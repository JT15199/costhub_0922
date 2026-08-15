// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';
import { savePart } from './parts';



// ==================== Projects ====================
export async function getProjects(status = '', projectType = '', category = '') {
  const d = await getDb(); let q = 'SELECT * FROM projects WHERE 1=1'; const p: any[] = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (projectType) { q += ' AND project_type = ?'; p.push(projectType); }
  if (category) { q += ' AND category = ?'; p.push(category); }
  q += ' AND COALESCE(is_deleted, 0) = 0 ORDER BY COALESCE(sort_order, 0), created_at DESC';
  return d.select<any[]>(q, p);
}


export async function getProject(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM projects WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [id]); return r[0] || null; }


export async function saveProject(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(`UPDATE projects SET code=?,name=?,project_type=?,tier=?,status=?,category=?,screen_size=?,resolution=?,refresh_rate=?,panel_type=?,platform_fee_rate=?,profit_rate=?,image=? WHERE id=?`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.category || '未分类', data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '', data.id]);
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,category,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.category || '未分类', data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '']);
    return r.lastInsertId;
  }
}


export async function deleteProject(id: number) { await (await getDb()).execute('UPDATE projects SET is_deleted = 1 WHERE id = ?', [id]); }



// ==================== 产品品类（可编辑） ====================
export async function getProductCategories() {
  return (await getDb()).select<any[]>('SELECT * FROM product_categories ORDER BY sort_order, id');
}


export async function saveProductCategory(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE product_categories SET name=?, sort_order=? WHERE id=?', [data.name, data.sort_order || 0, data.id]);
    return data.id;
  } else {
    const r = await d.execute('INSERT INTO product_categories (name, sort_order) VALUES (?,?)', [data.name, data.sort_order || 0]);
    return r.lastInsertId;
  }
}


export async function deleteProductCategory(id: number) {
  const d = await getDb();
  // 删除品类前，先把该品类的项目归回"未分类"兜底
  const [cat] = await d.select<any[]>('SELECT name FROM product_categories WHERE id=?', [id]);
  if (cat) {
    await d.execute("UPDATE projects SET category='未分类' WHERE category=?", [cat.name]);
    await d.execute("UPDATE competitors SET category='未分类' WHERE category=?", [cat.name]);
  }
  await d.execute('DELETE FROM product_categories WHERE id=?', [id]);
}


export async function ensureDefaultCategories() {
  const d = await getDb();
  const existing = await d.select<{ name: string }[]>('SELECT name FROM product_categories');
  const names = existing.map(e => e.name);
  // 只保证"未分类"兜底存在，其余品类由用户自行创建
  if (!names.includes('未分类')) {
    await d.execute('INSERT INTO product_categories (name, sort_order) VALUES (?,?)', ['未分类', 0]);
  }
}


export async function copyProject(id: number, newCode: string, newName: string) {
  const d = await getDb(); const src = await d.select<any[]>('SELECT * FROM projects WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [id]);
  if (!src[0]) return 0;
  const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [newCode, newName, '在研', src[0].tier, '进行中', src[0].screen_size, src[0].resolution, src[0].refresh_rate, src[0].panel_type, src[0].platform_fee_rate, src[0].profit_rate]);
  const boms = await d.select<any[]>('SELECT * FROM project_boms WHERE project_id = ? AND COALESCE(is_deleted, 0) = 0', [id]);
  for (const b of boms) {
    // 复制完整快照列（名称/型号/单价/分类/标记），保证复制项目与源项目显示一致
    await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, part_name, part_model, part_cost, main_category, sub_category, is_module_item, ref_project_id, is_reference, reference_remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [r.lastInsertId, b.part_id, b.module_name, b.quantity, b.remark || '', b.part_name || '', b.part_model || '', b.part_cost || 0, b.main_category || '', b.sub_category || '', b.is_module_item || 0, b.ref_project_id || 0, b.is_reference || 0, b.reference_remark || '']);
  }
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
  return (await getDb()).select<any[]>(`SELECT pb.id, pb.project_id, pb.part_id, pb.module_name, pb.quantity, pb.remark, pb.ref_project_id, pb.cost, pb.is_reference, pb.reference_remark, pb.is_deleted, pb.is_module_item,
    COALESCE(NULLIF(pb.part_name, ''), p.name) as part_name,
    COALESCE(NULLIF(pb.part_model, ''), p.model) as part_model,
    CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as part_cost,
    COALESCE(NULLIF(pb.main_category, ''), p.main_category) as main_category,
    COALESCE(NULLIF(pb.sub_category, ''), p.sub_category) as sub_category,
    p.category
    FROM project_boms pb LEFT JOIN parts p ON pb.part_id = p.id
    WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0
    ORDER BY pb.module_name, main_category, sub_category, part_name`, [projectId]);
}


