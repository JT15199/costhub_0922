// Quality Harness V2 — CDP 客户端（连接 / 求值 / 等待）
//
// 从 V1 的单个 cdpClient.mjs 中拆出。只负责协议层：
// 连上 WebView2 的调试端口、发 RPC、求值表达式、等待条件成立。
// 错误采集在 ./events.mjs，端口发现与页面辅助在 ./browser.mjs。
//
// 不含任何业务逻辑（不认识 CostHub 概念），不保存任何凭据。

import { WebSocket } from 'ws';

import { ERROR_BINDING, ERROR_HOOK_SOURCE, countAllowlistedWarnings, createRuntimeCollector, splitErrors } from './events.mjs';

const DEFAULT_TIMEOUT_MS = 15000;

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 连接到 WebView2 的 CDP 端口。
 *
 * @param {number} port
 * @param {{timeoutMs?: number, onEvent?: (event: object) => void}} [options]
 */
export async function connect(port, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, onEvent } = options;
  const listUrl = `http://127.0.0.1:${port}/json/list`;

  let targets;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(listUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${listUrl}`);
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
      `CDP_TARGET_MISSING: no "page" target on port ${port} ` +
      `(found ${Array.isArray(targets) ? targets.length : 0} targets). ` +
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
  let closed = false;
  const pending = new Map();
  const eventWaiters = new Map();
  const collector = createRuntimeCollector();

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.method) {
      collector.handle(message.method, message.params);
      const waiters = eventWaiters.get(message.method) || [];
      for (const waiter of waiters) waiter(message);
      eventWaiters.delete(message.method);
      if (onEvent) {
        try { onEvent(message); } catch { /* 观察者失败不影响客户端 */ }
      }
      return;
    }

    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`${item.method}: ${message.error.message}`));
    else item.resolve(message.result);
  });

  ws.on('close', () => { closed = true; });
  ws.on('error', error => collector.record('websocket', `cdp websocket error: ${error?.message || error}`));

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

  /** 求值；页面异常会抛出（便于测试断言失败而不是静默 undefined）。 */
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      const error = new Error(details.exception?.description || details.text || 'Runtime.evaluate failed');
      error.evaluateException = true;
      throw error;
    }
    return result?.result?.value;
  };

  /** 求值并解析 JSON（表达式须返回 JSON 字符串）。 */
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

  /** 轮询直到 predicate 返回真值；超时抛出并附带最后一次观测值便于定位。 */
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

  /** 等待 DOM 就绪且 #root 有内容（启动 smoke 用）。 */
  const waitForDom = async (timeoutMs = 40000) => waitFor(
    'DOM ready with #root content',
    async () => await evaluate('Boolean(document.body && document.querySelector("#root") && document.querySelector("#root").childElementCount > 0)'),
    { timeoutMs },
  );

  /** 安装未捕获错误钩子（幂等）。 */
  const installErrorHooks = async () => {
    await call('Runtime.enable').catch(() => {});
    await call('Log.enable').catch(() => {});
    await call('Page.enable').catch(() => {});
    await call('Runtime.addBinding', { name: ERROR_BINDING }).catch(() => {});
    await evaluate(ERROR_HOOK_SOURCE);
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
    get runtimeErrors() { return collector.errors; },
    get runtimeWarnings() { return collector.warnings; },
    get consoleMessages() { return collector.consoleMessages; },
    resetErrors() { collector.reset(); },
    get isClosed() { return closed; },
    close: () => {
      closed = true;
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * 汇总运行时错误状态（含 allowlist 分类）。
 * 抽成独立函数，让 runner 与 E2E 用同一套判定口径。
 */
export function summarizeRuntime(client, allowlist) {
  const { allowed, blocking } = splitErrors(client.runtimeErrors, allowlist);
  return {
    runtimeErrors: blocking.length,
    runtimeAllowedErrors: allowed.length,
    runtimeWarnings: client.runtimeWarnings.length,
    allowlistedWarnings: countAllowlistedWarnings(client.runtimeWarnings, allowlist),
    blockingErrors: blocking.map(error => ({ kind: error.kind, text: String(error.text || '').slice(0, 600) })),
  };
}
