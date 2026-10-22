import asyncio
import copy
import json

import httpx
import pytest

from harnessing_ts import demo_interactions as demo
from harnessing_ts import patient_guide as guide
from harnessing_ts.expert_collaboration import ModelServiceUnavailable
from test_expert_collaboration import app_fixture  # noqa: F401

REPORT = {"revision": 1, "labels": ["CD"], "note": "A conduction-related demo finding, not a confirmed disease.",
          "features": [{"name": "qrs_duration_ms", "value": None, "unit": "ms", "judgment": {"status": "not_assessable", "rule": "private-rule"}, "evidence": ["private-source"]}],
          "patientReport": {"generator": "RecursiveECG", "instructions": "private-instructions"},
          "feedbackImpact": {"opinion": "private-opinion", "evaluation": "private-cohort", "candidate": "private-candidate", "focus": {"before": ["NORM", "CD"], "after": ["CD"]}}}
ANSWER = {"explanation": "This is a report category, not a confirmed illness.", "limitation": "Its cause is not established.",
          "understanding": "not_checked", "references": ["report"], "nextQuestion": "What does this finding mean alongside my medical history?"}


@pytest.mark.parametrize('text', ['本回答仅供参考。', '本系统不构成医疗建议。', 'This response is not medical advice.'])
def test_standalone_identity_boilerplate_is_removed(text):
    assert guide.concise_patient_text(text) == ''


@pytest.mark.parametrize('text', ['若现在胸痛，请立即寻求急救。', '阿司匹林会增加出血风险。', '本回答仅供参考，如果现在胸痛请立即急救。', '本报告不能确定异常发生时间。'])
def test_concrete_uncertainty_and_safety_actions_are_never_stripped(text):
    assert guide.concise_patient_text(text) == text


def test_context_quotes_must_come_from_real_user_turns_not_assistant_or_report():
    guide.validate_context_updates([{'quote':'熬夜后心慌','focus':'重点解释发作时间与记录方法'}], '熬夜后心慌，该记录什么？', [])
    guide.validate_context_updates([{'quote':'睡得很晚','focus':'优先解释睡眠安排'}], '那今天呢？', [{'role':'user','text':'我最近睡得很晚'}])
    for history in ([], [{'role':'assistant','text':'睡得很晚'}]):
        with pytest.raises(ValueError):
            guide.validate_context_updates([{'quote':'睡得很晚','focus':'重点解释睡眠'}], '如何休息？', history)
    with pytest.raises(ValueError):
        guide.validate_context_updates([{'quote':'如何休息','focus':'one'},{'quote':'如何休息','focus':'two'}], '如何休息？', [])


def test_invalid_context_gets_one_bounded_rewrite_and_valid_context_is_returned():
    calls=[]
    async def complete(_,messages):
        calls.append(1)
        return {**ANSWER,'contextUpdates':[{'quote':'invented' if len(calls)==1 else 'What does this mean?', 'focus':ANSWER['explanation']}]}
    answer=call(complete=complete)
    assert len(calls)==2 and answer['contextUpdates'][0]['quote']=='What does this mean?'


def test_boilerplate_alone_cannot_pass_as_a_useful_answer():
    async def complete(*_):return {**ANSWER,'explanation':'本回答仅供参考。'}
    with pytest.raises(ValueError):call(complete=complete)


def test_context_focus_must_be_copied_from_the_actual_answer():
    with pytest.raises(ValueError):
        guide.validate_context_updates([{'quote':'睡得很晚','focus':'已更改诊断'}], '我睡得很晚', [], ['保持规律作息'])
    guide.validate_context_updates([{'quote':'睡得很晚','focus':'保持规律作息'}], '我睡得很晚', [], ['可先保持规律作息，再记录疲倦时间'])


def test_focus_is_projected_from_actual_text_never_a_second_model_action_claim():
    updates=[{'quote':'睡得很晚','focusField':'dailyCare','focus':'我已经修改诊断'}]
    guide.ground_context_updates(updates,{'explanation':'先看作息。','dailyCare':'记录入睡与起床时间。观察白天疲倦。'})
    assert updates[0]['focus']=='记录入睡与起床时间。'
    updates=[{'quote':'睡得很晚','focusField':'medication'}]
    guide.ground_context_updates(updates,{'explanation':'先记录作息。','medication':''})
    assert updates[0]['focusField']=='explanation' and updates[0]['focus']=='先记录作息。'


