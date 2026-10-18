// Pure presentation helpers. No clinical inference or changes to source predictions.
export const featureNames: Record<string, string> = {
  qrs_duration_ms: 'QRS duration', pr_interval_ms: 'PR interval', qrs_axis_deg: 'QRS axis',
  q_wave_v1v3_present: 'Q waves in V1–V3', pathological_q_wave_count_other_leads: 'Q waves in other leads',
  lvh_cornell_voltage_mm: 'Cornell voltage', lvh_sokolow_lyon_mm: 'Sokolow–Lyon voltage',
  lvh_romhilt_estes_partial_score: 'Partial voltage score', st_t_discordance_count: 'ST–T direction',
  qrs_amplitude_stats_mm: 'Lead amplitudes',
};
export const labelNames: Record<string, string> = {NORM:'No abnormal class in this task',MI:'Pattern associated with myocardial infarction',STTC:'ST or T-wave changes',CD:'Conduction disturbance',HYP:'Hypertrophy or overload pattern'};
export const metricSpecs: Record<string, {name:string; unit:string; threshold:number; feature:string}> = {
  'Q wave count':{name:'Q wave count',unit:'leads',threshold:1,feature:'pathological_q_wave_count_other_leads'},
  QRS:{name:'QRS duration',unit:'ms',threshold:120,feature:'qrs_duration_ms'},
  PR:{name:'PR interval',unit:'ms',threshold:200,feature:'pr_interval_ms'},
};
export function escapeHtml(v: unknown): string {return String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export function formatMeasurement(f: {value?:any;unit?:string}): string {
  const v=f.value;
  if(v==null)return 'Not measurable';
  if(typeof v==='number')return Number.isFinite(v)?`${Number(v.toFixed(2))} ${f.unit==='deg'?'°':f.unit||''}`.trim():'Not measurable';
  if(v.qrs_ms!=null)return `${v.qrs_ms} ms`;
  if(v.count!=null)return `${v.count} lead${v.count===1?'':'s'}`;
  if(v.present!=null)return v.present?'Detected':'Not detected';
  if(v.sokolow_index_mm!=null)return `${v.sokolow_index_mm} mm`;
  if(v.partial_score!=null)return `${v.partial_score} points`;
  return 'Per-lead values';
}
export function statusLabel(s:string):string {return ({normal:'Within reference',abnormal:'Outside reference',indeterminate:'Not assessable',not_applicable:'Not applicable'} as Record<string,string>)[s]||'Not available';}
export function criterionText(metric:string,op:string,threshold:number):string {
  const spec=metricSpecs[metric];
  if(!spec||!['>=','>','<=','<'].includes(op)||!Number.isFinite(threshold)||threshold<0||threshold>10000)throw new Error('Choose a supported measurement and a threshold from 0 to 10,000.');
  return `${metric} ${op} ${threshold} ${spec.unit}: needs review`;
}
export function previewCounts(rows:{matched:boolean|null}[]) {return {flagged:rows.filter(r=>r.matched===true).length,clear:rows.filter(r=>r.matched===false).length,unknown:rows.filter(r=>r.matched==null).length,total:rows.length};}
export function defaultCohort(selected:number,available:number[]):number[] {return [...new Set([selected,26,41,49,62,3919,1222])].filter(id=>available.includes(id)).slice(0,8);}
export function focusLead(feature:any,leads:string[]):string|null {
  const candidate=feature?.value?.lead_of_max||feature?.value?.leads?.[0]?.lead;
  return candidate?leads.find(l=>l.toLowerCase()===String(candidate).toLowerCase())||null:null;
}
export function validReview(labels:string[],note:string):string|null {
  if(!labels.length)return 'Select at least one demo review label.';
  if(labels.some(l=>!Object.hasOwn(labelNames,l)))return 'Unsupported review label.';
  if(labels.includes('NORM')&&labels.length>1)return 'NORM cannot be combined with an abnormal review label.';
  if(note.trim().length<10)return 'Add at least 10 characters describing observations and uncertainty.';
  return null;
}
