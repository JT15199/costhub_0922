// Synthetic UI only. Run with Vite on port 15132; no business database or cloud calls.
const { chromium } = require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:15132/docs/insight-approval-check.html');
    const search = page.getByRole('region', { name: '公开搜索主题', exact: true });
    await search.getByRole('button', { name: '批准本次发送' }).click();
    await page.getByRole('status').filter({ hasText: '模拟授权失败' }).waitFor();
    await search.getByRole('button', { name: '批准本次发送' }).click();
    await page.getByRole('status').filter({ hasText: '已批准搜索' }).waitFor();
    const model = page.getByRole('region', { name: '公开分析完整正文', exact: true });
    if (!await model.locator('mark').count()) throw new Error('Missing sensitive highlight');
    await model.getByRole('button', { name: '批准本次发送' }).click();
    await page.getByRole('status').filter({ hasText: '已批准完整正文' }).waitFor();
    if (!await page.getByRole('region', { name: '已知内部数据禁止发送' }).getByRole('button', { name: '批准本次发送' }).isDisabled()) throw new Error('Blocked audit must remain blocked');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('PASS: search approval, retry after failure, full prompt highlight/review, blocked audit');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
