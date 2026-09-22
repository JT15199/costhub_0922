const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=path.join(__dirname,'.supplier-resource-preview');
fs.writeFileSync(base+'.html','<div id="root"></div><script type="module" src="./.supplier-resource-preview.tsx"></script>');
fs.writeFileSync(base+'.tsx',`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Button} from 'antd';import SupplierResourcePool,{SupplierNameInput} from '../src/components/SupplierResourcePool';import {saveProjectSupplier} from '../src/db/projects';import '../src/index.css';import {setDataLocked} from '../src/db/core';setDataLocked(false);function App(){const [name,setName]=useState('');return <main style={{padding:24}}><SupplierResourcePool/><section style={{display:'flex',gap:12,marginTop:20}}><label htmlFor="odm-name">整机供应商</label><SupplierNameInput id="odm-name" value={name} onChange={setName} style={{width:260}}/><Button onClick={()=>saveProjectSupplier({project_id:1,supplier_name:name,quoted_price:100,is_active:1})}>保存测试整机关系</Button><label htmlFor="part-name">器件供应商</label><SupplierNameInput id="part-name" style={{width:260}}/></section></main>};createRoot(document.getElementById('root')).render(<App/>);`);
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1280,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const state=JSON.parse(localStorage.getItem('supplier-fixture')||'null')||{profiles:[],odm:['存量整机厂'],parts:['存量器件厂']};window.__supplierState=state;
 const persist=()=>localStorage.setItem('supplier-fixture',JSON.stringify(state));
 window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  if(command==='get_db_path')return 'sqlite:mock';if(command==='sql_load')return 'mock';
  const q=String(args?.request?.query||''),values=args?.request?.values||[];
  if(command==='sql_select'){
   if(q.includes('UNION ALL')&&q.includes('supplier_profiles'))return [...state.profiles.map(row=>({...row,source:'档案'})),...state.odm.map(supplier_name=>({supplier_name,source:'整机'})),...state.parts.map(supplier_name=>({supplier_name,source:'器件'}))];
   if(q.includes('FROM supplier_profiles'))return state.profiles.filter(row=>row.supplier_name.trim()===values[0]);return [];
  }
  if(command==='sql_execute'){
   if(q.startsWith('INSERT INTO supplier_profiles')){const columns=q.match(/\(([^)]+)\)/)[1].split(',').map(s=>s.trim());state.profiles.push({id:state.profiles.length+1,...Object.fromEntries(columns.map((key,i)=>[key,values[i]]))});persist();}
   if(q.startsWith('UPDATE supplier_profiles SET')){const row=state.profiles.find(row=>row.id===values.at(-1));const keys=['logo','category','contact','phone','rating','remark','address','province','city','longitude','latitude'];keys.forEach((key,i)=>row[key]=values[i]);persist();}
   if(q.startsWith('INSERT INTO project_suppliers')){state.odm.push(values[1]);persist();}
   return {rowsAffected:1,lastInsertId:state.profiles.length};
  }return [];
 }};
});
await page.goto('http://127.0.0.1:5188/docs/.supplier-resource-preview.html');await page.getByRole('cell',{name:'存量整机厂',exact:true}).waitFor();
await page.getByRole('button',{name:'新增供应商资源'}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('供应商名称').fill(' 新资源厂 ');await dialog.getByLabel('联系人').fill('张工');await dialog.getByRole('button',{name:'保存供应商'}).click();await dialog.waitFor({state:'hidden'});
for(const id of ['odm-name','part-name']){await page.locator('#'+id).fill('新资源');await page.locator('.ant-select-dropdown').filter({has:page.locator('#'+id+'_list')}).locator('.ant-select-item-option').filter({hasText:'新资源厂'}).click();assert.equal(await page.locator('#'+id).inputValue(),'新资源厂');}
await page.locator('#odm-name').fill('直接输入的新厂');await page.getByRole('button',{name:'保存测试整机关系'}).click();await page.waitForFunction(()=>window.__supplierState.odm.includes('直接输入的新厂'));
await page.locator('#part-name').fill('直接输入');await page.locator('.ant-select-dropdown').filter({has:page.locator('#part-name_list')}).locator('.ant-select-item-option').filter({hasText:'直接输入的新厂'}).click();assert.equal(await page.locator('#part-name').inputValue(),'直接输入的新厂');
await page.getByRole('button',{name:'刷新资源池'}).click();await page.getByRole('cell',{name:'直接输入的新厂',exact:true}).waitFor();
await page.getByRole('row').filter({has:page.getByRole('cell',{name:'新资源厂',exact:true})}).getByRole('button',{name:'编辑档案'}).click();assert(await dialog.getByLabel('供应商名称').isDisabled());await dialog.getByLabel('联系电话').fill('123456');await dialog.getByRole('button',{name:'保存供应商'}).click();await dialog.waitFor({state:'hidden'});
await page.reload();await page.getByRole('cell',{name:'123456',exact:true}).waitFor();assert.equal(await page.getByRole('cell',{name:'新资源厂',exact:true}).count(),1);assert.deepEqual(errors,[]);
await page.screenshot({path:path.join(__dirname,'supplier-resource-acceptance.png'),fullPage:true});console.log('PASS resource creation/edit/reload, existing names, both selectors, typed ODM save -> reusable part option');
}finally{await browser.close();fs.unlinkSync(base+'.html');fs.unlinkSync(base+'.tsx');}})().catch(error=>{console.error(error);process.exitCode=1});

