// Quality Harness V1 — 夹具程序启动器（测试侧）
//
// 只做三件事：在隔离目录里启动 CostHub.exe、等待 CDP 端口可用、结束时杀干净进程树。
// 不含业务逻辑，不接触正式数据库——启动前由调用方负责证明是 fixture。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { waitForCdpPort } from './cdpClient.mjs';

export const DEFAULT_CDP_PORT = 9244;

/** 找一个空闲端口（避免与上一次残留/其他工具抢 9244）。 */
export async function findFreePort(preferred = DEFAULT_CDP_PORT, attempts = 40) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free TCP port in range ${preferred}..${preferred + attempts - 1}`);
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 启动夹具内的 CostHub.exe，并打开 CDP 端口。
 *
 * @param {object} options
 * @param {string} options.dir         夹具目录（内含 CostHub.exe 与 costhub.db）
 * @param {number} [options.port]      CDP 端口
 * @param {number} [options.timeoutMs] 等待窗口出现的时间
 * @returns {Promise<{process: import('node:child_process').ChildProcess, port: number, pid: number, logs: string[]}>}
 */
export async function launchFixtureApp({ dir, port, timeoutMs = 60000 }) {
  const exePath = path.join(dir, 'CostHub.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`fixture executable missing: ${path.basename(exePath)} in ${path.basename(dir)}`);
  }

  const cdpPort = port ?? (await findFreePort());

  // WebView2 通过该环境变量接收附加浏览器参数；--remote-debugging-port 即 CDP 入口。
  // 注意：main.rs 在远程桌面会话（SESSIONNAME != Console）下会覆盖此变量为 --disable-gpu，
  // 因此 RDP 环境下 CDP 会不可用——这种情形由调用方报 BLOCKED，不伪装成 PASS。
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  };

  const child = spawn(exePath, [], {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const logs = [];
  const collect = chunk => {
    if (logs.length < 500) logs.push(chunk.toString());
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exitedEarly = null;
  child.once('exit', code => { exitedEarly = code; });

  try {
    await waitForCdpPort(cdpPort, { timeoutMs, isAlive: () => exitedEarly === null && child.exitCode === null });
  } catch (error) {
    killProcessTree(child);
    const detail = exitedEarly !== null
      ? `application exited early with code ${exitedEarly}`
      : 'application still running but CDP port never opened (WebView2 runtime missing?)';
    throw new Error(`LAUNCH_FAILED: ${error.message} — ${detail}`);
  }

  return { process: child, port: cdpPort, pid: child.pid, logs, get exited() { return exitedEarly; } };
}

/** 结束进程并等待退出；Windows 上必须杀进程树，否则 WebView2 子进程会残留。 */
export function killProcessTree(child, { waitMs = 8000 } = {}) {
  if (!child || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null);

  const finished = new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), waitMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });

  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return finished;
    } catch {
      /* 落到 kill */
    }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  return finished;
}

/** 等待进程退出。 */
export async function waitForExit(child, timeoutMs = 15000) {
  if (!child || child.exitCode !== null) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
