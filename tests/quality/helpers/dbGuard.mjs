// Quality Harness V2 — 数据库保护（严格目录白名单）
//
// V1 的问题（V2 要求 #1）：用**正则匹配路径特征**判断 fixture，存在误判风险。
// 例如 `D:/project/quality-old/test.db` 会因为路径里含 "quality" 而被放过。
//
// V2 改为**严格目录白名单**：
//   * 唯一合法位置由 config.database.fixtureDir 指定（默认 artifacts/quality/desktop-fixture）；
//   * 判定一律使用 path.relative()，要求相对路径**不以 .. 开头、不是绝对路径**；
//   * 删除 REQUIRED_DIR_MARKER 之类的正则/关键词匹配；
//   * 对「正式库可能所在的位置」保留一份**拒绝名单**（src/、data/、database/、production/ 等），
//     它是**额外的**拒绝条件，不承担白名单职责；
//   * fail closed：任何无法被明确证明为 fixture 的情况一律拒绝。
//
// 实现使用 Node 内置 node:sqlite（Node >= 23 免 flag），不引入新依赖。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from './config.mjs';

/** 默认 marker（与 config.json 保持一致；config 缺失时兜底，但 config 缺失本身会抛错）。 */
const DEFAULT_MARKER_KEY = 'quality_fixture';
const DEFAULT_MARKER_VALUE = '1';

/**
 * 明确禁止的目录（相对仓库根，或路径中出现的目录名）。
 * 这些是「正式库可能所在的位置」，命中即拒绝 —— 这是白名单之外的**额外**拒绝条件。
 */
const FORBIDDEN_PATH_SEGMENTS = [
  'src',
  'src-tauri',
  'data',
  'database',
  'production',
  'prod',
  'target',
  'release',
  'exports',
  'backups',
];

/**
 * 用 path.relative 判断 child 是否严格位于 parent 之内。
 *
 * 这替代了 V1 的正则匹配。要点：
 *   * 先 resolve 成绝对路径，消除 `..`、`./`、符号链接无关的大小写差异交给平台处理；
 *   * relative === '' 表示同一个路径（不视为「在内部」，避免 parent 自身被当成合法库）；
 *   * relative 以 '..' 开头或为绝对路径 → 不在内部。
 *
 * @returns {{inside: boolean, relative: string}}
 */
export function isStrictlyInside(parent, child) {
  const absParent = path.resolve(parent);
  const absChild = path.resolve(child);
  const relative = path.relative(absParent, absChild);

  if (relative === '') return { inside: false, relative };
  // 绝对路径：说明根本不在同一棵树下（Windows 跨盘符时 path.relative 会返回绝对路径）
  if (path.isAbsolute(relative)) return { inside: false, relative };
  // 以 .. 开头：向上逃逸
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || relative.startsWith('../')) {
    return { inside: false, relative };
  }
  return { inside: true, relative };
}

