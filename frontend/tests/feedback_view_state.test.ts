import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedbackViewState} from '../src/feedback_view_state.ts';
function view(scope='a:i',top=0,open=false){
  const details=[{open}],column={scrollTop:top,querySelectorAll:()=>details};
  const panel={dataset:{feedbackScope:scope},querySelectorAll:()=>[column]};
  return {root:{querySelector:()=>panel} as unknown as ParentNode,column,details};
}
test('in-place witness selection keeps scroll and disclosures; history/case changes reset',()=>{
  const state=new FeedbackViewState(),before=view('a:i',200,true),after=view();state.capture(before.root);state.restore(after.root);
  assert.equal(after.column.scrollTop,200);assert.equal(after.details[0].open,true);
  const other=view('a:j');state.restore(other.root);assert.equal(other.column.scrollTop,0);assert.equal(other.details[0].open,false);
  const again=view();state.restore(again.root);assert.equal(again.column.scrollTop,0);
});
test('visiting another tab retains the same feedback view without leaking to another context',()=>{
  const state=new FeedbackViewState(),before=view('a:i',120,true),absent={querySelector:()=>null} as unknown as ParentNode;
  state.capture(before.root);state.capture(absent);state.restore(absent);const after=view();state.restore(after.root);assert.equal(after.column.scrollTop,120);
  const other=view('b:i');state.restore(other.root);assert.equal(other.column.scrollTop,0);
});
