#!/usr/bin/env node
// Quality Harness V2 — 报告泄漏检查（V2 要求 #3）
//
// V1 的两个缺陷：
//   1. **扫描范围过宽**：扫描 artifacts/quality/ 下所有 .json/.md/.txt/.log，
//      于是把碰巧放在同目录的中间产物（例如 vitest 的 JSON reporter 输出、
//      eslint 的输出缓存）也当成「质量报告」来扫，导致误报。
//   2. **校验的不是本次运行的报告**：V1 在步骤序列中间执行本检查，
//      而正式报告要到全部步骤跑完才写盘 —— 它校验的是上一次运行的残留。
//
// V2 的修正：
//   * 只扫描**本次运行明确产出的报告文件**（由 runner 通过 --reports 传入，
//     或按 config.report.draftBasename 推导出的草稿报告）；
//   * 由 runner 在**写完草稿报告之后、finalize 之前**调用，
//     因此校验的必然是当前执行产生的报告；
//   * 扫不到任何目标文件时 **fail closed**（不能因为「没找到文件」就算通过）。
//
// 用法：
//   node tests/quality/check-report-leaks.mjs --reports <file1> <file2> ...
//   node tests/quality/check-report-leaks.mjs            # 使用当前运行目录的草稿报告
//
// 退出码：0 = 干净；1 = 发现泄漏或无法完成检查。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './helpers/config.mjs';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 检查项
// ---------------------------------------------------------------------------

/** 1. 环境变量 canary —— 只要值出现在报告里就是硬失败。 */
const CANARY_ENV_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'SERPAPI_API_KEY',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'COSTHUB_API_KEY',
  'QUALITY_TEST_PASSWORD',
];

/** 2. 硬编码凭据模式。 */
const PATTERNS = [
  { id: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { id: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  // V2：要求 BEGIN 与 END 同时出现，避免把「测试用例名里提到私钥头」当成真泄漏
  // （privacyRouter.test.ts 的用例名就是 "guards -----BEGIN PRIVATE KEY-----"）。
  { id: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: 'bearer_literal', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 3. 本机身份。 */
function identityPatterns() {
  const patterns = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const username = process.env.USERNAME || process.env.USER || '';
  if (home) patterns.push({ id: 'home_directory', pattern: new RegExp(escapeRegex(home), 'gi') });
  if (username && username.length >= 4) {
    patterns.push({ id: 'username', pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(username)}(?![A-Za-z0-9])`, 'g') });
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// 目标文件解析
// ---------------------------------------------------------------------------

/**
 * 决定要扫描哪些文件。
 * 优先级：--reports 显式列表 > 当前运行目录下的草稿报告。
 * 两者都拿不到目标时返回空数组，由 main 判定为 fail closed。
 */
function resolveTargets(config) {
  const flagIndex = process.argv.indexOf('--reports');
  if (flagIndex >= 0) {
    return process.argv.slice(flagIndex + 1).filter(Boolean).map(file => path.resolve(ROOT, file));
  }

  const runDir = process.env.QUALITY_RUN_DIR;
  if (runDir) {
    const base = config.report.draftBasename;
    return [
      path.join(runDir, `${base}.json`),
      path.join(runDir, `${base}.md`),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function main() {
  const config = loadConfig();
  const targets = resolveTargets(config).filter(file => fs.existsSync(file));

  console.log('');
  console.log('Quality Harness report leak check (V2: current-run reports only)');

  if (targets.length === 0) {
    // fail closed：没扫到目标文件不能算通过
    console.error('LEAK CHECK FAILED: no report files found to scan.');
    console.error('  Pass them explicitly with --reports <file...>, or set QUALITY_RUN_DIR so the');
    console.error(`  draft report (${config.report.draftBasename}.json/.md) can be located.`);
    console.error('  Refusing to report PASS without scanning the current run\'s report.');
    process.exit(1);
  }

  const canaries = [];
  for (const name of CANARY_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length >= 8) canaries.push({ name, value: value.trim() });
  }
  const identity = identityPatterns();

  const findings = [];
  for (const file of targets) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      findings.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), rule: `unreadable:${error.code || 'error'}`, severity: 'high' });
      continue;
    }
    const relative = path.relative(ROOT, file).replace(/\\/g, '/');

    for (const canary of canaries) {
      if (text.includes(canary.value)) findings.push({ file: relative, rule: `env_canary:${canary.name}`, severity: 'critical' });
    }
    for (const { id, pattern } of [...PATTERNS, ...identity]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) findings.push({ file: relative, rule: id, severity: id === 'username' ? 'medium' : 'high', sampleLength: match[0].length });
    }
  }

  console.log(`  scanned : ${targets.length} file(s) produced by THIS run`);
  for (const file of targets) console.log(`            ${path.relative(ROOT, file).replace(/\\/g, '/')}`);
  console.log(`  canaries: ${canaries.length}${canaries.length ? ` (${canaries.map(c => c.name).join(', ')})` : ' (no credential-like env vars set — pattern rules still applied)'}`);
  console.log(`  identity: ${identity.map(p => p.id).join(', ') || '(none)'}`);
  console.log('');

  if (findings.length > 0) {
    console.log(`LEAK CHECK FAILED: ${findings.length} finding(s)`);
    for (const finding of findings) {
      // 不打印命中原文，避免把泄漏内容再写进终端日志
      console.log(`  ✖ ${finding.severity.padEnd(8)} ${finding.rule.padEnd(24)} ${finding.file}`);
    }
    console.log('');
    process.exit(1);
  }

  console.log('LEAK CHECK PASSED — current run\'s report contains no credential, token, or local identity');
  process.exit(0);
}

main();
