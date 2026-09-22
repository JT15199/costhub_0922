#!/usr/bin/env node
// Quality Harness V2 — 桌面 fixture 准备（full 档 F01）
//
// 目标：产出一个**与正式库完全隔离、且可被机器证明**的 CostHub 运行环境。
//
// 为什么不用 artifacts/agent-upgrade 里那份现成的 database-copy.db：
//   1) 它本身是「某次运行库的副本」，语义上不可证明为合成夹具；
//   2) artifacts/ 整体被 .gitignore 忽略，fresh clone 后不存在，
//      把它作为 full 档前置会让 quality:full 在新机器上直接不可用。
//   因此这里改为**用被测程序自己创建 schema**：跑一次 exe 让它 bootstrap 空库，
//   再写入测试账号与 fixture marker。这样夹具内容 = 程序自身 schema，不会漂移，
//   且不含任何真实业务数据。
//
// V2 变化（要求 #4）：**不再硬编码明文密码**。
//   凭据由 helpers/fixtureCredentials.mjs 解析：优先 config.fixture.passwordEnvVar
//   指定的环境变量；未提供时由 runner 生成一次性随机密码并经进程环境传入。
//   manifest 里只记录用户名与密码来源，不记录密码本身。
//
// 产物：
//   artifacts/quality/desktop-fixture/
//     CostHub.exe           portable 副本（来自 tauri release 构建）
//     costhub.db            隔离夹具库（含 quality_fixture=1 标记 + 测试账号）
//     desktop-fixture.json  机器可读的夹具描述（**不含密码明文**）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { assertFixtureDatabase, integrityCheck, seedFixture, snapshotCounts } from '../helpers/dbGuard.mjs';
import { loadConfig } from '../helpers/config.mjs';
import { resolveFixtureCredentials } from '../helpers/fixtureCredentials.mjs';
import { FIXTURE_BOM_ROWS, FIXTURE_PROJECT_CODE, FIXTURE_PROJECT_NAME, seedFixtureData } from './fixtureData.mjs';

// node:sqlite 是内置模块，但用 createRequire 取用可以让本文件在
// 不支持该模块的 Node 版本上给出清晰错误而不是顶层语法崩溃。
const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

const ROOT = process.cwd();
const DB_NAME = 'costhub.db';
const EXE_NAME = 'CostHub.exe';

const RELEASE_EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'costhub.exe');
const PORTABLE_EXE = path.join(ROOT, 'artifacts', 'agent-upgrade', '20260910-portable', 'CostHub-Portable', EXE_NAME);

function log(message) {
  console.log(`[fixture] ${message}`);
}

/** 找一个可用的 release 可执行文件。 */
function locateExecutable() {
  if (fs.existsSync(RELEASE_EXE)) return RELEASE_EXE;
  if (fs.existsSync(PORTABLE_EXE)) return PORTABLE_EXE;
  return null;
}

/** 跑一次 exe，让它 bootstrap 出完整 schema，然后退出。 */
async function bootstrapSchema(exePath, cwd, timeoutMs = 60000) {
  log('bootstrapping schema with the application under test (first run creates the database)…');

  const child = spawn(exePath, [], { cwd, windowsHide: true, stdio: 'ignore', detached: false });

  const deadline = Date.now() + timeoutMs;
  const dbPath = path.join(cwd, DB_NAME);

  // 等到 settings 表出现即视为 bootstrap 完成（schema 由前端 ensureSchema 建）
  for (;;) {
    if (Date.now() > deadline) {
      kill(child);
      throw new Error(`bootstrap timed out after ${timeoutMs}ms (database appeared: ${fs.existsSync(dbPath)})`);
    }
    if (fs.existsSync(dbPath)) {
      const probe = probeSchema(dbPath);
      if (probe.ready) {
        log(`schema ready: ${probe.tableCount} tables, settings=${probe.hasSettings}`);
        break;
      }
    }
    await sleep(500);
  }

  kill(child);
  await sleep(1200);

  // WebView2 会留下 WAL/SHM，settle 后再继续，避免读到半写状态
  return dbPath;
}

