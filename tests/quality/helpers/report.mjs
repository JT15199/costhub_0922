// Quality Harness V1 — 机器可读 + 人类可读报告
//
// 输出（实施指导 §5.3）：
//   artifacts/quality/<run-id>/summary.json
//   artifacts/quality/<run-id>/summary.md
//   artifacts/quality/latest-summary.json
//   artifacts/quality/latest-summary.md
//
// 所有进入报告的文本必须先过 helpers/redact.mjs，禁止直接写原始 stdout/stderr。

import fs from 'node:fs';
import path from 'node:path';
import { redactSummary, redact } from './redact.mjs';

export const SCHEMA_VERSION = 1;

const STATUS_LABEL = {
  pass: 'PASS',
  fail: 'FAIL',
  blocked: 'BLOCKED',
  warning: 'WARN',
  skipped: 'SKIP',
};

/** 生成 run-id：可排序、含 profile、不含用户名。 */
export function makeRunId(profile, date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
  return `${stamp}-${profile}`;
}

/**
 * 汇总 steps → 报告对象。
 *
 * gate 语义（关键：不允许把失败伪装成 warning）：
 *   FAIL            → 任一 required 步骤 fail
 *   BLOCKED_ENVIRONMENT → 无 required fail，但存在 blocked 步骤
 *   PASS            → required 全 pass（warning 不阻塞 gate，但会被计数并列出）
 */
export function buildSummary({ profile, runId, git, environment, startedAt, durationMs, steps, notes = [], artifacts = {} }) {
  const requiredSteps = steps.filter(step => step.required);
  const requiredFailures = requiredSteps.filter(step => step.status === 'fail');
  const blocked = steps.filter(step => step.status === 'blocked');
  const warnings = steps.filter(step => step.status === 'warning');
  const passed = steps.filter(step => step.status === 'pass');

  let gate = 'PASS';
  if (requiredFailures.length > 0) gate = 'FAIL';
  else if (blocked.length > 0) gate = 'BLOCKED_ENVIRONMENT';

  return redactSummary({
    schemaVersion: SCHEMA_VERSION,
    profile,
    runId,
    git,
    environment,
    startedAt,
    durationMs,
    gate,
    counts: {
      total: steps.length,
      passed: passed.length,
      failed: steps.filter(step => step.status === 'fail').length,
      blocked: blocked.length,
      warnings: warnings.length,
      skipped: steps.filter(step => step.status === 'skipped').length,
    },
    requiredFailures: requiredFailures.length,
    warnings: warnings.length,
    blockedReason: blocked.length
      ? blocked.map(step => `${step.id}: ${step.blockedReason || step.reason || 'blocked'}`).join('; ')
      : null,
    steps,
    notes,
    artifacts,
  });
}

/** 人类可读 Markdown。 */
export function renderMarkdown(summary) {
  const lines = [];
  const { profile, runId, git, environment, steps } = summary;

  lines.push('# CostHub Quality Report');
  lines.push('');
  lines.push(`Commit: \`${git.commit || 'unknown'}\`${git.dirty ? ' (dirty working tree)' : ''}${git.branch ? ` · branch \`${git.branch}\`` : ''}`);
  lines.push(`Profile: \`${profile}\``);
  lines.push(`Run: \`${runId}\` · ${summary.startedAt} · ${formatDuration(summary.durationMs)}`);
  lines.push(`Environment: ${environment.platform} · node ${environment.node}${environment.rust ? ` · rust ${environment.rust}` : ''}`);
  lines.push('');

  lines.push('| Step | Result | Duration | Detail |');
  lines.push('|---|---|---|---|');
  for (const step of steps) {
    const label = STATUS_LABEL[step.status] || step.status.toUpperCase();
    const detail = step.blockedReason || step.reason || (step.regressionIds?.length ? step.regressionIds.join(' ') : '');
    lines.push(`| ${escapeCell(step.title)}${step.required ? '' : ' _(optional)_'} | ${label} | ${formatDuration(step.durationMs)} | ${escapeCell(detail)} |`);
  }
  lines.push('');

  lines.push(`Counts: ${summary.counts.passed} pass · ${summary.counts.failed} fail · ${summary.counts.blocked} blocked · ${summary.counts.warnings} warn · ${summary.counts.skipped} skip`);
  lines.push('');

  if (summary.blockedReason) {
    lines.push('Blocked:');
    lines.push('');
    lines.push('```text');
    lines.push(redact(summary.blockedReason));
    lines.push('```');
    lines.push('');
  }

  const failedSteps = steps.filter(step => step.status === 'fail');
  if (failedSteps.length) {
    lines.push('## Failures');
    lines.push('');
    for (const step of failedSteps) {
      lines.push(`### ${step.title} (\`${step.id}\`)`);
      lines.push('');
      lines.push(`\`${step.command}\` → exit ${step.exitCode}${step.timedOut ? ' (timeout)' : ''}`);
      lines.push('');
      const tail = (step.stderrTail || step.stdoutTail || '').trim();
      if (tail) {
        lines.push('```text');
        lines.push(tail.slice(-4000));
        lines.push('```');
        lines.push('');
      }
    }
  }

  const warningSteps = steps.filter(step => step.status === 'warning');
  if (warningSteps.length) {
    lines.push('## Warnings (non-blocking)');
    lines.push('');
    for (const step of warningSteps) {
      lines.push(`- **${step.title}** (\`${step.id}\`) — ${step.reason || 'warning'}`);
    }
    lines.push('');
  }

  if (summary.notes?.length) {
    lines.push('## Notes');
    lines.push('');
    for (const note of summary.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`QUALITY GATE: ${summary.gate}`);
  lines.push('');
  lines.push('_Report generated by tests/quality/run-quality.mjs (Quality Harness V1). Text is redacted before writing._');
  lines.push('');
  return lines.join('\n');
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}

/**
 * 落盘报告。返回实际写出的路径（相对仓库根）。
 */
export function writeReports(summary, { root = process.cwd(), artifactsDir = 'artifacts/quality' } = {}) {
  const base = path.join(root, artifactsDir);
  const runDir = path.join(base, summary.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = renderMarkdown(summary);

  const written = [];
  for (const [dir, suffix] of [[runDir, ''], [base, '-latest']]) {
    if (suffix === '') {
      written.push(writeFile(path.join(dir, 'summary.json'), json));
      written.push(writeFile(path.join(dir, 'summary.md'), markdown));
    } else {
      written.push(writeFile(path.join(dir, 'latest-summary.json'), json));
      written.push(writeFile(path.join(dir, 'latest-summary.md'), markdown));
    }
  }

  return {
    runDir: path.relative(root, runDir).replace(/\\/g, '/'),
    files: written.map(item => path.relative(root, item).replace(/\\/g, '/')),
  };
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}
