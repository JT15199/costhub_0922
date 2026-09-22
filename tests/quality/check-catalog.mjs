#!/usr/bin/env node
// Quality Harness V1 — 回归目录完整性校验（core 步骤 Q11）
//
// 为什么需要它：
//   回归目录如果指向了不存在的测试文件，就会变成「纸面保护」——
//   报告里写着 REG-PRIV-001 被保护，实际什么都没跑。
//   所以 catalog 里每一个 tests[]/sourceFiles[] 路径都必须真实存在，
//   id 必须唯一且符合 REG-<DOMAIN>-<NNN>，qualitySteps 必须指向真实存在的 profile 步骤。
//
// 退出码：0 = 目录自洽；1 = 有引用悬空。

import fs from 'node:fs';
import path from 'node:path';

import { PROFILES } from './profiles.mjs';

const CATALOG = 'tests/quality/regression-catalog.json';
const ID_PATTERN = /^REG-[A-Z]+-\d{3}$/;

let failures = 0;
const problems = [];

function fail(message) {
  failures += 1;
  problems.push(message);
}

const catalogPath = path.resolve(CATALOG);
if (!fs.existsSync(catalogPath)) {
  console.error(`✖ regression catalog missing: ${CATALOG}`);
  process.exit(1);
}

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
} catch (error) {
  console.error(`✖ regression catalog is not valid JSON: ${error.message}`);
  process.exit(1);
}

const entries = catalog.entries;
if (!Array.isArray(entries) || entries.length === 0) {
  console.error('✖ regression catalog has no entries');
  process.exit(1);
}

// 收集所有 profile 里出现过的 step id
const knownStepIds = new Set();
for (const profile of Object.values(PROFILES)) {
  for (const step of profile.steps) knownStepIds.add(step.id);
}

const seenIds = new Set();
const requiredFields = ['id', 'domain', 'title', 'protection', 'tests', 'qualitySteps', 'severity'];

for (const entry of entries) {
  const label = entry?.id || '(entry without id)';

  for (const field of requiredFields) {
    if (entry[field] == null || (Array.isArray(entry[field]) && entry[field].length === 0)) {
      fail(`${label}: missing required field "${field}"`);
    }
  }

  if (typeof entry.id === 'string') {
    if (!ID_PATTERN.test(entry.id)) fail(`${label}: id does not match REG-<DOMAIN>-<NNN>`);
    if (seenIds.has(entry.id)) fail(`${label}: duplicate id`);
    seenIds.add(entry.id);
  }

  if (entry.domain && catalog.domains && !catalog.domains[entry.domain]) {
    fail(`${label}: domain "${entry.domain}" is not declared in catalog.domains`);
  }

  for (const testPath of entry.tests || []) {
    if (!fs.existsSync(path.resolve(testPath))) fail(`${label}: referenced test does not exist → ${testPath}`);
  }

  for (const sourcePath of entry.sourceFiles || []) {
    if (!fs.existsSync(path.resolve(sourcePath))) fail(`${label}: referenced source file does not exist → ${sourcePath}`);
  }

  for (const stepId of entry.qualitySteps || []) {
    if (!knownStepIds.has(stepId)) fail(`${label}: qualitySteps references unknown step "${stepId}"`);
  }

  if (entry.incident == null && entry.mustNotRegress == null) {
    fail(`${label}: needs at least one of "incident" (real accident) or "mustNotRegress" (binding constraint)`);
  }
}

// 反向检查：core 里声明了 regressionIds 的步骤，必须真的登记过
for (const profile of Object.values(PROFILES)) {
  for (const step of profile.steps) {
    for (const id of step.regressionIds || []) {
      if (!seenIds.has(id)) fail(`profile step ${step.id} declares regressionIds "${id}" which is not in the catalog`);
    }
  }
}

console.log('');
console.log('Regression catalog integrity');
console.log(`  file    : ${CATALOG}`);
console.log(`  entries : ${entries.length}`);
console.log(`  domains : ${Object.keys(catalog.domains || {}).length}`);
console.log(`  stepIds : ${[...knownStepIds].join(', ')}`);
console.log('');

if (failures > 0) {
  console.log(`CATALOG INVALID: ${failures} problem(s)`);
  for (const problem of problems) console.log(`  ✖ ${problem}`);
  process.exit(1);
}

const byDomain = new Map();
for (const entry of entries) byDomain.set(entry.domain, (byDomain.get(entry.domain) || 0) + 1);
console.log('  coverage by domain:');
for (const [domain, count] of [...byDomain.entries()].sort()) {
  console.log(`    ${domain.padEnd(9)} ${count}`);
}
console.log('');
console.log('CATALOG OK');
process.exit(0);