export async function recordProjectCostSnapshot(projectId: number, snapshotType = 'bom_change', changeReason = '') {
  const d = await getDb();
  const project = await d.select<any[]>('SELECT * FROM projects WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [projectId]).then(rows => rows[0]);
  if (!project) return 0;

  // Get current BOM data with part details（单价用 BOM 行快照列，与页面显示一致）
  // LEFT JOIN：虚拟器件（part_id=0）无 parts 对应行，也必须计入成本
  const rows = await d.select<any[]>(
    `SELECT pb.id, pb.module_name, pb.quantity, COALESCE(NULLIF(pb.part_name, ''), p.name) as part_name, COALESCE(NULLIF(pb.part_model, ''), p.model) as part_model,
            CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost
     FROM project_boms pb
     LEFT JOIN parts p ON pb.part_id = p.id
     WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0`,
    [projectId]
  );

  // 计算口径：中间计算一律用原始值（该是多少就是多少），只有最终展示/落库才舍入
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
            COALESCE(NULLIF(pb.part_name, ''), p.name) as part_name, COALESCE(NULLIF(pb.part_model, ''), p.model) as part_model,
            COALESCE(NULLIF(pb.main_category, ''), p.main_category) as main_category, COALESCE(NULLIF(pb.sub_category, ''), p.sub_category) as sub_category,
            CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost
     FROM project_boms pb
     LEFT JOIN parts p ON pb.part_id = p.id
     WHERE pb.project_id = ?
       AND COALESCE(pb.is_deleted, 0) = 0
       AND pb.created_at <= ?
     ORDER BY pb.module_name, main_category, part_name`,
    [projectId, snapshotTime]
  );
  return rows;
}


export async function deleteProjectCostSnapshot(snapshotId: number) {
  await (await getDb()).execute('DELETE FROM project_cost_snapshots WHERE id = ?', [snapshotId]);
}


export async function addBOMItem(projectId: number, partId: number, quantity = 1, moduleName = '', remark = '', refProjectId = 0, autoSnapshot = true, snapshot?: { name?: string; model?: string; cost?: number; mainCategory?: string; subCategory?: string }) {
  const d = await getDb();
  // 固化快照列：BOM 行写入时记录器件名/型号/单价/分类，保证项目页与模块库读同一份数据
  // （parts 实时价可能被其他项目导入/供应商报价更新覆盖，若只 JOIN parts 会导致同一行两处显示不一致）
  // snapshot 参数：从参照项目导入时传入参照项目的快照值，确保导入后与参照完全一致
  let part: any = null;
  if (snapshot) {
    part = { name: snapshot.name || '', model: snapshot.model || '', cost: snapshot.cost ?? 0, main_category: snapshot.mainCategory || '', sub_category: snapshot.subCategory || '' };
  } else {
    part = await d.select<any[]>('SELECT name, model, cost, main_category, sub_category FROM parts WHERE id = ?', [partId]).then(r => r[0]);
  }
  await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id, part_name, part_model, part_cost, main_category, sub_category, is_module_item) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [projectId, partId, moduleName, quantity, remark, refProjectId, part?.name || '', part?.model || '', part?.cost || 0, part?.main_category || '', part?.sub_category || '', 0]);
  if (autoSnapshot) await recordProjectCostSnapshot(projectId, 'part_added', `新增器件到${moduleName || '未归类'}`);
}



/**
 * 添加虚拟器件 BOM 行（成本占位）：不建 parts、不占器件库，直接写 BOM 快照列。
 * 用于在研项目测算时预估模块成本（如"预留电源IC"），定型/选型后可替换为真实器件。
 */
export async function addVirtualBOMItem(projectId: number, data: { name: string; model?: string; cost?: number; quantity?: number; moduleName?: string; mainCategory?: string; subCategory?: string; remark?: string }) {
  await (await getDb()).execute(
    'INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, part_name, part_model, part_cost, main_category, sub_category, is_module_item) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [projectId, 0, data.moduleName || '未归类', data.quantity ?? 1, data.remark || '', data.name || '虚拟器件', data.model || '', data.cost ?? 0, data.mainCategory || '硬件类', data.subCategory || '', 1]
  );
  await recordProjectCostSnapshot(projectId, 'part_added', `新增虚拟器件：${data.name || ''}（${data.moduleName || '未归类'}）`);
}


export async function updateBOMItem(id: number, quantity: number, moduleName: string, remark: string, autoSnapshot = true, extra?: { partName?: string; partModel?: string; cost?: number; mainCategory?: string; subCategory?: string }) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT project_id FROM project_boms WHERE id = ?', [id]);
  // extra 传入时同步更新快照列（编辑 BOM 器件成本/名称时，快照优先显示会读到旧值）
  if (extra) {
    await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=?, part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=? WHERE id=?',
      [quantity, moduleName, remark, extra.partName ?? '', extra.partModel ?? '', extra.cost ?? 0, extra.mainCategory ?? '', extra.subCategory ?? '', id]);
  } else {
    await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=? WHERE id=?', [quantity, moduleName, remark, id]);
  }
  // 反向同步 module_items：项目页改 BOM 数量/模块后，模块库显示同一份数据
  try {
    const bom = await d.select<any[]>('SELECT part_id, module_name, part_name, part_model, part_cost, main_category, sub_category FROM project_boms WHERE id = ?', [id]).then(r => r[0]);
    if (rows[0]?.project_id && bom?.part_id) {
      await d.execute(`UPDATE module_items SET quantity=?, part_name=?, part_model=?, cost=?, main_category=?, sub_category=?
        WHERE module_id IN (SELECT id FROM modules WHERE project_id=? AND name=?)
          AND part_id=?`,
        [quantity, bom.part_name || '', bom.part_model || '', bom.part_cost || 0, bom.main_category || '', bom.sub_category || '', rows[0].project_id, bom.module_name, bom.part_id]);
    }
  } catch (e) { console.warn('updateBOMItem 同步 module_items 失败:', e); }
  if (autoSnapshot && rows[0]?.project_id) await recordProjectCostSnapshot(rows[0].project_id, 'part_changed', `调整BOM项：${moduleName || '未归类'}`);
}


export async function updateBOMRefProject(moduleName: string, projectId: number, refProjectId: number) {
  await (await getDb()).execute('UPDATE project_boms SET ref_project_id=? WHERE project_id=? AND module_name=?', [refProjectId, projectId, moduleName]);
}


export async function deleteBOMItem(id: number, autoSnapshot = true) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT project_id, module_name, part_id FROM project_boms WHERE id = ?', [id]);
  await d.execute('UPDATE project_boms SET is_deleted = 1 WHERE id = ?', [id]);
  // 反向同步 module_items：项目页移除 BOM 行后，模块库对应器件同步删除（防止两页偏差）
  try {
    const bom = rows[0];
    if (bom?.project_id && bom?.part_id && bom?.module_name) {
      await d.execute(`DELETE FROM module_items
        WHERE module_id IN (SELECT id FROM modules WHERE project_id=? AND name=?)
          AND part_id=?`,
        [bom.project_id, bom.module_name, bom.part_id]);
    }
  } catch (e) { console.warn('deleteBOMItem 同步 module_items 失败:', e); }
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



/** 模块分类顺序（存 settings 表，JSON 数组；未设置时按分类名字母序） */
export async function getModuleCategoryOrder(): Promise<string[]> {
  const d = await getDb();
  const rows = await d.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', ['module_category_order']);
  try { const arr = JSON.parse(rows[0]?.value || '[]'); return Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : []; }
  catch { return []; }
}


export async function saveModuleCategoryOrder(order: string[]) {
  await (await getDb()).execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['module_category_order', JSON.stringify(order)]);
}


export async function deleteModule(id: number) { await (await getDb()).execute('DELETE FROM modules WHERE id = ?', [id]); }


export async function updateModuleCategoryByName(name: string, category: string) {
  await (await getDb()).execute('UPDATE modules SET module_category = ? WHERE name = ?', [category || '未分类', name]);
}



/**
 * 修复 parts.projects 字段：按 project_boms 实际引用重算每个器件的关联项目代号（去重、逗号分隔）。
 * 历史数据早期导入未更新该字段，导致器件库"项目"列显示不全。幂等。
 */
export async function syncPartsProjectsField() {
  try {
    const d = await getDb();
    // 收集每个 part_id 被哪些项目引用（软删过滤）
    const rows = await d.select<any[]>(`SELECT pb.part_id, p.code FROM project_boms pb
      JOIN projects p ON pb.project_id = p.id
      WHERE pb.part_id > 0 AND COALESCE(pb.is_deleted, 0) = 0 AND COALESCE(p.is_deleted, 0) = 0
      ORDER BY pb.part_id, p.code`);
    const map: Record<number, string[]> = {};
    rows.forEach((r: any) => {
      if (!map[r.part_id]) map[r.part_id] = [];
      if (!map[r.part_id].includes(r.code)) map[r.part_id].push(r.code);
    });
    let fixed = 0;
    for (const [partId, codes] of Object.entries(map)) {
      const joined = codes.join(',');
      const cur = await d.select<any[]>('SELECT projects FROM parts WHERE id = ?', [Number(partId)]).then(r => r[0]);
      if (cur && (cur.projects || '') !== joined) {
        await d.execute('UPDATE parts SET projects = ? WHERE id = ?', [joined, Number(partId)]);
        fixed++;
      }
    }
    if (fixed > 0) console.log(`parts.projects 字段修复完成: ${fixed} 个器件`);
  } catch (e) { console.warn('syncPartsProjectsField 失败:', e); }
}



/**
 * 从 project_boms（权威 BOM 数据源）同步缺失的模块/器件到 modules/module_items。
 * 场景：①历史种子数据直接写 project_boms 没建 modules ②项目定型时只同步 parts 没同步模块库。
 * 幂等：已存在的模块/器件不重复创建，只补齐缺失的。返回新建的模块数。
 */
export async function syncProjectModulesToLibrary() {
  const d = await getDb();
  let created = 0;
  try {
    // 所有项目去重后的模块名（来自 project_boms）
    const projRows = await d.select<any[]>(`SELECT DISTINCT project_id, module_name FROM project_boms
      WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(NULLIF(module_name, ''), '') != ''`);
    for (const row of projRows) {
      const pid = row.project_id;
      const modName = row.module_name;
      const existing = await d.select<any[]>('SELECT id FROM modules WHERE project_id = ? AND name = ?', [pid, modName]);
      let modId: number;
      if (existing.length > 0) {
        modId = existing[0].id;
      } else {
        const r = await d.execute('INSERT INTO modules (project_id, name, module_category, description) VALUES (?,?,?,?)',
          [pid, modName, '未分类', `从项目BOM自动同步`]);
        modId = r.lastInsertId!;
        created++;
      }
      // 该模块的器件（project_boms 快照列）
      const items = await d.select<any[]>(`SELECT part_id, part_name, part_model, part_cost, main_category, sub_category, quantity, remark
        FROM project_boms WHERE project_id = ? AND module_name = ? AND COALESCE(is_deleted, 0) = 0 AND part_id IS NOT NULL`,
        [pid, modName]);
      for (const it of items) {
        const dup = await d.select<any[]>('SELECT id FROM module_items WHERE module_id = ? AND part_id = ?', [modId, it.part_id]);
        if (dup.length === 0) {
          await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)',
            [modId, it.part_id, it.part_name || '', it.part_model || '', it.main_category || '硬件类', it.sub_category || '', it.part_cost ?? 0, it.quantity ?? 1, it.remark || '']);
        }
      }
    }
    if (created > 0) console.log(`模块库同步完成: 新建 ${created} 个模块`);
  } catch (e) { console.warn('syncProjectModulesToLibrary 失败:', e); }
  return created;
}


export async function saveModuleItem(data: any) {
  const d = await getDb();
  let itemId: number;
  if (data.id) { await d.execute('UPDATE module_items SET part_id=?, part_name=?, part_model=?, main_category=?, sub_category=?, cost=?, quantity=?, remark=? WHERE id=?', [data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost ?? 0, data.quantity ?? 1, data.remark || '', data.id]); itemId = data.id; }
  else { const r = await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [data.module_id, data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost ?? 0, data.quantity ?? 1, data.remark || '']); itemId = r.lastInsertId!; }
  // 同步 project_boms 快照：模块库编辑器件后，项目页 BOM 显示同一份数据（防止两页偏差）
  try {
    const mod = await d.select<any[]>('SELECT project_id, name FROM modules WHERE id = ?', [data.module_id]).then(r => r[0]);
    if (mod) {
      await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=?, quantity=?, remark=?
        WHERE project_id=? AND module_name=? AND part_id=? AND COALESCE(is_deleted,0)=0`,
        [data.part_name || '', data.part_model || '', data.cost ?? 0, data.main_category || '硬件类', data.sub_category || '', data.quantity ?? 1, data.remark || '', mod.project_id, mod.name, data.part_id]);
    }
  } catch (e) { console.warn('saveModuleItem 同步 project_boms 失败:', e); }
  return itemId;
}


