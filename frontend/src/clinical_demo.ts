import type { JsonMap } from './types';

export const ECG_LABELS = ['NORM', 'MI', 'STTC', 'CD', 'HYP'] as const;
type ReviewStatus = 'draft' | 'approved';

export type ClinicalReview = {
  labels: string[];
  note: string;
  status: ReviewStatus;
  updatedAt: string;
};

const STORAGE_PREFIX = 'recursiveecg:clinical-demo:v1';
const descriptions: Record<string, string> = {
  NORM: 'No abnormal class detected in this five-class task',
  MI: 'ECG pattern associated with myocardial infarction',
  STTC: 'ST-segment or T-wave change',
  CD: 'Cardiac conduction disturbance',
  HYP: 'Pattern associated with chamber hypertrophy or overload',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}

function reviewKey(dataset: string, ecgId: number): string {
  return `${STORAGE_PREFIX}:${dataset}:${ecgId}`;
}

export function getClinicalReview(dataset: string, ecgId: number): ClinicalReview | null {
  try {
    const raw = localStorage.getItem(reviewKey(dataset, ecgId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClinicalReview;
    if (!Array.isArray(parsed.labels) || !parsed.labels.every((label) => ECG_LABELS.includes(label as typeof ECG_LABELS[number]))) return null;
    if (parsed.status !== 'draft' && parsed.status !== 'approved') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveClinicalReview(dataset: string, ecgId: number, form: HTMLFormElement, status: ReviewStatus): string {
  const data = new FormData(form);
  const labels = data.getAll('diagnosis').map(String).filter((label) => ECG_LABELS.includes(label as typeof ECG_LABELS[number]));
  const note = String(data.get('reviewNote') || '').trim();
  if (!labels.length) return 'Select at least one review label.';
  if (labels.includes('NORM') && labels.length > 1) return 'NORM cannot be selected with an abnormal class.';
  if (status === 'approved' && note.length < 10) return 'Write at least 10 characters of supporting notes before approval.';
  const review: ClinicalReview = { labels, note, status, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(reviewKey(dataset, ecgId), JSON.stringify(review));
  } catch {
    return 'The browser could not save this local review. Check storage access.';
  }
  return status === 'approved' ? 'Review approved in this browser; dataset labels and model scores are unchanged.' : 'Review draft saved in this browser.';
}

export function renderClinicalReview(sample: JsonMap | null, dataset: string): string {
  if (!sample) return '<p class="clinical-empty">Select a case to enter a review.</p>';
  const ecgId = Number(sample.ecgId);
  const review = getClinicalReview(dataset, ecgId);
  const selected = review?.labels || [];
  return `<form class="clinical-review-form" id="clinicalReviewForm">
    <div class="clinical-review-heading"><strong>Clinical review</strong><span class="clinical-demo-badge">Local prototype</span></div>
    <p class="clinical-help">Model scores and dataset labels are read-only. Review notes do not change training data.</p>
    <div class="clinical-original"><span>Model prediction</span><strong>${escapeHtml((sample.predicted || []).join(' + ') || 'NONE')}</strong></div>
    <fieldset><legend>Review labels</legend><div class="clinical-label-grid">${ECG_LABELS.map((label) => `<label><input type="checkbox" name="diagnosis" value="${label}" ${selected.includes(label) ? 'checked' : ''}/><span>${label}</span></label>`).join('')}</div></fieldset>
    <label class="clinical-note-label" for="clinicalReviewNote">Review notes and evidence</label>
    <textarea id="clinicalReviewNote" name="reviewNote" rows="4" placeholder="Record waveform observations and supporting evidence">${escapeHtml(review?.note || '')}</textarea>
    <div class="clinical-review-status">${review ? `${review.status === 'approved' ? 'Approved' : 'Draft'} · ${escapeHtml(new Date(review.updatedAt).toLocaleString('en-US'))}` : 'No review yet'}</div>
    <div class="clinical-review-actions"><button type="submit" data-review-action="draft" class="secondary">Save draft</button><button type="submit" data-review-action="approved">Approve review</button></div>
    <p id="clinicalReviewMessage" class="clinical-review-message" role="status"></p>
  </form>`;
}

export function renderPatientReport(sample: JsonMap | null, dataset: string): string {
  if (!sample) return '<p class="patient-empty">No cases are available.</p>';
  const review = getClinicalReview(dataset, Number(sample.ecgId));
  const approved = review?.status === 'approved';
  const labels = approved ? review.labels : (sample.predicted || []).filter((label: string) => ECG_LABELS.includes(label as typeof ECG_LABELS[number]));
  const labelText = labels.length ? labels.map((label: string) => `${label}: ${descriptions[label]}`).join('; ') : 'the model produced no definite class label';
  return `<div class="patient-report-status ${approved ? 'approved' : ''}">${approved ? 'Demo review approved' : 'Preliminary model result · Not reviewed by a clinician'}</div>
    <h3>ECG result explanation</h3>
    <p>Five-class output for this case: ${escapeHtml(labelText)}.</p>
    <p>${approved ? 'This report uses review labels saved in this browser.' : 'This model output is for demonstration and is not a clinical report.'}</p>
    ${approved && review.note ? `<div class="patient-review-note"><strong>Review note</strong><p>${escapeHtml(review.note)}</p></div>` : ''}
    <p class="patient-safety-note">ECG findings need clinical context. Seek urgent care for chest pain, breathing difficulty, or fainting.</p>`;
}
