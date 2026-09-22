#!/usr/bin/env node
// Quality Harness V2 — Vitest 结果分类（V2 要求 #5）
//
// 读取 reporters/vitest-collect.mjs 写出的 JSON，把**同一次执行**的结果
// 按文件归入各边界类别，替代 V1 里 Q04–Q07 的重复执行。
//
// 输出：
//   artifacts/quality/vitest-classification.json
//   artifacts/quality/vitest-classification.md
//
// 退出码：0 = 全部类别通过；1 = 有类别失败或采集结果缺失/不可信。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CATEGORIES } from './categories.mjs';

const ROOT = process.cwd();
const COLLECTED = path.join(ROOT, 'artifacts', 'quality', 'vitest-collected.json');
const OUT_JSON = path.join(ROOT, 'artifacts', 'quality', 'vitest-classification.json');
const OUT_MD = path.join(ROOT, 'artifacts', 'quality', 'vitest-classification.md');

/** 把某个文件路径归入它所属的类别（一个文件可属于多个类别）。 */
function categoriesFor(file) {
  return CATEGORIES.filter(category => category.match(file)).map(category => category.id);
}

function main() {
  if (!fs.existsSync(COLLECTED)) {
    // fail closed：采集文件不存在就说明 reporter 没生效，不能当作「无问题」
    console.error(`VITEST CLASSIFY: FAIL — collected results not found (${path.relative(ROOT, COLLECTED)}).`);
    console.error('  The vitest reporter did not produce output. Check --reporter=./tests/quality/reporters/vitest-collect.mjs');
    console.error('  and that QUALITY_VITEST_RESULT was set for the vitest process.');
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(COLLECTED, 'utf8'));
  } catch (error) {
    console.error(`VITEST CLASSIFY: FAIL — collected results are not valid JSON: ${error.message}`);
    process.exit(1);
  }

  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    console.error('VITEST CLASSIFY: FAIL — collected results contain no test files.');
    process.exit(1);
  }

  const buckets = new Map(CATEGORIES.map(category => [category.id, {
    id: category.id,
    title: category.title,
    description: category.description,
    files: 0,
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedFiles: [],
  }]));

  const uncategorized = [];

  for (const file of payload.files) {
    const ids = categoriesFor(file.file);
    if (ids.length === 0) {
      uncategorized.push({ file: file.file, tests: file.tests, failed: file.failed });
    }
    for (const id of ids) {
      const bucket = buckets.get(id);
      bucket.files += 1;
      bucket.tests += file.tests;
      bucket.passed += file.passed;
      bucket.failed += file.failed;
      bucket.skipped += file.skipped;
      if (file.failed > 0) bucket.failedFiles.push({ file: file.file, failed: file.failed, names: file.failedTestNames });
    }
  }

  const categories = [...buckets.values()];
  const failing = categories.filter(category => category.failed > 0);
  const status = failing.length === 0 ? 'pass' : 'fail';

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, COLLECTED).replace(/\\/g, '/'),
    singleExecution: true,
    note: 'V2：这些类别来自同一次 vitest 执行，不再重复运行测试文件。',
    status,
    totals: payload.totals,
    unhandledErrors: payload.unhandledErrors || [],
    categories,
    uncategorizedFileCount: uncategorized.length,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(OUT_MD, renderMarkdown(report), 'utf8');

  // ---- 控制台输出（这就是 V1 里 Q04–Q07 想给出的可见性，只是不再重复跑） ----
  console.log('');
  console.log('Vitest classification (single execution)');
  for (const category of categories) {
    const icon = category.failed > 0 ? '✖' : '✔';
    console.log(
      `  ${icon} ${category.title.padEnd(22)} ${category.tests.toString().padStart(4)} tests in ${category.files.toString().padStart(2)} files` +
      `${category.failed > 0 ? `  (${category.failed} FAILED)` : ''}`,
    );
  }
  console.log(`  ${' '.repeat(2)} ${'uncategorized'.padEnd(22)} ${uncategorized.length} file(s) matched no category`);
  console.log('');

  if (status === 'fail') {
    console.error(`VITEST CLASSIFY: FAIL — ${failing.length} category/categories have failures:`);
    for (const category of failing) {
      console.error(`  ✖ ${category.title}`);
      for (const file of category.failedFiles) {
        console.error(`      ${file.file} (${file.failed} failed)`);
        for (const name of file.names.slice(0, 5)) console.error(`        · ${name}`);
      }
    }
    process.exit(1);
  }

  console.log('VITEST CLASSIFY: PASS');
  process.exit(0);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Vitest 分类报告（单次执行）');
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('> V2：以下类别**来自同一次 vitest 执行**，不再重复运行测试文件。');
  lines.push('');
  lines.push('| 类别 | 说明 | 文件 | 用例 | 通过 | 失败 | 跳过 | 结果 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const category of report.categories) {
    lines.push(
      `| ${category.title} | ${category.description} | ${category.files} | ${category.tests} | ` +
      `${category.passed} | ${category.failed} | ${category.skipped} | ${category.failed > 0 ? '**FAIL**' : 'PASS'} |`,
    );
  }
  lines.push('');
  lines.push(`全部测试：${report.totals.tests} 个用例 / ${report.totals.files} 个文件（通过 ${report.totals.passed}，失败 ${report.totals.failed}，跳过 ${report.totals.skipped}）。`);
  if (report.uncategorizedFileCount > 0) {
    lines.push('');
    lines.push(`未归入任何类别的文件：${report.uncategorizedFileCount} 个（正常 —— 大部分单元测试不属于特定边界）。`);
  }
  lines.push('');
  lines.push(`**结果：${report.status.toUpperCase()}**`);
  lines.push('');
  return lines.join('\n');
}

main();
