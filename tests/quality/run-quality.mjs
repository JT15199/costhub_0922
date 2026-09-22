#!/usr/bin/env node
// CostHub Quality Harness V1 — 统一质量入口
//
// 用法：
//   node tests/quality/run-quality.mjs core
//   node tests/quality/run-quality.mjs full
//   node tests/quality/run-quality.mjs live
//   node tests/quality/run-quality.mjs report      # 只重渲染最近一次报告
//
// 行为约定（实施指导 §0.1 / §5 / §21）：
//   1. core 不访问真实云端、不依赖 API Key、不依赖 Ollama、不修改正式数据库
//   2. 可重复执行
//   3. 任一步 required 失败 → 进程退出码非 0
//   4. 即使某一步失败也继续执行其他步骤，最后生成完整报告
//   5. 同时产出机器可读 JSON 与人类可读 Markdown
//   6. 报告文本全部脱敏后才落盘

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runStep } from './helpers/exec.mjs';
import { buildSummary, formatDuration, makeRunId, renderMarkdown, writeReports } from './helpers/report.mjs';
import { redactSelfTest } from './helpers/redact.mjs';
import { getProfile, PROFILES } from './profiles.mjs';

const EXIT = {
  PASS: 0,
  FAIL: 1,
  USAGE: 2,
  BLOCKED: 3,
};

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  gray: '\u001b[90m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text);

// ---------------------------------------------------------------------------

async function main() {
  const [, , profileArg] = process.argv;

  if (!profileArg) {
    printUsage();
    process.exit(EXIT.USAGE);
  }

  if (profileArg === 'report') {
    return renderLatestOnly();
  }

  let profile;
  try {
    profile = getProfile(profileArg);
  } catch (error) {
    console.error(paint(C.red, `✖ ${error.message}`));
    printUsage();
    process.exit(EXIT.USAGE);
  }

  // runner 自身健全性：脱敏规则必须真的生效，否则拒绝产出报告
  const selfTest = redactSelfTest();
  if (!selfTest.ok) {
    console.error(paint(C.red, '✖ report redactor self-test failed; refusing to write a report that may leak secrets'));
    console.error(JSON.stringify(selfTest.failures, null, 2));
    process.exit(EXIT.FAIL);
  }

  const runId = makeRunId(profile.name);
  const startedAt = new Date();
  const startedMs = Date.now();

  const git = collectGit();
  const environment = collectEnvironment();

  banner(profile, runId, git, environment);

  const steps = [];
  for (const [index, spec] of profile.steps.entries()) {
    const label = `[${index + 1}/${profile.steps.length}] ${spec.id} ${spec.title}`;
    process.stdout.write(`${paint(C.blue, '▶')} ${label} ${C.dim}…${C.reset}\n`);

    const result = await runStep({
      ...spec,
      onOutput: process.env.QUALITY_VERBOSE ? chunk => process.stdout.write(chunk) : undefined,
    });

    // blockedExitCodes：把特定退出码映射为 blocked（环境不具备），例如 live 档 Ollama 不存在
    if (Array.isArray(spec.blockedExitCodes) && spec.blockedExitCodes.includes(result.exitCode)) {
      result.status = 'blocked';
      result.blockedReason = `exit ${result.exitCode} reported as environment-blocked by the step contract`;
      result.reason = result.blockedReason;
    }

    // 抖动重跑：只在第一次 fail 且步骤声明了 flakeRetry 时执行，且结果降级为 warning 并留痕
    if (result.status === 'fail' && spec.flakeRetry?.max > 0) {
      process.stdout.write(`  ${paint(C.yellow, '↻')} failed — rerunning once to distinguish flake from regression\n`);
      const retry = await runStep({ ...spec, onOutput: undefined });
      result.retry = {
        attempted: true,
        firstExitCode: result.exitCode,
        retryExitCode: retry.exitCode,
        retryStatus: retry.status,
        durationMs: retry.durationMs,
        stderrTail: retry.stderrTail,
        stdoutTail: retry.stdoutTail,
      };
      if (retry.status === 'pass') {
        result.status = 'warning';
        result.reason = `flaky: failed on first run (exit ${result.exitCode}), passed on rerun — treated as non-blocking but recorded`;
        result.flaky = true;
      } else {
        result.status = retry.status === 'blocked' ? 'blocked' : 'fail';
        result.reason = `failed twice (exit ${result.exitCode}, then ${retry.exitCode}) — not a flake`;
        result.stderrTail = retry.stderrTail || result.stderrTail;
        result.stdoutTail = retry.stdoutTail || result.stdoutTail;
      }
    }

    const icon = result.status === 'pass' ? paint(C.green, '✔')
      : result.status === 'warning' ? paint(C.yellow, '▲')
        : result.status === 'blocked' ? paint(C.yellow, '⏸')
          : paint(C.red, '✖');
    process.stdout.write(`  ${icon} ${result.status.toUpperCase()} ${C.dim}(${formatDuration(result.durationMs)})${C.reset}${result.reason ? ` ${C.dim}${result.reason}${C.reset}` : ''}\n`);

    steps.push(result);
  }

  const durationMs = Date.now() - startedMs;
  const summary = buildSummary({
    profile: profile.name,
    runId,
    git,
    environment,
    startedAt: startedAt.toISOString(),
    durationMs,
    steps: steps.map(toReportStep),
    notes: buildNotes(profile, steps),
    artifacts: {},
  });

  const written = writeReports(summary);
  summary.artifacts = { runDir: written.runDir, files: written.files };

  // 重新落盘一次，把 artifacts 字段写进去
  writeReports(summary);

  printSummary(summary, written);

  if (summary.gate === 'FAIL') process.exit(EXIT.FAIL);
  if (summary.gate === 'BLOCKED_ENVIRONMENT') process.exit(EXIT.BLOCKED);
  process.exit(EXIT.PASS);
}

