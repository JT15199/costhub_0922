#!/usr/bin/env node
// Quality Harness V2 — lint 输出采集（供 lint 基线门禁比较）
//
// 为什么单独一个脚本：
//   Q06 需要「跑 lint 并把输出留档」，但 **lint 本身失败是正常的**（基线就是失败状态）。
//   如果 Q06 直接用 `npx eslint .`，它会以退出码 1 结束，runner 会把它记为 fail/warning，
//   而真正需要判定的是「问题数有没有超过基线」—— 那是 Q07 的职责。
//
//   因此这里：跑 eslint → 把输出写到 artifacts/quality/lint-output.txt → **总是以 0 退出**
//   （只要成功产出了输出文件）。若连输出都产不出来（eslint 无法执行），才以 1 退出，
//   因为那意味着门禁无法比较，必须 fail closed。
//
// 退出码：0 = 输出已产出（不管 lint 有多少问题）；1 = 无法产出输出。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'artifacts', 'quality', 'lint-output.txt');

let output = '';
let spawnFailed = null;

try {
  output = execFileSync('npx', ['eslint', '.'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
} catch (error) {
  if (error.stdout || error.stderr) {
    // eslint 有问题时以非 0 退出，输出仍在 stdout/stderr —— 这正是要留档的内容
    output = `${error.stdout || ''}\n${error.stderr || ''}`;
  } else {
    spawnFailed = error;
  }
}

if (spawnFailed && !output.trim()) {
  console.error(`LINT CAPTURE: FAIL — could not execute eslint: ${spawnFailed.message}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, output, 'utf8');

const summary = output.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
const rel = path.relative(ROOT, OUTPUT).replace(/\\/g, '/');

if (summary) {
  console.log(`captured lint output → ${rel}`);
  console.log(`  reported: ${summary[1]} problems (${summary[2]} errors, ${summary[3]} warnings)`);
  console.log('  (lint 失败不阻塞；是否新增问题由 Q07 基线门禁判定)');
} else {
  console.log(`captured lint output → ${rel}`);
  console.log('  reported: 0 problems');
}

process.exit(0);
