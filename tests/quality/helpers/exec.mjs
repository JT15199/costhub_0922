// Quality Harness V1 — 子进程执行器
//
// 职责（实施指导 §5.1）：
//   * 启动子进程并记录 command / startAt / endAt / durationMs / exitCode / stdout / stderr
//   * 支持 timeout（超时按失败处理，并杀掉整棵进程树）
//   * 支持 Windows
//   * 不使用 shell 拼接不可信输入 —— 本文件所有命令都来自 profiles.mjs 的静态表，
//     并且优先走 program+args 直启；只有需要 .cmd/.bat shim（npm/npx）时才用 shell:true。
//   * stdout/stderr 进入报告前做脱敏
//   * 单个步骤失败不能导致整个 runner 立即退出（由调用方 ensure 决定）
//
// 退出码语义：
//   0                        → pass
//   非 0                     → fail
//   BLOCKED（见 classify）   → blocked（环境缺失，不是代码坏了）

import { spawn } from 'node:child_process';
import { redact, redactTail } from './redact.mjs';

/** 判定一条 stderr/stdout 是否意味着「环境不具备」而不是「代码坏了」。 */
const BLOCKED_MARKERS = [
  /is not recognized as an internal or external command/i,
  /CommandNotFoundException/i,
  /无法将.*项识别为/i,
  /不是内部或外部命令/i,
  /ENOENT.*spawn/i,
  /no such file or directory.*(python|cargo|rustc|node)/i,
  /error: could not find `Cargo\.toml`/i,
  /could not connect to server/i,
  /failed to connect .* port/i,
  /ERR_MODULE_NOT_FOUND/i,
];

/**
 * 把一次执行结果分类。
 * @returns {{status: 'pass'|'fail'|'blocked'|'warning', reason?: string}}
 */
export function classify({ exitCode, timedOut, stderr = '', stdout = '', required = true }) {
  if (timedOut) return { status: 'fail', reason: 'timeout' };
  if (exitCode === 0) return { status: 'pass' };
  const haystack = `${stderr}\n${stdout}`;
  for (const marker of BLOCKED_MARKERS) {
    if (marker.test(haystack)) return { status: 'blocked', reason: `environment: ${marker}` };
  }
  return { status: required ? 'fail' : 'warning', reason: `exit ${exitCode}` };
}

/** 杀掉整棵进程树（Node 子进程常带孙进程，直接 kill 会留孤儿）。 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      /* 落到下面的 child.kill */
    }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * 执行一个步骤。
 *
 * @param {object} step
 * @param {string} step.id            稳定步骤 id（用于报告与回归映射）
 * @param {string} step.title         人类可读标题
 * @param {string[]} step.command     命令数组；长度>1 时直启，不经过 shell
 * @param {string} [step.cwd]         工作目录（默认 process.cwd()）
 * @param {number} [step.timeoutMs]   超时（默认 15 分钟）
 * @param {boolean} [step.required]   是否属于 required gate（false → 失败降级为 warning）
 * @param {Record<string,string>} [step.env] 附加环境变量
 * @param {(chunk: string) => void} [step.onOutput] 实时回调（不脱敏，仅终端用）
 * @returns {Promise<object>} 步骤结果
 */
export async function runStep(step) {
  const {
    id,
    title = id,
    command,
    cwd = process.cwd(),
    timeoutMs = 15 * 60 * 1000,
    required = true,
    env = {},
    onOutput,
  } = step;

  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`runStep(${id}): command must be a non-empty array`);
  }

  const startAt = new Date();
  const started = Date.now();

  const result = {
    id,
    title,
    command: command.join(' '),
    cwd: relativeCwd(cwd),
    required,
    startAt: startAt.toISOString(),
    endAt: null,
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    status: 'fail',
    reason: undefined,
    stdoutTail: '',
    stderrTail: '',
    blockedReason: null,
    notes: [],
  };

  let child;
  let timedOut = false;
  const stdoutChunks = [];
  const stderrChunks = [];
  const MAX_BUFFER = 512 * 1024;

  try {
    child = spawnCommand(command, { cwd, env: { ...process.env, ...env } });
  } catch (error) {
    result.status = 'blocked';
    result.blockedReason = `spawn failed: ${error?.message || error}`;
    result.reason = 'spawn failed';
    result.endAt = new Date().toISOString();
    result.durationMs = Date.now() - started;
    return result;
  }

  // 命令不存在（Windows 常见）在 'error' 事件里出现，而不是抛异常
  let spawnError = null;
  child.on('error', error => { spawnError = error; });

  const collect = (chunks, chunk) => {
    if (chunks.length < 2000 && chunks.reduce((sum, part) => sum + part.length, 0) < MAX_BUFFER) {
      chunks.push(chunk);
    }
    if (onOutput) {
      // 只给终端，报告里仍然走脱敏
      try { onOutput(chunk); } catch { /* 终端回调失败不影响步骤 */ }
    }
  };

  child.stdout?.on('data', data => collect(stdoutChunks, data.toString()));
  child.stderr?.on('data', data => collect(stderrChunks, data.toString()));

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const exitCode = await new Promise(resolve => {
    child.on('close', code => resolve(code));
  });

  clearTimeout(timeoutHandle);

  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');

  result.endAt = new Date().toISOString();
  result.durationMs = Date.now() - started;
  result.exitCode = exitCode;
  result.timedOut = timedOut;
  result.stdoutTail = redactTail(stdout, 6000);
  result.stderrTail = redactTail(stderr, 6000);
  result.stdoutBytes = stdout.length;
  result.stderrBytes = stderr.length;

  if (spawnError) {
    result.status = 'blocked';
    result.blockedReason = `spawn error: ${spawnError.message}`;
    result.reason = 'spawn error';
    return result;
  }

  const verdict = classify({ exitCode, timedOut, stderr, stdout, required });
  result.status = verdict.status;
  result.reason = verdict.reason;
  if (verdict.status === 'blocked') result.blockedReason = verdict.reason;
  return result;
}

/** 去掉仓库根前缀，避免报告出现绝对路径。 */
function relativeCwd(cwd) {
  const root = process.cwd();
  const normalized = String(cwd).replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  if (normalized === normalizedRoot) return '.';
  if (normalized.startsWith(`${normalizedRoot}/`)) return normalized.slice(normalizedRoot.length + 1);
  return '<external-cwd>';
}

/**
 * 依据命令形状选择启动方式。
 * - 单个元素 → shell 执行（仅用于静态、可信命令串）
 * - 多元素   → 直启 program + args，不经过 shell（无注入面）
 * Windows 上 npm/npx 是 .cmd shim，必须经 shell 才能启动。
 */
function spawnCommand(command, options) {
  const [program, ...args] = command;
  const isWindows = process.platform === 'win32';
  const needsShell = command.length === 1 || (isWindows && /^(npm|npx|pnpm|yarn)$/i.test(program));

  if (needsShell) {
    return spawn(command.join(' '), {
      ...options,
      shell: true,
      windowsHide: true,
    });
  }
  return spawn(program, args, {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

export { killTree, redact };