export async function deleteModuleItem(id: number) {
  const d = await getDb();
  const item = await d.select<any[]>('SELECT module_id, part_id, quantity FROM module_items WHERE id = ?', [id]).then(r => r[0]);
  await d.execute('DELETE FROM module_items WHERE id = ?', [id]);
  // 同步 project_boms：模块库删除器件后，项目页 BOM 同步软删（防止两页偏差）
  try {
    if (item?.module_id && item?.part_id) {
      const mod = await d.select<any[]>('SELECT project_id, name FROM modules WHERE id = ?', [item.module_id]).then(r => r[0]);
      if (mod) {
        await d.execute(`UPDATE project_boms SET is_deleted=1
          WHERE project_id=? AND module_name=? AND part_id=? AND COALESCE(is_deleted,0)=0 AND quantity=?`,
          [mod.project_id, mod.name, item.part_id, item.quantity]);
      }
    }
  } catch (e) { console.warn('deleteModuleItem 同步 project_boms 失败:', e); }
}


export async function getModuleCost(moduleId: number) {
  const items = await getModuleItems(moduleId);
  return items.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0);
}


/**
 * 模块库数据源（单一数据源 = project_boms）：
 * 返回所有项目的模块实例（每项目一个模块 = 一行），含成本/器件数/分类。
 * 模块分类取自 modules 表（有则用之，无则未分类）；模块存在与否、器件、成本全部以 project_boms 为准。
 * 这样模块库与项目管理页天然同源：任何一边改动，另一边自动反映，无需同步。
 */
