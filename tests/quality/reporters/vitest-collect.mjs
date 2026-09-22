// Quality Harness V2 — Vitest 结果采集 reporter（V2 要求 #5）
//
// 为什么需要它：
//   V1 的 quality:core 先把 Q02 跑一遍全量 vitest，然后又用 Q04–Q07 把里面
//   一部分测试文件**再跑一遍**，只为让「隐私/网关/审批/resultStore」在报告里
//   各占一行。代价是总时长增加，而且同一批失败会在报告里重复计数。
//
//   V2 改为：**只跑一次** vitest，由本 reporter 把逐测试结果写成 JSON，
//   再由 classify-vitest.mjs 按文件把结果归入各边界类别。
//
// 用法：
//   QUALITY_VITEST_RESULT=<输出文件> npx vitest run \
//     --reporter=default --reporter=./tests/quality/reporters/vitest-collect.mjs
//
// 实测要点（避免以后重复踩坑）：
//   * Vitest 4 的收尾钩子是 **onTestRunEnd(files, errors, reason)**。
//     尝试过的 onFinished 在 Vitest 4 里**不再被调用** —— reporter 会被构造、
//     onInit 会触发，但 onFinished 始终不触发，采集文件永远不生成。
//   * 每个 "file" 没有 assertionResults；测试树在 `file.task` 里，
//     需要递归 `task.tasks` 才能拿到叶子测试与其状态。
//
// 设计约束：只写文件，不往 stdout 输出额外内容，避免干扰默认 reporter 的诊断输出。

import fs from 'node:fs';
import path from 'node:path';

/** 状态归一化：Vitest 4 用 'pass'/'fail'/'skip'/'todo'/'run'/'queued'。 */
const STATE_MAP = {
  pass: 'passed',
  fail: 'failed',
  skip: 'skipped',
  todo: 'todo',
  run: 'running',
  queued: 'queued',
};

function normalizeState(state) {
  return STATE_MAP[state] || state || 'unknown';
}

/** 递归收集叶子测试。 */
function collectLeaves(task, out = []) {
  if (!task) return out;
  if (task.type === 'test' || (task.type === undefined && !Array.isArray(task.tasks))) {
    out.push(task);
    return out;
  }
  for (const child of task.tasks || []) collectLeaves(child, out);
  return out;
}

/** 把绝对路径压成仓库相对路径，避免报告泄漏本机目录。 */
function normalizePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const marker = '/costhub/';
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : normalized;
}

export default class QualityCollectorReporter {
  constructor() {
    this.unhandledErrors = [];
  }

  onUnhandledError(error) {
    this.unhandledErrors.push({ message: String(error?.message || error), name: error?.name || null });
  }

  onTestRunEnd(files = [], errors = [], reason) {
    const outputFile = process.env.QUALITY_VITEST_RESULT;
    if (!outputFile) return; // 未指定输出文件时静默：不影响任何人正常跑 vitest

    const results = [];
    for (const file of files) {
      const leaves = collectLeaves(file.task);
      const states = leaves.map(leaf => normalizeState(leaf.result?.state ?? leaf.mode));
      const failedNames = leaves
        .filter((leaf, index) => states[index] === 'failed')
        .map(leaf => leaf.name || '(unnamed)');

      results.push({
        file: normalizePath(file.name || file.relativeModuleId || file.moduleId || ''),
        status: file.task?.result?.state ? normalizeState(file.task.result.state) : (failedNames.length ? 'failed' : 'passed'),
        tests: leaves.length,
        passed: states.filter(state => state === 'passed').length,
        failed: states.filter(state => state === 'failed').length,
        skipped: states.filter(state => state === 'skipped').length,
        todo: states.filter(state => state === 'todo').length,
        failedTestNames: failedNames,
        durationMs: typeof file.task?.result?.duration === 'number' ? Math.round(file.task.result.duration) : null,
      });
    }

    for (const error of Array.isArray(errors) ? errors : []) {
      this.unhandledErrors.push({ message: String(error?.message || error), name: error?.name || null });
    }

    const payload = {
      schemaVersion: 2,
      collector: 'vitest-collect.mjs',
      collectedAt: new Date().toISOString(),
      runReason: reason ?? null,
      totals: {
        files: results.length,
        tests: results.reduce((sum, r) => sum + r.tests, 0),
        passed: results.reduce((sum, r) => sum + r.passed, 0),
        failed: results.reduce((sum, r) => sum + r.failed, 0),
        skipped: results.reduce((sum, r) => sum + r.skipped, 0),
      },
      unhandledErrors: this.unhandledErrors,
      files: results,
    };

    try {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // 写不进去也不能让 vitest 崩 —— 分类缺失会在 classify-vitest.mjs 被发现并 fail closed
    }
  }
}
