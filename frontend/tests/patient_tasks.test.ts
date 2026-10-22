import test from 'node:test';
import assert from 'node:assert/strict';
import {newTaskView,syncTaskView,patientTaskBody,patientTaskComposer,expertTaskQueue,workKey,canRecheck} from '../src/patient_tasks.ts';
import {zhPatientTasks} from '../src/patient_tasks_zh.ts';
const esc=(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const h={t:(s:string)=>s,esc,pretty:(s:string)=>s,date:(s:string)=>s};
function state(){const item={id:'one',status:'prepared',question:'What supports <CD>?',reportRevision:1,createdAt:'now',investigation:{checks:[{action:'read_report',reportRevision:1,labels:['CD'],hasText:true},{action:'inspect_attachments',attachmentCount:1,rows:[{name:'qrs',status:'not_assessable',hasNumericValue:false,warningCount:1}]}],explanation:'<model interpretation>',limitation:'Cause unknown',reviewQuestion:'Review this basis.'}};return {tasksUI:newTaskView(),ctx:{contextId:'ctx',publishedReport:{revision:1,labels:['CD']},patientTasks:{revision:1,items:[item]}},expertTasks:{revision:1,items:[item]},busy:'',journey:{selected:'report'}} as any;}
test('task view persists across publication and language rerenders, but resets on case context',()=>{
 const s=state();syncTaskView(s);s.tasksUI.question='draft';s.tasksUI.requests.one='edited';s.ctx.publishedReport.revision=2;syncTaskView(s);
 assert.equal(s.tasksUI.question,'draft');assert.equal(s.tasksUI.requests.one,'edited');assert.equal(s.tasksUI.selectedId,'one');
 s.ctx.contextId='other';syncTaskView(s);assert.equal(s.tasksUI.question,'');assert.deepEqual(s.tasksUI.requests,{});
});
test('prepared task has real checks and editable confirmation, not a submitted badge or medical verification',()=>{
 const s=state();syncTaskView(s);const html=patientTaskBody(s,h);
 assert.match(html,/Application check receipt/);assert.match(html,/patient-check-trace/);assert.match(html,/No numeric value/);
 assert.ok(!html.includes('not clinical correctness'));assert.ok(!html.includes('NOT A CLINICAL VERDICT'));
 assert.match(html,/id="patient-task-submit"/);assert.match(html,/task has not been saved/);assert.match(html,/&lt;model interpretation>/);
 assert.ok(!html.includes('expert queue'));assert.match(html,/data-task-followup="one"/);
 assert.ok(html.indexOf('pt-model')<html.indexOf('patient-task-submit'));
 assert.ok(!expertTaskQueue(s,h).includes('What supports'));
});
test('submitted and in-review states require actual status; prepared text disappears',()=>{
 const s=state();syncTaskView(s);for(const status of ['submitted','in_review']){
  s.ctx.patientTasks.items[0].status=status;const html=patientTaskBody(s,h);
  assert.ok(!html.includes('id="patient-task-submit"'));assert.ok(!html.includes('no doctor reply or response time is promised'));
  assert.match(html,status==='submitted'?/evidence gap is saved/:/professional evidence check has started/);
  assert.match(html,/&lt;model interpretation>/);assert.match(html,/Help me understand this finding/);
 }
});
test('stale prepared requests cannot be submitted against a new published version',()=>{
 const s=state();syncTaskView(s);s.ctx.publishedReport.revision=2;const html=patientTaskBody(s,h);
 assert.match(html,/report has changed/);assert.ok(!html.includes('id="patient-task-submit"'));
});
test('published reply returns to the original question and describes real changes, including null results',()=>{
 const s=state();syncTaskView(s);const i=s.ctx.patientTasks.items[0];i.status='answered';
 i.answer={text:'Published <answer>',reportRevision:1,unresolved:true,change:{kind:'assessment_retained',beforeRevision:1,afterRevision:1,added:[],removed:[],retained:['CD']}};
 i.currentImpact=i.answer.change;
 const html=patientTaskBody(s,h);assert.match(html,/class="patient-specific-note">Cause unknown/);assert.match(html,/Report assessment retained/);
 assert.match(html,/&lt;answer>/);assert.match(html,/data-task-followup="one"/);assert.match(html,/YOUR ORIGINAL QUESTION/);
 s.ctx.publishedReport.revision=2;assert.match(patientTaskBody(s,h),/finding above is historical/);
});
test('expert links actual work instead of drafting a patient reply; source/version changes invalidate approval',()=>{
 const s=state(),i=s.expertTasks.items[0];i.status='in_review';i.requestText='Patient concern';
 assert.match(expertTaskQueue(s,h),/No eligible work yet/);assert.ok(!expertTaskQueue(s,h).includes('data-task-draft'));
 i.workOptions=[{kind:'revision',id:'r1',baseReportRevision:1}];let html=expertTaskQueue(s,h);
 assert.match(html,/data-task-complete="one"[^>]*disabled/);
 s.tasksUI.work[workKey(i,1)]='revision:r1';s.tasksUI.approvals[workKey(i,1)]=true;
 html=expertTaskQueue(s,h);assert.ok(!/data-task-complete="one"[^>]*disabled/.test(html));
 assert.ok(!html.includes('<textarea'));s.ctx.publishedReport.revision=2;
 assert.match(expertTaskQueue(s,h),/data-task-complete="one"[^>]*disabled/);
});
test('follow-up material is discarded on a new publication, not silently applied to the new report',()=>{
 const s=state();syncTaskView(s);s.tasksUI.followupId='one';s.tasksUI.followupRevision=1;s.journey.selected='clarification';
 syncTaskView(s);assert.equal(s.tasksUI.followupId,'one');s.ctx.publishedReport.revision=2;syncTaskView(s);
 assert.equal(s.tasksUI.followupId,'');assert.equal(s.journey.selected,'report');
});
test('composer is explicit and bounded; only published labels are selectable',()=>{
 const s=state();s.ctx.sample={truth:['MI'],predicted:['NORM']};const html=patientTaskComposer(s,h);
 assert.match(html,/maxlength="500"/);assert.match(html,/value="CD"/);assert.ok(!html.includes('MI'));assert.ok(!html.includes('NORM'));
 assert.ok(!html.includes('does not diagnose symptoms or change your report'));
});
test('core task stages have Chinese translations',()=>{
 for(const k of ['Check my question','Application check receipt','Start this review','Record review work','Report assessment retained','Ask Agent to check'])assert.ok(zhPatientTasks[k]);
});
test('published changes and Agent recheck are visible without a doctor reply or submitted task',()=>{
 const s=state();syncTaskView(s);const i=s.ctx.patientTasks.items[0];
 s.ctx.publishedReport.revision=2;i.currentImpact={kind:'evidence_updated',beforeRevision:1,afterRevision:2,added:[],removed:[],retained:['CD'],attachmentsChanged:true};
 assert.equal(canRecheck(i,2),true);let html=patientTaskBody(s,h);
 assert.match(html,/Published attachments updated/);assert.match(html,/v1 → v2/);
 assert.match(html,/data-task-recheck="one"/);assert.ok(!html.includes('not proof that your question caused'));
 i.rechecks=[{reportRevision:2,reviewOutcomeId:'',investigation:{checks:[],explanation:'Fresh Agent finding',limitation:'Still limited'}}];
 assert.equal(canRecheck(i,2),false);html=patientTaskBody(s,h);assert.match(html,/Fresh Agent finding/);
 assert.ok(!html.includes('finding above is historical'));
 i.reviewOutcome={id:'new-work'};assert.equal(canRecheck(i,2),true);
});
test('return visits prioritize the linked response; a new question expands explicitly and preserves drafts',()=>{
 const s=state();syncTaskView(s);
 assert.match(patientTaskComposer(s,h),/id="patient-task-new"/);
 assert.ok(!patientTaskComposer(s,h).includes('id="patient-task-question"'));
 s.tasksUI.composing=true;assert.match(patientTaskComposer(s,h),/id="patient-task-question"/);
 s.tasksUI.composing=false;s.tasksUI.question='Unsent follow-up';
 assert.match(patientTaskComposer(s,h),/Unsent follow-up/);
 s.ctx.patientTasks.items=[];s.tasksUI.question='';
 assert.match(patientTaskComposer(s,h),/id="patient-task-question"/);
});
