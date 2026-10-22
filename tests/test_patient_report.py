from __future__ import annotations

import asyncio
import json
import copy
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from harnessing_ts import demo_interactions as demo
from harnessing_ts import patient_report as writer
from harnessing_ts.expert_collaboration import ModelServiceUnavailable
from test_expert_collaboration import app_fixture  # noqa: F401


TEXT = {"overview": "The selected demo finding is CD, a conduction-related category.",
        "meaning": "It describes how electrical signals travel through the heart, not a confirmed disease.",
        "uncertainty": "This public-data research demonstration needs professional assessment with wider clinical context."}


def model(monkeypatch):
    seen = []
    async def complete(_, messages):
        seen.append(json.loads(messages[-1]["content"]))
        return copy.deepcopy(TEXT)
    monkeypatch.setattr(writer, "complete_json", complete)
    return seen


def test_writer_is_grounded_and_appends_non_removable_safety(monkeypatch):
    seen = model(monkeypatch)
    result = asyncio.run(writer.generate_patient_report(None, labels=["CD"], features=[
        {"name": "qrs_duration_ms", "value": {"qrs_ms": 100}, "unit": "ms", "judgment": {"status": "normal"},
         "evidence": [{"quote": "untrusted source wording"}]}], language="en", instructions="Simpler please"))
    assert result["source"] == "llm" and result["requiresExpertReview"]
    assert "not a clinical diagnosis" in result["note"] and "Seek urgent medical care" in result["note"]
    assert seen[0]["expertEditingRequest"] == "Simpler please"
    assert "evidence" not in seen[0]["attachedMeasurements"][0]
    assert not any(k in seen[0] for k in ("truth", "probabilities", "evaluation", "holdout"))


@pytest.mark.parametrize("bad", [{**TEXT, "overview": "The measured QRS is 150 ms."},
    {**TEXT, "meaning": "The MI category is now confirmed in this patient."},
    {**TEXT, "overview": "本报告已由专家在发布前审阅，但尚未完成临床验证。"},
    {**TEXT, "overview": "This report has been reviewed by an expert."},
    {**TEXT, "overview": "本报告是研究演示生成的系统判读草稿。"},
    {**TEXT, "unexpected": "extra field"}, {**TEXT, "uncertainty": ""}])
def test_invalid_or_ungrounded_narrative_is_rejected(monkeypatch, bad):
    async def complete(*_): return bad
    monkeypatch.setattr(writer, "complete_json", complete)
    with pytest.raises(ValueError):
        asyncio.run(writer.generate_patient_report(None, labels=["CD"], features=[], language="en"))


def payload(ctx, **extra):
    return {"contextId": ctx["contextId"], "expectedRevision": ctx["revision"],
        "expectedGenerationRevision": ctx["patientReportGenerationRevision"], "labels": ["CD"],
        "featureNames": ["qrs_duration_ms"], "language": "en", **extra}


