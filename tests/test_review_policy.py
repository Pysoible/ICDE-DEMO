from __future__ import annotations
import asyncio
import copy
import json
import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from harnessing_ts import demo_interactions as demo
from harnessing_ts.review_policy import Candidate, matches, boundary_tests, replay_row

def candidate(**changes):
    return Candidate(feature='qrs_duration_ms', lower=110, upper=120,
        lowerInclusive=False, upperInclusive=False, rationale='Software test of source coverage gap', **changes)

def test_bounds_missing_and_unavailable_are_distinct():
    c=candidate()
    assert [matches(c,x) for x in [109,110,111,112,119,120,121,None]]==[False,False,True,True,True,False,False,None]
    inclusive=c.model_copy(update={'lowerInclusive':True,'upperInclusive':True})
    assert matches(inclusive,110) and matches(inclusive,120)
    assert any(x['value']==110 and x['matched'] is False for x in boundary_tests(c))
    assert boundary_tests(c)[-1]=={'value':None,'matched':None,'kind':'missing_measurement'}
    feature={'name':'qrs_duration_ms','value':{'qrs_ms':112},'judgment':{'status':'indeterminate'}}
    assert replay_row(c,feature,26,'ctx')['outcome']=='not_assessable'
    assert replay_row(c,None,26,'ctx')['outcome']=='not_assessable'
    feature['judgment']['status']='abnormal'
    assert replay_row(c,feature,26,'ctx')['outcome']=='changed'
    assert feature['judgment']['status']=='abnormal'  # no mutation

@pytest.mark.parametrize('change',[{'lower':120,'upper':110},{'lower':None,'upper':None},{'lower':float('nan')},{'feature':'invented'},{'action':'diagnose'},{'code':'eval(1)'}])
def test_unsafe_or_invalid_candidate_is_rejected(change):
    data=candidate().model_dump();data.update(change)
    with pytest.raises(ValidationError):Candidate.model_validate(data)

@pytest.fixture
def setup(tmp_path,monkeypatch):
    demo._CACHE.clear();monkeypatch.setenv('TS_HARNESS_VARIANT','NOD-KGR-KTL-CRV-SUB-ADA')
    monkeypatch.setattr(demo,'resolve_ecg_workspace',lambda *_:tmp_path)
    def overview(*args,**kwargs):
        n=kwargs.get('ecg_id') or 26
        return {'samples':[{'ecgId':n,'truth':['STTC'],'predicted':['CD'],'exact':False}],'iteration':'fixture','sampleCount':3}
    monkeypatch.setattr(demo,'build_ecg_overview',overview)
    mutable={'sourceVersion':0}
    monkeypatch.setattr(demo,'load_ecg_waveform',lambda _,n:{'sampleRate':100,'durationSeconds':10,'leads':[{'name':'II','values':[0,mutable['sourceVersion'] if n==62 else 0,0]}]})
    calls=[]
    def execute(_,inp):
        n=inp['ecg_id'];calls.append(n)
        return {'features':[{'name':'qrs_duration_ms','value':{'qrs_ms':{26:112,62:100,63:None}.get(n)},'judgment':{'status':'abnormal' if n!=63 else 'indeterminate','rule':'Fixture'},'evidence':[]}],'warnings':[]}
    monkeypatch.setattr(demo,'execute_reference_feature_module',execute)
    monkeypatch.setattr(demo,'read_effective_llm_config',lambda _:None)
    async def propose(*_,**kwargs):
        return {'response':'Fixture source gap, not medical proof','draftNote':'Candidate only; not yet validated or adopted.','featureNames':['qrs_duration_ms'],'unresolved':[],'nextChecks':[],'candidate':candidate().model_dump()}
    monkeypatch.setattr(demo,'propose',propose)
    app=FastAPI();app.include_router(demo.create_demo_router(tmp_path))
    return app,tmp_path,mutable,calls

