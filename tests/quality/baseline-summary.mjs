#!/usr/bin/env node
// Quality Harness V1 — Phase 0 基线归档
//
// 读取 artifacts/quality/baseline/raw/*.out.txt|err.txt（由 Phase 0 手工采集），
// 生成实施指导 §4.2 / §4.4 要求的两个文件：
//   artifacts/quality/baseline/environment.json
//   artifacts/quality/baseline/baseline-summary.json

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { redactDeep } from './helpers/redact.mjs';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'artifacts', 'quality', 'baseline', 'raw');
const OUT = path.join(ROOT, 'artifacts', 'quality', 'baseline');

function tryExec(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function firstLine(text) {
  return text ? String(text).split('\n')[0].trim() : null;
}

/** 从原始输出里抽取 vitest 的通过/失败计数。 */
function parseVitest(text) {
  const files = text.match(/Test Files\s+(.+)/);
  const tests = text.match(/Tests\s+(.+)/);
  const duration = text.match(/Duration\s+(.+)/);
  return {
    testFiles: files ? files[1].trim() : null,
    tests: tests ? tests[1].trim() : null,
    duration: duration ? duration[1].trim() : null,
  };
}

/** 统计 eslint 的问题总数与 error/warning 拆分。 */
function parseLint(text) {
  const totals = text.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
  const parsingErrors = (text.match(/Parsing error/g) || []).length;
  return {
    total: totals ? Number(totals[1]) : null,
    errors: totals ? Number(totals[2]) : null,
    warnings: totals ? Number(totals[3]) : null,
    parsingErrors,
  };
}

function parseCargo(text) {
  const ok = text.match(/test result: ok\.\s+(\d+) passed;\s+(\d+) failed/);
  if (ok) return { passed: Number(ok[1]), failed: Number(ok[2]) };
  const bad = text.match(/test result: FAILED\.\s+(\d+) passed;\s+(\d+) failed/);
  if (bad) return { passed: Number(bad[1]), failed: Number(bad[2]) };
  return { passed: null, failed: null };
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

const environment = redactDeep({
  capturedAt: new Date().toISOString(),
  baselineCommit: tryExec('git', ['rev-parse', 'HEAD']),
  node: process.version,
  npm: tryExec('npm', ['--version']),
  rustc: firstLine(tryExec('rustc', ['--version'])),
  cargo: firstLine(tryExec('cargo', ['--version'])),
  python: firstLine(tryExec('python', ['--version'])),
  platform: process.platform,
  arch: process.arch,
  os: firstLine(tryExec('cmd', ['/c', 'ver'])),
  webview2: firstLine(tryExec('powershell', ['-NoProfile', '-Command',
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv"])),
  powershell: firstLine(tryExec('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])),
  note: 'No username, absolute path, token, or API key is recorded here.',
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// 基线步骤
// ---------------------------------------------------------------------------

/**
 * 基线步骤分类（实施指导 §4.4）：
 *   BASELINE_PASS        本来就通过
 *   BASELINE_FAIL_EXISTING  本来就失败（既有债务，非本轮引入）
 *   ENVIRONMENT_BLOCKED  环境不具备
 */
const STEP_DEFS = [
  { id: 'build', title: 'TypeScript/Vite Build', command: 'npm run build', category: 'required' },
  { id: 'lint', title: 'ESLint', command: 'npm run lint', category: 'debt' },
  { id: 'vitest', title: 'Vitest All', command: 'npx vitest run', category: 'flake' },
  { id: 'agent', title: 'Agent Deterministic Test', command: 'npx vitest run src/__tests__/modelProfile.test.ts src/__tests__/harnessPhases.test.ts', category: 'required' },
  { id: 'rust', title: 'Rust Unit Tests', command: 'cargo test --manifest-path src-tauri/Cargo.toml --lib', category: 'required' },
  { id: 'portable', title: 'Portable Check (agent-upgrade)', command: 'node tests/agent-upgrade/check-portable.mjs', category: 'optional' },
  { id: 'recovery', title: 'Restart Recovery', command: 'python tests/agent-upgrade/restart-recovery.py', category: 'optional' },
];

// Phase 0 采集到的真实退出码（原始采集见 raw/ 与 QUALITY_HARNESS_V1_REPORT.md）
const OBSERVED_EXIT_CODES = {
  build: 0,
  lint: 1,
  vitest: 1,
  agent: 0,
  rust: 0,
  portable: 0,
  recovery: 0,
};

const BASELINE_NOTES = {
  lint: '113 errors / 149 warnings。其中 107 个 error 是 eslint 扫描被 gitignore 的 .build-portable/ 打包产物产生的 Parsing error（配置噪声，非源码问题）；src+tests 单独跑为 6 errors / 149 warnings，6 个 error 均为 react-hooks「Cannot access refs during render」。',
  vitest: '首次运行失败：src/__tests__/costPackage.test.ts 冷导入超过 5s 默认超时（Test timed out in 5000ms）。随后单独运行 3/3 通过、全量运行连续 3/3 通过 → 判定为 CPU 争用抖动而非正确性缺陷。',
  build: '前端构建通过；注意 tsc -b 会捕获 JSX 结构错误（本轮 Harness 自身新增代码曾触发一次并在提交前修复）。',
};

const steps = STEP_DEFS.map(definition => {
  const outPath = path.join(RAW, `${definition.id}.out.txt`);
  const errPath = path.join(RAW, `${definition.id}.err.txt`);
  const stdout = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
  const combined = `${stdout}\n${stderr}`;
  const exitCode = OBSERVED_EXIT_CODES[definition.id];

  let classification = 'ENVIRONMENT_BLOCKED';
  if (exitCode === 0) classification = 'BASELINE_PASS';
  else if (definition.category === 'debt' || definition.category === 'flake') classification = 'BASELINE_FAIL_EXISTING';
  else if (exitCode != null) classification = 'BASELINE_FAIL_EXISTING';

  const detail = {};
  if (definition.id === 'vitest') Object.assign(detail, parseVitest(combined));
  if (definition.id === 'lint') Object.assign(detail, parseLint(combined));
  if (definition.id === 'rust') Object.assign(detail, parseCargo(combined));

  return {
    id: definition.id,
    title: definition.title,
    command: definition.command,
    exitCode,
    classification,
    detail,
    note: BASELINE_NOTES[definition.id] || null,
  };
});

function finalize() {
  const summary = redactDeep({
    schemaVersion: 1,
    phase: 'Phase 0 — baseline',
    capturedAt: new Date().toISOString(),
    baselineCommit: environment.baselineCommit,
    environment: {
      platform: environment.platform,
      arch: environment.arch,
      node: environment.node,
      rustc: environment.rustc,
    },
    steps,
    counts: {
      pass: steps.filter(step => step.classification === 'BASELINE_PASS').length,
      failExisting: steps.filter(step => step.classification === 'BASELINE_FAIL_EXISTING').length,
      environmentBlocked: steps.filter(step => step.classification === 'ENVIRONMENT_BLOCKED').length,
    },
    acceptedBaselinePolicy: [
      'build 必须 PASS —— 它是 quality:core 的 Q01。',
      'lint 基线为失败（113 errors / 149 warnings）→ 按 §12 在 V1 记为 non-blocking warning，不在本轮大规模修改业务代码「修 lint」。',
      'vitest 基线实测 5 次中 1 次失败（costPackage.test.ts 冷导入 5s 超时，与 lint 并发时触发），属已知抖动 → 在 core 中声明 flakeRetry（允许一次重跑，重跑通过降级为 warning 并留痕）。',
      'agent / rust / portable / recovery 基线 PASS，直接纳入 required 或 optional。',
    ],
  });
  fs.writeFileSync(path.join(OUT, 'baseline-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary.counts, null, 2));
  for (const step of summary.steps) {
    console.log(`${step.classification.padEnd(22)} ${step.id.padEnd(10)} exit=${step.exitCode}`);
  }
}

finalize();
