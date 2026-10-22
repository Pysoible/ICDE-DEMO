import asyncio
import json

import httpx
import pytest

from harnessing_ts import demo_interactions as demo
from harnessing_ts import revision_loop as rl
from harnessing_ts.revision_evidence import candidate_evidence
from test_expert_collaboration import app_fixture  # noqa: F401
from test_revision_agent import revision_app, build_data, script, thr, post, run  # noqa: F401
from test_revision_loop import make_data, row


def test_tuning_witnesses_are_real_exclude_focus_patient_and_keep_condition_facts():
    data=build_data(); data.patient_ids=['a','b','c','d','e','f']
    cand=rl.parse_candidate(thr(.4),data)
    evidence=candidate_evidence(data,cand,26)
    assert evidence['counts']=={'broken':1,'fixed':0,'unchanged':1,'unassessable':0}
    assert [(r['ecgId'],r['role']) for r in evidence['examples']]==[(2,'broken'),(3,'boundary')]
    assert evidence['focus']['after']==['CD']
    assert evidence['examples'][0]['checks']==[dict(source='prob',name='CD',op='>=',value=.4,observed=.45,passes=True)]
    data.patient_ids[1]='a'
    assert candidate_evidence(data,cand,26)['counts']['broken']==0


def test_missing_condition_is_unknown_and_does_not_create_a_fake_counterexample():
    data=make_data([row(1,'tuning',.45,True,qrs=120),row(2,'tuning',.45,False),row(3,'tuning',.1,False,qrs=80)])
    cand=rl.parse_candidate(dict(kind='criterion',target='CD',action='add_label',rationale='test',
        conditions=[dict(source='feature',name='qrs',op='>=',value=100)]),data)
    ev=candidate_evidence(data,cand,2)
    assert ev['focus']['effect']=='unassessable' and ev['focus']['before']==ev['focus']['after']
    assert ev['focus']['checks'][0]['passes'] is None
    assert ev['counts']['broken']==0 and ev['counts']['fixed']==1


def test_counts_do_not_depend_on_the_truncated_flip_list():
    data=make_data([row(i,'tuning',.45,False) for i in range(401)])
    cand=rl.parse_candidate(thr(.4),data)
    assert len(rl.evaluate(data,cand)['flips'])==300
    ev=candidate_evidence(data,cand,0)
    assert ev['counts']['broken']==400 and ev['eligibleN']==400
    assert ev['examples'][0]['ecgId']==1


def test_reviewed_patient_and_no_tuning_cases_never_fabricate_witnesses():
    data=make_data([row(1,'holdout',.45,True),row(2,'holdout',.45,False)])
    data.patient_ids=['same','same'];data=rl.for_review(data,1)
    ev=candidate_evidence(data,rl.parse_candidate(thr(.4),data),1)
    assert ev['examples']==[] and ev['eligibleN']==0
    assert ev['focus']['set']=='review'


def test_agent_receives_counterexample_before_the_next_decision(monkeypatch):
    seen=script(monkeypatch,[dict(action='evaluate',candidate=thr(.4)),dict(action='finish',chosen=None)])
    result=run(build_data())
    dossier=seen[1]['user']['executed'][0]['caseEvidence']
    assert dossier['examples'][0]['ecgId']==2 and dossier['examples'][0]['role']=='broken'
    assert 'holdout' not in json.dumps(seen[1]['user']).lower()
    assert result['attempts'][0]['caseEvidence']==dossier


@pytest.mark.parametrize('recommend',[True,False])
def test_read_only_route_serves_historical_evidence_without_changing_records(revision_app,monkeypatch,recommend):
    app,path=revision_app
    script(monkeypatch,[dict(action='evaluate',candidate=thr(.4)),dict(action='finish',chosen=1 if recommend else None)])
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            item=(await post(c,base,cid,0)).json()['items'][0]
            files={p:p.read_bytes() for p in path.glob('state/icde-demo/*.json')}
            r=await c.get(base+'/revision/'+item['id']+'/evidence')
            assert r.status_code==200,r.text
            ev=r.json()['evidence'];assert ev['recommended']==recommend and ev['examples'][0]['ecgId']==2
            assert files=={p:p.read_bytes() for p in path.glob('state/icde-demo/*.json')}
            assert (await c.get(base+'/revision/missing/evidence')).status_code==404
            changed=build_data();changed.input_fingerprint='new'
            monkeypatch.setattr(demo.rev,'load_revision_data',lambda _:changed)
            assert (await c.get(base+'/revision/'+item['id']+'/evidence')).status_code==409
    asyncio.run(scenario())


def test_evidence_route_rechecks_fingerprint_after_computation(revision_app,monkeypatch):
    from harnessing_ts import revision_evidence as re
    app,_=revision_app
    script(monkeypatch,[dict(action='evaluate',candidate=thr(.4)),dict(action='finish',chosen=1)])
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            base='/api/demo/ptbxl/cases/26';cid=(await c.get(base)).json()['contextId']
            item=(await post(c,base,cid,0)).json()['items'][0]
            original=re.candidate_evidence
            def during(*args):
                out=original(*args);changed=build_data();changed.input_fingerprint='changed'
                monkeypatch.setattr(demo.rev,'load_revision_data',lambda _:changed)
                return out
            monkeypatch.setattr(re,'candidate_evidence',during)
            assert (await c.get(base+'/revision/'+item['id']+'/evidence')).status_code==409
    asyncio.run(scenario())


@pytest.mark.parametrize('variant',['DIR','NOD-RQA-SUB-ADA','NOD-FQA-KTL-CXR-SUB-ADA'])
def test_read_only_comparison_respects_disabled_capabilities(revision_app,monkeypatch,variant):
    app,_=revision_app;monkeypatch.setenv('TS_HARNESS_VARIANT',variant)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            assert (await c.get('/api/demo/ptbxl/cases/26/revision/any/evidence')).status_code==403
    asyncio.run(scenario())