def test_end_to_end_validate_edit_adopt_and_explicit_publish(setup):
    app,path,mutable,calls=setup
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            base='/api/demo/ptbxl/cases/26';ctx=(await client.get(base)).json();cid=ctx['contextId']
            r=await client.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':0,'message':'Check QRS source gap','action':'audit_sources'})
            assert r.status_code==200,r.text
            round=r.json()['rounds'][-1];rid=round['id']
            decision={'contextId':cid,'expectedRevision':1,'roundId':rid,'decision':'accepted'}
            assert (await client.post(base+'/collaboration/decision',json=decision)).status_code==409
            req={'contextId':cid,'expectedRevision':1,'roundId':rid,'candidate':candidate().model_dump(),'caseIds':[26,62,63,26]}
            response=await client.post(base+'/collaboration/validate',json=req);assert response.status_code==200,response.text
            v=response.json()['rounds'][-1]['validation']
            assert v['counts']=={'changed':1,'unchanged':1,'not_assessable':1}
            assert [x['ecgId'] for x in v['rows']]==[26,62,63]
            assert v['applied'] is False and v['changesPredictions'] is False
            assert (await client.get(base)).json()['revision']==0
            # A second validation supersedes, but does not erase, the old receipt.
            req['expectedRevision']=2;req['candidate']['lower']=115
            response=await client.post(base+'/collaboration/validate',json=req);assert response.status_code==200,response.text
            second=response.json()['rounds'][-1]
            assert len(second['validationHistory'])==2 and second['validation']['counts']['changed']==0
            decision.update(expectedRevision=3,validationId=v['id'])
            assert (await client.post(base+'/collaboration/decision',json=decision)).status_code==409
            decision['validationId']=second['validation']['id']
            response=await client.post(base+'/collaboration/decision',json=decision);assert response.status_code==200,response.text
            adopted=response.json()['rounds'][-1]['policy']
            assert adopted['version']==1 and adopted['candidate']['lower']==115
            assert adopted['caseResult']['matched'] is False and adopted['caseResult']['value']==112
            assert adopted['expertEdited'] is True
            assert adopted['scope']=='case_local_review_overlay'
            unchanged=(await client.get(base)).json();assert unchanged['publishedReport'] is None and unchanged['sample']['predicted']==['CD']
            assert (await client.post(base+'/collaboration/validate',json=dict(req,expectedRevision=4))).status_code==409
            report={'contextId':cid,'expectedRevision':0,'labels':['STTC'],'note':'Explicit software fixture report, not clinical care.','status':'published','analysisRoundId':rid,'policyRoundId':rid}
            response=await client.post(base+'/review',json=report);assert response.status_code==200,response.text
            saved=(await client.get(base)).json()['publishedReport']
            assert saved['reviewPolicy']['candidate']['lower']==115
            assert saved['reviewPolicy']['validationId']==second['validation']['id']
            assert saved['reviewPolicy']['expertQuestion']=='Check QRS source gap'
    asyncio.run(scenario())

def test_validation_requires_current_record_and_rejects_late_report_change(setup,monkeypatch):
    app,path,mutable,calls=setup
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            r=(await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':0,'message':'Check coverage','action':'audit_sources'})).json()['rounds'][-1]
            req={'contextId':cid,'expectedRevision':1,'roundId':r['id'],'candidate':candidate().model_dump(),'caseIds':[62]}
            assert (await c.post(base+'/collaboration/validate',json=req)).status_code==422
            original=demo.execute_reference_feature_module
            def concurrent(*args):
                result=original(*args)
                demo.save_review(path/'state/icde-demo'/f'ptbxl-26-{cid}.json',{'status':'draft','note':'Concurrent software test draft'},0)
                return result
            monkeypatch.setattr(demo,'execute_reference_feature_module',concurrent)
            req['caseIds']=[26,62]
            assert (await c.post(base+'/collaboration/validate',json=req)).status_code==409
            stored=(await c.get(base+'/collaboration')).json()
            assert stored['revision']==1 and 'validation' not in stored['rounds'][-1]
            assert (await c.get(base)).json()['review']['note']=='Concurrent software test draft'
    asyncio.run(scenario())

def test_replay_context_change_rejects_adoption_and_preserves_history(setup):
    app,path,mutable,calls=setup
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            round=(await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':0,'message':'Check coverage','action':'audit_sources'})).json()['rounds'][-1]
            req={'contextId':cid,'expectedRevision':1,'roundId':round['id'],'candidate':candidate().model_dump(),'caseIds':[26,62]}
            v=(await c.post(base+'/collaboration/validate',json=req)).json()['rounds'][-1]['validation']
            mutable['sourceVersion']=1
            decision={'contextId':cid,'expectedRevision':2,'roundId':round['id'],'validationId':v['id'],'decision':'accepted'}
            assert (await c.post(base+'/collaboration/decision',json=decision)).status_code==409
            decision['decision']='rejected'
            assert (await c.post(base+'/collaboration/decision',json=decision)).status_code==200
            assert (await c.get(base)).json()['publishedReport'] is None
            assert (await c.get(base+'/collaboration')).json()['rounds'][-1].get('policy') is None
    asyncio.run(scenario())

@pytest.mark.parametrize('variant',['DIR','NOD-FQA-KTL-CXR-SUB-ADA','NOD-RQA-KTL-SUB-ADA','NOD-RQA-CRV-SUB-ADA'])
def test_variant_gates_validation_and_decision_before_tools(setup,monkeypatch,variant):
    app,_,_,calls=setup;monkeypatch.setenv('TS_HARNESS_VARIANT',variant)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26/collaboration'
            assert (await c.post(base+'/validate',json={'contextId':'x','expectedRevision':0,'roundId':'x','candidate':candidate().model_dump(),'caseIds':[26]})).status_code==403
            assert (await c.post(base+'/decision',json={'contextId':'x','expectedRevision':0,'roundId':'x','decision':'rejected'})).status_code==403
            assert not calls
    asyncio.run(scenario())
