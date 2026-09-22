// Quality Harness V2 — 桌面 E2E 主会话场景（E2E-001..006）
//
// 从 V1 的 run-e2e.mjs 中拆出。这六个场景在**同一个进程会话**里连续执行，
// 把「启动 → 登录 → 导航 → 项目/BOM → AI 窗 → 设置」当作一条完整用户旅程验证 ——
// 这正是「函数各自 PASS 但组合后失败」的检测点。
//
// 每个场景接收 ctx 并返回 { status, detail }，不直接操作进程/报告。
// 断言失败的表述放在 detail.reason 里，由 runner 统一记录。

import { integrityCheck } from '../../helpers/dbGuard.mjs';
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
  typeInComposer,
} from '../actions.mjs';

export const BOM_PART_MODELS = ['QA-PANEL-270', 'QA-BL-270', 'QA-SCALER-01', 'QA-DDR-01', 'QA-BEZEL-01', 'QA-PSU-01'];

/** E2E-001 应用启动。 */
export async function e2e001Startup(ctx) {
  const { cdp, app, dbPath, assertAll, summarizeRuntime } = ctx;

  const checks = [];
  let domReady = false;
  try {
    await cdp.waitForDom(45000);
    domReady = true;
  } catch (error) {
    checks.push({ name: 'DOM ready', ok: false, reason: error.message });
  }
  if (domReady) checks.push({ name: 'DOM ready', ok: true });

  const shell = domReady ? await cdp.evaluateJson(`JSON.stringify({
    url: location.href,
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    bodyTextLength: (document.body?.innerText || '').length,
    loginVisible: Boolean(document.querySelector('.login-screen')),
    errorBoundary: Boolean(document.querySelector('.error-boundary, [data-error-boundary]')),
  })`) : {};

  checks.push({ name: 'root has content', ok: (shell.rootChildren ?? 0) > 0, detail: shell.rootChildren });
  checks.push({ name: 'body renders text', ok: (shell.bodyTextLength ?? 0) > 10, detail: shell.bodyTextLength });
  checks.push({ name: 'no error boundary fallback', ok: shell.errorBoundary !== true });
  checks.push({ name: 'process alive', ok: app.process.exitCode === null });

  const integrity = integrityCheck(dbPath);
  checks.push({ name: 'fixture integrity ok', ok: integrity === 'ok', detail: integrity });

  const runtime = summarizeRuntime();
  const verdict = assertAll(checks);
  const runtimeOk = runtime.runtimeErrors === 0;

  return {
    status: verdict.ok && runtimeOk ? 'pass' : 'fail',
    detail: {
      reason: verdict.ok
        ? (runtimeOk ? undefined : `fatal JS exceptions: ${JSON.stringify(runtime.blockingErrors)}`)
        : verdict.failures.join('; '),
      checks: verdict.checks,
      url: shell.url,
      ...runtime,
    },
  };
}

/** E2E-002 测试账号登录。失败即认为后续场景无法进行（由 runner 决定是否中止）。 */
export async function e2e002Login(ctx) {
  const { cdp, credentials, assertAll, summarizeRuntime } = ctx;

  try {
    const result = await login(cdp, credentials);
    const runtime = summarizeRuntime();
    const verdict = assertAll([
      { name: 'login filled and submitted', ok: result.ok, reason: result.reason },
      { name: 'main shell rendered', ok: Boolean(result.shell?.hasSidebar), detail: result.shell },
      { name: 'primary navigation present', ok: (result.shell?.navItems ?? 0) > 0, detail: result.shell?.navItems },
      { name: 'login screen dismissed', ok: result.shell?.loginScreenGone === true },
      { name: 'no uncaught exceptions', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
    ]);
    return {
      status: verdict.ok ? 'pass' : 'fail',
      detail: { reason: verdict.ok ? undefined : verdict.failures.join('; '), checks: verdict.checks, ...runtime },
    };
  } catch (error) {
    return { status: 'fail', detail: { reason: error.message }, fatal: true };
  }
}

/** E2E-003 主导航 smoke。 */
export async function e2e003Navigation(ctx) {
  const { cdp, assertAll, summarizeRuntime } = ctx;

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
  return {
    status: allOk && runtime.runtimeErrors === 0 ? 'pass' : 'fail',
    detail: {
      reason: allOk
        ? (runtime.runtimeErrors === 0 ? undefined : `uncaught exceptions during navigation: ${JSON.stringify(runtime.blockingErrors)}`)
        : `navigation failed: ${navResults.filter(item => !item.ok).map(item => `${item.key}(${item.reason || 'blank'})`).join(', ')}`,
      navigated: navResults,
      ...runtime,
    },
  };
}

/** E2E-004 项目 / BOM 只读旅程。 */
export async function e2e004ProjectBom(ctx) {
  const { cdp, projectCode, assertAll, summarizeRuntime } = ctx;

  try {
    const opened = await openFixtureProjectBom(cdp, projectCode);
    const bomCounts = opened.ok ? await countFixtureBomRows(cdp, BOM_PART_MODELS) : null;
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

    return {
      status: verdict.ok ? 'pass' : 'fail',
      detail: { reason: verdict.ok ? undefined : verdict.failures.join('; '), checks: verdict.checks, bom: bomCounts, ...runtime },
    };
  } catch (error) {
    return { status: 'fail', detail: { reason: error.message } };
  }
}

/** E2E-005 AI 协作窗基础状态（不触发任何模型推理）。 */
export async function e2e005AiPanel(ctx) {
  const { cdp, assertAll, summarizeRuntime } = ctx;

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

    return {
      status: verdict.ok ? 'pass' : 'fail',
      detail: {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        readinessHints: panel.readinessHints,
        ...runtime,
      },
    };
  } catch (error) {
    return { status: 'fail', detail: { reason: error.message } };
  }
}

/** E2E-006 设置页读取 + 凭据不泄漏。 */
export async function e2e006Settings(ctx) {
  const { cdp, assertAll, summarizeRuntime } = ctx;

  try {
    const probe = await inspectSettingsForCredentialLeaks(cdp);
    const runtime = summarizeRuntime();

    const verdict = assertAll([
      { name: 'settings surface opened', ok: probe.modalOpen === true, detail: probe.textLength },
      { name: 'no secret-shaped input values in DOM', ok: probe.secretShapedInputs === 0, detail: probe.secretShapedInputs },
      { name: 'no long opaque token-shaped input values', ok: probe.longOpaqueInputs === 0, detail: probe.longOpaqueInputs },
      { name: 'no uncaught exceptions', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
    ]);

    return {
      status: verdict.ok ? 'pass' : 'fail',
      detail: {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        // 只报告形状统计，绝不记录 input value 原文
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
      },
    };
  } catch (error) {
    return { status: 'fail', detail: { reason: error.message } };
  }
}

/** 主会话场景表（顺序即执行顺序）。 */
export const MAIN_SESSION_SCENARIOS = [
  { id: 'E2E-001', title: 'Application startup', run: e2e001Startup, fatalOnFail: false },
  { id: 'E2E-002', title: 'Test account login', run: e2e002Login, fatalOnFail: true },
  { id: 'E2E-003', title: 'Primary navigation smoke', run: e2e003Navigation, fatalOnFail: false },
  { id: 'E2E-004', title: 'Project/BOM read-only journey', run: e2e004ProjectBom, fatalOnFail: false },
  { id: 'E2E-005', title: 'AI collaboration panel basic state', run: e2e005AiPanel, fatalOnFail: false },
  { id: 'E2E-006', title: 'Settings page read + credential non-leak', run: e2e006Settings, fatalOnFail: false },
];
