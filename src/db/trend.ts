// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb, localNow } from './core';



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



// ====== 快捷洞察（无需分解树，直接洞察单个物料行情，如"锂电池"） ======
export async function getQuickTrendItems() {
  // 确保旧库补齐缺失列（首次升级时兜底，幂等）
  try {
    await (await getDb()).execute("ALTER TABLE trend_items ADD COLUMN source_type TEXT DEFAULT 'decomposition'");
  } catch { /* 列已存在则忽略 */ }
  try {
    await (await getDb()).execute("ALTER TABLE trend_items ADD COLUMN last_queried_at TEXT DEFAULT ''");
  } catch { /* 列已存在则忽略 */ }
  return (await getDb()).select<any[]>(
    "SELECT * FROM trend_items WHERE source_type = 'quick' ORDER BY last_queried_at DESC, id DESC"
  );
}



export async function saveQuickTrendItem(data: { material_name: string; category_type?: string }) {
  const d = await getDb();
  const r = await d.execute(
    "INSERT INTO trend_items (query_category, category_type, source_type, last_queried_at) VALUES (?,?,?,?)",
    [data.material_name, data.category_type || '直接查询', 'quick', localNow()]
  );
  return r.lastInsertId;
}



export async function deleteQuickTrendItem(id: number) {
  await (await getDb()).execute('DELETE FROM trend_items WHERE id = ?', [id]);
}



export async function saveTrendItem(data: any) {
  const d = await getDb();
  // 字段口径统一：material_name（关注物料/快捷洞察入口传入）→ query_category
  const category = data.query_category ?? data.material_name ?? '';
  const sourceType = data.source_type || 'decomposition';
  const lastQueried = data.last_queried_at || data.last_updated_at || '';
  if (data.id) {
    await d.execute(
      'UPDATE trend_items SET query_category=?, category_type=?, trend_direction=?, confidence_level=?, summary=?, suggested_action=?, raw_search_results=?, last_updated_at=?, magnitude_min=?, magnitude_max=?, magnitude_reference=?, source_type=?, last_queried_at=? WHERE id=?',
      [category, data.category_type, data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference, sourceType, lastQueried, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO trend_items (query_category, category_type, trend_direction, confidence_level, summary, suggested_action, raw_search_results, last_updated_at, magnitude_min, magnitude_max, magnitude_reference, source_type, last_queried_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [category, data.category_type || '直接查询', data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference, sourceType, lastQueried]
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
  // 按 id DESC 排序（自增 id 单调递增，不受 query_time 字符串格式混排影响——旧数据是 ISO UTC 格式，新数据是本地时间格式，字符串排序会错乱）
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY id DESC', [trendItemId]);
}



export async function getLatestTrendSnapshot(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY id DESC LIMIT 1', [trendItemId]).then(r => r[0] || null);
}



export async function saveTrendSnapshot(data: any) {
  const d = await getDb();
  const confidenceLevel = data.confidence_level ?? data.confidence ?? '';
  const r = await d.execute(
    'INSERT INTO trend_snapshots (trend_item_id, query_time, source_type, direction, confidence, confidence_level, summary, suggested_action, skill_used, magnitude_min, magnitude_max, magnitude_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [data.trend_item_id, data.query_time ?? localNow(), data.source_type || 'direct_query', data.direction, confidenceLevel, confidenceLevel, data.summary, data.suggested_action, data.skill_used, data.magnitude_min, data.magnitude_max, data.magnitude_reference]
  );
  return r.lastInsertId;
}



export async function getTrendInsightDimensions(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_insight_dimensions WHERE trend_snapshot_id = ? ORDER BY dimension_order', [snapshotId]);
}



// 删除单个洞察快照（含关联的维度/关键事件；保留 trend_item 本身）
export async function deleteTrendSnapshot(snapshotId: number) {
  const d = await getDb();
  await d.execute('DELETE FROM trend_insight_dimensions WHERE trend_snapshot_id = ?', [snapshotId]);
  await d.execute('DELETE FROM trend_key_events WHERE trend_snapshot_id = ?', [snapshotId]);
  await d.execute('DELETE FROM trend_snapshots WHERE id = ?', [snapshotId]);
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