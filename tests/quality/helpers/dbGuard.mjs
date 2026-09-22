// Quality Harness V1 — 数据库保护（强制项，实施指导 §7 / E2E-008 / REG-DB-001）
//
// 规则：桌面 E2E 只能使用 fixture / copy / 临时数据库。
// 本模块提供「证明」能力，不提供「猜测」能力：
//   证明不出是 fixture → ABORT，绝不写「大概率不是正式库，所以继续」。
//
// 实现使用 Node 内置 node:sqlite（Node >= 23 免 flag），避免为测试基础设施引入新依赖。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** fixture 标记 key（不新增生产 schema，只写一行 settings）。 */
export const FIXTURE_MARKER_KEY = 'quality_fixture';
export const FIXTURE_MARKER_VALUE = '1';

/** 正式运行库可能出现的目录特征（出现即拒绝）。 */
const FORBIDDEN_DIR_MARKERS = [
  /[\\/]src-tauri[\\/]target[\\/]/i, // 开发机上的真实运行库
  /[\\/]\.costhub[\\/]/i,
  /[\\/]AppData[\\/]Roaming[\\/]/i,
  /[\\/]AppData[\\/]Local[\\/]/i,
  /[\\/]Program Files/i,
  /[\\/]Documents[\\/]/i,
];

/** fixture 目录名必须包含该片段，形成第二道人工可核对的特征。 */
const REQUIRED_DIR_MARKER = /quality-fixture|desktop-fixture|quality[\\/]/i;

/** 打开只读连接。 */
function openReadOnly(dbPath) {
  return new DatabaseSync(`file:${dbPath.replace(/\\/g, '/')}?mode=ro`, { readOnly: true });
}

function tableExists(db, name) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 证明一个数据库是 quality fixture。
 *
 * @param {string} dbPath 待证明的数据库绝对路径
 * @returns {{ok: boolean, reason?: string, evidence: object}}
 */
export function assertFixtureDatabase(dbPath) {
  const resolved = path.resolve(dbPath);
  const evidence = {
    basename: path.basename(resolved),
    // 只报告相对特征，不回传完整绝对路径到报告
    directoryHint: hintOf(resolved),
    exists: fs.existsSync(resolved),
    marker: null,
    integrity: null,
    counts: null,
  };

  if (!evidence.exists) {
    return { ok: false, reason: `fixture database does not exist: ${evidence.basename}`, evidence };
  }

  if (path.basename(resolved).toLowerCase() !== 'costhub.db') {
    return { ok: false, reason: `unexpected database basename "${evidence.basename}" (expected costhub.db)`, evidence };
  }

  for (const marker of FORBIDDEN_DIR_MARKERS) {
    if (marker.test(resolved)) {
      return { ok: false, reason: `database path matches a production location pattern ${marker}`, evidence };
    }
  }

  if (!REQUIRED_DIR_MARKER.test(resolved)) {
    return { ok: false, reason: 'database path is not inside a recognized fixture directory', evidence };
  }

  let db;
  try {
    db = openReadOnly(resolved);
  } catch (error) {
    return { ok: false, reason: `cannot open database read-only: ${error?.message || error}`, evidence };
  }

  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    evidence.integrity = integrityRow ? Object.values(integrityRow)[0] : null;
    if (evidence.integrity !== 'ok') {
      return { ok: false, reason: `SQLite integrity_check returned "${evidence.integrity}"`, evidence };
    }

    if (!tableExists(db, 'settings')) {
      return { ok: false, reason: 'settings table missing — this database was never initialized by CostHub', evidence };
    }

    const markerRow = db.prepare('SELECT value FROM settings WHERE key=?').get(FIXTURE_MARKER_KEY);
    evidence.marker = markerRow ? String(markerRow.value) : null;
    if (evidence.marker !== FIXTURE_MARKER_VALUE) {
      return {
        ok: false,
        reason: `fixture marker ${FIXTURE_MARKER_KEY}=${FIXTURE_MARKER_VALUE} absent (found ${JSON.stringify(evidence.marker)}) — refusing to run against a non-fixture database`,
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
 * 这是【fixture 准备阶段】的写操作，只允许作用在 fixture 副本上。
 */
export function seedFixture(dbPath, { username, passwordHash, passwordChanged = '1', extraSettings = {} } = {}) {
  const resolved = path.resolve(dbPath);
  const db = new DatabaseSync(resolved);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    upsert.run(FIXTURE_MARKER_KEY, FIXTURE_MARKER_VALUE);
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

/** 只保留目录尾部特征，避免报告泄漏用户名。 */
function hintOf(resolved) {
  const parts = resolved.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
