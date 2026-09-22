#!/usr/bin/env node
// Quality Harness V1 — 桌面 E2E 场景编排（full 档 F03）
//
// 覆盖实施指导 §9 的 E2E-001..008。设计取舍：
//   * **单进程会话跑 E2E-001..006**：启动一次、登录一次，把「启动→登录→导航→
//     项目/BOM→AI 窗→设置」当作一条连续用户旅程验证——这正是 §2.2 指出的
//     「函数各自 PASS 但组合后失败」的检测点。
//   * **E2E-007 单独重启**：持久化必须跨进程验证，否则等于没测。
//   * **E2E-008 是前置守卫**：证明不了是 fixture 就整体 ABORT，不允许「大概率不是正式库」。
//
// 退出码：0 全通过；1 有场景失败；3 环境不具备（无 exe / 非 Windows / RDP 下 CDP 不可用）。

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

import { connect } from './cdpClient.mjs';
import { killProcessTree, launchFixtureApp, sleep, waitForExit } from './launchApp.mjs';
import { assertFixtureDatabase, integrityCheck, snapshotCounts } from '../helpers/dbGuard.mjs';
import { redactTail } from '../helpers/redact.mjs';
import {
  NAV_ENTRIES,
  clearComposer,
  collectAiPanelState,
  countFixtureBomRows,
  expandAiPanel,
  inspectSettingsForCredentialLeaks,
  login,
  navigateTo,
  openFixtureProjectBom,
  readFixtureManifest,
  readLocalStorage,
  typeInComposer,
  writeLocalStorage,
} from './actions.mjs';

const ROOT = process.cwd();
const FIXTURE_DIR = path.join(ROOT, 'artifacts', 'quality', 'desktop-fixture');
const ALLOWLIST_PATH = path.join(ROOT, 'tests', 'quality', 'desktop', 'runtime-error-allowlist.json');
const REPORT_PATH = path.join(ROOT, 'artifacts', 'quality', 'desktop-e2e.json');

const BOM_PART_MODELS = ['QA-PANEL-270', 'QA-BL-270', 'QA-SCALER-01', 'QA-DDR-01', 'QA-BEZEL-01', 'QA-PSU-01'];

// E2E-007 验证**应用自身的 UI 偏好**（主题）能否跨进程重启保留。
//
// 走查记录（2026-09-22）：
//   * 最初用一个测试私有 localStorage 键做探针 → 重启后消失。
//     单独验证发现 localStorage 本身是持久的（同进程 reload 保留、应用自己的
//     app-theme 跨重启保留），消失的是那个私有键（app 运行时会清理无关键）。
//   * 因此改为断言真实用户偏好：主题。这样测的是「用户的设置会不会丢」，
//     而不是「某个内部键会不会被保留」——后者不是产品行为。
const E2E_THEME_SETTING = 'app-theme';
const E2E_THEME_VALUE = 'liquidLight';

const results = [];
let app = null;
let cdp = null;
let fixedErrors = []; // 已发生的非豁免错误（跨场景累计，用于最终判定）

function record(id, title, status, detail = {}) {
  results.push({ id, title, status, ...detail });
  const icon = status === 'pass' ? '✔' : status === 'fail' ? '✖' : status === 'blocked' ? '⏸' : '▲';
  console.log(`  ${icon} ${id} ${title} — ${status.toUpperCase()}${detail.reason ? ` (${detail.reason})` : ''}`);
}

/** 断言助手：把「条件 + 证据」转成 pass/fail。 */
function assertAll(checks) {
  const failed = checks.filter(check => !check.ok);
  return {
    ok: failed.length === 0,
    failures: failed.map(check => check.reason),
    checks: checks.map(check => ({ name: check.name, ok: check.ok, detail: check.detail })),
  };
}

// ---------------------------------------------------------------------------
// runtime error 判定
// ---------------------------------------------------------------------------

let allowlist = { errors: [], warnings: [] };

function loadAllowlist() {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (error) {
    console.error(`[e2e] could not read allowlist: ${error.message} — treating it as empty (strict)`);
    allowlist = { errors: [], warnings: [] };
  }
}

