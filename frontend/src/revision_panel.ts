// Expert opinion -> revised judgment. Rendering plus thin API glue; every number comes from the server.
// The revised judgment is an expert-informed CANDIDATE shown beside the original prediction. It never
// replaces the original, is never published here, and agreement with a dataset label is not clinical correctness.
import {fetchJson,postJson} from './api.ts';
import {resetStory,loadStory,storyHtml,storyFocusHtml,storyContextId} from './revision_story.ts';

type Obj=Record<string,any>;
type H={t:(s:string)=>string;esc:(s:any)=>string};

export const rev={items:[] as Obj[],revision:0,status:null as Obj|null,draft:'',loaded:false,selectedId:'',sourceReportRevision:null as number|null};

export function resetRevision(){rev.items=[];rev.revision=0;rev.status=null;rev.loaded=false;rev.draft='';rev.selectedId='';rev.sourceReportRevision=null;resetStory();}
export const latestRevision=()=>rev.items.at(-1) as Obj|undefined;
export const selectedRevision=()=>rev.items.find(i=>i.id===rev.selectedId)||latestRevision();
export const adoptedRevision=()=>[...rev.items].reverse().find(i=>i.decision==='adopted');

export async function loadRevision(base:string,contextId:string){
  const r=await fetchJson<Obj>(base+'/revision');
  if(r.contextId!==contextId)throw new Error('Case context changed. Refresh before continuing.');
  rev.items=r.items;rev.revision=r.revision;rev.status=r.status;rev.loaded=true;
  const item=selectedRevision();if(item)await loadStory(base,contextId,item.id,true);
}
export async function submitRevision(base:string,contextId:string){
  const r=await postJson<Obj>(base+'/revision',{contextId,expectedRevision:rev.revision,message:rev.draft.trim(),reportRevision:rev.sourceReportRevision,parentId:selectedRevision()?.id||null});
  rev.items=r.items;rev.revision=r.revision;rev.draft='';rev.selectedId=r.items.at(-1)?.id||'';rev.sourceReportRevision=null;
  if(rev.selectedId)await loadStory(base,contextId,rev.selectedId,true);
}
export async function decideRevision(base:string,contextId:string,itemId:string,decision:'adopted'|'rejected'){
  const r=await postJson<Obj>(base+'/revision/decision',{contextId,expectedRevision:rev.revision,itemId,decision});
  rev.items=r.items;rev.revision=r.revision;
}

// Library badge: only for the latest revision that was not rejected and has a recommended candidate.
export function revisionFlag(ecgId:number):'fixed'|'broken'|null{
  const it=latestRevision();
  if(!it||it.decision==='rejected')return null;
  const f=it.result?.evaluation?.flips?.find((x:Obj)=>x.ecgId===ecgId&&x.set==='tuning');
  return f?f.effect:null;
}

const f3=(x:any)=>typeof x==='number'?x.toFixed(3):'—';
const VERDICT:Record<string,string>={gain:'Improved',loss:'Worse',neutral:'Net unchanged',mixed:'Mixed',no_change:'No change'};

export function describeCandidate(c:Obj|null|undefined,h:H):string{
  if(!c)return '';
  const {t,esc}=h;
  if(c.kind==='threshold')return `${esc(c.target)}: ${esc(t('decision threshold becomes'))} <b>${esc(c.theta)}</b>`;
  const parts=(c.conditions||[]).map((x:Obj)=>`${x.source==='prob'?`P(${esc(x.name)})`:`<code>${esc(x.name)}</code>`} ${esc(x.op)} ${esc(x.value)}`);
  return `${esc(t('When'))} ${parts.join(` ${esc(t('and'))} `)} → ${esc(t(c.action==='add_label'?'add the label':'remove the label'))} <b>${esc(c.target)}</b>`;
}

function chips(list:string[],h:H,cls=''):string{
  return list.length?list.map(x=>`<span class="rv-chip ${cls}">${h.esc(x)}</span>`).join(''):`<span class="micro">${h.esc(h.t('No class'))}</span>`;
}

