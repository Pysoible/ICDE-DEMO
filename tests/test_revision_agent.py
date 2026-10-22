from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from harnessing_ts import demo_interactions as demo
from harnessing_ts import expert_collaboration as expert
from harnessing_ts import revision_loop as rl
from test_expert_collaboration import app_fixture  # noqa: F401  (pytest fixture)
from test_revision_loop import make_data, row


def build_data():
    return make_data([
        row(26, "tuning", 0.45, True, **{"qrs": 120.0}),
        row(2, "tuning", 0.45, False, **{"qrs": 80.0}),
        row(3, "tuning", 0.9, True, **{"qrs": 130.0}),
        row(4, "holdout", 0.45, False, **{"qrs": 85.0}),
        row(5, "holdout", 0.45, False, **{"qrs": 90.0}),
        row(6, "holdout", 0.2, False),
    ])


def thr(theta):
    return {"kind": "threshold", "target": "CD", "theta": theta, "rationale": "Expert says the CD cut is too high"}


def script(monkeypatch, replies):
    seen = []
    async def provider(_, messages):
        seen.append({"system": messages[0]["content"], "user": json.loads(messages[1]["content"])})
        return replies[min(len(seen) - 1, len(replies) - 1)]
    monkeypatch.setattr(expert, "complete_json", provider)
    return seen


async def noop():
    return None


def run(data, opinion="CD threshold looks too high"):
    return asyncio.run(rl.run_revision(None, data, focus_id=26, opinion=opinion, guard=noop))


def test_evaluate_then_finish_reports_tuning_to_agent_and_everything_to_expert(monkeypatch):
    seen = script(monkeypatch, [
        {"action": "evaluate", "candidate": thr(0.4), "explanation": "Most faithful expression"},
        {"action": "finish", "chosen": 1, "explanation": "It fixes case 26 but breaks others."}])
    result = run(build_data())
    assert result["stopReason"] == "finish" and result["chosen"] == 1
    assert len(seen) == 2 and seen[1]["user"]["executed"][0]["tuning"]["fixed"] == 1
    # the agent never receives anything about the holdout half
    for call in seen:
        assert "holdout" not in json.dumps(call["user"]).lower()
        assert call["user"]["remainingEvaluations"] <= 3
    # the expert does get both halves, plus the focused case before/after
    assert result["evaluation"]["subsets"]["holdout"]["broken"] == 2
    assert result["evaluation"]["verdict"]["holdout"] == "loss"
    assert result["focus"]["before"] == []
    assert result["focus"]["effect"] == "fixed" and result["focus"]["after"] == ["CD"]
    assert result["changesPredictions"] is False and result["published"] is False
    assert result["attempts"][0]["chosen"] is True and result["dataInfo"]["reconciliation"]["reconciled"]


def test_agent_can_decline_to_recommend_when_the_numbers_do_not_support_the_opinion(monkeypatch):
    script(monkeypatch, [{"action": "evaluate", "candidate": thr(0.4), "explanation": "Try it"},
                         {"action": "finish", "chosen": None, "explanation": "More records break than are fixed."}])
    result = run(build_data())
    assert result["chosen"] is None and result["candidate"] is None and result["evaluation"] is None
    assert result["attempts"][0]["verdict"]["holdout"] == "loss"       # the attempt is still shown, with holdout


def test_opinion_that_cannot_be_expressed_is_reported_not_forced(monkeypatch):
    script(monkeypatch, [{"action": "cannot_express", "missing": "An ST-segment depth measurement", "explanation": "No such column."}])
    result = run(build_data(), "ST depression in V4-V6 should count")
    assert result["stopReason"] == "cannot_express" and result["missing"].startswith("An ST-segment")
    assert result["candidate"] is None and not result["attempts"] and result["focusBaseline"]["ecgId"] == 26


