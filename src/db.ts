import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import { PRESET_PROVIDERS as PRESET_PROVIDER_TEMPLATES } from './constants';

let db: Database | null = null;
let dbUrl: string | null = null;
let schemaReady = false;

async function getDbUrl(): Promise<string> {
  if (!dbUrl) { dbUrl = await invoke<string>('get_db_path'); }
  return dbUrl;
}
async function getDb(): Promise<Database> {
  if (!db) { db = await Database.load(await getDbUrl()); }
  if (!schemaReady) {
    await ensureSchema(db);
    schemaReady = true;
  }
  return db;
}

async function ignoreSchemaError(task: Promise<any>) {
  try { await task; } catch { }
}

async function ensureSchema(d: Database) {
  // 首先确保关键表存在（防止迁移未执行）
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS decomposition_tree (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_part_id INTEGER,
        parent_id INTEGER,
        component_name TEXT NOT NULL,
        cost_ratio_estimate REAL DEFAULT NULL,
        source_type TEXT DEFAULT 'user_confirmed',
        node_type TEXT DEFAULT 'structural',
        insight_status TEXT DEFAULT 'pending',
        trend_item_id INTEGER DEFAULT NULL,
        remark TEXT DEFAULT '',
        ai_insights TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('✓ decomposition_tree 表已确保存在');
  } catch (e) {
    console.error('创建 decomposition_tree 表失败:', e);
  }

  // 确保 decomposition_history 表存在
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS decomposition_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_part_id INTEGER NOT NULL,
        timestamp TEXT DEFAULT (datetime('now','localtime')),
        summary TEXT DEFAULT ''
      )
    `);
    console.log('✓ decomposition_history 表已确保存在');
  } catch (e) {
    console.error('创建 decomposition_history 表失败:', e);
  }

  // 确保 trend_part_mapping 表存在
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS trend_part_mapping (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        part_id INTEGER NOT NULL,
        trend_item_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('✓ trend_part_mapping 表已确保存在');
  } catch (e) {
    console.error('创建 trend_part_mapping 表失败:', e);
  }

  // 确保 material_categories 表存在
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS material_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_name TEXT NOT NULL UNIQUE
      )
    `);
    console.log('✓ material_categories 表已确保存在');
  } catch (e) {
    console.error('创建 material_categories 表失败:', e);
  }

  // 确保 ai_request_logs 表存在（用于审计）
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS ai_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_type TEXT NOT NULL,
        material_name TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        user_prompt TEXT DEFAULT '',
        response_summary TEXT DEFAULT '',
        success INTEGER DEFAULT 1,
        error_message TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('✓ ai_request_logs 表已确保存在');
  } catch (e) {
    console.error('创建 ai_request_logs 表失败:', e);
  }

  // 为 trend_items 表添加缺失的列
  await ignoreSchemaError(d.execute('ALTER TABLE trend_items ADD COLUMN magnitude_min REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute('ALTER TABLE trend_items ADD COLUMN magnitude_max REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_items ADD COLUMN magnitude_reference TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_items ADD COLUMN source_type TEXT DEFAULT 'decomposition'"));

  // 为 trend_snapshots 表添加缺失的列
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence_level TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_min REAL DEFAULT NULL"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_max REAL DEFAULT NULL"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_reference TEXT DEFAULT ''"));

  // 为 trend_insight_dimensions 表添加缺失的列
  await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN data_points TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN source_title TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN source_url TEXT DEFAULT ''"));

  // 为 trend_key_events 表添加缺失的列（确保所有列都存在）
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN event_date TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN event_description TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN impact_direction TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN source_title TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN source_url TEXT DEFAULT ''"));

  // 原有的列补齐逻辑
  await ignoreSchemaError(d.execute('ALTER TABLE parts ADD COLUMN trend_enabled INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE parts ADD COLUMN trend_query_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE parts ADD COLUMN trend_category_type TEXT DEFAULT '直接查询'"));

  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN price REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN share_ratio REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN is_active INTEGER DEFAULT 1'));
  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN unit_price REAL DEFAULT 0'));

  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN source_type TEXT DEFAULT 'direct_query'"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence_level TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE modules ADD COLUMN module_category TEXT DEFAULT '未分类'"));

  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN component_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN correction_reason TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN user_corrected_summary TEXT DEFAULT ''"));

  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN component_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE decomposition_tree ADD COLUMN cost_ratio_estimate REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN source_type TEXT DEFAULT 'user_confirmed'"));
  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN insight_status TEXT DEFAULT 'pending'"));
  await ignoreSchemaError(d.execute('ALTER TABLE decomposition_tree ADD COLUMN trend_item_id INTEGER DEFAULT NULL'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN is_deleted INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE competitors ADD COLUMN sort_order INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_reference INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN reference_remark TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_deleted INTEGER DEFAULT 0'));

  // ====== 性能优化：添加关键索引 ======
  // 这些索引可以显著提升查询性能，特别是数据量大时
  console.log('正在创建数据库索引...');

  // trend_items 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_items_part_id ON trend_items(part_id)'));

  // trend_snapshots 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_snapshots_trend_item_id ON trend_snapshots(trend_item_id)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_snapshots_query_time ON trend_snapshots(query_time DESC)'));

  // trend_sources 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_sources_trend_item_id ON trend_sources(trend_item_id)'));

  // trend_conversations 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_conversations_trend_item_id ON trend_conversations(trend_item_id)'));

  // trend_insight_dimensions 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_insight_dimensions_snapshot_id ON trend_insight_dimensions(trend_snapshot_id)'));

  // trend_key_events 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_key_events_snapshot_id ON trend_key_events(trend_snapshot_id)'));

  // decomposition_tree 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_decomposition_tree_root_part_id ON decomposition_tree(root_part_id)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_decomposition_tree_parent_id ON decomposition_tree(parent_id)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_decomposition_tree_trend_item_id ON decomposition_tree(trend_item_id)'));

  // part_suppliers 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_part_suppliers_part_id ON part_suppliers(part_id)'));

  // parts 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_parts_main_category ON parts(main_category)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_parts_trend_enabled ON parts(trend_enabled)'));

  console.log('✓ 数据库索引创建完成');

  // Migrate project_cost_snapshots table - rebuild if it has old schema with snapshot_name
  try {
    await d.execute(
      `INSERT INTO project_cost_snapshots (project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count) VALUES (?,?,?,?,?,?,?,?,?)`,
      [-999, 'test', 'test', 0, 0, 0, 0, 0, 0]
    );
    await d.execute('DELETE FROM project_cost_snapshots WHERE project_id = -999');
  } catch (e) {
    // If insert fails, rebuild the table
    console.log('Rebuilding project_cost_snapshots table...');
    await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots RENAME TO project_cost_snapshots_old'));
    await d.execute(`
      CREATE TABLE IF NOT EXISTS project_cost_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        snapshot_type TEXT DEFAULT 'bom_change',
        change_reason TEXT DEFAULT '',
        bom_cost REAL DEFAULT 0,
        total_cost REAL DEFAULT 0,
        platform_fee_rate REAL DEFAULT 0,
        profit_rate REAL DEFAULT 0,
        module_count INTEGER DEFAULT 0,
        item_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    await ignoreSchemaError(d.execute(`
      INSERT INTO project_cost_snapshots (id, project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count, created_at)
      SELECT id, project_id,
        COALESCE(snapshot_type, 'bom_change'),
        COALESCE(change_reason, ''),
        COALESCE(bom_cost, 0),
        COALESCE(total_cost, 0),
        COALESCE(platform_fee_rate, 0),
        COALESCE(profit_rate, 0),
        COALESCE(module_count, 0),
        COALESCE(item_count, 0),
        created_at
      FROM project_cost_snapshots_old
    `));
    await ignoreSchemaError(d.execute('DROP TABLE project_cost_snapshots_old'));
  }

  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN snapshot_type TEXT DEFAULT 'bom_change'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN change_reason TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN bom_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN total_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN platform_fee_rate REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN profit_rate REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN module_count INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN item_count INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN change_details TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute(`
    CREATE TABLE IF NOT EXISTS project_cost_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      snapshot_type TEXT DEFAULT 'bom_change',
      change_reason TEXT DEFAULT '',
      bom_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      platform_fee_rate REAL DEFAULT 0,
      profit_rate REAL DEFAULT 0,
      module_count INTEGER DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `));
}

// ==================== Parts ====================
export async function getParts(search = '', category = '', mainCategory = '') {
  const d = await getDb();
  let q = 'SELECT * FROM parts WHERE 1=1'; const p: any[] = [];
  if (search) { q += ' AND (name LIKE ? OR model LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  if (category) { q += ' AND category = ?'; p.push(category); }
  if (mainCategory) { q += ' AND main_category = ?'; p.push(mainCategory); }
  q += ' ORDER BY main_category, sub_category, name';
  return d.select<any[]>(q, p);
}
export async function getPart(id: number) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM parts WHERE id = ?', [id]);
  return r[0] || null;
}
export async function savePart(data: any, autoSnapshot = true) {
  const d = await getDb();
  if (data.id) {
    const old = await d.select<{ cost: number }[]>('SELECT cost FROM parts WHERE id = ?', [data.id]);
    if (old[0] && Math.abs(old[0].cost - (data.cost || 0)) > 0.0001) {
      await d.execute('INSERT INTO part_price_history (part_id, old_cost, new_cost) VALUES (?, ?, ?)', [data.id, old[0].cost, data.cost || 0]);
    }
    const affectedProjects = autoSnapshot
      ? await d.select<{ project_id: number }[]>('SELECT DISTINCT project_id FROM project_boms WHERE part_id = ? AND COALESCE(is_deleted, 0) = 0', [data.id])
      : [];
    await d.execute(`UPDATE parts SET main_category=?, sub_category=?, category=?, name=?, model=?, cost=?, specs=?, projects=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '', data.id]);
    if (autoSnapshot && affectedProjects.length > 0) {
      for (const p of affectedProjects) {
        await recordProjectCostSnapshot(p.project_id, 'part_price_changed', `器件「${data.name || ''}」价格/信息变更`);
      }
    }
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO parts (main_category, sub_category, category, name, model, cost, specs, projects, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '']);
    return r.lastInsertId;
  }
}
export async function deletePart(id: number) { await (await getDb()).execute('DELETE FROM parts WHERE id = ?', [id]); }
export async function getPriceHistory(partId: number) { return (await getDb()).select<any[]>('SELECT * FROM part_price_history WHERE part_id = ? ORDER BY changed_at DESC', [partId]); }
export async function getCategories() { return (await (await getDb()).select<{ category: string }[]>('SELECT DISTINCT category FROM parts ORDER BY category')).map(x => x.category); }
export async function getMainCategories(): Promise<string[]> {
  const d = await getDb();
  const r = await d.select<{ mc: string }[]>('SELECT DISTINCT main_category as mc FROM parts UNION SELECT DISTINCT domain as mc FROM project_targets ORDER BY mc');
  const defaults = ['硬件类', '结构类', '电源类', '线材类', '包材类', '加工费类', '软件类', '其他'];
  return [...new Set([...defaults, ...r.map(x => x.mc)])];
}
export async function getSubCategories(mainCat: string): Promise<string[]> {
  const r = await (await getDb()).select<{ sc: string }[]>('SELECT DISTINCT sub_category as sc FROM parts WHERE main_category = ? ORDER BY sc', [mainCat]);
  return r.map(x => x.sc).filter(Boolean);
}

// ==================== Projects ====================
export async function getProjects(status = '', projectType = '') {
  const d = await getDb(); let q = 'SELECT * FROM projects WHERE 1=1'; const p: any[] = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (projectType) { q += ' AND project_type = ?'; p.push(projectType); }
  q += ' AND COALESCE(is_deleted, 0) = 0 ORDER BY COALESCE(sort_order, 0), created_at DESC';
  return d.select<any[]>(q, p);
}
export async function getProject(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM projects WHERE id = ?', [id]); return r[0] || null; }
export async function saveProject(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(`UPDATE projects SET code=?,name=?,project_type=?,tier=?,status=?,screen_size=?,resolution=?,refresh_rate=?,panel_type=?,platform_fee_rate=?,profit_rate=?,image=? WHERE id=?`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '', data.id]);
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '']);
    return r.lastInsertId;
  }
}
export async function deleteProject(id: number) { await (await getDb()).execute('UPDATE projects SET is_deleted = 1 WHERE id = ?', [id]); }
export async function copyProject(id: number, newCode: string, newName: string) {
  const d = await getDb(); const src = await d.select<any[]>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!src[0]) return 0;
  const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [newCode, newName, '在研', src[0].tier, '进行中', src[0].screen_size, src[0].resolution, src[0].refresh_rate, src[0].panel_type, src[0].platform_fee_rate, src[0].profit_rate]);
  const boms = await d.select<any[]>('SELECT * FROM project_boms WHERE project_id = ?', [id]);
  for (const b of boms) { await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark) VALUES (?,?,?,?,?)', [r.lastInsertId, b.part_id, b.module_name, b.quantity, b.remark]); }
  const mods = await d.select<any[]>('SELECT * FROM modules WHERE project_id = ?', [id]);
  for (const m of mods) {
    const mr = await d.execute('INSERT INTO modules (project_id, name, module_category, description) VALUES (?,?,?,?)', [r.lastInsertId, m.name, m.module_category || '未分类', m.description]);
    const items = await d.select<any[]>('SELECT * FROM module_items WHERE module_id = ?', [m.id]);
    for (const mi of items) { await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [mr.lastInsertId, mi.part_id, mi.part_name, mi.part_model, mi.main_category, mi.sub_category, mi.cost, mi.quantity, mi.remark]); }
  }
  return r.lastInsertId;
}

