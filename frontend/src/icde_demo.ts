import './icde_demo.css';
import './demo_viewport.css';
import './revision_workspace.css';
import {revisionWorkspace} from './revision_workspace';
import {bindThresholdLab,boundsOf,measurementScale,provenanceChain} from './review_lab';
import {reviewGuide} from './review_guide';
import {rev,resetRevision,loadRevision,submitRevision,decideRevision,revisionHtml,revisionFlag,adoptedRevision,feedbackImpactHtml} from './revision_panel';
import './review_lab.css';
import './feedback_workspace.css';
import './patient_report.css';
import {loadStory,selectStoryCase,storyRefinement} from './revision_story.ts';
import {reportBasisKey,reportIsCurrent,canPublishReport,patientReportEditor,reportApproval,publishedChangeSummary,expertValidationSummary} from './patient_report_view.ts';
import {fetchJson,postJson} from './api';
import {featureNames as names,labelNames,metricSpecs,escapeHtml as esc,formatMeasurement as rawValue,statusLabel as rawStatusLabel,criterionText,previewCounts,defaultCohort,focusLead,validReview} from './demo_view';
import {getLanguage,setLanguage,t,languageButtons} from './demo_i18n';
import {ReportViewState} from './report_view_state';
import {FeedbackViewState} from './feedback_view_state.ts';
import {newJourney,syncJourney,journeyKey,patientCompanion,addQuestion,questionPacket,PatientViewState} from './patient_companion.ts';
import type {PatientMode} from './patient_companion.ts';
import './patient_companion.css';
import {newTaskView,syncTaskView,activeTask,workKey,expertTaskQueue,hasTaskDraft} from './patient_tasks.ts';
import './patient_tasks.css';
import {mountPositiveDemo} from './positive_demo.ts';

