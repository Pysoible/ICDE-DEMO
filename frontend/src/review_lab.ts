// Presentation and preview helpers for the ICDE expert/patient demo.
// Counts mirror backend/harnessing_ts/review_policy.py. They are a live preview over records
// already replayed by the server; they never call a model, never change the saved receipt,
// and never adopt or publish a condition. Re-validation remains the only path to a receipt.
type Obj = Record<string, any>;
export type Bounds = { lower: number | null; upper: number | null; lowerInclusive: boolean; upperInclusive: boolean };
type Helpers = { t: (s: string) => string; esc: (s: any) => string; pretty?: (s: string) => string; value?: (f: any) => string };

// Units, backend value key and display domain for each measurement a review overlay may target.
export const METRIC_SPECS: Record<string, { key: string | null; unit: 'ms' | 'leads'; max: number }> = {
  qrs_duration_ms: { key: 'qrs_ms', unit: 'ms', max: 200 },
  pr_interval_ms: { key: null, unit: 'ms', max: 400 },
  pathological_q_wave_count_other_leads: { key: 'count', unit: 'leads', max: 6 },
};

export function boundsOf(c: Obj | null | undefined): Bounds | null {
  if (!c) return null;
  return { lower: c.lower ?? null, upper: c.upper ?? null, lowerInclusive: c.lowerInclusive ?? true, upperInclusive: c.upperInclusive ?? false };
}

export function scalarOf(name: string, raw: any): number | null {
  const spec = METRIC_SPECS[name];
  if (!spec) return null;
  const v = spec.key ? (raw && typeof raw === 'object' ? raw[spec.key] : null) : raw;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Mirrors review_policy.matches(): null when the measurement is missing.
export function boundMatch(b: Bounds, value: number | null): boolean | null {
  if (value == null || !Number.isFinite(value)) return null;
  const lowOk = b.lower == null || (b.lowerInclusive ? value >= b.lower : value > b.lower);
  const upOk = b.upper == null || (b.upperInclusive ? value <= b.upper : value < b.upper);
  return lowOk && upOk;
}

// Mirrors review_policy.replay_row(): only normal/abnormal original assessments are comparable.
export function labOutcomes(rows: Obj[], b: Bounds) {
  const perRow = rows.map((r) => {
    const comparable = r.originalStatus === 'normal' || r.originalStatus === 'abnormal';
    const matched = comparable ? boundMatch(b, r.value ?? null) : null;
    const outcome = matched ? 'changed' : matched === false ? 'unchanged' : 'not_assessable';
    return { ecgId: r.ecgId as number, value: (r.value ?? null) as number | null, outcome };
  });
  const count = (k: string) => perRow.filter((r) => r.outcome === k).length;
  return { changed: count('changed'), unchanged: count('unchanged'), not_assessable: count('not_assessable'), perRow };
}

const pct = (x: number, max: number) => (Math.min(max, Math.max(0, x)) / max * 100).toFixed(2);

function dynamicPart(rows: Obj[], b: Bounds, feature: string, h: Obj) {
  const { t, esc } = h;
  const spec = METRIC_SPECS[feature] ?? { key: null, unit: 'ms' as const, max: 200 };
  const unit = spec.unit === 'leads' ? t('leads') : 'ms';
  const res = labOutcomes(rows, b);
  const lo = b.lower ?? 0, hi = b.upper ?? spec.max;
  // Stack nearby markers into lanes so overlapping records remain individually clickable.
  const laneEnd: number[] = [];
  const dots = res.perRow.filter((r) => r.value != null).sort((a, b) => (a.value as number) - (b.value as number)).map((r) => {
    const x = Number(pct(r.value as number, spec.max));
    let lane = laneEnd.findIndex((end) => x - end >= 8);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(x); } else laneEnd[lane] = x;
    return `<button type="button" class="lab-dot ${r.outcome}" style="left:${x}%;--lane:${lane}" data-inspect-case="${r.ecgId}" title="ECG ${r.ecgId}: ${esc(r.value)} ${unit}">${r.ecgId}</button>`;
  }).join('');
  const missing = res.perRow.filter((r) => r.value == null).map((r) => `ECG ${r.ecgId}`);
  return {
    html: `<div class="lab-track" aria-hidden="true"><div class="lab-band" style="left:${pct(lo, spec.max)}%;width:${(Math.max(0, hi - lo) / spec.max * 100).toFixed(2)}%"></div><div class="lab-dots">${dots}</div><div class="lab-ticks"><span>0</span><span>${spec.max / 2}</span><span>${spec.max} ${unit}</span></div></div>
      <div class="lab-counts" role="status" aria-live="polite">
        <div class="changed"><b>${res.changed}</b><span>${t('Changed in preview')}</span></div>
        <div class="unchanged"><b>${res.unchanged}</b><span>${t('Unchanged')}</span></div>
        <div class="not_assessable"><b>${res.not_assessable}</b><span>${t('Not assessable')}</span></div>
      </div>
      ${missing.length ? `<p class="micro">${t('Missing measurement')}: ${missing.map((m) => esc(m)).join(', ')}</p>` : ''}`,
  };
}

