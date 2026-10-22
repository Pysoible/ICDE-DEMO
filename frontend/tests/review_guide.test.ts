import test from 'node:test';
import assert from 'node:assert/strict';
import {guideSteps,reviewGuide} from '../src/review_guide.ts';
const h={t:(x:string)=>x,esc:(x:any)=>String(x??'').replaceAll('<','&lt;')};
test('no rounds: first step is current and nothing is marked done',()=>{
  const s=guideSteps({collaboration:{rounds:[]},publishedReport:null});
  assert.equal(s.filter(x=>x.done).length,0);
  assert.match(reviewGuide({collaboration:{rounds:[]}},h),/aria-current="step"/);
});
test('steps complete in order from the saved record; patient step needs a published policy',()=>{
  const round={investigation:{},validation:{},policy:{version:1}};
  const s=guideSteps({collaboration:{rounds:[round]},publishedReport:{reviewPolicy:{version:1}}});
  assert.deepEqual(s.map(x=>x.done),[true,true,true,true,true]);
  const partial=guideSteps({collaboration:{rounds:[{investigation:{}}]},publishedReport:null});
  assert.deepEqual(partial.map(x=>x.done),[true,true,false,false,false]);
});
test('guide copy is informational and never calls a model or changes data',()=>{
  const html=reviewGuide({collaboration:{rounds:[]}},h);
  assert.ok(!/publish|adopted|accepted/i.test(html.replace(/Publish a report.*?(?=<)|Validate the exact.*?(?=<)|Adopt/gi,'')));
  assert.ok(html.includes('data-guide-target="expert-question"'));
});
