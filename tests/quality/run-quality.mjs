#!/usr/bin/env node
// CostHub Quality Harness V2 — 统一质量入口
//
// 用法：
//   node tests/quality/run-quality.mjs core|full|live
//   node tests/quality/run-quality.mjs report      # 只重渲染最近一次报告
//
// V2 相对 V1 的行为变化（全部为加固，未放宽任何门槛）：
//   1. 策略从 tests/quality/config.json 读取，不再硬编码；
//   2. 报告改为「草稿 → 泄漏检查 → finalize」，Q12 校验的必然是本次运行的报告；
//   3. Vitest 只执行一次，边界类别由结果分类得出（不再重复跑 Q04–Q07）；
//   4. lint 走基线门禁（只允许减少，不允许新增）；
//   5. fixture 密码不落明文：优先环境变量，否则生成一次性随机值并经进程环境传递；
//   6. 增加单文件行数门禁。
//
// 退出码：0 PASS / 1 FAIL / 2 用法错误 / 3 BLOCKED_ENVIRONMENT

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildSummary, executeSteps, writeDraftReport } from './helpers/phase-runner.mjs';
import { formatDuration, renderMarkdown, writeReports } from './helpers/report.mjs';
import { loadConfig } from './helpers/config.mjs';
import { resolveFixtureCredentials, persistFixtureCredential } from './helpers/fixtureCredentials.mjs';
import { redactSelfTest } from './helpers/redact.mjs';
import { getProfile, PROFILES } from './profiles.mjs';
import { C, colorEnabled, banner, paint, printSummary, printUsage } from './helpers/console.mjs';
import { collectEnvironment, collectGit, makeRunId } from './helpers/environment.mjs';

const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, BLOCKED: 3 };


async function main() {
  const profileArg = process.argv[2];

  if (!profileArg) { printUsage(PROFILES); process.exit(EXIT.USAGE); }
  if (profileArg === 'report') return renderLatestOnly();

  // ---- 配置（缺失/非法即 fail closed） ----
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(paint(C.red, `✖ ${error.message}`));
    process.exit(EXIT.FAIL);
  }

  let profile;
  try {
    profile = getProfile(profileArg);
  } catch (error) {
    console.error(paint(C.red, `✖ ${error.message}`));
    printUsage(PROFILES);
    process.exit(EXIT.USAGE);
  }

  // ---- runner 自身健全性：脱敏规则必须真的生效 ----
  const selfTest = redactSelfTest();
  if (!selfTest.ok) {
    console.error(paint(C.red, '✖ report redactor self-test failed; refusing to write a report that may leak secrets'));
    console.error(JSON.stringify(selfTest.failures, null, 2));
    process.exit(EXIT.FAIL);
  }

  // ---- 本次运行的标识与目录 ----
  const runId = makeRunId(profile.name);
  const runDir = path.join(config._root, config.artifactsDir ?? 'artifacts/quality', runId);
  const startedAt = new Date();
  const startedMs = Date.now();

  // ---- fixture 凭据：优先环境变量，否则一次性随机（写入运行目录，永不进 git/报告） ----
  const fixtureCredentials = resolveFixtureCredentials(config);
  if (fixtureCredentials.source === 'generated') {
    persistFixtureCredential(runDir, {
      username: fixtureCredentials.username,
      password: fixtureCredentials.password,
    });
  }
  const childEnv = {
    ...(process.env[config.fixture.passwordEnvVar]
      ? {}
      : { [config.fixture.passwordEnvVar]: fixtureCredentials.password }),
    QUALITY_RUN_DIR: runDir,
    QUALITY_CONFIG_PATH: config._configPath,
  };

  const git = collectGit();
  const environment = collectEnvironment();
  banner(profile, runId, git, environment, fixtureCredentials.source);

  // ---- 阶段一：跑步骤，写草稿报告 ----
  const steps = await executeSteps(profile.steps, { color: colorEnabled, env: childEnv });

  let durationMs = Date.now() - startedMs;
  let summary = buildSummary({
    profile: profile.name,
    runId,
    git,
    environment,
    startedAt: startedAt.toISOString(),
    durationMs,
    steps,
    notes: buildNotes(profile, steps),
    artifacts: { runDir: path.relative(config._root, runDir).replace(/\\/g, '/') },
  });

  writeDraftReport({ runDir, summary, draftBasename: config.report.draftBasename });
  console.log(`\n${C.dim}draft report written for leak check${C.reset}`);

  // ---- 阶段二：对本次运行的草稿做泄漏检查 ----
  let leakPassed = true;
  if (config.report.leakCheckBeforeFinalize) {
    process.stdout.write(`${paint(C.blue, '▶')} [finalize] Report leak check on this run's report ${C.dim}…${C.reset}\n`);
    leakPassed = runLeakCheck(runDir, config);
    console.log(leakPassed
      ? `  ${paint(C.green, '✔',)} PASS`
      : `  ${paint(C.red, '✖')} FAIL — report leaked sensitive content; finalize aborted`);
  }

  // ---- 阶段三：finalize（仅当泄漏检查通过） ----
  const durationFinal = Date.now() - startedMs;
  summary = buildSummary({
    profile: profile.name,
    runId,
    git,
    environment,
    startedAt: startedAt.toISOString(),
    durationMs: durationFinal,
    steps,
    notes: buildNotes(profile, steps),
    artifacts: {},
  });

  let written = { runDir: path.relative(config._root, runDir).replace(/\\/g, '/'), files: [] };
  if (leakPassed) {
    written = writeReports(summary, { root: config._root, artifactsDir: config.artifactsDir ?? 'artifacts/quality' });
    summary.artifacts = { runDir: written.runDir, files: written.files };
    writeReports(summary, { root: config._root, artifactsDir: config.artifactsDir ?? 'artifacts/quality' });
    // 草稿在 finalize 成功后移除，避免留下两份可能不一致的报告
    for (const name of [`${config.report.draftBasename}.json`, `${config.report.draftBasename}.md`]) {
      try { fs.rmSync(path.join(runDir, name), { force: true }); } catch { /* ignore */ }
    }
  } else {
    // fail closed：泄漏检查没过就不产出正式报告，并把草稿保留供人工取证
    summary.gate = 'FAIL';
    summary.notes = [...(summary.notes || []), 'FINALIZE ABORTED: report leak check failed; draft report retained for inspection.'];
  }

  printSummary(summary, written, leakPassed);

  if (!leakPassed || summary.gate === 'FAIL') process.exit(EXIT.FAIL);
  if (summary.gate === 'BLOCKED_ENVIRONMENT') process.exit(EXIT.BLOCKED);
  process.exit(EXIT.PASS);
}

