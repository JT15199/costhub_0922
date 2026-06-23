import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

let db: Database | null = null;
let dbUrl: string | null = null;

async function getDbUrl(): Promise<string> {
  if (!dbUrl) { dbUrl = await invoke<string>('get_db_path'); }
  return dbUrl;
}
async function getDb(): Promise<Database> {
  if (!db) { db = await Database.load(await getDbUrl()); }
  return db;
}

let hasCostColumn: boolean | null = null;
async function checkCostColumn(): Promise<boolean> {
  if (hasCostColumn !== null) return hasCostColumn;
  try {
    const info = await (await getDb()).select<{ name: string }[]>("PRAGMA table_info('project_boms')");
    hasCostColumn = info.some(r => r.name === 'cost');
  } catch {
    hasCostColumn = false;
  }
  return hasCostColumn;
}

// 启动时自动检测并补齐缺失的 schema，不依赖线性迁移历史
export async function ensureSchema() {
  const d = await getDb();
  // project_boms.cost 列
  try { await d.execute("ALTER TABLE project_boms ADD COLUMN cost REAL DEFAULT NULL"); } catch {}
  // projects.sort_order 列
  try { await d.execute("ALTER TABLE projects ADD COLUMN sort_order REAL DEFAULT 0"); } catch {}
  // competitors.sort_order 列
  try { await d.execute("ALTER TABLE competitors ADD COLUMN sort_order REAL DEFAULT 0"); } catch {}
  // project_groups / project_group_members 表
  try { await d.execute("CREATE TABLE IF NOT EXISTS project_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))"); } catch {}
  try { await d.execute("CREATE TABLE IF NOT EXISTS project_group_members (group_id INTEGER NOT NULL, project_id INTEGER NOT NULL, PRIMARY KEY (group_id, project_id), FOREIGN KEY (group_id) REFERENCES project_groups(id) ON DELETE CASCADE, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE)"); } catch {}
  // project_boms.is_reference 列（规划引用标记）
  try { await d.execute("ALTER TABLE project_boms ADD COLUMN is_reference INTEGER DEFAULT 0"); } catch {}
  // project_boms.reference_remark 列（差异备注）
  try { await d.execute("ALTER TABLE project_boms ADD COLUMN reference_remark TEXT DEFAULT ''"); } catch {}
  // project_boms.is_deleted 列（软删除标记）
  try { await d.execute("ALTER TABLE project_boms ADD COLUMN is_deleted INTEGER DEFAULT 0"); } catch {}
  // cost_snapshots 表（成本快照）
  try { await d.execute("CREATE TABLE IF NOT EXISTS cost_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, snapshot_type TEXT DEFAULT 'auto', snapshot_date TEXT NOT NULL, snapshot_name TEXT DEFAULT '', snapshot_desc TEXT DEFAULT '', total_cost REAL NOT NULL, bom_cost REAL NOT NULL, fee_rate REAL DEFAULT 0, profit_rate REAL DEFAULT 0, final_price REAL DEFAULT 0, cost_breakdown TEXT DEFAULT '{}', bom_data TEXT DEFAULT '[]', parts_count INTEGER DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE)"); } catch {}
  try { await d.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_project ON cost_snapshots(project_id)"); } catch {}
  try { await d.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_date ON cost_snapshots(snapshot_date)"); } catch {}
  // cost_snapshots 新列（如果表已存在则补充）
  try { await d.execute("ALTER TABLE cost_snapshots ADD COLUMN bom_data TEXT DEFAULT '[]'"); } catch {}
  try { await d.execute("ALTER TABLE cost_snapshots ADD COLUMN snapshot_name TEXT DEFAULT ''"); } catch {}
  try { await d.execute("ALTER TABLE cost_snapshots ADD COLUMN snapshot_desc TEXT DEFAULT ''"); } catch {}
  // 刷新列缓存
  hasCostColumn = null;
}

// ==================== Cost Snapshots ====================
export async function saveCostSnapshot(projectId: number, snapshotType: 'auto' | 'manual' = 'auto', remark = '', snapshotName = '', snapshotDesc = '') {
  const d = await getDb();
  const project = await getProject(projectId);
  if (!project) return null;

  const boms = await getProjectBOMs(projectId);
  const bomCost = boms.reduce((sum: number, b: any) => sum + (b.part_cost || 0) * (b.quantity || 1), 0);
  const feeRate = project.platform_fee_rate || 0;
  const profitRate = project.profit_rate || 0;
  const totalCost = bomCost * (1 + feeRate / 100 + profitRate / 100);
  const finalPrice = totalCost;

  // 计算分类成本明细
  const breakdown: Record<string, number> = {};
  boms.forEach((b: any) => {
    const cat = b.main_category || '其他';
    breakdown[cat] = (breakdown[cat] || 0) + (b.part_cost || 0) * (b.quantity || 1);
  });

  // 保存完整BOM数据（JSON格式）
  const bomData = boms.map((b: any) => ({
    part_id: b.part_id,
    part_name: b.part_name,
    part_model: b.part_model,
    main_category: b.main_category,
    sub_category: b.sub_category,
    module_name: b.module_name,
    cost: b.part_cost || 0,
    quantity: b.quantity || 1,
    remark: b.remark || ''
  }));

  const partsCount = boms.length;
  const snapshotDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const r = await d.execute(
    `INSERT INTO cost_snapshots (project_id, snapshot_type, snapshot_date, total_cost, bom_cost, fee_rate, profit_rate, final_price, cost_breakdown, parts_count, remark, bom_data, snapshot_name, snapshot_desc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, snapshotType, snapshotDate, totalCost, bomCost, feeRate, profitRate, finalPrice, JSON.stringify(breakdown), partsCount, remark, JSON.stringify(bomData), snapshotName, snapshotDesc]
  );

  return r.lastInsertId;
}

export async function getCostSnapshots(projectId: number, limit = 30) {
  const d = await getDb();
  return d.select<any[]>(
    'SELECT * FROM cost_snapshots WHERE project_id = ? ORDER BY snapshot_date DESC, created_at DESC LIMIT ?',
    [projectId, limit]
  );
}

export async function getCostSnapshot(id: number) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM cost_snapshots WHERE id = ?', [id]);
  return r[0] || null;
}

export async function deleteCostSnapshot(id: number) {
  await (await getDb()).execute('DELETE FROM cost_snapshots WHERE id = ?', [id]);
}

export async function getLatestSnapshot(projectId: number) {
  const r = await (await getDb()).select<any[]>(
    'SELECT * FROM cost_snapshots WHERE project_id = ? ORDER BY snapshot_date DESC, created_at DESC LIMIT 1',
    [projectId]
  );
  return r[0] || null;
}

export async function compareSnapshots(snapshotId1: number, snapshotId2: number) {
  const d = await getDb();
  const s1 = await d.select<any[]>('SELECT * FROM cost_snapshots WHERE id = ?', [snapshotId1]);
  const s2 = await d.select<any[]>('SELECT * FROM cost_snapshots WHERE id = ?', [snapshotId2]);

  if (!s1[0] || !s2[0]) return null;

  const bom1 = JSON.parse(s1[0].bom_data || '[]');
  const bom2 = JSON.parse(s2[0].bom_data || '[]');

  // 对比BOM器件差异
  const bomDiff: any[] = [];

  // 按part_id分组对比
  const bom1Map = new Map<number, any>(bom1.map((b: any) => [b.part_id, b]));
  const bom2Map = new Map<number, any>(bom2.map((b: any) => [b.part_id, b]));

  // 检查所有器件
  const allPartIds = new Set([...bom1Map.keys(), ...bom2Map.keys()]);

  allPartIds.forEach(partId => {
    const item1: any = bom1Map.get(partId);
    const item2: any = bom2Map.get(partId);

    if (!item1 && item2) {
      // 新增器件
      bomDiff.push({
        part_id: partId,
        part_name: item2.part_name,
        change_type: 'added',
        old_cost: 0,
        new_cost: item2.cost * item2.quantity,
        old_qty: 0,
        new_qty: item2.quantity,
        diff_cost: item2.cost * item2.quantity
      });
    } else if (item1 && !item2) {
      // 删除器件
      bomDiff.push({
        part_id: partId,
        part_name: item1.part_name,
        change_type: 'removed',
        old_cost: item1.cost * item1.quantity,
        new_cost: 0,
        old_qty: item1.quantity,
        new_qty: 0,
        diff_cost: -(item1.cost * item1.quantity)
      });
    } else if (item1 && item2) {
      // 检查是否有变化（成本或数量）
      const oldCost = item1.cost * item1.quantity;
      const newCost = item2.cost * item2.quantity;
      const costDiff = newCost - oldCost;

      if (costDiff !== 0 || item1.quantity !== item2.quantity || item1.cost !== item2.cost) {
        bomDiff.push({
          part_id: partId,
          part_name: item2.part_name,
          change_type: costDiff > 0 ? 'increased' : 'decreased',
          old_cost: oldCost,
          new_cost: newCost,
          old_qty: item1.quantity,
          new_qty: item2.quantity,
          old_unit_cost: item1.cost,
          new_unit_cost: item2.cost,
          diff_cost: costDiff
        });
      }
    }
  });

  const breakdown1 = JSON.parse(s1[0].cost_breakdown || '{}');
  const breakdown2 = JSON.parse(s2[0].cost_breakdown || '{}');

  const breakdownDiff: Record<string, { old: number; new: number; change: number }> = {};
  const allCats = new Set([...Object.keys(breakdown1), ...Object.keys(breakdown2)]);

  allCats.forEach(cat => {
    const old = breakdown1[cat] || 0;
    const newVal = breakdown2[cat] || 0;
    const change = newVal - old;
    if (old !== newVal) {
      breakdownDiff[cat] = { old, new: newVal, change };
    }
  });

  return {
    snapshot1: s1[0],
    snapshot2: s2[0],
    totalChange: s2[0].total_cost - s1[0].total_cost,
    bomDiff,
    breakdownDiff,
    addedCount: bomDiff.filter(d => d.change_type === 'added').length,
    removedCount: bomDiff.filter(d => d.change_type === 'removed').length,
    changedCount: bomDiff.filter(d => d.change_type === 'increased' || d.change_type === 'decreased').length,
  };
}

export async function getProjectCostHistory(projectId: number, days = 30) {
  const d = await getDb();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  return d.select<any[]>(
    'SELECT * FROM cost_snapshots WHERE project_id = ? AND snapshot_date >= ? ORDER BY snapshot_date ASC',
    [projectId, startDateStr]
  );
}

export async function autoSnapshotAllProjects() {
  const projects = await getProjects('', '');
  const results = [];
  for (const p of projects) {
    try {
      const id = await saveCostSnapshot(p.id, 'auto', '每日自动快照');
      if (id) results.push({ projectId: p.id, snapshotId: id });
    } catch (e) {
      console.error(`Failed to snapshot project ${p.id}:`, e);
    }
  }
  return results;
}
export async function getParts(search = '', subCategory = '', mainCategory = '') {
  const d = await getDb();
  let q = 'SELECT * FROM parts WHERE 1=1'; const p: any[] = [];
  if (search) { q += ' AND (name LIKE ? OR model LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  if (subCategory) { q += ' AND sub_category = ?'; p.push(subCategory); }
  if (mainCategory) { q += ' AND main_category = ?'; p.push(mainCategory); }
  q += ' ORDER BY main_category, sub_category, name';
  return d.select<any[]>(q, p);
}
export async function getPart(id: number) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM parts WHERE id = ?', [id]);
  return r[0] || null;
}
export async function savePart(data: any) {
  const d = await getDb();
  if (data.id) {
    const old = await d.select<{ cost: number }[]>('SELECT cost FROM parts WHERE id = ?', [data.id]);
    if (old[0] && Math.abs(old[0].cost - (data.cost || 0)) > 0.0001) {
      await d.execute('INSERT INTO part_price_history (part_id, old_cost, new_cost) VALUES (?, ?, ?)', [data.id, old[0].cost, data.cost || 0]);
    }
    await d.execute(`UPDATE parts SET main_category=?, sub_category=?, category=?, name=?, model=?, cost=?, specs=?, projects=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '', data.id]);
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
  const d = await getDb();
  if (mainCat) {
    const r = await d.select<{ sc: string }[]>('SELECT DISTINCT sub_category as sc FROM parts WHERE main_category = ? AND sub_category != "" ORDER BY sc', [mainCat]);
    return r.map(x => x.sc);
  } else {
    // 获取所有子类（不限大类）
    const r = await d.select<{ sc: string }[]>('SELECT DISTINCT sub_category as sc FROM parts WHERE sub_category != "" ORDER BY sc');
    return r.map(x => x.sc);
  }
}

// ==================== Projects ====================
export async function getProjects(status = '', projectType = '') {
  const d = await getDb(); let q = 'SELECT * FROM projects WHERE 1=1'; const p: any[] = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (projectType) { q += ' AND project_type = ?'; p.push(projectType); }
  q += ' ORDER BY COALESCE(sort_order, 999999) ASC, created_at DESC';
  return d.select<any[]>(q, p);
}
export async function getProject(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM projects WHERE id = ?', [id]); return r[0] || null; }
export async function updateProjectOrder(orderedIds: number[]) {
  const d = await getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    await d.execute('UPDATE projects SET sort_order = ? WHERE id = ?', [i, orderedIds[i]]);
  }
}
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
export async function deleteProject(id: number) { await (await getDb()).execute('DELETE FROM projects WHERE id = ?', [id]); }

// ==================== Project Groups ====================
export async function getProjectGroups() {
  return (await getDb()).select<any[]>('SELECT * FROM project_groups ORDER BY id');
}
export async function getProjectGroupMembers(groupId: number) {
  return (await getDb()).select<any[]>('SELECT p.* FROM projects p JOIN project_group_members gm ON p.id = gm.project_id WHERE gm.group_id = ? ORDER BY p.sort_order ASC, p.created_at DESC', [groupId]);
}
export async function getUngroupedProjects() {
  return (await getDb()).select<any[]>(`SELECT * FROM projects WHERE id NOT IN (SELECT project_id FROM project_group_members) ORDER BY COALESCE(sort_order, 999999) ASC, created_at DESC`);
}
export async function saveProjectGroup(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE project_groups SET name=?, description=? WHERE id=?', [data.name, data.description || '', data.id]);
    return data.id;
  } else {
    const r = await d.execute('INSERT INTO project_groups (name, description) VALUES (?,?)', [data.name, data.description || '']);
    return r.lastInsertId;
  }
}
export async function deleteProjectGroup(id: number) {
  await (await getDb()).execute('DELETE FROM project_groups WHERE id = ?', [id]);
}
export async function addProjectToGroup(groupId: number, projectId: number) {
  await (await getDb()).execute('INSERT OR IGNORE INTO project_group_members (group_id, project_id) VALUES (?,?)', [groupId, projectId]);
}
export async function removeProjectFromGroup(groupId: number, projectId: number) {
  await (await getDb()).execute('DELETE FROM project_group_members WHERE group_id = ? AND project_id = ?', [groupId, projectId]);
}
export async function getProjectGroupId(projectId: number): Promise<number | null> {
  const r = await (await getDb()).select<{ group_id: number }[]>('SELECT group_id FROM project_group_members WHERE project_id = ?', [projectId]);
  return r.length > 0 ? r[0].group_id : null;
}

