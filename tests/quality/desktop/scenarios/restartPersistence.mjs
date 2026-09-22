// Quality Harness V2 — 桌面 E2E 重启持久化场景（E2E-007）
//
// 从 V1 的 run-e2e.mjs 中拆出。持久化**必须跨进程验证**，否则等于没测：
// 改一个安全的 UI 偏好 → 关闭应用 → 重新启动 → 偏好仍在且已重新应用。
//
// 走查记录（2026-09-22，避免以后重复踩坑）：
//   * 最初用一个测试私有 localStorage 键做探针 → 重启后消失。
//     单独验证发现 localStorage 本身是持久的（同进程 reload 保留、应用自己的
//     app-theme 跨重启保留），消失的是那个私有键（应用运行时会清理无关键）。
//   * 因此改为断言**真实用户偏好**：主题。这样测的是「用户的设置会不会丢」，
//     而不是「某个内部键会不会被保留」——后者不是产品行为。

import { connect } from '../cdpClient.mjs';
import { killProcessTree, launchFixtureApp, sleep, waitForExit } from '../launchApp.mjs';
import { login, readLocalStorage, writeLocalStorage } from '../actions.mjs';

export const E2E_THEME_SETTING = 'app-theme';
export const E2E_THEME_VALUE = 'liquidLight';

/**
 * @param {object} ctx
 * @param {string} ctx.fixtureDir
 * @param {{username: string, password: string}} ctx.credentials
 * @param {(checks: Array) => object} ctx.assertAll
 * @param {(client: object) => object} ctx.summarizeRuntimeFor
 */
export async function e2e007RestartPersistence(ctx) {
  const { fixtureDir, credentials, assertAll, summarizeRuntimeFor } = ctx;

  let first = null;
  let restarted = null;
  let client = null;

  try {
    // ---- 第一段：写入偏好 ----
    first = await launchFixtureApp({ dir: fixtureDir });
    client = await connect(first.port);
    await client.installErrorHooks();
    await client.waitForDom(45000);
    await login(client, credentials);

    const written = await writeLocalStorage(client, E2E_THEME_SETTING, E2E_THEME_VALUE);
    const appliedBefore = await client.evaluate(`document.documentElement.getAttribute('data-theme')`);

    // ---- 关闭 ----
    client.close();
    client = null;
    await killProcessTree(first.process);
    await waitForExit(first.process);
    await sleep(2500);

    // ---- 第二段：重启后必须仍在 ----
    restarted = await launchFixtureApp({ dir: fixtureDir });
    client = await connect(restarted.port);
    await client.installErrorHooks();
    await client.waitForDom(45000);
    await login(client, credentials);

    const readBack = await readLocalStorage(client, E2E_THEME_SETTING);
    const appliedAfter = await client.evaluate(`document.documentElement.getAttribute('data-theme')`);

    const runtime = summarizeRuntimeFor(client);
    const verdict = assertAll([
      { name: 'preference written before restart', ok: written === E2E_THEME_VALUE, detail: written },
      { name: 'preference survives restart', ok: readBack === E2E_THEME_VALUE, detail: readBack },
      { name: 'preference reapplied to the document after restart', ok: appliedAfter === E2E_THEME_VALUE, detail: appliedAfter },
      { name: 'no uncaught exceptions after restart', ok: runtime.runtimeErrors === 0, reason: JSON.stringify(runtime.blockingErrors) },
    ]);

    return {
      status: verdict.ok ? 'pass' : 'fail',
      detail: {
        reason: verdict.ok ? undefined : verdict.failures.join('; '),
        checks: verdict.checks,
        key: E2E_THEME_SETTING,
        before: written,
        after: readBack,
        themeAppliedBefore: appliedBefore,
        themeAppliedAfter: appliedAfter,
        ...runtime,
      },
    };
  } catch (error) {
    return { status: 'fail', detail: { reason: error.message } };
  } finally {
    try { client?.close(); } catch { /* ignore */ }
    if (restarted) {
      await killProcessTree(restarted.process);
      await waitForExit(restarted.process);
    }
  }
}
