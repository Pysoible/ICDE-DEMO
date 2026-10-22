import {zh as zhBase} from './demo_zh.ts';
import {zhLab} from './review_lab_zh.ts';
import {zhFeedback} from './feedback_zh.ts';
import {zhPatientReport} from './patient_report_zh.ts';
import {zhStory} from './revision_story_zh.ts';
import {zhCompanion} from './patient_companion_zh.ts';
import {zhPatientTasks} from './patient_tasks_zh.ts';
// The base dictionary wins: review_lab_zh only adds new keys and can never reword existing UI text.
const zh:Record<string,string>={...zhPatientTasks,...zhCompanion,...zhLab,...zhFeedback,...zhPatientReport,...zhStory,...zhBase};

export type Language='en'|'zh';
export const languageKey='recursiveecg.demo.language';
export function resolveLanguage(saved:string|null, browserLanguage:string):Language {
  return saved==='zh'||saved==='en'?saved:browserLanguage.toLowerCase().startsWith('zh')?'zh':'en';
}
export function initialLanguage():Language {
  let saved=null;
  try{saved=localStorage.getItem(languageKey);}catch{/* Storage may be blocked. */}
  return resolveLanguage(saved,navigator.language);
}
let language:Language=typeof navigator==='undefined'?'en':initialLanguage();
export function getLanguage(){return language;}
export function setLanguage(value:Language){
  language=value;
  try{localStorage.setItem(languageKey,value);}catch{/* Keep the in-memory preference. */}
}
export function t(text:string):string {
  if(language==='en')return text;
  if(Object.hasOwn(zh,text))return zh[text];
  const reportSuffix=' Existing reports and your draft are unchanged.';
  if(text.endsWith(reportSuffix))return `${t(text.slice(0,-reportSuffix.length))} ${t(reportSuffix.trim())}`;
  for(const preserved of [' Your question and existing reports are unchanged.',' Your opinion and existing reports are unchanged.']){
    if(text.endsWith(preserved)){
      const problem=text.slice(0,-preserved.length);
      if(Object.hasOwn(zh,problem))return zh[problem]+' '+zh[preserved.trim()];
    }
  }
  const patterns:[RegExp,(m:RegExpMatchArray)=>string][]=[
    [/^(\d+) leads?$/,m=>`${m[1]} 个导联`],
    [/^(\d+) points$/,m=>`${m[1]} 分`],
    [/^Report v(\d+) published with (\d+) attached measurements\. Open Patient to view this version\.$/,m=>`报告 v${m[1]} 已发布，附带 ${m[2]} 项测量。可在患者页面查看。`],
    [/^Draft v(\d+) saved\. The patient still sees the last published report, if any\.$/,m=>`草稿 v${m[1]} 已保存，患者仍只能看到上一次发布的报告（如有）。`],
  ];
  for(const [pattern,format] of patterns){const match=text.match(pattern);if(match)return format(match);}
  return text;
}
export function languageButtons(){return `<div class="language-switch" role="group" aria-label="${language==='zh'?'界面语言':'Interface language'}"><button type="button" data-language="zh" lang="zh-CN" aria-pressed="${language==='zh'}">中文</button><button type="button" data-language="en" lang="en" aria-pressed="${language==='en'}">English</button></div>`;}