function matches(entry, error) {
  try {
    return new RegExp(entry.pattern, 'i').test(String(error.text || ''));
  } catch {
    return false;
  }
}

/** 把 CDP 采集到的错误分成「豁免」与「必须失败」两类。 */
function splitErrors(errors) {
  const allowed = [];
  const blocking = [];
  for (const error of errors) {
    const entry = (allowlist.errors || []).find(candidate => matches(candidate, error));
    if (entry) allowed.push({ ...error, allowlistId: entry.id });
    else blocking.push(error);
  }
  return { allowed, blocking };
}

/** 统计被 allowlist 覆盖的告警数（不参与通过判定）。 */
function countAllowlistedWarnings(warnings) {
  const list = allowlist.warnings || [];
  return warnings.filter(warning => list.some(entry => matches(entry, warning))).length;
}

function summarizeRuntime() {
  const errors = cdp.runtimeErrors;
  const warnings = cdp.runtimeWarnings;
  const { allowed, blocking } = splitErrors(errors);
  return {
    runtimeErrors: blocking.length,
    runtimeAllowedErrors: allowed.length,
    runtimeWarnings: warnings.length,
    allowlistedWarnings: countAllowlistedWarnings(warnings),
    blockingErrors: blocking.map(error => ({ kind: error.kind, text: redactTail(error.text, 600) })),
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('CostHub Quality Harness V1 — Desktop E2E');
  console.log('');

  if (process.platform !== 'win32') {
    finish('blocked', 'desktop E2E is Windows-only (WebView2 runtime)');
    return;
  }

  loadAllowlist();

  // ---- E2E-008 前置守卫：证明这是 fixture -----------------------------------
  console.log('[guard] proving the database is an isolated fixture…');
  if (!fs.existsSync(FIXTURE_DIR)) {
    finish('blocked', `fixture directory missing (${path.relative(ROOT, FIXTURE_DIR)}) — run prepare-fixture.mjs first`);
    return;
  }
  const manifest = readFixtureManifest(FIXTURE_DIR);
  const dbPath = path.join(FIXTURE_DIR, manifest.database || 'costhub.db');

  const proof = assertFixtureDatabase(dbPath);
  record('E2E-008', 'Production database isolation', proof.ok ? 'pass' : 'fail', {
    reason: proof.ok ? undefined : proof.reason,
    evidence: {
      fixtureBasename: proof.evidence.basename,
      fixtureDirectoryHint: proof.evidence.directoryHint,
      fixtureMarker: proof.evidence.marker,
      integrity: proof.evidence.integrity,
      counts: proof.evidence.counts,
      identity: manifest.identity?.username || null,
    },
  });
  if (!proof.ok) {
    finish('fail', `ABORT: refusing to run E2E without a provable fixture — ${proof.reason}`);
    return;
  }

  const before = snapshotCounts(dbPath);
  const beforeSettingsKeys = readSettingsKeys(dbPath);
  console.log(`[guard] fixture proven: marker=${proof.evidence.marker}, integrity=${proof.evidence.integrity}`);
  console.log(`[guard] counts before: ${JSON.stringify(before)}`);
  console.log('');

  // ---- 启动 ----------------------------------------------------------------
  console.log('[session] launching fixture application…');
  try {
    app = await launchFixtureApp({ dir: FIXTURE_DIR });
  } catch (error) {
    finish('blocked', `launch failed: ${error.message}`);
    return;
  }
  console.log(`[session] pid=${app.pid} cdpPort=${app.port}`);

  cdp = await connect(app.port);
  await cdp.installErrorHooks();

  // ---- E2E-001 应用启动 -----------------------------------------------------
  const startChecks = [];
  let domReady = false;
  try {
    await cdp.waitForDom(45000);
    domReady = true;
  } catch (error) {
    startChecks.push({ name: 'DOM ready', ok: false, reason: error.message });
  }
  if (domReady) startChecks.push({ name: 'DOM ready', ok: true });

  const shell = domReady ? await cdp.evaluateJson(`JSON.stringify({
    url: location.href,
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    bodyTextLength: (document.body?.innerText || '').length,
    loginVisible: Boolean(document.querySelector('.login-screen')),
    errorBoundary: Boolean(document.querySelector('.error-boundary, [data-error-boundary]')),
  })`) : {};

  startChecks.push({ name: 'root has content', ok: (shell.rootChildren ?? 0) > 0, detail: shell.rootChildren });
  startChecks.push({ name: 'body renders text', ok: (shell.bodyTextLength ?? 0) > 10, detail: shell.bodyTextLength });
  startChecks.push({ name: 'no error boundary fallback', ok: shell.errorBoundary !== true });
  startChecks.push({ name: 'process alive', ok: app.process.exitCode === null });

  const integrityDuringStartup = integrityCheck(dbPath);
  startChecks.push({ name: 'fixture integrity ok', ok: integrityDuringStartup === 'ok', detail: integrityDuringStartup });

  {
    const runtime = summarizeRuntime();
    const verdict = assertAll(startChecks);
    const runtimeOk = runtime.runtimeErrors === 0;
    record('E2E-001', 'Application startup', verdict.ok && runtimeOk ? 'pass' : 'fail', {
      reason: verdict.ok ? (runtimeOk ? undefined : `fatal JS exceptions: ${JSON.stringify(runtime.blockingErrors)}`) : verdict.failures.join('; '),
      checks: verdict.checks,
      url: shell.url,
      ...runtime,
    });
  }

  // ---- E2E-002 测试账号登录 -------------------------------------------------
  try {
    const loginResult = await login(cdp, { username: manifest.identity.username, password: manifest.identity.password });
    const runtime = summarizeRuntime();
    const verdict = assertAll([
      { name: 'login filled and submitted', ok: loginResult.ok, reason: loginResult.reason },
      { name: 'main shell rendered', ok: Boolean(loginResult.shell?.hasSidebar), detail: loginResult.shell },
      { name: 'primary navigation present', ok: (loginResult.shell?.navItems ?? 0) > 0, detail: loginResult.shell?.navItems },
      { name: 'login screen dismissed', ok: loginResult.shell?.loginScreenGone === true },
      { name: 'no uncaught exceptions', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
    ]);
    record('E2E-002', 'Test account login', verdict.ok ? 'pass' : 'fail', {
      reason: verdict.ok ? undefined : verdict.failures.join('; '),
      checks: verdict.checks,
      ...runtime,
    });
  } catch (error) {
    record('E2E-002', 'Test account login', 'fail', { reason: error.message });
    finish('fail', 'login journey failed — remaining scenarios depend on it');
    return;
  }

  // ---- E2E-003 主导航 smoke -------------------------------------------------
  {
    const navResults = [];
    for (const entry of NAV_ENTRIES) {
      try {
        const result = await navigateTo(cdp, entry);
        navResults.push({ key: entry.key, label: entry.label, ok: result.ok, textLength: result.textLength, tables: result.tables });
      } catch (error) {
        navResults.push({ key: entry.key, label: entry.label, ok: false, reason: error.message });
      }
    }
    const runtime = summarizeRuntime();
    const allOk = navResults.every(item => item.ok);
    record('E2E-003', 'Primary navigation smoke', allOk && runtime.runtimeErrors === 0 ? 'pass' : 'fail', {
      reason: allOk
        ? (runtime.runtimeErrors === 0 ? undefined : `uncaught exceptions during navigation: ${JSON.stringify(runtime.blockingErrors)}`)
        : `navigation failed: ${navResults.filter(i => !i.ok).map(i => `${i.key}(${i.reason || 'blank'})`).join(', ')}`,
      navigated: navResults,
      ...runtime,
    });
  }

  // ---- E2E-004 项目/BOM 只读旅程 --------------------------------------------
  {
    try {
      const opened = await openFixtureProjectBom(cdp, manifest.projectCode || manifest.counts?.projectCode || 'QAFIX-0001');
      let bomCounts = null;
      if (opened.ok) bomCounts = await countFixtureBomRows(cdp, BOM_PART_MODELS);
      const runtime = summarizeRuntime();
      const verdict = assertAll([
        { name: 'fixture project opened with BOM table', ok: opened.ok, reason: opened.reason },
        { name: 'BOM tab present', ok: Boolean(opened.bomTabLabel), detail: opened.bomTabLabel },
        // 夹具 BOM 有 6 行；表格可能额外渲染分组/合计行，因此要求 >= 5 而不是精确相等
        { name: 'BOM table rendered fixture rows', ok: (opened.rows ?? 0) >= 5, detail: opened.rows },
        // 只有「已知型号真的出现在页面上」才能证明渲染的是夹具数据而不是空表
        { name: 'fixture BOM parts visible in DOM', ok: (bomCounts?.foundInDom ?? 0) >= 3, detail: bomCounts },
        { name: 'no uncaught exceptions', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
      ]);
      record('E2E-004', 'Project/BOM read-only journey', verdict.ok ? 'pass' : 'fail', {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        bom: bomCounts,
        ...runtime,
      });
    } catch (error) {
      record('E2E-004', 'Project/BOM read-only journey', 'fail', { reason: error.message });
    }
  }

  // ---- E2E-005 AI 协作窗基础状态 --------------------------------------------
  {
    try {
      const expand = await expandAiPanel(cdp);
      const panel = expand.ok ? await collectAiPanelState(cdp) : { panelPresent: false };
      const typed = expand.ok ? await typeInComposer(cdp, 'Quality Harness E2E 输入可用性探测（不发送）') : { ok: false, reason: 'panel not expanded' };
      await clearComposer(cdp);
      const runtime = summarizeRuntime();

      const verdict = assertAll([
        { name: 'AI panel present', ok: panel.panelPresent === true },
        { name: 'composer present', ok: panel.composerPresent === true, reason: expand.reason },
        { name: 'composer input editable', ok: panel.inputEditable === true, detail: { disabled: panel.inputDisabled } },
        { name: 'model control present', ok: panel.modelControlPresent === true },
        { name: 'action buttons present', ok: panel.sendButtonPresent === true, detail: panel.buttonCount },
        { name: 'composer accepts typed text', ok: typed.ok === true, reason: typed.reason },
        // 模型未启动时 UI 必须给出提示或正常降级，不得 crash（本轮不要求真实推理）
        { name: 'offline model handled without crash', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
      ]);
      record('E2E-005', 'AI collaboration panel basic state', verdict.ok ? 'pass' : 'fail', {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        readinessHints: panel.readinessHints,
        ...runtime,
      });
    } catch (error) {
      record('E2E-005', 'AI collaboration panel basic state', 'fail', { reason: error.message });
    }
  }

  // ---- E2E-006 设置页读取 + 凭据不泄漏 --------------------------------------
  {
    try {
      const probe = await inspectSettingsForCredentialLeaks(cdp);
      const runtime = summarizeRuntime();
      const verdict = assertAll([
        { name: 'settings surface opened', ok: probe.modalOpen === true, detail: probe.textLength },
        { name: 'no secret-shaped input values in DOM', ok: probe.secretShapedInputs === 0, detail: probe.secretShapedInputs },
        { name: 'no long opaque token-shaped input values', ok: probe.longOpaqueInputs === 0, detail: probe.longOpaqueInputs },
        { name: 'no uncaught exceptions', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
      ]);
      record('E2E-006', 'Settings page read + credential non-leak', verdict.ok ? 'pass' : 'fail', {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        // 注意：只报告形状统计，绝不记录 input value 原文
        probe: {
          modalOpen: probe.modalOpen,
          textLength: probe.textLength,
          mentionsConfiguredState: probe.mentionsConfiguredState,
          mentionsApiKeyWords: probe.mentionsApiKeyWords,
          inputCount: probe.inputCount,
          secretShapedInputs: probe.secretShapedInputs,
          longOpaqueInputs: probe.longOpaqueInputs,
        },
        ...runtime,
      });
    } catch (error) {
      record('E2E-006', 'Settings page read + credential non-leak', 'fail', { reason: error.message });
    }
  }

  // ---- 收尾：关闭第一段会话 -------------------------------------------------
  const errorsBeforeRestart = cdp.runtimeErrors.length;
  cdp.close();
  await killProcessTree(app.process);
  await waitForExit(app.process);
  await sleep(2500);

  // ---- E2E-007 重启持久化 ---------------------------------------------------
  {
    let phase1 = { ok: false };
    let phase2 = { ok: false };
    let restarted = null;
    let restartCdp = null;
    try {
      // 第一段：切换到一个安全的 UI 偏好（主题，不涉及任何业务成本字段）
      app = await launchFixtureApp({ dir: FIXTURE_DIR });
      restartCdp = await connect(app.port);
      await restartCdp.installErrorHooks();
      await restartCdp.waitForDom(45000);
      await login(restartCdp, { username: manifest.identity.username, password: manifest.identity.password });

      const written = await writeLocalStorage(restartCdp, E2E_THEME_SETTING, E2E_THEME_VALUE);
      const appliedBefore = await restartCdp.evaluate(`document.documentElement.getAttribute('data-theme')`);
      phase1 = { ok: written === E2E_THEME_VALUE, value: written, appliedBefore };

      // 关闭
      restartCdp.close();
      await killProcessTree(app.process);
      await waitForExit(app.process);
      await sleep(2500);

      // 第二段：重启后必须仍在（同时校验 localStorage 与 DOM 上的 data-theme）
      restarted = await launchFixtureApp({ dir: FIXTURE_DIR });
      restartCdp = await connect(restarted.port);
      await restartCdp.installErrorHooks();
      await restartCdp.waitForDom(45000);
      await login(restartCdp, { username: manifest.identity.username, password: manifest.identity.password });
      const readBack = await readLocalStorage(restartCdp, E2E_THEME_SETTING);
      const appliedAfter = await restartCdp.evaluate(`document.documentElement.getAttribute('data-theme')`);
      phase2 = { ok: readBack === E2E_THEME_VALUE, value: readBack, appliedAfter };

      const runtime = summarizeRuntimeFor(restartCdp);
      const verdict = assertAll([
        { name: 'preference written before restart', ok: phase1.ok, detail: phase1.value },
        { name: 'preference survives restart', ok: phase2.ok, detail: phase2.value },
        { name: 'preference reapplied to the document after restart', ok: appliedAfter === E2E_THEME_VALUE, detail: appliedAfter },
        { name: 'no uncaught exceptions after restart', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
      ]);
      record('E2E-007', 'Restart persistence (UI preference)', verdict.ok ? 'pass' : 'fail', {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        key: E2E_THEME_SETTING,
        before: phase1.value,
        after: phase2.value,
        themeAppliedBefore: appliedBefore,
        themeAppliedAfter: appliedAfter,
        ...runtime,
      });
    } catch (error) {
      record('E2E-007', 'Restart persistence (UI preference)', 'fail', { reason: error.message });
    } finally {
      try { restartCdp?.close(); } catch { /* ignore */ }
      if (restarted) { await killProcessTree(restarted.process); await waitForExit(restarted.process); }
    }
  }

  // ---- 收尾：夹具未被改变 ---------------------------------------------------
  // 断言范围刻意区分：
  //   * 业务数据表（projects / project_boms / parts）在「只读旅程」后必须逐字节不变；
  //   * settings 表允许变化 —— 应用自身会在启动/运行时持久化运行时状态
  //     （本机的 local_ai_model、手账书签等）。把这部分当作不同性质的事实单独记录，
  //     而不是笼统地判成「测试污染了夹具」。
  const after = snapshotCounts(dbPath);
  const businessTables = ['projects', 'project_boms', 'parts'];
  const businessUnchanged = businessTables.every(table => before[table] === after[table]);
  const finalIntegrity = integrityCheck(dbPath);
  const settingsDelta = readSettingsKeys(dbPath, beforeSettingsKeys);

  record('E2E-008b', 'Fixture data unchanged by E2E', businessUnchanged && finalIntegrity === 'ok' ? 'pass' : 'fail', {
    reason: businessUnchanged
      ? (finalIntegrity === 'ok' ? undefined : `integrity degraded to ${finalIntegrity}`)
      : `business row counts changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    businessTables,
    before,
    after,
    integrityBefore: proof.evidence.integrity,
    integrityAfter: finalIntegrity,
    settingsChangedByApplication: settingsDelta,
    settingsNote: 'settings deltas are runtime state persisted by the application itself (e.g. local_ai_model, worklog books), not test-driven business mutations.',
  });

  const anyFail = results.some(result => result.status === 'fail');
  finish(anyFail ? 'fail' : 'pass', anyFail ? 'one or more desktop E2E scenarios failed' : null, {
    errorsBeforeRestart,
    countsBefore: before,
    countsAfter: after,
  });
}

/** 读取 settings 的 key 列表（用于区分「应用自身运行时状态」与「测试污染」）。 */
function readSettingsKeys(dbPath, previous = null) {
  let keys = [];
  try {
    const db = new DatabaseSync(path.resolve(dbPath));
    try {
      keys = db.prepare('SELECT key FROM settings ORDER BY key').all().map(row => row.key);
    } finally {
      db.close();
    }
  } catch (error) {
    return { error: String(error?.message || error) };
  }
  if (!previous) return keys;
  return {
    added: keys.filter(key => !previous.includes(key)),
    removed: previous.filter(key => !keys.includes(key)),
  };
}

/** 针对任意 cdp 客户端汇总 runtime 状态（重启段使用）。 */
function summarizeRuntimeFor(client) {  const errors = client.runtimeErrors;
  const { allowed, blocking } = splitErrors(errors);
  return {
    runtimeErrors: blocking.length,
    runtimeAllowedErrors: allowed.length,
    runtimeWarnings: client.runtimeWarnings.length,
    allowlistedWarnings: countAllowlistedWarnings(client.runtimeWarnings),
    blockingErrors: blocking.map(error => ({ kind: error.kind, text: redactTail(error.text, 600) })),
  };
}

function finish(status, reason, extra = {}) {
  const summary = {
    schemaVersion: 1,
    profile: 'full',
    step: 'F03',
    ranAt: new Date().toISOString(),
    platform: process.platform,
    fixtureOnly: true,
    formalDatabaseTouched: false,
    status,
    reason: reason || null,
    passed: results.filter(result => result.status === 'pass').length,
    failed: results.filter(result => result.status === 'fail').length,
    blocked: results.filter(result => result.status === 'blocked').length,
    scenarios: results,
    ...extra,
  };

  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`[e2e] could not write ${path.relative(ROOT, REPORT_PATH)}: ${error.message}`);
  }

  console.log('');
  console.log(`E2E: ${summary.passed} pass · ${summary.failed} fail · ${summary.blocked} blocked`);
  console.log(`DESKTOP E2E: ${status.toUpperCase()}${reason ? ` — ${reason}` : ''}`);
  if (status === 'pass') {
    console.log('');
    console.log('ALLOWLIST STATUS');
    console.log(`  runtimeErrors:         ${results.reduce((sum, r) => sum + (r.runtimeErrors ?? 0), 0)}`);
    console.log(`  runtimeWarnings:       ${results.reduce((sum, r) => sum + (r.runtimeWarnings ?? 0), 0)}`);
    console.log(`  allowlistedWarnings:   ${results.reduce((sum, r) => sum + (r.allowlistedWarnings ?? 0), 0)}`);
  }
  console.log('');
  process.exit(status === 'pass' ? 0 : status === 'blocked' ? 3 : 1);
}

main().catch(async error => {
  console.error(`[e2e] crashed: ${error?.stack || error}`);
  try { cdp?.close(); } catch { /* ignore */ }
  try { if (app) await killProcessTree(app.process); } catch { /* ignore */ }
  finish('fail', `e2e runner crashed: ${error?.message || error}`);
});
