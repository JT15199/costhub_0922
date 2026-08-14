// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';



// ==================== Competitors ====================
export async function getCompetitors(category = '') {
  const d = await getDb();
  let q = 'SELECT * FROM competitors'; const p: any[] = [];
  if (category) { q += ' WHERE category = ?'; p.push(category); }
  q += ' ORDER BY COALESCE(sort_order, 0), created_at DESC';
  return d.select<any[]>(q, p);
}


export async function getCompetitor(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM competitors WHERE id = ?', [id]); return r[0] || null; }


export async function saveCompetitor(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitors SET brand=?,model=?,tier=?,category=?,market_price=?,bom_cost=?,platform_fee_rate=?,remark=? WHERE id=?', [data.brand, data.model, data.tier, data.category || '未分类', data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitors (brand,model,tier,category,market_price,bom_cost,platform_fee_rate,remark) VALUES (?,?,?,?,?,?,?,?)', [data.brand, data.model, data.tier, data.category || '未分类', data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '']); return r.lastInsertId; }
}


export async function deleteCompetitor(id: number) {
  const d = await getDb();
  // 级联清理竞品 BOM（避免孤儿行）
  await d.execute('DELETE FROM competitor_boms WHERE competitor_id = ?', [id]);
  await d.execute('DELETE FROM competitors WHERE id = ?', [id]);
}


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
// type: 不传=全部；'custom'=用户自定义（旧对比雷达）；'radar'=竞争力雷达固定五维
export async function getFeatures(type?: string) {
  if (type) return (await getDb()).select<any[]>('SELECT * FROM product_features WHERE type = ? ORDER BY id', [type]);
  return (await getDb()).select<any[]>('SELECT * FROM product_features ORDER BY id');
}


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



// ==================== 模块-特性关联（竞争力雷达）====================
// 模块名 → 特性（多对多，同名模块全局一致）；模块名以 project_boms 为准（与模块库单一数据源一致）
// 返回 [{ name, total }]：所有出现过且未删除的模块名，按 BOM 成本聚合降序（先配置成本高的）
export async function getModuleNames() {
  return (await getDb()).select<any[]>(`SELECT pb.module_name as name,
    SUM((CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END) * pb.quantity) as total
    FROM project_boms pb LEFT JOIN parts p ON pb.part_id = p.id
    WHERE pb.is_deleted = 0 AND pb.module_name != ''
    GROUP BY pb.module_name ORDER BY total DESC`);
}


// 全量关联：{ module_name: feature_id[] }
export async function getModuleFeatureLinks() {
  const rows = await (await getDb()).select<any[]>('SELECT module_name, feature_id FROM module_feature_links');
  const map: Record<string, number[]> = {};
  rows.forEach((r: any) => { (map[r.module_name] = map[r.module_name] || []).push(r.feature_id); });
  return map;
}


// 保存某模块的关联（先删后插，featureIds 传空数组 = 清空该模块关联）
export async function setModuleFeatureLinks(moduleName: string, featureIds: number[]) {
  const d = await getDb();
  await d.execute('DELETE FROM module_feature_links WHERE module_name = ?', [moduleName]);
  for (const fid of featureIds) {
    await d.execute('INSERT INTO module_feature_links (module_name, feature_id) VALUES (?,?)', [moduleName, fid]);
  }
}