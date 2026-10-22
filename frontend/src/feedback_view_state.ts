// Ephemeral only: keep in-place comparison clicks from resetting the workspace scroll.
export class FeedbackViewState{
  private snapshot:{scope:string;scroll:number[];open:boolean[][]}|null=null;
  capture(root:ParentNode){
    const panel=root.querySelector<HTMLElement>('[data-feedback-scope]');if(!panel)return;
    this.snapshot={scope:panel.dataset.feedbackScope||'',scroll:[],open:[]};
    panel.querySelectorAll<HTMLElement>('.feedback-scroll').forEach(el=>{this.snapshot!.scroll.push(el.scrollTop);this.snapshot!.open.push(Array.from(el.querySelectorAll('details')).map(d=>d.open));});
  }
  restore(root:ParentNode){
    const panel=root.querySelector<HTMLElement>('[data-feedback-scope]');if(!panel)return;
    if(!this.snapshot||panel.dataset.feedbackScope!==this.snapshot.scope){this.snapshot=null;return;}
    panel.querySelectorAll<HTMLElement>('.feedback-scroll').forEach((el,i)=>{el.querySelectorAll<HTMLDetailsElement>('details').forEach((d,j)=>d.open=this.snapshot!.open[i]?.[j]||false);el.scrollTop=this.snapshot!.scroll[i]||0;});
  }
}
