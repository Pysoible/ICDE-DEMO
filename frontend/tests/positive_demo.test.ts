import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticRows,simulatedImpact,matches,afterNormal} from '../src/positive_demo_data.ts';

test('positive replay metrics come from distinct synthetic rows, including real regressions in broad fixture',()=>{
 const tuning=syntheticRows('tuning'),holdout=syntheticRows('holdout');
 assert.equal(new Set([...tuning,...holdout].map(r=>r.id)).size,22);
 assert.ok([...tuning,...holdout].every(r=>r.id.startsWith('SIM-')));
 for(const rows of [tuning,holdout]){
  const broad=simulatedImpact(rows,'broad'),narrow=simulatedImpact(rows,'narrow');
  assert.ok(broad.afterF1>broad.beforeF1);assert.equal(broad.broken,1);
  assert.ok(narrow.afterF1>narrow.beforeF1);assert.equal(narrow.broken,0);
 }
 assert.equal(simulatedImpact(tuning,'narrow').fixed,2);
 assert.equal(simulatedImpact(holdout,'narrow').fixed,3);
 assert.ok(Math.abs(simulatedImpact(tuning,'narrow').afterF1-8/11)<1e-12);
 assert.ok(Math.abs(simulatedImpact(holdout,'narrow').afterF1-10/13)<1e-12);
});
test('missing axis never matches narrow rule and input rows are immutable',()=>{
 const rows=syntheticRows('tuning'),before=structuredClone(rows);
 simulatedImpact(rows,'narrow');assert.deepEqual(rows,before);
 const missing={id:'SIM-MISSING',normal:true,before:true,cd:.7,axis:null};
 assert.equal(matches(missing,'narrow'),false);assert.equal(afterNormal(missing,'narrow'),true);
});
