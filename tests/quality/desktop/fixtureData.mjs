// Quality Harness V1 — 夹具数据播种（只作用于 fixture 副本）
//
// 目的：让 E2E-004（项目/BOM 只读旅程）有一个**已知、可断言**的数据集。
//
// 设计原则：
//   * 只写隔离夹具库，写之前先跑 assertFixtureDatabase 证明；
//   * 内容全部是合成数据（Synthetic），不含任何真实项目/供应商/成本；
//   * 幂等：重复 prepare 不会叠加行数（每行有稳定 code / 唯一键）；
//   * 从库自身 schema 探测可用列，缺列不写 —— 这样夹具生成与 schema 演进解耦。

import { createRequire } from 'node:module';
import path from 'node:path';

import { assertFixtureDatabase } from '../helpers/dbGuard.mjs';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

/** 夹具项目代号：E2E 断言与页面跳转都用它。 */
export const FIXTURE_PROJECT_CODE = 'QAFIX-0001';
export const FIXTURE_PROJECT_NAME = 'Quality Harness 夹具项目';

/** 夹具 BOM 行（模块 / 器件 / 型号 / 单价 / 数量）。合成数据。 */
export const FIXTURE_BOM_ROWS = [
  { module: '显示模块', category: '面板', name: '夹具面板 27"', model: 'QA-PANEL-270', cost: 500, quantity: 1 },
  { module: '显示模块', category: '背光', name: '夹具背光模组', model: 'QA-BL-270', cost: 60, quantity: 1 },
  { module: '主板模块', category: '主控芯片', name: '夹具 Scaler IC', model: 'QA-SCALER-01', cost: 80, quantity: 1 },
  { module: '主板模块', category: '存储芯片', name: '夹具 DDR 模组', model: 'QA-DDR-01', cost: 40, quantity: 1 },
  { module: '结构模块', category: '外壳件', name: '夹具前框', model: 'QA-BEZEL-01', cost: 45, quantity: 1 },
  { module: '电源模块', category: '内置电源', name: '夹具电源板', model: 'QA-PSU-01', cost: 70, quantity: 1 },
];

