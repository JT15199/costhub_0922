// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb, logDataChange } from './core';
import { recordProjectCostSnapshot } from './projects';



// ==================== Parts ====================
let canonicalEnsured = false; // 幂等兜底：canonical 影子列只在首次查询时 ALTER（防止未跑规范化时列不存在）
export async function getParts(search = '', category = '', mainCategory = '') {
  const d = await getDb();
  if (!canonicalEnsured) {
    for (const sql of ["ALTER TABLE parts ADD COLUMN canonical_name TEXT DEFAULT ''", "ALTER TABLE parts ADD COLUMN canonical_category TEXT DEFAULT ''", "ALTER TABLE parts ADD COLUMN canonical_specs TEXT DEFAULT '[]'", "ALTER TABLE parts ADD COLUMN canonical_updated_at TEXT DEFAULT ''"]) { try { await d.execute(sql); } catch { } }
    canonicalEnsured = true;
  }
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

// 批量取器件规格（报价比对/尺寸归一评估用；2026-08-17）
export async function getPartsSpecsMap(partIds: number[]): Promise<Record<number, string>> {
  const ids = [...new Set(partIds.filter(id => Number(id) > 0))];
  if (ids.length === 0) return {};
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT id, COALESCE(specs, \'\') as specs FROM parts WHERE id IN (' + ids.map(() => '?').join(',') + ')', ids);
  const map: Record<number, string> = {};
  rows.forEach((r: any) => { map[r.id] = r.specs || ''; });
  return map;
}


export async function savePart(data: any, autoSnapshot = true, syncReferences = false, source = 'manual') {
  const d = await getDb();
  if (data.id) {
    const old = await d.select<any[]>('SELECT * FROM parts WHERE id = ?', [data.id]);
    if (old[0] && Math.abs(old[0].cost - (data.cost || 0)) > 0.0001) {
      await d.execute('INSERT INTO part_price_history (part_id, old_cost, new_cost) VALUES (?, ?, ?)', [data.id, old[0].cost, data.cost || 0]);
    }
    const affectedProjects = autoSnapshot
      ? await d.select<{ project_id: number }[]>('SELECT DISTINCT project_id FROM project_boms WHERE part_id = ? AND COALESCE(is_deleted, 0) = 0', [data.id])
      : [];
    await d.execute(`UPDATE parts SET main_category=?, sub_category=?, category=?, name=?, model=?, cost=?, specs=?, projects=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '', data.id]);
    const oldPart = old[0];
    const nextPart = {
      main_category: data.main_category || '硬件类',
      sub_category: data.sub_category || '',
      category: data.category || '',
      name: data.name || '',
      model: data.model || '',
      cost: data.cost || 0,
      specs: data.specs || '',
      projects: data.projects || '',
      remark: data.remark || '',
    };
    // 成本仍写入既有 part_price_history，供价格趋势/统计模块使用；
    // 这里不再重复写入 data_change_history，避免一次成本编辑在历史弹窗中出现两条。
    const partFields: Array<[string, string]> = [
      ['main_category', '大类'], ['sub_category', '子类'], ['name', '名称'], ['model', '型号'],
      ['specs', '规格参数'], ['projects', '使用项目'], ['remark', '备注'],
    ];
    for (const [fieldKey, fieldLabel] of partFields) {
      await logDataChange({
        entityType: 'part', entityId: data.id, fieldKey, fieldLabel,
        oldValue: oldPart?.[fieldKey], newValue: nextPart[fieldKey as keyof typeof nextPart], source,
      });
    }
    // 需要跨页面保持一致时（项目 BOM 双击编辑/器件库行内编辑），同步所有引用的快照。
    // 默认关闭，避免历史报价导入流程意外改写既有项目快照。
    if (syncReferences) {
      await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, price_state='confirmed', main_category=?, sub_category=?
        WHERE part_id=? AND COALESCE(is_deleted,0)=0`,
        [nextPart.name, nextPart.model, nextPart.cost, nextPart.main_category, nextPart.sub_category, data.id]);
      await d.execute(`UPDATE module_items SET part_name=?, part_model=?, cost=?, main_category=?, sub_category=? WHERE part_id=?`,
        [nextPart.name, nextPart.model, nextPart.cost, nextPart.main_category, nextPart.sub_category, data.id]);
    }
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


export async function deletePart(id: number) {
  const d = await getDb();
  // 先处理引用它的 BOM 行（软删，避免 JOIN 到不存在的 parts 造成错位/报错）
  await d.execute('UPDATE project_boms SET is_deleted = 1 WHERE part_id = ? AND COALESCE(is_deleted, 0) = 0', [id]);
  // 清理供应商数据
  await d.execute('DELETE FROM part_suppliers WHERE part_id = ?', [id]);
  await d.execute('DELETE FROM part_price_history WHERE part_id = ?', [id]);
  // 清理洞察关联
  await d.execute('DELETE FROM trend_part_mapping WHERE part_id = ?', [id]);
  await d.execute('DELETE FROM parts WHERE id = ?', [id]);
}


export async function getPriceHistory(partId: number) { return (await getDb()).select<any[]>('SELECT * FROM part_price_history WHERE part_id = ? ORDER BY changed_at DESC', [partId]); }

export async function getPartPriceEvidence(partIds: number[] = []) {
  const ids = [...new Set(partIds.map(Number).filter(Boolean))];
  if (!ids.length) return {};
  const d = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await d.select<any[]>(`SELECT part_id, price, changed_at, source FROM (
    SELECT part_id, price, updated_at AS changed_at, '器件供应商' AS source FROM part_suppliers WHERE part_id IN (${placeholders}) AND COALESCE(is_active,1)=1 AND price>0
    UNION ALL SELECT pb.part_id, CASE WHEN pb.part_cost>0 THEN pb.part_cost ELSE p.cost END AS price, pb.created_at AS changed_at, '项目BOM' AS source FROM project_boms pb LEFT JOIN parts p ON p.id=pb.part_id WHERE pb.part_id IN (${placeholders}) AND COALESCE(pb.is_deleted,0)=0 AND (pb.part_cost>0 OR COALESCE(p.cost,0)>0)
    UNION ALL SELECT part_id, new_price AS price, changed_at, '供应商历史' AS source FROM part_supplier_price_history WHERE part_id IN (${placeholders}) AND new_price>0
  ) ORDER BY changed_at DESC, price DESC`, [...ids, ...ids, ...ids]);
  const result: Record<number, any> = {};
  rows.forEach(row => {
    const id = Number(row.part_id); const price = Number(row.price) || 0;
    const item = result[id] || { low: price, high: price, latest: price, latestAt: row.changed_at || '', sources: new Set<string>() };
    item.low = Math.min(item.low, price); item.high = Math.max(item.high, price); item.sources.add(row.source || '未知来源');
    result[id] = item;
  });
  try {
    const baselineRows = await d.select<any[]>(`SELECT scope_key, value, status, confirmed_at FROM cost_baseline_decisions WHERE baseline_type='material' AND status='confirmed' AND scope_key IN (${ids.map(() => '?').join(',')})`, ids.map(id => `part:${id}`));
    baselineRows.forEach(row => { const id = Number(String(row.scope_key).replace('part:', '')); const item = result[id] || { low: 0, high: 0, latest: 0, latestAt: '', sourceCount: 0 }; item.baseline = Number(row.value); result[id] = item; });
  } catch { }
  Object.values(result).forEach(item => { item.sourceCount = item.sources.size; delete item.sources; });
  return result;
}

export async function confirmPartPriceBaseline(partId: number, value: number, rationale = '用户确认物料价格基线') {
  const d = await getDb();
  const scopeKey = `part:${Number(partId)}`;
  const existing = (await d.select<any[]>('SELECT id FROM cost_baseline_decisions WHERE baseline_type=\'material\' AND scope_key=? AND status IN (\'candidate\',\'confirmed\') ORDER BY id DESC LIMIT 1', [scopeKey]))[0];
  if (existing) await d.execute("UPDATE cost_baseline_decisions SET value=?, status='confirmed', rationale=?, confirmed_at=datetime('now','localtime') WHERE id=?", [Number(value) || 0, rationale, existing.id]);
  else await d.execute("INSERT INTO cost_baseline_decisions (project_id, baseline_type, category, scope_key, source_type, value, status, rationale, confirmed_at) VALUES (0,'material',?,?,? ,?,'confirmed',?,datetime('now','localtime'))", ['物料', scopeKey, 'price_evidence', Number(value) || 0, rationale]);
  return existing?.id || 0;
}


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



// ==================== Part Suppliers ====================
export async function getAllPartSuppliers() {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers ORDER BY part_id, id DESC');
}



export async function getPartSuppliers(partId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers WHERE part_id = ? ORDER BY id DESC', [partId]);
}



export async function addPartSupplier(data: any) {
  data = { ...data, supplier_name: String(data.supplier_name || '').trim() };
  if (!data.supplier_name) throw new Error('供应商名称不能为空');
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
  data = { ...data, supplier_name: String(data.supplier_name || '').trim() };
  if (!data.supplier_name) throw new Error('供应商名称不能为空');
  const d = await getDb();
  const old = await d.select<any[]>('SELECT * FROM part_suppliers WHERE id = ?', [data.id]);
  const price = data.price || 0;
  const oldPrice = old[0]?.price || 0;

  // 价格变动时记录历史（统一写入 part_supplier_price_history，按 part_id+supplier_name 检索）
  if (old[0] && Math.abs(oldPrice - price) > 0.0001) {
    await d.execute(
      'INSERT INTO part_supplier_price_history (part_id, supplier_name, old_price, new_price, change_reason, changed_at) VALUES (?,?,?,?,?,datetime(\'now\',\'localtime\'))',
      [data.part_id ?? old[0].part_id, data.supplier_name ?? old[0].supplier_name, oldPrice, price, data.change_reason || '手动更新']
    );
    // 供应商报价变动 → 成本变动日志（追溯链起点，含影响项目）
    try {
      const partRow = await d.select<any[]>('SELECT name FROM parts WHERE id = ?', [data.part_id ?? old[0].part_id]);
      const projs = await d.select<any[]>(
        'SELECT DISTINCT p.code FROM project_boms b JOIN projects p ON p.id = b.project_id WHERE b.part_id = ? AND COALESCE(b.is_deleted,0)=0 AND COALESCE(p.is_deleted,0)=0',
        [data.part_id ?? old[0].part_id]
      );
      await d.execute(
        'INSERT INTO cost_change_log (change_type, ref_type, ref_id, ref_name, supplier_name, old_value, new_value, change_reason, impact_scope, changed_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
        ['part_supplier_price', 'part', data.part_id ?? old[0].part_id, partRow?.[0]?.name || '', data.supplier_name ?? old[0].supplier_name, oldPrice, price, data.change_reason || '手动更新', JSON.stringify(projs.map((p: any) => p.code))]
      );
    } catch { /* 日志失败不影响主流程 */ }
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
export async function updatePartWeightedCost(partId: number) {
  const d = await getDb();
  const suppliers = await d.select<any[]>(
    'SELECT price, share_ratio FROM part_suppliers WHERE part_id = ? AND is_active = 1',
    [partId]
  );
  // 追溯链：读取旧成本（变化时写 cost_change_log）
  const oldRow = await d.select<any[]>('SELECT cost, name FROM parts WHERE id = ?', [partId]);
  const oldCost = Number(oldRow?.[0]?.cost) || 0;
  const partName = oldRow?.[0]?.name || '';

  if (suppliers.length === 0) {
    // 没有启用的供应商，成本设为0
    await d.execute('UPDATE parts SET cost = 0, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [partId]);
    await logPartCostChange(partId, partName, oldCost, 0);
    return;
  }

  // 计算加权成本
  const totalShare = suppliers.reduce((sum, s) => sum + (Number(s.share_ratio) || 0), 0);

  if (totalShare === 0) {
    // 所有供应商份额都是0，取第一个供应商的价格
    const firstPrice = Number(suppliers[0]?.price) || 0;
    await d.execute('UPDATE parts SET cost = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [firstPrice, partId]);
    await logPartCostChange(partId, partName, oldCost, firstPrice);
    return;
  }

  // 归一化并计算加权成本（原始值累加，禁止循环内舍入）
  const weightedCost = suppliers.reduce((sum, s) => {
    const share = Number(s.share_ratio) || 0;
    const price = Number(s.price) || 0;
    return sum + (price * share / totalShare);
  }, 0);

  await d.execute('UPDATE parts SET cost = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [weightedCost, partId]);
  await logPartCostChange(partId, partName, oldCost, weightedCost);
}

// 成本变化 → 写成本变动日志（追溯链：改价 → 器件成本 → 影响项目）
async function logPartCostChange(partId: number, partName: string, oldCost: number, newCost: number) {
  if (Math.abs(newCost - oldCost) < 0.0001 || !partName) return;
  try {
    const d = await getDb();
    const projs = await d.select<any[]>(
      'SELECT DISTINCT p.code FROM project_boms b JOIN projects p ON p.id = b.project_id WHERE b.part_id = ? AND COALESCE(b.is_deleted,0)=0 AND COALESCE(p.is_deleted,0)=0',
      [partId]
    );
    await d.execute(
      'INSERT INTO cost_change_log (change_type, ref_type, ref_id, ref_name, old_value, new_value, change_reason, impact_scope, changed_at) VALUES (?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
      ['part_cost', 'part', partId, partName, oldCost, newCost, '供应商加权成本变化', JSON.stringify(projs.map((p: any) => p.code))]
    );
  } catch { /* 日志失败不影响主流程 */ }
}

export async function getSupplierPriceHistory(partId: number, supplierName: string) {
  return (await getDb()).select<any[]>('SELECT * FROM part_supplier_price_history WHERE part_id = ? AND supplier_name = ? ORDER BY changed_at DESC, id DESC', [partId, supplierName]);
}

// 成本变动追溯：该器件的 供应商报价变动 + 加权成本变化 日志（含影响项目）
export async function getPartCostChangeLogs(partId: number, limit = 10) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM cost_change_log WHERE ref_type = ? AND ref_id = ? AND change_type IN (?,?) ORDER BY changed_at DESC, id DESC LIMIT ?',
    ['part', partId, 'part_supplier_price', 'part_cost', limit]
  );
}