/** 打开只读连接。 */
function openReadOnly(dbPath) {
  return new DatabaseSync(`file:${dbPath.replace(/\\/g, '/')}?mode=ro`, { readOnly: true });
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** 只保留目录尾部特征，避免报告泄漏用户名。 */
function hintOf(resolved) {
  const parts = resolved.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * 证明一个数据库是 quality fixture。
 *
 * 判定顺序（任一不满足即拒绝，不回退）：
 *   1. 路径在 fixtureDir 白名单内（path.relative 严格判断）
 *   2. 文件名等于 config.database.databaseFilename
 *   3. 路径中不含任何 FORBIDDEN_PATH_SEGMENTS（额外拒绝条件）
 *   4. 文件存在、可只读打开
 *   5. PRAGMA integrity_check == 'ok'
 *   6. settings 表存在
 *   7. settings[fixtureMarkerKey] == fixtureMarkerValue
 *
 * @param {string} dbPath 待证明的数据库路径
 * @param {{fixtureRoot?: string, databaseFilename?: string, markerKey?: string, markerValue?: string}} [options]
 * @returns {{ok: boolean, reason?: string, evidence: object}}
 */
export function assertFixtureDatabase(dbPath, options = {}) {
  let fixtureRoot = options.fixtureRoot;
  let databaseFilename = options.databaseFilename;
  let markerKey = options.markerKey || DEFAULT_MARKER_KEY;
  let markerValue = options.markerValue || DEFAULT_MARKER_VALUE;

  if (!fixtureRoot || !databaseFilename) {
    const config = loadConfig();
    fixtureRoot = fixtureRoot || config.fixtureRoot;
    databaseFilename = databaseFilename || config.database.databaseFilename;
    markerKey = options.markerKey || config.database.fixtureMarkerKey;
    markerValue = options.markerValue || config.database.fixtureMarkerValue;
  }

  const resolved = path.resolve(dbPath);
  const evidence = {
    basename: path.basename(resolved),
    directoryHint: hintOf(resolved),
    fixtureRootHint: hintOf(path.resolve(fixtureRoot)),
    relativeToFixtureRoot: null,
    exists: fs.existsSync(resolved),
    marker: null,
    integrity: null,
    counts: null,
  };

  // ---- 1. 严格白名单（替代 V1 的正则匹配） ----
  const containment = isStrictlyInside(fixtureRoot, resolved);
  evidence.relativeToFixtureRoot = containment.relative;
  if (!containment.inside) {
    return {
      ok: false,
      reason:
        `database is not under the quality fixture directory (strict allowlist). ` +
        `expected a path under "${evidence.fixtureRootHint}", got "${evidence.directoryHint}" ` +
        `(path.relative = "${containment.relative}")`,
      evidence,
    };
  }

  // ---- 2. 文件名 ----
  if (path.basename(resolved).toLowerCase() !== String(databaseFilename).toLowerCase()) {
    return {
      ok: false,
      reason: `unexpected database basename "${evidence.basename}" (expected ${databaseFilename})`,
      evidence,
    };
  }

  // ---- 3. 额外拒绝条件（正式库可能所在的位置） ----
  const segments = resolved.replace(/\\/g, '/').split('/').map(segment => segment.toLowerCase());
  const hit = FORBIDDEN_PATH_SEGMENTS.find(segment => segments.includes(segment));
  if (hit) {
    return {
      ok: false,
      reason: `database path contains forbidden segment "${hit}" (production-looking location)`,
      evidence,
    };
  }

  // ---- 4. 存在性 ----
  if (!evidence.exists) {
    return { ok: false, reason: `fixture database does not exist: ${evidence.basename}`, evidence };
  }

  let db;
  try {
    db = openReadOnly(resolved);
  } catch (error) {
    return { ok: false, reason: `cannot open database read-only: ${error?.message || error}`, evidence };
  }

  try {
    // ---- 5. 完整性 ----
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    evidence.integrity = integrityRow ? Object.values(integrityRow)[0] : null;
    if (evidence.integrity !== 'ok') {
      return { ok: false, reason: `SQLite integrity_check returned "${evidence.integrity}"`, evidence };
    }

    // ---- 6. 已被应用初始化 ----
    if (!tableExists(db, 'settings')) {
      return { ok: false, reason: 'settings table missing — this database was never initialized by CostHub', evidence };
    }

    // ---- 7. fixture marker ----
    const markerRow = db.prepare('SELECT value FROM settings WHERE key=?').get(markerKey);
    evidence.marker = markerRow ? String(markerRow.value) : null;
    if (evidence.marker !== String(markerValue)) {
      return {
        ok: false,
        reason:
          `fixture marker ${markerKey}=${markerValue} absent (found ${JSON.stringify(evidence.marker)}) — ` +
          'refusing to run against a non-fixture database',
        evidence,
      };
    }

    evidence.counts = readCounts(db);
    return { ok: true, evidence };
  } catch (error) {
    return { ok: false, reason: `fixture verification failed: ${error?.message || error}`, evidence };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 读取用于「测试不改变数据」断言的计数。 */
export function readCounts(db) {
  const counts = {};
  for (const table of ['projects', 'project_boms', 'parts', 'settings']) {
    if (!tableExists(db, table)) { counts[table] = null; continue; }
    try {
      counts[table] = Number(db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c);
    } catch {
      counts[table] = null;
    }
  }
  return counts;
}

/** 从文件路径读计数（独立连接，用于前后对比）。 */
export function snapshotCounts(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`database not found: ${path.basename(resolved)}`);
  const db = openReadOnly(resolved);
  try {
    return readCounts(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 完整性检查（E2E 收尾必做）。 */
export function integrityCheck(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`database not found: ${path.basename(resolved)}`);
  const db = openReadOnly(resolved);
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    return row ? String(Object.values(row)[0]) : 'unknown';
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 写入 fixture 标记与测试账号。
 * 这是【fixture 准备阶段】的写操作，只允许作用在白名单目录内的副本上 ——
 * 因此这里先做一次严格白名单判定，**不依赖 marker**（marker 就是本次要写的）。
 */
export function seedFixture(dbPath, { username, passwordHash, passwordChanged = '1', extraSettings = {}, fixtureRoot } = {}) {
  const resolved = path.resolve(dbPath);
  const root = fixtureRoot || loadConfig().fixtureRoot;

  const containment = isStrictlyInside(root, resolved);
  if (!containment.inside) {
    throw new Error(
      `refusing to seed: ${hintOf(resolved)} is not under the quality fixture directory ` +
      `(path.relative = "${containment.relative}")`,
    );
  }

  const db = new DatabaseSync(resolved);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const config = loadConfig();
    upsert.run(config.database.fixtureMarkerKey, config.database.fixtureMarkerValue);
    if (username) upsert.run('auth_username', username);
    if (passwordHash) upsert.run('auth_password_hash', passwordHash);
    if (passwordChanged) upsert.run('auth_password_changed', passwordChanged);
    // fixture 明确不保留明文副本（正式库的明文副本是产品行为，fixture 不需要）
    db.prepare("DELETE FROM settings WHERE key='auth_password_plain'").run();
    for (const [key, value] of Object.entries(extraSettings)) upsert.run(key, String(value));
    return true;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export { FORBIDDEN_PATH_SEGMENTS, hintOf };
