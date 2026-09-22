#!/usr/bin/env node
// Quality Harness V2 — 单文件行数门禁
//
// V2 要求：「不要让 Quality Harness 成为第二套复杂系统，避免单文件超过 300 行」。
// 口头约定会腐化，因此把它变成一条自动检查：超过 config.limits.maxFileLines
// 即失败，并在输出里列出超限文件与当前行数。
//
// 豁免：JSON / Markdown 不计（数据与文档，不是逻辑）。
//
// 退出码：0 = 全部在限内；1 = 有文件超限或配置非法。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './helpers/config.mjs';

const ROOT = process.cwd();
const COUNTED_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.tsx']);
const IGNORED_DIRS = new Set(['node_modules', '.git']);

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), found);
    } else if (COUNTED_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

function main() {
  const config = loadConfig();
  const limit = config.limits.maxFileLines;
  const dirs = config.limits.enforcedDirs.map(dir => path.resolve(ROOT, dir));

  if (typeof limit !== 'number' || limit <= 0) {
    console.error(`FILE SIZE GATE: FAIL — limits.maxFileLines must be a positive number, got ${JSON.stringify(limit)}`);
    process.exit(1);
  }

  const offenders = [];
  let scanned = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      console.error(`FILE SIZE GATE: FAIL — enforced directory not found: ${path.relative(ROOT, dir)}`);
      process.exit(1);
    }
    for (const file of walk(dir)) {
      scanned += 1;
      const lines = fs.readFileSync(file, 'utf8').split('\n').length;
      if (lines > limit) {
        offenders.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), lines });
      }
    }
  }

  console.log('');
  console.log('File size gate');
  console.log(`  limit   : ${limit} lines`);
  console.log(`  scanned : ${scanned} file(s) in ${config.limits.enforcedDirs.join(', ')}`);
  console.log('');

  if (offenders.length > 0) {
    offenders.sort((a, b) => b.lines - a.lines);
    console.error(`FILE SIZE GATE: FAIL — ${offenders.length} file(s) exceed ${limit} lines:`);
    for (const offender of offenders) {
      console.error(`  ✖ ${String(offender.lines).padStart(5)} lines  ${offender.file}`);
    }
    console.error('');
    console.error('  请按职责拆分（例如把「动作」与「编排」分开），不要靠调高上限绕过。');
    process.exit(1);
  }

  const longest = scanned > 0 ? findLongest(dirs, limit) : null;
  if (longest) {
    console.log(`  largest : ${longest.lines} lines (${longest.file})`);
    console.log('');
  }
  console.log('FILE SIZE GATE: PASS');
  process.exit(0);
}

function findLongest(dirs, limit) {
  let best = null;
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').length;
      if (!best || lines > best.lines) {
        best = { lines, file: path.relative(ROOT, file).replace(/\\/g, '/') };
      }
    }
  }
  return best && best.lines <= limit ? best : null;
}

main();
