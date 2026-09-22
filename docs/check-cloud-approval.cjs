// Run with the local Vite server on port 5179; synthetic UI only, no grants or business data.
const { chromium } = require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5179/docs/approval-card-check.html');
    await page.getByRole('button', { name: '拒绝本次' }).click();
    await page.getByRole('status').filter({ hasText: '已拒绝' }).waitFor();
    await page.getByRole('button', { name: '确认并继续' }).click();
    await page.getByRole('status').filter({ hasText: '已批准' }).waitFor();
    if (await page.locator('.ant-modal').count()) throw new Error('审批不应使用弹窗');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('窄屏溢出');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({ path: 'docs/cloud-approval-card.png', fullPage: true });
    console.log('PASS: inline approval/rejection, no modal, narrow viewport, no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
