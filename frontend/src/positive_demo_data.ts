/** Synthetic presentation fixture, not PTB-XL data or an independent evaluation. */
export type SimRow={id:string;normal:boolean;before:boolean;cd:number;axis:number|null};
export type SimRule='broad'|'narrow';
const tuples:[boolean,boolean,number,number|null][]=[
 [false,true,.47,141.5],[false,true,.6,112],[false,true,.5,80],
 [true,true,.4,45],[true,true,.1,15],[true,true,.2,30],[true,true,.25,65],
 [true,false,.1,25],[true,false,.2,50],[false,false,.1,20],
];
export function syntheticRows(set:'tuning'|'holdout'):SimRow[]{
 const rows=tuples.map(([normal,before,cd,axis],i)=>({id:`SIM-${set==='tuning'?'T':'H'}${String(i+1).padStart(2,'0')}`,normal,before,cd,axis:axis===null?null:axis+(set==='holdout'?3:0)}));
 if(set==='holdout')rows.push({id:'SIM-H11',normal:true,before:true,cd:.15,axis:20},{id:'SIM-H12',normal:false,before:true,cd:.65,axis:120});
 return rows;
}
export function matches(row:SimRow,rule:SimRule){return row.cd>=.326&&(rule==='broad'||(row.axis!==null&&row.axis>90));}
export function afterNormal(row:SimRow,rule:SimRule){return matches(row,rule)?false:row.before;}
export function normalF1(rows:SimRow[],prediction:(row:SimRow)=>boolean){
 let tp=0,fp=0,fn=0;
 for(const row of rows){const p=prediction(row);if(p&&row.normal)tp++;if(p&&!row.normal)fp++;if(!p&&row.normal)fn++;}
 return 2*tp+fp+fn?2*tp/(2*tp+fp+fn):0;
}
export function simulatedImpact(rows:SimRow[],rule:SimRule){
 let fixed=0,broken=0;
 for(const row of rows){const before=row.before===row.normal,after=afterNormal(row,rule)===row.normal;if(!before&&after)fixed++;if(before&&!after)broken++;}
 return {n:rows.length,fixed,broken,beforeF1:normalF1(rows,r=>r.before),afterF1:normalF1(rows,r=>afterNormal(r,rule))};
}
