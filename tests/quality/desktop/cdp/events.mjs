// Quality Harness V2 — CDP 运行期错误采集
//
// 从 V1 的单个 cdpClient.mjs 中拆出（V2 要求 #「避免单文件超过 300 行」）。
// 只负责把 WebView2 抛出的异常/告警归一化成结构化条目，
// 不含任何连接与业务逻辑。
//
// 采集来源（实施指导 §10）：
//   Runtime.exceptionThrown        未捕获异常
//   Runtime.consoleAPICalled       console.error / console.assert / console.warn
//   Runtime.bindingCalled          页面侧 window.onerror / unhandledrejection 回传
//   Log.entryAdded                 浏览器日志域

/** 页面侧错误钩子的 binding 名称。 */
export const ERROR_BINDING = '__qualityRuntimeError';

/** 安装到页面里的钩子源码（幂等：用 window.__qualityHooked 去重）。 */
export const ERROR_HOOK_SOURCE = `(() => {
  if (window.__qualityHooked) return 'already';
  window.__qualityHooked = true;
  const send = payload => { try { window.${ERROR_BINDING}(JSON.stringify(payload)); } catch (e) {} };
  window.addEventListener('error', event => send({
    kind: 'window.onerror',
    text: String(event.message || event.error || 'error'),
    url: event.filename || '',
    line: event.lineno,
  }));
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    send({
      kind: 'unhandledrejection',
      text: reason && reason.stack ? String(reason.stack) : String(reason),
    });
  });
  return 'installed';
})()`;

/** 创建一个采集器。 */
export function createRuntimeCollector() {
  const errors = [];
  const warnings = [];
  const consoleMessages = [];

  const pushError = entry => errors.push(entry);
  const pushWarning = entry => warnings.push(entry);

  return {
    /** 处理一条 CDP 事件；不认识的 method 直接忽略。 */
    handle(method, params) {
      switch (method) {
        case 'Runtime.exceptionThrown': {
          const details = params?.exceptionDetails || {};
          pushError({
            kind: 'exceptionThrown',
            level: 'error',
            text: details.exception?.description || details.text || 'unknown exception',
            url: details.url || '',
            line: details.lineNumber,
            column: details.columnNumber,
          });
          break;
        }
        case 'Runtime.consoleAPICalled': {
          const type = params?.type || 'log';
          const text = (params?.args || [])
            .map(arg => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || ''))
            .join(' ');
          consoleMessages.push({ type, text });
          // console.error / assert 记为错误；warn 记为告警；其余仅留档不计入
          if (type === 'error' || type === 'assert') pushError({ kind: 'console.error', level: 'error', text });
          else if (type === 'warning') pushWarning({ kind: 'console.warn', level: 'warning', text });
          break;
        }
        case 'Log.entryAdded': {
          const entry = params?.entry || {};
          const source = entry.source || 'unknown';
          if (entry.level === 'error') {
            pushError({ kind: `log.${source}`, level: 'error', text: entry.text || '', url: entry.url || '' });
          } else {
            pushWarning({ kind: `log.${source}`, level: entry.level || 'verbose', text: entry.text || '', url: entry.url || '' });
          }
          break;
        }
        case 'Runtime.bindingCalled': {
          if (params?.name !== ERROR_BINDING) break;
          let payload;
          try {
            payload = JSON.parse(params.payload);
          } catch {
            payload = { text: String(params.payload) };
          }
          pushError({
            kind: payload.kind || 'binding',
            level: 'error',
            text: payload.text || '',
            url: payload.url || '',
            line: payload.line,
          });
          break;
        }
        default:
          break;
      }
    },

    /** 记录非 CDP 事件来源的错误（例如 websocket 自身故障）。 */
    record(kind, text) {
      pushError({ kind, level: 'error', text });
    },

    get errors() { return [...errors]; },
    get warnings() { return [...warnings]; },
    get consoleMessages() { return [...consoleMessages]; },
    reset() { errors.length = 0; warnings.length = 0; },
  };
}

/**
 * 按 allowlist 把错误分为「豁免」与「必须失败」两类。
 *
 * fail closed：allowlist 为空（或规则非法）时，所有错误都进入 blocking。
 * 这保证「配置坏了」不会意外放宽门禁。
 *
 * @param {Array<object>} errors
 * @param {{errors?: Array<{id: string, pattern: string}>}} allowlist
 */
export function splitErrors(errors, allowlist = {}) {
  const rules = Array.isArray(allowlist.errors) ? allowlist.errors : [];
  const allowed = [];
  const blocking = [];

  for (const error of errors) {
    const rule = rules.find(candidate => matchesRule(candidate, error));
    if (rule) allowed.push({ ...error, allowlistId: rule.id });
    else blocking.push(error);
  }
  return { allowed, blocking };
}

/** 统计被 allowlist 覆盖的告警数（只用于报告展示，不参与通过判定）。 */
export function countAllowlistedWarnings(warnings, allowlist = {}) {
  const rules = Array.isArray(allowlist.warnings) ? allowlist.warnings : [];
  return warnings.filter(warning => rules.some(rule => matchesRule(rule, warning))).length;
}

function matchesRule(rule, entry) {
  if (!rule || typeof rule.pattern !== 'string') return false;
  try {
    return new RegExp(rule.pattern, 'i').test(String(entry.text || ''));
  } catch {
    // 规则本身非法 → 不豁免（fail closed）
    return false;
  }
}