type Obj=Record<string,any>;
type Role='expert'|'patient';
type Section='collaboration'|'investigation'|'evidence'|'cohort'|'review';
const app=document.querySelector<HTMLElement>('#demo')!;
const reportViewState=new ReportViewState();
const feedbackViewState=new FeedbackViewState();
const patientViewState=new PatientViewState();
const params=new URLSearchParams(location.search);
const state={
  role:(params.get('role')==='patient'?'patient':'expert') as Role,section:'collaboration' as Section,
  cases:[] as Obj[],ctx:null as Obj|null,evidence:null as Obj|null,selectedFeature:'',
  lead:'II',seconds:10,start:0,allLeads:false,busy:'',error:'',message:'',filter:'',caseFilter:'all',
  cohort:[] as number[],metric:'Q wave count',op:'>=',threshold:1,preview:null as Obj|null,previewStale:false,
  labels:[] as string[],note:'',featureNames:[] as string[],reviewDirty:false,reviewBaseRevision:0,
  messages:[] as Obj[],question:'',feedback:'',patientFeature:'',showFeedback:false,sourceChanged:false,
  journey:newJourney(),patientFeedbackKey:'',
  tasksUI:newTaskView(),expertTasks:{revision:0,items:[]} as Obj,
  collaboration:{revision:0,rounds:[]} as Obj,expertQuestion:'',expertAction:'auto',expertFocus:'',analysisRoundId:null as string|null,
  collaborationLoaded:false,suggestionFeatures:[] as Obj[],
  policyDraft:null as Obj|null,policyDirty:false,policyRoundId:null as string|null,
  revisionItemId:null as string|null,
  patientReportId:null as string|null,patientReportBasis:'',patientReportLanguage:'',reportInstructions:'',reportApproved:false,
};
const base=()=>`/api/demo/ptbxl/cases/${state.ctx!.sample.ecgId}`;
const activeFeature=()=>state.evidence?.result.features.find((f:Obj)=>f.name===state.selectedFeature)||state.evidence?.result.features[0];
const status=(key:string)=>`<span class="status ${esc(key)}">${esc(statusLabel(key))}</span>`;
const disabled=()=>state.busy?'disabled':'';
const labelChips=(labels:string[],tone='')=>labels?.length?labels.map(l=>`<span class="label-chip ${tone}">${esc(l)}</span>`).join(''):`<span class="muted">${t("No class")}</span>`;
const date=(v:string)=>new Date(v).toLocaleString(getLanguage()==='zh'?'zh-CN':'en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const pretty=(f:string)=>t(names[f]||f.replaceAll('_',' '));
const value=(f:Parameters<typeof rawValue>[0])=>t(rawValue(f));
const statusLabel=(s:string)=>t(rawStatusLabel(s));

function render(){
  patientViewState.capture(app);
  if(state.ctx){syncJourney(state);syncTaskView(state);}
  reportViewState.capture(app);
  feedbackViewState.capture(app);
  document.documentElement.lang=getLanguage()==='zh'?'zh-CN':'en';
  document.title=getLanguage()==='zh'?'RecursiveECG · 交互演示':'RecursiveECG · Interactive Demo';
  const c=state.ctx,r=c?.publishedReport,patient=state.role==='patient';
  app.innerHTML=`<div class="app-shell ${patient?'patient-mode':''}">
    <header class="app-header"><a class="brand" href="/demo"><span class="brand-mark">R</span><span>RecursiveECG<small>${t("INTERACTIVE RESEARCH DEMO")}</small></span></a>
      <nav class="role-nav" aria-label="${t("Interaction role")}"><button data-role="expert" aria-pressed="${!patient}">${t("Clinical Expert")}</button><button data-role="patient" aria-pressed="${patient}">${t("Patient")}</button></nav>
      <div class="header-end"><span class="demo-badge">${t("Public data · Demo only")}</span>${languageButtons()}<a href="/" class="workspace-link">${t("Agent workspace")} ↗</a></div>
    </header>
    <div class="shell-body ${patient?'patient-shell':''}">${patient?'':caseSidebar()}
    <main class="workspace">
      <div class="workspace-heading"><div><span class="eyebrow">${patient?t("PATIENT EXPERIENCE"):t("EXPERT COLLABORATION")}</span><h1>${patient?t("Understand your report"):t("A second look. Together.")}</h1><p>${patient?t("An explanation connected to the same published report."):t("Challenge a finding. Inspect the checks. Decide what to keep.")}</p></div>
        ${c?`<div class="record-heading">${patient?`<label for="patient-case">${t("Demo record")}</label><select id="patient-case" ${disabled()}>${state.cases.map(s=>`<option value="${s.ecgId}" ${s.ecgId===c.sample.ecgId?'selected':''}>ECG ${s.ecgId}</option>`).join('')}</select>`:`<span class="record-label">PTB-XL</span><strong>ECG ${c.sample.ecgId}</strong>`}<details class="provenance"><summary>${t("Source & version")}</summary><dl><dt>${t("Recorded run")}</dt><dd>${esc(c.iteration)}</dd><dt>${t("Evidence tool")}</dt><dd>${esc(c.toolVersion)}</dd><dt>${t("Report")}</dt><dd>${r?t("Published v")+r.revision:t("Not published")}</dd><dt>${t("Context")}</dt><dd>${esc(c.contextId)}</dd></dl></details></div>`:''}
      </div>
      ${state.error?`<div class="notice error" role="alert">${esc(t(state.error))} ${c?`<button id="reload-case" class="text-button">${t("Refresh this record")}</button>`:''}</div>`:''}
      ${state.message?`<div class="notice success" role="status">${esc(t(state.message))}<button id="dismiss-message" aria-label="${t("Dismiss notification")}">×</button></div>`:''}
      ${c?patient?`<div class="workspace-panel patient-panel">${patientPage()}</div>`:expertPage():`<section class="surface loading"><span class="spinner"></span><h2>${state.error?t("Records unavailable"):t("Loading recorded ECGs")}</h2><p>${t("Retrieving the signal, model output and saved review.")}</p>${state.error?`<button id="retry-cases" class="primary">${t("Try again")}</button>`:''}</section>`}
      ${patient?'':`<footer class="workspace-footer"><span>${t("Public ECG dataset. Demonstration reviews do not establish a clinical diagnosis.")}</span><span>${t('Original run retained for comparison.')}</span></footer>`}
    </main></div>${state.busy?`<div class="busy-toast" role="status"><span class="spinner"></span>${esc(t(state.busy))}</div>`:''}
  </div>`;
  reportViewState.restore(app,state.ctx?.contextId||'');
  feedbackViewState.restore(app);
  patientViewState.restore(app,state.ctx?journeyKey(state.ctx):'');
  bind();
}
// Guide targets are real controls on the collaboration tab; the guide only moves focus, never changes data.
const guideSelectors:Record<string,string>={'expert-question':'#expert-question','expert-question-form':'#expert-question-form button','threshold-lab':'[data-threshold-lab]','revision-actions':'.revision-actions button'};
function focusGuideTarget(target:string){
  if(state.section!=='investigation'){state.section='investigation';render();}
  const el=app.querySelector<HTMLElement>(guideSelectors[target]??'');
  if(!el){state.message=target==='threshold-lab'?'Run the replay first. The threshold lab appears after a validation.':'This step is not available yet.';render();return;}
  el.scrollIntoView({block:'center',behavior:'smooth'});
  el.focus({preventScroll:true});
}
function caseSidebar(){
  const featured=[26,3919,62];
  return `<aside class="case-sidebar"><div class="rail-title"><span class="eyebrow">${t("CASE LIBRARY")}</span><span>${state.cases.length}</span></div><label class="sr-only" for="case-search">${t("Find ECG ID")}</label><input id="case-search" type="search" placeholder="${t("Find ECG ID…")}" value="${esc(state.filter)}"/>
    <div class="case-filters" role="group" aria-label="${t("Case filter")}"><button data-filter="all" aria-pressed="${state.caseFilter==='all'}">${t("All records")}</button><button data-filter="disagreement" aria-pressed="${state.caseFilter==='disagreement'}">${t("Disagreement")}</button></div>
    <div class="case-list">${[...state.cases].sort((a,b)=>(featured.includes(a.ecgId)?featured.indexOf(a.ecgId):-1)<0?featured.includes(b.ecgId)?1:0:featured.includes(b.ecgId)?featured.indexOf(a.ecgId)-featured.indexOf(b.ecgId):-1).map(c=>`<button class="case-choice ${state.ctx?.sample.ecgId===c.ecgId?'active':''}" data-case="${c.ecgId}" data-exact="${c.exact}" ${caseVisible(c)?'':'hidden'} ${disabled()} aria-pressed="${state.ctx?.sample.ecgId===c.ecgId}"><span class="case-line"><strong>ECG ${c.ecgId}</strong><span class="case-dot ${c.exact?'':'disagreement'}"></span></span>${revBadge(c.ecgId)}<span class="case-class">${esc(c.predicted.join(' + ')||t("No class"))}</span><small>${c.ecgId===26?t("Explore multiple findings"):c.ecgId===3919?t("Inspect a disagreement"):c.ecgId===62?t("Explore report dialogue"):c.exact?t("Reference agreement"):t("Prediction disagreement")}</small></button>`).join('')}</div>
    <div class="rail-foot"><span class="case-dot disagreement"></span> ${t("Dataset / model disagreement")}<p>${t("These labels are separate from expert review.")}</p></div></aside>`;
}
function caseVisible(c:Obj){return String(c.ecgId).includes(state.filter)&&(state.caseFilter!=='disagreement'||!c.exact);}
function expertPage(){
  const c=state.ctx!,r=c.publishedReport;
  const inbox=c.feedback.length+(c.patientTasks?.items||[]).filter((i:Obj)=>i.status==='submitted'||i.status==='in_review').length;
  return `<div class="case-context"><div><span>${t("Dataset labels")}</span><div>${labelChips(c.sample.truth)}</div></div><span class="context-divider">${c.sample.exact?'=':'≠'}</span><div><span>${t("Model output")}</span><div>${labelChips(c.sample.predicted)}</div></div><div class="context-assessment"><span>${c.sample.exact?t("Reference agreement"):t("Prediction disagreement")}</span><small>${c.sample.exact?t("Agreement is not clinical verification."):t("Inspect evidence; do not infer a diagnosis from this difference.")}</small></div><div class="context-report"><span>${r?t("Published report v")+r.revision:t("Not yet published")}</span><small>${state.reviewDirty?t("Unsaved review changes"):c.review?.status==='draft'?t("Draft v")+c.review.revision+t(" saved"):t("Expert review is a separate record")}</small></div></div>
    ${adoptedRevision()?.result?.focus?`<div class="feedback-active micro">${t('Updated demo assessment')}: ${labelChips(adoptedRevision()!.result.focus.after,'published')} · ${t('Confirmed expert feedback; original run retained for comparison.')}</div>`:''}
    ${state.section==='investigation'?`<details class="investigation-guide"><summary>${t('Evidence investigation guide')}</summary>${reviewGuide({...c,collaboration:state.collaboration},{t,esc})}</details>`:''}<nav class="work-tabs" aria-label="${t("Expert workspace section")}">${([['collaboration','01',t('Expert feedback')],['evidence','02',t("Evidence")],['investigation','03',t('Evidence investigation')],['cohort','04',t("Criterion preview")],['review','05',t("Report & feedback")]] as const).map(([key,n,label])=>`<button data-section="${key}" aria-pressed="${state.section===key}"><span>${n}</span>${label}${key==='review'&&inbox?`<b>${inbox}</b>`:''}</button>`).join('')}<span class="tab-hint">${t("Your judgment stays in control")}</span></nav>
    <div class="workspace-panel panel-${state.section}">${state.section==='collaboration'?collaborationWorkspace():state.section==='investigation'?revisionWorkspace(state,{t,esc,pretty,value,status,disabled}):state.section==='evidence'?evidenceWorkspace():state.section==='cohort'?cohortWorkspace():reviewWorkspace()}</div>`;
}

function collaborationWorkspace(){return revisionHtml(Boolean(state.busy),{t,esc},state.ctx||undefined);}
const revBadge=(id:number)=>{const f=revisionFlag(id);return f?`<span class="rv-flip-badge ${f}" title="${esc(t(f==='fixed'?'Now agrees with the dataset label':'No longer agrees with the dataset label'))}">${t('Judgment revised')}</span>`:'';};
async function submitOpinion(){
  if(rev.draft.trim().length<3){state.error='Write your opinion first.';render();return;}
  await task('The agent is proposing and testing a criterion with the model. This takes up to a minute.',async()=>{
    await submitRevision(base(),state.ctx!.contextId);
    state.message='Revision tested. Inspect the current case and tuning results before deciding.';
  });
}
async function decideOpinion(itemId:string,decision:'adopted'|'rejected'){
  await task('Saving your decision…',async()=>{
    await decideRevision(base(),state.ctx!.contextId,itemId,decision);
    state.message=decision==='adopted'?'Recorded as this case’s candidate judgment. Nothing was published.':'Rejected. Nothing was changed.';
  });
}

async function revisionToDraft(itemId:string){
  if(state.busy)return;
  const item=rev.items.find(i=>i.id===itemId);
  if(!item||item.decision!=='adopted'||!item.result.focus)return;
  if(item.baseReportRevision!==state.ctx!.revision){state.error='The report changed since this feedback. Re-analyze before linking it.';render();return;}
  if(state.reviewDirty&&!window.confirm(t('Replace the unsaved note and attachments with this suggestion? Your saved reports will not change.')))return;
  const r=item.result;
  state.labels=[...r.focus.after]; // Explicit "Use this result" action, never implicit on model response.
  state.note='';state.patientReportId=null;state.patientReportBasis='';state.reportApproved=false;state.reportInstructions='';
  const cols=r.candidate?.conditions?.filter((x:Obj)=>x.source==='feature').map((x:Obj)=>x.name)||[];
  state.featureNames=(state.evidence?.result.features||[]).filter((f:Obj)=>cols.some((n:string)=>n===f.name||n.startsWith(f.name+'.'))).map((f:Obj)=>f.name);
  state.revisionItemId=item.id;state.analysisRoundId=null;state.policyRoundId=null;state.reviewDirty=true;state.section='review';render();
  await generateReport();
}

function signalPlot(lead:Obj,overview=false){
  const w=state.ctx!.waveform,max=Math.max(2,Math.ceil(Math.max(...w.leads.flatMap((l:Obj)=>l.values.map((v:number)=>Math.abs(v))))));
  const duration=overview?w.durationSeconds:Math.min(state.seconds,w.durationSeconds),start=overview?0:Math.min(state.start,w.durationSeconds-duration);
  const values=lead.values.slice(Math.floor(start*w.sampleRate),Math.min(lead.values.length,Math.ceil((start+duration)*w.sampleRate)+1));
  const width=1000,height=overview?100:210,pad=overview?10:20;
  const d=values.map((v:number,i:number)=>`${i?'L':'M'}${(pad+i/Math.max(1,values.length-1)*(width-2*pad)).toFixed(2)},${(height/2-v/max*(height*.42)).toFixed(2)}`).join(' ');
  const gridId=`grid-${lead.name}-${overview?'all':'single'}`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded lead ${esc(lead.name)}, ${start.toFixed(1)} to ${(start+duration).toFixed(1)} seconds, plus or minus ${max} mV"><defs><pattern id="${gridId}" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#eadbd9" stroke-width=".6"/></pattern></defs><rect width="1000" height="${height}" fill="url(#${gridId})"/><path d="${d}" fill="none" stroke="#22474b" stroke-width="${overview?1.4:1.8}" vector-effect="non-scaling-stroke"/></svg>`;
}
function waveform(){
  const w=state.ctx!.waveform,lead=w.leads.find((l:Obj)=>l.name===state.lead)||w.leads[0],max=Math.max(2,Math.ceil(Math.max(...w.leads.flatMap((l:Obj)=>l.values.map((v:number)=>Math.abs(v))))));
  const start=Math.min(state.start,Math.max(0,w.durationSeconds-state.seconds)),end=Math.min(w.durationSeconds,start+state.seconds);
  return `<section class="surface waveform-surface"><div class="panel-heading"><div><span class="eyebrow">${t("RECORDED SIGNAL")}</span><h2>${t("ECG waveform")} <span>${w.durationSeconds}s · ${w.sampleRate} Hz</span></h2></div><button class="quiet-button" id="toggle-leads" aria-pressed="${state.allLeads}">${state.allLeads?t("Single lead"):t("12-lead overview")}</button></div>
    ${state.allLeads?`<div class="all-leads">${w.leads.map((l:Obj)=>`<button class="mini-lead" data-lead="${esc(l.name)}"><span>${esc(l.name)}</span>${signalPlot(l,true)}</button>`).join('')}</div>`:`<div class="lead-selector" aria-label="${t("Focus lead")}">${w.leads.map((l:Obj)=>`<button data-lead="${esc(l.name)}" aria-pressed="${lead.name===l.name}">${esc(l.name)}</button>`).join('')}</div><div class="signal-paper"><span class="signal-lead">${esc(lead.name)}</span>${signalPlot(lead)}<div class="time-axis">${Array.from({length:6},(_,i)=>`<span>${Number((start+(end-start)*i/5).toFixed(1))}s</span>`).join('')}</div></div><div class="signal-controls"><span>${t("View window")}</span><div>${[10,4,2].map(n=>`<button data-window="${n}" aria-pressed="${state.seconds===n}">${n}s</button>`).join('')}</div>${state.seconds<w.durationSeconds?`<label for="signal-start">${t("Start")}</label><input id="signal-start" aria-label="${t("Signal window start")}" type="range" min="0" max="${Math.max(0,w.durationSeconds-state.seconds)}" step=".1" value="${start}"/><output>${start.toFixed(1)}s</output>`:''}<span class="amplitude">±${max} mV</span></div>`}
    <p class="micro">${t("View controls only. Evidence measurements use the complete record; this is not a selected-segment measurement.")}</p></section>`;
}
function evidenceWorkspace(){
  const e=state.evidence;
  return `<div class="evidence-layout"><div class="signal-column">${waveform()}${measurementScale(activeFeature(),state.policyDraft,{t,esc,pretty,value})}<section class="surface measurements-surface"><div class="panel-heading"><div><span class="eyebrow">${t("EXECUTABLE EVIDENCE")}</span><h2>${e?t("Measured on this record"):t("Inspect the evidence behind a finding")}</h2></div><button id="run-evidence" class="primary" ${disabled()}>${e?t("Run again"):t("Run evidence check")} <span>↗</span></button></div>
      ${e?`<div class="execution-receipt"><span class="receipt-dot"></span>${e.cached?t("Cached result retrieved"):t("Tool executed")}<span>${e.elapsedMs} ms</span><span>${e.result.features.length}${t(" measurements")}</span></div><div class="measurement-grid">${e.result.features.map((f:Obj)=>`<button class="measurement ${f.name===activeFeature()?.name?'selected':''}" data-feature="${esc(f.name)}" aria-pressed="${f.name===activeFeature()?.name}"><span>${esc(pretty(f.name))}</span><strong>${esc(value(f))}</strong><small><span class="metric-dot ${esc(f.judgment.status)}"></span>${esc(statusLabel(f.judgment.status))}${state.featureNames.includes(f.name)?t(" · Attached"):''}</small></button>`).join('')}</div><details class="quality-details"><summary>${t("Measurement quality & limitations")}</summary><p>${e.result.quality.beats_detected}${t(" detected beats · ")}${e.result.quality.leads_with_qrs_bounds}${t(" leads measured")}</p>${[...e.result.warnings.map((w:Obj)=>w.message),...e.result.adapterNotes].map(t=>`<p>${esc(t)}</p>`).join('')}</details>`:`<div class="evidence-prompt"><span class="step-marker">01</span><div><h3>${t("A result you can check, not just read.")}</h3><p>${t("Run the existing reference feature tool. Select a measurement to inspect its rule and source.")}</p></div></div><div class="evidence-route"><span>${t("Recorded signal")}</span><b>→</b><span>${t("Measurement")}</span><b>→</b><span>${t("Reference")}</span></div>`}
    </section></div><aside class="surface evidence-inspector">${evidenceInspector()}</aside></div><div class="evidence-tray"><div><strong>${state.featureNames.length}${t(" measurements attached")}</strong><span>${t("to your review draft")}</span></div><button data-section="cohort" class="quiet-button">${t("Preview a condition")} →</button><button data-section="review" class="primary">${t("Compose report")} →</button></div>`;
}
function evidenceInspector(){
  const f=activeFeature();
  if(!f)return `<span class="eyebrow">${t("EVIDENCE INSPECTOR")}</span><h2>${t("Follow a finding to its source")}</h2><div class="inspector-placeholder">${[['01',t("Measurement"),t("A value from the recorded ECG")],['02',t("Reference rule"),t("The condition used to assess it")],['03',t("Source excerpt"),t("The original supporting text")]].map(([n,t,d])=>`<div><span>${n}</span><section><h3>${t}</h3><p>${d}</p></section></div>`).join('')}</div><p class="micro">${t("The evidence tool supports review. Its measurements do not explain the classifier’s internal decision.")}</p>`;
  const target=focusLead(f,state.ctx!.waveform.leads.map((l:Obj)=>l.name));
  return `<div class="inspector-top"><span class="eyebrow">${t("EVIDENCE INSPECTOR")}</span><span class="inspect-tag">${t("SELECTED")}</span></div><h2>${esc(pretty(f.name))}</h2>
    <section class="evidence-stage"><span class="stage-index">01</span><div><h3>${t("Measurement")}</h3><div class="measurement-value">${esc(value(f))}</div>${status(f.judgment.status)}<p class="micro">${f.name==='qrs_duration_ms'?t("Tool-reported aggregate across measured leads."):t("Assessment of this measurement under the tool’s reference rule.")}</p>${target?`<button id="focus-measured-lead" class="text-button">${t("View lead ")}${esc(target)}${t(" in waveform")} ↗</button><p class="micro">${t("Lead focus only; no beat boundaries are provided by this result.")}</p>`:''}<details><summary>${t("Measurement details")}</summary><pre>${esc(JSON.stringify(f.value,null,2))}</pre></details></div></section>
    <section class="evidence-stage"><span class="stage-index">02</span><div><h3>${t("Reference rule")}</h3><p class="rule-text">${esc(f.judgment.rule)}</p></div></section>
    <section class="evidence-stage source-stage"><span class="stage-index">03</span><div><h3>${t("Source excerpt")}</h3><span class="micro">${t("Original reference text")}</span>${f.evidence.map((e:Obj)=>`<blockquote><p>${esc(e.quote)}</p><cite>${esc(e.section|| (e.page?t("Page ")+e.page:t("Reference excerpt")))}</cite><a href="/api/references/preview?path=${encodeURIComponent(e.referencePath)}${e.page?'#page='+encodeURIComponent(e.page):''}" target="_blank" rel="noopener">${t("Open source document")} ↗</a></blockquote>`).join('')}</div></section>
    <button class="quiet-button" data-challenge-feature="${esc(f.name)}">${t("Question this evidence")} ↗</button><label class="attach-control"><input type="checkbox" data-attach="${esc(f.name)}" ${state.featureNames.includes(f.name)?'checked':''}/>${t("Include this evidence in the review")}</label>`;
}
function cohortWorkspace(){
  const spec=metricSpecs[state.metric],p=state.preview,counts=p?previewCounts(p.rows):null;
  return `<section class="surface cohort-workspace"><div class="panel-heading"><div><span class="eyebrow">${t("BOUNDED CRITERION PREVIEW")}</span><h2>${t("One condition. Compare its impact across cases.")}</h2><p class="muted">${t("Choose a measurement and records. Only review flags are previewed.")}</p></div><span class="immutable-badge">${t("Model predictions unchanged")}</span></div>
    <form id="criterion-form"><div class="condition-builder"><label>${t("Measurement")}<select id="criterion-metric">${Object.entries(metricSpecs).map(([k,v])=>`<option value="${k}" ${state.metric===k?'selected':''}>${esc(t(v.name))}</option>`).join('')}</select></label><label>${t("Condition")}<select id="criterion-op">${['>=','>','<=','<'].map(op=>`<option value="${esc(op)}" ${state.op===op?'selected':''}>${esc(op.replace('>=','≥').replace('<=','≤'))}</option>`).join('')}</select></label><label>${t("Threshold")}<div class="unit-input"><input id="criterion-threshold" type="number" step="any" min="0" max="10000" required value="${state.threshold}"/><span>${t(spec.unit)}</span></div></label><div class="condition-action"><span>${t("Action")}</span><strong>${t("Needs review")}</strong></div><button class="primary" ${disabled()}>${t("Preview impact")} →</button></div><p class="micro">${t("Supported measurements: QRS duration, PR interval and Q-wave count. This is a bounded rule, not unrestricted clinical language.")}</p></form>
    <div class="cohort-select"><div><h3>${t("Records to compare")} <span>${state.cohort.length} / 8</span></h3><p class="micro">${t("The selection stays fixed while you compare thresholds.")}</p></div><div class="cohort-chips">${state.cohort.map(id=>`<button data-remove-cohort="${id}" aria-label="${t("Remove ECG ")}${id}${t(" from preview")}">ECG ${id}<span>×</span></button>`).join('')}<label class="sr-only" for="cohort-add">${t("Add record to preview")}</label><select id="cohort-add" ${state.cohort.length>=8?'disabled':''}><option value="">${t("+ Add record")}</option>${state.cases.filter(c=>!state.cohort.includes(c.ecgId)).map(c=>`<option value="${c.ecgId}">ECG ${c.ecgId}</option>`).join('')}</select></div></div>
    ${p?`${state.previewStale?`<div class="notice warning">${t("Inputs changed. The results below belong to the previous preview. Run Preview impact to update them.")}</div>`:''}<div class="preview-summary"><div><span>${t("PREVIEW RESULT")}</span><h3>${esc(p.criterion.text)}</h3></div><div><strong>${counts!.flagged}</strong><span>${t("flagged")}</span></div><div><strong>${counts!.clear}</strong><span>${t("not flagged")}</span></div><div><strong>${counts!.unknown}</strong><span>${t("not assessable")}</span></div></div><div class="table-scroll"><table><thead><tr><th>${t("Record")}</th><th>${t("Measured value")}</th><th>${t("Reference assessment")}</th><th>${t("Preview outcome")}</th><th></th></tr></thead><tbody>${p.rows.map((r:Obj)=>`<tr class="${r.matched===true?'flagged':''}"><td><b>ECG ${r.ecgId}</b></td><td>${r.value==null?t("Not measurable"):esc(r.value+' '+p.criterion.unit)}</td><td>${status(r.originalStatus)}</td><td><span class="preview-outcome ${r.matched===true?'flag':r.matched==null?'unknown':''}">${r.matched===true?t("Needs review"):r.matched===false?t("No new flag"):t("Cannot determine")}</span></td><td><button data-inspect-case="${r.ecgId}" class="text-button" ${disabled()}>${t("Inspect")} →</button></td></tr>`).join('')}</tbody></table></div><div class="preview-foot"><p>${counts!.flagged===0?t("No selected record met this condition. This is a valid preview result."):t("A review flag is an invitation to inspect, not a diagnosis.")}</p><span>${p.rows.length}${t(" selected records · Preview only · Not applied")}</span></div>`:`<div class="preview-empty"><span class="step-marker">02</span><h3>${t("See which records meet your condition")}</h3><p>${t("Matched, unmatched and unavailable measurements remain separate.")}</p><span class="micro">${t("Example: Q wave count ≥ 1 across the selected public records.")}</span></div>`}
  </section>`;
}
function selectedDraftFeatures(){const available=[...state.suggestionFeatures,...(state.evidence?.result.features||[]),...(state.ctx?.review?.features||[])];return state.featureNames.map(n=>available.find((f:Obj)=>f.name===n)).filter(Boolean);}
function reviewWorkspace(){
  const c=state.ctx!,r=c.publishedReport,features=selectedDraftFeatures();
  const item=rev.items.find(i=>i.id===state.revisionItemId);
  return `<div class="review-layout patient-report-workspace" data-report-view="${esc(c.contextId)}"><section class="surface review-editor system-report-editor"><div class="report-scroll"><div class="panel-heading"><div><span class="eyebrow">${t('SYSTEM REPORT · EXPERT REVIEW')}</span><h2>${t('The system writes. You review.')}</h2></div><span class="draft-indicator">${state.reviewDirty?t("Unsaved changes"):c.review?.status==='draft'?t("Draft saved"):t("Review draft")}</span></div>
    ${patientReportEditor(state,{t,esc})}
    <details class="report-basis" ${state.labels.length?'':'open'}><summary>${t('Assessment and evidence used for generation')} · ${state.labels.join(' + ')||t('Choose labels')}</summary><fieldset><legend>${t("Demo review labels")} <span>${t("Choose explicitly; model labels are not copied into a new review.")}</span></legend><div class="review-labels">${Object.keys(labelNames).map(l=>`<label><input type="checkbox" name="review-label" value="${l}" ${state.labels.includes(l)?'checked':''}/> ${l}</label>`).join('')}</div></fieldset>
    <div class="attached-evidence"><h3>${t("Attached evidence")} <span>${features.length}</span></h3>${features.length?features.map((f:Obj)=>`<div><span>${esc(pretty(f.name))}</span><strong>${esc(value(f))}</strong><button data-detach="${esc(f.name)}" type="button" aria-label="${t("Remove ")}${esc(pretty(f.name))}${t(" from draft")}">×</button></div>`).join(''):`<p class="muted">${t("No measurements attached yet. Select evidence in the inspector.")}</p>`}<button type="button" data-section="evidence" class="text-button">${t("Choose supporting evidence")} →</button></div></details>
    <button id="report-to-feedback" class="text-button" ${disabled()}>${t('Send this report back for assessment review')} →</button></div>
    <footer class="report-approval-bar">${reportApproval(state,{t,esc})}</footer></section>
    <aside class="review-side">${item?`<details class="report-audit"><summary>${t('Expert-only adjustment and validation record')}</summary>${feedbackImpactHtml({...item.result,opinion:item.opinion},{t,esc},!state.reviewDirty)}${expertValidationSummary(item.result,{t,esc})}</details>`:''}${reportPolicy(state.policyRoundId?state.collaboration.rounds.find((x:Obj)=>x.id===state.policyRoundId)?.policy:null)}<section class="surface publication-panel"><span class="eyebrow">${t("PATIENT HANDOFF")}</span><h2>${r?t("Published report v")+r.revision:t('System report awaiting publication')}</h2>${r?`<div class="published-labels">${labelChips(r.labels,'published')}</div><p class="published-note">${esc(r.note)}</p><div class="publication-receipt"><span>${r.features.length}${t(" measurements attached")}</span><span>${esc(date(r.updatedAt))}</span></div><button data-role="patient" class="primary">${t("Open patient report")} →</button>`:`<div class="handoff-items"><p><b>${t('System-generated explanation')}</b>${t('Findings, meaning and limitations in patient-friendly language')}</p><p><b>${t('Expert approval')}</b>${t('Review the content rather than write it from scratch')}</p></div><p class="micro">${t("No report is visible to the patient until it is published.")}</p>`}</section>
    <section class="surface feedback-panel">${expertTaskQueue(state,{t,esc,pretty,date})}<details><summary>${t('Legacy clarification requests')} · ${c.feedback.length}</summary>${c.feedback.length?c.feedback.map((f:Obj)=>`<article class="feedback-item"><span>${t("Report v")}${f.reportRevision}${t(" · Awaiting clarification")}</span><p>${esc(f.text)}</p><small>${esc(date(f.createdAt))}</small></article>`).join(''):`<p class="muted">${t("Requests linked to this report will appear here.")}</p>`}<p class="micro">${t("Use tracked review tasks to request a response linked to your question.")}</p></details></section></aside></div>`;
}
function reportPolicy(p:Obj|null|undefined){return p?`<div class="report-policy"><b>${t("Adopted review overlay")} · v${p.version}</b><p>${esc(pretty(p.candidate.feature))} · ${p.candidate.lower==null?'':(p.candidate.lowerInclusive?'≥ ' :'> ')+p.candidate.lower} ${p.candidate.upper==null?'':(p.candidate.upperInclusive?'≤ ':'< ')+p.candidate.upper} ${p.candidate.feature.includes('count')?t('leads'):'ms'}</p><p>${p.expertEdited?t('Bounds edited by the expert. Source support has not been re-verified.'):''}</p><p>${t('Original proposal rationale')}: ${esc(p.candidate.rationale)}</p><p>${t('This record')}: ${t(p.caseResult?.matched===true?'Needs review':p.caseResult?.matched===false?'No additional flag for this record':'Not assessable')}</p><p>${t("An expert adopted a tested review condition. It adds review flags, not a new diagnosis.")}</p><small>${t("Validation receipt")}: ${esc(p.validationId)} · ${t("Model predictions unchanged")}</small></div>`:'';}
function patientPage(){
  const c=state.ctx!,r=c.publishedReport;
  if(!r)return `<section class="surface patient-pending"><span class="eyebrow">${t("REVIEW PENDING")}</span><h2>${t("This record has no published demo report.")}</h2><p>${t('The system report becomes available after an expert reviews and explicitly publishes it.')}</p><button data-role="expert" class="primary">${t("Open expert workspace")} →</button><button data-case="62" class="quiet-button" ${disabled()}>${t("View demo record 62")}</button></section>`;
  return patientCompanion(state,{t,esc,pretty,value,date},labelNames,publishedChangeSummary(r.feedbackImpact,{t,esc}),provenanceChain(r,c,{t,esc,pretty,value}));
}

function urlState(){history.replaceState({},'',`/demo?role=${state.role}${state.ctx?'&case='+state.ctx.sample.ecgId:''}`);}
function updateCaseFilter(){app.querySelectorAll<HTMLElement>('.case-choice').forEach(el=>{el.hidden=!String(el.dataset.case).includes(state.filter)||(state.caseFilter==='disagreement'&&el.dataset.exact==='true');});}
function setQuestion(q:string){state.question=q;render();app.querySelector<HTMLInputElement>('#patient-question')?.focus();}
function patientPrompt(mode:PatientMode,q?:string,selected?:string){
  if(state.busy)return;
  if(q&&state.question.trim()&&state.question!==q&&!window.confirm(t('Replace your unsent patient question?')))return;
  state.tasksUI.tab='conversation';
  if(selected&&selected!=='clarification')state.tasksUI.followupId='';
  state.journey.mode=mode;if(selected)state.journey.selected=selected;
  if(q!==undefined)state.question=q;
  render();app.querySelector<HTMLTextAreaElement>('#patient-question')?.focus();
}
function markPreviewStale(){state.previewStale=Boolean(state.preview);}
function bind(){
  app.querySelectorAll<HTMLButtonElement>('[data-language]').forEach(el=>el.onclick=()=>{
    const language=el.dataset.language;
    if((language!=='en'&&language!=='zh')||language===getLanguage())return;
    const selectors=['.workspace-panel','.revision-scroll','.doubt-scroll','.investigation-scroll','.impact-scroll','.dialogue-messages','.case-list','.signal-column','.evidence-inspector','.patient-report','.conversation','.feedback-scroll','.report-scroll','.review-side'];
    const positions=selectors.flatMap(selector=>Array.from(app.querySelectorAll(selector)).map((el,index)=>({selector,index,top:el.scrollTop})));
    const openDetails=Array.from(app.querySelectorAll<HTMLDetailsElement>('details')).map(detail=>detail.open);
    setLanguage(language);render();
    app.querySelectorAll<HTMLDetailsElement>('details').forEach((detail,i)=>detail.open=openDetails[i]||false);
    positions.forEach(({selector,index,top})=>app.querySelectorAll(selector)[index]?.scrollTo({top}));
    app.querySelector<HTMLButtonElement>(`[data-language="${language}"]`)?.focus({preventScroll:true});
  });
  app.querySelector('#expert-question-form')?.addEventListener('submit',e=>{e.preventDefault();void investigate();});
  app.querySelector('#validate-policy')?.addEventListener('click',()=>void validatePolicy());
  const labRoot=app.querySelector<HTMLElement>('[data-threshold-lab]'),labValidation=state.collaboration.rounds.at(-1)?.validation,labDraft=state.policyDraft;
  if(labRoot&&labValidation&&labDraft)bindThresholdLab(labRoot,{rows:labValidation.rows,feature:labDraft.feature,bounds:boundsOf(labDraft),validated:boundsOf(labValidation.candidate),t,esc,pretty,value,onBoundsChange:(b:Obj)=>{for(const side of ['lower','upper'] as const){const input=app.querySelector<HTMLInputElement>('#policy-'+side);if(input){input.value=b[side]==null?'':String(b[side]);input.dispatchEvent(new Event('input'));}}}});
  app.querySelectorAll<HTMLElement>('[data-guide-target]').forEach(el=>el.onclick=()=>focusGuideTarget(el.dataset.guideTarget!));
  app.querySelector<HTMLTextAreaElement>('#rev-draft')?.addEventListener('input',e=>{rev.draft=(e.target as HTMLTextAreaElement).value;rev.sourceReportRevision=null;});
  app.querySelector<HTMLButtonElement>('#rev-submit')?.addEventListener('click',()=>void submitOpinion());
  app.querySelectorAll<HTMLElement>('[data-rv-decide]').forEach(el=>el.onclick=()=>void decideOpinion(el.dataset.rvItem!,el.dataset.rvDecide as 'adopted'|'rejected'));
  app.querySelectorAll<HTMLElement>('[data-rv-open]').forEach(el=>el.onclick=()=>{rev.selectedId=el.dataset.rvOpen!;void refreshStory(rev.selectedId,true);render();});
  app.querySelectorAll<HTMLElement>('[data-story-case]').forEach(el=>el.onclick=()=>{selectStoryCase(el.dataset.storyItem!,Number(el.dataset.storyCase));render();});
  app.querySelectorAll<HTMLElement>('[data-story-retry]').forEach(el=>el.onclick=()=>void refreshStory(el.dataset.storyRetry!,true));
  app.querySelectorAll<HTMLElement>('[data-story-refine]').forEach(el=>el.onclick=()=>fillStoryFeedback(el.dataset.storyRefine!,false));
  app.querySelectorAll<HTMLElement>('[data-story-correct]').forEach(el=>el.onclick=()=>fillStoryFeedback(el.dataset.storyCorrect!,true));
  app.querySelectorAll<HTMLElement>('[data-rv-draft]').forEach(el=>el.onclick=()=>void revisionToDraft(el.dataset.rvDraft!));
  app.querySelector('[data-rv-report]')?.addEventListener('click',()=>{state.section='review';render();});
  app.querySelectorAll<HTMLElement>('[data-rv-followup]').forEach(el=>el.onclick=()=>{rev.selectedId=el.dataset.rvFollowup!;rev.draft=t('Please refine the previous candidate: ');rev.sourceReportRevision=null;render();app.querySelector<HTMLTextAreaElement>('#rev-draft')?.focus();});
  app.querySelector('#report-to-feedback')?.addEventListener('click',()=>{if(rev.draft.trim()&&!window.confirm(t('Replace the current feedback text with this report?')))return;rev.draft=state.note.slice(0,1000);rev.sourceReportRevision=state.reviewDirty?null:state.ctx?.review?.revision||null;state.section='collaboration';render();app.querySelector<HTMLTextAreaElement>('#rev-draft')?.focus();});
  for(const bound of ['lower','upper'])app.querySelector<HTMLInputElement>('#policy-'+bound)?.addEventListener('input',e=>{const input=e.target as HTMLInputElement;state.policyDraft![bound]=input.value===''?null:input.valueAsNumber;state.policyDirty=true;const accept=app.querySelector<HTMLButtonElement>('#accept-suggestion');if(accept)accept.disabled=true;app.querySelector('.impact-counts')?.classList.add('is-stale');invalidateAgentAssessment(app);const stale=app.querySelector<HTMLElement>('.policy-stale-notice');if(stale)stale.hidden=false;});
  for(const bound of ['lower','upper'])app.querySelector<HTMLSelectElement>('#policy-'+bound+'-inclusive')?.addEventListener('change',e=>{state.policyDraft![bound+'Inclusive']=(e.target as HTMLSelectElement).value==='true';state.policyDirty=true;render();});
  app.querySelectorAll<HTMLInputElement>('[data-replay-case]').forEach(el=>el.onchange=()=>{const id=Number(el.dataset.replayCase);state.cohort=el.checked?[...new Set([...state.cohort,id])]:state.cohort.filter(x=>x!==id);state.policyDirty=true;markPreviewStale();render();});
  app.querySelector<HTMLTextAreaElement>('#expert-question')?.addEventListener('input',e=>state.expertQuestion=(e.target as HTMLTextAreaElement).value);
  app.querySelector<HTMLSelectElement>('#expert-action')?.addEventListener('change',e=>state.expertAction=(e.target as HTMLSelectElement).value);
  app.querySelector<HTMLSelectElement>('#expert-focus')?.addEventListener('change',e=>state.expertFocus=(e.target as HTMLSelectElement).value);
  app.querySelector('#start-collaboration')?.addEventListener('click',()=>{state.expertQuestion=t('Summarize the evidence for this case, identify unsupported conclusions, and prepare a cautious research-review draft.');state.expertAction='auto';void investigate();});
  app.querySelectorAll<HTMLElement>('[data-expert-prompt]').forEach(el=>el.onclick=()=>{state.expertQuestion=el.dataset.expertPrompt!;render();app.querySelector<HTMLTextAreaElement>('#expert-question')?.focus();});
  app.querySelectorAll<HTMLElement>('[data-challenge-feature]').forEach(el=>el.onclick=()=>{state.expertFocus=el.dataset.challengeFeature!;state.expertQuestion=getLanguage()==='zh'?`${pretty(state.expertFocus)}的证据充分吗？请检查其局限与支持来源。`:`Is the ${pretty(state.expertFocus)} evidence sufficient? Check its limitations and supporting source.`;state.expertAction='auto';state.section='investigation';render();app.querySelector<HTMLTextAreaElement>('#expert-question')?.focus();});
  app.querySelectorAll<HTMLElement>('[data-collab-evidence]').forEach(el=>el.onclick=()=>void openCollaborationEvidence(el.dataset.collabEvidence!));
  app.querySelector('#accept-suggestion')?.addEventListener('click',()=>void decideSuggestion('accepted'));
  app.querySelector('#reject-suggestion')?.addEventListener('click',()=>void decideSuggestion('rejected'));
  app.querySelector('#restore-suggestion')?.addEventListener('click',()=>useSuggestion());
  app.querySelector('#challenge-suggestion')?.addEventListener('click',()=>{state.expertQuestion=t('I am not convinced by this suggestion. Please re-check ');render();app.querySelector<HTMLTextAreaElement>('#expert-question')?.focus();});
  app.querySelectorAll<HTMLElement>('[data-role]').forEach(el=>el.onclick=()=>{if(state.busy)return;state.role=el.dataset.role as Role;state.error='';state.message='';urlState();render();if(state.role==='expert')void task('Refreshing the saved record…',loadExpertTasks);});
  app.querySelectorAll<HTMLElement>('[data-section]').forEach(el=>el.onclick=()=>{state.section=el.dataset.section as Section;render();if(state.section==='review')void task('Refreshing evidence-check tasks…',loadExpertTasks);});
  app.querySelectorAll<HTMLElement>('[data-case]').forEach(el=>el.onclick=()=>void loadCase(Number(el.dataset.case)));
  app.querySelectorAll<HTMLElement>('[data-inspect-case]').forEach(el=>el.onclick=()=>void inspectCase(Number(el.dataset.inspectCase)));
  app.querySelector<HTMLInputElement>('#case-search')?.addEventListener('input',e=>{state.filter=(e.target as HTMLInputElement).value;updateCaseFilter();});
  app.querySelectorAll<HTMLElement>('[data-filter]').forEach(el=>el.onclick=()=>{state.caseFilter=el.dataset.filter!;render();});
  app.querySelector<HTMLSelectElement>('#patient-case')?.addEventListener('change',e=>void loadCase(Number((e.target as HTMLSelectElement).value)));
  app.querySelector('#dismiss-message')?.addEventListener('click',()=>{state.message='';render();});
  app.querySelector('#reload-case')?.addEventListener('click',()=>void refreshContext());
  app.querySelector('#retry-cases')?.addEventListener('click',()=>void init());
  app.querySelectorAll<HTMLElement>('[data-lead]').forEach(el=>el.onclick=()=>{state.lead=el.dataset.lead!;state.allLeads=false;render();});
  app.querySelectorAll<HTMLElement>('[data-window]').forEach(el=>el.onclick=()=>{state.seconds=Number(el.dataset.window);state.start=Math.min(state.start,Math.max(0,state.ctx!.waveform.durationSeconds-state.seconds));render();});
  app.querySelector<HTMLInputElement>('#signal-start')?.addEventListener('change',e=>{state.start=Number((e.target as HTMLInputElement).value);render();});
  app.querySelector('#toggle-leads')?.addEventListener('click',()=>{state.allLeads=!state.allLeads;render();});
  app.querySelector('#focus-measured-lead')?.addEventListener('click',()=>{const l=focusLead(activeFeature(),state.ctx!.waveform.leads.map((l:Obj)=>l.name));if(l){state.lead=l;state.allLeads=false;render();}});
  app.querySelector('#run-evidence')?.addEventListener('click',()=>void runEvidence());
  app.querySelectorAll<HTMLElement>('[data-feature]').forEach(el=>el.onclick=()=>{state.selectedFeature=el.dataset.feature!;render();});
  app.querySelectorAll<HTMLInputElement>('[data-attach]').forEach(el=>el.onchange=()=>{state.reviewDirty=true;state.reportApproved=false;state.featureNames=el.checked?[...new Set([...state.featureNames,el.dataset.attach!])]:state.featureNames.filter(f=>f!==el.dataset.attach);render();});
  app.querySelectorAll<HTMLElement>('[data-detach]').forEach(el=>el.onclick=()=>{state.featureNames=state.featureNames.filter(f=>f!==el.dataset.detach);state.reviewDirty=true;state.reportApproved=false;render();});
  app.querySelector<HTMLSelectElement>('#criterion-metric')?.addEventListener('change',e=>{state.metric=(e.target as HTMLSelectElement).value;state.threshold=metricSpecs[state.metric].threshold;state.op=state.metric==='PR'?'>':'>=';markPreviewStale();render();});
  app.querySelector<HTMLSelectElement>('#criterion-op')?.addEventListener('change',e=>{state.op=(e.target as HTMLSelectElement).value;markPreviewStale();render();});
  app.querySelector<HTMLInputElement>('#criterion-threshold')?.addEventListener('input',e=>{state.threshold=(e.target as HTMLInputElement).valueAsNumber;markPreviewStale();const summary=app.querySelector('.preview-summary');if(summary)summary.classList.add('stale');});
  app.querySelector<HTMLInputElement>('#criterion-threshold')?.addEventListener('change',()=>render());
  app.querySelectorAll<HTMLElement>('[data-remove-cohort]').forEach(el=>el.onclick=()=>{state.cohort=state.cohort.filter(id=>id!==Number(el.dataset.removeCohort));state.policyDirty=Boolean(state.collaboration.rounds.at(-1)?.validation)||state.policyDirty;markPreviewStale();render();});
  app.querySelector<HTMLSelectElement>('#cohort-add')?.addEventListener('change',e=>{const id=Number((e.target as HTMLSelectElement).value);if(id&&state.cohort.length<8&&!state.cohort.includes(id)){state.cohort.push(id);state.policyDirty=Boolean(state.collaboration.rounds.at(-1)?.validation)||state.policyDirty;markPreviewStale();render();}});
  app.querySelector('#criterion-form')?.addEventListener('submit',e=>{e.preventDefault();void previewCriterion();});
  app.querySelectorAll<HTMLInputElement>('[name="review-label"]').forEach(el=>el.onchange=()=>{let selected=Array.from(app.querySelectorAll<HTMLInputElement>('[name="review-label"]:checked')).map(i=>i.value);if(el.checked&&el.value==='NORM')selected=['NORM'];else if(el.checked)selected=selected.filter(l=>l!=='NORM');state.labels=selected;state.reviewDirty=true;state.reportApproved=false;render();});
  app.querySelector<HTMLTextAreaElement>('#review-note')?.addEventListener('input',e=>{state.note=(e.target as HTMLTextAreaElement).value;state.reviewDirty=true;state.reportApproved=false;const preview=app.querySelector('.system-report-body');if(preview)preview.textContent=state.note;const check=app.querySelector<HTMLInputElement>('#report-approved');if(check)check.checked=false;syncPublishButton();const mark=app.querySelector('.draft-indicator');if(mark)mark.textContent=t('Unsaved changes');});
  app.querySelector<HTMLTextAreaElement>('#report-instructions')?.addEventListener('input',e=>{state.reportInstructions=(e.target as HTMLTextAreaElement).value;state.reportApproved=false;const check=app.querySelector<HTMLInputElement>('#report-approved');if(check){check.checked=false;check.disabled=!reportIsCurrent(state)||Boolean(state.reportInstructions.trim());}syncPublishButton();});
  app.querySelector<HTMLInputElement>('#report-approved')?.addEventListener('change',e=>{state.reportApproved=(e.target as HTMLInputElement).checked;syncPublishButton();});
  app.querySelector('#generate-patient-report')?.addEventListener('click',()=>void generateReport());
  app.querySelector('#save-draft')?.addEventListener('click',()=>void saveReview('draft'));
  app.querySelector('#publish-report')?.addEventListener('click',()=>void saveReview('published'));
  app.querySelectorAll<HTMLElement>('[data-question]').forEach(el=>el.onclick=()=>setQuestion(el.dataset.question!));
  app.querySelectorAll<HTMLElement>('[data-material]').forEach(el=>el.onclick=()=>{
    const id=el.dataset.material!,measurement=id.startsWith('measurement:');
    patientPrompt(measurement?'evidence':'explain',el.dataset.patientPrompt||(measurement?
      (getLanguage()==='zh'?`请用普通人能理解的话解释报告中的${pretty(id.slice(12))}，不需要先教我专业术语。`:`Explain the attached ${pretty(id.slice(12))} in everyday words, without requiring technical knowledge.`):t('Explain what this report says in everyday language.')),id);
  });
  app.querySelectorAll<HTMLElement>('[data-patient-mode]').forEach(el=>el.onclick=()=>patientPrompt(el.dataset.patientMode as PatientMode,el.dataset.patientPrompt,'report'));
  app.querySelectorAll<HTMLElement>('[data-patient-turn]').forEach(el=>el.onclick=()=>{state.journey.activeTurn=Number(el.dataset.patientTurn);render();});
  app.querySelector('#patient-teachback')?.addEventListener('click',()=>patientPrompt('teachback','',state.tasksUI.followupId?'clarification':'report'));
  app.querySelector('#patient-simplify')?.addEventListener('click',()=>{
    const a=state.journey.activeTurn>=0?state.messages[state.journey.activeTurn]:state.messages.filter(m=>m.role==='assistant'&&m.source==='llm').at(-1);
    const prefix=t('I still do not understand this explanation. Please use simpler everyday language, without medical terms: ');
    patientPrompt('explain',prefix+(a?.explanation||'').slice(0,Math.max(0,500-prefix.length)));
  });
  app.querySelectorAll<HTMLElement>('[data-understood]').forEach(el=>el.onclick=()=>{const id=el.dataset.understood!;state.journey.understood=state.journey.understood.includes(id)?state.journey.understood.filter(x=>x!==id):[...state.journey.understood,id];render();});
  app.querySelectorAll<HTMLElement>('[data-save-patient-question]').forEach(el=>el.onclick=()=>{addQuestion(state.journey,el.dataset.savePatientQuestion!);render();const d=app.querySelector<HTMLDetailsElement>('[data-patient-detail="notebook"]');if(d)d.open=true;});
  app.querySelectorAll<HTMLElement>('[data-remove-patient-question]').forEach(el=>el.onclick=()=>{state.journey.questions.splice(Number(el.dataset.removePatientQuestion),1);render();});
  app.querySelector('#prepare-patient-request')?.addEventListener('click',()=>{
    if(state.tasksUI.question.trim()&&!window.confirm(t('Replace your unsent patient question?')))return;
    state.tasksUI.tab='task';state.tasksUI.question=state.journey.questions[0]||'';state.tasksUI.label='';
    state.message='The first saved question is prepared for the Agent. Send explicitly to run the check.';render();
    app.querySelector<HTMLTextAreaElement>('#patient-task-question')?.focus();
  });
  app.querySelectorAll<HTMLElement>('[data-patient-feature]').forEach(el=>el.onclick=()=>{state.patientFeature=el.dataset.patientFeature!;setQuestion(getLanguage()==='zh'?`报告中的${pretty(state.patientFeature)}测量是什么意思？`:`What does the ${pretty(state.patientFeature)} measurement in this report mean?`);});
  app.querySelector<HTMLTextAreaElement>('#patient-question')?.addEventListener('input',e=>state.question=(e.target as HTMLTextAreaElement).value);
  app.querySelector('#question-form')?.addEventListener('submit',e=>{e.preventDefault();void askQuestion();});
  app.querySelector('#toggle-feedback')?.addEventListener('click',()=>{state.showFeedback=!state.showFeedback;render();});
  app.querySelector<HTMLTextAreaElement>('#patient-feedback')?.addEventListener('input',e=>{if(!state.feedback.trim())state.patientFeedbackKey=journeyKey(state.ctx!);state.feedback=(e.target as HTMLTextAreaElement).value;});
  app.querySelector('#feedback-form')?.addEventListener('submit',e=>{e.preventDefault();void sendFeedback();});
  bindPatientTasks();
  // Keep request inputs stable until the response is reconciled with this view.
  if(state.busy)app.querySelectorAll<HTMLInputElement>('input,textarea,select,button[data-remove-cohort],button[data-detach]').forEach(el=>el.disabled=true);
}
async function loadExpertTasks(){
  const contextId=state.ctx!.contextId,result=await fetchJson<Obj>(base()+'/patient-tasks/review');
  if(result.contextId!==contextId||state.ctx?.contextId!==contextId)throw new Error('Case context changed. Refresh before continuing.');
  state.expertTasks=result;
}
async function refreshTaskContext(){
  const contextId=state.ctx!.contextId,c=await fetchJson<Obj>(base());
  if(c.contextId!==contextId||state.ctx?.contextId!==contextId)throw new Error('Case context changed. Refresh before continuing.');
  state.ctx=c;
}
async function patientTaskAction(itemId:string,action:string,extra:Obj={},expert=false){
  const contextId=state.ctx!.contextId;
  const result=await postJson<Obj>(base()+`/patient-tasks/${itemId}/${action}`,{contextId,
    expectedRevision:expert?state.expertTasks.revision:state.ctx!.patientTasks.revision,
    reportRevision:state.ctx!.publishedReport.revision,language:getLanguage(),...extra});
  if(result.contextId!==contextId||state.ctx?.contextId!==contextId)throw new Error('Case context changed. Refresh before continuing.');
  if(expert)state.expertTasks=result;
  await refreshTaskContext();
  if(expert)await loadExpertTasks();
}
function bindPatientTasks(){
  const ui=state.tasksUI;
  app.querySelectorAll<HTMLElement>('[data-patient-tab]').forEach(el=>el.onclick=()=>{ui.tab=el.dataset.patientTab!;render();});
  app.querySelectorAll<HTMLElement>('[data-patient-task]').forEach(el=>el.onclick=()=>{ui.selectedId=el.dataset.patientTask!;render();});
  app.querySelector<HTMLTextAreaElement>('#patient-task-question')?.addEventListener('input',e=>ui.question=(e.target as HTMLTextAreaElement).value);
  app.querySelector<HTMLSelectElement>('#patient-task-label')?.addEventListener('change',e=>ui.label=(e.target as HTMLSelectElement).value);
  app.querySelector('#patient-task-new')?.addEventListener('click',()=>{ui.composing=true;render();app.querySelector<HTMLTextAreaElement>('#patient-task-question')?.focus();});
  app.querySelector('#patient-task-starter')?.addEventListener('click',()=>{if(ui.question.trim())return;ui.question=t('What supports this report finding, and what cannot be concluded from it?');render();app.querySelector<HTMLTextAreaElement>('#patient-task-question')?.focus();});
  app.querySelector('#patient-task-investigate')?.addEventListener('submit',e=>{e.preventDefault();void task('The Agent is checking the published materials…',async()=>{
    const contextId=state.ctx!.contextId,reportRevision=state.ctx!.publishedReport.revision;
    const result=await postJson<Obj>(base()+'/patient-tasks/investigate',{contextId,reportRevision,
      expectedRevision:state.ctx!.patientTasks.revision,question:ui.question.trim(),label:ui.label,language:getLanguage()});
    if(result.contextId!==contextId||!state.ctx||state.ctx.contextId!==contextId||state.ctx.publishedReport.revision!==reportRevision)throw new Error('The report or review task changed during the check. Your question is retained.');
    state.ctx!.patientTasks={revision:result.revision,items:result.items};ui.selectedId=result.selectedId;ui.question='';ui.composing=false;
    await refreshTaskContext();
    state.message='The Agent check is ready. Explore the finding now; saving a further check target is optional.';
  });});
  app.querySelector<HTMLTextAreaElement>('#task-request')?.addEventListener('input',e=>{const i=activeTask(state);if(i)ui.requests[i.id]=(e.target as HTMLTextAreaElement).value;});
  app.querySelector('#patient-task-submit')?.addEventListener('submit',e=>{e.preventDefault();const i=activeTask(state);if(!i)return;void task('Saving an evidence-check target…',async()=>{await patientTaskAction(i.id,'submit',{text:ui.requests[i.id]??i.investigation.reviewQuestion});state.message='The evidence-check task is saved. The Agent finding remains available; your report is unchanged.';});});
  app.querySelectorAll<HTMLElement>('[data-task-recheck]').forEach(el=>el.onclick=()=>void task('The Agent is checking the published materials…',async()=>{await patientTaskAction(el.dataset.taskRecheck!,'recheck');state.message='The Agent rechecked your original question against the current published materials.';}));
  app.querySelectorAll<HTMLElement>('[data-task-start]').forEach(el=>el.onclick=()=>void task('Updating the review task…',async()=>{await patientTaskAction(el.dataset.taskStart!,'start',{},true);}));
  app.querySelectorAll<HTMLElement>('[data-task-investigate]').forEach(el=>el.onclick=()=>{
    if(state.expertQuestion.trim()&&!window.confirm(t('Replace the current unsent feedback?')))return;
    const i=state.expertTasks.items.find((i:Obj)=>i.id===el.dataset.taskInvestigate);if(!i)return;
    state.expertQuestion=i.requestText||i.investigation.reviewQuestion;state.expertAction='auto';state.expertFocus='';state.section='investigation';render();
  });
  app.querySelectorAll<HTMLElement>('[data-task-feedback]').forEach(el=>el.onclick=()=>{
    if(rev.draft.trim()&&!window.confirm(t('Replace the current unsent feedback?')))return;
    const i=state.expertTasks.items.find((i:Obj)=>i.id===el.dataset.taskFeedback);if(!i)return;
    rev.draft=i.requestText||i.investigation.reviewQuestion;rev.sourceReportRevision=null;state.section='collaboration';render();
  });
  app.querySelectorAll<HTMLSelectElement>('[data-task-work]').forEach(el=>el.onchange=()=>{ui.work[el.dataset.taskWork!]=el.value;ui.approvals[el.dataset.taskWork!]=false;render();});
  app.querySelectorAll<HTMLInputElement>('[data-task-work-approve]').forEach(el=>el.onchange=()=>{ui.approvals[el.dataset.taskWorkApprove!]=el.checked;render();});
  app.querySelectorAll<HTMLElement>('[data-task-complete]').forEach(el=>el.onclick=()=>void task('Updating the review task…',async()=>{
    const i=state.expertTasks.items.find((i:Obj)=>i.id===el.dataset.taskComplete);if(!i)return;
    const key=workKey(i,state.ctx!.publishedReport.revision),selected=ui.work[key]||'',split=selected.indexOf(':');
    await patientTaskAction(i.id,'complete-review',{workKind:selected.slice(0,split),workId:selected.slice(split+1),approved:ui.approvals[key]||false},true);
    state.message='Actual review work recorded. No patient reply or report was published.';
  }));
  app.querySelectorAll<HTMLElement>('[data-task-followup]').forEach(el=>el.onclick=()=>{
    const question=t('Explain what the Agent found for my original question, what the current report changes show, and what is still unknown.');
    if(state.question.trim()&&state.question!==question&&!window.confirm(t('Replace your unsent patient question?')))return;
    ui.followupId=el.dataset.taskFollowup!;ui.followupRevision=state.ctx!.publishedReport.revision;ui.tab='conversation';state.question=question;state.journey.mode='explain';state.journey.selected='clarification';state.messages=[];state.journey.activeTurn=-1;render();
  });
}
async function task(name:string,run:()=>Promise<void>){if(state.busy)return;state.busy=name;state.error='';state.message='';render();try{await run();}catch(e){state.error=e instanceof Error?e.message:String(e);}finally{state.busy='';render();}}
function applyContext(c:Obj,reset=true){
  state.ctx=c;state.sourceChanged=false;
  if(reset){state.evidence=null;state.selectedFeature='';state.preview=null;state.previewStale=false;state.messages=[];state.question='';state.feedback='';state.patientFeature='';state.showFeedback=false;state.start=0;state.cohort=defaultCohort(c.sample.ecgId,state.cases.map(s=>s.ecgId));state.collaboration={revision:0,rounds:[]};state.collaborationLoaded=false;resetRevision();state.expertQuestion='';state.expertFocus='';state.expertAction='auto';state.suggestionFeatures=[];}
  state.featureNames=c.review?.features?.map((f:Obj)=>f.name)||[];state.labels=c.review?.labels||[];state.note=c.review?.note||'';state.analysisRoundId=c.review?.analysisRoundId||null;state.reviewDirty=false;state.reviewBaseRevision=c.revision;urlState();
  state.policyRoundId=c.review?.reviewPolicy?.roundId||null;
  state.revisionItemId=c.review?.revisionItemId||null;
  state.patientReportId=c.review?.patientReportId||null;state.patientReportBasis=state.patientReportId?reportBasisKey(state):'';
  state.patientReportLanguage=c.review?.patientReport?.language||'';state.reportApproved=false;state.reportInstructions='';
  if(reset){state.policyDraft=null;state.policyDirty=false;state.expertTasks={revision:0,items:[]};}
}
async function loadCase(id:number){
  if(state.busy)return false;
  if((state.reviewDirty||state.expertQuestion.trim()||rev.draft.trim()||state.policyDirty||state.reportInstructions.trim()||state.question.trim()||state.feedback.trim()||state.journey.questions.length||hasTaskDraft(state))&&!window.confirm(t('This record has unsaved review changes or an unsent question. Switch records and discard them?'))){render();return false;}
  let loaded=false;await task('Loading recorded ECG…',async()=>{applyContext(await fetchJson(`/api/demo/ptbxl/cases/${id}`));await loadCollaboration();await loadInitialEvidence();loaded=true;});return loaded;
}
function syncPolicy(){const r=state.collaboration.rounds.at(-1);state.policyDraft=r?.validation?.candidate?structuredClone(r.validation.candidate):r?.candidate?structuredClone(r.candidate):null;state.policyDirty=false;if(r?.validation)state.cohort=r.validation.rows.map((x:Obj)=>x.ecgId);}
async function refreshStory(itemId:string,force=false){const contextId=state.ctx!.contextId;const pending=loadStory(base(),contextId,itemId,force);render();await pending;if(state.ctx?.contextId===contextId)render();}
function fillStoryFeedback(itemId:string,correct:boolean){
  const text=correct?t('The candidate does not reflect my intent. Please reinterpret my concern as follows: '):storyRefinement(itemId,{t,esc});
  if(!text)return;
  if(rev.draft.trim()&&!window.confirm(t('Replace the current unsent feedback?')))return;
  rev.selectedId=itemId;rev.draft=text;rev.sourceReportRevision=null;render();app.querySelector<HTMLTextAreaElement>('#rev-draft')?.focus();
}
async function loadCollaboration(){const c=await fetchJson<Obj>(base()+'/collaboration');if(c.contextId!==state.ctx!.contextId)throw new Error('Case context changed. Refresh before continuing.');const keep=state.policyDirty&&state.collaboration.rounds.at(-1)?.id===c.rounds.at(-1)?.id;state.collaboration=c;state.collaborationLoaded=true;if(!keep)syncPolicy();await loadRevision(base(),state.ctx!.contextId);if(state.role==='expert')await loadExpertTasks();}
async function investigate(){
  if(state.busy||state.expertQuestion.trim().length<3)return;
  if(state.policyDirty&&!window.confirm(t('Start a new investigation and discard your unvalidated condition edits?')))return;
  await task('Checking evidence and preparing a response. Your question is kept until this completes…',async()=>{
    if(state.sourceChanged)throw new Error('Source context changed. Refresh this record.');
    if(!state.collaborationLoaded)await loadCollaboration();
    const answer=await postJson<Obj>(base()+'/collaboration',{contextId:state.ctx!.contextId,expectedRevision:state.collaboration.revision,message:state.expertQuestion.trim(),action:state.expertAction,focus:state.expertFocus,autonomous:state.expertAction==='auto',caseIds:[...state.cohort]});
    state.collaboration=answer;syncPolicy();state.expertQuestion='';state.message='Analysis returned. Check the evidence and proposed changes before accepting.';
  });
  // Show the beginning of the latest answer, not the bottom of its check receipt.
  const history=app.querySelector<HTMLElement>('.collab-history');
  const latest=history?.querySelector<HTMLElement>('.collab-round:last-child');
  if(history&&latest)history.scrollTo({top:history.scrollTop+latest.getBoundingClientRect().top-history.getBoundingClientRect().top,behavior:'smooth'});
}
function useSuggestion(confirmReplace=true){
  const r=state.collaboration.rounds.at(-1);if(!r||r.decision!=='accepted')return;
  if(confirmReplace&&state.reviewDirty&&!window.confirm(t('Replace the unsaved note and attachments with this suggestion? Your saved reports will not change.')))return;
  if(r.baseReportRevision!==state.ctx!.revision){state.error='The report changed since this suggestion. Ask for a fresh analysis before using it.';render();return;}
  state.note='';state.patientReportId=null;state.patientReportBasis='';state.reportApproved=false;state.reportInstructions='';state.featureNames=[...r.featureNames];state.suggestionFeatures=r.features;state.analysisRoundId=r.id;state.reviewDirty=true;state.section='review';state.message='Evidence loaded. Choose report labels explicitly, then let the system generate the patient report.';
  state.revisionItemId=null;
  state.policyRoundId=r.policy?r.id:null;render();
}
async function decideSuggestion(decision:'accepted'|'rejected'){
  if(state.busy)return;
  const latest=state.collaboration.rounds.at(-1);
  if(decision==='accepted'&&latest?.candidate&&(state.policyDirty||!latest.validation))return;
  await task(decision==='accepted'?'Recording your decision…':'Keeping the suggestion as rejected…',async()=>{const r=state.collaboration.rounds.at(-1);if(!r)return;state.collaboration=await postJson(base()+'/collaboration/decision',{contextId:state.ctx!.contextId,expectedRevision:state.collaboration.revision,roundId:r.id,decision,validationId:r.validation?.id||null});syncPolicy();state.message=decision==='rejected'?'Suggestion rejected. Explain what should be checked next; the report has not changed.':'Decision recorded. No report has been published by this action.';});
}
async function validatePolicy(){await task('Running boundary tests and actual case replay…',async()=>{if(!state.cohort.length)throw new Error('Select at least one record to preview.');const r=state.collaboration.rounds.at(-1);state.collaboration=await postJson(base()+'/collaboration/validate',{contextId:state.ctx!.contextId,expectedRevision:state.collaboration.revision,roundId:r.id,candidate:state.policyDraft,caseIds:[...state.cohort]});syncPolicy();state.message='Validation complete. Inspect new flags, unchanged records and missing measurements before adopting.';});}
async function openCollaborationEvidence(name:string){state.section='evidence';await runEvidence();state.selectedFeature=name;render();}
async function inspectCase(id:number){if(await loadCase(id)){state.section='evidence';await runEvidence();}}
async function loadInitialEvidence(){if(state.role==='expert')state.evidence=await postJson(base()+'/evidence',{contextId:state.ctx!.contextId,lead:state.lead});}
async function runEvidence(){await task('Running the reference feature tool…',async()=>{state.evidence=await postJson(base()+'/evidence',{contextId:state.ctx!.contextId,lead:state.lead});const features=state.evidence!.result.features;state.selectedFeature=features.find((f:Obj)=>f.judgment.status==='abnormal')?.name||features.find((f:Obj)=>f.name==='qrs_duration_ms')?.name||features[0]?.name;});}
async function previewCriterion(){await task('Checking the selected case measurements…',async()=>{if(!state.cohort.length)throw new Error('Select at least one record to preview.');const text=criterionText(state.metric,state.op,state.threshold);state.preview=await postJson(base()+'/criteria/preview',{text,contextId:state.ctx!.contextId,caseIds:[...state.cohort]});state.previewStale=false;});}
function syncPublishButton(){const button=app.querySelector<HTMLButtonElement>('#publish-report');if(button)button.disabled=!canPublishReport(state);}
async function generateReport(){
  let generated=false;
  await task('Generating a patient-friendly report from the selected assessment and evidence…',async()=>{
    if(state.sourceChanged)throw new Error('Source context changed. Refresh this record.');
    if(!state.labels.length)throw new Error('Choose report labels before generating.');
    state.reportApproved=false;
    const basis=reportBasisKey(state);
    const answer=await postJson<Obj>(base()+'/patient-report',{contextId:state.ctx!.contextId,expectedRevision:state.reviewBaseRevision,
      expectedGenerationRevision:state.ctx!.patientReportGenerationRevision||0,labels:state.labels,featureNames:state.featureNames,
      revisionItemId:state.revisionItemId,policyRoundId:state.policyRoundId,analysisRoundId:state.analysisRoundId,
      language:getLanguage(),instructions:state.reportInstructions,previousDraft:state.patientReportId?state.note:''});
    state.ctx!.patientReportGenerationRevision=answer.generationRevision;
    state.patientReportId=answer.report.id;state.patientReportBasis=basis;state.patientReportLanguage=answer.report.language;
    state.note=answer.report.note;state.reportInstructions='';state.reviewDirty=true;
    generated=true;
    state.message='System report generated. Review its content and limitations, then approve publication. Nothing is published yet.';
  });
  if(generated){const panel=app.querySelector<HTMLElement>('.report-scroll'),preview=app.querySelector<HTMLElement>('.system-report-preview');if(panel&&preview&&panel.scrollHeight>panel.clientHeight)panel.scrollTo({top:panel.scrollTop+preview.getBoundingClientRect().top-panel.getBoundingClientRect().top-10,behavior:'smooth'});}
}
async function saveReview(status:'draft'|'published'){
  if(status==='published'&&!canPublishReport(state)){state.error='Generate and review the current patient report before publishing.';render();return;}
  await task(status==='published'?'Publishing the versioned demo report…':'Saving review draft…',async()=>{const problem=validReview(state.labels,state.note);if(problem)throw new Error(problem);if(state.sourceChanged)throw new Error('Source context changed. Refresh the record before saving.');if(state.patientReportId&&!reportIsCurrent(state))throw new Error('Assessment or evidence changed. Generate a fresh report before publishing.');await postJson(base()+'/review',{contextId:state.ctx!.contextId,expectedRevision:state.reviewBaseRevision,labels:state.labels,note:state.note,status,featureNames:state.featureNames,analysisRoundId:state.analysisRoundId,policyRoundId:state.policyRoundId,revisionItemId:state.revisionItemId,patientReportId:state.patientReportId,reportApproved:state.reportApproved});const c=await fetchJson<Obj>(base());applyContext(c,false);state.messages=[];state.message=status==='published'?`Report v${c.publishedReport.revision} published with ${c.publishedReport.features.length} attached measurements. Open Patient to view this version.`:`Draft v${c.revision} saved. The patient still sees the last published report, if any.`;});
}
async function askQuestion(){
  const q=state.question.trim(),c=state.ctx;if(!q||!c?.publishedReport)return;
  const key=journeyKey(c),contextId=c.contextId,reportRevision=c.publishedReport.revision,mode=state.journey.mode;
  const previous=state.journey.activeTurn>=0?state.messages.slice(0,state.journey.activeTurn+1):state.messages;
  const history=previous.filter(m=>m.source!=="error"&&m.source!=="safety").slice(-6).map(m=>({role:m.role,text:m.text}));
  await task("Helping you understand the published report…",async()=>{
    state.messages.push({role:"user",text:q});render();
    try{
      const result=await postJson<Obj>(base()+"/understand",{contextId,reportRevision,mode,language:getLanguage(),selected:state.journey.selected,question:q,history,taskId:state.tasksUI.followupId||null});
      if(!state.ctx||journeyKey(state.ctx)!==key||result.contextId!==contextId||result.reportRevision!==reportRevision)return;
      state.messages.push({role:"assistant",...result,text:[result.explanation,result.symptoms,result.dailyCare,result.medication,result.followUpQuestion,result.basis,result.limitation].filter(Boolean).join("\n")});
      state.journey.activeTurn=state.messages.length-1;state.question="";
    }catch(e){if(state.ctx&&journeyKey(state.ctx)===key)state.messages.push({role:"assistant",text:e instanceof Error?e.message:String(e),source:"error"});}
  });
}
async function sendFeedback(){await task('Saving the clarification request…',async()=>{if(state.patientFeedbackKey&&state.patientFeedbackKey!==journeyKey(state.ctx!))throw new Error("This clarification draft belongs to an earlier report. Copy it, clear the draft, and review it against the current report before sending.");await postJson(base()+'/feedback',{contextId:state.ctx!.contextId,reportRevision:state.ctx!.publishedReport.revision,text:state.feedback});state.ctx=await fetchJson(base());state.feedback='';state.patientFeedbackKey='';state.showFeedback=false;state.message='Request saved to the expert queue, linked to this report version.';});}
async function refreshContext(){await task('Refreshing the saved record…',async()=>{const c=await fetchJson<Obj>(base());if(c.contextId!==state.ctx!.contextId){if(state.reviewDirty||state.expertQuestion.trim()||rev.draft.trim()||state.policyDirty)throw new Error('The signal or tool changed. Your unsaved note/question is kept; copy it before reloading the page.');applyContext(c);await loadCollaboration();return;}if(state.reviewDirty){state.ctx=c;state.reviewBaseRevision=c.revision;state.message='Latest published report loaded alongside your unsaved draft. Compare it before publishing.';}else applyContext(c,false);await loadCollaboration();});}
async function init(){await task('Loading case library…',async()=>{const data=await fetchJson<Obj>('/api/demo/cases');state.cases=data.samples;if(!data.samples.length)throw new Error('No recorded cases are available.');const requested=Number(params.get('case'));const id=data.samples.find((s:Obj)=>s.ecgId===requested)?.ecgId||data.samples.find((s:Obj)=>s.ecgId===(state.role==='patient'?62:26))?.ecgId||data.samples[0].ecgId;applyContext(await fetchJson(`/api/demo/ptbxl/cases/${id}`));await loadCollaboration();await loadInitialEvidence();});}
window.addEventListener('beforeunload',e=>{if(state.reviewDirty||state.expertQuestion.trim()||rev.draft.trim()||state.policyDirty||state.reportInstructions.trim()||hasTaskDraft(state)){e.preventDefault();e.returnValue='';}});
// Read-only refresh. Do not destroy the active text field on a remote update.
setInterval(async()=>{
 if(!state.ctx||state.busy||document.hidden||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName||''))return;
 const id=state.ctx.sample.ecgId;
 try{
  const c=await fetchJson<Obj>(base());if(state.ctx?.sample.ecgId!==id||state.busy)return;
  if(c.contextId!==state.ctx.contextId){if(!state.sourceChanged){state.sourceChanged=true;state.error='The source run or evidence tool changed. Refresh this record.';render();}return;}
  const changed=c.revision!==state.ctx.revision,tasksChanged=c.patientTasks.revision!==state.ctx.patientTasks?.revision;
  const publishedChanged=c.publishedReport?.revision!==state.ctx.publishedReport?.revision;
  if(changed||tasksChanged||c.feedback.length!==state.ctx.feedback.length){
   if(changed&&!state.reviewDirty)applyContext(c,false);else state.ctx=c;
   if(state.role==='expert'&&(tasksChanged||changed))await loadExpertTasks();
   if(changed&&(state.role!=='patient'||publishedChanged)){if(publishedChanged)state.messages=[];state.message=state.reviewDirty?'A new review version is available. Your draft is kept; refresh and compare before publishing.':'A new review version is available. The report has been refreshed.';}
   render();
  }
 }catch{/* Preserve the current view on a transient read failure. */}
},8000);
if(params.get('scenario')==='positive')mountPositiveDemo(app);else void init();
import {invalidateAgentAssessment} from './agent_trace.ts';
