// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';
import { recordProjectCostSnapshot } from './projects';



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
async function updatePartWeightedCost(partId: number) {
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
