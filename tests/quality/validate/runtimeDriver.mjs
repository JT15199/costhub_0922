// Agent Runtime Stage 3.5 — 应用驱动层
//
// 从 runner 拆出（V2 要求「单文件不超过 300 行」）。
// 职责：连上真实运行的桌面应用、切 Runtime 开关、发消息、等到本轮结束。
//
// 本模块不认识"哪个 Case 断言什么"，只提供动作；断言留在 runner 里。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { connect, sleep } from '../desktop/cdpClient.mjs';
import { login } from '../desktop/actions.mjs';
import { expandAiPanel, typeInComposer } from '../desktop/actions/aiPanel.mjs';
import { readRuntimeRecorder } from './runtimeObservations.mjs';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

const ROOT = process.cwd();
const CDP_PORT = Number(process.env.STAGE35_CDP_PORT || 9333);
const RUNTIME_FLAG_KEY = 'costhub-use-agent-runtime';
/** 开发工具开关：打开后 `/runtime` 命令与 RuntimeEvent 记录器才生效（缺省关闭）。 */
const DEV_TOOLS_KEY = 'costhub-dev-tools';

/** 真实模型不是无限快：9B 在 CPU 上可能数分钟。宽松上限避免把"慢"误判成"坏"。 */
const RUN_TIMEOUT_MS = Number(process.env.STAGE35_RUN_TIMEOUT_MS || 6 * 60 * 1000);

/** 停止按钮存在 = 正在生成。 */
const STREAMING_PROBE = `Boolean(document.querySelector('.local-ai-stop-button'))`;

/**
 * 解析登录身份。
 *
 * 优先级：显式环境变量 → 夹具一次性凭据 → 应用默认账号（仅在库中密码未被改动时）。
 * **不硬编码任何口令**：默认口令从 `src/db/core.ts` 读取，仓库里只保留一处定义。
 */
export function resolveIdentity(dbPath, fixtureCredentials) {
  const envUser = process.env.STAGE35_USER;
  const envPass = process.env.STAGE35_PASSWORD;
  if (envUser && envPass) return { username: envUser, password: envPass, source: 'env' };

  if (fixtureCredentials?.username && fixtureCredentials?.password) {
    return { username: fixtureCredentials.username, password: fixtureCredentials.password, source: 'fixture' };
  }

  let username = 'admin';
  let unchanged = true;
  try {
    const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='auth_username'").get();
      if (row?.value) username = String(row.value);
      const changed = db.prepare("SELECT value FROM settings WHERE key='auth_changed'").get();
      unchanged = String(changed?.value ?? '0') !== '1';
    } finally { db.close(); }
  } catch { /* 读不到就走默认 */ }

  if (!unchanged) return null;
  const password = readDefaultPasswordFromSource();
  if (!password) return null;
  return { username, password, source: 'app-default' };
}

function readDefaultPasswordFromSource() {
  try {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'db', 'core.ts'), 'utf8');
    const match = /const\s+DEFAULT_PASSWORD\s*=\s*['"]([^'"]+)['"]/.exec(source);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** 等待 CDP 端口出现（dev 模式下 cargo 编译可能还没结束）。 */
export async function connectWithRetry(timeoutMs = 6 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      // 只挑应用页面：dev 模式下 /json/list 里还有 devtools:// 页面，
      // 默认的"第一个 page target"可能连到 devtools 上。
      // 应用在 dev 下由 Vite dev server 提供（http://localhost:5173/），
      // 打包/夹具形态下则是本地 http 服务 —— 两者都要接受。
      const client = await connect(CDP_PORT, {
        timeoutMs: 15000,
        targetFilter: target => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(String(target.url || '')),
      });
      await client.installErrorHooks();
      return client;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw new Error(`CDP never became available on ${CDP_PORT}: ${lastError?.message || lastError}`);
      await sleep(3000);
    }
  }
}

/** 确保已登录（需要时才走登录表单）。 */
export async function ensureLoggedIn(cdp, identity, log = console.log) {
  const needsLogin = await cdp.evaluate(`Boolean(document.querySelector('.login-screen'))`);
  if (!needsLogin) { log('[login] already authenticated'); return true; }
  const result = await login(cdp, identity);
  log(`[login] ${result.ok ? 'ok' : `failed: ${result.reason}`}`);
  return result.ok;
}

/** 打开/关闭 Runtime 路径开关（等价于开发构建里的 `/runtime on|off`）。 */
export async function setRuntimeFlag(cdp, enabled) {
  return cdp.evaluate(`(() => { localStorage.setItem(${JSON.stringify(RUNTIME_FLAG_KEY)}, ${enabled ? "'1'" : "'0'"}); return localStorage.getItem(${JSON.stringify(RUNTIME_FLAG_KEY)}); })()`);
}

/** 打开开发工具开关（RuntimeEvent 记录器据此生效；缺省关闭）。 */
export async function setDevTools(cdp, enabled) {
  return cdp.evaluate(`(() => { localStorage.setItem(${JSON.stringify(DEV_TOOLS_KEY)}, ${enabled ? "'1'" : "'0'"}); return localStorage.getItem(${JSON.stringify(DEV_TOOLS_KEY)}); })()`);
}