def test_rejected_candidate_is_fed_back_and_counts_toward_the_budget(monkeypatch):
    bad = {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "uses a made-up column",
           "conditions": [{"source": "feature", "name": "made_up_column", "op": ">=", "value": 1}]}
    seen = script(monkeypatch, [{"action": "evaluate", "candidate": bad, "explanation": "first try"},
                                {"action": "evaluate", "candidate": thr(0.4), "explanation": "corrected"},
                                {"action": "finish", "chosen": 1, "explanation": "ok"}])
    result = run(build_data())
    err = seen[1]["user"]["executed"][0]["error"]
    assert "made_up_column" in err and "http" not in err and seen[1]["user"]["remainingEvaluations"] == 2
    assert len(result["rejected"]) == 1 and result["chosen"] == 1 and len(result["attempts"]) == 1


def test_budget_is_bounded_and_ends_without_a_recommendation(monkeypatch):
    seen = script(monkeypatch, [{"action": "evaluate", "candidate": thr(t), "explanation": "more"} for t in (0.35, 0.4, 0.42, 0.44)])
    result = run(build_data())
    assert len(seen) == 4 and result["stopReason"] == "budget" and result["chosen"] is None
    assert len(result["attempts"]) == 3


def test_identical_candidate_stops_the_loop(monkeypatch):
    seen = script(monkeypatch, [{"action": "evaluate", "candidate": thr(0.4), "explanation": "a"}] * 3)
    result = run(build_data())
    assert result["stopReason"] == "duplicate" and len(seen) == 2 and result["chosen"] is None


def test_rewording_rationale_does_not_bypass_duplicate_guard(monkeypatch):
    script(monkeypatch, [{"action": "evaluate", "candidate": thr(.4)},
                          {"action": "evaluate", "candidate": {**thr(.4), "rationale": "Different prose"}}])
    assert run(build_data())["stopReason"] == "duplicate"


def test_invalid_choice_is_not_recommended(monkeypatch):
    script(monkeypatch, [{"action": "evaluate", "candidate": thr(0.4), "explanation": "a"},
                         {"action": "finish", "chosen": 7, "explanation": "pick"}])
    result = run(build_data())
    assert result["chosen"] is None and result["candidate"] is None and "does not exist" in result["notice"]
    assert result["explanation"] == "pick"       # model prose stays separate from the application notice


def test_null_text_fields_from_the_model_are_accepted(monkeypatch):
    # observed with the real model: unused text fields are written as null
    script(monkeypatch, [{"action": "evaluate", "candidate": thr(0.4), "chosen": None, "explanation": "try", "missing": None},
                         {"action": "finish", "candidate": None, "chosen": 1, "explanation": None, "missing": None}])
    result = run(build_data())
    assert result["chosen"] == 1 and result["explanation"] == ""


def test_unknown_focus_case_is_refused(monkeypatch):
    script(monkeypatch, [{"action": "finish", "chosen": None, "explanation": "n/a"}])
    with pytest.raises(ValueError):
        asyncio.run(rl.run_revision(None, build_data(), focus_id=999, opinion="x y z", guard=noop))


# ------------------------------------------------------------------ routes

@pytest.fixture
def revision_app(app_fixture, monkeypatch):  # noqa: F811
    app, _, _, path = app_fixture
    monkeypatch.setattr(demo.rev, "load_revision_data", lambda _ws: build_data())
    return app, path


def post(client, base, cid, rev_no, message="CD threshold looks too high"):
    return client.post(base + "/revision", json={"contextId": cid, "expectedRevision": rev_no, "message": message})