export async function copyProject(id: number, newCode: string, newName: string) {
  const d = await getDb(); const src = await d.select<any[]>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!src[0]) return 0;
  const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newCode, newName, '在研', src[0].tier, '进行中', src[0].screen_size, src[0].resolution, src[0].refresh_rate, src[0].panel_type, src[0].platform_fee_rate, src[0].profit_rate, src[0].image || '']);
  const boms = await d.select<any[]>('SELECT * FROM project_boms WHERE project_id = ?', [id]);
  const hasCost = await checkCostColumn();
  for (const b of boms) {
    if (hasCost) {
      await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, cost, ref_project_id) VALUES (?,?,?,?,?,?,?)', [r.lastInsertId, b.part_id, b.module_name, b.quantity, b.remark, b.cost, 0]);
    } else {
      await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id) VALUES (?,?,?,?,?,?)', [r.lastInsertId, b.part_id, b.module_name, b.quantity, b.remark, 0]);
    }
  }
  const mods = await d.select<any[]>('SELECT * FROM modules WHERE project_id = ?', [id]);
  for (const m of mods) {
    const mr = await d.execute('INSERT INTO modules (project_id, name, description) VALUES (?,?,?)', [r.lastInsertId, m.name, m.description]);
    const items = await d.select<any[]>('SELECT * FROM module_items WHERE module_id = ?', [m.id]);
    for (const mi of items) { await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [mr.lastInsertId, mi.part_id, mi.part_name, mi.part_model, mi.main_category, mi.sub_category, mi.cost, mi.quantity, mi.remark]); }
  }
  return r.lastInsertId;
}

