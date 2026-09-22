// Quality Harness V2 — runner 的控制台输出
//
// 从 V1 的 run-quality.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
// runner 只负责调度与退出码；「怎么把结果画到终端」放在这里。

import { formatDuration } from './report.mjs';

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[34m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const colorEnabled = useColor;
export const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text);
export { C };

/** 运行头部：profile / commit / run-id / 环境 / 凭据来源。 */
export function banner(profile, runId, git, environment, passwordSource) {
  console.log('');
  console.log(paint(C.bold, 'CostHub Quality Harness V2'));
  console.log(`${C.dim}profile${C.reset}  ${profile.name}  ${C.dim}${profile.description}${C.reset}`);
  console.log(`${C.dim}commit ${C.reset}  ${git.commit}${git.dirty ? paint(C.yellow, ' (dirty)') : ''}${git.branch ? `  ${C.dim}branch${C.reset} ${git.branch}` : ''}`);
  console.log(`${C.dim}run    ${C.reset}  ${runId}`);
  console.log(`${C.dim}env    ${C.reset}  ${environment.platform}/${environment.arch} · node ${environment.node}${environment.rust ? ` · ${environment.rust}` : ''}`);
  console.log(`${C.dim}fixture${C.reset}  password source: ${passwordSource === 'env' ? 'environment variable' : `${passwordSource} (one-time, not in git, not in report)`}`);
  console.log('');
}

/** 步骤汇总表 + gate 结论。 */
export function printSummary(summary, written, leakPassed) {
  console.log('');
  console.log(paint(C.bold, '─'.repeat(64)));
  for (const step of summary.steps) {
    const icon = step.status === 'pass' ? paint(C.green, '✔')
      : step.status === 'warning' ? paint(C.yellow, '▲')
        : step.status === 'blocked' ? paint(C.yellow, '⏸')
          : paint(C.red, '✖');
    const tag = step.required ? '' : paint(C.dim, ' (optional)');
    console.log(`${icon} ${step.id.padEnd(5)} ${step.title.padEnd(44)} ${formatDuration(step.durationMs).padStart(7)}${tag}`);
  }
  console.log(paint(C.bold, '─'.repeat(64)));
  console.log(`Counts: ${summary.counts.passed} pass · ${summary.counts.failed} fail · ${summary.counts.blocked} blocked · ${summary.counts.warnings} warn · ${summary.counts.skipped} skip`);
  console.log(`Total:  ${formatDuration(summary.durationMs)}`);
  console.log('');

  if (summary.blockedReason) {
    console.log(paint(C.yellow, `BLOCKED: ${summary.blockedReason}`));
    console.log('');
  }

  const gate = leakPassed ? summary.gate : 'FAIL';
  const gateColor = gate === 'PASS' ? C.green : gate === 'FAIL' ? C.red : C.yellow;
  console.log(`${paint(C.bold, 'QUALITY GATE:')} ${paint(gateColor, gate)}`);
  if (!leakPassed) console.log(paint(C.red, '  (finalize aborted by report leak check — draft retained)'));
  console.log('');

  if (leakPassed) {
    console.log(`${C.dim}report  ${written.runDir}/summary.md${C.reset}`);
    console.log(`${C.dim}json    ${written.runDir}/summary.json${C.reset}`);
    console.log(`${C.dim}latest  artifacts/quality/latest-summary.md${C.reset}`);
  }
  console.log('');
}

/** 用法说明。 */
export function printUsage(profiles) {
  console.log('');
  console.log(`${paint(C.bold, 'Usage:')} node tests/quality/run-quality.mjs <profile>`);
  console.log('');
  for (const profile of Object.values(profiles)) {
    console.log(`  ${paint(C.bold, profile.name.padEnd(6))} ${profile.description}`);
  }
  console.log(`  ${paint(C.bold, 'report'.padEnd(6))} re-render the latest summary.md from latest-summary.json`);
  console.log('');
}
