#!/usr/bin/env node
// Quality Harness V2 — 桌面 E2E 编排（full 档 F03）
//
// V2 把 V1 的单文件（472 行）拆成：
//   scenarios/mainSession.mjs      E2E-001..006（同一进程会话内的连续用户旅程）
//   scenarios/restartPersistence.mjs  E2E-007（必须跨进程验证）
//   本文件                         编排、守卫、runtime error 门禁、报告
//
// 结构与判定规则：
//   * E2E-008 是**前置守卫**：证明不了是 fixture 就整体 ABORT，不允许「大概率不是正式库」；
//   * 主会话 6 个场景在同一个进程里跑，组合失败才会暴露；
//   * E2E-007 单独重启；
//   * E2E-008b 收尾断言业务表未被改变。
//
// 退出码：0 全通过；1 有场景失败；3 环境不具备（非 Windows / 缺 exe / 缺凭据）。

import fs from 'node:fs';
import path from 'node:path';

import { connect, summarizeRuntime } from './cdpClient.mjs';
import { killProcessTree, launchFixtureApp } from './launchApp.mjs';
import { assertFixtureDatabase, integrityCheck, snapshotCounts } from '../helpers/dbGuard.mjs';
import { loadConfig } from '../helpers/config.mjs';
import { resolveFixtureCredentials } from '../helpers/fixtureCredentials.mjs';
import { redactSummary } from '../helpers/redact.mjs';
import { readFixtureManifest, readSettingsKeys } from './manifest.mjs';
import { MAIN_SESSION_SCENARIOS } from './scenarios/mainSession.mjs';
import { e2e007RestartPersistence } from './scenarios/restartPersistence.mjs';

const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, 'artifacts', 'quality', 'desktop-e2e.json');

const results = [];

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

function loadAllowlist(allowlistPath) {
  try {
    return JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    // fail closed：读不到 allowlist 就当作空，任何错误都不豁免
    console.error(`[e2e] could not read allowlist (${error.message}) — treating it as empty (strict)`);
    return { errors: [], warnings: [] };
  }
}