export async function getLibraryModules() {
  const d = await getDb();
  const projs = await d.select<any[]>('SELECT * FROM projects WHERE COALESCE(is_deleted, 0) = 0 ORDER BY id');
  const mods = await d.select<any[]>(`SELECT m.id, m.project_id, m.name, m.module_category, m.description FROM modules m`);
  const catByKey: Record<string, string> = {};
  for (const m of mods) catByKey[`${m.project_id}|${m.name}`] = m.module_category || '未分类';
  const descByKey: Record<string, string> = {};
  for (const m of mods) descByKey[`${m.project_id}|${m.name}`] = m.description || '';

  const all: any[] = [];
  for (const p of projs) {
    // 该项目的全部 BOM 行（快照列，与项目页同一查询口径）
    const boms = await getProjectBOMs(p.id);
    // 按模块名分组
    const byMod: Record<string, any[]> = {};
    boms.forEach((b: any) => {
      const m = b.module_name || '未归类';
      if (!byMod[m]) byMod[m] = [];
      byMod[m].push(b);
    });
    for (const [modName, items] of Object.entries(byMod)) {
      // 虚拟模块过滤：空模块（成本预估占位、无器件）不进模块库
      if (items.length === 0) continue;
      const cost = items.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
      const key = `${p.id}|${modName}`;
      all.push({
        // 标识用 project_id+module_name（模块库内部 id 不再依赖 modules 表）
        id: key, project_id: p.id, module_name: modName, name: modName,
        module_category: catByKey[key] || '未分类',
        description: descByKey[key] || '',
        project_code: p.code, project_name: p.name, project_type: p.project_type,
        prod_category: p.category || '未分类',
        itemCount: items.length, totalCost: cost, cost,
        items,
      });
    }
  }
  return all;
}