function focusBlock(result:Obj,h:H):string{
  const {t,esc}=h;
  const f=result.focus,b=result.focusBaseline;
  if(!b)return '';
  const before:string[]=f?f.before:b.predicted,after:string[]=f?f.after:b.predicted;
  const removed=before.filter(x=>!after.includes(x)),added=after.filter(x=>!before.includes(x));
  const effect=f?.effect;
  const effectText=effect==='fixed'?'Now agrees with the dataset label':effect==='broken'?'No longer agrees with the dataset label':effect==='unassessable'?'Not assessable for this record':'No change for this record';
  return `<div class="rv-focus">
    <div><span>${esc(t('Dataset label'))}</span>${chips(b.truth,h)}</div>
    <div><span>${esc(t('Original prediction'))}</span>${chips(before,h)}</div>
    <div><span>${esc(t('Expert-informed candidate'))}</span>${f?chips(after,h,'cand'):`<span class="micro">${esc(t('No candidate was recommended.'))}</span>`}</div>
    ${f?`<div class="rv-effect ${esc(effect)}">${esc(t(effectText))}${removed.length?` · ${esc(t('removed'))}: ${esc(removed.join(', '))}`:''}${added.length?` · ${esc(t('added'))}: ${esc(added.join(', '))}`:''}</div>`:''}
  </div>`;
}

function subsetTable(ev:Obj,target:string,h:H):string{
  const {t,esc}=h;
  const row=(k:string)=>{
    const s=ev.subsets[k],v=ev.verdict?.[k];
    return `<tr><th scope="row">${esc(t('Tuning set'))}</th><td>${esc(s.n)}</td><td class="fixed">${esc(s.fixed)}</td><td class="broken">${esc(s.broken)}</td>
      <td>${f3(s.baseline.f1)} → ${f3(s.revised.f1)}</td><td>${f3(s.macroF1.baseline)} → ${f3(s.macroF1.revised)}</td><td>${esc(s.unassessable)}</td>
      <td>${v?`<span class="rv-verdict ${esc(v)}">${esc(t(VERDICT[v]))}</span>`:''}</td></tr>`;
  };
  return `<table class="rv-table"><thead><tr><th></th><th>${esc(t('Records'))}</th><th>${esc(t('Now agree'))}</th><th>${esc(t('No longer agree'))}</th><th>${esc(target)} F1</th><th>${esc(t('Macro F1'))}</th><th>${esc(t('Not assessable'))}</th><th></th></tr></thead><tbody>${row('tuning')}</tbody></table>
    <p class="micro">${esc(t('Tuning results only; not independent generalization validation.'))}</p>`;
}

function attempts(result:Obj,h:H):string{
  const {t,esc}=h;
  if(!result.attempts?.length&&!result.rejected?.length)return '';
  const items=(result.attempts as Obj[]).map(a=>{
    const tu=a.subsets.tuning;
    return `<li class="${a.chosen?'chosen':''}"><div>${describeCandidate(a.candidate,h)}${a.chosen?` <b class="rv-picked">${esc(t('Recommended'))}</b>`:''}</div>
      <div class="micro">${esc(t('Tuning set'))}: +${tu.fixed} / −${tu.broken} · <span class="rv-verdict ${esc(a.verdict.tuning)}">${esc(t(VERDICT[a.verdict.tuning]))}</span></div>
      ${a.reason?`<div class="micro">${esc(t('Agent note'))}: ${esc(a.reason)}</div>`:''}</li>`;
  }).join('');
  const rej=(result.rejected||[]).length?`<li class="rejected micro">${esc((result.rejected as Obj[]).length)} ${esc(t('candidate(s) were rejected by the application as invalid and corrected.'))}</li>`:'';
  return `<details class="rv-attempts"><summary>${esc(t('What the agent tried'))} · ${(result.attempts||[]).length}</summary><ol>${items}${rej}</ol></details>`;
}