/** 重载页面，让 feature flag 在挂载时被读到；等 DOM 与主壳回来。 */
export async function reloadAndWait(cdp, timeoutMs = 60000) {
  await cdp.call('Page.reload', { ignoreCache: false }).catch(() => {});
  await sleep(1200);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ready = await cdp.evaluate(`Boolean(document.querySelector('#root') && document.querySelector('#root').childElementCount > 0)`);
      if (ready) break;
    } catch { /* 重载中偶发 evaluate 失败是正常的 */ }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
  // 重载后登录态由 sessionStorage 保持，无需再走一次登录表单
  await cdp.waitFor(
    'main shell after reload',
    async () => await cdp.evaluate(`document.querySelectorAll('.nav-item').length > 0`),
    { timeoutMs: 60000, intervalMs: 500 },
  ).catch(() => {});
  return true;
}

/**
 * 切换 Runtime 开关并让应用按新开关重新挂载。
 *
 * 为什么必须"重载 + 重新登录"：
 *   `AiPanel` 在**挂载时**读一次 feature flag（`isAgentRuntimeEnabled()`），
 *   所以改 localStorage 不会影响已经挂载的实例；必须让组件重新挂载。
 *   而本应用的登录态是 App 组件里的 React state（不持久化），
 *   任何整页重载都会回到登录页 —— 因此重载之后必须再登录一次。
 */
export async function applyRuntimeFlag(cdp, identity, enabled, log = console.log) {
  const devServer = await cdp.evaluate(`location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '5173'`).catch(() => false);
  if (!devServer) {
    log('[flag] BLOCKED: Stage 3.5 validation requires the Vite development server at localhost:5173');
    return false;
  }
  await setDevTools(cdp, true);
  await setRuntimeFlag(cdp, enabled);
  log(`[flag] ${RUNTIME_FLAG_KEY}=${enabled ? 1 : 0} · ${DEV_TOOLS_KEY}=1`);
  await reloadAndWait(cdp);
  if (!await ensureLoggedIn(cdp, identity, log)) return false;
  // 挂载完成、面板可用，才算真正切好
  const expanded = await expandAiPanel(cdp).catch(error => ({ ok: false, reason: error.message }));
  if (!expanded.ok) { log(`[panel] not available: ${expanded.reason}`); return false; }
  return true;
}

/**
 * 发送一条消息并等到本轮结束。
 *
 * 完成判定刻意**不依赖数据库**：
 *   早先版本等应用持久化的 `run_finished`，但本机开发实例并不写
 *   `local_ai_session_events`（表都不存在），于是把一次成功的运行误判成"没跑完"。
 *   现在改为看 UI 事实：出现过流式（停止按钮）→ 停止按钮消失且面板文本增长 = 本轮结束。
 *   这样判定与"模型快慢 / 是否落库"都解耦。
 */
export async function sendAndWait(cdp, dbPath, text, { budgetMs = RUN_TIMEOUT_MS } = {}) {
  const textBefore = await panelText(cdp);

  await expandAiPanel(cdp);
  const typed = await typeInComposer(cdp, text);
  if (!typed.ok) return { ok: false, reason: `composer not writable: ${typed.reason}` };

  const clicked = await cdp.evaluateJson(`(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    if (!button) return JSON.stringify({ ok: false, reason: 'send-button-not-found' });
    if (button.disabled) return JSON.stringify({ ok: false, reason: 'send-button-disabled' });
    button.click();
    return JSON.stringify({ ok: true });
  })()`);
  if (!clicked.ok) return { ok: false, reason: clicked.reason };

  const deadline = Date.now() + budgetMs;
  let sawStreaming = false;
  let samples = 0;

  for (;;) {
    await sleep(1000);
    samples += 1;

    // 轮询本身要容错：推理期间 WebView 主线程可能被占满，
    // 单次 evaluate 超时不应把整轮判定成失败（那正是早先"假超时"的来源之一）。
    let streaming;
    try {
      streaming = await cdp.evaluate(STREAMING_PROBE);
    } catch {
      continue;
    }

    if (streaming) { sawStreaming = true; continue; }
    // 只有"见过流式、现在停了"才算跑完；否则可能还没起步
    if (sawStreaming) {
      let textAfter = '';
      try { textAfter = await panelText(cdp); } catch { /* 读不到不致命 */ }
      let recorder = { available: false, types: [], events: [], gatewayTypes: [] };
      try { recorder = await readRuntimeRecorder(cdp); } catch { /* 同上 */ }
      return {
        ok: true,
        sawStreaming: true,
        elapsedMs: budgetMs - (deadline - Date.now()),
        answerAdded: textAfter.length > textBefore.length,
        samples,
        recorder,
      };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: `streaming never started within ${budgetMs}ms`, sawStreaming: false, samples };
    }
  }
}

/** 面板可读文本（用于确认回答真的渲染出来了）。 */
async function panelText(cdp) {
  return String(await cdp.evaluate(`(() => { const root = document.querySelector('.local-ai-root'); return root ? root.innerText : ''; })()`) || '');
}

export { CDP_PORT, RUNTIME_FLAG_KEY, STREAMING_PROBE };
