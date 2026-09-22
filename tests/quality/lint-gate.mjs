#!/usr/bin/env node
// Quality Harness V2 — lint 基线门禁（V2 要求 #6）
//
// 为什么需要它：
//   V1 把 lint 记为 non-blocking warning，理由是基线本身失败。但那意味着
//   **lint 债务可以无限增长**——长期下去闸门就形同虚设。
//   V2 改为「基线制」：记录当前允许的问题数上限，只允许减少，不允许新增。
//
// 为什么不用 `npm run lint` 的退出码：
//   基线本来就是失败状态（113 errors），退出码恒为 1，无法区分「还是那 113 个」
//   与「新增了 5 个」。因此这里解析 eslint 的文本输出，比较**数量**。
//
// 用法：
//   node tests/quality/lint-gate.mjs            # 自己跑 eslint 并比较
//   node tests/quality/lint-gate.mjs <文件>      # 用已保存的输出比较（供 quality runner 复用，避免重复执行）

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './helpers/config.mjs';

const ROOT = process.cwd();

/** 从 eslint 文本输出里解析总数与分级数。 */
export function parseLintOutput(text) {
  // 形如：✖ 262 problems (113 errors, 149 warnings)
  const totals = text.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
  if (totals) {
    return { total: Number(totals[1]), errors: Number(totals[2]), warnings: Number(totals[3]), parsed: true };
  }

  // 没有 problems 汇总行 = 零问题（eslint 干净时不会打印 summary）
  if (!/problems?/i.test(text)) {
    return { total: 0, errors: 0, warnings: 0, parsed: true };
  }
  return { total: null, errors: null, warnings: null, parsed: false };
}

function runEslint() {
  try {
    return execFileSync('npx', ['eslint', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // eslint 有问题时以非 0 退出，输出仍在 stdout/stderr 里 —— 这正是我们要解析的
    return `${error.stdout || ''}\n${error.stderr || ''}`;
  }
}

function main() {
  const config = loadConfig();

  if (config.lint.baseline !== true) {
    console.log('LINT GATE: SKIPPED (lint.baseline is false in config.json)');
    process.exit(0);
  }

  let output;
  const outputFile = process.argv[2];
  if (outputFile) {
    if (!fs.existsSync(outputFile)) {
      console.error(`LINT GATE: FAIL — saved lint output not found: ${outputFile}`);
      process.exit(1);
    }
    output = fs.readFileSync(outputFile, 'utf8');
  } else {
    output = runEslint();
  }

  const current = parseLintOutput(output);

  if (!current.parsed) {
    // fail closed：解析不出来就当作失败，不能「看不懂所以放过」
    console.error('LINT GATE: FAIL — could not parse eslint output; refusing to pass an unreadable result.');
    console.error(output.slice(-2000));
    process.exit(1);
  }

  const baselinePath = config.lintBaselinePath;
  if (!fs.existsSync(baselinePath)) {
    // fail closed：没有基线就不能证明「没有新增」
    console.error(`LINT GATE: FAIL — baseline file missing: ${path.relative(ROOT, baselinePath)}`);
    process.exit(1);
  }

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    console.error(`LINT GATE: FAIL — baseline is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  const limit = baseline.gate || {};
  if (typeof limit.total !== 'number' || typeof limit.errors !== 'number' || typeof limit.warnings !== 'number') {
    console.error('LINT GATE: FAIL — baseline is missing numeric gate.{total,errors,warnings}');
    process.exit(1);
  }

  const delta = {
    total: current.total - limit.total,
    errors: current.errors - limit.errors,
    warnings: current.warnings - limit.warnings,
  };

  console.log('');
  console.log('Lint baseline gate');
  console.log(`  baseline : ${limit.total} total (${limit.errors} errors, ${limit.warnings} warnings)`);
  console.log(`  current  : ${current.total} total (${current.errors} errors, ${current.warnings} warnings)`);
  console.log(`  delta    : ${delta.total >= 0 ? '+' : ''}${delta.total} total (${delta.errors >= 0 ? '+' : ''}${delta.errors} errors, ${delta.warnings >= 0 ? '+' : ''}${delta.warnings} warnings)`);
  console.log('');

  const regressions = [];
  if (current.errors > limit.errors) regressions.push(`errors +${current.errors - limit.errors}`);
  if (current.total > limit.total) regressions.push(`total +${current.total - limit.total}`);

  if (regressions.length > 0) {
    console.error(`LINT GATE: FAIL — new lint problems introduced: ${regressions.join(', ')}`);
    console.error('  基线只允许下调，不允许新增。请先修掉新增问题；');
    console.error(`  若确认是合理的基线调整，请修改 ${path.relative(ROOT, baselinePath)} 并在提交信息中说明理由。`);
    process.exit(1);
  }

  if (current.total < limit.total) {
    console.log(`LINT GATE: PASS (improved by ${limit.total - current.total})`);
    console.log('  提示：债务已下降，可同步下调基线以锁定收益。');
  } else {
    console.log('LINT GATE: PASS (no new problems)');
  }
  process.exit(0);
}

// 仅在被直接执行时运行（被 import 做单测时不自动跑）
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly || process.argv[1]?.endsWith('lint-gate.mjs')) {
  main();
}

export { main as lintGateMain };