function flipList(ev:Obj,h:H):string{
  const {t,esc}=h;
  const count=ev?.subsets?.tuning?.changed||0;
  if(!count)return `<p class="micro">${esc(t('No record changed.'))}</p>`;
  const shown=(ev.flips as Obj[]).filter(f=>f.set==='tuning').slice(0,60);
  return `<div class="rv-flips">${shown.map(f=>`<button type="button" class="rv-flip ${esc(f.effect)}" data-inspect-case="${esc(f.ecgId)}" title="${esc(t(f.effect==='fixed'?'Now agrees with the dataset label':'No longer agrees with the dataset label'))}">ECG ${esc(f.ecgId)} · ${esc(t('Tuning set'))}</button>`).join('')}</div>
    <p class="micro">${esc(count)} ${esc(t('records changed'))} · ${esc(t('Tuning set'))}${count>shown.length?` · ${esc(shown.length)} ${esc(t('shown'))}`:''} · ${esc(t('Regressions are listed first.'))}</p>`;
}

function lineageBlock(item:Obj,h:H):string{
  const parent=rev.items.find(i=>i.id===item.parentId);if(!parent)return '';
  const {t,esc}=h,a=parent.result,b=item.result;
  const same=a.dataInfo?.inputFingerprint===b.dataInfo?.inputFingerprint;
  const counts=(r:Obj)=>{const s=r.evaluation?.subsets?.tuning;return s?`${esc(t('Now agree'))} +${esc(s.fixed)} / ${esc(t('No longer agree'))} −${esc(s.broken)}`:esc(t('No candidate was recommended.'));};
  return `<details class="story-lineage"><summary>${esc(t('What changed since the selected feedback?'))}</summary><p><b>${esc(t('Previous candidate'))}</b><br>${describeCandidate(a.candidate,h)||esc(t('No candidate was recommended.'))}</p><p><b>${esc(t('Current candidate'))}</b><br>${describeCandidate(b.candidate,h)||esc(t('No candidate was recommended.'))}</p>${same?`<p class="micro">${esc(t('Tuning set'))}: ${counts(a)} → ${counts(b)}</p>`:`<p class="micro">${esc(t('Input versions differ; no direct metric comparison is shown.'))}</p>`}<p class="micro">${esc(t('Both candidates are evaluated against the same original baseline, not applied on top of each other.'))}</p></details>`;
}

function testReceipt(r:Obj,h:H):string{
  const {t,esc}=h,attempts=r.attempts||[],s=r.evaluation?.subsets?.tuning||attempts.at(-1)?.subsets?.tuning;
  if(!s)return `<p class="micro">${esc(t('No candidate was executed in this round. Model text is not an execution receipt.'))}</p>`;
  return `<div class="story-receipt"><span class="eyebrow">${esc(t('TEST RECEIPT · APPLICATION COMPUTED'))}</span><p>${esc(t('Tuning set'))} · ${esc(t('New weak-label agreement'))} <b>+${esc(s.fixed)}</b> / ${esc(t('New weak-label disagreement'))} <b>−${esc(s.broken)}</b></p><small>${esc(attempts.length)} ${esc(t('candidate(s) actually tested'))} · ${esc(t('Not assessable'))}: ${esc(s.unassessable)}${!r.candidate?` · ${esc(t('Last tested candidate, not recommended'))}`:''}</small></div>`;
}