// ==================== Project BOMs ====================
export async function getProjectBOMs(projectId: number) {
  const d = await getDb();
  const hasCost = await checkCostColumn();
  const partCostExpr = hasCost ? 'COALESCE(pb.cost, p.cost) as part_cost' : 'p.cost as part_cost';
  return d.select<any[]>(`SELECT pb.*, p.name as part_name, p.model as part_model, ${partCostExpr}, p.main_category, p.sub_category, p.category FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ? ORDER BY pb.module_name, p.main_category, p.sub_category, p.name`, [projectId]);
}
export async function addBOMItem(projectId: number, partId: number, quantity = 1, moduleName = '', remark = '', refProjectId = 0, cost: number | null = null, isReference = false, referenceRemark = '') {
  const d = await getDb();
  const hasCost = await checkCostColumn();
  if (hasCost) {
    await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id, cost, is_reference, reference_remark) VALUES (?,?,?,?,?,?,?,?,?)', [projectId, partId, moduleName, quantity, remark, refProjectId, cost, isReference ? 1 : 0, referenceRemark]);
  } else {
    await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id, is_reference, reference_remark) VALUES (?,?,?,?,?,?,?,?)', [projectId, partId, moduleName, quantity, remark, refProjectId, isReference ? 1 : 0, referenceRemark]);
  }
}
export async function updateBOMItem(id: number, quantity: number, moduleName: string, remark: string, cost?: number | null) {
  const d = await getDb();
  if (cost !== undefined) {
    await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=?, cost=? WHERE id=?', [quantity, moduleName, remark, cost, id]);
  } else {
    await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=? WHERE id=?', [quantity, moduleName, remark, id]);
  }
}
export async function updateBOMReferenceRemark(id: number, remark: string) {
  await (await getDb()).execute('UPDATE project_boms SET reference_remark=? WHERE id=?', [remark, id]);
}
export async function deleteReferenceBOMsByModule(projectId: number, moduleName: string) {
  await (await getDb()).execute('DELETE FROM project_boms WHERE project_id=? AND module_name=? AND is_reference=1', [projectId, moduleName]);
}
export async function softDeleteBOMItem(id: number) {
  await (await getDb()).execute('UPDATE project_boms SET is_deleted=1 WHERE id=?', [id]);
}
export async function restoreBOMItem(id: number) {
  await (await getDb()).execute('UPDATE project_boms SET is_deleted=0 WHERE id=?', [id]);
}
export async function updateBOMRefProject(moduleName: string, projectId: number, refProjectId: number) {
  await (await getDb()).execute('UPDATE project_boms SET ref_project_id=? WHERE project_id=? AND module_name=?', [refProjectId, projectId, moduleName]);
}
export async function deleteBOMItem(id: number) { await (await getDb()).execute('DELETE FROM project_boms WHERE id = ?', [id]); }
export async function deleteBOMItemsByModule(projectId: number, moduleName: string) {
  await (await getDb()).execute('DELETE FROM project_boms WHERE project_id = ? AND module_name = ?', [projectId, moduleName]);
}
export async function getModuleByProjectAndName(projectId: number, moduleName: string) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM modules WHERE project_id = ? AND name = ?', [projectId, moduleName]);
  return r[0] || null;
}
export async function syncBOMToModuleItem(projectId: number, moduleName: string, partId: number, quantity: number, cost: number) {
  const mod = await getModuleByProjectAndName(projectId, moduleName);
  if (!mod) return;
  await (await getDb()).execute(
    'UPDATE module_items SET quantity=?, cost=? WHERE module_id=? AND part_id=?',
    [quantity, cost, mod.id, partId]
  );
}
export async function deleteModuleItemByPartId(moduleId: number, partId: number) {
  await (await getDb()).execute('DELETE FROM module_items WHERE module_id=? AND part_id=?', [moduleId, partId]);
}
export async function getModuleProjectId(moduleId: number) {
  const r = await (await getDb()).select<{ project_id: number }[]>('SELECT project_id FROM modules WHERE id=?', [moduleId]);
  return r[0]?.project_id || null;
}
export async function getModuleNameById(moduleId: number) {
  const r = await (await getDb()).select<{ name: string }[]>('SELECT name FROM modules WHERE id=?', [moduleId]);
  return r[0]?.name || null;
}
export async function syncModuleItemToBOM(moduleId: number, partId: number, quantity: number, moduleName: string) {
  const projectId = await getModuleProjectId(moduleId);
  if (!projectId) return;
  await (await getDb()).execute(
    'UPDATE project_boms SET quantity=? WHERE project_id=? AND part_id=? AND module_name=?',
    [quantity, projectId, partId, moduleName]
  );
}
export async function deleteBOMByModuleName(projectId: number, moduleName: string) {
  await (await getDb()).execute('DELETE FROM project_boms WHERE project_id=? AND module_name=?', [projectId, moduleName]);
}
export async function deleteBOMItemsByPartIds(projectId: number, partIds: number[], moduleName: string) {
  if (partIds.length === 0) return;
  const d = await getDb();
  await d.execute(`DELETE FROM project_boms WHERE project_id=? AND module_name=? AND part_id IN (${partIds.map(() => '?').join(',')})`, [projectId, moduleName, ...partIds]);
}

