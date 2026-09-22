const { chromium } = require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({ viewport: {width:1440,height:1050}, deviceScaleFactor:1 });
    const errors=[]; page.on('pageerror', error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:5173/prototypes/pi-charts-20260908/',{waitUntil:'networkidle'});
    await page.locator('.analysis-chart-card svg').first().waitFor();
    assert.equal(await page.locator('.analysis-chart-card').count(),3);
    await page.waitForTimeout(700);
    await page.screenshot({path:'prototypes/pi-charts-20260908/charts-desktop.png',fullPage:true});
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.analysis-chart-actions button').nth(1).click();
    const download = await downloadPromise;
    await download.saveAs('prototypes/pi-charts-20260908/chart-example.svg');
    await page.locator('.analysis-chart-actions button').first().click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(700);
    await page.screenshot({path:'prototypes/pi-charts-20260908/chart-expanded.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS: real chart components, SVG renderer, SVG download, expand interaction, no page errors');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
