import test from 'node:test';
import assert from 'node:assert/strict';
import {reportBasisKey,reportIsCurrent,canPublishReport,patientReportEditor,reportApproval,publishedChangeSummary,expertValidationSummary} from '../src/patient_report_view.ts';
const h={t:(s:string)=>s,esc:(s:any)=>String(s??'').replaceAll('<','&lt;')};
const setup=()=>{
  const s={ctx:{contextId:'ctx'},labels:['CD'],featureNames:['qrs'],revisionItemId:'i1',policyRoundId:null,analysisRoundId:null,
    patientReportId:'g1',patientReportBasis:'',patientReportLanguage:'en',note:'A sufficiently long report',reportInstructions:'',reportApproved:false,busy:'',sourceChanged:false};
  s.patientReportBasis=reportBasisKey(s);return s;
};
test('generation and human approval are separate; no approval means no publish',()=>{
  const s=setup();assert.ok(reportIsCurrent(s));assert.equal(canPublishReport(s),false);
  s.reportApproved=true;assert.ok(canPublishReport(s));s.busy='generating';assert.equal(canPublishReport(s),false);
});
test('changed evidence, labels, context and linkage invalidate publication',()=>{
  for(const change of [(s:any)=>s.labels=['STTC'],(s:any)=>s.featureNames=[],(s:any)=>s.ctx.contextId='new',
    (s:any)=>s.revisionItemId='new',(s:any)=>s.sourceChanged=true]){
    const s=setup();s.reportApproved=true;change(s);assert.equal(reportIsCurrent(s),false);assert.equal(canPublishReport(s),false);
  }
});
test('unsubmitted rewrite request cannot be published as if applied',()=>{
  const s=setup();s.reportApproved=true;s.reportInstructions='Simpler';assert.equal(canPublishReport(s),false);
  assert.match(reportApproval(s,h),/id="report-approved"[^>]*disabled/);
});
test('empty editor tells expert to review rather than write from scratch',()=>{
  const s=setup();s.patientReportId='';s.note='';
  const html=patientReportEditor(s,h);
  assert.ok(html.includes('You review. The system writes.')&&html.includes('Generate patient report'));
  assert.ok(!html.includes('id="review-note"')&&html.includes('id="report-instructions"'));
});
test('generated and legacy reports are attributed honestly and content escaped',()=>{
  const s=setup();s.note='<script>bad</script>';
  let html=patientReportEditor(s,h);assert.ok(!html.includes('<script>')&&html.includes('Edit report text directly'));
  s.patientReportId='';html=patientReportEditor(s,h);assert.ok(html.includes('Existing report retained'));
});
test('patient sees concise published change, not expert opinion or cohort diagnostics',()=>{
  const html=publishedChangeSummary({focus:{before:['NORM','CD'],after:['CD']},opinion:'private expert request',evaluation:{holdout:'metrics'}},h);
  assert.ok(html.includes('NORM + CD → CD'));
  assert.ok(!html.includes('metrics')&&!html.includes('private expert'));
  assert.equal(publishedChangeSummary(undefined,h),'');
});
test('expert report audit presents tuning-only metrics with their scope',()=>{
  const html=expertValidationSummary({evaluation:{subsets:{tuning:{fixed:2,broken:0},holdout:{fixed:1,broken:2}}}},h);
  assert.ok(html.includes('Tuning set')&&html.includes('Now agree +2')&&html.includes('weak labels'));
  assert.ok(!html.includes('Holdout set')&&!html.includes('No longer agree −2'));
  assert.ok(html.includes('not independent generalization validation'));
});
