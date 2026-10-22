from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from harnessing_ts import agent_investigation as agent
from harnessing_ts import demo_interactions as demo
from test_expert_collaboration import app_fixture
from test_review_policy import setup, candidate


def test_next_action_depends_on_actual_observation_and_stops(monkeypatch):
    decisions, executions = [], []
    async def provider(_, messages):
        data = json.loads(messages[-1]['content']);decisions.append(data)
        steps = data['executedSteps']
        action = 'audit_sources' if not steps else 'rerun_measurements' if steps[-1]['observation'].get('missing') else 'finish'
        return {'action': action, 'focus': 'qrs_duration_ms', 'reason': 'Check the observed uncertainty', 'question': ''}
    async def execute(plan, result):
        executions.append(plan.action)
        return {'result': result, 'checks': [], 'sources': [], 'changes': [], 'observation': {'missing': plan.action == 'audit_sources'}}
    async def guard(): pass
    monkeypatch.setattr(agent, 'complete_json', provider)
    result = asyncio.run(agent.investigate(None, question='Check source and reproducibility', focus='',
        result={'features':[{'name':'qrs_duration_ms'}]}, history=[], execute=execute, guard=guard))
    assert executions == ['audit_sources', 'rerun_measurements']
    assert decisions[1]['executedSteps'][0]['observation']['missing'] is True
    assert result['investigation']['stopReason'] == 'finish'
    assert len(result['investigation']['trace']) == 2


def test_implementation_mapping_is_read_from_source_not_assumed(tmp_path):
    assert agent.qrs_mapping_excerpt(tmp_path) is None
    source=tmp_path/'tools/reference-feature-extractor/extractor.py'
    source.parent.mkdir(parents=True)
    source.write_text('qrs = m.get("qrs_width_ms_p75")\nvalue = {"qrs_ms": qrs}\n')
    excerpt=agent.qrs_mapping_excerpt(tmp_path)
    assert excerpt['lines'][0]['line']==1
    assert excerpt['lines'][1]['code']=='value = {"qrs_ms": qrs}'


@pytest.mark.parametrize('mode', ['duplicate', 'budget', 'unavailable', 'ask'])
def test_execution_is_bounded_and_missing_tools_are_not_invented(monkeypatch, mode):
    calls=[]
    async def provider(_, messages):
        n=len(json.loads(messages[-1]['content'])['executedSteps'])
        return {'action': 'ask_expert' if mode=='ask' else ['review_evidence','audit_sources','rerun_measurements','review_evidence'][n] if mode=='budget' else 'audit_sources',
                'focus': 'unavailable' if mode=='unavailable' else 'qrs_duration_ms',
                'reason':'A bounded next check', 'question':'What morphology did you observe?' if mode=='ask' else ''}
    async def execute(plan, result):
        calls.append(plan.action)
        return {'result':result,'checks':[],'changes':[],'sources':[],'observation':{}}
    async def guard():pass
    monkeypatch.setattr(agent,'complete_json',provider)
    async def run():return await agent.investigate(None,question='Check',focus='',result={'features':[{'name':'qrs_duration_ms'}]},history=[],execute=execute,guard=guard)
    if mode=='unavailable':
        with pytest.raises(ValueError):asyncio.run(run())
        assert not calls
    else:
        result=asyncio.run(run())['investigation']
        assert result['stopReason']=={'duplicate':'duplicate_check','budget':'tool_budget','ask':'ask_expert'}[mode]
        assert len(calls)=={'duplicate':1,'budget':3,'ask':0}[mode]


def install_two_step_planner(monkeypatch):
    async def provider(_, messages):
        data=json.loads(messages[-1]['content'])
        if 'actualReplay' in data:
            assert data['actualReplay']['counts']=={'changed':1,'unchanged':1,'not_assessable':1}
            return {'recommendation':'withhold','explanation':'Selected replay does not prove clinical benefit.','question':''}
        n=len(data['executedSteps'])
        return {'action':['audit_sources','rerun_measurements','finish'][n], 'focus':'qrs_duration_ms',
                'reason':'Respond to the preceding observation','question':''}
    monkeypatch.setattr(agent,'complete_json',provider)


