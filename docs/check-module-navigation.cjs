const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const source = fs.readFileSync('src/pages/Projects.tsx', 'utf8');
const nav = source.slice(source.indexOf("{bomTableMode === 'module' && sortedModNames.length"), source.indexOf("{bomTableMode === 'flat' && <div className=\"bom-spreadsheet-hint\">"));
const base = path.join(__dirname, '.module-nav-preview');
fs.writeFileSync(base + '.html', '<div id="root"></div><script type="module" src="./.module-nav-preview.tsx"></script>');
fs.writeFileSync(base + '.tsx', `import React from 'react';import {createRoot} from 'react-dom/client';import {Tabs,Select} from 'antd';import '../src/index.css';
function Preview(){const bomTableMode='module';const sortedModNames=Array.from({length:30},(_,i)=>'模块 '+(i+1)+' / 电源[板]');const groupedBOMs=Object.fromEntries(sortedModNames.map(name=>[name,[1,2]]));return <div className="projects-detail-card" style={{height:500,margin:24}}><div className="project-detail-scroll"><div style={{height:180}}>项目标题与操作区</div><Tabs items={[{key:'bom',label:'BOM清单',children:<div className="bom-tab-layout"><div className="bom-workspace-main">${nav}{sortedModNames.map(name=><div key={name} id={'module-'+name} className="bom-module-card" tabIndex={-1} style={{height:240,scrollMarginTop:64}}><h2>{name}</h2></div>)}</div></div>}]}/></div></div>};createRoot(document.getElementById('root')).render(<Preview/>);`);
(async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1000,height:700}});await page.goto('http://127.0.0.1:5188/docs/.module-nav-preview.html');
await page.getByRole('navigation',{name:'模块快速定位'}).waitFor();
for(const number of [28,2,30]){
 const select=page.getByRole('combobox',{name:'搜索并定位模块'});await select.fill('模块 '+number+' /');
 await page.locator('.ant-select-item-option').filter({hasText:'模块 '+number+' /'}).click();
 const bounds=await page.evaluate(number=>{const scroll=document.querySelector('.project-detail-scroll'),nav=document.querySelector('.bom-module-navigation'),target=document.getElementById('module-模块 '+number+' / 电源[板]');return {navTop:nav.getBoundingClientRect().top,navBottom:nav.getBoundingClientRect().bottom,top:scroll.getBoundingClientRect().top,target:target.getBoundingClientRect().top,focused:document.activeElement===target,scroll:scroll.scrollTop};},number);
 assert(bounds.focused);assert(bounds.scroll>0);assert(Math.abs(bounds.navTop-bounds.top)<2,JSON.stringify(bounds));assert(bounds.target>=bounds.navBottom,JSON.stringify(bounds));
}
await page.setViewportSize({width:600,height:700});assert(await page.locator('.bom-module-navigation').evaluate(e=>e.scrollWidth<=e.clientWidth));console.log('PASS 30 modules: search, forward/back navigation, special names, sticky position, focus and narrow layout');
}finally{await browser.close();fs.unlinkSync(base+'.html');fs.unlinkSync(base+'.tsx');}})().catch(e=>{console.error(e);process.exitCode=1});
