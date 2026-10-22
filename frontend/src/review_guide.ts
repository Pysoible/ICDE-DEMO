// Reviewer-guided flow for the expert page. Each step is a real control or a saved state,
// derived only from the server record. Nothing here calls a model or changes data.
type Obj = Record<string, any>;
type Helpers = { t: (s: string) => string; esc: (s: any) => string };

export type GuideStep = { key: string; label: string; done: boolean; hint: string; action: string; target: string };

// Pure derivation: which steps are complete, and which one the expert should do next.
export function guideSteps(ctx: Obj | null | undefined): GuideStep[] {
  const rounds: Obj[] = ctx?.collaboration?.rounds ?? [];
  const r = rounds.at(-1);
  const published = ctx?.publishedReport?.reviewPolicy ?? null;
  return [
    { key: 'question', label: 'Raise a challenge', done: rounds.length > 0, hint: 'Ask a specific question about a rule or measurement.', action: 'Write question', target: 'expert-question' },
    { key: 'investigate', label: 'Agent checks', done: Boolean(r?.investigation), hint: 'The agent reads measurements and sources, then stops with a reason.', action: 'Delegate investigation', target: 'expert-question-form' },
    { key: 'replay', label: 'Replay & threshold', done: Boolean(r?.validation), hint: 'Drag the bounds. Counts update from the replayed records.', action: 'Open threshold lab', target: 'threshold-lab' },
    { key: 'adopt', label: 'Adopt', done: Boolean(r?.policy), hint: 'Validate the exact condition, then adopt it for this case only.', action: 'Go to decision', target: 'revision-actions' },
    { key: 'patient', label: 'Patient sees it', done: Boolean(published), hint: 'Publish a report; the patient view shows the same provenance.', action: 'Open patient view', target: 'patient' },
  ];
}

export function reviewGuide(ctx: Obj | null | undefined, h: Helpers): string {
  const { t, esc } = h;
  const steps = guideSteps(ctx);
  const current = steps.findIndex((s) => !s.done);
  const active = current === -1 ? steps.length - 1 : current;
  const s = steps[active];
  const pid = ctx?.sample?.ecgId;
  return `<nav class="review-guide" aria-label="${esc(t('Review guide'))}">
    <ol class="guide-steps">${steps.map((step, i) => `<li class="guide-step ${step.done ? 'done' : ''} ${i === active ? 'current' : ''}">
      ${step.key === 'patient' && step.done ? `<a href="/demo?role=patient&case=${esc(pid)}" class="guide-node">${i + 1}</a>` : `<button type="button" class="guide-node" data-guide-target="${esc(step.target)}" aria-current="${i === active ? 'step' : 'false'}">${i + 1}</button>`}
      <span class="guide-label">${esc(t(step.label))}</span></li>`).join('')}
    </ol>
    <p class="guide-hint"><b>${esc(t(current === -1 ? 'All steps complete' : 'Next'))}</b> ${esc(t(s.hint))}
      ${s.key === 'patient' && !s.done ? '' : `<button type="button" class="guide-go" data-guide-target="${esc(s.target)}">${esc(t(s.action))} →</button>`}</p>
  </nav>`;
}