function probeSchema(dbPath) {
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const tables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
      const hasSettings = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get());
      const hasProjects = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get());
      return { ready: hasSettings && hasProjects && tables > 30, tableCount: tables, hasSettings };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ready: false, error: String(error?.message || error) };
  }
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* fallthrough */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== 'win32') {
    console.error('[fixture] BLOCKED: desktop fixture is Windows-only (WebView2 runtime).');
    process.exit(3);
  }

  const config = loadConfig();
  const fixtureDir = config.fixtureRoot;

  // V2：凭据不落明文。优先环境变量；未提供则由 runner 传入的随机值兜底。
  const credentials = resolveFixtureCredentials(config);

  const exeSource = locateExecutable();
  if (!exeSource) {
    console.error('[fixture] BLOCKED: no CostHub executable found.');
    console.error(`[fixture]   looked for: src-tauri/target/release/costhub.exe`);
    console.error(`[fixture]   and:        artifacts/agent-upgrade/20260910-portable/CostHub-Portable/CostHub.exe`);
    console.error('[fixture]   build one with: npm run tauri:build');
    process.exit(3);
  }
  log(`executable: ${path.relative(ROOT, exeSource).replace(/\\/g, '/')}`);

  // 每次都重建：夹具必须可重复再生，且绝不能复用上一次可能被写脏的库
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });

  const exeTarget = path.join(fixtureDir, EXE_NAME);
  fs.copyFileSync(exeSource, exeTarget);

  const dbPath = await bootstrapSchema(exeTarget, fixtureDir);

  // 写入测试账号 + fixture marker（这是夹具准备阶段，允许写；写的是夹具副本）
  seedFixture(dbPath, {
    username: credentials.username,
    passwordHash: credentials.passwordHash,
    passwordChanged: '1',
    fixtureRoot: fixtureDir,
    extraSettings: {
      // 明确关掉 fixture 里的本地模型依赖，保证 full 档不因 Ollama 缺失而假失败
      local_ai_model: '',
    },
  });
  log(`seeded fixture marker + test identity (password source: ${credentials.source})`);

  // 播种合成业务数据，让 E2E-004 有可断言的已知数据集
  const seeded = seedFixtureData(dbPath);
  if (!seeded.ok) {
    console.error(`[fixture] ABORT: seeding fixture data failed — ${seeded.reason}`);
    process.exit(1);
  }
  log(`seeded synthetic project ${seeded.projectCode} (id=${seeded.projectId}) with ${seeded.expectedBomRows} BOM rows (parts +${seeded.partsInserted}, boms +${seeded.bomInserted})`);
  for (const note of seeded.schemaNotes || []) log(`schema: ${note}`);

  // 机器证明：这份库确实是 fixture
  const proof = assertFixtureDatabase(dbPath, {
    fixtureRoot: fixtureDir,
    databaseFilename: config.database.databaseFilename,
    markerKey: config.database.fixtureMarkerKey,
    markerValue: config.database.fixtureMarkerValue,
  });
  if (!proof.ok) {
    console.error(`[fixture] ABORT: fixture proof failed — ${proof.reason}`);
    process.exit(1);
  }
  log(`proof ok: marker=${proof.evidence.marker}, relative=${proof.evidence.relativeToFixtureRoot}, integrity=${proof.evidence.integrity}, counts=${JSON.stringify(proof.evidence.counts)}`);

  const manifest = {
    mode: 'quality-desktop-fixture',
    generatedAt: new Date().toISOString(),
    fixtureOnly: true,
    formalDatabaseTouched: false,
    database: DB_NAME,
    executable: EXE_NAME,
    // V2：只记录用户名与密码来源，**不记录密码本身**。
    // 密码通过进程环境在 runner → prepare-fixture → run-e2e 之间传递。
    identity: { username: credentials.username, passwordSource: credentials.source },
    fixtureMarker: { key: config.database.fixtureMarkerKey, value: config.database.fixtureMarkerValue },
    // E2E-004 的断言目标
    projectCode: FIXTURE_PROJECT_CODE,
    projectName: FIXTURE_PROJECT_NAME,
    expectedBomModels: FIXTURE_BOM_ROWS.map(row => row.model),
    integrity: integrityCheck(dbPath),
    counts: snapshotCounts(dbPath),
    note:
      'Synthetic fixture: schema created by the application under test, no real business data. ' +
      'Recreated on every prepare run. No plaintext credential is stored in this manifest.',
  };
  fs.writeFileSync(path.join(fixtureDir, 'desktop-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(JSON.stringify({
    ok: true,
    fixtureDir: 'artifacts/quality/desktop-fixture',
    projectCode: FIXTURE_PROJECT_CODE,
    integrity: manifest.integrity,
    counts: manifest.counts,
  }, null, 2));
  process.exit(0);
}

main().catch(error => {
  console.error(`[fixture] FAILED: ${error?.stack || error}`);
  process.exit(1);
});
