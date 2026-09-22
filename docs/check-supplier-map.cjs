const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=path.join(__dirname,'.supplier-map-preview');
fs.writeFileSync(base+'.html','<div id="root"></div><script type="module" src="./.supplier-map-preview.tsx"></script>');
fs.writeFileSync(base+'.tsx',`import React from 'react';import {createRoot} from 'react-dom/client';import SupplierManagement from '../src/pages/SupplierManagement';import {setDataLocked} from '../src/db/core';import '../src/index.css';setDataLocked(false);createRoot(document.getElementById('root')).render(<SupplierManagement/>);`);
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1360,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const sites=[{id:1,supplier_name:'测试整机厂',site_name:'深圳主厂',address:'测试地址',city:'深圳市',longitude:114.0579,latitude:22.5431,is_primary:1},{id:2,supplier_name:'测试整机厂',site_name:'上海分厂',address:'测试地址2',city:'上海市',longitude:121.47,latitude:31.23,is_primary:0}];
 window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  if(command==='get_db_path'||command==='sql_load')return 'sqlite:mock';
  const q=String(args?.request?.query||''),v=args?.request?.values||[];
  if(command==='sql_select'){
   if(q.startsWith('SELECT * FROM supplier_sites'))return sites;
   if(q.startsWith('SELECT * FROM supplier_profiles'))return [];
   if(q.includes('FROM projects')&&!q.includes('JOIN'))return [{id:1,code:'P1',name:'测试项目',status:'进行中'}];
   if(q.startsWith('SELECT * FROM project_suppliers'))return [{id:1,project_id:1,supplier_name:'测试整机厂',quoted_price:100,share_ratio:100,is_active:1},{id:2,project_id:1,supplier_name:'待定位整机厂',quoted_price:110,share_ratio:0,is_active:1}];
   return [];
  }
  if(command==='sql_execute'){
   if(q.startsWith('UPDATE supplier_sites SET supplier_name=')){const site=sites.find(s=>s.id===v.at(-1));['supplier_name','site_name','address','province','city','longitude','latitude','contact','phone','is_primary','remark'].forEach((key,i)=>site[key]=v[i]);}
   return {rowsAffected:1,lastInsertId:3};
  }return [];
 }};
});
await page.goto('http://127.0.0.1:5188/docs/.supplier-map-preview.html');await page.locator('label.ant-radio-button-wrapper').filter({hasText:'整机供应商'}).click();await page.getByRole('tab',{name:/供应商地图/}).click();
await page.getByRole('button',{name:'测试整机厂，深圳市，覆盖 1 个项目',exact:true}).waitFor();
await page.getByRole('button',{name:'测试整机厂，上海市，覆盖 1 个项目',exact:true}).click();
const modal=page.getByRole('dialog');await modal.getByLabel('厂家名称',{exact:true}).waitFor();assert.equal(await modal.getByLabel('厂家名称',{exact:true}).inputValue(),'上海分厂');await modal.getByLabel('城市',{exact:true}).fill('上海测试市');await modal.getByRole('button',{name:'保存位置'}).click();await modal.waitFor({state:'hidden'});
await page.getByRole('button',{name:'测试整机厂，上海测试市，覆盖 1 个项目',exact:true}).waitFor();await page.getByRole('button',{name:/待定位整机厂.*维护地址/}).waitFor();
// Progressive detail and navigation regressions, using the real local boundary data.
assert.equal(await page.locator('.supplier-map-city').count(),0);
assert((await page.locator('.supplier-map-label').count())>=10);
await page.getByRole('button',{name:'放大地图',exact:true}).click();
assert.equal(await page.locator('.supplier-map-city').count(),0,'one zoom step must not expose city boundaries');
await page.getByRole('button',{name:'重置地图视图',exact:true}).click();
await page.getByRole('button',{name:'广东省',exact:true}).press('Enter');
await page.waitForFunction(()=>document.querySelectorAll('.supplier-map-city').length>0);
const cities=await page.locator('.supplier-map-city').count();assert(cities<200,'only visible city boundaries should be mounted');
assert((await page.locator('.supplier-map-city-label').count())>0,'wheel and province zoom must expose city names');
const focus=await page.locator('.supplier-map-province.is-selected').evaluate(e=>{const b=e.getBoundingClientRect(),s=e.ownerSVGElement.getBoundingClientRect();return {dx:Math.abs(b.x+b.width/2-s.x-s.width/2),dy:Math.abs(b.y+b.height/2-s.y-s.height/2)};});
assert(focus.dx<3&&focus.dy<3,'province click should center its bounds');
const svg=page.locator('.supplier-map-svg');const rect=await svg.boundingBox();
await page.mouse.move(rect.x+rect.width*.55,rect.y+rect.height*.45);
await page.mouse.wheel(0,-70);
await page.waitForTimeout(100);
assert((await page.locator('.supplier-map-city-label').count())>0);
const collisions=await page.locator('.supplier-map-city-label').evaluateAll(es=>{const boxes=es.map(e=>e.getBoundingClientRect());return boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));});
assert.equal(collisions,false,'city labels should not overlap');
await page.screenshot({path:path.join(__dirname,'supplier-map-city-acceptance.png'),fullPage:true});
await page.getByRole('button',{name:'重置地图视图',exact:true}).click();
await page.mouse.move(rect.x+rect.width*.4,rect.y+rect.height*.4);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.5,rect.y+rect.height*.5,{steps:20});await page.mouse.up();
assert.equal(await page.locator('.supplier-map-province.is-selected').count(),0,'drag must not trigger a province click');
assert.equal(await page.locator('.supplier-map-city').count(),0);
await page.getByRole('button',{name:'重置地图视图',exact:true}).click();
console.log('PASS progressive province/city layers, city culling, label collision, province centering and drag click suppression');
assert.deepEqual(errors,[]);await page.screenshot({path:path.join(__dirname,'supplier-map-odm-acceptance.png'),fullPage:true});console.log('PASS ODM map: two sites, project counts, correct site edit/reload and unlocated entry');
}finally{await browser.close();fs.unlinkSync(base+'.html');fs.unlinkSync(base+'.tsx');}})().catch(error=>{console.error(error);process.exitCode=1});