def call(**kwargs):
    return asyncio.run(guide.guide_patient(None, report=copy.deepcopy(REPORT), question="What does this mean?",
        mode=kwargs.pop("mode", "explain"), language=kwargs.pop("language", "en"), selected=kwargs.pop("selected", "report"), history=[], **kwargs))


def test_only_published_allowlisted_materials_enter_model():
    seen = []
    async def complete(_, messages):
        seen.append(json.loads(messages[-1]["content"]))
        return copy.deepcopy(ANSWER)
    result = call(complete=complete)
    assert result["source"] == "llm"
    assert "private-" not in str(seen)
    assert "not_assessable" in str(seen) and 'None' in str(seen)
    assert "before" in str(seen) and "after" in str(seen)
    assert not any(k in seen[0] for k in ("truth", "scores", "cohort", "revisions"))


@pytest.mark.parametrize("mode", ["explain", "evidence", "uncertainty", "prepare", "teachback"])
def test_each_mode_and_language_are_explicit_and_factual(mode):
    async def complete(_, messages):
        data = json.loads(messages[-1]["content"])
        assert data["mode"] == mode and data["language"] == "zh"
        assert "never require them to learn" in messages[0]["content"].lower()
        return {**ANSWER, "understanding": "needs_clarification" if mode == "teachback" else "not_checked"}
    assert call(mode=mode, language="zh", complete=complete)["understanding"] == ("needs_clarification" if mode == "teachback" else "not_checked")


@pytest.mark.parametrize("update", [{"references": ["measurement:invented"]}, {"understanding": "consistent"},
    {"explanation": " "}, {"nextQuestion": ""}, {"unexpected": "x"}])
def test_invalid_or_invented_model_output_is_not_success(update):
    async def complete(*_): return {**ANSWER, **update}
    with pytest.raises(ValueError): call(complete=complete)


def test_unknown_selection_rejected_before_model():
    async def complete(*_): raise AssertionError("Must not call model")
    with pytest.raises(guide.PatientGuideInputError): call(selected="measurement:invented", complete=complete)


@pytest.mark.parametrize("language", ["en", "zh"])
def test_urgent_symptoms_bypass_model_in_both_languages(language):
    async def complete(*_): raise AssertionError("Must not call model")
    result = asyncio.run(guide.guide_patient(None, report=REPORT, question="我现在胸痛", mode="teachback", language=language, selected="report", history=[], complete=complete))
    assert result["source"] == "safety" and result["understanding"] == "not_checked"
    assert result["references"] == []
    assert ("紧急" if language == "zh" else "urgent") in result["explanation"]


@pytest.mark.parametrize("change", ["report", "context", "none", "provider", "format"])
def test_route_rechecks_versions_and_preserves_records(app_fixture, monkeypatch, change):
    app, _, _, root = app_fixture
    state = {"done": False}
    async def complete(_, **kwargs):
        if change == "provider": raise ModelServiceUnavailable("The model service returned HTTP 402 (payment/quota issue). Restore service availability before retrying.")
        if change == "format": raise ValueError("private-provider-error")
        if change == "report":
            path = next((root / "state/icde-demo").glob("*.json"))
            saved = demo.read_record(path)
            demo.save_review(path, {**REPORT, "status": "published", "note": "Concurrent new published note"}, saved["revision"])
        if change == "context":
            monkeypatch.setattr(demo, "load_ecg_waveform", lambda *_: {"sampleRate": 100, "leads": [], "durationSeconds": 11})
        state["done"] = True
        return {**ANSWER, "source": "llm", "materials": []}
    monkeypatch.setattr(demo, "guide_patient", complete)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            base = "/api/demo/ptbxl/cases/26"
            ctx = (await c.get(base)).json()
            request = {"contextId": ctx["contextId"], "reportRevision": 1, "question": "What does this mean?", "mode": "explain", "language": "zh"}
            assert (await c.post(base+"/understand", json=request)).status_code == 409
            path = root/"state/icde-demo"/f"ptbxl-26-{ctx['contextId']}.json"
            demo.save_review(path, {**REPORT, "status": "published"}, 0)
            before = path.read_bytes()
            response = await c.post(base+"/understand", json=request)
            assert response.status_code == (409 if change in ("report", "context") else 503 if change in ("provider", "format") else 200), response.text
            if change != "report": assert path.read_bytes() == before
            assert "private-provider-error" not in response.text
            if change == "none":
                assert response.json()["reportRevision"] == 1
                assert response.json()["contextId"] == ctx["contextId"]
    asyncio.run(scenario())


