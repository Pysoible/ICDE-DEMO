import test from 'node:test';
import assert from 'node:assert/strict';
import {story,resetStory,loadStory,storyHtml,storyRefinement,selectStoryCase,storyFocusHtml} from '../src/revision_story.ts';
import {reportTextChanges,reportDiffHtml} from '../src/patient_report_view.ts';
import {t,setLanguage} from '../src/demo_i18n.ts';
const h={t:(s:string)=>s,esc:(s:any)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
const record=(id=2)=>({ecgId:id,role:'broken',targetLabel:false,before:[],after:['CD'],effect:'broken',checks:[{name:'qrs',op:'>=',value:100,observed:120,passes:true}]});
function setup(){resetStory();story.contextId='a';story.entries.i={loading:false,caseId:2,data:{target:'CD',counts:{broken:1,fixed:0,unchanged:3,unassessable:1},eligibleN:5,focus:record(26),examples:[record(),{...record(3),role:'boundary',effect:'unchanged'}]}};}
test('real counterexample, exact condition facts, no whole-case navigation',()=>{setup();const html=storyHtml('i',false,h);assert.ok(html.includes('ECG 2')&&html.includes('Counterexample')&&html.includes('120'));assert.ok(html.includes('data-story-refine')&&!html.includes('data-inspect-case'));assert.ok(storyFocusHtml('i',h).includes('CURRENT CASE'));});
test('in-place selection and follow-up uses only selected tuning witness',()=>{setup();selectStoryCase('i',3);const draft=storyRefinement('i',h);assert.ok(draft.includes('ECG 3')&&!draft.includes('ECG 2'));assert.ok(!draft.toLowerCase().includes('holdout'));selectStoryCase('i',999);assert.equal(story.entries.i.caseId,3);});
test('missing evidence and no recommendation are honest',()=>{setup();story.entries.i.data!.recommended=false;assert.ok(storyHtml('i',false,h).includes('not a recommendation'));story.entries.i.data!.examples=[];story.entries.i.data!.counts.broken=0;const html=storyHtml('i',false,h);assert.ok(html.includes('No eligible comparison case')&&html.includes('does not prove clinical validity'));});
test('user text is escaped and errors have retry without losing saved feedback',()=>{setup();story.entries.i.data!.examples[0].checks[0].name='<script>bad</script>';assert.ok(!storyHtml('i',false,h).includes('<script>'));story.entries.i={loading:false,error:'<script>fail</script>'};const html=storyHtml('i',false,h);assert.ok(html.includes('data-story-retry')&&!html.includes('<script>'));});
test('late response from previous case is ignored; failure is isolated',async()=>{
 const original=globalThis.fetch;let release!:(v:Response)=>void;
 try{globalThis.fetch=()=>new Promise(r=>release=r);resetStory();const p=loadStory('/case-a','a','i');resetStory();release(new Response(JSON.stringify({contextId:'a',itemId:'i',evidence:{examples:[]}})));await p;assert.deepEqual(story.entries,{});
 globalThis.fetch=async()=>{throw Error('offline')};await loadStory('/case-b','b','j');assert.equal(story.entries.j.error,'offline');assert.equal(story.entries.j.loading,false);
 }finally{globalThis.fetch=original;}
});
test('report difference compares actual paragraphs and preserves repeated paragraphs',()=>{assert.deepEqual(reportTextChanges('A\nB','A\nC'),{removed:['B'],added:['C']});assert.deepEqual(reportTextChanges('A\nA','A'),{removed:['A'],added:[]});});
test('report diff is expert-only draft information, never invents a prior report',()=>{assert.equal(reportDiffHtml({note:'New'},h),'');const first=reportDiffHtml({note:'New',patientReportId:'x'},h);assert.ok(first.includes('no earlier published'));const html=reportDiffHtml({note:'<new>',patientReportId:'x',ctx:{publishedReport:{note:'<old>',revision:2}}},h);assert.ok(html.includes('−1 / +1')&&html.includes('&lt;new>')&&!html.includes('<old>'));});
test('new comparison and report impact UI is bilingual',()=>{try{setLanguage('zh');assert.equal(t('Counterexample'),'反例');assert.equal(t('Ask Agent to refine using this example'),'请 Agent 结合此病例继续修订');assert.equal(t('Report impact'),'报告文字变化');}finally{setLanguage('en');}});