export function revisionHtml(busy:boolean,h:H,report?:Obj):string{
  const {t,esc}=h;
  const st=rev.status;
  const item=selectedRevision(),r=item?.result,latest=latestRevision(),ev=r?.evaluation;
  const blocked=Boolean(st&&(!st.available||st.inValidationSet===false));
  const unavailable=st&&!st.available?`${t('The revision test is not available')}: ${st.reason}`:t('This record is outside the validation set, so a revision cannot be tested on it.');
  const head=(n:string,title:string,sub:string)=>`<header class="feedback-heading"><span class="eyebrow">${n}</span><h2>${esc(t(title))}</h2><p>${esc(t(sub))}</p></header>`;
  const cards=[...rev.items].reverse().map((i:Obj)=>`<button type="button" class="feedback-report ${i.id===item?.id?'selected':''}" data-rv-open="${esc(i.id)}" ${busy?'disabled':''}><span>${esc(t('Expert report'))} ${rev.items.indexOf(i)+1} · ${esc(t(i.decision==='adopted'?'Adopted':i.decision==='rejected'?'Rejected':'Pending'))}</span><p>${esc(i.opinion)}</p><small>${esc(t('Click to inspect its adjustment and impact'))}</small></button>`).join('');
  const form=blocked?`<p class="notice warning">${esc(unavailable)}</p>`:`<label for="rev-draft">${esc(t('Adjustment request for Agent'))}</label><textarea id="rev-draft" rows="3" maxlength="1000" placeholder="${esc(t('Describe what should change and why. The agent will test a threshold or criterion, not just acknowledge your feedback.'))}" ${busy?'disabled':''}>${esc(rev.draft)}</textarea>${rev.sourceReportRevision?`<span class="micro">${esc(t('Based on saved report'))} v${rev.sourceReportRevision}</span>`:''}<button type="button" class="primary" id="rev-submit" ${busy?'disabled':''}>${esc(t('Apply feedback & re-analyze'))} →</button>`;
  let proposal=`<div class="feedback-empty"><h3>${esc(t('Your expertise becomes a testable adjustment'))}</h3><p>${esc(t('The agent reads your feedback and evidence, proposes a criterion from a closed set, evaluates it, and refines it from actual results.'))}</p><p class="micro">${esc(t('Supported now: class thresholds and measurement/probability criteria. No model retraining or generated code.'))}</p></div>`;
  if(r){
    const rule=r.candidate?`<div class="rv-rule">${describeCandidate(r.candidate,h)}</div>`:r.stopReason==='cannot_express'?`<div class="rv-none"><b>${esc(t('The available measurements cannot express this opinion.'))}</b><p>${esc(r.missing)}</p><p class="micro">${esc(t('It is recorded as a need for a future full iteration, not approximated.'))}</p></div>`:`<div class="rv-none"><b>${esc(t('The system does not recommend a change.'))}</b><p>${esc(t(r.notice||''))}</p></div>`;
    const before=r.candidate?.kind==='threshold'&&r.frozenThresholds?`<p class="micro">${esc(t('Original threshold'))}: ${esc(r.frozenThresholds[r.candidate.target])} → ${esc(r.candidate.theta)}</p>`:'';
    proposal=`<blockquote class="rv-quote">${esc(item!.opinion)}</blockquote>${item!.parentId?`<p class="feedback-continuation">${esc(t('Continues the previous feedback with its candidate and test observations.'))}</p>`:''}<h3>${esc(t('Criterion proposed by the system'))}</h3>${rule}${before}${lineageBlock(item!,h)}${r.candidate?`<button type="button" class="text-button" data-story-correct="${esc(item!.id)}" ${busy?'disabled':''}>${esc(t('Not what I meant — correct the interpretation'))}</button>${storyFocusHtml(item!.id,h)}`:''}${testReceipt(r,h)}${r.explanation?`<details class="rv-reply"><summary>${esc(t('AGENT EXPLANATION · MODEL TEXT'))}</summary><p>${esc(r.explanation)}</p><small>${esc(t('Model text may be inaccurate. Use the independently computed condition checks and counts to verify it.'))}</small></details>`:''}${attempts(r,h)}<details class="feedback-evidence"><summary>${esc(t('Measurements used for this review'))}</summary>${Object.entries(r.focusBaseline?.measurements||{}).map(([k,v])=>`<p><code>${esc(k)}</code> <b>${esc(v)}</b></p>`).join('')}</details><p class="micro">${esc(t('Each feedback is re-evaluated against the original baseline; earlier candidates are not silently stacked.'))}</p>`;
  }
  let decision=`<span class="micro">${esc(t('You confirm the result. Publication remains a separate action.'))}</span>`;
  if(item){
    if(item.id===latest?.id&&item.decision==='pending')decision=`${r.candidate?`<button type="button" class="primary" data-rv-decide="adopted" data-rv-item="${esc(item.id)}" ${busy?'disabled':''}>${esc(t('Confirm updated demo assessment'))} →</button>`:''}<div class="feedback-decision-pair"><button type="button" class="text-button" data-rv-followup="${esc(item.id)}" ${busy?'disabled':''}>${esc(t('Refine this feedback'))}</button><button type="button" class="text-button" data-rv-decide="rejected" data-rv-item="${esc(item.id)}" ${busy?'disabled':''}>${esc(t(r.candidate?'Reject':'Dismiss'))}</button></div>`;
    else if(item.decision==='adopted'){
      const published=report?.publishedReport?.revisionItemId===item.id,linked=report?.review?.revisionItemId===item.id;
      decision=`<p class="micro">${esc(t('Adopted'))} v${esc(item.adoption?.version)} · ${published?`${esc(t('Published as report v'))}${esc(report!.publishedReport.revision)}`:esc(t('Updated demo assessment recorded; nothing is published yet.'))}</p>${linked?`<button type="button" class="primary" data-rv-report ${busy?'disabled':''}>${esc(t('Open linked report'))} →</button>`:`<button type="button" class="primary" data-rv-draft="${esc(item.id)}" ${busy?'disabled':''}>${esc(t('Generate patient report from this assessment'))} →</button>`}`;
    }
    else decision=`<p class="micro">${esc(t(item.decision==='rejected'?'Rejected. Nothing was changed.':'A newer feedback report is awaiting your decision.'))}</p>`;
  }
  const impact=r?`${focusBlock(r,h)}${storyHtml(item!.id,busy,h)}${ev?`<div class="feedback-score"><span>${esc(t('Tuning set'))} · ${esc(ev.subsets.tuning.n)}</span><strong class="rv-verdict ${esc(ev.verdict.tuning)}">${esc(t(VERDICT[ev.verdict.tuning]))}</strong><p>${esc(t('Now agree'))} <b>+${ev.subsets.tuning.fixed}</b> · ${esc(t('No longer agree'))} <b>−${ev.subsets.tuning.broken}</b></p><small>${esc(r.candidate.target)} F1 ${f3(ev.subsets.tuning.baseline.f1)} → ${f3(ev.subsets.tuning.revised.f1)}</small><p class="micro">${esc(t('Tuning results only; not independent generalization validation.'))}</p></div><details><summary>${esc(t('Effect on the tuning records'))}</summary><div class="feedback-table-scroll">${subsetTable(ev,r.candidate.target,h)}</div>${flipList(ev,h)}</details>`:''}<p class="micro">${esc(t('Dataset labels are weak labels. Agreement is not a clinical diagnosis.'))}</p>`:`<div class="feedback-empty"><h3>${esc(t('See what your feedback changes'))}</h3><p>${esc(t('Original assessment → updated assessment. Added and removed labels will be highlighted here.'))}</p></div>`;
  return `<div class="feedback-layout" id="revision-panel" data-feedback-scope="${esc(storyContextId()+':'+(item?.id||'empty'))}"><section class="surface feedback-column">${head('01 · EXPERT','Your feedback reports','Give the goal. Let the agent do the checking.')}<div class="feedback-scroll">${cards||`<div class="feedback-empty"><h3>${esc(t('An expert is a user, not an annotator'))}</h3><p>${esc(t('State your concern, inspect the response, and decide whether the change is useful.'))}</p></div>`}</div><div class="feedback-composer">${form}</div></section><section class="surface feedback-column">${head('02 · AGENT','What the agent adjusted','A concrete criterion, actual tests, and an explanation.')}<div class="feedback-scroll">${proposal}</div><footer class="feedback-foot">${st?.available?`${esc(t('Tuning set'))} ${st.tuningN}`:esc(t('Evidence is required before an adjustment can be tested.'))}</footer></section><section class="surface feedback-column">${head('03 · IMPACT','Before & after your feedback','Inspect the change, then confirm or refine.')}<div class="feedback-scroll">${impact}</div><div class="feedback-actions">${decision}</div></section></div>`;
}

export function feedbackImpactHtml(snapshot:Obj|null|undefined,h:H,saved=true):string{
  if(!snapshot)return '';
  const {t,esc}=h;
  return `<details class="report-policy feedback-snapshot"><summary>${esc(t(saved?'Expert feedback · saved changes':'Expert feedback · draft changes'))}</summary><blockquote>${esc(snapshot.opinion)}</blockquote><p>${describeCandidate(snapshot.candidate,h)}</p>${snapshot.focus?`<p>${esc(t('Original prediction'))}: ${esc(snapshot.focus.before.join(' + '))} → ${esc(t('Updated demo assessment'))}: ${esc(snapshot.focus.after.join(' + '))}</p>`:''}<small>${esc(t(saved?'Saved report snapshot; later feedback does not rewrite this report.':'Feedback selected for this draft; saved only when you save or publish the report.'))}</small></details>`;
}
