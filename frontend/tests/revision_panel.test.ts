import test from 'node:test';
import assert from 'node:assert/strict';
import {rev,resetRevision,revisionHtml,revisionFlag,describeCandidate,selectedRevision,feedbackImpactHtml} from '../src/revision_panel.ts';
const h={t:(x:string)=>x,esc:(x:any)=>String(x??'').replaceAll('<','&lt;')};
const sub=(n:number,fixed:number,broken:number,b:number,r:number)=>({n,fixed,broken,changed:fixed+broken,unassessable:3,baseline:{f1:b},revised:{f1:r},macroF1:{baseline:.76,revised:.761}});
const cand={kind:'criterion',target:'MI',action:'remove_label',rationale:'r',conditions:[{source:'prob',name:'MI',op:'<=',value:0.5},{source:'feature',name:'q_wave_v1v3_present.present',op:'<=',value:0}]};
const result=(over:Obj={})=>({opinion:'MI is too loose',stopReason:'finish',explanation:'Narrow rule supported on tuning only.',notice:'',missing:'',chosen:1,candidate:cand,
  attempts:[{index:1,candidate:cand,reason:'most faithful',subsets:{tuning:sub(1129,4,1,.764,.767),holdout:sub(1064,9,6,.767,.766)},verdict:{tuning:'gain',holdout:'mixed'},flipCount:20,focus:null,chosen:true}],rejected:[],
  evaluation:{target:'MI',subsets:{tuning:sub(1129,4,1,.764,.767),holdout:sub(1064,9,6,.767,.766),all:sub(2193,13,7,.7655,.7667)},verdict:{tuning:'gain',holdout:'mixed'},flipCount:3,flips:[
    {ecgId:705,set:'holdout',before:true,after:false,label:true,effect:'broken'},{ecgId:26,set:'tuning',before:true,after:false,label:false,effect:'fixed'},{ecgId:134,set:'holdout',before:true,after:false,label:false,effect:'fixed'}],flipsTruncated:false},
  focus:{ecgId:26,truth:['STTC'],before:['MI','STTC','CD'],after:['STTC','CD'],effect:'fixed'},focusBaseline:{ecgId:26,truth:['STTC'],predicted:['MI','STTC','CD']},...over});
type Obj=Record<string,any>;
const item=(over:Obj={},res:Obj={})=>({id:'i1',opinion:'MI is too loose',decision:'pending',result:result(res),...over});
const setup=(items:Obj[],status:Obj={available:true,inValidationSet:true,tuningN:1129,holdoutN:1064})=>{resetRevision();rev.items=items;rev.status=status;};

test('no revision yet: form only, with the honest scope note and no results',()=>{
  setup([]);
  const html=revisionHtml(false,h);
  for(const s of ['id="rev-draft"','id="rev-submit"','closed set','No model retraining','Your feedback reports','Before & after'])assert.ok(html.includes(s),s);
  assert.ok(!html.includes('rv-chain')&&!html.includes('data-rv-decide'));
});

test('chain shows current case and tuning metrics only, preserving tuning regressions',()=>{
  setup([item()]);
  const html=revisionHtml(false,h);
  for(const s of ['MI is too loose','P(MI) &lt;= 0.5','q_wave_v1v3_present.present','remove the label','Now agrees with the dataset label','Original prediction','Expert-informed candidate',
                  'Tuning set','1129','0.764 → 0.767','Improved','not independent generalization validation'])
    assert.ok(html.includes(s),s);
  for(const hidden of ['Holdout set','1064','2193','0.767 → 0.766','data-inspect-case="705"','data-inspect-case="134"'])assert.ok(!html.includes(hidden),hidden);
  assert.ok(html.includes('data-inspect-case="26"'));
  assert.ok(html.includes('No longer agree</th>')&&html.includes('class="broken">1</td>'));
  assert.ok(html.includes('removed: MI'));
  assert.ok(html.includes('AGENT EXPLANATION · MODEL TEXT'));   // model prose is labelled as such
});

test('decision controls exist only for a pending revision with a candidate; adoption never claims publication',()=>{
  setup([item()]);
  const pending=revisionHtml(false,h);
  assert.ok(pending.includes('data-rv-decide="adopted"')&&pending.includes('data-rv-decide="rejected"'));
  assert.ok(revisionHtml(true,h).includes('data-rv-decide="adopted" data-rv-item="i1" disabled'));
  setup([item({decision:'adopted',adoption:{version:2}})]);
  const adopted=revisionHtml(false,h);
  assert.ok(!adopted.includes('data-rv-decide')&&adopted.includes('Adopted v2')&&adopted.includes('nothing is published'));
  setup([item({decision:'rejected'})]);
  assert.ok(revisionHtml(false,h).includes('Rejected. Nothing was changed.'));
});

test('an opinion the measurements cannot express is reported, not approximated, and cannot be adopted',()=>{
  setup([item({},{stopReason:'cannot_express',candidate:null,chosen:null,evaluation:null,focus:null,attempts:[],missing:'An ST-segment depth measurement'})]);
  const html=revisionHtml(false,h);
  assert.ok(html.includes('cannot express this opinion')&&html.includes('An ST-segment depth measurement')&&html.includes('not approximated'));
  assert.ok(!html.includes('data-rv-decide="adopted"')&&html.includes('data-rv-decide="rejected"')&&html.includes('Dismiss'));
  assert.ok(!html.includes('rv-table'));
});

