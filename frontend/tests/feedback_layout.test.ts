import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../src/icde_demo.ts',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/feedback_workspace.css',import.meta.url),'utf8');
test('the primary workbench renders one bounded grid, not two full-height grids stacked',()=>{
  assert.match(src,/function collaborationWorkspace\(\)\{return revisionHtml\(/);
  assert.ok(src.includes("state.section==='investigation'"));
  assert.match(css,/\.feedback-scroll\{flex:1;min-height:0;overflow:auto/);
  assert.match(css,/@media\(max-width:979px\),\(max-height:599px\)/);
  assert.match(css,/\.feedback-column\{height:auto\}/);
});
test('report linking is an explicit click, not a side effect of receiving or adopting feedback',()=>{
  assert.ok(src.includes('data-rv-draft')&&src.includes('revisionToDraft('));
  assert.ok(src.includes('revisionItemId:state.revisionItemId'));
  assert.ok(src.includes("app.querySelector('#report-to-feedback')"));
  const decide=src.slice(src.indexOf('async function revisionDecision('),src.indexOf('function revisionToDraft('));
  assert.ok(!decide.includes('state.labels=')&&!decide.includes('saveReview('));
});
