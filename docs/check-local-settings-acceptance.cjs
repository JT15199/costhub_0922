// Run against npm run dev -- --host 127.0.0.1 --port 5188.
// Real React/Ant Design/component; only DB and Tauri/model boundaries are mocked.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      window.__settings = { local_ai_backend: 'llama.cpp', local_ai_base_url: 'http://127.0.0.1:8081', local_ai_model: 'test' };
      window.__calls = [];
      window.__TAURI_INTERNALS__ = { invoke: async (name, args) => {
        window.__calls.push(name);
        if (name === 'llama_server_start') return { running: true };
        if (name === 'llama_server_stop') return {};
        if (name === 'llama_server_status') return { running: false };
        if (name === 'http_get') return new Promise(resolve => { window.__healthResolve = resolve; });
        throw new Error('Unexpected IPC: ' + name);
      } };
    });
    await page.route(/\/src\/db\.ts(?:\?|$)/, route => route.fulfill({ contentType: 'text/javascript', body: 'export async function getSetting(k,f){return window.__settings[k] ?? f} export async function setSetting(k,v){window.__settings[k]=v}' }));
    await page.route(/\/src\/ai\/piCapability\.ts(?:\?|$)/, route => route.fulfill({ contentType: 'text/javascript', body: 'export function probePiCapability(){return new Promise(resolve=>window.__probeResolve=resolve)} export async function runLocalProductionSampleAcceptance(){return {ok:true}}' }));
    await page.route(/\/src\/ai\/piExecution\.ts(?:\?|$)/, route => route.fulfill({ contentType: 'text/javascript', body: 'export async function createPiExecutionContext(){return {}}' }));
    await page.goto('http://127.0.0.1:5188/docs/local-settings-acceptance.html');
    const base = page.getByPlaceholder('http://127.0.0.1:8080', { exact: true });
    await page.waitForFunction(() => document.querySelector('input[placeholder="http://127.0.0.1:8080"]')?.value.endsWith(':8081'));
    await page.getByPlaceholder('GGUF 模型路径（可用相对应用目录路径）').fill('models/test.gguf');
    await base.click();
    assert.equal(await base.inputValue(), 'http://127.0.0.1:8081');
    assert.equal(await page.evaluate(() => window.__settings.local_ai_base_url), 'http://127.0.0.1:8081');
    assert.equal(await page.getByPlaceholder('模型默认', { exact: true }).inputValue(), '');
    await page.getByRole('switch').click();
    await page.waitForFunction(() => Object.keys(window.__settings).some(k => k.startsWith('local_model_options:')));
    assert.equal(await page.evaluate(() => Object.entries(window.__settings).filter(([k]) => k.startsWith('local_model_options:')).some(([,v]) => 'temperature' in JSON.parse(v))), false);
    console.log('PASS: non-port blur preserves external endpoint; unrelated option does not save temperature');
    await page.getByRole('button', { name: /工具链自检/ }).click();
    await page.waitForFunction(() => !!window.__probeResolve);
    await base.fill('http://127.0.0.1:8082');
    await page.evaluate(() => window.__probeResolve({ supported: true, reason: 'OLD-ENDPOINT-PROBE' }));
    await page.getByRole('button', { name: /工具链自检/ }).waitFor();
    assert.equal(await page.getByText('OLD-ENDPOINT-PROBE').count(), 0);
    console.log('PASS: stale model probe result rejected');
    await page.getByRole('button', { name: /启动 llama.cpp/ }).click();
    await page.waitForFunction(() => !!window.__healthResolve);
    const stop = page.getByRole('button', { name: /停\s*止/ });
    assert.equal(await stop.isEnabled(), true);
    await stop.click();
    await page.getByText('llama.cpp 已停止', { exact: true }).waitFor();
    await page.evaluate(() => window.__healthResolve({ success: true, body: JSON.stringify({ data: [{ id: 'test' }] }) }));
    await page.getByRole('button', { name: /启动 llama.cpp/ }).waitFor();
    // Drain browser microtasks/render; no real server or timer is involved.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const text = await page.locator('body').innerText();
    console.log('late health after stop:', text.includes('服务可用') ? 'WRONG: ready after stop' : 'stopped');
    assert.equal(text.includes('服务可用'), false, 'A stopped server must not become ready from a late health response');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