def test_autonomous_route_replays_before_answer_and_never_auto_adopts(setup,monkeypatch):
    app,path,_,calls=setup
    install_two_step_planner(monkeypatch)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';ctx=(await c.get(base)).json()
            response=await c.post(base+'/collaboration',json={'contextId':ctx['contextId'],'expectedRevision':0,
                'message':'Investigate the rule','autonomous':True,'caseIds':[62,63]})
            assert response.status_code==200,response.text
            state=response.json();r=state['rounds'][-1]
            assert len(r['investigation']['trace'])==2
            assert calls==[26,26,62,63]
            assert r['decision']=='pending' and 'policy' not in r
            assert r['validation']['initiatedBy']=='agent'
            assert r['validation']['counts']=={'changed':1,'unchanged':1,'not_assessable':1}
            assert r['investigation']['replayAssessment']['recommendation']=='withhold'
            assert r['investigation']['assessmentValidationId']==r['validation']['id']
            assert (await c.get(base)).json()['revision']==0
            # It remains explicitly adoptable, never automatically adopted or published.
            response=await c.post(base+'/collaboration/decision',json={'contextId':ctx['contextId'],'expectedRevision':1,
                'roundId':r['id'],'decision':'accepted','validationId':r['validation']['id']})
            assert response.status_code==200,response.text
            assert (await c.get(base)).json()['publishedReport'] is None
    asyncio.run(scenario())


def test_concurrent_report_change_stops_before_next_action(app_fixture,monkeypatch):
    app,calls,_,path=app_fixture
    async def provider(*_):
        record=next((path/'state/icde-demo').glob('*.json'))
        demo.save_review(record,{'status':'draft','note':'Concurrent fixture'},0)
        return {'action':'rerun_measurements','focus':'qrs_duration_ms','reason':'Recheck','question':''}
    monkeypatch.setattr(agent,'complete_json',provider)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            demo.save_collaboration(path/'state/icde-demo'/f'ptbxl-26-{cid}.json',0,round_record={'id':'fixture','decision':'rejected','message':'Old question','response':'Old answer','draftNote':'Old draft'})
            response=await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':1,'message':'Check reliability','autonomous':True})
            assert response.status_code==409
            assert len(calls)==1 # no late rerun or fake completed round
            assert len((await c.get(base+'/collaboration')).json()['rounds'])==1
    asyncio.run(scenario())


def test_replay_assessment_failure_is_not_saved_as_success(setup,monkeypatch):
    app,_,_,_=setup
    async def provider(_,messages):
        data=json.loads(messages[-1]['content'])
        if 'actualReplay' in data:raise ValueError('invalid format')
        return {'action':'finish','focus':'','reason':'Existing measurements suffice','question':''}
    monkeypatch.setattr(agent,'complete_json',provider)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            response=await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':0,'message':'Check','autonomous':True})
            assert response.status_code==503
            assert (await c.get(base+'/collaboration')).json()['rounds']==[]
    asyncio.run(scenario())


def test_comparison_context_changes_during_assessment_rejects_entire_round(setup,monkeypatch):
    app,_,mutable,_=setup
    async def provider(_,messages):
        data=json.loads(messages[-1]['content'])
        if 'actualReplay' in data:
            mutable['sourceVersion']=1
            return {'recommendation':'retain_for_review','explanation':'Fixture only','question':''}
        return {'action':'finish','focus':'','reason':'Use existing evidence','question':''}
    monkeypatch.setattr(agent,'complete_json',provider)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            response=await c.post(base+'/collaboration',json={'contextId':cid,'expectedRevision':0,'message':'Check','autonomous':True,'caseIds':[62]})
            assert response.status_code==409
            assert (await c.get(base+'/collaboration')).json()['rounds']==[]
    asyncio.run(scenario())


def test_missing_capability_blocks_autonomous_execution(setup,monkeypatch):
    app,_,_,calls=setup;monkeypatch.setenv('TS_HARNESS_VARIANT','NOD-FQA-KTL-CXR-SUB-ADA')
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            response=await c.post('/api/demo/ptbxl/cases/26/collaboration',json={'contextId':'x','expectedRevision':0,'message':'Check','autonomous':True})
            assert response.status_code==403 and calls==[]
    asyncio.run(scenario())