/** 模块库：取某项目某模块的器件明细（直接读 project_boms） */
export async function getLibraryModuleItems(projectId: number, moduleName: string) {
  const boms = await getProjectBOMs(projectId);
  return boms.filter((b: any) => (b.module_name || '未归类') === moduleName);
}



/** 模块库：编辑模块器件（更新 project_boms 快照列 + 同步 parts 器件库）——单一数据源，改这里两边都变 */
export async function updateLibraryModuleItem(bomId: number, data: any) {
  const d = await getDb();
  const bom = await d.select<any[]>('SELECT * FROM project_boms WHERE id = ?', [bomId]).then(r => r[0]);
  if (!bom) return;
  await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=?, quantity=?, remark=? WHERE id=?`,
    [data.part_name || '', data.part_model || '', data.cost ?? 0, data.main_category || '硬件类', data.sub_category || '', data.quantity ?? 1, data.remark || '', bomId]);
  // 同步 parts 表（器件库也更新），保证器件库/项目页/模块库三处一致
  if (bom.part_id) {
    await savePart({ id: bom.part_id, main_category: data.main_category || '硬件类', sub_category: data.sub_category || '', category: data.main_category || '硬件类', name: data.part_name, model: data.part_model || '', cost: data.cost ?? 0, specs: '', projects: '', remark: data.remark || '' }, false);
  }
  // 同步 module_items（兼容层）
  const mod = await d.select<any[]>('SELECT id FROM modules WHERE project_id = ? AND name = ?', [bom.project_id, bom.module_name]).then(r => r[0]);
  if (mod) {
    const dup = await d.select<any[]>('SELECT id FROM module_items WHERE module_id = ? AND part_id = ?', [mod.id, bom.part_id]).then(r => r[0]);
    if (dup) await d.execute('UPDATE module_items SET part_name=?, part_model=?, cost=?, main_category=?, sub_category=?, quantity=?, remark=? WHERE id=?',
      [data.part_name || '', data.part_model || '', data.cost ?? 0, data.main_category || '硬件类', data.sub_category || '', data.quantity ?? 1, data.remark || '', dup.id]);
  }
}



/** 模块库：删除模块（软删该项目该模块的全部 BOM 行 + 同步 module_items） */
export async function deleteLibraryModule(projectId: number, moduleName: string) {
  const d = await getDb();
  await d.execute('UPDATE project_boms SET is_deleted=1 WHERE project_id=? AND module_name=? AND COALESCE(is_deleted,0)=0', [projectId, moduleName]);
  const mod = await d.select<any[]>('SELECT id FROM modules WHERE project_id = ? AND name = ?', [projectId, moduleName]).then(r => r[0]);
  if (mod) await d.execute('DELETE FROM module_items WHERE module_id = ?', [mod.id]);
}



/** 模块库：模块改名（同步 project_boms 全部行 + modules 表） */
export async function renameLibraryModule(projectId: number, oldName: string, newName: string) {
  const d = await getDb();
  await d.execute('UPDATE project_boms SET module_name=? WHERE project_id=? AND module_name=?', [newName, projectId, oldName]);
  await d.execute('UPDATE modules SET name=? WHERE project_id=? AND name=?', [newName, projectId, oldName]);
}



export async function getProjectModuleSummary(projectId: number) {
  const d = await getDb();
  const boms = await d.select<any[]>(`SELECT pb.module_name, pb.quantity, CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0`, [projectId]);
  const map: Record<string, number> = {};
  boms.forEach(b => {
    const m = b.module_name || '未归类';
    map[m] = (map[m] || 0) + (b.cost || 0) * (b.quantity || 1);
  });
  return Object.entries(map).map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }));
}



// ==================== SKU 变体（基座项目 + 差异规则）====================
// SKU 不落完整 BOM，只存差异规则（add 加器件 / remove 减基座器件 / replace 换型号单价）
// SKU 成本 = 基座 BOM 成本 + Σ差异 → 基座变则 SKU 自动重算
export async function getSkus(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM project_skus WHERE project_id = ? ORDER BY id', [projectId]);
}


// 全部 SKU（品类→项目→SKU 树用）
export async function getAllSkus() {
  return (await getDb()).select<any[]>('SELECT * FROM project_skus ORDER BY project_id, id');
}


export async function saveSku(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE project_skus SET sku_code=?, sku_name=?, spec_desc=?, remark=? WHERE id=?',
      [data.sku_code, data.sku_name || '', data.spec_desc || '', data.remark || '', data.id]);
    return data.id;
  }
  const r = await d.execute('INSERT INTO project_skus (project_id, sku_code, sku_name, spec_desc, remark) VALUES (?,?,?,?,?)',
    [data.project_id, data.sku_code, data.sku_name || '', data.spec_desc || '', data.remark || '']);
  return r.lastInsertId;
}


export async function deleteSku(id: number) {
  const d = await getDb();
  await d.execute('DELETE FROM sku_diffs WHERE sku_id = ?', [id]);
  await d.execute('DELETE FROM project_skus WHERE id = ?', [id]);
}


export async function getSkuDiffs(skuId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM sku_diffs WHERE sku_id = ? ORDER BY id', [skuId]);
}


export async function saveSkuDiff(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE sku_diffs SET diff_type=?, module_name=?, part_name=?, part_model=?, quantity=?, unit_cost=?, remark=? WHERE id=?',
      [data.diff_type, data.module_name || '', data.part_name || '', data.part_model || '', data.quantity ?? 1, data.unit_cost || 0, data.remark || '', data.id]);
    return data.id;
  }
  const r = await d.execute('INSERT INTO sku_diffs (sku_id, diff_type, module_name, part_name, part_model, quantity, unit_cost, remark) VALUES (?,?,?,?,?,?,?,?)',
    [data.sku_id, data.diff_type, data.module_name || '', data.part_name || '', data.part_model || '', data.quantity ?? 1, data.unit_cost || 0, data.remark || '']);
  return r.lastInsertId;
}


export async function deleteSkuDiff(id: number) { await (await getDb()).execute('DELETE FROM sku_diffs WHERE id = ?', [id]); }


// 批量取多个 SKU 的差异（SKU 列表成本计算用）
export async function getAllSkuDiffs(skuIds: number[]) {
  const d = await getDb();
  if (skuIds.length === 0) return {} as Record<number, any[]>;
  const rows = await d.select<any[]>(`SELECT * FROM sku_diffs WHERE sku_id IN (${skuIds.map(() => '?').join(',')}) ORDER BY id`, skuIds);
  const map: Record<number, any[]> = {};
  rows.forEach(r => { (map[r.sku_id] = map[r.sku_id] || []).push(r); });
  return map;
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



// ==================== 整机供应商（ODM） ====================
// ODM 供应商：承接整机生产制造，提供部分或全部物料，报价为整机报价（project_suppliers 表）

export async function getProjectSuppliers(projectId: number) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM project_suppliers WHERE project_id = ? ORDER BY is_active DESC, id DESC',
    [projectId]
  );
}



export async function saveProjectSupplier(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      "UPDATE project_suppliers SET supplier_name=?, quoted_price=?, share_ratio=?, is_active=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.supplier_name, data.quoted_price || 0, data.share_ratio || 0, data.is_active ? 1 : 0, data.remark || '', data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO project_suppliers (project_id, supplier_name, quoted_price, share_ratio, is_active, remark) VALUES (?,?,?,?,?,?)',
      [data.project_id, data.supplier_name, data.quoted_price || 0, data.share_ratio || 0, data.is_active ? 1 : 0, data.remark || '']
    );
    return r.lastInsertId;
  }
}



export async function deleteProjectSupplier(id: number) {
  await (await getDb()).execute('DELETE FROM project_suppliers WHERE id = ?', [id]);
}



// 整机供应商报价历史（project_supplier_price_history 表）
export async function getProjectSupplierPriceHistory(supplierId: number) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM project_supplier_price_history WHERE supplier_id = ? ORDER BY changed_at DESC',
    [supplierId]
  );
}



export async function saveProjectSupplierPriceHistory(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO project_supplier_price_history (supplier_id, old_price, new_price, change_reason) VALUES (?,?,?,?)',
    [data.supplier_id, data.old_price || 0, data.new_price || 0, data.change_reason || '']
  );
  return r.lastInsertId;
}