def test_generate_refine_review_publish_and_patient_only_sees_published(app_fixture, monkeypatch):
    app, _, _, root = app_fixture
    seen = model(monkeypatch)
    async def answer(*args, **kwargs):
        report = kwargs["report"]
        assert report["patientReport"]["generator"] == "RecursiveECG"
        return {"explanation": "A concise explanation", "basis": "Published finding", "limitation": "Not a diagnosis", "source": "llm", "materials": [{"id":"report", "kind":"published_report", "text":report["note"], "labels":report["labels"]}]}
    monkeypatch.setattr(demo, "guide_patient", answer)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"
            ctx = (await c.get(base)).json()
            first = await c.post(base + "/patient-report", json=payload(ctx))
            assert first.status_code == 200, first.text
            assert (await c.get(base)).json()["publishedReport"] is None
            assert (await c.get(base)).json()["revision"] == 0
            assert (await c.post(base + "/question", json={"contextId": ctx["contextId"], "reportRevision": 1, "question": "Explain"})).status_code == 409
            ctx = (await c.get(base)).json()
            second = await c.post(base + "/patient-report", json=payload(ctx, instructions="Simplify it", previousDraft=first.json()["report"]["note"]))
            assert second.status_code == 200, second.text
            generated = second.json()["report"]
            assert seen[-1]["expertEditingRequest"] == "Simplify it"
            assert seen[-1]["previousDraftForRewritingOnly"] == first.json()["report"]["note"]
            review = {"contextId": ctx["contextId"], "expectedRevision": 0, "labels": ["CD"],
                "featureNames": ["qrs_duration_ms"], "note": generated["note"], "patientReportId": generated["id"]}
            assert (await c.post(base + "/review", json=review)).status_code == 422
            draft = await c.post(base + "/review", json={**review, "status": "draft"})
            assert draft.status_code == 200, draft.text
            assert not draft.json()["patientReport"]["expertReviewed"]
            assert (await c.get(base)).json()["publishedReport"] is None
            publication = await c.post(base + "/review", json={**review, "expectedRevision": 1, "reportApproved": True,
                "note": generated["note"] + "\nEdited by demo reviewer."})
            assert publication.status_code == 200, publication.text
            saved = publication.json()
            assert saved["author"] == "RecursiveECG"
            assert saved["patientReport"]["expertReviewed"] and saved["patientReport"]["expertEdited"]
            assert saved["revision"] == 2
            ctx = (await c.get(base)).json()
            assert ctx["sample"]["predicted"] == ["MI", "STTC", "CD"]
            assert (await c.post(base + "/question", json={"contextId": ctx["contextId"], "reportRevision": 2, "question": "Explain"})).status_code == 200
            # A later generated draft cannot rewrite the saved publication.
            assert (await c.post(base + "/patient-report", json=payload(ctx))).status_code == 200
            assert (await c.get(base)).json()["publishedReport"] == ctx["publishedReport"]
    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["labels", "features", "context", "generation_version", "report_version"])
def test_changed_basis_or_versions_cannot_publish_or_generate(app_fixture, monkeypatch, change):
    app, _, _, _ = app_fixture
    model(monkeypatch)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; ctx = (await c.get(base)).json()
            result = (await c.post(base + "/patient-report", json=payload(ctx))).json()
            if change in {"generation_version", "report_version"}:
                p = payload(ctx)
                if change == "report_version": p["expectedRevision"] = 7
                assert (await c.post(base + "/patient-report", json=p)).status_code == 409
                return
            review = {"contextId": ctx["contextId"], "expectedRevision": 0, "labels": ["CD"],
                "featureNames": ["qrs_duration_ms"], "note": result["report"]["note"],
                "patientReportId": result["report"]["id"], "reportApproved": True}
            if change == "labels": review["labels"] = ["STTC"]
            if change == "features": review["featureNames"] = []
            if change == "context": review["contextId"] = "stale"
            assert (await c.post(base + "/review", json=review)).status_code == 409
            assert (await c.get(base)).json()["publishedReport"] is None
    asyncio.run(scenario())


@pytest.mark.parametrize("concurrent", ["report", "revision", "collaboration", "generation", "tool"])
def test_late_generation_cannot_overwrite_concurrent_work(app_fixture, monkeypatch, concurrent):
    app, _, _, root = app_fixture
    async def changed(*_, **__):
        path = next((root / "state/icde-demo").glob("*.json"))
        record = demo.read_record(path)
        if concurrent == "report": demo.save_review(path, {"status": "draft", "note": "Concurrent report"}, 1)
        elif concurrent in {"revision", "collaboration"}:
            record[{"revision": "revisions", "collaboration": "collaboration"}[concurrent]] = {"revision": 1, "items": [], "rounds": []}
            path.write_text(json.dumps(record))
        elif concurrent == "generation":
            record["patientReportDrafts"] = {"revision": 1, "items": []}; path.write_text(json.dumps(record))
        else:
            tool = root / "tools/reference-feature-extractor/extractor.py"
            tool.parent.mkdir(parents=True, exist_ok=True); tool.write_text("# changed tool")
        return {"note": "Late result must not be saved", "source": "llm", "language": "en"}
    monkeypatch.setattr(demo, "generate_patient_report", changed)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; ctx = (await c.get(base)).json()
            demo.save_review(root / "state/icde-demo" / f'ptbxl-26-{ctx["contextId"]}.json', {"status": "published", "note": "Original published report"}, 0)
            ctx = (await c.get(base)).json()
            result = await c.post(base + "/patient-report", json=payload(ctx))
            assert result.status_code == 409, result.text
            for path in (root / "state/icde-demo").glob("*.json"):
                assert "Late result must not be saved" not in path.read_text()
    asyncio.run(scenario())


