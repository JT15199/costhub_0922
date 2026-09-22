#!/usr/bin/env node
// Quality Harness V1 — 桌面夹具可执行文件检查（full 档 F02）
//
// 检查夹具里的 CostHub.exe 是否具备跑 E2E 的条件：
//   * 文件存在且可读、体积合理（不是 0 字节或占位文件）
//   * 夹具目录里没有敏感残留（.env / 私钥 / 真实凭据文件）
//   * 夹具库与 exe 同目录（CostHub 是便携形态，db 落在 exe 同级目录）
//
// 退出码：0 = 可用；3 = 环境不具备（缺 exe，需要先构建）；1 = 检查失败（有敏感残留等）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FIXTURE_DIR = path.join(ROOT, 'artifacts', 'quality', 'desktop-fixture');
const EXE = path.join(FIXTURE_DIR, 'CostHub.exe');
const DB = path.join(FIXTURE_DIR, 'costhub.db');

if (process.platform !== 'win32') {
  console.error('BLOCKED: desktop fixture check is Windows-only (WebView2 runtime).');
  process.exit(3);
}

if (!fs.existsSync(EXE)) {
  console.error(`BLOCKED: fixture executable missing (${path.relative(ROOT, EXE)}).`);
  console.error('         build one with: npm run tauri:build');
  console.error('         then rerun:     node tests/quality/desktop/prepare-fixture.mjs');
  process.exit(3);
}

const problems = [];

const stat = fs.statSync(EXE);
// Tauri release 产物量级为 10MB+；明显偏小说明是占位/被截断
if (stat.size < 5 * 1024 * 1024) problems.push(`executable unusually small: ${stat.size} bytes`);

if (!fs.existsSync(DB)) problems.push(`fixture database missing: ${path.basename(DB)}`);

// 夹具目录里不允许出现凭据类文件——否则可能被应用读到并外发
const forbidden = fs.readdirSync(FIXTURE_DIR).filter(name => /\.env$|\.pem$|\.key$|id_rsa|credentials/i.test(name));
if (forbidden.length) problems.push(`sensitive-looking files inside fixture dir: ${forbidden.join(', ')}`);

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
const result = {
  ok: problems.length === 0,
  fixtureDir: path.relative(ROOT, FIXTURE_DIR).replace(/\\/g, '/'),
  executableBytes: stat.size,
  executableSha256: sha256,
  databasePresent: fs.existsSync(DB),
  forbiddenFiles: forbidden,
  problems,
};

console.log(JSON.stringify(result, null, 2));

if (problems.length) {
  console.error(`FIXTURE CHECK FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('FIXTURE CHECK OK');
process.exit(0);