const sameBounds = (a: Bounds | null, b: Bounds) => !!a && JSON.stringify(a) === JSON.stringify(b);
const stateText = (t: (s: string) => string, same: boolean) =>
  t(same ? 'Matches the validated condition.' : 'Differs from the validated condition. Run boundary tests & case replay before adopting.');

// Renders the whole lab. Sliders are created once, so a drag does not lose focus.
export function thresholdLabHtml(cfg: Obj): string {
  const { t, esc } = cfg;
  const spec = METRIC_SPECS[cfg.feature] ?? { key: null, unit: 'ms' as const, max: 200 };
  const unit = spec.unit === 'leads' ? t('leads') : 'ms';
  const same = sameBounds(cfg.validated, cfg.bounds);
  const label = (b: number | null) => (b == null ? t('No bound') : `${b} ${unit}`);
  const slider = (side: 'lower' | 'upper', b: number | null) => `<label class="lab-slider"><span>${t(side === 'lower' ? 'Lower bound' : 'Upper bound')} <output data-lab-out="${side}">${esc(label(b))}</output></span><input type="range" min="0" max="${spec.max}" step="1" value="${b ?? (side === 'lower' ? 0 : spec.max)}" data-lab-bound="${side}" ${cfg.locked ? 'disabled' : ''}/></label>`;
  return `<section class="lab" data-threshold-lab data-feature="${esc(cfg.feature)}">
    <div class="lab-head"><span class="eyebrow">${t('LIVE PREVIEW · NOT YET VALIDATED')}</span><b>${t('Threshold lab')}</b></div>
    <p class="micro">${t('Drag the bounds. Counts recompute from the records already replayed. No model call. Adoption still requires validation.')}</p>
    <div class="lab-dynamic">${dynamicPart(cfg.rows, cfg.bounds, cfg.feature, cfg).html}</div>
    <div class="lab-controls">${slider('lower', cfg.bounds.lower)}${slider('upper', cfg.bounds.upper)}</div>
    <p class="lab-state ${same ? 'same' : 'differs'}">${stateText(t, same)}</p>
  </section>`;
}

// Wires the sliders. onBoundsChange keeps the saved draft in step through the existing input handlers.
export function bindThresholdLab(root: HTMLElement, cfg: Obj) {
  const current: Bounds = { ...cfg.bounds };
  const unit = (METRIC_SPECS[cfg.feature]?.unit ?? 'ms') === 'leads' ? cfg.t('leads') : 'ms';
  root.querySelectorAll<HTMLInputElement>('[data-lab-bound]').forEach((el) => {
    el.oninput = () => {
      const side = el.dataset.labBound as 'lower' | 'upper';
      let v = Number(el.value);
      // Keep lower < upper: the band cannot invert.
      if (side === 'lower') { if (current.upper != null && v >= current.upper) v = current.upper - 1; current.lower = v; }
      else { if (current.lower != null && v <= current.lower) v = current.lower + 1; current.upper = v; }
      el.value = String(v);
      const out = root.querySelector<HTMLElement>(`[data-lab-out="${side}"]`);
      if (out) out.textContent = `${v} ${unit}`;
      const dyn = root.querySelector<HTMLElement>('.lab-dynamic');
      if (dyn) dyn.innerHTML = dynamicPart(cfg.rows, current, cfg.feature, cfg).html;
      const same = sameBounds(cfg.validated, current);
      const state = root.querySelector<HTMLElement>('.lab-state');
      if (state) { state.className = `lab-state ${same ? 'same' : 'differs'}`; state.textContent = stateText(cfg.t, same); }
      cfg.onBoundsChange({ ...current });
    };
  });
}

