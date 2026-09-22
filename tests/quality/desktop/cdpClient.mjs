// Quality Harness V1 — 桌面 CDP 客户端（测试侧）
//
// 抽取自 tests/agent-upgrade/cdp-e01-upload.mjs 的连接样板，但：
//   * 不含任何业务逻辑（不点按钮、不填表单、不认识 CostHub 概念）
//   * 不保存任何真实密码（凭据由调用方以参数传入，且只允许 fixture 测试账号）
//   * 连接失败给出明确原因（端口/目标/WebView2 三类）
//   * 内置 runtime error 采集（Runtime.exceptionThrown / Log.entryAdded / console.error /
//     unhandledrejection / window.onerror）——实施指导 §10
//
// 用法：
//   const cdp = await connect(9244);
//   await cdp.evaluate('document.title');
//   cdp.runtimeErrors   // 采集到的错误数组
//   await cdp.close();

import { WebSocket } from 'ws';

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 连接到 WebView2 的 CDP 端口。
 * @param {number} port
 * @param {{timeoutMs?: number, onEvent?: (event: object) => void}} [options]
 */
export async function connect(port, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, onEvent } = options;
  const host = '127.0.0.1';
  const listUrl = `http://${host}:${port}/json/list`;

  let targets;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(listUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${listUrl}`);
    }
    targets = await response.json();
  } catch (error) {
    throw new Error(
      `CDP_CONNECT_FAILED: cannot read ${listUrl} (${error?.message || error}). ` +
        'Likely causes: CostHub.exe not running / --remote-debugging-port not applied / wrong port.',
    );
  }

  const target = Array.isArray(targets) ? targets.find(item => item.type === 'page') : null;
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      `CDP_TARGET_MISSING: no "page" target on port ${port} (found ${Array.isArray(targets) ? targets.length : 0} targets). ` +
        'The WebView2 host may not have finished creating the page yet.',
    );
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP_WS_TIMEOUT: websocket open timed out')), timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', error => { clearTimeout(timer); reject(new Error(`CDP_WS_ERROR: ${error?.message || error}`)); });
  });

  return createClient(ws, { port, onEvent });
}

function createClient(ws, { port, onEvent }) {
  let nextId = 0;
  const pending = new Map();
  const eventWaiters = new Map();
  const runtimeErrors = [];
  const runtimeWarnings = [];
  const consoleMessages = [];
  let closed = false;

  const record = entry => {
    if (entry.level === 'error') runtimeErrors.push(entry);
    else runtimeWarnings.push(entry);
  };

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.method) {
      handleEvent(message);
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

  function handleEvent(message) {
    const { method, params } = message;

    if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails || {};
      record({
        kind: 'exceptionThrown',
        level: 'error',
        text: details.exception?.description || details.text || 'unknown exception',
        url: details.url || '',
        line: details.lineNumber,
        column: details.columnNumber,
      });
    } else if (method === 'Runtime.consoleAPICalled') {
      const type = params?.type || 'log';
      const text = (params?.args || [])
        .map(arg => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || ''))
        .join(' ');
      consoleMessages.push({ type, text });
      // console.error 是 error；console.warn 是 warning；其余仅留档不计入
      if (type === 'error' || type === 'assert') {
        record({ kind: 'console.error', level: 'error', text });
      } else if (type === 'warning') {
        record({ kind: 'console.warn', level: 'warning', text });
      }
    } else if (method === 'Log.entryAdded') {
      const entry = params?.entry || {};
      // Log 域同时承载网络 404 等噪声，只有 error 级且非网络才计
      if (entry.level === 'error') {
        record({ kind: `log.${entry.source || 'unknown'}`, level: 'error', text: entry.text || '', url: entry.url || '' });
      } else {
        runtimeWarnings.push({ kind: `log.${entry.source || 'unknown'}`, level: entry.level || 'verbose', text: entry.text || '', url: entry.url || '' });
      }
    } else if (method === 'Runtime.bindingCalled') {
      // 下面安装的 __qualityRuntimeError binding 会走到这里
      if (params?.name === '__qualityRuntimeError') {
        let payload;
        try { payload = JSON.parse(params.payload); } catch { payload = { text: String(params.payload) }; }
        record({ kind: payload.kind || 'binding', level: 'error', text: payload.text || '', url: payload.url || '', line: payload.line });
      }
    }

    if (onEvent) {
      try { onEvent(message); } catch { /* 观察者失败不影响客户端 */ }
    }
  }

  ws.on('close', () => { closed = true; });
  ws.on('error', error => {
    record({ kind: 'websocket', level: 'error', text: `cdp websocket error: ${error?.message || error}` });
  });

  const call = (method, params = {}, callTimeoutMs = 30000) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error(`CDP_CLOSED: cannot call ${method}`));
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP_CALL_TIMEOUT: ${method} exceeded ${callTimeoutMs}ms`));
    }, callTimeoutMs);
    pending.set(id, {
      method,
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  /** 求值一个表达式；异常会抛出（便于测试断言失败而不是静默 undefined）。 */
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.exception?.description || details.text || 'Runtime.evaluate failed';
      const error = new Error(text);
      error.evaluateException = true;
      throw error;
    }
    return result?.result?.value;
  };

  /** 求值并返回 JSON 解析后的对象（表达式须返回 JSON 字符串）。 */
  const evaluateJson = async expression => {
    const raw = await evaluate(expression);
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  };

  const waitForEvent = (method, timeoutMs = DEFAULT_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const list = eventWaiters.get(method) || [];
    const done = event => { clearTimeout(timer); resolve(event); };
    const timer = setTimeout(() => {
      eventWaiters.set(method, (eventWaiters.get(method) || []).filter(item => item !== done));
      reject(new Error(`CDP_EVENT_TIMEOUT: ${method}`));
    }, timeoutMs);
    list.push(done);
    eventWaiters.set(method, list);
  });

  /** 轮询直到 predicate 返回真值，否则超时抛出（含最后一次观测值，便于定位）。 */
  const waitFor = async (label, predicate, { timeoutMs = 20000, intervalMs = 250 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try { last = await predicate(); } catch (error) { last = `threw: ${error?.message || error}`; }
      if (last) return last;
      if (Date.now() >= deadline) throw new Error(`CDP_WAIT_TIMEOUT: ${label} (last=${JSON.stringify(last)})`);
      await sleep(intervalMs);
    }
  };

  /** 等待 DOM 就绪且 #root 有内容（用于启动 smoke）。 */
  const waitForDom = async (timeoutMs = 40000) => waitFor(
    'DOM ready with #root content',
    async () => await evaluate('Boolean(document.body && document.querySelector("#root") && document.querySelector("#root").childElementCount > 0)'),
    { timeoutMs },
  );

  /**
   * 安装未捕获错误钩子。必须在页面脚本执行前/早期注入才完备，
   * 但对「导航之后不崩」这类断言仍然有效。
   */
  const installErrorHooks = async () => {
    await call('Runtime.enable').catch(() => {});
    await call('Log.enable').catch(() => {});
    await call('Page.enable').catch(() => {});
    // 用 binding 把 window 级错误带回 Node 侧
    await call('Runtime.addBinding', { name: '__qualityRuntimeError' }).catch(() => {});
    await evaluate(`(() => {
      if (window.__qualityHooked) return 'already';
      window.__qualityHooked = true;
      const send = payload => { try { window.__qualityRuntimeError(JSON.stringify(payload)); } catch (e) {} };
      window.addEventListener('error', event => send({ kind: 'window.onerror', text: String(event.message || event.error || 'error'), url: event.filename || '', line: event.lineno }));
      window.addEventListener('unhandledrejection', event => {
        const reason = event.reason;
        send({ kind: 'unhandledrejection', text: reason && reason.stack ? String(reason.stack) : String(reason) });
      });
      return 'installed';
    })()`);
  };

  return {
    port,
    call,
    evaluate,
    evaluateJson,
    waitForEvent,
    waitFor,
    waitForDom,
    installErrorHooks,
    get runtimeErrors() { return [...runtimeErrors]; },
    get runtimeWarnings() { return [...runtimeWarnings]; },
    get consoleMessages() { return [...consoleMessages]; },
    resetErrors() { runtimeErrors.length = 0; runtimeWarnings.length = 0; },
    get isClosed() { return closed; },
    close: () => {
      closed = true;
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 轮询等待 CDP HTTP 端点上线（应用启动后 WebView2 需要数秒才创建页面）。
 *
 * @param {number} port
 * @param {{timeoutMs?: number, intervalMs?: number, isAlive?: () => boolean}} [options]
 */
export async function waitForCdpPort(port, { timeoutMs = 60000, intervalMs = 500, isAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';

  for (;;) {
    if (isAlive && !isAlive()) {
      throw new Error(`CDP_PORT_ABORTED: process went away while waiting for port ${port}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`CDP_PORT_TIMEOUT: port ${port} not ready after ${timeoutMs}ms (last: ${lastError})`);
    }
    await sleep(intervalMs);
  }
}

/**
 * 在页面里用「原生 setter + input 事件」写入受控输入框。
 * antd 的 Input 是受控组件，直接改 .value 不会触发 React onChange。
 */
export async function typeInto(cdp, selector, text) {
  return cdp.evaluateJson(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return JSON.stringify({ ok: false, reason: 'not-found' });
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return JSON.stringify({ ok: false, reason: 'no-setter' });
    const previous = input.value;
    setter.call(input, ${JSON.stringify(text)});
    // antd/rc-input 用 _valueTracker 去重，需要回退旧值再派发，否则 onChange 不触发
    input._valueTracker?.setValue(previous);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: input.value });
  })()`);
}

/** 点击第一个匹配 selector 的元素。 */
export async function click(cdp, selector) {
  return cdp.evaluateJson(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return JSON.stringify({ ok: false, reason: 'not-found' });
    node.click();
    return JSON.stringify({ ok: true });
  })()`);
}