/** 读一张表的列名集合。 */
function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  } catch {
    return new Set();
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/**
 * 播种夹具数据。
 * @param {string} dbPath fixture 数据库路径
 * @returns {{ok: boolean, projectId?: number, bomRows?: number, parts?: number, reason?: string}}
 */
export function seedFixtureData(dbPath) {
  const resolved = path.resolve(dbPath);

  // 先证明这是夹具，再动笔 —— 顺序不能反
  const proof = assertFixtureDatabase(resolved);
  if (!proof.ok) {
    return { ok: false, reason: `refusing to seed: ${proof.reason}` };
  }

  const db = new DatabaseSync(resolved);
  try {
    const schemaNotes = [];
    if (!tableExists(db, 'projects') || !tableExists(db, 'project_boms')) {
      return { ok: false, reason: 'projects/project_boms table missing — run prepare-fixture bootstrap first' };
    }

    const projectCols = columnsOf(db, 'projects');
    const partCols = columnsOf(db, 'parts');
    const bomCols = columnsOf(db, 'project_boms');

    // ---- 项目 ----------------------------------------------------------------
    let projectId = db.prepare('SELECT id FROM projects WHERE code=?').get(FIXTURE_PROJECT_CODE)?.id;

    if (projectId == null) {
      const fields = { code: FIXTURE_PROJECT_CODE, name: FIXTURE_PROJECT_NAME };
      const optional = {
        project_type: '在研',
        stage: 'Charter',
        category: '显示器',
        tier: '主流级',
        status: '进行中',
        screen_size: '27"',
        resolution: '2560×1440 (QHD)',
        refresh_rate: '165Hz',
        panel_type: 'IPS',
        platform_fee_rate: 5,
        profit_rate: 15,
        specs: 'Quality Harness synthetic fixture project',
      };
      for (const [key, value] of Object.entries(optional)) {
        if (projectCols.has(key)) fields[key] = value;
      }
      const names = Object.keys(fields);
      const statement = `INSERT INTO projects (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
      const result = db.prepare(statement).run(...names.map(name => fields[name]));
      projectId = Number(result.lastInsertRowid);
    }

    // ---- 器件 + BOM 行 -------------------------------------------------------
    let partsInserted = 0;
    let bomInserted = 0;

    const findPart = db.prepare('SELECT id FROM parts WHERE name=? AND model=?');
    const insertPartParts = [];
    const insertPartValues = [];

    const partFields = ['main_category', 'sub_category', 'category', 'name', 'model', 'cost', 'specs', 'projects', 'remark'];
    const partDefaults = {
      main_category: '硬件类',
      sub_category: '',
      category: '',
      name: '',
      model: '',
      cost: 0,
      specs: '',
      projects: '',
      remark: 'Quality Harness synthetic fixture part',
    };
    for (const field of partFields) {
      if (partCols.has(field)) insertPartParts.push(field);
    }

    // 去重键：优先用 BOM 行自己的快照列（产品读取口径「快照优先」），
    // 若本次 bootstrap 出的 schema 还没有这些 ALTER 列，则退回 part_id 匹配。
    // 这让夹具生成与 schema 演进解耦，而不是硬编码某一版列集合。
    const hasSnapshotCols = bomCols.has('part_name') && bomCols.has('part_model');
    const findBom = hasSnapshotCols
      ? db.prepare('SELECT id FROM project_boms WHERE project_id=? AND part_name=? AND part_model=?')
      : db.prepare('SELECT id FROM project_boms WHERE project_id=? AND part_id=?');
    schemaNotes.push(
      hasSnapshotCols
        ? 'project_boms snapshot columns present (part_name/part_model) — using snapshot-based dedup'
        : 'project_boms snapshot columns absent — fell back to part_id-based dedup and omitted those columns',
    );
    schemaNotes.push(`project_boms columns available: ${[...bomCols].join(', ') || '(none)'}`);

    for (const row of FIXTURE_BOM_ROWS) {
      let partId = findPart.get(row.name, row.model)?.id;

      if (partId == null) {
        const values = {
          ...partDefaults,
          sub_category: row.category,
          category: row.category,
          name: row.name,
          model: row.model,
          cost: row.cost,
        };
        insertPartValues.length = 0;
        for (const field of insertPartParts) insertPartValues.push(values[field]);
        const statement = `INSERT INTO parts (${insertPartParts.join(', ')}) VALUES (${insertPartParts.map(() => '?').join(', ')})`;
        const result = db.prepare(statement).run(...insertPartValues);
        partId = Number(result.lastInsertRowid);
        partsInserted += 1;
      }

      const already = hasSnapshotCols ? findBom.get(projectId, row.name, row.model) : findBom.get(projectId, partId);
      if (already) continue;

      // BOM 行带快照列（part_name/part_model/part_cost/main_category/sub_category），
      // 与产品读取口径一致（快照优先、parts 兜底），因此即使 parts 行缺失页面也能显示。
      const bomFields = {
        project_id: projectId,
        part_id: partId,
        module_name: row.module,
        quantity: row.quantity,
        cost: row.cost,
        part_name: row.name,
        part_model: row.model,
        part_cost: row.cost,
        main_category: '硬件类',
        sub_category: row.category,
        part_specs: `synthetic spec for ${row.model}`,
        price_state: 'known',
        is_module_item: 0,
      };
      const names = Object.keys(bomFields).filter(name => bomCols.has(name));
      const statement = `INSERT INTO project_boms (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
      db.prepare(statement).run(...names.map(name => bomFields[name]));
      bomInserted += 1;
    }

    const counts = {
      projects: db.prepare('SELECT count(*) AS c FROM projects').get().c,
      project_boms: db.prepare('SELECT count(*) AS c FROM project_boms').get().c,
      parts: db.prepare('SELECT count(*) AS c FROM parts').get().c,
    };

    return {
      ok: true,
      projectId: Number(projectId),
      projectCode: FIXTURE_PROJECT_CODE,
      partsInserted,
      bomInserted,
      counts,
      expectedBomRows: FIXTURE_BOM_ROWS.length,
      schemaNotes,
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
