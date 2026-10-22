import asyncio
import copy
import json

import httpx
import pytest
from fastapi import HTTPException

from harnessing_ts import demo_interactions as demo
from harnessing_ts import patient_tasks as pt
from harnessing_ts import patient_guide as guide
from test_expert_collaboration import app_fixture  # noqa: F401

REPORT = {"status": "published", "labels": ["CD"], "note": "Published demo finding, not a medical diagnosis.",
          "features": [{"name": "qrs_duration_ms", "value": None, "judgment": {"status": "not_assessable"}, "warnings": ["missing"]}]}
FINAL = {"action": "finish", "explanation": "The report has a category but its cause is not established.",
         "basis": "I read the published report and inspected its attached material inventory.",
         "limitation": "An attachment is not proof of a diagnosis.", "reviewQuestion": "Please review the basis and limits of this report finding."}


@pytest.mark.parametrize('quote,valid', [('睡得很晚',True),('报告提示传导异常',False)])
def test_task_context_quote_comes_only_from_current_patient_question(quote,valid):
    async def guard():pass
    async def complete(_,messages):
        data=json.loads(messages[-1]['content'])
        if not data['observations']:return {'action':'read_report'}
        return {**FINAL,'contextUpdates':[{'quote':quote,'focus':FINAL['explanation']}]}
    def run():return asyncio.run(pt.investigate_task(None,report={**REPORT,'revision':1},previous=None,
        question='我睡得很晚，如何休息？',label='',language='zh',guard=guard,complete=complete))
    if valid:assert run()['contextUpdates'][0]['quote']==quote
    else:
        with pytest.raises(ValueError):run()


def test_task_basis_is_separate_and_research_output_is_not_saved():
    async def guard(): pass
    async def run(bad):
        async def complete(_, messages):
            data=json.loads(messages[-1]['content'])
            if not data['observations']: return {'action':'read_report'}
            return {**FINAL,'basis':'数据集标签和模型输出不一致。'} if bad else dict(FINAL)
        return await pt.investigate_task(None,report={**REPORT,'revision':1},previous=None,question='What can I know?',label='',language='en',guard=guard,complete=complete)
    result=asyncio.run(run(False))
    assert result['basis'] == FINAL['basis']
    with pytest.raises(ValueError): asyncio.run(run(True))


def test_task_optional_care_fields_do_not_require_an_extra_disclaimer():
    async def guard():pass
    async def complete(_,messages):
        data=json.loads(messages[-1]['content'])
        assert data['generalEducation']['scope']=='general_health_education_not_case_evidence'
        if not data['observations']:return {'action':'read_report'}
        return {**FINAL,'limitation':'','dailyCare':'Keep a regular sleep schedule.',
                'medication':'A conduction label does not select a medicine.'}
    result=asyncio.run(pt.investigate_task(None,report={**REPORT,'revision':1},previous=None,
        question='How should I rest?',label='',language='en',guard=guard,complete=complete))
    assert result['limitation']=='' and result['dailyCare']
    assert len(result['checks'])==1 and not result['changesReport']


@pytest.fixture
def model(monkeypatch):
    seen = []
    async def complete(_, messages):
        data = json.loads(messages[-1]["content"]); seen.append(data)
        return {"action": ["read_report", "inspect_attachments"][len(data["observations"])]} if len(data["observations"]) < 2 else copy.deepcopy(FINAL)
    monkeypatch.setattr(pt, "complete_json", complete)
    async def answer(*_, **kwargs):
        return {"explanation": "The published report does not establish a cause.", "limitation": "Wider clinical context is unavailable.",
                "source": "llm", "understanding": "not_checked", "references": ["report"], "nextQuestion": "What still needs review?"}
    monkeypatch.setattr(demo, "guide_patient", answer)
    return seen


async def seeded(client, path):
    base = "/api/demo/ptbxl/cases/26"
    ctx = (await client.get(base)).json()
    record_path = path/"state/icde-demo"/f"ptbxl-26-{ctx['contextId']}.json"
    demo.save_review(record_path, dict(copy.deepcopy(REPORT), contextId=ctx["contextId"]), 0)
    request = {"contextId": ctx["contextId"], "expectedRevision": 0, "reportRevision": 1,
               "question": "What supports this report category?", "label": "CD", "language": "en"}
    return base, record_path, request