/** 只保留报告需要的字段（避免把内部结构写进 JSON）。 */
function toReportStep(step) {
  return {
    id: step.id,
    title: step.title,
    command: step.command,
    required: step.required,
    status: step.status,
    exitCode: step.exitCode,
    durationMs: step.durationMs,
    startAt: step.startAt,
    endAt: step.endAt,
    reason: step.reason ?? null,
    blockedReason: step.blockedReason ?? null,
    timedOut: Boolean(step.timedOut),
    flaky: Boolean(step.flaky),
    regressionIds: step.regressionIds || [],
    stdoutTail: step.stdoutTail || '',
    stderrTail: step.stderrTail || '',
    retry: step.retry
      ? {
        attempted: true,
        firstExitCode: step.retry.firstExitCode,
        retryExitCode: step.retry.retryExitCode,
        retryStatus: step.retry.retryStatus,
        durationMs: step.retry.durationMs,
      }
      : null,
  };
}

function buildNotes(profile, steps) {
  const notes = [];
  notes.push(`Profile "${profile.name}": ${profile.description}`);
  notes.push('Scope: Quality Harness V1 only — no changes to cloud insight strategy, privacy policy, or cloud approval policy.');

  const flaky = steps.filter(step => step.flaky);
  if (flaky.length) {
    notes.push(`Flaky steps (failed once, passed on rerun — non-blocking but recorded): ${flaky.map(step => step.id).join(', ')}`);
  }
  const warnings = steps.filter(step => step.status === 'warning' && !step.flaky);
  if (warnings.length) {
    notes.push(`Non-blocking warnings: ${warnings.map(step => `${step.id} (${step.reason || 'see report'})`).join('; ')}`);
  }
  const blocked = steps.filter(step => step.status === 'blocked');
  if (blocked.length) {
    notes.push(`Environment-blocked steps: ${blocked.map(step => `${step.id} (${step.blockedReason})`).join('; ')}`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// 环境与 git 信息（不含用户名/绝对路径）
// ---------------------------------------------------------------------------

function tryExec(command, args, timeout = 10000) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function collectGit() {
  const commit = tryExec('git', ['rev-parse', 'HEAD']);
  const branch = tryExec('git', ['branch', '--show-current']);
  const status = tryExec('git', ['status', '--porcelain']);
  const base = tryExec('git', ['rev-parse', '--short', 'HEAD']);
  return {
    commit: commit || 'unknown',
    shortCommit: base || null,
    branch: branch || null,
    dirty: status == null ? null : status.length > 0,
    dirtyFileCount: status ? status.split('\n').filter(Boolean).length : null,
  };
}

function collectEnvironment() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: (tryExec('npm', ['--version']) || null),
    rust: firstLine(tryExec('rustc', ['--version'])),
    cargo: firstLine(tryExec('cargo', ['--version'])),
    python: firstLine(tryExec('python', ['--version'])),
  };
}

function firstLine(text) {
  if (!text) return null;
  return String(text).split('\n')[0].trim();
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function banner(profile, runId, git, environment) {
  console.log('');
  console.log(paint(C.bold, 'CostHub Quality Harness V1'));
  console.log(`${C.dim}profile${C.reset}  ${profile.name}  ${C.dim}${profile.description}${C.reset}`);
  console.log(`${C.dim}commit ${C.reset}  ${git.commit}${git.dirty ? paint(C.yellow, ' (dirty)') : ''}${git.branch ? `  ${C.dim}branch${C.reset} ${git.branch}` : ''}`);
  console.log(`${C.dim}run    ${C.reset}  ${runId}`);
  console.log(`${C.dim}env    ${C.reset}  ${environment.platform}/${environment.arch} · node ${environment.node}${environment.rust ? ` · ${environment.rust}` : ''}`);
  console.log('');
}

function printSummary(summary, written) {
  console.log('');
  console.log(paint(C.bold, '─'.repeat(64)));
  for (const step of summary.steps) {
    const icon = step.status === 'pass' ? paint(C.green, '✔')
      : step.status === 'warning' ? paint(C.yellow, '▲')
        : step.status === 'blocked' ? paint(C.yellow, '⏸')
          : paint(C.red, '✖');
    const tag = step.required ? '' : paint(C.dim, ' (optional)');
    console.log(`${icon} ${step.id.padEnd(4)} ${step.title.padEnd(42)} ${formatDuration(step.durationMs).padStart(7)}${tag}`);
  }
  console.log(paint(C.bold, '─'.repeat(64)));
  console.log(`Counts: ${summary.counts.passed} pass · ${summary.counts.failed} fail · ${summary.counts.blocked} blocked · ${summary.counts.warnings} warn · ${summary.counts.skipped} skip`);
  console.log(`Total:  ${formatDuration(summary.durationMs)}`);
  console.log('');

  if (summary.blockedReason) {
    console.log(paint(C.yellow, `BLOCKED: ${summary.blockedReason}`));
    console.log('');
  }

  const gateColor = summary.gate === 'PASS' ? C.green : summary.gate === 'FAIL' ? C.red : C.yellow;
  console.log(`${paint(C.bold, 'QUALITY GATE:')} ${paint(gateColor, summary.gate)}`);
  console.log('');
  console.log(`${C.dim}report  ${written.runDir}/summary.md${C.reset}`);
  console.log(`${C.dim}json    ${written.runDir}/summary.json${C.reset}`);
  console.log(`${C.dim}latest  artifacts/quality/latest-summary.md${C.reset}`);
  console.log('');
}

function printUsage() {
  console.log('');
  console.log(`${paint(C.bold, 'Usage:')} node tests/quality/run-quality.mjs <profile>`);
  console.log('');
  for (const profile of Object.values(PROFILES)) {
    console.log(`  ${paint(C.bold, profile.name.padEnd(6))} ${profile.description}`);
  }
  console.log(`  ${paint(C.bold, 'report'.padEnd(6))} re-render the latest summary.md from latest-summary.json`);
  console.log('');
}

/** report 子命令：从 latest-summary.json 重渲染 Markdown（不需要重跑测试）。 */
function renderLatestOnly() {
  const jsonPath = path.join(process.cwd(), 'artifacts/quality/latest-summary.json');
  if (!fs.existsSync(jsonPath)) {
    console.error(paint(C.red, `✖ no previous run found at artifacts/quality/latest-summary.json`));
    process.exit(EXIT.USAGE);
  }
  const summary = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const markdown = renderMarkdown(summary);
  const target = path.join(process.cwd(), 'artifacts/quality/latest-summary.md');
  fs.writeFileSync(target, markdown, 'utf8');
  console.log(`re-rendered ${path.relative(process.cwd(), target).replace(/\\/g, '/')}`);
  process.exit(EXIT.PASS);
}

main().catch(error => {
  console.error(paint(C.red, `✖ quality runner crashed: ${error?.stack || error}`));
  process.exit(EXIT.FAIL);
});
