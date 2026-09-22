// Quality Harness V2 — 运行环境信息采集
//
// 从 V1 的 run-quality.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
// 只做两件事：采集 git 状态与工具链版本。
// 刻意**不采集**用户名、绝对路径、Token —— 这些会进报告，属于禁止项。

import { execFileSync } from 'node:child_process';

function tryExec(command, args, timeout = 10000) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function firstLine(text) {
  return text ? String(text).split('\n')[0].trim() : null;
}

/** git 提交、分支与工作区洁净度。 */
export function collectGit() {
  const status = tryExec('git', ['status', '--porcelain']);
  return {
    commit: tryExec('git', ['rev-parse', 'HEAD']) || 'unknown',
    shortCommit: tryExec('git', ['rev-parse', '--short', 'HEAD']),
    branch: tryExec('git', ['branch', '--show-current']) || null,
    dirty: status == null ? null : status.length > 0,
    dirtyFileCount: status ? status.split('\n').filter(Boolean).length : null,
  };
}

/** 平台与工具链版本。 */
export function collectEnvironment() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: tryExec('npm', ['--version']),
    rust: firstLine(tryExec('rustc', ['--version'])),
    cargo: firstLine(tryExec('cargo', ['--version'])),
    python: firstLine(tryExec('python', ['--version'])),
  };
}

/** 生成 run-id：可排序、含 profile、不含用户名。 */
export function makeRunId(profileName, date = new Date()) {
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
  return `${stamp}-${profileName}`;
}
