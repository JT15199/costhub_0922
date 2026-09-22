// Quality Harness V2 — 阶段执行器（步骤循环 + 抖动重跑 + 草稿报告）
//
// 从 V1 的 run-quality.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
// 职责边界很清楚：
//   本文件负责「怎么跑步骤、怎么判定单步结果、怎么把中间态写盘」；
//   run-quality.mjs 负责「读配置、拼环境、按阶段调度、决定退出码」。

import fs from 'node:fs';
import path from 'node:path';

import { runStep } from './exec.mjs';
import { buildSummary, formatDuration, renderMarkdown } from './report.mjs';
import { redactSummary } from './redact.mjs';

const COLORS = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[34m',
};

/**
 * Vitest 逐测试结果的落盘位置。
 * 由 reporters/vitest-collect.mjs 写入、classify-vitest.mjs 读取。
 * 放在 artifacts/quality/ 下，但**不属于报告文件** ——
 * 泄漏检查只扫报告（见 check-report-leaks.mjs 的 --reports 白名单）。
 */
export const VITEST_COLLECTED = path.join(process.cwd(), 'artifacts', 'quality', 'vitest-collected.json');

function paint(color, text, enabled) {
  return enabled ? `${color}${text}${COLORS.reset}` : text;
}

/**
 * 执行一组步骤，返回报告步骤对象数组。
 *
 * 行为约定（与 V1 一致，V2 未放宽）：
 *   * 单步失败**不中断**后续步骤 —— 先跑完再汇总，报告才完整；
 *   * blockedExitCodes：把约定退出码映射为 blocked（环境不具备，不是代码坏了）；
 *   * flakeRetry：仅对声明了该字段的步骤生效，重跑通过降级为 warning 并留痕。
 *
 * @param {object[]} specs      步骤定义（来自 profiles.mjs）
 * @param {object} options
 * @param {boolean} options.color
 * @param {Record<string,string>} options.env 附加给子进程的环境变量（例如 fixture 密码）
 * @param {(step: object) => void} [options.onStepDone]
 */
export async function executeSteps(specs, { color = false, env = {}, onStepDone } = {}) {
  const steps = [];

  for (const [index, spec] of specs.entries()) {
    const label = `[${index + 1}/${specs.length}] ${spec.id} ${spec.title}`;
    process.stdout.write(`${paint(COLORS.blue, '▶', color)} ${label} ${COLORS.dim}…${COLORS.reset}\n`);

    const result = await runStep({
      ...spec,
      env: { QUALITY_VITEST_RESULT: VITEST_COLLECTED, ...env },
      onOutput: process.env.QUALITY_VERBOSE ? chunk => process.stdout.write(chunk) : undefined,
    });

    if (Array.isArray(spec.blockedExitCodes) && spec.blockedExitCodes.includes(result.exitCode)) {
      result.status = 'blocked';
      result.blockedReason = `exit ${result.exitCode} reported as environment-blocked by the step contract`;
      result.reason = result.blockedReason;
    }

    await applyFlakeRetry(result, spec, { QUALITY_VITEST_RESULT: VITEST_COLLECTED, ...env }, color);

    const icon = result.status === 'pass' ? paint(COLORS.green, '✔', color)
      : result.status === 'warning' ? paint(COLORS.yellow, '▲', color)
        : result.status === 'blocked' ? paint(COLORS.yellow, '⏸', color)
          : paint(COLORS.red, '✖', color);
    process.stdout.write(
      `  ${icon} ${result.status.toUpperCase()} ${COLORS.dim}(${formatDuration(result.durationMs)})${COLORS.reset}` +
      `${result.reason ? ` ${COLORS.dim}${result.reason}${COLORS.reset}` : ''}\n`,
    );

    const reportStep = toReportStep(result);
    steps.push(reportStep);
    if (onStepDone) onStepDone(reportStep);
  }

  return steps;
}

/** 抖动重跑：只在首次 fail 且步骤声明了 flakeRetry 时执行。 */
async function applyFlakeRetry(result, spec, env, color) {
  const max = spec.flakeRetry?.max ?? 0;
  if (result.status !== 'fail' || max <= 0) return;

  process.stdout.write(`  ${paint(COLORS.yellow, '↻', color)} failed — rerunning once to distinguish flake from regression\n`);

  const retry = await runStep({ ...spec, env, onOutput: undefined });
  result.retry = {
    attempted: true,
    firstExitCode: result.exitCode,
    retryExitCode: retry.exitCode,
    retryStatus: retry.status,
    durationMs: retry.durationMs,
  };

  if (retry.status === 'pass') {
    result.status = 'warning';
    result.flaky = true;
    result.reason = `flaky: failed on first run (exit ${result.exitCode}), passed on rerun — treated as non-blocking but recorded`;
  } else {
    result.status = retry.status === 'blocked' ? 'blocked' : 'fail';
    result.reason = `failed twice (exit ${result.exitCode}, then ${retry.exitCode}) — not a flake`;
    result.stderrTail = retry.stderrTail || result.stderrTail;
    result.stdoutTail = retry.stdoutTail || result.stdoutTail;
  }
}

/** 只保留报告需要的字段（避免把内部结构写进 JSON）。 */
export function toReportStep(step) {
  return {
    id: step.id,
    title: step.title,
    command: step.command,
    required: step.required,
    status: step.status,
    exitCode: step.exitCode,
    durationMs: step.durationMs,
    startAt: step.startAt,
    endAt: step.endAt,
    reason: step.reason ?? null,
    blockedReason: step.blockedReason ?? null,
    timedOut: Boolean(step.timedOut),
    flaky: Boolean(step.flaky),
    regressionIds: step.regressionIds || [],
    stdoutTail: step.stdoutTail || '',
    stderrTail: step.stderrTail || '',
    retry: step.retry || null,
  };
}

/**
 * 写草稿报告。
 *
 * V2 要求 #3 的关键：正式报告要到所有步骤跑完才写，而泄漏检查必须在
 * 「报告已存在」之后才能校验**本次运行的报告**。因此引入草稿阶段：
 * 阶段一写 draft → Q12 扫 draft → 通过后才 finalize 成正式报告。
 *
 * @returns {string} 草稿文件所在目录
 */
export function writeDraftReport({ runDir, summary, draftBasename }) {
  fs.mkdirSync(runDir, { recursive: true });
  const safe = redactSummary(summary);
  fs.writeFileSync(path.join(runDir, `${draftBasename}.json`), `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, `${draftBasename}.md`), renderMarkdown(safe), 'utf8');
  return runDir;
}

export { buildSummary, renderMarkdown };
