import test from 'node:test';
import assert from 'node:assert/strict';
import {newJourney,syncJourney,journeyKey,patientCompanion,addQuestion,questionPacket,PatientViewState} from '../src/patient_companion.ts';
import {zhCompanion} from '../src/patient_companion_zh.ts';
const esc=(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const h={t:(s:string)=>s,esc,pretty:(s:string)=>s,value:()=> '100 ms',date:(s:string)=>s};
function state(){return {ctx:{contextId:'ctx',sample:{ecgId:26},feedback:[],publishedReport:{revision:1,labels:['CD'],note:'<script>not safe HTML</script>',features:[{name:'qrs_duration_ms'}],updatedAt:'now'}},journey:newJourney(),messages:[] as any[],busy:'',question:'my draft',feedback:'',showFeedback:false};}
test('published labels are visible above all disclosures, localized, and prepare editable questions',()=>{
 const s=state();s.ctx.publishedReport.labels=['CD','MI','STTC'];
 Object.assign(s.ctx.sample,{predicted:['UNPUBLISHED'],truth:['WEAK_TRUTH']});
 const html=patientCompanion(s,{...h,t:(k:string)=>zhCompanion[k]||k},{CD:'传导异常',MI:'与心肌梗死相关的模式',STTC:'ST 段或 T 波变化'},'','');
 const findings=html.slice(html.indexOf('<section class="patient-report-labels"'),html.indexOf('<div class="patient-report-ready"'));
 assert.match(findings,/报告提示/);assert.match(findings,/<b>CD<\/b><span>传导异常/);
 assert.equal((findings.match(/data-material="report"/g)||[]).length,3);
 assert.match(findings,/data-patient-prompt="[^\"]*CD"/);
 assert.ok(html.indexOf('patient-report-labels')<html.indexOf('<details'));
 assert.equal((html.match(/class="patient-findings"/g)||[]).length,1);
 assert.ok(!html.includes('UNPUBLISHED'));assert.ok(!html.includes('WEAK_TRUTH'));
 assert.match(findings,/点击一项/);assert.ok(!findings.includes('不代表症状或确诊'));
});
test('empty and unknown published labels stay honest and escaped; busy labels are disabled',()=>{
 const s=state();s.ctx.publishedReport.labels=[];
 assert.match(patientCompanion(s,h,{},'',''),/No labels in this published report/);
 s.ctx.publishedReport.labels=['<unknown>'];s.busy='working';
 const html=patientCompanion(s,h,{},'','');assert.match(html,/<b>&lt;unknown><\/b>/);
 assert.match(html,/data-patient-prompt="Please explain the report finding: &lt;unknown>" disabled/);
});
test('report change resets understanding, not unsent question; stable language rerender retains it',()=>{
 const s=state();syncJourney(s);s.journey.mode='teachback';s.journey.questions=['one'];s.messages.push({role:'assistant',text:'previous'});
 syncJourney(s);assert.equal(s.journey.mode,'teachback');assert.equal(s.messages.length,1);
 s.ctx.publishedReport.revision=2;syncJourney(s);assert.deepEqual(s.journey.questions,[]);assert.equal(s.messages.length,0);assert.equal(s.question,'my draft');assert.equal(s.journey.selected,'report');
 s.ctx.contextId='new';syncJourney(s);assert.equal(s.journey.key,journeyKey(s.ctx));
});
test('question list is explicit, deduplicated, bounded and linked to current published version',()=>{
 const s=state();addQuestion(s.journey,' a ');addQuestion(s.journey,'a');for(let i=0;i<10;i++)addQuestion(s.journey,String(i));
 assert.equal(s.journey.questions.length,6);const text=questionPacket(s,h.t);assert.match(text,/v1 · ECG 26/);assert.match(text,/1. a/);
});
test('main entry points address ordinary concerns; measurements are optional and folded',()=>{
 const s=state(),html=patientCompanion(s,h,{CD:'Conduction'},'','');
 assert.match(html,/Address my worries/);assert.match(html,/Add my situation/);
 assert.match(html,/<details data-patient-detail="technical" class="patient-technical"><summary>Optional:/);
 assert.ok(html.indexOf('patient-technical')<html.indexOf('qrs_duration_ms'));
 assert.match(html,/&lt;script>/);assert.ok(!html.includes('<script>not safe'));
 assert.ok(!html.includes('patient-teachback'));assert.match(html,/No model call until you send/);
});
test('teachback shows report consistency not a diagnosis grade; references and text are escaped',()=>{
 const s=state();s.messages=[{role:'user',text:'I am definitely ill?'},{role:'assistant',source:'llm',mode:'teachback',understanding:'needs_clarification',explanation:'<bad>',limitation:'Cannot diagnose',references:['report'],nextQuestion:'Ask <clinician>',reportRevision:1}];
 const html=patientCompanion(s,h,{CD:'Conduction'},'','');
 assert.match(html,/One distinction to clarify/);assert.ok(!html.includes('not a medical assessment'));assert.match(html,/&lt;bad>/);assert.match(html,/data-save-patient-question="Ask &lt;clinician>/);
 assert.match(html,/model-selected, not verified sentence-level/);assert.match(html,/Let me explain it back/);
});
test('safety guidance does not invite teachback, reassurance or question saving',()=>{
 const s=state();s.messages=[{role:'user',text:'chest pain'},{role:'assistant',source:'safety',explanation:'Urgent care',limitation:'No triage',reportRevision:1}];
 const html=patientCompanion(s,h,{},'','');assert.match(html,/SAFETY GUIDANCE/);assert.ok(!html.includes('id="patient-teachback"'));assert.ok(!html.includes('data-understood'));
});
test('marked-clear notebook retains the explanation, never a mistaken paraphrase as a new fact',()=>{
 const s=state();s.messages=[{role:'user',text:'WRONG_BELIEF'},{role:'assistant',source:'llm',mode:'teachback',understanding:'needs_clarification',explanation:'CORRECTION',limitation:'Unknown',references:[],nextQuestion:'Ask clinician',reportRevision:1}];
 s.journey.understood=['1'];const html=patientCompanion(s,h,{},'','');
 const notebook=html.slice(html.indexOf('class="patient-clear-list"'),html.indexOf('class="patient-reading-guide"'));
 assert.match(notebook,/CORRECTION/);assert.ok(!notebook.includes('WRONG_BELIEF'));
});
test('view snapshot restores actual details and scroll; a new report resets transient state',()=>{
 const d={dataset:{patientDetail:'technical'},open:true};const a={scrollTop:80},b={scrollTop:120};
 const root={querySelector:(s:string)=>s==='.patient-doc-scroll'?a:s==='.companion-scroll'?b:s==='.patient-studio'?{}:null,querySelectorAll:()=>[d]} as any;
 const view=new PatientViewState();view.restore(root,'ctx:1');view.capture(root);a.scrollTop=0;b.scrollTop=0;d.open=false;view.restore(root,'ctx:1');assert.equal(a.scrollTop,80);assert.equal(d.open,true);
 view.restore(root,'ctx:2');assert.deepEqual(view.details,{});assert.deepEqual(view.scroll,[]);
});
test('patient UI contains bilingual wording for core interactions',()=>{
 for(const k of ['Address my worries','Let me explain it back','One distinction to clarify','My clarification list','Check understanding'])assert.ok(zhCompanion[k]);
});
test('answer separates direct answer, supplied basis and limitation, and only prepares an editable next question',()=>{
 const s=state();s.messages=[{role:'user',text:'Does this mean a diagnosis?'},{role:'assistant',source:'llm',mode:'uncertainty',understanding:'not_checked',explanation:'DIRECT',basis:'BASIS <source>',limitation:'LIMIT',references:['report'],nextQuestion:'What can be checked?',reportRevision:1}];
 const html=patientCompanion(s,h,{},'','');
 assert.ok(html.indexOf('DIRECT')<html.indexOf('BASIS &lt;source>'));
 assert.ok(html.indexOf('LIMIT')<html.indexOf('BASIS &lt;source>'));
 assert.ok(html.indexOf('<details class="patient-answer-receipt"')<html.indexOf('BASIS &lt;source>'));
 assert.match(html,/data-patient-mode="explain" data-patient-prompt="What can be checked\?"/);
 assert.match(html,/Ask the Agent about this/);
 assert.ok(!html.includes('A question worth taking forward'));
 for(const k of ['First, your question','What the published material says','A useful next question','Ask the Agent about this']) assert.ok(zhCompanion[k]);
});
test('general care is visible, optional and escaped; empty limitations do not create a warning box',()=>{
 const s=state();s.messages=[{role:'user',text:'How to rest?'},{role:'assistant',source:'llm',explanation:'MEANING',dailyCare:'SLEEP <script>',medication:'DRUG EDUCATION',limitation:'',basis:'REPORT BASIS',references:['report'],nextQuestion:'What should I record?',reportRevision:1}];
 const html=patientCompanion(s,h,{},'','');
 assert.match(html,/GENERAL HEALTH INFORMATION/);assert.match(html,/SLEEP &lt;script>/);
 assert.ok(!html.includes('data-care-topic="symptoms"'));
 assert.ok(!html.includes('class="patient-specific-note"'));
 assert.ok(html.indexOf('DRUG EDUCATION')<html.indexOf('patient-answer-receipt'));
 assert.match(html,/data-patient-prompt="How should I arrange sleep/);
 for(const k of ['Possible symptoms & what to record','Rest & everyday habits','Understanding medicines'])assert.ok(zhCompanion[k]);
});
test('personal context focus is visible without changing published content or adding blanket disclaimers',()=>{
 const s=state();s.messages=[{role:'user',text:'I sleep late'},{role:'assistant',source:'llm',explanation:'Try a regular bedtime',contextUpdates:[{quote:'sleep late',focus:'Focus on sleep habits'}],limitation:'',references:[],nextQuestion:'What should I record?',reportRevision:1}];
 const before=JSON.stringify(s.ctx.publishedReport),html=patientCompanion(s,h,{},'','');
 assert.match(html,/How your input shaped/);assert.match(html,/sleep late/);assert.equal(JSON.stringify(s.ctx.publishedReport),before);
 assert.ok(!html.includes('A finding does not establish its cause'));
 assert.ok(!html.includes('Public dataset example, not a personal clinical report'));
 assert.ok(!html.includes('patient-specific-note'));
});