def test_revision_is_saved_beside_reports_decided_once_and_never_published(revision_app, monkeypatch):
    app, path = revision_app
    script(monkeypatch, [{"action": "evaluate", "candidate": thr(0.4), "explanation": "try"},
                         {"action": "finish", "chosen": 1, "explanation": "supported on tuning only"}])
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"
            ctx = (await c.get(base)).json(); cid = ctx["contextId"]
            status = (await c.get(base + "/revision")).json()
            assert status["status"]["available"] and status["status"]["inValidationSet"] and status["items"] == []
            r = await post(c, base, cid, 0); assert r.status_code == 200, r.text
            state = r.json(); item = state["items"][0]
            assert state["revision"] == 1 and item["decision"] == "pending" and item["result"]["chosen"] == 1
            assert (await post(c, base, cid, 0)).status_code == 409                       # stale revision
            dec = {"contextId": cid, "expectedRevision": 1, "itemId": item["id"], "decision": "adopted"}
            r = await c.post(base + "/revision/decision", json=dec); assert r.status_code == 200, r.text
            adopted = r.json()["items"][0]
            assert adopted["adoption"]["version"] == 1 and adopted["adoption"]["changesPredictions"] is False
            assert adopted["adoption"]["published"] is False
            assert (await c.post(base + "/revision/decision", json={**dec, "expectedRevision": 2})).status_code == 409  # decided already
            after = (await c.get(base)).json()
            assert after["publishedReport"] is None and after["revision"] == ctx["revision"]    # no report touched
    asyncio.run(scenario())
    saved = json.loads(next(path.glob("state/icde-demo/*.json")).read_text())
    assert saved["revisions"]["items"][0]["result"]["changesPredictions"] is False and saved["reviews"] == []


def test_failures_and_unavailable_inputs_save_nothing(revision_app, monkeypatch):
    app, path = revision_app
    async def boom(*_):
        raise expert.ModelServiceUnavailable("The model service is rate-limited. Wait before retrying.")
    monkeypatch.setattr(expert, "complete_json", boom)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; cid = (await c.get(base)).json()["contextId"]
            r = await post(c, base, cid, 0)
            assert r.status_code == 503 and "unchanged" in r.json()["detail"] and "rate-limited" in r.json()["detail"]
            assert (await c.get(base + "/revision")).json()["items"] == []
            def unavailable(_ws):
                raise rl.RevisionUnavailable("The validation feature table has not been built. Run the offline build step first.")
            monkeypatch.setattr(demo.rev, "load_revision_data", unavailable)
            r = await post(c, base, cid, 0); assert r.status_code == 503 and "feature table" in r.json()["detail"]
            assert (await c.get(base + "/revision")).json()["status"]["available"] is False
    asyncio.run(scenario())


def test_nothing_to_adopt_when_the_agent_recommends_nothing(revision_app, monkeypatch):
    app, _ = revision_app
    script(monkeypatch, [{"action": "cannot_express", "missing": "ST segment measurement", "explanation": "n/a"}])
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; cid = (await c.get(base)).json()["contextId"]
            item = (await post(c, base, cid, 0)).json()["items"][0]
            r = await c.post(base + "/revision/decision", json={"contextId": cid, "expectedRevision": 1, "itemId": item["id"], "decision": "adopted"})
            assert r.status_code == 422
            r = await c.post(base + "/revision/decision", json={"contextId": cid, "expectedRevision": 1, "itemId": item["id"], "decision": "rejected"})
            assert r.status_code == 200 and r.json()["items"][0]["decision"] == "rejected"
    asyncio.run(scenario())