// ==================== Modules ====================
export async function getModules(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM modules WHERE project_id = ? ORDER BY name', [projectId]); }
export async function getModuleItems(moduleId: number) { return (await getDb()).select<any[]>('SELECT * FROM module_items WHERE module_id = ? ORDER BY main_category, sub_category, part_name', [moduleId]); }
export async function saveModule(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE modules SET name=?, description=? WHERE id=?', [data.name, data.description || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO modules (project_id, name, description) VALUES (?,?,?)', [data.project_id, data.name, data.description || '']); return r.lastInsertId; }
}
export async function deleteModule(id: number) { await (await getDb()).execute('DELETE FROM modules WHERE id = ?', [id]); }
export async function cleanupEmptyModules(projectId: number) {
  // 删除没有器件的空模块
  const d = await getDb();
  // 先找出所有空模块的ID
  const emptyMods = await d.select<{ id: number }[]>(`
    SELECT m.id FROM modules m
    WHERE m.project_id=?
    AND NOT EXISTS (SELECT 1 FROM module_items mi WHERE mi.module_id = m.id)
  `, [projectId]);
  // 删除空模块
  for (const mod of emptyMods) {
    await d.execute('DELETE FROM modules WHERE id=?', [mod.id]);
  }
}
export async function saveModuleItem(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE module_items SET part_id=?, part_name=?, part_model=?, main_category=?, sub_category=?, cost=?, quantity=?, remark=? WHERE id=?', [data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost || 0, data.quantity ?? 1, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [data.module_id, data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost || 0, data.quantity ?? 1, data.remark || '']); return r.lastInsertId; }
}
export async function deleteModuleItem(id: number) { await (await getDb()).execute('DELETE FROM module_items WHERE id = ?', [id]); }
export async function getModuleCost(moduleId: number) {
  const items = await getModuleItems(moduleId);
  return items.reduce((s, i) => s + (i.cost || 0) * (i.quantity ?? 1), 0);
}
export async function getProjectModuleSummary(projectId: number) {
  const d = await getDb();
  const boms = await d.select<any[]>(`SELECT pb.module_name, pb.quantity, p.cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?`, [projectId]);
  const map: Record<string, number> = {};
  boms.forEach(b => {
    const m = b.module_name || '未归类';
    map[m] = (map[m] || 0) + (b.cost || 0) * (b.quantity ?? 1);
  });
  return Object.entries(map).map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }));
}

