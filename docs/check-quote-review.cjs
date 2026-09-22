// Browser fixtures only: no business database is opened or changed.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const entry = path.resolve('__quote-review-check.tsx');
(async () => {
  assert(!fs.existsSync(entry));
  fs.writeFileSync(entry, `import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './src/components/QuoteReviewWorkspace'; createRoot(document.getElementById('root')!).render(<Workspace projectId={1} project={{name:'显示器'}} projects={[{id:1,name:'显示器'},{id:2,name:'供应商B'}]}><div>高级内容测试</div></Workspace>);`);
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    const errors=[]; page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
    await page.route('**/src/db.ts*', route=>route.fulfill({contentType:'application/javascript',body:`
      const line = (cost) => ({module_name:'面板',quantity:1,price_state:'confirmed',line_total:cost});
      let rounds=[{id:12,status:'frozen',version_no:2,version_name:'报价 R2',total_cost:110},{id:11,status:'frozen',version_no:1,version_name:'报价 R1',total_cost:100}], actions=[];
      export async function getCostLayerSummary(){return {rows:[line(120)],missingCostRows:[],standardCost:120,layers:{material:120,packaging:0,odm_processing:0},platformFee:0};}
      export async function getProjectBOMVersions(id){return id===1?rounds:[{id:21,status:'frozen',version_no:1,version_name:'B报价',total_cost:90}];}
      export async function getProjectBOMVersionLines(id){return [line(id===11?100:id===12?110:90)];}
      export async function getMeasures(){return actions;}
      export async function saveMeasure(data){if(data.id) actions=actions.map(a=>a.id===data.id?data:a);else actions.push({...data,id:1});window.testActions=actions;}
      export async function freezeProjectBOMVersion(id,data){rounds=[{id:13,status:'frozen',version_no:3,version_name:data.versionName,total_cost:120},...rounds];window.testRounds=rounds;}
    `}));
    await page.route('**/__quote-review-check', route=>route.fulfill({contentType:'text/html',body:`<div id="root" style="max-width:1180px;margin:24px auto"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__quote-review-check.tsx"></script>`}));
    await page.goto('http://127.0.0.1:5173/__quote-review-check');
    await page.getByText('高于参考',{exact:true}).waitFor({timeout:10000}).catch(async e=>{console.log(await page.locator('body').innerText());throw e;});
    assert.equal(await page.getByText('高级内容测试').count(),0);
    await page.getByRole('button',{name:'记入跟进'}).click();
    await page.getByRole('button',{name:'保存跟进',exact:true}).click();
    await page.getByRole('button',{name:'更新跟进'}).waitFor();
    assert.equal(await page.evaluate(()=>window.testActions.length),1);
    await page.getByRole('button',{name:'更新跟进'}).click();
    await page.getByLabel('报价依据 / 供应商反馈').fill('供应商确认下轮更新价格');
    await page.getByRole('button',{name:'保存跟进',exact:true}).click();
    await page.locator('.ant-modal').filter({hasText:'更新谈价跟进'}).waitFor({state:'hidden'}); await page.locator('.quote-review-feedback').filter({hasText:'供应商确认下轮更新价格'}).waitFor();
    assert.equal(await page.evaluate(()=>window.testActions.length),1);
    await page.locator('.quote-review-workspace button').filter({hasText:'保存本轮报价'}).click();
    await page.getByLabel('报价轮次名称').fill('A供应商 R3');
    await page.getByRole('button',{name:'保存报价',exact:true}).click();
    await page.getByRole('button',{name:'A供应商 R3 · ¥120.00',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.testRounds.length),3);
    await page.getByLabel('参考项目').click();
    await page.locator('.ant-select-item-option').filter({hasText:'供应商B'}).click();
    await page.getByText('+¥30.00',{exact:true}).waitFor();
    await page.getByRole('button',{name:'报价 R1 · ¥100.00',exact:true}).click();
    await page.getByText('+¥20.00',{exact:true}).waitFor();
    await page.getByText('高级策划 · 产品规格、费用参数与目标成本',{exact:true}).click();
    await page.getByText('高级内容测试').waitFor();
    assert.deepEqual(errors,[]);
    await page.screenshot({path:'docs/quote-review-check.png',fullPage:true});
    console.log('PASS: compact view, saved rounds, comparison source switching, follow-up create/update, advanced collapse');
  } finally {await browser.close();fs.unlinkSync(entry);}
})().catch(e=>{console.error(e);process.exitCode=1;});





