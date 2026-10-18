from __future__ import annotations
import asyncio
import copy
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from harnessing_ts import demo_interactions as demo
from harnessing_ts import expert_collaboration as expert


def test_collaboration_preserves_reports_and_requires_latest_version(tmp_path):
    path=tmp_path/'case.json'
    demo.save_review(path, {'status':'published','note':'Existing verified software fixture'}, 0)
    r={'id':'round1','decision':'pending','draftNote':'Suggested note'}
    demo.save_collaboration(path,0,round_record=r,report_revision=1)
    with pytest.raises(HTTPException):
        demo.save_collaboration(path,0,round_record=r)
    decision=demo.DecisionRequest(contextId='ctx',expectedRevision=1,roundId='round1',decision='accepted')
    demo.save_collaboration(path,1,decision=decision,report_revision=1)
    saved=demo.read_record(path)
    assert saved['revision']==1 and len(saved['reviews'])==1
    assert saved['collaboration']['rounds'][0]['decision']=='accepted'
    with pytest.raises(HTTPException):
        demo.save_collaboration(path,2,decision=decision)
    demo.save_review(path, {'status':'draft','note':'Concurrent edit'}, 1)
    with pytest.raises(HTTPException):
        demo.save_collaboration(path,2,round_record=r,report_revision=1)


def test_note_diff_and_measurement_changes_are_computed():
    assert expert.note_diff('A\nB','A\nC')==[{'kind':'same','text':'A'},{'kind':'removed','text':'B'},{'kind':'added','text':'C'}]
    assert expert.measurement_changes([{'name':'qrs','value':100}],[{'name':'qrs','value':100}])==[]
    assert len(expert.measurement_changes([{'name':'qrs','value':100}],[{'name':'qrs','value':110}]))==1