// Scale for the selected measurement: aggregate value plus any draft rule band.
// Not a per-beat annotation; the tool returns aggregates, not beat positions.
export function measurementScale(f: Obj | undefined, draft: Obj | null, h: Helpers): string {
  if (!f || !METRIC_SPECS[f.name]) return '';
  const { t, esc, pretty } = h;
  const spec = METRIC_SPECS[f.name];
  const unit = spec.unit === 'leads' ? t('leads') : 'ms';
  const v = scalarOf(f.name, f.value);
  const hasBand = !!draft && draft.feature === f.name && (draft.lower != null || draft.upper != null);
  const band = hasBand ? `<div class="scale-band" style="left:${pct(draft.lower ?? 0, spec.max)}%;width:${(Math.max(0, (draft.upper ?? spec.max) - (draft.lower ?? 0)) / spec.max * 100).toFixed(2)}%"></div>` : '';
  const marker = v != null
    ? `<div class="scale-marker" style="left:${pct(v, spec.max)}%"><span>${esc(v)} ${unit}</span></div>`
    : `<div class="scale-missing">${t('Measurement unavailable')}</div>`;
  return `<section class="surface measure-scale" aria-label="${t('Measurement scale')}">
    <div class="scale-head"><span class="eyebrow">${t('MEASUREMENT SCALE')}</span><b>${esc(pretty ? pretty(f.name) : f.name)}</b></div>
    <div class="scale-track">${band}${marker}<div class="scale-ticks"><span>0</span><span>${spec.max / 2}</span><span>${spec.max} ${unit}</span></div></div>
    <p class="micro">${hasBand ? t('Band: the rule band in your draft condition.') : t('No rule band yet. Propose or edit a condition to compare.')} ${t('Aggregate measurement, not per-beat positions.')}</p>
  </section>`;
}

// A saved, inspectable chain from the published statement back to the recorded signal.
export function provenanceChain(report: Obj, ctx: Obj, h: Helpers): string {
  const { t, esc, pretty, value } = h;
  const p = report.reviewPolicy as Obj | null | undefined;
  const feats: Obj[] = report.features || [];
  const node = (cls: string, title: string, sub: string, body: string) =>
    `<li class="prov-node ${cls}"><details><summary><span class="prov-title">${title}</span><small>${sub}</small></summary><div class="prov-body">${body}</div></details></li>`;
  const nodes: string[] = [
    node('record', `${t('Record')} · ECG ${esc(ctx.sample.ecgId)}`, t('Public PTB-XL record · read only'),
      `<p>${t('The waveform is not changed by review. Measurements are recomputed from the complete record.')}</p>`),
    node('measurements', `${feats.length} ${t('attached measurements')}`, t('Measurement tool output'),
      feats.length ? `<ul>${feats.map((f: Obj) => `<li>${esc(pretty ? pretty(f.name) : f.name)}: <b>${esc(value ? value(f) : '')}</b></li>`).join('')}</ul>` : `<p>${t('No measurements were attached.')}</p>`),
  ];
  if (p) {
    const c: Obj = p.candidate ?? {};
    const bounds = [c.lower == null ? '' : `${c.lowerInclusive ? '≥' : '>'} ${c.lower}`, c.upper == null ? '' : `${c.upperInclusive ? '≤' : '<'} ${c.upper}`].filter(Boolean).join(' ');
    const counts = p.counts ?? { changed: 0, unchanged: 0, not_assessable: 0 };
    const here = p.caseResult?.matched === true ? t('Needs review') : p.caseResult?.matched === false ? t('No additional flag for this record') : t('Not assessable');
    nodes.push(node('overlay', `${t('Review overlay')} v${esc(p.version)}`, `${esc(pretty && c.feature ? pretty(c.feature) : '')} ${esc(bounds)}`,
      `<p>${t('This record')}: ${here}</p><p>${t('Scope: this case only')} · ${t('Not a global tool update')}</p><p>${t('Original assessments unchanged')}</p>`));
    nodes.push(node('replay', t('Replay receipt'), `${(p.caseIds || []).length} ${t('cases replayed')}`,
      `<p>${t('New flags')}: <b>${counts.changed}</b> · ${t('Unchanged')}: <b>${counts.unchanged}</b> · ${t('Not assessable')}: <b>${counts.not_assessable}</b></p><p>${t('Validation ID')}: <code>${esc(p.validationId)}</code></p><p class="micro">${t('Boundary tests are synthetic values; case replay uses actual full-record measurements.')}</p>`));
  }
  nodes.push(node('report', `${t('Published report')} v${esc(report.revision)}`, t('Patients see only this published version'),
    `<p>${t('Counts describe the selected records only. They are not an accuracy or diagnosis claim.')}</p>`));
  return `<section class="surface prov-panel" aria-label="${t('Provenance')}"><span class="eyebrow">${t('PROVENANCE')}</span><h3>${t('From this statement to the recorded evidence')}</h3><ol class="prov-chain">${nodes.join('')}</ol><p class="micro">${t('Each step opens a saved record. Nothing here is recomputed for display.')}</p></section>`;
}
