import test from 'node:test';
import assert from 'node:assert/strict';
import {revisionWorkspace} from '../src/revision_workspace.ts';
const h={t:(x:string)=>x,esc:(x:any)=>String(x).replaceAll('<','&lt;'),pretty:(x:string)=>x,value:()=>'',status:()=>'',disabled:()=>''};
const initial={collaboration:{revision:0,rounds:[]},policyDraft:null,policyDirty:false,cases:[],cohort:[],expertQuestion:'unsent question',expertAction:'auto',expertFocus:''};
const candidate={feature:'qrs_duration_ms',lower:110,upper:120,lowerInclusive:false,upperInclusive:false,rationale:'Test only'};
const round={id:'r',decision:'pending',response:'Analysis',features:[],checks:[],nextChecks:[],unresolved:[],draftNote:'Draft not published',diff:[],message:'Question',candidate};
test('three panels and unsent question are preserved before investigation',()=>{
  const html=revisionWorkspace(initial,h);
  for(const x of ['Delegate a review goal','Agent investigation','Replay & reassess','unsent question'])assert.ok(html.includes(x));
  assert.ok(!html.includes('id="accept-suggestion"'));
});
test('adoption stays disabled until validated; zero changed is displayed without embellishment',()=>{
  const validation={id:'v',candidate,counts:{changed:0,unchanged:1,not_assessable:1},rows:[{ecgId:26,value:100,originalStatus:'normal',afterFlag:'no_overlay',outcome:'unchanged'},{ecgId:62,value:null,originalStatus:'indeterminate',afterFlag:'not_assessable',outcome:'not_assessable'}],boundaryTests:[{value:112,matched:true},{value:null,matched:null}]};
  for(const dirty of [true,false]){
    const html=revisionWorkspace({...initial,collaboration:{rounds:[{...round,validation}]},policyDraft:candidate,policyDirty:dirty},h);
    const button=html.match(/<button id="accept-suggestion"[^>]*>/)![0];
    assert.equal(button.includes('disabled'),dirty);
    assert.ok(html.includes('synthetic, not patients'));
    assert.ok(html.includes('<b>0</b>'));
    assert.ok(!html.includes('accuracy improved'));
  }
});
test('no executable candidate does not fabricate a rule or replay',()=>{
  const html=revisionWorkspace({...initial,collaboration:{rounds:[{...round,candidate:null}]}},h);
  assert.ok(html.includes('No executable condition proposed'));
  assert.ok(!html.includes('id="validate-policy"'));
});
test('adopted condition is immutable in rendering and does not publish',()=>{
  const html=revisionWorkspace({...initial,policyDraft:candidate,collaboration:{rounds:[{...round,decision:'accepted',policy:{version:2,validationId:'receipt'}}]}},h);
  assert.ok(html.includes('Adopted review overlay'));
  assert.ok(html.includes('id="policy-lower"')&&html.includes('value="110" placeholder="—" disabled'));
  assert.ok(html.includes('No report has been published by this action.'));
  assert.ok(!html.includes('id="accept-suggestion"'));
});
