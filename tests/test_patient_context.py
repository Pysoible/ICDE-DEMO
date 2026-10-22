import asyncio
import json

import pytest

from harnessing_ts.patient_context import needs_urgent_guidance, patient_context, symptom_mentions
from harnessing_ts.patient_guide import guide_patient

REPORT = {'revision': 3, 'labels': ['MI', 'STTC', 'CD'], 'note': 'Published findings.', 'features': []}
QUESTION = '我最近经常熬夜，通常凌晨两点睡、早上七点起，每天喝两杯咖啡。有时喝完咖啡会觉得心跳明显，持续几分钟后缓解，目前没有胸痛、气短或晕倒。我看到报告里的几个异常标签有些担心。该如何休息，是否需要自行吃药？'


@pytest.mark.parametrize('text', [
    QUESTION, '目前没有胸痛、气短或晕倒', '我无胸痛、无呼吸困难、无晕厥。',
    '我没有出现明显的胸痛，也没有气短。', '没有胸痛，气短或晕倒。',
    '胸痛没有，心慌有。', '我不伴有胸痛', '我否认胸痛和气短',
    'I have no chest pain, shortness of breath, or fainting.',
    "I don't have chest pain or shortness of breath.",
    'I do not have chest pain, and I have never experienced fainting.',
    'I deny chest pain and breathlessness.', 'I am not having chest pain.',
    '什么是胸痛？', '气短是什么意思？', 'What is chest pain?', 'Define fainting.',
])
def test_explicit_local_denials_and_exact_definitions_do_not_trigger_emergency(text):
    assert not needs_urgent_guidance(text)


@pytest.mark.parametrize('text', [
    '胸痛', '我现在胸痛', '目前气短', '我刚才晕倒了', '我现在喘不过气',
    '没有胸痛，但有气短', '没有胸痛但刚才晕倒了',
    '我没睡好，现在胸痛', '没有吃药，胸痛持续十分钟',
    '没有胸痛现在呼吸困难', '没有胸痛、气短或晕倒，不过刚才昏倒了',
    '我不是没有胸痛', '并非无胸痛', '不能排除胸痛',
    '我不确定有没有胸痛', '我好像胸痛', '我没有胸痛？',
    'I have no chest pain but I just fainted.',
    'No chest pain. I have shortness of breath now.',
    "I'm not sure whether I have chest pain.",
    'I do not deny chest pain.', 'not without chest pain',
    '我没有否认胸痛', '我未否认胸痛', 'I have no reason to deny chest pain.',
    '以前没有胸痛，现在有了。',
    'What is chest pain? I have it now',
])
def test_positive_uncertain_and_mixed_symptoms_keep_conservative_priority(text):
    assert needs_urgent_guidance(text)


def test_denial_provenance_never_becomes_an_inferred_absence():
    mentions = symptom_mentions(QUESTION)
    assert {m['name'] for m in mentions if m['status'] == 'denied'} == {'chest_pain', 'breathlessness', 'fainting'}
    for mention in mentions:
        assert mention['quote'] in QUESTION
        if mention['status'] == 'denied':
            assert '没有' in mention['quote']
    assert symptom_mentions('我喝咖啡后心慌')[0]['status'] == 'reported'
    assert not any(m['status'] == 'denied' for m in symptom_mentions('我喝咖啡后心慌'))


def test_current_user_supersedes_earlier_user_not_assistant_and_keeps_conflict():
    history = [{'role': 'user', 'text': '我没有胸痛'}, {'role': 'assistant', 'text': '我现在晕厥'}]
    context = patient_context('现在我胸痛，心慌', history, REPORT)
    assert {m['name'] for m in context['symptoms']} == {'chest_pain', 'palpitations'}
    assert all(m['status'] == 'reported' for m in context['symptoms'])
    context = patient_context('我没有胸痛，但刚才胸痛了', [], REPORT)
    assert {m['status'] for m in context['symptoms']} == {'denied', 'reported'}
    assert needs_urgent_guidance('我没有胸痛，但刚才胸痛了')


def test_report_conflict_is_from_snapshot_not_gt_or_prediction():
    assert patient_context(QUESTION, [], REPORT)['reportClaim']['conflict'] is False
    normal = {**REPORT, 'revision': 1, 'labels': ['NORM'], 'truth': ['CD'], 'predicted': ['MI']}
    context = patient_context(QUESTION, [], normal)
    assert context['reportClaim']['conflict'] is True
    assert context['report'] == {'revision': 1, 'labels': ['NORM']}
    assert 'truth' not in str(context) and 'predicted' not in str(context)
    assert patient_context('报告显示正常', [], REPORT)['reportClaim']['conflict'] is True
    assert patient_context('报告显示正常', [], {**REPORT, 'labels': ['NORM','CD']})['reportClaim']['conflict'] is True
    assert patient_context('报告里是不是有异常标签？', [], normal)['reportClaim'] is None


@pytest.mark.parametrize('labels,conflict', [(['NORM'], True), (['MI','STTC','CD'], False)])
def test_negated_question_reaches_model_with_actual_context_and_one_question(labels,conflict):
    calls=[]
    async def complete(_,messages):
        data=json.loads(messages[-1]['content']); calls.append(data)
        assert data['patientContext']['report']['labels'] == labels
        assert data['patientContext']['reportClaim']['conflict'] is conflict
        return {'explanation':'睡眠不足和咖啡因可能与心慌有关，不能确定原因。',
                'understanding':'not_checked','references':['report'],
                'nextQuestion':'怎样记录发作？',
                'followUpQuestion':'不喝咖啡的时候也会出现吗？',
                'contextUpdates':[{'quote':'凌晨两点睡、早上七点起','focusField':'explanation'}]}
    answer=asyncio.run(guide_patient(None,report={**REPORT,'labels':labels},question=QUESTION,
        mode='prepare',language='zh',selected='report',history=[],complete=complete))
    assert len(calls)==1 and answer['source']=='llm'
    assert answer['patientContext']['report']['labels']==labels and answer['followUpQuestion']


def test_prepare_context_requires_bounded_followup_rewrite():
    calls=[]
    async def complete(_,messages):
        calls.append(1)
        return {'explanation':'先记录发作时间。','understanding':'not_checked','references':[],
                'nextQuestion':'怎样记录？', 'followUpQuestion':'' if len(calls)==1 else '发作时心跳会明显加快吗？',
                'contextUpdates':[{'quote':'我最近心慌','focusField':'explanation'}]}
    answer=asyncio.run(guide_patient(None,report=REPORT,question='我最近心慌',mode='prepare',language='zh',selected='report',history=[],complete=complete))
    assert len(calls)==2 and answer['followUpQuestion']


def test_schema_and_multiple_followups_use_the_same_bounded_rewrite():
    for bad in ('schema','questions'):
        calls=[]
        async def complete(_,messages):
            calls.append(1)
            updates=[{'quote':'我最近心慌','focusField':'explanation'}]
            return {'explanation':'记录发作时间。','understanding':'not_checked','references':[],
                    'nextQuestion':'怎样记录？',
                    'followUpQuestion':'是否加快？是否不齐？' if bad=='questions' and len(calls)==1 else '发作时心跳会明显加快吗？',
                    'contextUpdates':updates*4 if bad=='schema' and len(calls)==1 else updates}
        answer=asyncio.run(guide_patient(None,report=REPORT,question='我最近心慌',mode='prepare',language='zh',selected='report',history=[],complete=complete))
        assert len(calls)==2 and answer['followUpQuestion']=='发作时心跳会明显加快吗？'