async function main() {
  console.log('');
  console.log('CostHub Quality Harness V2 — Desktop E2E');
  console.log('');

  if (process.platform !== 'win32') {
    finish('blocked', 'desktop E2E is Windows-only (WebView2 runtime)');
    return;
  }

  const config = loadConfig();
  const fixtureDir = config.fixtureRoot;
  const allowlist = loadAllowlist(path.join(ROOT, 'tests', 'quality', 'desktop', 'runtime-error-allowlist.json'));

  // ---- E2E-008 前置守卫：证明这是 fixture -----------------------------------
  console.log('[guard] proving the database is an isolated fixture…');
  if (!fs.existsSync(fixtureDir)) {
    finish('blocked', `fixture directory missing (${config.database.fixtureDir}) — run prepare-fixture.mjs first`);
    return;
  }

  const manifest = readFixtureManifest(fixtureDir);
  const dbPath = path.join(fixtureDir, manifest.database || config.database.databaseFilename);

  const proof = assertFixtureDatabase(dbPath, {
    fixtureRoot: fixtureDir,
    databaseFilename: config.database.databaseFilename,
    markerKey: config.database.fixtureMarkerKey,
    markerValue: config.database.fixtureMarkerValue,
  });

  record('E2E-008', 'Production database isolation', proof.ok ? 'pass' : 'fail', {
    reason: proof.ok ? undefined : proof.reason,
    evidence: {
      fixtureBasename: proof.evidence.basename,
      fixtureDirectoryHint: proof.evidence.directoryHint,
      relativeToFixtureRoot: proof.evidence.relativeToFixtureRoot,
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

  // ---- 凭据（禁止明文；未提供环境变量则由 runner 生成一次性随机密码） ----
  const credentials = resolveFixtureCredentials(config);
  if (!credentials.password) {
    finish('blocked', `fixture credentials unavailable (set ${config.fixture.passwordEnvVar} or let the runner generate one)`);
    return;
  }

  const before = snapshotCounts(dbPath);
  const beforeSettingsKeys = readSettingsKeys(dbPath);
  console.log(`[guard] fixture proven: marker=${proof.evidence.marker}, integrity=${proof.evidence.integrity}`);
  console.log(`[guard] counts before: ${JSON.stringify(before)}`);
  console.log(`[guard] identity: ${credentials.username} (password source: ${credentials.source})`);
  console.log('');

  // ---- 启动主会话 -----------------------------------------------------------
  console.log('[session] launching fixture application…');
  let app;
  try {
    app = await launchFixtureApp({ dir: fixtureDir });
  } catch (error) {
    finish('blocked', `launch failed: ${error.message}`);
    return;
  }
  console.log(`[session] pid=${app.pid} cdpPort=${app.port}`);

  const cdp = await connect(app.port);
  await cdp.installErrorHooks();

  const ctx = {
    cdp,
    app,
    dbPath,
    credentials,
    projectCode: manifest.projectCode || config.fixture.seedProjectCode,
    assertAll,
    summarizeRuntime: () => summarizeRuntime(cdp, allowlist),
  };

  try {
    for (const scenario of MAIN_SESSION_SCENARIOS) {
      const outcome = await scenario.run(ctx);
      record(scenario.id, scenario.title, outcome.status, outcome.detail);
      if (outcome.status === 'fail' && scenario.fatalOnFail) {
        cdp.close();
        await killProcessTree(app.process);
        finish('fail', `${scenario.id} failed — remaining scenarios depend on it`);
        return;
      }
    }
  } finally {
    try { cdp.close(); } catch { /* ignore */ }
    await killProcessTree(app.process);
  }

  // ---- E2E-007 重启持久化 ---------------------------------------------------
  const restartOutcome = await e2e007RestartPersistence({
    fixtureDir,
    credentials,
    assertAll,
    summarizeRuntimeFor: client => summarizeRuntime(client, allowlist),
  });
  record('E2E-007', 'Restart persistence (UI preference)', restartOutcome.status, restartOutcome.detail);

  // ---- E2E-008b 夹具未被改变 ------------------------------------------------
  // 断言范围刻意区分：
  //   * 业务数据表（projects / project_boms / parts）在「只读旅程」后必须不变；
  //   * settings 允许变化 —— 应用自身会持久化运行时状态（本机 local_ai_model、手账书签等）。
  const after = snapshotCounts(dbPath);
  const businessTables = ['projects', 'project_boms', 'parts'];
  const businessUnchanged = businessTables.every(table => before[table] === after[table]);
  const finalIntegrity = integrityCheck(dbPath);

  record('E2E-008b', 'Fixture data unchanged by E2E', businessUnchanged && finalIntegrity === 'ok' ? 'pass' : 'fail', {
    reason: businessUnchanged
      ? (finalIntegrity === 'ok' ? undefined : `integrity degraded to ${finalIntegrity}`)
      : `business row counts changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    businessTables,
    before,
    after,
    integrityBefore: proof.evidence.integrity,
    integrityAfter: finalIntegrity,
    settingsChangedByApplication: readSettingsKeys(dbPath, beforeSettingsKeys),
    settingsNote:
      'settings deltas are runtime state persisted by the application itself ' +
      '(e.g. local_ai_model, worklog books), not test-driven business mutations.',
  });

  const anyFail = results.some(result => result.status === 'fail');
  finish(anyFail ? 'fail' : 'pass', anyFail ? 'one or more desktop E2E scenarios failed' : null, {
    countsBefore: before,
    countsAfter: after,
  });
}

function finish(status, reason, extra = {}) {
  const summary = {
    schemaVersion: 2,
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
    // 报告同样经脱敏后再落盘（run-e2e 直接写文件，不走 report.mjs）
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(redactSummary(summary), null, 2)}\n`, 'utf8');
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
  finish('fail', `e2e runner crashed: ${error?.message || error}`);
});
