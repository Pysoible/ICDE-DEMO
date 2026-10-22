import test from 'node:test';
import assert from 'node:assert/strict';
import {patientResponseFocus,patientCheckTrace,patientContextCard,patientFollowUp} from '../src/patient_response.ts';
import {zhCompanion} from '../src/patient_companion_zh.ts';
import {zhPatientTasks} from '../src/patient_tasks_zh.ts';
const h={t:(s:string)=>s,esc:(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
test('legacy and generic answers do not invent personalization',()=>{
 assert.equal(patientResponseFocus({},h),'');assert.equal(patientResponseFocus({contextUpdates:[]},h),'');
});
test('exact user quote and model focus are escaped and separated',()=>{
 const html=patientResponseFocus({contextUpdates:[{quote:'<patient>',focus:'<focus>'}]},h);
 assert.match(html,/&lt;patient>/);assert.match(html,/&lt;focus>/);
 assert.match(html,/You shared/);assert.match(html,/Agent focus/);assert.ok(!html.includes('<patient>'));
});
test('trace only renders actual completed checks, including empty inventories and absent versions',()=>{
 assert.equal(patientCheckTrace([],h),'');
 const html=patientCheckTrace([{action:'inspect_attachments',attachmentCount:0},{action:'compare_publications',available:false},{action:'fake_diagnosis'}],h);
 assert.match(html,/Attachments checked/);assert.match(html,/>0</);assert.match(html,/No earlier version/);
 assert.ok(!html.includes('Report read'));assert.ok(!html.includes('fake_diagnosis'));
});
test('new interactions are bilingual',()=>{
 for(const key of ['YOUR INPUT → THIS ANSWER','How your input shaped the explanation','You shared','Agent focus','Add my situation'])assert.ok(zhCompanion[key]);
 for(const key of ['Report read','Attachments checked','Versions compared','AGENT CHECK RESULT'])assert.ok(zhPatientTasks[key]);
});
test('explicit denial and the actual published report remain separate',()=>{
 const html=patientContextCard({patientContext:{symptoms:[{name:'chest_pain',status:'denied',quote:'<no chest pain>'},{name:'palpitations',status:'reported',quote:'palpitations'}],report:{revision:3,labels:['MI','STTC','CD']}}},h);
 assert.match(html,/You explicitly denied/);assert.match(html,/You described/);assert.match(html,/v3/);
 assert.match(html,/&lt;no chest pain>/);assert.ok(!html.includes('safe'));assert.ok(!html.includes('Normal category'));
 assert.equal(patientContextCard({},h),'');
});
test('report conflict uses actual snapshot and never silently invents findings',()=>{
 const html=patientContextCard({patientContext:{report:{revision:1,labels:['NORM']},reportClaim:{conflict:true}}},h);
 assert.match(html,/differs from this published version/);assert.match(html,/Normal category/);
 assert.ok(!html.includes('Conduction-related finding'));
});
test('Agent followup prepares editable input, never submits or fills a factual answer',()=>{
 const html=patientFollowUp({followUpQuestion:'<when?>'},h);
 assert.match(html,/ONE KEY DETAIL/);assert.match(html,/&lt;when\?>/);assert.match(html,/data-patient-prompt/);
 assert.ok(!html.includes('<when?>'));assert.ok(!html.includes('type="submit"'));
 assert.equal(patientFollowUp({},h),'');
 for(const key of ['You explicitly denied','Your description of the report differs from this published version. The explanation uses the findings above.','ONE KEY DETAIL TO CLARIFY','Add my answer'])assert.ok(zhCompanion[key]);
});