def test_feedback_history_evidence_and_explicit_report_snapshot(revision_app, monkeypatch):
    app, path = revision_app
    seen = script(monkeypatch, [{"action": "evaluate", "candidate": thr(.4)}, {"action": "finish", "chosen": 1}])
    patient_contexts = []
    from harnessing_ts import patient_guide
    async def answer(_, messages):
        patient_contexts.append(json.loads(messages[-1]['content'])['publishedMaterials'])
        return {"explanation":"The published assessment changed.","basis":"The report records a category change.",
                "limitation":"This does not establish clinical correctness.","understanding":"not_checked",
                "references":["change"],"nextQuestion":"What can this change tell me?"}
    monkeypatch.setattr(patient_guide, 'complete_json', answer)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; cid = (await c.get(base)).json()["contextId"]
            first = (await post(c, base, cid, 0)).json()["items"][0]
            report = {"contextId": cid, "expectedRevision": 0, "labels": ["CD"], "note": "Explicit test report, not a clinical diagnosis", "status": "published", "revisionItemId": first["id"]}
            assert (await c.post(base+"/review", json=report)).status_code == 409
            dec = {"contextId": cid, "expectedRevision": 1, "itemId": first["id"], "decision": "adopted"}
            assert (await c.post(base+"/revision/decision", json=dec)).status_code == 200
            saved = await c.post(base+"/review", json=report)
            assert saved.status_code == 200, saved.text
            snapshot = saved.json()["feedbackImpact"]
            assert snapshot["opinion"] == first["opinion"] and snapshot["candidate"]["theta"] == .4
            assert (await c.get(base)).json()["sample"]["predicted"] == ["MI", "STTC", "CD"]
            script(monkeypatch, [{"action": "finish", "chosen": None, "explanation": "No new candidate"}])
            captures = []
            async def follow_provider(_, messages):
                captures.append(json.loads(messages[1]["content"]))
                return {"action": "finish", "chosen": None}
            monkeypatch.setattr(expert, "complete_json", follow_provider)
            reply = await c.post(base+"/revision", json={"contextId": cid, "expectedRevision": 2, "parentId": first["id"], "reportRevision": 1, "message": "Refine the earlier CD feedback"})
            assert reply.status_code == 200, reply.text
            assert reply.json()["items"][-1]["parentId"] == first["id"]
            context = captures[0]
            history = context["previousFeedback"]
            assert history[-1]["selectedForRefinement"] and history[-1]["candidate"]["theta"] == .4
            assert "holdout" not in json.dumps(history).lower()
            assert context["evidenceContext"]["features"][0]["name"] == "qrs_duration_ms"
            after = (await c.get(base)).json()["publishedReport"]
            assert after["feedbackImpact"] == snapshot and after["revision"] == 1
            q = await c.post(base+"/question", json={"contextId": cid, "reportRevision": 1, "question": "What changed?"})
            assert q.status_code == 200, q.text
            assert next(m for m in patient_contexts[-1] if m['id']=='change') == {
                "id":"change", "kind":"published_case_assessment_change",
                "before": snapshot["focus"]["before"], "after": snapshot["focus"]["after"],
                "scope": "case_local_demo_assessment_not_training_or_diagnosis"}
            assert 'published_feedback_impact' not in str(patient_contexts[-1])
            assert 'evaluation' not in str(patient_contexts[-1])
            assert len(demo.read_record(next(path.glob("state/icde-demo/*.json")))["reviews"]) == 1
    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["fingerprint", "unavailable"])
def test_changed_inputs_block_adoption_and_report_link(revision_app, monkeypatch, change):
    app, _ = revision_app
    script(monkeypatch, [{"action": "evaluate", "candidate": thr(.4)}, {"action": "finish", "chosen": 1}])
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; cid = (await c.get(base)).json()["contextId"]
            item = (await post(c, base, cid, 0)).json()["items"][0]
            def changed(_):
                if change == "unavailable":
                    raise rl.RevisionUnavailable("The feature table is stale.")
                data = build_data(); data.input_fingerprint = "new"; return data
            monkeypatch.setattr(demo.rev, "load_revision_data", changed)
            dec = await c.post(base+"/revision/decision", json={"contextId": cid, "expectedRevision": 1, "itemId": item["id"], "decision": "adopted"})
            assert dec.status_code == 409, dec.text
            report = await c.post(base+"/review", json={"contextId": cid, "expectedRevision": 0, "labels": ["CD"], "note": "Explicit research demo report", "revisionItemId": item["id"]})
            assert report.status_code == 409, report.text
            assert (await c.get(base)).json()["publishedReport"] is None
    asyncio.run(scenario())


def test_input_change_during_provider_call_never_saves_a_result(revision_app, monkeypatch):
    app, path = revision_app
    async def provider(*_):
        data = build_data(); data.input_fingerprint = "changed while waiting"
        monkeypatch.setattr(demo.rev, "load_revision_data", lambda _: data)
        return {"action": "finish", "chosen": None}
    monkeypatch.setattr(expert, "complete_json", provider)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"; cid = (await c.get(base)).json()["contextId"]
            response = await post(c, base, cid, 0)
            assert response.status_code == 409
            assert (await c.get(base+"/revision")).json()["items"] == []
    asyncio.run(scenario())