test('no recommendation still shows negative tuning counts without other subsets',()=>{
  setup([item({},{candidate:null,chosen:null,evaluation:null,focus:null,notice:'',attempts:[{index:1,candidate:cand,reason:'literal',subsets:{tuning:sub(1129,45,72,.75,.6),holdout:sub(1064,34,85,.8,.6)},verdict:{tuning:'loss',holdout:'loss'},flipCount:117,focus:null,chosen:false}]})]);
  const html=revisionHtml(false,h);
  assert.ok(html.includes('does not recommend a change')&&html.includes('What the agent tried')&&html.includes('Worse'));
  assert.ok(html.includes('+45 / −72')&&!html.includes('+34 / −85')&&!html.includes('Holdout set')&&!html.includes('Recommended</b>'));
});

test('unavailable inputs and records outside the validation set are explained and disable the form',()=>{
  setup([],{available:false,reason:'The validation feature table has not been built.'});
  let html=revisionHtml(false,h);
  assert.ok(html.includes('not available')&&html.includes('feature table')&&!html.includes('id="rev-submit"'));
  setup([],{available:true,inValidationSet:false});
  html=revisionHtml(false,h);
  assert.ok(html.includes('outside the validation set')&&!html.includes('id="rev-submit"'));
});

test('library badges follow the latest non-rejected revision only',()=>{
  setup([item()]);
  assert.equal(revisionFlag(26),'fixed');assert.equal(revisionFlag(705),null);assert.equal(revisionFlag(1),null);
  setup([item({decision:'rejected'})]);assert.equal(revisionFlag(26),null);
  setup([]);assert.equal(revisionFlag(26),null);
});

test('rule text is readable and user text is escaped; no accuracy or diagnosis claims anywhere',()=>{
  assert.equal(describeCandidate({kind:'threshold',target:'CD',theta:0.4},h),'CD: decision threshold becomes <b>0.4</b>');
  assert.equal(describeCandidate(null,h),'');
  setup([item({opinion:'<script>alert(1)</script>'})]);
  const html=revisionHtml(false,h);
  assert.ok(!html.includes('<script>'));
  assert.ok(!/accuracy (improved|gain)|diagnosis (changed|improved)|clinically validated|now correct/i.test(html));
});

test('history click selects that report and never exposes a decision on an older pending candidate',()=>{
  setup([item({id:'older',opinion:'Old concern'},{explanation:'Old explanation'}),item({id:'newer',opinion:'New concern'},{explanation:'New explanation'})]);
  rev.selectedId='older';
  assert.equal(selectedRevision()?.id,'older');
  const html=revisionHtml(false,h);
  assert.ok(html.includes('Old explanation')&&!html.includes('New explanation'));
  assert.ok(!html.includes('data-rv-decide')&&html.includes('data-rv-open="newer"'));
  assert.equal((html.match(/class="surface feedback-column"/g)||[]).length,3);
  assert.ok(!html.includes('revision-grid')&&!html.includes('rv-chain'));
});

test('adoption is separate from use in draft, and a report snapshot is escaped and stable',()=>{
  setup([item({decision:'adopted',adoption:{version:1}})]);
  assert.ok(revisionHtml(false,h).includes('data-rv-draft="i1"'));
  const snap={opinion:'<script>old</script>',candidate:cand,focus:result().focus};
  const before=feedbackImpactHtml(snap,h);
  rev.items.push(item({id:'new'}));
  assert.equal(feedbackImpactHtml(snap,h),before);
  assert.ok(before.includes('&lt;script>')&&!before.includes('<script>'));
  assert.ok(before.includes('later feedback does not rewrite'));
  const draft=feedbackImpactHtml(snap,h,false);
  assert.ok(draft.includes('draft changes')&&draft.includes('saved only when'));
  assert.ok(!draft.includes('Saved report snapshot'));
});

test('changing case clears the feedback draft and selection',()=>{
  rev.draft='unfinished';rev.sourceReportRevision=2;rev.selectedId='old';
  resetRevision();
  assert.equal(rev.draft,'');assert.equal(rev.selectedId,'');assert.equal(rev.sourceReportRevision,null);
});

test('published feedback opens its saved report and no longer claims it is unpublished',()=>{
  setup([item({decision:'adopted',adoption:{version:1}})]);
  const html=revisionHtml(false,h,{review:{revisionItemId:'i1'},publishedReport:{revisionItemId:'i1',revision:2}});
  assert.ok(html.includes('Published as report v2')&&html.includes('data-rv-report'));
  assert.ok(!html.includes('nothing is published yet')&&!html.includes('data-rv-draft'));
});

test('computed receipt is primary and fallible model prose is collapsed, never an execution receipt',()=>{
  setup([item()]);let html=revisionHtml(false,h);
  assert.ok(html.includes('TEST RECEIPT · APPLICATION COMPUTED'));
  assert.ok(html.includes('<details class="rv-reply"><summary>')&&!html.includes('<details class="rv-reply" open'));
  setup([item({}, {candidate:null,evaluation:null,attempts:[],explanation:'Unexecuted claim'})]);
  html=revisionHtml(false,h);assert.ok(html.includes('No candidate was executed in this round'));
});