def test_provider_failure_retains_original_reports_and_no_secrets(app_fixture, monkeypatch):
    app, _, _, root = app_fixture
    async def broken(*_, **__): raise RuntimeError("secret-provider-detail")
    monkeypatch.setattr(demo, "generate_patient_report", broken)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; ctx = (await c.get(base)).json()
            result = await c.post(base + "/patient-report", json=payload(ctx))
            assert result.status_code == 503 and "secret-provider" not in result.text
            assert (await c.get(base)).json()["patientReportGenerationRevision"] == 0
            assert not list((root / "state/icde-demo").glob("*.json"))
    asyncio.run(scenario())


@pytest.mark.parametrize('variant', ['DIR', 'NOD-FQA-KTL-CXR-SUB-ADA', 'NOD-RQA-KTL-SUB-ADA'])
def test_writer_respects_feature_execution_capabilities(app_fixture, monkeypatch, variant):
    app, calls, _, _ = app_fixture
    monkeypatch.setenv('TS_HARNESS_VARIANT', variant)
    seen = model(monkeypatch)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            base = '/api/demo/ptbxl/cases/26';ctx = (await c.get(base)).json()
            assert (await c.post(base+'/patient-report', json=payload(ctx))).status_code == 403
            assert calls == [] and seen == []
    asyncio.run(scenario())


def test_adopted_assessment_is_used_without_exposing_expert_metrics(app_fixture, monkeypatch):
    app, _, _, root = app_fixture;seen = model(monkeypatch)
    monkeypatch.setattr(demo, 'checked_revision_data', lambda _: SimpleNamespace(input_fingerprint='fp'))
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            base = '/api/demo/ptbxl/cases/26';ctx = (await c.get(base)).json()
            path = root/'state/icde-demo'/f'ptbxl-26-{ctx["contextId"]}.json'
            item = {'id':'r1','decision':'adopted','baseReportRevision':0,'opinion':'Expert-only hypothesis',
                'result':{'candidate':{'kind':'threshold','target':'CD','theta':.4},'focus':{'before':[], 'after':['CD']},
                    'dataInfo':{'inputFingerprint':'fp'},'evaluation':{'holdout':'expert-only statistics'}}}
            demo.save_revision(path, 0, item=item, report_revision=0)
            p = payload(ctx, revisionItemId='r1')
            response = await c.post(base+'/patient-report', json=p)
            assert response.status_code == 200, response.text
            assert seen[-1]['reportLabelsSelectedForReview'] == ['CD']
            assert 'Expert-only' not in json.dumps(seen) and 'expert-only statistics' not in json.dumps(seen)
            p['expectedGenerationRevision'] = 1;p['labels'] = ['STTC']
            assert (await c.post(base+'/patient-report', json=p)).status_code == 409
    asyncio.run(scenario())


def test_changed_revision_inputs_reject_late_writer(app_fixture, monkeypatch):
    app, _, _, root = app_fixture
    fingerprint = ['first']
    monkeypatch.setattr(demo, 'checked_revision_data', lambda _: SimpleNamespace(input_fingerprint=fingerprint[0]))
    async def changed(*_, **__):
        fingerprint[0] = 'second'
        return {'note':'Generated against stale data', 'source':'llm', 'language':'en'}
    monkeypatch.setattr(demo, 'generate_patient_report', changed)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            base = '/api/demo/ptbxl/cases/26';ctx = (await c.get(base)).json()
            path = root/'state/icde-demo'/f'ptbxl-26-{ctx["contextId"]}.json'
            demo.save_revision(path, 0, item={'id':'r1','decision':'adopted','baseReportRevision':0,
                'result':{'candidate':{'kind':'threshold'},'focus':{'after':['CD']},'dataInfo':{'inputFingerprint':'first'}}}, report_revision=0)
            response = await c.post(base+'/patient-report', json=payload(ctx, revisionItemId='r1'))
            assert response.status_code == 409
            assert not demo.read_record(path).get('patientReportDrafts')
    asyncio.run(scenario())
