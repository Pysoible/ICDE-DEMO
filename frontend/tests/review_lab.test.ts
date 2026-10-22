import test from 'node:test';
import assert from 'node:assert/strict';
import {boundMatch,boundsOf,labOutcomes,thresholdLabHtml,measurementScale,provenanceChain} from '../src/review_lab.ts';
const h={t:(x:string)=>x,esc:(x:any)=>String(x??'').replaceAll('<','&lt;')};
const rows=[
  {ecgId:26,value:100,originalStatus:'normal'},
  {ecgId:62,value:null,originalStatus:'indeterminate'},
  {ecgId:3919,value:118,originalStatus:'abnormal'},
  {ecgId:1,value:120,originalStatus:'normal'},
  {ecgId:2,value:150,originalStatus:'indeterminate'},
];
const bounds={lower:110,upper:200,lowerInclusive:true,upperInclusive:false};

test('bound semantics mirror review_policy: lower inclusive, upper exclusive, missing stays null',()=>{
  const b={lower:110,upper:120,lowerInclusive:true,upperInclusive:false};
  assert.equal(boundMatch(b,110),true);
  assert.equal(boundMatch(b,120),false);
  assert.equal(boundMatch(b,109.9),false);
  assert.equal(boundMatch(b,null),null);
  assert.equal(boundMatch({...b,lowerInclusive:false},110),false);
  assert.equal(boundMatch({...b,upperInclusive:true},120),true);
});

test('preview counts follow replay rules; non-comparable original status is not assessable even in range',()=>{
  const r=labOutcomes(rows,bounds);
  assert.deepEqual([r.changed,r.unchanged,r.not_assessable],[2,1,2]);
  assert.equal(r.perRow.find(x=>x.ecgId===2)?.outcome,'not_assessable');
});

test('boundsOf applies the same defaults as the backend candidate model',()=>{
  assert.deepEqual(boundsOf({lower:110,upper:120}),{lower:110,upper:120,lowerInclusive:true,upperInclusive:false});
  assert.equal(boundsOf(null),null);
});

test('threshold lab states it is a preview, has two sliders, and reports matching validation',()=>{
  const html=thresholdLabHtml({rows,feature:'qrs_duration_ms',bounds,validated:bounds,locked:false,...h});
  for(const s of ['LIVE PREVIEW · NOT YET VALIDATED','data-lab-bound="lower"','data-lab-bound="upper"','Matches the validated condition.','Changed in preview'])
    assert.ok(html.includes(s),s);
  assert.ok(!html.includes(' disabled'));
  assert.ok(!/accuracy|improv|diagnos/i.test(html));
  const differs=thresholdLabHtml({rows,feature:'qrs_duration_ms',bounds:{...bounds,upper:150},validated:bounds,locked:true,...h});
  assert.ok(differs.includes('Run boundary tests &amp; case replay')||differs.includes('Run boundary tests & case replay'));
  assert.ok(differs.includes('disabled'));
});

test('measurement scale shows only the aggregate and the draft band, never per-beat positions',()=>{
  const html=measurementScale({name:'qrs_duration_ms',value:{qrs_ms:100}},{feature:'qrs_duration_ms',lower:110,upper:120},{...h,pretty:(x:string)=>x});
  assert.ok(html.includes('100 ms'));
  assert.ok(html.includes('scale-band'));
  assert.ok(html.includes('Aggregate measurement, not per-beat positions.'));
  assert.equal(measurementScale({name:'unknown_feature',value:1},null,h),'');
  assert.ok(measurementScale({name:'qrs_duration_ms',value:{}},null,h).includes('Measurement unavailable'));
});

test('provenance chain links record, measurements, overlay, replay and published version without claims',()=>{
  const report={revision:4,features:[{name:'qrs_duration_ms',value:{qrs_ms:100}}],reviewPolicy:{version:1,validationId:'abc123',candidate:{feature:'qrs_duration_ms',lower:110,upper:120,lowerInclusive:false,upperInclusive:false},counts:{changed:1,unchanged:2,not_assessable:0},caseIds:[26,3919,62],caseResult:{matched:true}}};
  const html=provenanceChain(report,{sample:{ecgId:26}},{...h,pretty:(x:string)=>x,value:()=>'100 ms'});
  for(const s of ['ECG 26','Review overlay v1','Scope: this case only','Replay receipt','abc123','Published report v4','Patients see only this published version'])
    assert.ok(html.includes(s),s);
  assert.ok(!/accuracy improved|clinically validated/i.test(html));
  const plain=provenanceChain({revision:1,features:[]},{sample:{ecgId:62}},{...h,pretty:(x:string)=>x,value:()=>''});
  assert.ok(!plain.includes('Review overlay'));
  assert.ok(plain.includes('Published report v1'));
});
