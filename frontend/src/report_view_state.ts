// View-only state: never persisted with a clinical report or used for approval.
const detailSelectors=['.report-basis','.report-manual-edit','.report-audit','.report-text-impact'] as const;
const scrollSelectors=['.report-scroll','.review-side'] as const;
type Snapshot={details:Map<string,boolean>;scroll:Map<string,{top:number;left:number}>};

export class ReportViewState {
  private scope='';
  private snapshot:Snapshot|null=null;

  capture(root:ParentNode):void {
    const report=root.querySelector<HTMLElement>('[data-report-view]');
    if(!report)return; // Keep the last report view while visiting another tab.
    this.scope=report.dataset.reportView||'';
    this.snapshot={details:new Map(),scroll:new Map()};
    for(const selector of detailSelectors){
      const detail=report.querySelector<HTMLDetailsElement>(selector);
      if(detail)this.snapshot.details.set(selector,detail.open);
    }
    for(const selector of scrollSelectors){
      const panel=report.querySelector<HTMLElement>(selector);
      if(panel)this.snapshot.scroll.set(selector,{top:panel.scrollTop,left:panel.scrollLeft});
    }
  }

  restore(root:ParentNode,scope:string):void {
    if(this.scope!==scope){this.scope=scope;this.snapshot=null;}
    const report=root.querySelector<HTMLElement>('[data-report-view]');
    if(!report||report.dataset.reportView!==scope||!this.snapshot)return;
    // Restore details before scroll so the browser has the correct content height.
    // Read the DOM synchronously before replacement; no delayed toggle handlers
    // from detached nodes can overwrite the user's latest choice.
    for(const [selector,open] of this.snapshot.details){
      const detail=report.querySelector<HTMLDetailsElement>(selector);
      if(detail)detail.open=open;
    }
    for(const [selector,position] of this.snapshot.scroll){
      const panel=report.querySelector<HTMLElement>(selector);
      if(panel){panel.scrollTop=position.top;panel.scrollLeft=position.left;}
    }
  }
}
