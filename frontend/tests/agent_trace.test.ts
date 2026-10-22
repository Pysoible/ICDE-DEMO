import test from 'node:test';
import assert from 'node:assert/strict';
import {agentTrace,agentAssessment,invalidateAgentAssessment} from '../src/agent_trace.ts';
const h={t:(x:string)=>x,esc:(x:any)=>String(x??'').replaceAll('<','&lt;'),pretty:(x:string)=>x};
const r={investigation:{mode:'bounded_agent',maxToolCalls:3,stopReason:'ask_expert',question:'Need <morphology>',trace:[{step:1,action:'audit_sources',focus:'qrs_duration_ms',reason:'Check source coverage',observation:{measurements:[{name:'qrs_duration_ms',value:{qrs_ms:100}}],sources:[{available:false}],measurementChanges:[],cacheBypassed:false}}],assessmentValidationId:'v1',replayAssessment:{recommendation:'withhold',explanation:'Zero flags is not evidence of accuracy.',question:''}},validation:{id:'v1'}};
test('renders only actual action receipts, observed values, stop and targeted question',()=>{
  assert.equal(agentTrace(undefined as any,h),'');
  const html=agentTrace(r,h);
  for(const s of ['Inspect attached sources','qrs_ms','100','Expert clarification needed','Need &lt;morphology>'])assert.ok(html.includes(s));
  assert.ok(!html.includes('confidence'));
});
test('assessment is bound to the exact replay and hidden after edits or rerun',()=>{
  assert.ok(agentAssessment(r,false,h).includes('Recommendation withheld'));
  assert.ok(!agentAssessment(r,true,h).includes('Zero flags'));
  assert.ok(!agentAssessment({...r,validation:{id:'v2'}},false,h).includes('Zero flags'));
});
test('numeric input invalidates the old assessment immediately without waiting for blur',()=>{
  const panel={hidden:false},notice={hidden:true};
  const root={querySelector:(s:string)=>s==='.agent-assessment'?panel:notice};
  invalidateAgentAssessment(root as any);
  assert.ok(panel.hidden);assert.equal(notice.hidden,false);
});