/** 用本次运行的草稿报告调用 Q12。 */
function runLeakCheck(runDir, config) {
  const args = ['tests/quality/check-report-leaks.mjs', '--reports',
    path.join(runDir, `${config.report.draftBasename}.json`),
    path.join(runDir, `${config.report.draftBasename}.md`)];
  try {
    execFileSync('node', args, { cwd: config._root, stdio: 'pipe', timeout: 2 * 60 * 1000, encoding: 'utf8' });
    return true;
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
    if (output) console.log(output.split('\n').map(line => `  ${C.dim}${line}${C.reset}`).join('\n'));
    return false;
  }
}


function buildNotes(profile, steps) {
  const notes = [];
  notes.push(`Profile "${profile.name}": ${profile.description}`);
  notes.push('Scope: Quality Harness only — no changes to cloud insight strategy, privacy policy, or cloud approval policy.');
  notes.push('V2: strategies come from tests/quality/config.json; reports are draft-checked-finalized; vitest runs once and is classified.');

  const flaky = steps.filter(step => step.flaky);
  if (flaky.length) notes.push(`Flaky steps (failed once, passed on rerun — non-blocking but recorded): ${flaky.map(step => step.id).join(', ')}`);
  const warnings = steps.filter(step => step.status === 'warning' && !step.flaky);
  if (warnings.length) notes.push(`Non-blocking warnings: ${warnings.map(step => `${step.id} (${step.reason || 'see report'})`).join('; ')}`);
  const blocked = steps.filter(step => step.status === 'blocked');
  if (blocked.length) notes.push(`Environment-blocked steps: ${blocked.map(step => `${step.id} (${step.blockedReason})`).join('; ')}`);
  return notes;
}

function renderLatestOnly() {
  const jsonPath = path.join(process.cwd(), 'artifacts/quality/latest-summary.json');
  if (!fs.existsSync(jsonPath)) {
    console.error(paint(C.red, '✖ no previous run found at artifacts/quality/latest-summary.json'));
    process.exit(EXIT.USAGE);
  }
  const summary = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const target = path.join(process.cwd(), 'artifacts/quality/latest-summary.md');
  fs.writeFileSync(target, renderMarkdown(summary), 'utf8');
  console.log(`re-rendered ${path.relative(process.cwd(), target).replace(/\\/g, '/')}`);
  process.exit(EXIT.PASS);
}

main().catch(error => {
  console.error(paint(C.red, `✖ quality runner crashed: ${error?.stack || error}`));
  process.exit(EXIT.FAIL);
});