async def checked(client, url, payload):
    response = await client.post(url, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("outcome", ["changed", "retained", "unresolved", "text_only"])
def test_end_to_end_explicit_patient_expert_loop(app_fixture, model, outcome):
    app, calls, captures, path = app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base, record, payload = await seeded(c, path)
            result = await checked(c, base+"/patient-tasks/investigate", payload)
            item = result["items"][0]; task = base+"/patient-tasks/"+item["id"]
            assert item["status"] == "prepared" and not item.get("submittedAt")
            assert len(item["investigation"]["checks"]) == 2 and calls == []
            assert (await c.get(base)).json()["publishedReport"]["revision"] == 1
            payload.update(expectedRevision=1, text="Please check the basis of this report category.")
            result = await checked(c, task+"/submit", payload)
            assert result["items"][0]["requestText"] == payload["text"]
            payload["expectedRevision"] = 2
            result = await checked(c, task+"/start", payload)
            assert result["items"][0]["status"] == "in_review"
            assert (await c.post(task+"/resolve", json=payload)).status_code == 422
            if outcome in ("changed", "text_only"):
                new = dict(copy.deepcopy(REPORT), contextId=payload["contextId"], note="Published revised explanation with limits.")
                if outcome == "changed": new["labels"] = ["STTC"]
                demo.save_review(record, new, 1)
                payload["reportRevision"] = 2
            payload["expectedRevision"] = 3
            result = await checked(c, task+"/answer-draft", payload)
            draft = result["items"][0]["answerDraft"]
            public = (await c.get(base)).json()["patientTasks"]
            assert "answerDraft" not in public["items"][0] and "answer" not in public["items"][0]
            payload.update(expectedRevision=4, text=draft["text"], draftId=draft["id"], approved=True, unresolved=outcome=="unresolved")
            result = await checked(c, task+"/resolve", payload)
            answer = result["items"][0]["answer"]
            assert result["items"][0]["status"] == "answered"
            assert answer["unresolved"] == (outcome == "unresolved")
            assert answer["change"]["kind"] == {"changed":"labels_changed", "text_only":"explanation_updated"}.get(outcome, "assessment_retained")
            if outcome == "changed": assert answer["change"]["removed"] == ["CD"] and answer["change"]["added"] == ["STTC"]
            assert len(demo.read_record(record)["reviews"]) == payload["reportRevision"]
            assert demo.read_record(record)["revision"] == payload["reportRevision"]
            assert (await c.post(task+"/resolve", json={**payload,"expectedRevision":5})).status_code == 409
            ctx = (await c.get(base)).json()
            assert "answerDraft" not in ctx["patientTasks"]["items"][0]
            assert ctx["patientTasks"]["items"][0]["answer"]["reportRevision"] == payload["reportRevision"]
            response = await c.post(base+"/understand", json={"contextId":payload["contextId"], "reportRevision":payload["reportRevision"], "question":"Explain this answer", "selected":"clarification", "taskId":item["id"]})
            assert response.status_code == 200, response.text
            assert not any(k in str(model) for k in ("truth", "predicted", "private-"))
    asyncio.run(run())


@pytest.mark.parametrize("bad", [{"label":"MI"}, {"question":" "}, {"expectedRevision":5}, {"reportRevision":7}, {"contextId":"other"}, {"question":"I have chest pain"}])
def test_invalid_or_urgent_requests_do_not_write(app_fixture, model, bad):
    app, _, _, path = app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base, record, payload = await seeded(c, path); before = record.read_bytes()
            r = await c.post(base+"/patient-tasks/investigate", json={**payload, **bad})
            assert r.status_code in (409, 422) and record.read_bytes() == before
    asyncio.run(run())


@pytest.mark.parametrize('question', ['No chest pain, shortness of breath, or fainting. What does this report say?', '没有胸痛、气短或晕倒。报告是什么意思？'])
def test_explicit_denials_are_not_rejected_by_the_task_route(app_fixture, model, question):
    app, _, _, path = app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            base, record, payload = await seeded(c, path)
            before = demo.read_record(record)['reviews']
            response = await c.post(base+'/patient-tasks/investigate', json={**payload, 'question':question})
            assert response.status_code == 200, response.text
            assert demo.read_record(record)['reviews'] == before
            context = response.json()['items'][-1]['investigation']['patientContext']
            assert {s['name'] for s in context['symptoms'] if s['status']=='denied'} == {'chest_pain','breathlessness','fainting'}
    asyncio.run(run())


@pytest.mark.parametrize("bad", ["repeat", "empty_finish", "invented", "failure", "new_report", "new_task", "new_context"])
def test_failed_or_stale_investigation_never_saves_success(app_fixture, monkeypatch, bad):
    app, _, _, path = app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base, record, payload = await seeded(c, path)
            async def complete(_, messages):
                if bad == "failure": raise RuntimeError("secret-provider-detail")
                if bad == "new_report": demo.save_review(record, copy.deepcopy(REPORT), 1)
                if bad == "new_task": demo.save_patient_task(record, 0, 1, lambda state,_:None)
                if bad == "new_context": monkeypatch.setattr(demo,"load_ecg_waveform",lambda *_:{"sampleRate":100,"leads":[]})
                return {"action":"read_report"} if bad == "repeat" else {"action":"invented"} if bad == "invented" else {"action":"finish"}
            monkeypatch.setattr(pt,"complete_json",complete)
            response = await c.post(base+"/patient-tasks/investigate", json=payload)
            assert response.status_code in (409, 503)
            assert "secret" not in response.text
            assert not pt.task_state(demo.read_record(record))["items"]
    asyncio.run(run())


def test_store_is_optimistic_preserves_other_histories_and_never_uses_drafts(tmp_path):
    path=tmp_path/"record.json"; demo.save_review(path, copy.deepcopy(REPORT), 0)
    demo.save_patient_task(path,0,1,lambda state,_:state["items"].append({"id":"a"}))
    demo.save_review(path, {**copy.deepcopy(REPORT),"status":"draft","labels":["MI"]},1)
    demo.save_patient_task(path,1,1,lambda state,_:state["items"].append({"id":"b"}))
    with pytest.raises(HTTPException): demo.save_patient_task(path,1,1,lambda *_:None)
    saved=demo.read_record(path)
    assert saved["revision"]==2 and len(saved["reviews"])==2 and len(saved["patientTasks"]["items"])==2
    assert saved["feedback"]==[]


def test_actual_receipts_do_not_equate_missing_or_numeric_values_to_a_diagnosis():
    report={"revision":1,"note":"text","labels":["CD"],"features":[{"name":"qrs","value":float("nan")},{"name":"pr","value":0,"warnings":["x"]}]}
    receipt=pt.check_materials("inspect_attachments",report,None)
    assert [r["hasNumericValue"] for r in receipt["rows"]]==[False,True]
    assert all(r["status"]=="unknown" for r in receipt["rows"])
    assert pt.check_materials("compare_publications",report,None)["available"] is False


def test_legacy_research_clauses_are_omitted_only_in_task_model_projection():
    original={**REPORT,"note":"报告提示需复核。数据集标签为 STTC，模型输出为 MI。形态未评估。 GT is CD. Limits remain unknown."}
    projected=pt.task_model_report(original)
    assert projected["researchClausesOmitted"] is True
    assert "STTC" not in projected["note"] and "GT" not in projected["note"]
    assert "形态未评估" in projected["note"] and "Limits remain unknown" in projected["note"]
    assert "STTC" in original["note"] and projected["labels"]==original["labels"]


def test_published_answer_is_separate_allowlisted_understanding_material():
    seen=[]
    async def complete(_,messages):
        seen.append(json.loads(messages[-1]["content"]))
        return {"explanation":"This explains the published response.","limitation":"Not medical care.","references":["clarification"],"understanding":"not_checked","nextQuestion":"What remains uncertain?"}
    result=asyncio.run(guide.guide_patient(None,report={**REPORT,"revision":1},question="Explain the response",mode="explain",language="en",selected="clarification",history=[],complete=complete,
        clarification={"text":"Approved reply","reportRevision":1,"unresolved":True,"change":pt.publication_change({**REPORT,"revision":1},{**REPORT,"revision":1}),"private":"DO_NOT_SEND"}))
    assert result["references"]==["clarification"] and "DO_NOT_SEND" not in str(seen)


def test_changed_publication_invalidates_answer_draft_and_old_followup(app_fixture,model):
    app,_,_,path=app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base,record,payload=await seeded(c,path)
            r=await checked(c,base+"/patient-tasks/investigate",payload); task=base+"/patient-tasks/"+r["selectedId"]
            for n,action in enumerate(("submit","start","answer-draft"),1):
                payload.update(expectedRevision=n,text="Please review the report basis.")
                r=await checked(c,task+"/"+action,payload)
            draft=r["items"][0]["answerDraft"]
            demo.save_review(record,{**copy.deepcopy(REPORT),"labels":["STTC"]},1)
            payload.update(expectedRevision=4,reportRevision=2,draftId=draft["id"],text=draft["text"],approved=True)
            assert (await c.post(task+"/resolve",json=payload)).status_code==409
            payload.update(expectedRevision=4)
            r=await checked(c,task+"/answer-draft",payload);draft=r["items"][0]["answerDraft"]
            payload.update(expectedRevision=5,draftId=draft["id"],text=draft["text"])
            await checked(c,task+"/resolve",payload)
            demo.save_review(record,copy.deepcopy(REPORT),2)
            r=await c.post(base+"/understand",json={"contextId":payload["contextId"],"reportRevision":3,"question":"Explain old response","taskId":r["items"][0]["id"]})
            assert r.status_code==409
    asyncio.run(run())


@pytest.mark.parametrize("variant",["DIR","NOD-RQA-CRV-SUB-ADA","NOD-FQA-KTL-CXR-SUB-ADA"])
def test_tasks_respect_variant_gate(app_fixture,monkeypatch,model,variant):
    app,_,_,path=app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base,record,payload=await seeded(c,path);monkeypatch.setenv("TS_HARNESS_VARIANT",variant)
            assert (await c.post(base+"/patient-tasks/investigate",json=payload)).status_code==403
            assert (await c.get(base+"/patient-tasks/review")).status_code==403
    asyncio.run(run())


def test_agent_finding_and_followup_need_no_expert_reply_or_submission(app_fixture, model, monkeypatch):
    app, _, _, path = app_fixture
    seen=[]
    async def explain(*_, **kwargs):
        seen.append(kwargs)
        return {"explanation":"Agent explains actual material.","limitation":"Not clinical verification.","source":"llm"}
    monkeypatch.setattr(demo,"guide_patient",explain)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base, record, payload=await seeded(c,path)
            result=await checked(c,base+"/patient-tasks/investigate",payload);item=result["items"][0]
            before=record.read_bytes()
            await checked(c,base+"/understand",{"contextId":payload["contextId"],"reportRevision":1,"question":"Explain the Agent finding","taskId":item["id"],"selected":"clarification"})
            assert record.read_bytes()==before
            assert seen[-1]["clarification"]["kind"]=="agent_material_check_not_clinical_verification"
            assert seen[-1]["clarification"]["currentCheckAvailable"] is True
            assert item["status"]=="prepared" and "answer" not in item
    asyncio.run(run())


@pytest.mark.parametrize("outcome",["labels","text","attachments","same"])
def test_report_impact_and_agent_recheck_do_not_wait_for_expert_reply(app_fixture,model,outcome):
    app, _, _, path=app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base,record,payload=await seeded(c,path)
            result=await checked(c,base+"/patient-tasks/investigate",payload);item=result["items"][0];task=base+"/patient-tasks/"+item["id"]
            payload["expectedRevision"]=1;before=record.read_bytes()
            assert (await c.post(task+"/recheck",json=payload)).status_code==409
            assert record.read_bytes()==before
            new=copy.deepcopy(REPORT)
            if outcome=="labels":new["labels"]=["STTC"]
            if outcome=="text":new["note"]="Updated published explanation."
            if outcome=="attachments":new["features"]=[]
            demo.save_review(record,new,1);published=copy.deepcopy(demo.read_record(record)["reviews"])
            ctx=(await c.get(base)).json();impact=ctx["patientTasks"]["items"][0]["currentImpact"]
            assert impact["kind"]=={"labels":"labels_changed","text":"explanation_updated","attachments":"evidence_updated","same":"assessment_retained"}[outcome]
            assert ctx["patientTasks"]["revision"]==1
            payload["reportRevision"]=2
            result=await checked(c,task+"/recheck",payload);fresh=result["items"][0]
            assert fresh["status"]=="prepared" and "answer" not in fresh and "reviewOutcome" not in fresh
            assert fresh["rechecks"][0]["reportRevision"]==2 and fresh["rechecks"][0]["change"]==impact
            assert demo.read_record(record)["reviews"]==published
            payload["expectedRevision"]=2;before=record.read_bytes()
            assert (await c.post(task+"/recheck",json=payload)).status_code==409
            assert record.read_bytes()==before
    asyncio.run(run())


def test_review_records_actual_work_not_a_doctor_answer_and_does_not_publish(app_fixture,model):
    app, _, _, path=app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base,record,payload=await seeded(c,path)
            result=await checked(c,base+"/patient-tasks/investigate",payload);item=result["items"][0];task=base+"/patient-tasks/"+item["id"]
            payload.update(expectedRevision=1,text="Inspect the missing evidence.");await checked(c,task+"/submit",payload)
            payload["expectedRevision"]=2;await checked(c,task+"/start",payload)
            payload.update(expectedRevision=3,approved=True,workKind="revision",workId="invented")
            before=record.read_bytes();assert (await c.post(task+"/complete-review",json=payload)).status_code==409
            assert record.read_bytes()==before
            saved=demo.read_record(record);started=saved["patientTasks"]["items"][0]["startedAt"]
            saved["revisions"]={"revision":1,"items":[{"id":"actual-work","createdAt":started,"contextId":payload["contextId"],"baseReportRevision":1,"private":"NO_PRIVATE_PATIENT_INPUT"}]}
            record.write_text(json.dumps(saved));before_reports=copy.deepcopy(saved["reviews"])
            options=(await c.get(base+"/patient-tasks/review")).json()["items"][0]["workOptions"]
            assert options[0]["id"]=="actual-work"
            payload["workId"]="actual-work";result=await checked(c,task+"/complete-review",payload)
            item=result["items"][0]
            assert item["status"]=="reviewed" and item["reviewOutcome"]["unresolved"] is True
            assert "answer" not in item and "answerDraft" not in item
            assert demo.read_record(record)["reviews"]==before_reports
            public=(await c.get(base)).json()["patientTasks"]
            assert "NO_PRIVATE" not in str(public)
            payload["expectedRevision"]=4;await checked(c,task+"/recheck",payload)
            assert demo.read_record(record)["reviews"]==before_reports
    asyncio.run(run())


def test_review_work_options_exclude_old_work_other_contexts_and_unpublished_reports():
    item={"id":"task","contextId":"ctx","reportRevision":1,"startedAt":"2026-10-20T10:00:00Z"}
    common={"createdAt":"2026-10-20T10:00:01Z","contextId":"ctx","baseReportRevision":1}
    record={"revisions":{"items":[dict(common,id="ok"),dict(common,id="old",createdAt="2026-10-20T09:00:00Z"),dict(common,id="other",contextId="other")]}}
    assert [w["id"] for w in pt.review_work_options(record,item,{"revision":1})]==["ok"]


def test_stale_agent_interpretation_not_sent_with_new_report():
    item={"question":"Original","reportRevision":1,"originalReport":dict(REPORT,revision=1),"investigation":{"explanation":"OLD_INTERPRETATION","limitation":"Old limit"}}
    material=pt.task_clarification(item,dict(REPORT,revision=2))
    assert material["text"]=="" and material["currentCheckAvailable"] is False
    assert material["unresolved"] is True and "OLD_INTERPRETATION" not in str(material)


@pytest.mark.parametrize("failure",["provider","report","task","context"])
def test_failed_or_stale_recheck_never_appends_a_success(app_fixture,model,monkeypatch,failure):
    app,_,_,path=app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base,record,payload=await seeded(c,path)
            data=await checked(c,base+"/patient-tasks/investigate",payload);item=data["items"][0]
            demo.save_review(record,copy.deepcopy(REPORT),1);payload.update(expectedRevision=1,reportRevision=2)
            async def late(_,messages):
                if failure=="provider":raise RuntimeError("PRIVATE_PROVIDER_DATA")
                if failure=="report":demo.save_review(record,copy.deepcopy(REPORT),2)
                if failure=="task":demo.save_patient_task(record,1,2,lambda *_:None)
                if failure=="context":monkeypatch.setattr(demo,"load_ecg_waveform",lambda *_:{"sampleRate":100,"leads":[]})
                return {"action":"read_report"}
            monkeypatch.setattr(pt,"complete_json",late)
            r=await c.post(base+"/patient-tasks/"+item["id"]+"/recheck",json=payload)
            assert r.status_code in (409,503) and "PRIVATE_PROVIDER_DATA" not in r.text
            assert not demo.read_record(record)["patientTasks"]["items"][0].get("rechecks")
    asyncio.run(run())


def test_task_update_invalidates_inflight_agent_followup(app_fixture,model,monkeypatch):
    app,_,_,path=app_fixture
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as c:
            base,record,payload=await seeded(c,path)
            result=await checked(c,base+"/patient-tasks/investigate",payload)
            async def answer(*_,**kwargs):
                demo.save_patient_task(record,1,1,lambda *_:None)
                return {"explanation":"late","source":"llm"}
            monkeypatch.setattr(demo,"guide_patient",answer)
            r=await c.post(base+"/understand",json={"contextId":payload["contextId"],"reportRevision":1,"question":"Explain","taskId":result["items"][0]["id"]})
            assert r.status_code==409
    asyncio.run(run())
