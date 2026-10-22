import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLanguage,getLanguage,setLanguage,t,languageButtons} from '../src/demo_i18n.ts';

test('saved preference takes priority over browser locale',()=>{
  assert.equal(resolveLanguage('en','zh-CN'),'en');
  assert.equal(resolveLanguage('zh','en-US'),'zh');
  assert.equal(resolveLanguage(null,'zh-TW'),'zh');
  assert.equal(resolveLanguage('invalid','fr-FR'),'en');
});
test('Chinese UI copy, statuses and count values are translated',()=>{
  setLanguage('zh');assert.equal(getLanguage(),'zh');
  assert.equal(t('Clinical Expert'),'临床专家');
  assert.equal(t('Not assessable'),'无法评估');
  assert.equal(t('QRS duration'),'QRS 时限');
  assert.equal(t('2 leads'),'2 个导联');
  assert.equal(t('1 lead'),'1 个导联');
  assert.equal(t('3 points'),'3 分');
});
test('unknown content and diagnosis codes are never rewritten',()=>{
  setLanguage('zh');
  for(const text of ['MI','NORM','120 ms','患者备注：请进一步复核。','Unrecognized source sentence.','<script>alert(1)</script>'])assert.equal(t(text),text);
});
test('versioned notifications preserve numeric values',()=>{
  setLanguage('zh');
  assert.equal(t('Report v12 published with 3 attached measurements. Open Patient to view this version.'),'报告 v12 已发布，附带 3 项测量。可在患者页面查看。');
  assert.equal(t('Draft v7 saved. The patient still sees the last published report, if any.'),'草稿 v7 已保存，患者仍只能看到上一次发布的报告（如有）。');
});
test('analysis service errors explain the cause in Chinese and preserve drafts',()=>{
  setLanguage('zh');
  assert.equal(t('The model analysis timed out. Retry with a more focused question. Your question and existing reports are unchanged.'),'模型分析超时，请缩小问题范围后重试。 你的问题和已有报告已保留。');
  assert.equal(t('The model service returned HTTP 402 (payment/quota issue). Restore service availability before retrying. Your question and existing reports are unchanged.'),'模型服务返回 HTTP 402（计费或额度问题），请恢复服务后重试。 你的问题和已有报告已保留。');
});
test('English round trip and accessible toggle state',()=>{
  setLanguage('zh');assert.match(languageButtons(),/data-language="zh" lang="zh-CN" aria-pressed="true"/);
  setLanguage('en');assert.equal(t('Clinical Expert'),'Clinical Expert');
  assert.match(languageButtons(),/data-language="en" lang="en" aria-pressed="true"/);
});
test('expert-feedback UI and safe provider failures have Chinese translations',()=>{
  setLanguage('zh');
  assert.equal(t('Apply feedback & re-analyze'),'根据意见调整并重新分析');
  assert.equal(t('The model service returned HTTP 402 (payment/quota issue). Restore service availability before retrying. Your opinion and existing reports are unchanged.'),'模型服务返回 HTTP 402（计费或额度问题），请恢复服务后重试。 你的意见和已有报告已保留。');
  setLanguage('en');
});
