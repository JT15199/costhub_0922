// Runs the real Projects entry handler and modal JSX with synthetic, local-only stores.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const source=fs.readFileSync(path.join(__dirname,'../src/pages/Projects.tsx'),'utf8');
const start=source.indexOf('      <Modal title={<span><BulbOutlined /> AI 情报中心');
const modal=source.slice(start,source.indexOf("        {aiTab === 'diff' && (",start))+'</Modal>';
const entryStart=source.indexOf('    const onOpen = (event?: Event) =>');
const entry=source.slice(entryStart,source.indexOf("    if (localStorage.getItem('costhub-open-insights-pending'))",entryStart));
const fixture=`import React,{useState,useEffect,useRef} from 'react';import {createRoot} from 'react-dom/client';
import {Button,Modal,Segmented,Tag,message} from 'antd';import {BulbOutlined} from '@ant-design/icons';
import {consumeInsightTab,openInsightCenter} from '../src/insightNavigation';
const adviceRows=Array.from({length:12},(_,i)=>({id:i+1,status:'open',title:'巡查建议 '+(i+1),detail:'虚构验收依据 '+(i+1)}));
let auditRows=[{id:1,status:'unread',title:'巡检条目一',detail:'虚构数据质量问题',source:'rule'},{id:2,status:'unread',title:'巡检条目二',detail:'虚构价格问题',source:'ai'}];
const getAuditFindings=async()=>auditRows;const getAdvisorInsights=async()=>adviceRows;
const markAuditRead=async(id)=>{auditRows=auditRows.map(x=>x.id===id?{...x,status:'read'}:x)};
const dismissAuditFinding=async(id)=>{auditRows=auditRows.filter(x=>x.id!==id)};
const RecommendationCard=({recommendation})=><div>结构化参考：{recommendation.title}</div>;
function Harness(){
const [insightModal,setInsightModal]=useState(false),[aiTab,setAiTab]=useState('diff');
const insightOpenGeneration=useRef(0);const [adviceList,setAdviceList]=useState([]),[auditList,setAuditList]=useState([]);
const [adviceShowDone,setAdviceShowDone]=useState(false);const insights=[];
const recommendationList=[{id:101,status:'open',title:'独立结构化参考'}];
const loadInsights=()=>{};const refreshAiCenter=async()=>{const advice=await getAdvisorInsights(),audit=await getAuditFindings();setAdviceList(advice);setAuditList(audit);return [advice,undefined,audit]};
useEffect(()=>{${entry}
if(localStorage.getItem('costhub-open-insights-pending'))onOpen();
window.addEventListener('costhub-open-insights',onOpen);window.__ready=true;
return()=>window.removeEventListener('costhub-open-insights',onOpen);},[]);
return <>${modal}</>;
}
window.__open=(tab)=>openInsightCenter(()=>{},tab);createRoot(document.getElementById('root')).render(<Harness/>);`;
fs.writeFileSync(path.join(__dirname,'.insight-entry-preview.tsx'),fixture);
fs.writeFileSync(path.join(__dirname,'.insight-entry-preview.html'),'<!doctype html><html><body><div id="root"></div><script type="module" src="./.insight-entry-preview.tsx"></script></body></html>');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:850}});
  await page.addInitScript(()=>localStorage.setItem('costhub-open-insights-pending','audit'));
  await page.goto('http://127.0.0.1:5188/docs/.insight-entry-preview.html');
  await page.getByText('巡检条目一',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('costhub-open-insights-pending')),null);
  await page.getByText('标记已读',{exact:true}).first().click();
  await page.getByText('巡检发现 1',{exact:true}).waitFor();
  await page.evaluate(()=>window.__open('advice'));
  await page.getByText('巡查建议 12',{exact:true}).waitFor();
  assert.equal(await page.locator('b').filter({hasText:/^巡查建议 \d+$/}).count(),12);
  await page.locator('summary').filter({hasText:'结构化分析参考'}).click();
  await page.getByText('结构化参考：独立结构化参考',{exact:true}).waitFor();
  assert.equal(await page.locator('b').filter({hasText:/^巡查建议 \d+$/}).count(),12);
  await page.screenshot({path:path.join(__dirname,'insight-entry-acceptance.png'),fullPage:true});
  console.log('PASS cold mount audit entry, mark-read count, live advice entry and all 12 legacy suggestions alongside structured reference');
 }finally{await browser.close();for(const n of ['.insight-entry-preview.tsx','.insight-entry-preview.html'])fs.unlinkSync(path.join(__dirname,n));}
})().catch(e=>{console.error(e);process.exitCode=1});
