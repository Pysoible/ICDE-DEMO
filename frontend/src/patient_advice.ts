type H={t:(s:string)=>string;esc:(s:any)=>string};
/** Optional education is distinct from case findings and is always escaped. */
export function patientCareSections(answer:Record<string,any>,h:H){
 const sections=[['symptoms','Possible symptoms & what to record'],['dailyCare','Rest & everyday habits'],['medication','Understanding medicines']];
 const used=sections.filter(([key])=>typeof answer[key]==='string'&&answer[key].trim());
 if(!used.length)return '';
 return `<section class="patient-care"><span class="patient-care-label">${h.t('GENERAL HEALTH INFORMATION')}</span>${used.map(([key,title])=>`<section class="patient-care-section" data-care-topic="${key}"><h3>${h.t(title)}</h3><p>${h.esc(answer[key])}</p></section>`).join('')}</section>`;
}
export function patientHealthStarters(h:H,busy:boolean){
 const topics=[
  ['Symptoms to watch for','What symptoms might be associated with these findings, and what should I record if they occur? Do not assume I have symptoms.'],
  ['How to rest','How should I arrange sleep, rest and everyday habits? Give practical general suggestions.'],
  ['Questions about medicines','Do these findings necessarily need medicine? Explain what medicine information would be useful before discussing it.'],
 ];
 return `<nav class="patient-health-topics" aria-label="${h.t('Everyday health questions')}">${topics.map(([title,q])=>`<button class="quiet-button" data-patient-mode="explain" data-patient-prompt="${h.esc(h.t(q))}" ${busy?'disabled':''}>${h.t(title)} →</button>`).join('')}</nav>`;
}
