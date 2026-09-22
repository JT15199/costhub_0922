// Real DashboardRedesign markup and CSS, synthetic data; no database or model calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/pages/Dashboard.tsx'), 'utf8');
const component = source.slice(source.indexOf('// 直达项目页'), source.indexOf('export default function Dashboard('));
const projectSource = fs.readFileSync(path.join(root, 'src/pages/Projects.tsx'), 'utf8');
const specMarkup = projectSource.match(/<span className="project-detail-spec">.*?<\/span>/)[0];
const fixture = `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {Tag,Button,Empty,Modal,Input,Table,Select} from 'antd'; import {BarChartOutlined,RobotOutlined} from '@ant-design/icons';
import {openInsightCenter} from '../src/insightNavigation';
import type {DashboardStats,ProductionCostSaving} from '../src/types';
import '../src/index.css'; import '../src/pages/Dashboard.css';
const AIStatusBar=()=>null;
${component}
const projects=Array.from({length:5},(_,i)=>({id:i+1,code:'DEMO-'+(i+1),name:'显示器报价与供应商评审项目名称较长的示例',status:'进行中',platform_fee_rate:5,profit_rate:30,category:i===0?'鼠标':'显示器'}));
const props={savingYear:2026,savingYears:[2026,2025],onSavingYearChange:(year)=>{window.__year=year;props.savingYear=year;window.__render();},costHistory:{1:[{id:1,created_at:'2026-09-01 10:00:00',bom_cost:800,total_cost:840,platform_fee_rate:5,profit_rate:0,change_reason:'测试历史报价'}]},stats:{active_projects:5},projects,productionSavings:projects.map((p,i)=>({id:i+1,project_id:p.id,project_code:p.code,project_name:p.name,part_name:'测试器件',module_name:['电源','驱动板','结构','包材','其他'][i],unit_saving:2,annual_shipments:10000,annual_benefit:20000})),productionTarget:160000,projCosts:Array.from({length:13},(_,i)=>({name:'DEMO-'+(i+1),projectId:i+1,cost:850-i*40})),snapshotChanges:[],missedByProject:[{projectId:1,code:'DEMO-1',worstDomain:'结构模块',worstRate:95},{projectId:2,code:'DEMO-2',worstDomain:'电源模块',worstRate:90}],targetedProjectIds:[1],unknownTargetCount:1,unreadInsights:[{module_name:'电源模块',insight_json:JSON.stringify(Array.from({length:3},(_,i)=>({name:'测试控制器'+i,diff:12,rows:[1,2]})))}],recentPriceChanges:[],advisorInsights:[],cloudUsage:{count:0},cloudLimit:50,onNavigate:(key)=>window.__nav=key,onRunAudit:()=>{},auditRunning:false,auditCount:12};
const app=createRoot(document.getElementById('root'));
window.__render=(empty=false)=>app.render(<main style={{width:'calc(100vw - 280px)',margin:'24px auto',height:'calc(100vh - 48px)',minWidth:0}}><DashboardRedesign {...props} {...(empty?{projects:[],productionSavings:[],projCosts:[],missedByProject:[],unreadInsights:[]}: {})}/></main>);
window.__render();
window.__spec=(selectedProject)=>app.render(<div className="content-card" style={{margin:40,padding:30}}>${specMarkup}</div>);
`;
fs.writeFileSync(path.join(__dirname, '.dashboard-layout-preview.tsx'), fixture);
fs.writeFileSync(path.join(__dirname, '.dashboard-layout-preview.html'), '<!doctype html><html><head><style>body{overflow:auto!important;background:linear-gradient(120deg,#edf3fc,#f5f8fc)!important}#root{height:auto!important;display:block!important}</style></head><body><div id="root"></div><script type="module" src="./.dashboard-layout-preview.tsx"></script></body></html>');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:5188/docs/.dashboard-layout-preview.html');
    await page.locator('.dashboard-production-benefit').waitFor();
    for(const [width,height] of [[1360,900],[980,700],[740,700],[560,700],[600,530],[360,740]]) {
      await page.setViewportSize({width:width+280,height});
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      const result=await page.evaluate(()=>{
        const board=document.querySelector('.dashboard-redesign').getBoundingClientRect();
        const cards=[...document.querySelectorAll('.dashboard-layout > section')].filter(e=>e.getBoundingClientRect().width>0).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
        const overlap=cards.some((a,i)=>cards.slice(i+1).some(b=>a.x<b.right-1&&a.right>b.x+1&&a.y<b.bottom-1&&a.bottom>b.y+1));
        const clipped=[...document.querySelectorAll('.dashboard-layout button,.dashboard-production-benefit,.dashboard-production-donut')].filter(e=>{const r=e.getBoundingClientRect(),p=e.closest('section').getBoundingClientRect();return r.width>0&&(r.right>p.right+1||r.left<p.left-1||r.bottom>p.bottom+1);}).map(e=>e.className);
        const summary=document.querySelector('.dashboard-production-summary').getBoundingClientRect();
        const innerOverflow=[...document.querySelector('.dashboard-production-summary').children].some(e=>e.getBoundingClientRect().right>summary.right+1);
        const verticalOverflow=[...document.querySelectorAll('.dashboard-layout > section')].filter(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight+1).map(e=>e.className);
        return {verticalOverflow,pageOverflow:document.documentElement.scrollHeight>innerHeight+1,count:cards.length,overlap,clipped,innerOverflow,overflow:cards.some(r=>r.right>board.right+1||r.x<board.x-1),columns:getComputedStyle(document.querySelector('.dashboard-layout')).gridTemplateColumns.split(' ').length};
      });
      if(result.verticalOverflow.length) { await page.screenshot({path:path.join(__dirname,'dashboard-layout-failure.png'),fullPage:true}); console.log(await page.locator('.dashboard-todo').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,children:[...e.children].map(x=>({name:x.className,height:x.getBoundingClientRect().height}))}))); }
      assert.deepEqual(result.verticalOverflow,[]); assert.equal(result.pageOverflow,false); assert.equal(result.count,width>=900?5:2); assert.equal(result.overlap,false); assert.equal(result.overflow,false); assert.equal(result.innerOverflow,false); assert.deepEqual(result.clipped,[]);
      assert.equal(result.columns,width>=900?3:1);
      if(width===1360||width===980||width===360) await page.screenshot({path:path.join(__dirname,`dashboard-layout-${width}.png`),fullPage:true});
      console.log('PASS width',width,JSON.stringify(result));
    }
    await page.setViewportSize({width:1280,height:850});
    const year=page.getByRole('combobox',{name:'收益年份'});
    await year.selectOption('2025');
    assert.equal(await page.evaluate(()=>window.__year),2025);
    await page.getByRole('button',{name:/查看项目明细/}).click();
    await page.getByRole('dialog',{name:'2025 年降本项目明细'}).waitFor();
    await page.getByRole('dialog',{name:'2025 年降本项目明细'}).getByRole('button',{name:'Close',exact:true}).click();
    const details=await page.locator('.dashboard-production-details').evaluate(e=>({background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderLeftWidth,shadow:getComputedStyle(e).boxShadow}));
    assert.deepEqual(details,{background:'rgba(0, 0, 0, 0)',border:'0px',shadow:'none'});
    await year.selectOption('2026');
    console.log('PASS year selection, selected-year detail title and clean detail control');

    await page.getByRole('button',{name:'成本总览',exact:true}).click();
    const overview=page.getByRole('dialog',{name:'项目成本总览'});
    await overview.getByRole('cell',{name:'¥892.50',exact:true}).waitFor();
    assert.equal(await overview.locator('tbody tr.ant-table-row').count(),5);
    assert.equal(await overview.locator('.cost-overview-project').first().evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
    assert((await overview.locator('tbody tr.ant-table-row').first().boundingBox()).height < 55);
    await overview.getByRole('combobox',{name:'筛选项目类别'}).click();
    await page.locator('.ant-select-item-option').filter({hasText:'鼠标'}).click();
    assert.equal(await overview.locator('tbody tr.ant-table-row').count(),1);
    await overview.getByRole('button',{name:'成本历史',exact:true}).click();
    const history=page.getByRole('dialog',{name:'DEMO-1 · 成本历史'});
    await history.getByText('测试历史报价',{exact:true}).waitFor();
    await history.getByRole('cell',{name:'¥840.00',exact:true}).waitFor();
    await history.getByRole('button',{name:'Close'}).click();
    await history.waitFor({state:'hidden'});
    await overview.locator('.ant-select-clear').click();
    await overview.getByPlaceholder('搜索项目代号、名称或品类').fill('DEMO-5');
    assert.equal(await overview.locator('tbody tr.ant-table-row').count(),1);
    await overview.getByPlaceholder('搜索项目代号、名称或品类').fill('');
    await overview.evaluate(async el => { await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{}))); });
    await page.screenshot({path:path.join(__dirname,'cost-overview-acceptance.png'),fullPage:true});
    await overview.getByRole('button',{name:/DEMO-5/}).click();
    assert.equal(await page.evaluate(()=>window.__nav),'projects');
    console.log('PASS cost overview, platform fee only, search and project navigation');
    await page.setViewportSize({width:640,height:740});
    await page.getByRole('button',{name:/巡检发现 12/}).click();
    assert.equal(await page.evaluate(()=>window.__nav),'projects');
    assert.equal(await page.evaluate(()=>localStorage.getItem('costhub-open-insights-pending')),'audit');
    await page.locator('.dashboard-production-details').click();
    await page.locator('.dashboard-production-row button').first().click();
    assert.equal(await page.evaluate(()=>window.__nav),'projects');
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'成本分布',exact:true}).click();
    assert.equal(await page.locator('.chart-bar').count(),6);
    await page.getByRole('button',{name:'下一组项目成本'}).click();
    assert.equal(await page.locator('.chart-labels').textContent(),'DEMO-7DEMO-8DEMO-9DEMO-10DEMO-11DEMO-12');
    await page.getByRole('button',{name:'下一组项目成本'}).click();
    assert.equal(await page.locator('.chart-bar').count(),1);
    assert.equal(await page.locator('.chart-labels').textContent(),'DEMO-13');
    await page.locator('.chart-bar').first().click();
    assert.equal(await page.evaluate(()=>window.__nav),'projects');
    await page.evaluate(()=>window.__render(true));
    await page.getByText('在手账录入关键成本后显示模块贡献').waitFor();
    await page.evaluate(()=>window.__spec({category:'鼠标',specs:'26000 DPI · 55g · 三模连接'}));
    await page.getByText('鼠标 · 26000 DPI · 55g · 三模连接',{exact:true}).waitFor();
    const card = page.locator('.content-card');
    const box = await card.boundingBox();
    await page.mouse.move(box.x+35,box.y+35); await page.mouse.down();
    await page.mouse.move(box.x+180,box.y+35,{steps:12});
    assert.equal(await card.evaluate(e=>getComputedStyle(e).transform),'none','Selecting text must not scale the content card');
    await page.mouse.up();
    await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.project-detail-spec'));getSelection().removeAllRanges();getSelection().addRange(range);});
    assert.equal(await page.evaluate(()=>String(getSelection())),'鼠标 · 26000 DPI · 55g · 三模连接');
    await page.evaluate(()=>window.__spec({category:'显示器',screen_size:'27英寸',resolution:'2560×1440',refresh_rate:'180Hz'}));
    await page.getByText('显示器 · 27英寸 · 2560×1440 · 180Hz',{exact:true}).waitFor();
    await page.evaluate(()=>window.__spec({category:'手写笔',specs:''}));
    await page.getByText('手写笔',{exact:true}).waitFor();
    console.log('PASS detail links, pagination, empty state, category specs and stable text selection');
  } finally {
    await browser.close();
    for(const name of ['.dashboard-layout-preview.tsx','.dashboard-layout-preview.html']) fs.unlinkSync(path.join(__dirname,name));
  }
})().catch(e=>{console.error(e);process.exitCode=1});

