// Quality Harness V2 — 桌面 fixture 清单读取
//
// 从 V1 的 run-e2e.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
// 职责：读取 prepare-fixture.mjs 写出的 desktop-fixture.json，
// 以及为「测试没有改变业务数据」这条断言提供 settings key 快照。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

/** 读取夹具 manifest（由 prepare-fixture.mjs 写出）。 */
export function readFixtureManifest(fixtureDir) {
  const manifestPath = path.join(fixtureDir, 'desktop-fixture.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `fixture manifest missing: ${path.basename(manifestPath)} ` +
      '(run "node tests/quality/desktop/prepare-fixture.mjs")',
    );
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/**
 * 读取 settings 的 key 列表。
 *
 * 传入 previous 时返回 { added, removed }，用于把「应用自身持久化的运行时状态」
 * 与「测试污染」区分开 —— 前者是正常的，后者才是问题。
 */
export function readSettingsKeys(dbPath, previous = null) {
  let keys = [];
  try {
    const db = new DatabaseSync(path.resolve(dbPath));
    try {
      keys = db.prepare('SELECT key FROM settings ORDER BY key').all().map(row => row.key);
    } finally {
      db.close();
    }
  } catch (error) {
    return { error: String(error?.message || error) };
  }

  if (!previous) return keys;
  return {
    added: keys.filter(key => !previous.includes(key)),
    removed: previous.filter(key => !keys.includes(key)),
  };
}
