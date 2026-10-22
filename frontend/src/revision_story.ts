import {fetchJson} from './api.ts';
// All comparison evidence is server-computed and tuning-only; no synthetic success cards.
type Obj=Record<string,any>;
type H={t:(s:string)=>string;esc:(s:any)=>string};
type Entry={loading:boolean;data?:Obj|null;error?:string;caseId?:number};
export const story={contextId:'',epoch:0,entries:{} as Record<string,Entry>};
export const storyContextId=()=>story.contextId;
export function resetStory(){story.epoch++;story.contextId='';story.entries={};}
export async function loadStory(base:string,contextId:string,itemId:string,force=false){
  if(story.contextId!==contextId){resetStory();story.contextId=contextId;}
  if(!force&&story.entries[itemId])return;
  const epoch=story.epoch,entry:Entry={loading:true};story.entries[itemId]=entry;
  try{
    const r=await fetchJson<Obj>(`${base}/revision/${encodeURIComponent(itemId)}/evidence`);
    if(epoch!==story.epoch||story.entries[itemId]!==entry)return;
    if(r.contextId!==contextId||r.itemId!==itemId)throw new Error('Case context changed. Refresh before continuing.');
    entry.data=r.evidence;entry.caseId=r.evidence?.examples?.[0]?.ecgId;
  }catch(e){if(epoch===story.epoch&&story.entries[itemId]===entry)entry.error=e instanceof Error?e.message:String(e);}
  finally{if(epoch===story.epoch&&story.entries[itemId]===entry)entry.loading=false;}
}
const num=(x:any)=>typeof x==='number'?`${Number(x.toFixed(4))===x?'':'≈'}${Number(x.toFixed(4))}`:'—';
const roles:Record<string,string>={broken:'Counterexample',fixed:'Supporting example',boundary:'Boundary example',focus:'Current case'};
const effects:Record<string,string>={broken:'No longer agrees with the dataset label',fixed:'Now agrees with the dataset label',unchanged:'No change for this record',unassessable:'Not assessable for this record'};
export function selectStoryCase(itemId:string,id:number){const e=story.entries[itemId];if(e?.data?.examples.some((x:Obj)=>x.ecgId===id))e.caseId=id;}
export function storyRefinement(itemId:string,h:H):string{
  const e=story.entries[itemId],d=e?.data,row=d?.examples.find((x:Obj)=>x.ecgId===e.caseId);
  if(!d||!row)return '';
  return `${h.t('Please refine the selected candidate using this tuning example, without changing the original prediction:')} ECG ${row.ecgId}; ${d.target}: ${row.before.includes(d.target)} → ${row.after.includes(d.target)}; ${h.t('Dataset label')}=${row.targetLabel}. ${row.checks.map((c:Obj)=>`${c.source==='prob'?`P(${c.name})`:c.name}=${c.observed??'missing'} (${c.op} ${c.value})`).join('; ')}. ${h.t('Check whether the available measurements can preserve the intended change while avoiding disagreement on this example. If not, explain the limitation; do not force a recommendation.')}`.slice(0,1000);
}
function conditionTable(f:Obj,h:H):string{
  const {t,esc}=h;
  return `<table class="story-checks"><thead><tr><th>${esc(t('Tested condition'))}</th><th>${esc(t('Observed'))}</th><th>${esc(t('Match'))}</th></tr></thead><tbody>${f.checks.map((c:Obj)=>`<tr><th><code>${esc(c.source==='prob'?`P(${c.name})`:c.name)}</code><small>${esc(c.op)} ${esc(c.value)}</small></th><td title="${esc(c.observed??'missing')}">${esc(num(c.observed))}</td><td class="${c.passes===true?'pass':c.passes===false?'fail':'unknown'}">${esc(t(c.passes===null?'Not assessable':c.passes?'Matches':'Does not match'))}</td></tr>`).join('')}</tbody></table>`;
}
export function storyFocusHtml(itemId:string,h:H):string{
  const e=story.entries[itemId];
  return e?.data?.focus?`<div class="story-focus"><span class="eyebrow">${h.esc(h.t('DATA FACTS · CURRENT CASE'))}</span>${conditionTable(e.data.focus,h)}<p class="micro">${h.esc(h.t('A matched condition is not a clinical diagnosis. Missing measurements keep the original assessment.'))}</p></div>`:'';
}
export function storyHtml(itemId:string,busy:boolean,h:H):string{
  const {t,esc}=h,e=story.entries[itemId];
  if(!e||e.loading)return `<p class="micro" role="status">${esc(t('Loading real comparison evidence…'))}</p>`;
  if(e.error)return `<div class="notice warning"><p>${esc(t('Comparison evidence could not be loaded. The saved feedback is unchanged.'))}</p><p>${esc(t(e.error))}</p><button type="button" data-story-retry="${esc(itemId)}">${esc(t('Retry evidence'))}</button></div>`;
  const d=e.data;if(!d)return '';
  const row=d.examples.find((x:Obj)=>x.ecgId===e.caseId)||d.examples[0];
  return `<section class="story-evidence"><span class="eyebrow">${esc(t('DATA FACTS · TUNING CASES'))}</span><h3>${esc(t('Where does this suggestion stop working?'))}</h3>${d.recommended===false?`<p class="notice warning">${esc(t('Showing the last tested candidate, not a recommendation. It cannot be adopted.'))}</p>`:''}<p class="story-counts">${esc(t('Counterexamples'))} <b>${esc(d.counts.broken)}</b> · ${esc(t('Supporting changes'))} <b>${esc(d.counts.fixed)}</b> · ${esc(t('Unchanged'))} ${esc(d.counts.unchanged)}</p>
    ${!d.counts.broken?`<p class="story-no-counter">${esc(t('No changed record in this comparison pool became less consistent with the weak label. This does not prove clinical validity.'))}</p>`:''}
    <div class="story-tabs" role="group" aria-label="${esc(t('Comparison cases'))}">${d.examples.map((x:Obj)=>`<button type="button" data-story-case="${esc(x.ecgId)}" data-story-item="${esc(itemId)}" aria-pressed="${row?.ecgId===x.ecgId}" class="${esc(x.role)}">${esc(t(roles[x.role]))}<b>ECG ${esc(x.ecgId)}</b></button>`).join('')}</div>
    ${row?`<article class="story-case ${esc(row.role)}"><div class="story-case-title"><b>${esc(t(roles[row.role]))} · ECG ${esc(row.ecgId)}</b><span>${esc(d.target)} ${esc(t('Dataset label'))}: ${esc(t(row.targetLabel?'Present':'Absent'))}</span></div><p><span>${esc(t('Original prediction'))}: ${esc(row.before.join(' + ')||t('No class'))}</span><br>→ ${esc(t('Expert-informed candidate'))}: <b>${esc(row.after.join(' + ')||t('No class'))}</b></p><p class="story-effect">${esc(t(effects[row.effect]))}</p>${conditionTable(row,h)}<button type="button" class="quiet-button" data-story-refine="${esc(itemId)}" ${busy?'disabled':''}>${esc(t('Ask Agent to refine using this example'))} →</button></article>`:`<p class="micro">${esc(t('No eligible comparison case is available.'))}</p>`}
    <details><summary>${esc(t('Where these examples come from'))}</summary><p class="micro">${esc(t('Real validation records from the tuning set, excluding the reviewed patient. Counts use the whole eligible pool, not the truncated change list. Changed witnesses use the lowest ECG ID; the unchanged witness is nearest to the numeric condition boundary. These are not clinically similar or representative patients.'))}</p><p class="micro">${esc(t('Not assessable'))}: ${esc(d.counts.unassessable)} · ${esc(t('Eligible records'))}: ${esc(d.eligibleN)}</p></details></section>`;
}
