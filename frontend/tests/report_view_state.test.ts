import test from 'node:test';
import assert from 'node:assert/strict';
import {ReportViewState} from '../src/report_view_state.ts';

// Minimal DOM-shaped fixtures exercise the actual capture/restore implementation.
function view(scope='case-a',open=true){
  const elements:Record<string,any>={
    '.report-basis':{open},'.report-manual-edit':{open:false},'.report-audit':{open:true},
    '.report-scroll':{scrollTop:225,scrollLeft:0},'.review-side':{scrollTop:80,scrollLeft:0},
  };
  const report={dataset:{reportView:scope},querySelector:(selector:string)=>elements[selector]||null};
  const root={querySelector:(selector:string)=>selector==='[data-report-view]'?report:null} as unknown as ParentNode;
  return {root,elements};
}
const absent={querySelector:()=>null} as unknown as ParentNode;

test('consecutive label/evidence rerenders keep the basis open and panels scrolled',()=>{
  const state=new ReportViewState();let current=view();
  state.restore(current.root,'case-a');
  for(const label of ['MI','STTC','CD','remove MI','remove STTC','remove CD']){
    state.capture(current.root);
    const next=view('case-a',false);next.elements['.report-scroll'].scrollTop=0;
    next.elements['.review-side'].scrollTop=0;
    state.restore(next.root,'case-a');
    assert.equal(next.elements['.report-basis'].open,true,label);
    assert.equal(next.elements['.report-scroll'].scrollTop,225,label);
    assert.equal(next.elements['.review-side'].scrollTop,80,label);
    current=next;
  }
});
test('manual close survives rerender even if the fresh default is open',()=>{
  const state=new ReportViewState(),before=view('case-a',false),after=view();
  before.elements['.report-manual-edit'].open=true;
  state.capture(before.root);state.restore(after.root,'case-a');
  assert.equal(after.elements['.report-basis'].open,false);
  assert.equal(after.elements['.report-manual-edit'].open,true);
  after.elements['.report-basis'].open=true;state.capture(after.root);
  const reopened=view('case-a',false);state.restore(reopened.root,'case-a');
  assert.equal(reopened.elements['.report-basis'].open,true);
});
test('tab/role and language redraws retain stable keyed details, not DOM order',()=>{
  const state=new ReportViewState(),before=view();state.capture(before.root);
  state.restore(absent,'case-a');state.capture(absent);
  const after=view('case-a',false);delete after.elements['.report-audit'];
  state.restore(after.root,'case-a');
  assert.equal(after.elements['.report-basis'].open,true);
  assert.equal(after.elements['.report-manual-edit'].open,false);
});
test('case or source context change resets view state and does not leak it back',()=>{
  const state=new ReportViewState(),before=view();state.capture(before.root);
  state.restore(absent,'case-b');
  const next=view('case-b',false);next.elements['.report-scroll'].scrollTop=0;
  state.restore(next.root,'case-b');
  assert.equal(next.elements['.report-basis'].open,false);
  assert.equal(next.elements['.report-scroll'].scrollTop,0);
  state.restore(before.root,'new-source-context'); // No mismatched-context restoration.
  const back=view('case-a',false);state.restore(back.root,'case-a');
  assert.equal(back.elements['.report-basis'].open,false);
});
test('first render keeps its intended default, missing optional controls are safe',()=>{
  const state=new ReportViewState(),initial=view('case-a',false);
  state.restore(initial.root,'case-a');assert.equal(initial.elements['.report-basis'].open,false);
  state.capture(initial.root);
  const changed=view();delete changed.elements['.report-basis'];
  state.restore(changed.root,'case-a');
  assert.equal(changed.elements['.report-audit'].open,true);
});