def test_prompt_forbids_technical_gatekeeping_and_medical_actions():
    text = guide.prompt("patient-guide")
    for phrase in ("not a diagnostic", "not independently verified sentence", "cannot alter report", "without unsupported reassurance", "NOT verification", "do not lead with technical", "not clinical correctness"):
        assert phrase.lower() in text.lower()


def test_ordinary_explanation_filters_legacy_research_and_old_assistant_turns():
    report = copy.deepcopy(REPORT)
    report['note'] = '报告记录了一项提示；数据集标签和模型输出不一致。报告说明部分形态未评估。'
    report['features'][0]['warnings'] = ['真值为CD', 'measurement unavailable']
    original = copy.deepcopy(report)
    async def complete(_, messages):
        data = json.loads(messages[-1]['content'])
        assert '数据集标签' not in str(data) and '模型输出' not in str(data) and '真值' not in str(data)
        assert '部分形态未评估' in str(data)
        assert data['materialFacts']['attachedMeasurementCount'] == 1
        assert data['publishedMaterials'][1]['status'] == 'not_assessable'
        return {**ANSWER, 'basis':'The report records a finding; its cause is not established.'}
    answer = asyncio.run(guide.guide_patient(None, report=report, question='Does this mean a diagnosis?',
        mode='uncertainty',language='en',selected='report',
        history=[{'role':'assistant','text':'数据集标签和模型输出不一致。The report records a finding.'}],complete=complete))
    assert answer['basis'].startswith('The report records') and report == original


@pytest.mark.parametrize('text', ['数据集标签与模型输出不一致，所以不能相信报告。', 'The ground truth proves your diagnosis.', 'The model prediction is wrong.'])
def test_research_comparisons_in_patient_response_are_rejected(text):
    async def complete(*_): return {**ANSWER,'basis':text}
    with pytest.raises(ValueError): call(complete=complete)


def test_authored_numeric_evidence_is_retained_but_not_recited_and_rewrite_is_bounded():
    calls=[]
    report={**REPORT,'note':'报告记录 QRS 为 100 ms。报告说明部分形态未评估。','features':[{**REPORT['features'][0],'value':100}]}
    async def complete(_,messages):
        data=json.loads(messages[-1]['content']);calls.append(data)
        assert not data['technicalDetailRequested']
        assert '100' in data['publishedMaterials'][0]['text']
        assert not data['publishedMaterials'][0]['technicalDescriptionsOmitted']
        assert data['publishedMaterials'][1]['value'] == 100
        return {**ANSWER,'explanation':'QRS is 100 ms.'} if len(calls)==1 else {**ANSWER,'basis':'The report states a finding.'}
    result=asyncio.run(guide.guide_patient(None,report=report,question='What is known?',mode='explain',language='en',selected='report',history=[],complete=complete))
    assert result['basis']=='The report states a finding.' and len(calls)==2
    assert calls[-1]['responseCorrectionRequired']


def test_education_is_separate_from_case_evidence_and_empty_boundary_is_valid():
    async def complete(_,messages):
        data=json.loads(messages[-1]['content'])
        assert data['generalEducation']['scope']=='general_health_education_not_case_evidence'
        assert [f['label'] for f in data['generalEducation']['findings']]==['CD']
        assert not any(m['id']=='generalEducation' for m in data['publishedMaterials'])
        return {**ANSWER,'explanation':'Conduction is how electrical signals coordinate the heartbeat.',
                'basis':'','limitation':'','symptoms':'Some people have no symptoms.',
                'dailyCare':'Keep regular sleep times and note when symptoms occur.',
                'medication':'A label alone does not select a medicine.'}
    result=call(complete=complete)
    assert result['limitation']=='' and result['dailyCare'] and result['medication']