// ==================== Project BOMs ====================
export async function getProjectBOMs(projectId: number) {
  return (await getDb()).select<any[]>(`SELECT pb.*, p.name as part_name, p.model as part_model, p.cost as part_cost, p.main_category, p.sub_category, p.category FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0 ORDER BY pb.module_name, p.main_category, p.sub_category, p.name`, [projectId]);
}
export async function recordProjectCostSnapshot(projectId: number, snapshotType = 'bom_change', changeReason = '') {
  const d = await getDb();
  const project = await d.select<any[]>('SELECT * FROM projects WHERE id = ?', [projectId]).then(rows => rows[0]);
  if (!project) return 0;

  // Get current BOM data with part details
  const rows = await d.select<any[]>(
    `SELECT pb.id, pb.module_name, pb.quantity, p.name as part_name, p.model as part_model, p.cost
     FROM project_boms pb
     JOIN parts p ON pb.part_id = p.id
     WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0`,
    [projectId]
  );

  const bomCost = rows.reduce((sum, row) => sum + (Number(row.cost) || 0) * (Number(row.quantity) || 0), 0);
  const totalCost = bomCost * (1 + ((Number(project.platform_fee_rate) || 0) + (Number(project.profit_rate) || 0)) / 100);
  const modules = new Set(rows.map(row => row.module_name || '未归类'));

  // Get previous snapshot to compare
  const prevSnapshots = await d.select<any[]>(
    'SELECT * FROM project_cost_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [projectId]
  );
  const prevSnap = prevSnapshots[0];

  // Build change details
  let changeDetails = '';
  if (prevSnap && snapshotType === 'part_changed') {
    // For part changes, extract which part changed from changeReason
    const match = changeReason.match(/调整BOM项：(.+)/);
    if (match) {
      const partName = match[1];
      const currentPart = rows.find(r => r.part_name === partName);
      if (currentPart) {
        changeDetails = `${partName} (${currentPart.part_model || ''}): 成本变化`;
      }
    }
  }

  if (changeDetails === '' && prevSnap) {
    const bomDiff = bomCost - Number(prevSnap.bom_cost || 0);
    if (Math.abs(bomDiff) > 0.01) {
      changeDetails = `BOM总成本: ¥${Number(prevSnap.bom_cost || 0).toFixed(2)} → ¥${bomCost.toFixed(2)} (${bomDiff > 0 ? '+' : ''}${bomDiff.toFixed(2)})`;
    }
  }

  const result = await d.execute(
    `INSERT INTO project_cost_snapshots
      (project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count, change_details)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      projectId,
      snapshotType,
      changeReason,
      Math.round(bomCost * 10000) / 10000,
      Math.round(totalCost * 10000) / 10000,
      Number(project.platform_fee_rate) || 0,
      Number(project.profit_rate) || 0,
      modules.size,
      rows.length,
      changeDetails,
    ]
  );
  return result.lastInsertId;
}
export async function getProjectCostSnapshots(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM project_cost_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC', [projectId]);
}
export async function getSnapshotBOMDetail(projectId: number, snapshotTime: string) {
  // Get BOM details at the time of snapshot (or closest before)
  const d = await getDb();
  const rows = await d.select<any[]>(
    `SELECT pb.module_name, pb.quantity, pb.remark,
            p.name as part_name, p.model as part_model, p.main_category, p.sub_category, p.cost
     FROM project_boms pb
     JOIN parts p ON pb.part_id = p.id
     WHERE pb.project_id = ?
       AND COALESCE(pb.is_deleted, 0) = 0
       AND pb.created_at <= ?
     ORDER BY pb.module_name, p.main_category, p.name`,
    [projectId, snapshotTime]
  );
  return rows;
}
export async function deleteProjectCostSnapshot(snapshotId: number) {
  await (await getDb()).execute('DELETE FROM project_cost_snapshots WHERE id = ?', [snapshotId]);
}
export async function addBOMItem(projectId: number, partId: number, quantity = 1, moduleName = '', remark = '', refProjectId = 0, autoSnapshot = true) {
  await (await getDb()).execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id) VALUES (?,?,?,?,?,?)', [projectId, partId, moduleName, quantity, remark, refProjectId]);
  if (autoSnapshot) await recordProjectCostSnapshot(projectId, 'part_added', `新增器件到${moduleName || '未归类'}`);
}
export async function updateBOMItem(id: number, quantity: number, moduleName: string, remark: string, autoSnapshot = true) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT project_id FROM project_boms WHERE id = ?', [id]);
  await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=? WHERE id=?', [quantity, moduleName, remark, id]);
  if (autoSnapshot && rows[0]?.project_id) await recordProjectCostSnapshot(rows[0].project_id, 'part_changed', `调整BOM项：${moduleName || '未归类'}`);
}
export async function updateBOMRefProject(moduleName: string, projectId: number, refProjectId: number) {
  await (await getDb()).execute('UPDATE project_boms SET ref_project_id=? WHERE project_id=? AND module_name=?', [refProjectId, projectId, moduleName]);
}
export async function deleteBOMItem(id: number, autoSnapshot = true) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT project_id, module_name FROM project_boms WHERE id = ?', [id]);
  await d.execute('UPDATE project_boms SET is_deleted = 1 WHERE id = ?', [id]);
  if (autoSnapshot && rows[0]?.project_id) await recordProjectCostSnapshot(rows[0].project_id, 'part_deleted', `移除器件：${rows[0].module_name || '未归类'}`);
}

// ==================== Modules ====================
export async function getModules(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM modules WHERE project_id = ? ORDER BY module_category, name', [projectId]); }
export async function getModuleItems(moduleId: number) { return (await getDb()).select<any[]>('SELECT * FROM module_items WHERE module_id = ? ORDER BY main_category, sub_category, part_name', [moduleId]); }
export async function saveModule(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE modules SET name=?, module_category=?, description=? WHERE id=?', [data.name, data.module_category || '未分类', data.description || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO modules (project_id, name, module_category, description) VALUES (?,?,?,?)', [data.project_id, data.name, data.module_category || '未分类', data.description || '']); return r.lastInsertId; }
}
export async function getModuleCategories() {
  return (await getDb()).select<{ module_category: string }[]>(
    "SELECT DISTINCT COALESCE(NULLIF(module_category, ''), '未分类') AS module_category FROM modules ORDER BY module_category"
  ).then(rows => rows.map(r => r.module_category));
}
export async function deleteModule(id: number) { await (await getDb()).execute('DELETE FROM modules WHERE id = ?', [id]); }
export async function updateModuleCategoryByName(name: string, category: string) {
  await (await getDb()).execute('UPDATE modules SET module_category = ? WHERE name = ?', [category || '未分类', name]);
}
export async function saveModuleItem(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE module_items SET part_id=?, part_name=?, part_model=?, main_category=?, sub_category=?, cost=?, quantity=?, remark=? WHERE id=?', [data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost || 0, data.quantity || 1, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [data.module_id, data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost || 0, data.quantity || 1, data.remark || '']); return r.lastInsertId; }
}
export async function deleteModuleItem(id: number) { await (await getDb()).execute('DELETE FROM module_items WHERE id = ?', [id]); }
export async function getModuleCost(moduleId: number) {
  const items = await getModuleItems(moduleId);
  return items.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0);
}
export async function getProjectModuleSummary(projectId: number) {
  const d = await getDb();
  const boms = await d.select<any[]>(`SELECT pb.module_name, pb.quantity, p.cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?`, [projectId]);
  const map: Record<string, number> = {};
  boms.forEach(b => {
    const m = b.module_name || '未归类';
    map[m] = (map[m] || 0) + (b.cost || 0) * (b.quantity || 1);
  });
  return Object.entries(map).map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }));
}

// ==================== Competitors ====================
export async function getCompetitors() { return (await getDb()).select<any[]>('SELECT * FROM competitors ORDER BY COALESCE(sort_order, 0), created_at DESC'); }
export async function getCompetitor(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM competitors WHERE id = ?', [id]); return r[0] || null; }
export async function saveCompetitor(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitors SET brand=?,model=?,tier=?,market_price=?,bom_cost=?,platform_fee_rate=?,remark=? WHERE id=?', [data.brand, data.model, data.tier, data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitors (brand,model,tier,market_price,bom_cost,platform_fee_rate,remark) VALUES (?,?,?,?,?,?,?)', [data.brand, data.model, data.tier, data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '']); return r.lastInsertId; }
}
export async function deleteCompetitor(id: number) { await (await getDb()).execute('DELETE FROM competitors WHERE id = ?', [id]); }
export async function getCompetitorBOMs(competitorId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM competitor_boms WHERE competitor_id = ? ORDER BY module_name, part_name', [competitorId]);
}
export async function addCompetitorBOMItem(competitorId: number, partName: string, partModel = '', estimatedCost = 0, quantity = 1, moduleName = '', ourPartName = '', ourPartModel = '', ourCost = 0, ourQuantity = 0) {
  await (await getDb()).execute('INSERT INTO competitor_boms (competitor_id, part_name, part_model, estimated_cost, quantity, module_name, our_part_name, our_part_model, our_cost, our_quantity) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [competitorId, partName, partModel, estimatedCost, quantity, moduleName, ourPartName, ourPartModel, ourCost, ourQuantity]);
}
export async function updateCompetitorBOMItem(id: number, partName: string, partModel: string, estimatedCost: number, quantity: number, moduleName: string) {
  await (await getDb()).execute('UPDATE competitor_boms SET part_name=?, part_model=?, estimated_cost=?, quantity=?, module_name=? WHERE id=?',
    [partName, partModel, estimatedCost, quantity, moduleName, id]);
}
export async function deleteCompetitorBOMItem(id: number) { await (await getDb()).execute('DELETE FROM competitor_boms WHERE id = ?', [id]); }
export async function getCompetitorParts() { return (await getDb()).select<any[]>('SELECT * FROM competitor_parts ORDER BY main_category, category, name'); }
export async function saveCompetitorPart(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitor_parts SET main_category=?,sub_category=?,category=?,name=?,model=?,cost=?,specs=?,remark=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [data.main_category || '硬件类', data.sub_category || '', data.category, data.name, data.model, data.cost || 0, data.specs || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitor_parts (main_category,sub_category,category,name,model,cost,specs,remark) VALUES (?,?,?,?,?,?,?,?)', [data.main_category || '硬件类', data.sub_category || '', data.category, data.name, data.model, data.cost || 0, data.specs || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteCompetitorPart(id: number) { await (await getDb()).execute('DELETE FROM competitor_parts WHERE id = ?', [id]); }

// ==================== Product Features & Scores (Radar) ====================
export async function getFeatures() { return (await getDb()).select<any[]>('SELECT * FROM product_features ORDER BY id'); }
export async function saveFeature(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE product_features SET name=?, weight=? WHERE id=?', [data.name, data.weight || 1, data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO product_features (name, weight) VALUES (?,?)', [data.name, data.weight || 1]); return r.lastInsertId; }
}
export async function deleteFeature(id: number) { await (await getDb()).execute('DELETE FROM product_features WHERE id = ?', [id]); }
export async function getScores(refType: string, refId: number) {
  const d = await getDb();
  const scores = await d.select<any[]>('SELECT * FROM product_scores WHERE ref_type = ? AND ref_id = ?', [refType, refId]);
  const map: Record<number, number> = {};
  scores.forEach(s => { map[s.feature_id] = s.score; });
  return map;
}
export async function saveScore(refType: string, refId: number, featureId: number, score: number) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT id FROM product_scores WHERE ref_type = ? AND ref_id = ? AND feature_id = ?', [refType, refId, featureId]);
  if (existing.length > 0) {
    await d.execute('UPDATE product_scores SET score = ? WHERE id = ?', [score, existing[0].id]);
  } else {
    await d.execute('INSERT INTO product_scores (ref_type, ref_id, feature_id, score) VALUES (?,?,?,?)', [refType, refId, featureId, score]);
  }
}
export async function getAllScoresForRefs(refType: string, refIds: number[]) {
  const d = await getDb();
  if (refIds.length === 0) return {} as Record<number, Record<number, number>>;
  const scores = await d.select<any[]>(`SELECT * FROM product_scores WHERE ref_type = ? AND ref_id IN (${refIds.map(() => '?').join(',')})`, [refType, ...refIds]);
  const result: Record<number, Record<number, number>> = {};
  scores.forEach(s => {
    if (!result[s.ref_id]) result[s.ref_id] = {};
    result[s.ref_id][s.feature_id] = s.score;
  });
  return result;
}

// ==================== Cost Reviews & Measures ====================
export async function getCostReviews(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_cost_reviews WHERE project_id = ? ORDER BY reviewed_at DESC', [projectId]); }
export async function saveCostReview(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_cost_reviews SET stage=?, reviewed_cost=?, reviewer=?, remark=? WHERE id=?', [data.stage, data.reviewed_cost, data.reviewer || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_cost_reviews (project_id, stage, reviewed_cost, reviewer, remark) VALUES (?,?,?,?,?)', [data.project_id, data.stage, data.reviewed_cost, data.reviewer || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteCostReview(id: number) { await (await getDb()).execute('DELETE FROM project_cost_reviews WHERE id = ?', [id]); }
export async function getMeasures(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_measures WHERE project_id = ? ORDER BY created_at DESC', [projectId]); }
export async function saveMeasure(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_measures SET main_category=?,measure=?,status=?,due_date=?,owner=?,remark=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [data.main_category, data.measure, data.status, data.due_date || '', data.owner || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_measures (project_id, main_category, measure, status, due_date, owner, remark) VALUES (?,?,?,?,?,?,?)', [data.project_id, data.main_category, data.measure, data.status, data.due_date || '', data.owner || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteMeasure(id: number) { await (await getDb()).execute('DELETE FROM project_measures WHERE id = ?', [id]); }

// ==================== Project Targets ====================
export async function getTargets(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_targets WHERE project_id = ? ORDER BY domain', [projectId]); }
export async function saveTarget(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_targets SET domain=?, target_cost=?, remark=? WHERE id=?', [data.domain, data.target_cost || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_targets (project_id, domain, target_cost, remark) VALUES (?,?,?,?)', [data.project_id, data.domain, data.target_cost || 0, data.remark || '']); return r.lastInsertId; }
}
export async function deleteTarget(id: number) { await (await getDb()).execute('DELETE FROM project_targets WHERE id = ?', [id]); }

// ==================== Dashboard ====================
export async function getDashboardStats() {
  const d = await getDb();
  const totalParts = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM parts'))[0].c;
  const totalProjects = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM projects'))[0].c;
  const activeProjects = (await d.select<{ c: number }[]>("SELECT COUNT(*) as c FROM projects WHERE status='进行中'"))[0].c;
  const totalCompetitors = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM competitors'))[0].c;
  const projects = await d.select<{ id: number }[]>('SELECT id FROM projects');
  let totalCost = 0;
  for (const p of projects) {
    const boms = await d.select<{ quantity: number; cost: number }[]>('SELECT pb.quantity, p.cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?', [p.id]);
    totalCost += boms.reduce((s, b) => s + b.quantity * b.cost, 0);
  }
  const avgBomCost = projects.length > 0 ? Math.round(totalCost / projects.length * 100) / 100 : 0;
  const catDist = await d.select<{ main_category: string; c: number }[]>('SELECT main_category, COUNT(*) as c FROM parts GROUP BY main_category ORDER BY c DESC');
  const recentParts = await d.select<any[]>('SELECT * FROM parts ORDER BY updated_at DESC LIMIT 5');
  return { total_parts: totalParts, total_projects: totalProjects, active_projects: activeProjects, total_competitors: totalCompetitors, avg_bom_cost: avgBomCost, category_distribution: catDist.map(r => ({ category: r.main_category, count: r.c })), recent_parts: recentParts };
}

// ==================== Trend Tracking ====================
export { getDb };

export async function getTrendItem(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_items WHERE id = ?', [id]).then(r => r[0] || null);
}

export async function getTrendItemByCategory(category: string, categoryType: string) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_items WHERE query_category = ? AND category_type = ?', [category, categoryType]).then(r => r[0] || null);
}

export async function getTrendItemsWithDetails() {
  const items = await (await getDb()).select<any[]>('SELECT * FROM trend_items ORDER BY query_category');
  const result = [];
  for (const item of items) {
    const mappedParts = await (await getDb()).select<any[]>('SELECT p.* FROM parts p JOIN trend_part_mapping tpm ON p.id = tpm.part_id WHERE tpm.trend_item_id = ?', [item.id]);
    result.push({ ...item, mapped_parts: mappedParts });
  }
  return result;
}

export async function saveTrendItem(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      'UPDATE trend_items SET query_category=?, category_type=?, trend_direction=?, confidence_level=?, summary=?, suggested_action=?, raw_search_results=?, last_updated_at=?, magnitude_min=?, magnitude_max=?, magnitude_reference=? WHERE id=?',
      [data.query_category, data.category_type, data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO trend_items (query_category, category_type, trend_direction, confidence_level, summary, suggested_action, raw_search_results, last_updated_at, magnitude_min, magnitude_max, magnitude_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [data.query_category, data.category_type || '直接查询', data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference]
    );
    return r.lastInsertId;
  }
}

export async function deleteTrendItem(id: number) {
  await (await getDb()).execute('DELETE FROM trend_items WHERE id = ?', [id]);
}

export async function addTrendMapping(trendItemId: number, partId: number) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM trend_part_mapping WHERE trend_item_id = ? AND part_id = ?', [trendItemId, partId]);
  if (existing.length === 0) {
    await d.execute('INSERT INTO trend_part_mapping (trend_item_id, part_id) VALUES (?,?)', [trendItemId, partId]);
  }
}

export async function getTrendSources(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_sources WHERE trend_item_id = ? ORDER BY id', [trendItemId]);
}

export async function saveTrendSource(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_sources (trend_item_id, source_title, source_url, excerpt) VALUES (?,?,?,?)',
    [data.trend_item_id, data.source_title, data.source_url, data.excerpt]
  );
  return r.lastInsertId;
}

export async function clearTrendSources(trendItemId: number) {
  await (await getDb()).execute('DELETE FROM trend_sources WHERE trend_item_id = ?', [trendItemId]);
}

export async function getTrendConversations(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_conversations WHERE trend_item_id = ? ORDER BY created_at', [trendItemId]);
}

export async function saveTrendConversation(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_conversations (trend_item_id, question, answer, created_at) VALUES (?,?,?,datetime(\'now\',\'localtime\'))',
    [data.trend_item_id, data.question, data.answer]
  );
  return r.lastInsertId;
}

export async function getTrendSnapshots(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY query_time DESC', [trendItemId]);
}

export async function getLatestTrendSnapshot(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY query_time DESC LIMIT 1', [trendItemId]).then(r => r[0] || null);
}

export async function saveTrendSnapshot(data: any) {
  const d = await getDb();
  const confidenceLevel = data.confidence_level ?? data.confidence ?? '';
  const r = await d.execute(
    'INSERT INTO trend_snapshots (trend_item_id, query_time, source_type, direction, confidence, confidence_level, summary, suggested_action, skill_used, magnitude_min, magnitude_max, magnitude_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [data.trend_item_id, data.query_time ?? new Date().toISOString(), data.source_type || 'direct_query', data.direction, confidenceLevel, confidenceLevel, data.summary, data.suggested_action, data.skill_used, data.magnitude_min, data.magnitude_max, data.magnitude_reference]
  );
  return r.lastInsertId;
}

export async function getTrendInsightDimensions(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_insight_dimensions WHERE trend_snapshot_id = ? ORDER BY dimension_order', [snapshotId]);
}

export async function saveTrendInsightDimensions(snapshotId: number, dimensions: any[]) {
  const d = await getDb();
  await d.execute('DELETE FROM trend_insight_dimensions WHERE trend_snapshot_id = ?', [snapshotId]);
  for (const dim of dimensions) {
    await d.execute(
      'INSERT INTO trend_insight_dimensions (trend_snapshot_id, dimension_type, dimension_order, content, evidence_strength, data_points, source_title, source_url) VALUES (?,?,?,?,?,?,?,?)',
      [snapshotId, dim.dimension_type, dim.dimension_order, dim.content || dim.observation, dim.evidence_strength, dim.data_points, dim.source_title, dim.source_url]
    );
  }
}

export async function getTrendKeyEvents(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_key_events WHERE trend_snapshot_id = ? ORDER BY event_date DESC', [snapshotId]);
}

export async function saveTrendKeyEvent(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_key_events (trend_snapshot_id, event_date, event_description, impact_direction, source_title, source_url) VALUES (?,?,?,?,?,?)',
    [data.trend_snapshot_id, data.event_date || data.event_time, data.event_description, data.impact_direction || data.impact_level, data.source_title, data.source_url]
  );
  return r.lastInsertId;
}

export async function getMaterialCategories() {
  return (await getDb()).select<any[]>('SELECT * FROM material_categories ORDER BY category_name');
}

export async function addMaterialCategory(categoryName: string) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM material_categories WHERE category_name = ?', [categoryName]);
  if (existing.length === 0) {
    await d.execute('INSERT INTO material_categories (category_name) VALUES (?)', [categoryName]);
  }
}

export async function removeMaterialCategory(categoryName: string) {
  await (await getDb()).execute('DELETE FROM material_categories WHERE category_name = ?', [categoryName]);
}

// ==================== API Providers (compat exports used by Settings) ====================
export const PRESET_PROVIDERS = PRESET_PROVIDER_TEMPLATES;

export async function ensurePresetProviders() {
  const d = await getDb();
  try {
    await d.execute(`
      DELETE FROM api_providers
      WHERE is_preset = 1
        AND IFNULL(api_key, '') = ''
        AND EXISTS (
          SELECT 1 FROM api_providers q
          WHERE q.provider_type = api_providers.provider_type
            AND q.provider_name = api_providers.provider_name
            AND q.id <> api_providers.id
            AND (IFNULL(q.api_key, '') <> '' OR q.id < api_providers.id)
        )
    `);
  } catch {}
  let priority = 20;
  for (const preset of PRESET_PROVIDER_TEMPLATES) {
    await d.execute(
      `INSERT INTO api_providers
        (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
       SELECT ?,?,?,?,?,0,?,1,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM api_providers
         WHERE provider_type = ? AND provider_name = ?
       )`,
      [
        preset.provider_type, preset.provider_name, '', preset.base_url || '', (preset as any).model_name || '', priority++, preset.monthly_quota_note || '', preset.registration_url || '',
        preset.provider_type, preset.provider_name,
      ]
    );
  }
}

export async function getApiProviders() {
  return getAllApiProviders();
}

export async function saveApiProvider(data: any) {
  const normalized = {
    ...data,
    is_active: data.is_active ?? data.enabled ?? 0,
    is_preset: data.is_preset ?? 0,
    base_url: data.base_url || '',
    model_name: data.model_name || '',
    monthly_quota_note: data.monthly_quota_note || '',
    registration_url: data.registration_url || '',
  };
  if (data.id) {
    return updateApiProvider(normalized);
  }
  return addApiProvider(normalized);
}

export async function deleteApiProvider(id: number) {
  await (await getDb()).execute('DELETE FROM api_providers WHERE id = ?', [id]);
}

export async function setActiveProvider(providerType: string, providerId: number) {
  const d = await getDb();
  await d.execute('UPDATE api_providers SET is_active = 0 WHERE provider_type = ?', [providerType]);
  await d.execute('UPDATE api_providers SET is_active = 1 WHERE id = ?', [providerId]);
}

export async function updateProviderPriorities(providers: any[]) {
  const d = await getDb();
  for (let index = 0; index < providers.length; index++) {
    const item = providers[index];
    const id = typeof item === 'number' ? item : item.id;
    const priority = typeof item === 'number' ? index + 1 : (item.priority ?? index + 1);
    if (id != null) await d.execute('UPDATE api_providers SET priority = ? WHERE id = ?', [priority, id]);
  }
}

export async function getOutboundRequestLogs(limit = 100) {
  return (await getDb()).select<any[]>('SELECT * FROM outbound_request_logs ORDER BY timestamp DESC LIMIT ?', [limit]);
}

export async function clearOutboundRequestLogs() {
  await (await getDb()).execute('DELETE FROM outbound_request_logs');
}

export async function logOutboundRequest(data: any) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO outbound_request_logs (timestamp, method, url, status_code, response_time_ms, error_message) VALUES (datetime(\'now\',\'localtime\'),?,?,?,?,?)',
    [data.method, data.url, data.status_code, data.response_time_ms, data.error_message]
  );
}

// ==================== Decomposition ====================
export async function getAllDecompositionNodes() {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree ORDER BY root_part_id, parent_id');
}

export async function getDecompositionTree(rootPartId: number) {
  const d = await getDb();
  const nodes = await d.select<any[]>('SELECT * FROM decomposition_tree WHERE root_part_id = ?', [rootPartId]);
  return nodes;
}

export async function getDecompositionNode(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree WHERE id = ?', [id]).then(r => r[0] || null);
}

export async function saveDecompositionNode(data: any) {
  const d = await getDb();
  const parentId = data.parent_id ?? null;
  let rootPartId = data.root_part_id ?? null;
  if (parentId && !rootPartId) {
    const parent = await d.select<any[]>('SELECT root_part_id FROM decomposition_tree WHERE id = ?', [parentId]);
    rootPartId = parent[0]?.root_part_id || parentId;
  }
  if (data.id) {
    await d.execute(
      'UPDATE decomposition_tree SET root_part_id=?, parent_id=?, component_name=?, cost_ratio_estimate=?, source_type=?, node_type=?, insight_status=?, trend_item_id=?, remark=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
      [rootPartId || data.id, parentId, data.component_name || data.node_name || '', data.cost_ratio_estimate ?? null, data.source_type || 'user_confirmed', data.node_type || 'structural', data.insight_status || 'pending', data.trend_item_id ?? null, data.remark || '', data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO decomposition_tree (root_part_id, parent_id, component_name, cost_ratio_estimate, source_type, node_type, insight_status, trend_item_id, remark, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'),datetime(\'now\',\'localtime\'))',
      [rootPartId, parentId, data.component_name || data.node_name || '', data.cost_ratio_estimate ?? null, data.source_type || 'user_confirmed', data.node_type || 'structural', data.insight_status || 'pending', data.trend_item_id ?? null, data.remark || '']
    );
    if (!rootPartId) await d.execute('UPDATE decomposition_tree SET root_part_id = ? WHERE id = ?', [r.lastInsertId, r.lastInsertId]);
    return r.lastInsertId;
  }
}

export async function deleteDecompositionNode(id: number) {
  await (await getDb()).execute(
    'WITH RECURSIVE descendants(id) AS (SELECT id FROM decomposition_tree WHERE id = ? UNION ALL SELECT dt.id FROM decomposition_tree dt JOIN descendants d ON dt.parent_id = d.id) DELETE FROM decomposition_tree WHERE id IN (SELECT id FROM descendants)',
    [id]
  );
}

export async function getDecompositionHistory(rootPartId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_history WHERE root_part_id = ? ORDER BY timestamp DESC', [rootPartId]);
}

export async function searchDecompositionNodes(query: string) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree WHERE component_name LIKE ? ORDER BY id', [`%${query}%`]);
}

export async function saveRollupContribution(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO rollup_contributions (parent_snapshot_id, child_component_id, cost_ratio_used, direction_used, created_at) VALUES (?,?,?,?,datetime(\'now\',\'localtime\'))',
    [data.parent_snapshot_id, data.child_component_id, data.cost_ratio_used ?? null, data.direction_used || '']
  );
  return r.lastInsertId;
}

export async function saveRollupFeedback(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO rollup_feedback (component_id, component_name, ai_direction, ai_summary, ai_confidence_level, user_corrected_direction, user_corrected_confidence_level, correction_reason, user_corrected_summary, created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
    [data.component_id, data.component_name || '', data.ai_direction || '', data.ai_summary || '', data.ai_confidence_level || '', data.user_corrected_direction || '', data.user_corrected_confidence_level || '', data.correction_reason || data.user_reason || '', data.user_corrected_summary || '']
  );
  return r.lastInsertId;
}

// ==================== Analysis Checklist ====================
export async function getAllChecklistWithLogs() {
  const d = await getDb();
  const items = await d.select<any[]>('SELECT * FROM analysis_checklist ORDER BY category, check_order');
  const logs = await d.select<any[]>('SELECT * FROM checklist_logs ORDER BY created_at DESC LIMIT 1000');
  const logMap: Record<number, any[]> = {};
  for (const log of logs) {
    const id = log.checklist_id;
    if (!logMap[id]) logMap[id] = [];
    logMap[id].push(log);
  }
  return {
    items: items.map((item: any) => ({ ...item, trigger_logs: logMap[item.id] || [] })),
    logs,
  };
}

export async function updateChecklistActive(id: number, active: boolean) {
  await (await getDb()).execute('UPDATE analysis_checklist SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

export async function deleteAnalysisChecklistItem(id: number) {
  await (await getDb()).execute('DELETE FROM analysis_checklist WHERE id = ?', [id]);
}

export async function getRollupContributions(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM rollup_contributions WHERE parent_snapshot_id = ?', [projectId]);
}

export async function getAllRollupFeedback() {
  return (await getDb()).select<any[]>('SELECT * FROM rollup_feedback ORDER BY created_at DESC');
}

// ==================== Part Suppliers ====================
export async function getAllPartSuppliers() {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers ORDER BY part_id, id DESC');
}

export async function getPartSuppliers(partId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers WHERE part_id = ? ORDER BY id DESC', [partId]);
}

export async function addPartSupplier(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO part_suppliers (part_id, supplier_name, price, share_ratio, is_active, remark) VALUES (?,?,?,?,?,?)',
    [data.part_id, data.supplier_name, data.price || 0, data.share_ratio || 0, data.is_active ?? 1, data.remark || '']
  );

  // 更新器件加权成本
  await updatePartWeightedCost(data.part_id);

  return r.lastInsertId;
}

export async function updatePartSupplier(data: any) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT * FROM part_suppliers WHERE id = ?', [data.id]);
  const price = data.price || 0;
  const oldPrice = old[0]?.price || 0;

  // 价格变动时记录历史
  if (old[0] && Math.abs(oldPrice - price) > 0.0001) {
    await d.execute(
      'INSERT INTO supplier_price_history (part_id, supplier_name, old_price, new_price, change_reason, changed_at) VALUES (?,?,?,?,?,datetime(\'now\',\'localtime\'))',
      [data.part_id ?? old[0].part_id, data.supplier_name ?? old[0].supplier_name, oldPrice, price, data.change_reason || '手动更新']
    );
  }

  await d.execute(
    'UPDATE part_suppliers SET supplier_name=?, price=?, share_ratio=?, is_active=?, remark=? WHERE id=?',
    [data.supplier_name, price, data.share_ratio || 0, data.is_active ?? 1, data.remark || '', data.id]
  );

  // 更新器件加权成本
  await updatePartWeightedCost(data.part_id ?? old[0]?.part_id);

  return data.id;
}

export async function deletePartSupplier(id: number) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT part_id FROM part_suppliers WHERE id = ?', [id]);
  await d.execute('DELETE FROM part_suppliers WHERE id = ?', [id]);

  // 删除后更新器件加权成本
  if (old[0]?.part_id) {
    await updatePartWeightedCost(old[0].part_id);
  }
}

// 更新器件的加权成本
async function updatePartWeightedCost(partId: number) {
  const d = await getDb();
  const suppliers = await d.select<any[]>(
    'SELECT price, share_ratio FROM part_suppliers WHERE part_id = ? AND is_active = 1',
    [partId]
  );

  if (suppliers.length === 0) {
    // 没有启用的供应商，成本设为0
    await d.execute('UPDATE parts SET cost = 0 WHERE id = ?', [partId]);
    return;
  }

  // 计算加权成本
  const totalShare = suppliers.reduce((sum, s) => sum + (Number(s.share_ratio) || 0), 0);

  if (totalShare === 0) {
    // 所有供应商份额都是0，取第一个供应商的价格
    const firstPrice = Number(suppliers[0]?.price) || 0;
    await d.execute('UPDATE parts SET cost = ? WHERE id = ?', [firstPrice, partId]);
    return;
  }

  // 归一化并计算加权成本
  const weightedCost = suppliers.reduce((sum, s) => {
    const share = Number(s.share_ratio) || 0;
    const price = Number(s.price) || 0;
    return sum + (price * share / totalShare);
  }, 0);

  await d.execute('UPDATE parts SET cost = ? WHERE id = ?', [weightedCost, partId]);
}

export async function getProjectSuppliers(projectId: number) {
  return (await getDb()).select<any[]>(
    `SELECT
       MIN(ps.id) as id,
       pb.project_id,
       ps.supplier_name,
       SUM(COALESCE(ps.price, ps.unit_price, 0) * pb.quantity) as quoted_price,
       AVG(COALESCE(ps.share_ratio, 0)) as share_ratio,
       MAX(COALESCE(ps.is_active, 1)) as is_active
     FROM part_suppliers ps
     JOIN project_boms pb ON ps.part_id = pb.part_id
     WHERE pb.project_id = ?
     GROUP BY pb.project_id, ps.supplier_name
     ORDER BY ps.supplier_name`,
    [projectId]
  );
}

export async function getSupplierPriceHistory(partId: number, supplierName: string) {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_price_history WHERE part_id = ? AND supplier_name = ? ORDER BY changed_at DESC', [partId, supplierName]);
}

// ==================== API Providers ====================
export async function getAllApiProviders() {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers ORDER BY provider_type, priority');
}

export async function getApiProvidersByType(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? ORDER BY priority', [type]);
}

export async function getActiveApiProviders(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? AND is_active = 1 ORDER BY priority', [type]);
}

export async function addApiProvider(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO api_providers (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [data.provider_type, data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.is_preset ? 1 : 0, data.monthly_quota_note || '', data.registration_url || '']
  );
  return r.lastInsertId;
}

export async function updateApiProvider(data: any) {
  const d = await getDb();
  await d.execute(
    'UPDATE api_providers SET provider_name=?, api_key=?, base_url=?, model_name=?, is_active=?, priority=?, monthly_quota_note=?, registration_url=? WHERE id=?',
    [data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.monthly_quota_note || '', data.registration_url || '', data.id]
  );
  return data.id;
}

export async function toggleApiProviderActive(id: number, isActive: boolean) {
  await (await getDb()).execute('UPDATE api_providers SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}

// ==================== AI Request Logs（AI请求审计日志） ====================

export async function saveAIRequestLog(data: {
  request_type: string;
  material_name?: string;
  system_prompt: string;
  user_prompt: string;
  response_summary: string;
  success: boolean;
  error_message?: string;
}) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO ai_request_logs (request_type, material_name, system_prompt, user_prompt, response_summary, success, error_message) VALUES (?,?,?,?,?,?,?)',
    [
      data.request_type,
      data.material_name || '',
      data.system_prompt,
      data.user_prompt,
      data.response_summary,
      data.success ? 1 : 0,
      data.error_message || ''
    ]
  );
  return r.lastInsertId;
}

export async function getAllAIRequestLogs(limit = 100) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM ai_request_logs ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

export async function deleteAIRequestLog(id: number) {
  await (await getDb()).execute('DELETE FROM ai_request_logs WHERE id = ?', [id]);
}

export async function clearAllAIRequestLogs() {
  await (await getDb()).execute('DELETE FROM ai_request_logs');
}