// ==================== Competitors ====================
export async function getCompetitors() { return (await getDb()).select<any[]>('SELECT * FROM competitors ORDER BY COALESCE(sort_order, 999999) ASC, created_at DESC'); }
export async function getCompetitor(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM competitors WHERE id = ?', [id]); return r[0] || null; }
export async function updateCompetitorOrder(orderedIds: number[]) {
  const d = await getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    await d.execute('UPDATE competitors SET sort_order = ? WHERE id = ?', [i, orderedIds[i]]);
  }
}
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
  await updateCompetitorBOMCost(competitorId);
}
export async function updateCompetitorBOMItem(id: number, partName: string, partModel: string, estimatedCost: number, quantity: number, moduleName: string) {
  await (await getDb()).execute('UPDATE competitor_boms SET part_name=?, part_model=?, estimated_cost=?, quantity=?, module_name=? WHERE id=?',
    [partName, partModel, estimatedCost, quantity, moduleName, id]);
  // 获取竞品ID并更新成本
  const r = await (await getDb()).select<{ competitor_id: number }[]>('SELECT competitor_id FROM competitor_boms WHERE id=?', [id]);
  if (r[0]) await updateCompetitorBOMCost(r[0].competitor_id);
}
export async function deleteCompetitorBOMItem(id: number) {
  const r = await (await getDb()).select<{ competitor_id: number }[]>('SELECT competitor_id FROM competitor_boms WHERE id=?', [id]);
  await (await getDb()).execute('DELETE FROM competitor_boms WHERE id = ?', [id]);
  if (r[0]) await updateCompetitorBOMCost(r[0].competitor_id);
}
export async function updateCompetitorBOMCost(competitorId: number) {
  // 计算BOM总成本并更新竞品表
  const items = await (await getDb()).select<{ estimated_cost: number, quantity: number }[]>('SELECT estimated_cost, quantity FROM competitor_boms WHERE competitor_id=?', [competitorId]);
  const totalCost = items.reduce((s, i) => s + (i.estimated_cost || 0) * (i.quantity ?? 1), 0);
  await (await getDb()).execute('UPDATE competitors SET bom_cost=? WHERE id=?', [totalCost, competitorId]);
}
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