def test_payment_error_is_actionable_without_raw_provider_details(monkeypatch):
    real_client = httpx.AsyncClient
    def handler(request):
        return httpx.Response(402, json={'message': 'secret-provider-token'})
    monkeypatch.setattr(expert.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    config = SimpleNamespace(apiKey='fixture-key', baseUrl='https://provider.invalid', model='fixture')
    with pytest.raises(expert.ModelServiceUnavailable, match='HTTP 402') as exc:
        asyncio.run(expert.complete_json(config, []))
    assert 'secret-provider-token' not in str(exc.value)


def test_invalid_model_plan_and_invented_features_are_rejected(monkeypatch):
    async def fake(*_):return {'action':'rerun_measurements','focus':'invented','reason':'Check'}
    monkeypatch.setattr(expert,'complete_json',fake)
    with pytest.raises(ValueError):
        asyncio.run(expert.plan_check(None,'Check this','',['qrs'],None))
    async def fake_proposal(*_):return {'response':'Answer','draftNote':'A sufficiently long draft','unresolved':[],'nextChecks':[],'featureNames':['invented']}
    monkeypatch.setattr(expert,'complete_json',fake_proposal)
    with pytest.raises(ValueError):
        asyncio.run(expert.propose(None,feedback='Check',context={},result={'features':[]},plan=expert.Plan(action='review_evidence',focus='',reason='Check'),checks=[],history=[]))


@pytest.fixture
def app_fixture(tmp_path,monkeypatch):
    demo._CACHE.clear()
    monkeypatch.setenv('TS_HARNESS_VARIANT','NOD-KGR-KTL-CRV-SUB-ADA')
    monkeypatch.setattr(demo,'resolve_ecg_workspace',lambda *_:tmp_path)
    sample={'ecgId':26,'truth':['STTC'],'predicted':['MI','STTC','CD'],'exact':False}
    monkeypatch.setattr(demo,'build_ecg_overview',lambda *a,**k:{'samples':[sample],'iteration':'test-run','sampleCount':1})
    monkeypatch.setattr(demo,'load_ecg_waveform',lambda *_:{'durationSeconds':10,'sampleRate':100,'leads':[{'name':'II','values':[0,1,0]}]})
    monkeypatch.setattr(demo,'read_effective_llm_config',lambda _:SimpleNamespace())
    source=tmp_path/'references';source.mkdir();(source/'rule.md').write_text('Test rule')
    calls=[]
    result={'features':[{'name':'qrs_duration_ms','value':{'qrs_ms':100},'unit':'ms','judgment':{'status':'normal','rule':'Fixture rule'},'evidence':[{'referencePath':'references/rule.md','quote':'Test rule'}]}],'quality':{},'warnings':[]}
    def execute(*_):calls.append('execute');return copy.deepcopy(result)
    monkeypatch.setattr(demo,'execute_reference_feature_module',execute)
    async def plan(*_):return expert.Plan(action='rerun_measurements',focus='qrs_duration_ms',reason='User challenged reliability')
    monkeypatch.setattr(demo,'plan_check',plan)
    captures=[]
    async def propose(*a,**k):
        captures.append(k)
        return {'response':'Measurement unchanged; morphology remains unavailable.','draftNote':f'Research suggestion round {len(captures)}. No clinical diagnosis.','unresolved':['No beat boundaries supplied'],'nextChecks':['Check the source'],'featureNames':['qrs_duration_ms']}
    monkeypatch.setattr(demo,'propose',propose)
    app=FastAPI();app.include_router(demo.create_demo_router(tmp_path))
    return app,calls,captures,tmp_path


def test_full_loop_reexecutes_then_accepts_without_publishing(app_fixture):
    app,calls,captures,path=app_fixture
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26'
            ctx=(await c.get(base)).json(); cid=ctx['contextId']
            p={'contextId':cid,'expectedRevision':0,'message':'Prepare initial analysis','action':'review_evidence'}
            r=await c.post(base+'/collaboration',json=p);assert r.status_code==200,r.text
            first=r.json();assert len(calls)==1
            p.update(expectedRevision=1,message='This measurement may be unreliable. Recheck it.',action='auto')
            r=await c.post(base+'/collaboration',json=p);assert r.status_code==200,r.text
            second=r.json();assert len(calls)==2
            latest=second['rounds'][-1]
            assert latest['measurementChanges']==[]
            assert latest['beforeNote']==first['rounds'][0]['draftNote']
            assert captures[-1]['history'][0]['decision']=='pending'
            assert latest['sources'][0]['available'] is True
            assert latest['checks'][1]['name']=='Re-execute measurement tool'
            decision={'contextId':cid,'expectedRevision':2,'roundId':latest['id'],'decision':'accepted'}
            assert (await c.post(base+'/collaboration/decision',json=decision)).status_code==200
            unchanged=(await c.get(base)).json()
            assert unchanged['publishedReport'] is None and unchanged['revision']==0
            assert unchanged['sample']['predicted']==['MI','STTC','CD']
            assert (await c.post(base+'/review',json={'contextId':cid,'expectedRevision':0,'labels':['STTC'],'note':'Explicit research demo review by user','status':'published','featureNames':['qrs_duration_ms'],'analysisRoundId':latest['id']})).status_code==200
            saved=(await c.get(base)).json();assert saved['publishedReport']['analysisRoundId']==latest['id']
            assert (await c.post(base+'/collaboration',json=p)).status_code==409
    asyncio.run(scenario())


def test_failures_do_not_create_fake_round_or_expose_provider_errors(app_fixture,monkeypatch):
    app,_,_,_=app_fixture
    async def broken(*a,**k):raise RuntimeError('secret-provider-token')
    monkeypatch.setattr(demo,'propose',broken)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            r=await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':0,'message':'Check evidence','action':'review_evidence'})
            assert r.status_code==503 and 'secret-provider' not in r.text
            assert (await c.get(base+'/collaboration')).json()['rounds']==[]
            bad=await c.post(base+'/collaboration',json={'contextId':'old','expectedRevision':0,'message':'Check evidence'})
            assert bad.status_code==409
    asyncio.run(scenario())


@pytest.mark.parametrize('variant',['DIR','NOD-FQA-KTL-CXR-SUB-ADA','NOD-RQA-KTL-SUB-ADA'])
def test_disabled_variant_cannot_run_collaboration(app_fixture,monkeypatch,variant):
    app,calls,_,_=app_fixture;monkeypatch.setenv('TS_HARNESS_VARIANT',variant)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            r=await c.post('/api/demo/ptbxl/cases/26/collaboration',json={'contextId':'x','expectedRevision':0,'message':'Check evidence'})
            assert r.status_code==403
            assert calls==[]
    asyncio.run(scenario())


def test_report_change_during_analysis_rejects_late_response(app_fixture,monkeypatch):
    app,_,_,path=app_fixture
    async def changed(*a,**k):
        record=next((path/'state/icde-demo').glob('*.json'))
        demo.save_review(record,{'status':'draft','note':'Concurrent saved review'},0)
        return {'response':'Answer','draftNote':'Proposed draft note','unresolved':[],'nextChecks':[],'featureNames':[]}
    monkeypatch.setattr(demo,'propose',changed)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            demo.save_collaboration(path/'state/icde-demo'/f'ptbxl-26-{cid}.json',0,round_record={'id':'fixture','decision':'rejected','message':'Previous question','response':'Previous answer','draftNote':'Previous draft'})
            r=await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':1,'message':'Check evidence','action':'review_evidence'})
            assert r.status_code==409
            assert len((await c.get(base+'/collaboration')).json()['rounds'])==1
    asyncio.run(scenario())


def test_reject_then_followup_retains_decision_and_missing_source(app_fixture):
    app,_,captures,path=app_fixture
    (path/'references/rule.md').rename(path/'references/moved-rule.md')
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            p={'contextId':cid,'expectedRevision':0,'message':'Audit the sources','action':'audit_sources'}
            first=(await c.post(base+'/collaboration',json=p)).json()
            latest=first['rounds'][-1]
            assert latest['sources'][0]['available'] is False
            decision={'contextId':cid,'expectedRevision':1,'roundId':latest['id'],'decision':'rejected'}
            assert (await c.post(base+'/collaboration/decision',json=decision)).status_code==200
            assert (await c.post(base+'/review',json={'contextId':cid,'expectedRevision':0,'labels':['STTC'],'note':'Explicit software test review','analysisRoundId':latest['id']})).status_code==409
            p.update(expectedRevision=2,message='I reject the inference. Check its limitation.')
            assert (await c.post(base+'/collaboration',json=p)).status_code==200
            assert captures[-1]['history'][0]['decision']=='rejected'
            ctx=(await c.get(base)).json()
            assert ctx['publishedReport'] is None and ctx['revision']==0
    asyncio.run(scenario())
