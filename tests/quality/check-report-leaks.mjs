#!/usr/bin/env node
// Quality Harness V1 — 报告泄漏检查（独立验证脱敏是否真的生效）
//
// 为什么要独立一个脚本：
//   self-check.mjs 验证的是**脱敏函数本身**（喂输入、看输出）。
//   本脚本验证的是**真实落盘的报告文件**——包括那些由子进程 stdout/stderr 带进来的、
//   我们自己没预料到的内容。这是「报告是否可能泄漏 API Key」这一问的实证答案，
//   而不是对函数单测的推断。
//
// 检查三件事：
//   1. 环境变量里的真实凭据值（canary）绝不出现在任何报告文件中；
//   2. 硬编码的凭据模式（vendor key 前缀、Bearer、私钥块、JWT）不出现；
//   3. 本机用户名与用户目录绝对路径不出现。
//
// 退出码：0 = 干净；1 = 发现泄漏（打印命中位置）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const QUALITY_DIR = path.join(ROOT, 'artifacts', 'quality');

/** 只扫描报告类文件；夹具 exe / db 是二进制，跳过。 */
const REPORT_EXTENSIONS = new Set(['.json', '.md', '.txt', '.log']);

function collectReportFiles(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 夹具目录里有 exe 和 db，不扫
      if (entry.name === 'desktop-fixture') continue;
      collectReportFiles(full, found);
    } else if (REPORT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

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
];

const canaries = [];
for (const name of CANARY_ENV_NAMES) {
  const value = process.env[name];
  if (typeof value === 'string' && value.trim().length >= 8) {
    canaries.push({ name, value: value.trim() });
  }
}

/** 2. 硬编码凭据模式。 */
const PATTERNS = [
  { id: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { id: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { id: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'bearer_literal', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

/** 3. 本机身份。 */
const home = process.env.USERPROFILE || process.env.HOME || '';
const username = process.env.USERNAME || process.env.USER || '';
const identityPatterns = [];
if (home) identityPatterns.push({ id: 'home_directory', pattern: new RegExp(escapeRegex(home), 'gi') });
if (username && username.length >= 4) identityPatterns.push({ id: 'username', pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(username)}(?![A-Za-z0-9])`, 'g') });

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const files = collectReportFiles(QUALITY_DIR);
const findings = [];

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const relative = path.relative(ROOT, file).replace(/\\/g, '/');

  for (const canary of canaries) {
    if (text.includes(canary.value)) {
      findings.push({ file: relative, rule: `env_canary:${canary.name}`, severity: 'critical' });
    }
  }
  for (const { id, pattern } of [...PATTERNS, ...identityPatterns]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      findings.push({ file: relative, rule: id, severity: id === 'username' ? 'medium' : 'high', sampleLength: match[0].length });
    }
  }
}

console.log('');
console.log('Quality Harness report leak check');
console.log(`  scanned : ${files.length} report files under artifacts/quality/`);
console.log(`  canaries: ${canaries.length}${canaries.length ? ` (${canaries.map(c => c.name).join(', ')})` : ' (no credential-like env vars set — pattern rules still applied)'}`);
console.log(`  identity: ${identityPatterns.map(p => p.id).join(', ') || '(none)'}`);
console.log('');

if (findings.length > 0) {
  console.log(`LEAK CHECK FAILED: ${findings.length} finding(s)`);
  for (const finding of findings) {
    console.log(`  ✖ ${finding.severity.padEnd(8)} ${finding.rule.padEnd(24)} ${finding.file}`);
  }
  console.log('');
  console.log('提示：命中位置不会打印原文（避免把泄漏内容再写进终端日志）。');
  process.exit(1);
}

console.log('LEAK CHECK PASSED — no credential, token, or local identity found in generated reports');
process.exit(0);
