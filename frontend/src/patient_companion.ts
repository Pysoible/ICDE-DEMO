import {patientTaskBody,patientTaskComposer,taskTabs} from './patient_tasks.ts';
import {patientCareSections,patientHealthStarters} from './patient_advice.ts';
import {patientResponseFocus,patientContextCard,patientFollowUp} from './patient_response.ts';
type Obj=Record<string,any>;
type Helpers={t:(s:string)=>string;esc:(s:any)=>string;pretty:(s:string)=>string;value:(f:any)=>string;date:(s:string)=>string};
export type PatientMode='explain'|'evidence'|'uncertainty'|'prepare'|'teachback';
export function newJourney(){return {key:'',mode:'explain' as PatientMode,selected:'report',understood:[] as string[],questions:[] as string[],activeTurn:-1};}
export function journeyKey(c:Obj){return `${c.contextId}:${c.publishedReport?.revision||0}`;}
export function syncJourney(s:Obj){
  const key=journeyKey(s.ctx);
  if(s.journey.key!==key){s.journey={...newJourney(),key};s.messages=[];s.patientFeature='';}
}
export function addQuestion(j:ReturnType<typeof newJourney>,q:string){
  if(!q.trim()||j.questions.includes(q.trim())||j.questions.length>=6)return;
  if(q.trim().length<=140)j.questions.push(q.trim());
}
export function questionPacket(s:Obj,t:Helpers['t']):string{
  const r=s.ctx.publishedReport;
  return `${t('Questions about published report')} v${r.revision} · ECG ${s.ctx.sample.ecgId}\n${s.journey.questions.map((q:string,i:number)=>`${i+1}. ${q}`).join('\n')}`;
}
export function materialTitle(id:string,h:Helpers){return id==='report'?h.t('Published report'):id==='change'?h.t('Published assessment change'):id==='clarification'?h.t('Agent check and published-version comparison'):h.pretty(id.replace(/^measurement:/,''));}
const modes:[PatientMode,string,string,string][]=[
  ['explain','01','Read my report','Explain what this report says in everyday language.'],
  ['uncertainty','02','Address my worries','Does a finding in this report mean a confirmed disease? Explain what is known and what is not, without assuming I am safe or ill.'],
  ['prepare','03','Add my situation','I would like to add my symptoms, when they happen, sleep habits or current medicines. Ask me one focused question so the explanation can address my situation.'],
];
export function patientCompanion(s:Obj,h:Helpers,labelNames:Record<string,string>,changeHtml:string,provenance:string){
  const {t,esc,pretty,value,date}=h,c=s.ctx,r=c.publishedReport,j=s.journey;
  const last=s.messages.map((m:Obj,i:number)=>({...m,index:i})).filter((m:Obj)=>m.role==='assistant'&&m.source!=='error').at(-1);
  const active=s.messages[j.activeTurn]?.role==='assistant'?s.messages[j.activeTurn]:last;
  const activeIndex=j.activeTurn>=0?j.activeTurn:last?.index;
  const busy=s.busy?'disabled':'';
  const taskMode=s.tasksUI?.tab==='task';
  const findings=`<section class="patient-report-labels" aria-label="${esc(t('Report findings'))}"><h4>${t('Report findings')}</h4><div class="patient-findings">${r.labels.length?r.labels.map((l:string)=>`<button data-material="report" data-patient-prompt="${esc(t('Please explain the report finding: ')+l)}" ${busy}><b>${esc(l)}</b><span>${esc(t(labelNames[l]||l))}</span><span aria-hidden="true">↗</span></button>`).join(''):`<p class="muted">${t('No labels in this published report.')}</p>`}</div><p class="micro">${t('Select a finding to ask what it means.')}</p></section>`;
  return `<div class="patient-journey-strip"><div><span class="published-dot"></span><b>${t('Published demo report · v')}${r.revision}</b><small>ECG ${c.sample.ecgId} · ${esc(date(r.updatedAt))}</small></div><p>${t('Read together')} <span>→</span> ${t('Check my understanding')} <span>→</span> ${t('Take questions forward')}</p></div>
  <div class="patient-studio"><section class="surface patient-document"><div class="patient-doc-header"><span class="eyebrow">${t('YOUR REPORT · YOUR PACE')}</span><h2>${t('You do not need to speak ECG.')}</h2></div>
  <div class="patient-doc-scroll" tabindex="0">
  <section class="patient-original"><div class="panel-heading"><h3>${t("Published report")}</h3><span>v${r.revision}</span></div>${findings}<div class="patient-report-ready"><h3>${t("Your report is ready. Start with your question.")}</h3><p>${t("Start with a finding, share what happens in everyday life, then see how the explanation responds.")}</p><button data-material="report" class="text-button" ${busy}>${t("Read this with me")} →</button></div><details data-patient-detail="original"><summary>${t("Read the original published text")}</summary><h3>${t(r.patientReport?"RecursiveECG report · expert-reviewed demo":"Previously published demo report")}</h3><p>${esc(r.note)}</p></details></section>
  ${j.understood.length?`<section class="patient-clear-list"><span>${t("WHAT IS CLEARER TO ME")}</span>${j.understood.map((id:string)=>`<p>${esc(s.messages[Number(id)]?.explanation||"")}</p>`).join("")}<small>${t("Marked by you, not a medical confirmation.")}</small></section>`:""}
  <div class="patient-reading-guide"><span>${t('MAKE IT ABOUT YOUR QUESTION')}</span><p>${t('Tell the Agent when a symptom happens, what worries you, or which medicine you want explained. Your own words become a visible focus in the next answer.')}</p><button data-patient-mode="prepare" data-patient-prompt="${esc(t('I would like to add my symptoms, when they happen, sleep habits or current medicines. Ask me one focused question so the explanation can address my situation.'))}" class="text-button" ${busy}>${t('Add my situation')} →</button></div>
  <details data-patient-detail="technical" class="patient-technical"><summary>${t('Optional: original terms & measurements')}</summary><p class="micro">${t('You can use this companion without understanding these technical details.')}</p>${changeHtml}
  <section class="patient-evidence"><div class="panel-heading"><h3>${t('Evidence attached to this report')}</h3><span class="count">${r.features.length}</span></div>${r.features.length?r.features.map((f:Obj)=>`<button class="patient-measurement ${j.selected==='measurement:'+f.name?'focused':''}" data-material="measurement:${esc(f.name)}" ${busy}><span>${esc(pretty(f.name))}</span><strong>${esc(value(f))}</strong><small>${t('Explore this attachment')} →</small></button>`).join(''):`<p class="muted">${t('No measurements were attached to this version.')}</p>`}</section>${provenance}</details>
  </div></section>
  <section class="surface patient-companion ${active?'has-answer':''}"><div class="companion-heading"><div><span class="eyebrow">${t('RECURSIVEECG · UNDERSTANDING COMPANION')}</span><h2>${t('Not just an answer. A clearer understanding.')}</h2></div><span class="context-badge">${t('Report v')}${r.revision}</span></div>
  ${s.tasksUI?taskTabs(s,h):''}<div class="companion-scroll" tabindex="0">${patientHealthStarters(h,Boolean(s.busy))}${taskMode?patientTaskBody(s,h):''}<div ${taskMode?'hidden':''}><div class="patient-intents">${modes.map(([mode,n,title,q])=>`<button data-patient-mode="${mode}" data-patient-prompt="${esc(t(q))}" aria-pressed="${j.mode===mode}" ${busy}><small>${n}</small><strong>${t(title)}</strong><span>↗</span></button>`).join('')}</div>
  ${s.messages.length?`<nav class="patient-turns" aria-label="${t('Explanation history')}">${s.messages.map((m:Obj,i:number)=>m.role==='assistant'&&m.source!=='error'?`<button data-patient-turn="${i}" aria-pressed="${i===activeIndex}">${t(m.mode==='teachback'?'Understanding check':'Explanation')} ${Math.ceil(i/2)}</button>`:'').join('')}</nav>`:''}
  ${active?answerCard(active,activeIndex,s,h):`<div class="patient-invitation"><span class="patient-invitation-line"></span><h3>${t('What is on your mind?')}</h3><p>${t('You can say “Does this mean I am ill?” or “How do I explain this to my family?” I will help you understand this report without asking you to learn medical terms.')}</p><div class="patient-loop-preview"><span>${t('Your concern')}</span><b>→</b><span>${t('An explanation for you')}</span><b>→</b><span>${t('Your own words')}</span></div><small>${t('No model call until you send your question.')}</small></div>`}
  ${s.messages.at(-1)?.source==='error'?`<div class="notice error" role="alert">${esc(t(s.messages.at(-1).text))}<p>${t('Your question is kept below. No explanation was saved as successful.')}</p></div>`:''}
  <details class="patient-notebook" data-patient-detail="notebook" ${j.questions.length?'open':''}><summary>${t('My clarification list')} <span>${j.questions.length}/6</span></summary><p class="micro">${t('Session-only questions. The Agent checks a question only after you explicitly send it.')}</p>${j.questions.length?`<ol>${j.questions.map((q:string,i:number)=>`<li>${esc(q)}<button data-remove-patient-question="${i}" aria-label="${t('Remove question')}" ${busy}>×</button></li>`).join('')}</ol><button id="prepare-patient-request" class="quiet-button" ${busy}>${t('Prepare an Agent check')} →</button>`:`<p class="muted">${t('Save a useful follow-up from an explanation here.')}</p>`}</details>
  ${c.feedback.length?`<details class="patient-handoff" data-patient-detail="handoff"><summary>${t('Legacy clarification requests')} <span>${c.feedback.length}</span></summary><p class="micro">${t('Use tracked review tasks to request a response linked to your question.')}</p>${c.feedback.slice(-2).map((f:Obj)=>`<div class="patient-request-receipt"><span>${t('Awaiting clarification · v')}${f.reportRevision}</span><p>${esc(f.text)}</p></div>`).join('')}</details>`:''}</div></div>
  ${taskMode?patientTaskComposer(s,h):''}<div class="patient-composer" ${taskMode?'hidden':''}><div class="patient-anchor"><span>${t(j.mode==='teachback'?'CHECK MY UNDERSTANDING':'EXPLAIN WITH ME')}</span><small>${t('Anchored to')} <b>${esc(materialTitle(j.selected,h))}</b></small>${j.mode==='teachback'?`<button data-patient-mode="explain" class="text-button" ${busy}>${t('Back to questions')}</button>`:''}</div>
  <form id="question-form"><label for="patient-question">${t(j.mode==='teachback'?'In my own words, I think this means…':'What would you like to understand?')}</label><div class="patient-question-input"><textarea id="patient-question" maxlength="500" rows="2" required placeholder="${esc(t(j.mode==='teachback'?'Write your interpretation. The Agent checks it against this report, not a clinical diagnosis.':'Ask a question, or choose a starting point above.'))}">${esc(s.question)}</textarea><button class="primary" ${busy}>${t(j.mode==='teachback'?'Check understanding':'Explain')} →</button></div></form><p class="micro">${t('Explanations adapt. The published report and assessment do not change.')}</p></div></section></div>`;
}
function answerCard(a:Obj,index:number,s:Obj,h:Helpers){
  const {t,esc}=h,j=s.journey,question=s.messages[index-1]?.text||'',checked=a.mode==='teachback',marked=j.understood.includes(String(index));
  const labels:Record<string,string>={consistent:'Your interpretation matches the report',needs_clarification:'One distinction to clarify',not_enough_information:'The report cannot settle this interpretation',not_checked:'Grounded explanation'};
  return `<article class="patient-answer ${a.source==='safety'?'patient-safety':''}" aria-live="polite"><div class="patient-concern"><span>${t(checked?'MY UNDERSTANDING':'YOUR CONCERN')}</span><p>${esc(question)}</p></div><div class="patient-answer-main"><span class="eyebrow">${t(a.source==='safety'?'SAFETY GUIDANCE':checked?labels[a.understanding]||'Grounded explanation':'First, your question')}</span><p>${esc(a.explanation)}</p></div>${a.source!=='safety'?patientContextCard(a,h)+patientFollowUp(a,h)+patientCareSections(a,h)+patientResponseFocus(a,h):''}${a.limitation?`<p class="patient-specific-note">${esc(a.limitation)}</p>`:''}
  ${a.source!=='safety'?`<details class="patient-answer-receipt" data-patient-detail="receipt-${index}"><summary>${t('Explanation inputs & linked attachments')} · v${a.reportRevision}</summary>${a.basis?`<section class="patient-answer-basis"><h3>${t('What the published material says')}</h3><p>${esc(a.basis)}</p></section>`:''}<p>${t('The Agent received this published report and its attachments. Links below are model-selected, not verified sentence-level citations.')}</p>${(a.references||[]).map((id:string)=>`<button data-material="${esc(id)}" class="context-link">${esc(materialTitle(id,h))}</button>`).join('')}<small>${t('No unpublished expert proposals or other patients are used.')}</small></details>
  <div class="patient-answer-actions"><button id="patient-teachback" class="quiet-button" ${s.busy?'disabled':''}>${t('Let me explain it back')} →</button><button id="patient-simplify" class="text-button" ${s.busy?'disabled':''}>${t('Still unclear — simplify this')}</button><button data-understood="${index}" class="patient-understood" aria-pressed="${marked}" ${s.busy?'disabled':''}>${t(marked?'Marked clear by you':'This is clearer to me')}</button></div>
  <div class="patient-next-question"><span>${t('A useful next question')}</span><p>${esc(a.nextQuestion)}</p><button data-patient-mode="explain" data-patient-prompt="${esc(a.nextQuestion)}" class="quiet-button" ${s.busy?'disabled':''}>${t('Ask the Agent about this')} →</button><button data-save-patient-question="${esc(a.nextQuestion)}" class="text-button" ${j.questions.includes(a.nextQuestion)||j.questions.length>=6||s.busy?'disabled':''}>${t(j.questions.includes(a.nextQuestion)?'In my clarification list':'Add to my clarification list')} +</button></div>`:''}</article>`;
}

/** Synchronous transient view snapshot, scoped to one published report. */
export class PatientViewState{
  key='';scroll:number[]=[];details:Record<string,boolean>={};
  capture(root:ParentNode){const view=root.querySelector<HTMLElement>('.patient-studio');if(!view)return;
    this.scroll=['.patient-doc-scroll','.companion-scroll'].map(s=>root.querySelector(s)?.scrollTop||0);
    this.details=Object.fromEntries(Array.from(root.querySelectorAll<HTMLDetailsElement>('[data-patient-detail]')).map(d=>[d.dataset.patientDetail!,d.open]));}
  restore(root:ParentNode,key:string){if(this.key!==key){this.key=key;this.scroll=[];this.details={};return;}
    root.querySelectorAll<HTMLDetailsElement>('[data-patient-detail]').forEach(d=>{if(d.dataset.patientDetail! in this.details)d.open=this.details[d.dataset.patientDetail!];});
    ['.patient-doc-scroll','.companion-scroll'].forEach((s,i)=>{const el=root.querySelector(s);if(el)el.scrollTop=this.scroll[i]||0;});}
}
