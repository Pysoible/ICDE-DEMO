// A receipt of executed actions, not hidden chain-of-thought or simulated progress.
type Obj=Record<string,any>;
export function invalidateAgentAssessment(root:ParentNode){
  const assessment=root.querySelector<HTMLElement>('.agent-assessment');
  if(assessment)assessment.hidden=true;
  const notice=root.querySelector<HTMLElement>('.agent-assessment-stale');
  if(notice)notice.hidden=false;
}
export function agentTrace(r:Obj|undefined,h:{t:(s:string)=>string;esc:(s:any)=>string;pretty:(s:string)=>string}){
  const {t,esc,pretty}=h,a=r?.investigation;
  if(!a)return '';
  const names:Obj={review_evidence:'Inspect measurement rules',audit_sources:'Inspect attached sources',rerun_measurements:'Re-execute measurement tool'};
  const stops:Obj={finish:'Investigation complete',ask_expert:'Expert clarification needed',tool_budget:'Check budget reached',duplicate_check:'Repeated check prevented'};
  return `<div class="agent-trace"><div class="agent-trace-heading"><span class="eyebrow">${t('AGENT ACTION RECEIPT')}</span><span>${(a.trace||[]).length} / ${a.maxToolCalls}</span></div><p class="micro">${t('Next checks were selected after reading the preceding results.')}</p><ol class="agent-timeline">${(a.trace||[]).map((step:Obj,i:number)=>`<li class="agent-tl-item" style="--i:${i}"><details class="agent-step"><summary><span>${step.step}</span><b>${esc(t(names[step.action]||step.action))}</b><small>${esc(step.focus?pretty(step.focus):t('Whole case'))}</small></summary><p>${esc(step.reason)}</p><div class="agent-observation">${step.observation.cacheBypassed?`<p>${t('Measurement values changed')}: ${step.observation.measurementChanges.length}</p>`:''}${(step.observation.measurements||[]).map((m:Obj)=>`<p><b>${esc(pretty(m.name))}</b><code>${esc(typeof m.value==='object'?JSON.stringify(m.value):m.value??'—')}</code></p>`).join('')}${step.observation.implementationExcerpt?`<details><summary>${t('Extractor field mapping')}</summary><code>${esc(step.observation.implementationExcerpt.path)}<br>${step.observation.implementationExcerpt.lines.map((l:Obj)=>esc(l.line+': '+l.code)).join('<br>')}</code></details>`:''}${step.observation.sourcesChecked?`<p>${t('Attached excerpts')}: ${(step.observation.sources||[]).length} · ${t('Available source files')}: ${(step.observation.sources||[]).filter((s:Obj)=>s.available).length}</p>`:''}</div></details></li>`).join('')}<li class="agent-tl-stop" style="--i:${(a.trace||[]).length}"><div class="agent-stop"><b>${t(stops[a.stopReason]||'Investigation complete')}</b>${a.stopExplanation?`<p>${esc(a.stopExplanation)}</p>`:''}${a.question?`<p>${esc(a.question)}</p><button class="text-button" data-expert-prompt="${esc(t('My clarification about')+': '+a.question+'\n')}">${t('Discuss this missing information')} →</button>`:''}</div></li></ol></div>`;
}

export function agentAssessment(r:Obj|undefined,dirty:boolean,h:{t:(s:string)=>string;esc:(s:any)=>string}){
  const {t,esc}=h,a=r?.investigation,v=r?.validation;
  if(!a?.replayAssessment)return '';
  if(dirty||a.assessmentValidationId!==v?.id)return `<p class="micro agent-assessment-stale">${t('The agent assessment belongs to the earlier replay, not your edited condition.')}</p>`;
  const x=a.replayAssessment,labels:Obj={retain_for_review:'Retained for expert review',withhold:'Recommendation withheld',ask_expert:'Expert clarification needed'};
  return `<p class="micro agent-assessment-stale" hidden>${t('The agent assessment belongs to the earlier replay, not your edited condition.')}</p><div class="agent-assessment"><span class="eyebrow">${t('AFTER REPLAY · AGENT REASSESSMENT')}</span><h3>${t(labels[x.recommendation])}</h3><p class="agent-assessment-brief">${esc(x.explanation)}</p><details><summary>${t('Read reassessment')}</summary><p>${esc(x.explanation)}</p></details>${x.question?`<button class="text-button" data-expert-prompt="${esc(t('My clarification about')+': '+x.question+'\n')}">${esc(x.question)}</button>`:''}<p class="micro">${t('Assessment of the selected replay, not clinical validation. You decide whether to adopt.')}</p></div>`;
}
