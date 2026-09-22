import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || 9244);
const fixtureDir = path.resolve(process.argv[3] || 'artifacts/agent-upgrade/20260911-final11-e01-upload');
const requestedModel = process.argv[4] || '';
const output = path.join(fixtureDir, 'cdp-upload-run.json');
const files = [
  path.resolve('tests/agent-upgrade/fixtures/quote-rounds.csv'),
  path.resolve('tests/agent-upgrade/fixtures/quote-rounds.xlsx'),
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error(`CDP page not found on ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const eventWaiters = new Map();
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method) {
      events.push(message);
      for (const waiter of eventWaiters.get(message.method) || []) waiter(message);
      eventWaiters.delete(message.method);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`${item.method}: ${message.error.message}`));
    else item.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result?.value;
  };
  const waitForEvent = (method, timeoutMs = 12000) => new Promise((resolve, reject) => {
    const existing = events.find(event => event.method === method);
    if (existing) return resolve(existing);
    const list = eventWaiters.get(method) || [];
    const done = event => { clearTimeout(timer); resolve(event); };
    const timer = setTimeout(() => {
      const current = eventWaiters.get(method) || [];
      eventWaiters.set(method, current.filter(item => item !== done));
      reject(new Error(`timeout waiting for CDP event ${method}`));
    }, timeoutMs);
    list.push(done);
    eventWaiters.set(method, list);
  });
  return { call, evaluate, waitForEvent, close: () => ws.close() };
}

async function waitFor(label, check, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

const result = {
  mode: 'desktop-live-model-real-upload',
  fixtureOnly: true,
  formalDatabaseTouched: false,
  identity: 'agent-test (isolated fixture only)',
  model: 'unknown until UI probe',
  files,
  manualIntervention: false,
  confirmationClicks: 0,
  pollSamples: [],
};

for (const file of files) if (!fs.existsSync(file)) throw new Error(`missing fixture file: ${file}`);

const cdp = await connect();
try {
  await waitFor('page DOM', async () => await cdp.evaluate('Boolean(document && document.body)'), 30000);
  console.log('stage beforeLogin');
  result.beforeLogin = await cdp.evaluate(`JSON.stringify({url:location.href, text:(document.body?.innerText || '').slice(0,800)})`);
  console.log('stage login');
  await waitFor('login inputs', async () => await cdp.evaluate('Boolean(document.querySelector(\'input[type="password"]\'))'), 30000);
  result.login = JSON.parse(await cdp.evaluate(`JSON.stringify((() => {
    const inputs = [...document.querySelectorAll('input')];
    const username = inputs.find(input => input.type !== 'password');
    const password = inputs.find(input => input.type === 'password');
    return { ok: Boolean(username && password), inputs: inputs.map(input => ({ type: input.type, placeholder: input.placeholder })) };
  })())`));
  const typeInto = async (selector, text) => {
    return cdp.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return { ok: false };
      const old = input.value;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(text)});
      input._valueTracker?.setValue(old);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: input.value };
    })()`);
  };
  console.log(`typedUsername ${JSON.stringify(await typeInto('input:not([type="password"])', 'agent-test'))}`);
  console.log(`typedPassword ${JSON.stringify(await typeInto('input[type="password"]', 'agent-test-666'))}`);
  console.log(`typedLogin ${await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('input')].map(input => ({ type: input.type, value: input.value })))` )}`);
  result.login.clicked = await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => /登/.test(item.innerText) || item.className.includes('login')); button?.click(); return Boolean(button); })()`);
  await sleep(1200);
  console.log(`loginProbe ${await cdp.evaluate(`JSON.stringify({ url: location.href, text: document.body.innerText.slice(0, 1800), inputs: [...document.querySelectorAll('input')].map(input => ({ type: input.type, value: input.value, placeholder: input.placeholder })), buttons: [...document.querySelectorAll('button')].slice(0, 12).map(button => ({ text: button.innerText, cls: String(button.className) })) })` )}`);
  await waitFor('AI composer after login', async () => await cdp.evaluate('Boolean(document.querySelector(\'.local-ai-composer\'))'), 30000);
  console.log('stage afterLogin');
  result.afterLogin = await cdp.evaluate(`JSON.stringify({text:document.body.innerText.slice(0,1200), inputs:[...document.querySelectorAll('input')].map(input => ({type:input.type,placeholder:input.placeholder}))})`);

  console.log('stage model');
  result.model = await cdp.evaluate(`(() => {
    const text = document.body.innerText;
    const select = document.querySelector('[aria-label="选择本地模型"]');
    return select?.value || document.querySelector('.local-ai-model-control')?.innerText || text.match(/(qwen3:[^\\s\\n]+|qwythos-[^\\s\\n]+|openbmb[^\\s\\n]+)/)?.[1] || 'unknown';
  })()`);
  if (requestedModel && !String(result.model).includes(requestedModel)) {
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[aria-label="选择本地模型"]');
      const select = input?.closest('.ant-select')
        || [...document.querySelectorAll('.ant-select')].find(node => /qwen|openbmb|qwythos/i.test(node.innerText));
      const target = select?.querySelector('.ant-select-selector') || select;
      if (!target) return { opened: false, selects: [...document.querySelectorAll('.ant-select')].length };
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.click();
      return { opened: true, text: select.innerText };
    })()`);
    await sleep(250);
    await waitFor('requested model option', async () => await cdp.evaluate(`Boolean([...document.querySelectorAll('.ant-select-item-option')].find(item => item.innerText.includes(${JSON.stringify(requestedModel)})))`));
    await cdp.evaluate(`(() => { const item = [...document.querySelectorAll('.ant-select-item-option')].find(node => node.innerText.includes(${JSON.stringify(requestedModel)})); item?.click(); return Boolean(item); })()`);
    await sleep(800);
    result.model = await cdp.evaluate(`(() => document.querySelector('[aria-label="选择本地模型"]')?.value || ${JSON.stringify(requestedModel)})()`);
  }

  console.log('stage upload');
  await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  result.uploaded = 0;
  for (const file of files) {
    result.paperclip = JSON.parse(await cdp.evaluate(`JSON.stringify((() => {
      const composer = document.querySelector('.local-ai-composer');
      const icon = composer?.querySelector('.anticon-paper-clip');
      const button = icon?.closest('button')
        || composer?.querySelector('button[title*="附加"]')
        || composer?.querySelectorAll('button').item(1)
        || [...document.querySelectorAll('button')].find(item => item.title?.includes('附加文件'));
      button?.click();
      return { clicked: Boolean(button), fileInputs: document.querySelectorAll('input[type="file"]').length, composer: Boolean(composer), buttons: [...(composer?.querySelectorAll('button') || [])].map(item => ({ title: item.title, text: item.innerText, cls: String(item.className) })) };
    })())`));
    console.log(`paperclip ${JSON.stringify(result.paperclip)}`);
    await waitFor('file input', async () => Number(await cdp.evaluate('document.querySelectorAll(\'input[type="file"]\').length')) > 0);
    const documentResult = await cdp.call('DOM.getDocument', { depth: -1 });
    const fileInput = await cdp.call('DOM.querySelector', { nodeId: documentResult.root.nodeId, selector: 'input[type="file"]' });
    if (!fileInput.nodeId) throw new Error('file input node not found');
    const beforeCount = Number(await cdp.evaluate('document.querySelectorAll(\'.local-ai-attachment\').length'));
    await cdp.call('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [file] });
    await sleep(800);
    const afterSetCount = Number(await cdp.evaluate('document.querySelectorAll(\'.local-ai-attachment\').length'));
    if (afterSetCount <= beforeCount) await cdp.evaluate(`(() => { const input = document.querySelector('input[type="file"]'); input?.dispatchEvent(new Event('change', { bubbles: true })); return Boolean(input); })()`);
    result.uploaded = await waitFor(`attachment chip ${path.basename(file)}`, async () => {
      const count = Number(await cdp.evaluate('document.querySelectorAll(\'.local-ai-attachment\').length'));
      return count > result.uploaded ? count : 0;
    }, 30000);
  }

  console.log('stage send');
  const prompt = '比较附件的两轮报价，核对变化和不能直接比较的地方，给我一份谈价材料和明细表。先不要写入项目数据库。';
  result.prompt = prompt;
  await waitFor('composer input', async () => await cdp.evaluate('Boolean(document.querySelector(\'input[placeholder*=直接说]\'))'));
  await cdp.evaluate(`(() => { const input = document.querySelector('input[placeholder*="直接说"]'); input?.focus(); return Boolean(input); })()`);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA' });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA' });
  await cdp.call('Input.insertText', { text: prompt });
  result.send = await cdp.evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="直接说"]');
    const buttons = [...(input?.parentElement?.querySelectorAll('button') || [])];
    const button = buttons.at(-1) || [...document.querySelectorAll('button')].find(item => item.querySelector('svg'));
    button?.click();
    return 'clicked:' + Boolean(button);
  })()`);

  console.log('stage poll');
  const runDeadline = Date.now() + 420000;
  let seenStreaming = false;
  while (Date.now() < runDeadline) {
    const state = await cdp.evaluate(`(() => {
      const text = document.body.innerText;
      const input = document.querySelector('input');
      const pendingWrite = document.querySelector('.local-ai-write-confirm');
      const pendingAsk = document.querySelector('.local-ai-ask');
      return JSON.stringify({
        text: text.slice(-2500),
        streaming: Boolean(document.querySelector('input[placeholder*="执行中"]')),
        pendingWrite: Boolean(pendingWrite),
        pendingAsk: Boolean(pendingAsk),
        confirm: pendingWrite ? pendingWrite.innerText : '',
        inputPlaceholder: input?.placeholder || '',
      });
    })()`);
    const parsed = JSON.parse(state);
    result.pollSamples.push({ at: new Date().toISOString(), ...parsed });
    if (parsed.streaming) seenStreaming = true;
    if (parsed.pendingWrite && /执行写入/.test(parsed.confirm)) {
      const clicked = await cdp.evaluate(`(() => {
        const root = document.querySelector('.local-ai-write-confirm');
        const button = [...(root?.querySelectorAll('button') || [])].find(item => item.innerText.includes('执行写入'));
        button?.click();
        return Boolean(button);
      })()`);
      if (clicked) result.confirmationClicks += 1;
    }
    if (seenStreaming && !parsed.streaming && !parsed.pendingWrite && !parsed.pendingAsk) {
      result.finished = true;
      break;
    }
    await sleep(4000);
  }
  result.finalUi = await cdp.evaluate(`JSON.stringify({text:document.body.innerText.slice(-12000), streaming:Boolean(document.querySelector('input[placeholder*="执行中"]'))})`);
} finally {
  cdp.close();
}

fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, model: result.model, uploaded: result.uploaded, finished: result.finished, confirmationClicks: result.confirmationClicks }, null, 2));
