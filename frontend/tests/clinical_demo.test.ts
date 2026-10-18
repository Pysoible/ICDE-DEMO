import {describe, expect, test} from 'bun:test';
import {getClinicalReview, renderPatientReport} from '../src/clinical_demo';

const entries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {value: {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
}});

describe('patient-facing demonstration boundaries', () => {
  test('unreviewed model output is not presented as an approved diagnosis', () => {
    entries.clear();
    const report = renderPatientReport({ecgId: 17, predicted: ['MI']}, 'ptbxl');
    expect(report).toContain('Not reviewed by a clinician');
    expect(report).toContain('not a clinical report');
    expect(report).not.toContain('Demo review approved');
  });

  test('approved local review replaces model labels without exposing raw HTML', () => {
    entries.clear();
    entries.set('recursiveecg:clinical-demo:v1:ptbxl:17', JSON.stringify({
      labels: ['CD'], note: '<script>alert(1)</script>', status: 'approved', updatedAt: '2026-09-28T00:00:00Z',
    }));
    expect(getClinicalReview('ptbxl', 17)?.labels).toEqual(['CD']);
    const report = renderPatientReport({ecgId: 17, predicted: ['MI']}, 'ptbxl');
    expect(report).toContain('CD: Cardiac conduction disturbance');
    expect(report).not.toContain('MI: ECG pattern');
    expect(report).toContain('&lt;script&gt;');
    expect(report).not.toContain('<script>');
  });

});