@pytest.mark.parametrize('question',['请解释报告中的这一标签：CD','MI是什么意思','How should I rest?'])
def test_label_or_daily_question_does_not_request_measurement_details(question):
    assert not guide.technical_requested(question)


@pytest.mark.parametrize('question',['胸痛','我胸痛','我现在胸痛怎么办','请解释胸痛，我正在胸痛','I have chest pain','what is chest pain? I have it now'])
def test_personal_or_ambiguous_urgent_symptoms_keep_priority(question):
    assert guide.needs_urgent_guidance(question)


@pytest.mark.parametrize('question',['什么是胸痛？','胸痛是什么意思？','请解释晕厥','What is chest pain?','Define fainting.'])
def test_exact_educational_symptom_question_is_not_an_asserted_emergency(question):
    assert not guide.needs_urgent_guidance(question)


@pytest.mark.parametrize('field',['explanation','medication','dailyCare','symptoms','nextQuestion'])
def test_generated_dose_schedule_is_rejected_in_patient_sections(field):
    async def complete(*_): return {**ANSWER,field:'建议每天服用阿司匹林100毫克。'}
    with pytest.raises(ValueError): call(complete=complete)


def test_general_education_cannot_be_cited_as_case_evidence():
    async def complete(*_):return {**ANSWER,'references':['generalEducation']}
    with pytest.raises(ValueError):call(complete=complete)


def test_explicit_technical_question_keeps_recorded_numeric_details():
    async def complete(_,messages):
        data=json.loads(messages[-1]['content'])
        assert data['technicalDetailRequested'] and '100' in str(data['publishedMaterials'])
        return {**ANSWER,'basis':'The report records QRS as 100 ms, not independently verified.'}
    report={**REPORT,'note':'The report records QRS as 100 ms.'}
    result=asyncio.run(guide.guide_patient(None,report=report,question='What does QRS 100 ms mean?',mode='evidence',language='en',selected='report',history=[],complete=complete))
    assert '100 ms' in result['basis']


@pytest.mark.parametrize('bad', ['它说波形没看过，所以不能确认。', '它没有看波形，所以不能确认。'])
def test_imprecise_waveform_claim_is_not_a_success(bad):
    calls=[]
    async def complete(*_):
        calls.append(1)
        return {**ANSWER,'explanation':bad}
    with pytest.raises(ValueError): call(complete=complete)
    assert len(calls)==2


@pytest.mark.parametrize('compat', [False, True])
@pytest.mark.parametrize('change', ['none','context','report'])
def test_all_demo_explanation_routes_share_projection_and_stale_guards(app_fixture, monkeypatch, compat, change):
    app, _, _, root = app_fixture
    async def explain(_, **kwargs):
        report = kwargs['report']
        assert '模型输出' not in report['note'] and '数据集标签' not in report['note']
        assert kwargs['language'] == 'zh'
        if change == 'context': monkeypatch.setattr(demo,'load_ecg_waveform',lambda *_:{'sampleRate':100,'leads':[],'durationSeconds':11})
        if change == 'report':
            p = next((root/'state/icde-demo').glob('*.json'))
            demo.save_review(p,{**REPORT,'status':'published'},1)
        return {**ANSWER,'basis':'The report states a finding.','source':'llm','materials':guide.guide_materials(report)}
    monkeypatch.setattr(demo,'guide_patient',explain)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';ctx=(await c.get(base)).json()
            p=root/'state/icde-demo'/f"ptbxl-26-{ctx['contextId']}.json"
            demo.save_review(p,{**REPORT,'status':'published','note':'报告有提示。数据集标签和模型输出不一致。'},0)
            before=p.read_bytes()
            res=await c.post(base+('/question' if compat else '/understand'),json={'contextId':ctx['contextId'],'reportRevision':1,'question':'这代表确诊了吗？','language':'zh'})
            assert res.status_code == (200 if change == 'none' else 409),res.text
            if change != 'report': assert p.read_bytes() == before
            if compat and change == 'none': assert 'answer' in res.json() and '模型输出' not in res.text
    asyncio.run(run())
