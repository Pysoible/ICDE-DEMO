type Obj=Record<string,any>;
type H={t:(s:string)=>string;esc:(s:any)=>string};
/** Application facts from this answer's snapshot, never a clinical safety score. */
export function patientContextCard(answer:Obj,h:H){
 const c=answer.patientContext;
 if(!c)return '';
 const names:Record<string,string>={chest_pain:'Chest pain',breathlessness:'Breathlessness',fainting:'Fainting',palpitations:'Palpitations',fatigue:'Fatigue',severe:'Severe symptoms'};
 const groups=[['reported','You described'],['denied','You explicitly denied'],['uncertain','Still unclear']] as const;
 const symptoms=Array.isArray(c.symptoms)?c.symptoms:[];
 const rows=groups.map(([status,title])=>{const entries=symptoms.filter((m:Obj)=>m.status===status&&names[m.name]);return entries.length?`<div class="patient-context-row"><small>${h.t(title)}</small><div>${entries.map((m:Obj)=>`<span title="${h.esc(m.quote)}">${h.t(names[m.name])}</span>`).join('')}</div></div>`:'';}).join('');
 const mismatch=c.reportClaim?.conflict===true;
 if(!rows&&!mismatch)return '';
 const labels=Array.isArray(c.report?.labels)?c.report.labels:[];
 const findings:Record<string,string>={NORM:'Normal category',CD:'Conduction-related finding',MI:'Infarction-related pattern',STTC:'Electrical recovery changes',HYP:'Hypertrophy-related pattern'};
 const report=labels.map((l:string)=>h.t(findings[l]||l)).join(' · ')||h.t('No labels attached');
 return `<section class="patient-context-card"><span class="eyebrow">${h.t('YOUR WORDS · CURRENT REPORT')}</span>${rows}<div class="patient-context-report"><small>${h.t('Published report')} · v${h.esc(c.report?.revision)}</small><p>${h.esc(report)}</p>${mismatch?`<p class="patient-report-mismatch">${h.t('Your description of the report differs from this published version. The explanation uses the findings above.')}</p>`:''}</div></section>`;
}
export function patientFollowUp(answer:Obj,h:H){
 if(!answer.followUpQuestion?.trim())return '';
 const draft=h.t('My reply to this question: ')+answer.followUpQuestion+'\n'+h.t('My additional details: ');
 return `<section class="patient-follow-up"><span>${h.t('ONE KEY DETAIL TO CLARIFY')}</span><p>${h.esc(answer.followUpQuestion)}</p><button class="text-button" data-patient-mode="prepare" data-patient-prompt="${h.esc(draft)}">${h.t('Add my answer')} →</button></section>`;
}
/** Display only the server-validated exact user quotes; no symptoms are inferred. */
export function patientResponseFocus(answer:Obj,h:H){
 const updates=Array.isArray(answer.contextUpdates)?answer.contextUpdates:[];
 if(!updates.length)return '';
 return `<section class="patient-response-focus"><span class="eyebrow">${h.t('YOUR INPUT → THIS ANSWER')}</span><h3>${h.t('How your input shaped the explanation')}</h3>${updates.map((u:Obj)=>`<div class="patient-focus-row"><blockquote><small>${h.t('You shared')}</small><p>${h.esc(u.quote)}</p></blockquote><span aria-hidden="true">→</span><div><small>${h.t('Agent focus')}</small><p>${h.esc(u.focus)}</p></div></div>`).join('')}</section>`;
}
/** Checks are completed application observations, not a simulated progress animation. */
export function patientCheckTrace(checks:Obj[],h:H){
 if(!checks?.length)return '';
 const names:Record<string,string>={read_report:'Report read',inspect_attachments:'Attachments checked',compare_publications:'Versions compared'};
 return `<nav class="patient-check-trace" aria-label="${h.t('Completed Agent actions')}">${checks.filter(c=>names[c.action]).map(c=>`<span><b aria-hidden="true">✓</b>${h.t(names[c.action])}<small>${h.esc(c.action==='read_report'?'v'+c.reportRevision:c.action==='inspect_attachments'?String(c.attachmentCount):c.available?h.t('Comparison available'):h.t('No earlier version'))}</small></span>`).join('')}</nav>`;
}
