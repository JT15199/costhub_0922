// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { invoke } from '@tauri-apps/api/core';
import { getDb, localNow } from './core';

export type MaterialInsightSubjectKind = 'decomposition' | 'direct';
export type MaterialInsightSubjectStatus = 'draft' | 'ready' | 'pending' | 'queued' | 'running' | 'paused' | 'partial' | 'completed' | 'failed';
export interface MaterialInsightSubject {
  key: string;
  kind: MaterialInsightSubjectKind;
  title: string;
  categoryType: string;
  rootNodeId: number | null;
  nodes: any[];
  trendItemId: number | null;
  trendItemIds: number[];
  childTrendItemIds: number[];
  trendItem: any | null;
  latestSnapshot: any | null;
  status: MaterialInsightSubjectStatus;
  nodeCount: number;
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  queuedNodes: number;
  runningNodes: number;
  pausedNodes: number;
  pendingNodes: number;
  skippedNodes: number;
  updatedAt: string;
  favorite: boolean;
  archived: boolean;
  historyCount: number;
  needsReview?: boolean;
}

const numericId = (value: unknown) => {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const latestById = (rows: any[]) => rows.slice().sort((a, b) => (Number(b?.id) || 0) - (Number(a?.id) || 0))[0] || null;
const latestTime = (rows: any[]) => rows.map(row => String(row?.updated_at || row?.query_time || row?.last_queried_at || row?.created_at || '')).sort().pop() || '';
const directKey = (item: any) => `${String(item?.query_category || '').trim().toLocaleLowerCase()}|${String(item?.category_type || '直接查询').trim().toLocaleLowerCase()}`;

function nodeCounts(nodes: any[]) {
  const work = nodes.filter(node => node?.node_type === 'terminal');
  const count = (values: string[]) => work.filter(node => values.includes(String(node?.insight_status || 'pending'))).length;
  const completedNodes = count(['queried', 'completed']);
  const failedNodes = count(['failed', 'error']);
  const queuedNodes = count(['queued']);
  const runningNodes = count(['running']);
  const pausedNodes = count(['paused']);
  const skippedNodes = count(['skipped', 'ready']);
  const pendingNodes = count(['pending', '']);
  let status: MaterialInsightSubjectStatus = 'pending';
  if (work.length === 0) status = 'draft';
  else if (pausedNodes > 0 && runningNodes === 0) status = 'paused';
  else if (runningNodes > 0) status = 'running';
  else if (queuedNodes > 0) status = 'queued';
  else if (failedNodes > 0 && completedNodes > 0) status = 'partial';
  else if (failedNodes > 0 && completedNodes === 0 && pendingNodes === 0 && skippedNodes === 0) status = 'failed';
  else if (completedNodes === work.length) status = 'completed';
  else if (completedNodes > 0 || failedNodes > 0) status = 'partial';
  else if (skippedNodes === work.length) status = 'ready';
  return { work, status, completedNodes, failedNodes, queuedNodes, runningNodes, pausedNodes, pendingNodes, skippedNodes };
}

/** Pure grouping rule shared by the workbench, results page and tests. */
export function groupMaterialInsightRows(trendItems: any[], treeNodes: any[], snapshots: any[] = []): MaterialInsightSubject[] {
  const items = Array.isArray(trendItems) ? trendItems : [];
  const nodes = Array.isArray(treeNodes) ? treeNodes : [];
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  const roots = nodes.filter(node => node?.parent_id == null && numericId(node?.id));
  const rootTrendIds = new Set<number>();
  const childTrendIds = new Set<number>();
  const subjects: MaterialInsightSubject[] = [];

  for (const root of roots) {
    const rootId = Number(root.id);
    const related = new Map<number, any>([[rootId, root]]);
    const queue = [rootId];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const node of nodes) {
        if (Number(node?.parent_id) !== parentId || !numericId(node?.id) || related.has(Number(node.id))) continue;
        related.set(Number(node.id), node);
        queue.push(Number(node.id));
      }
    }
    // Older databases sometimes retained root_part_id without a complete parent chain.
    const legacyRootPart = root.root_part_id;
    if (legacyRootPart != null) {
      const sameLegacyRoot = roots.filter(candidate => candidate.id !== root.id && candidate.root_part_id === legacyRootPart);
      if (sameLegacyRoot.length === 0) {
        nodes.filter(node => node.root_part_id === legacyRootPart && node.parent_id != null).forEach(node => related.set(Number(node.id), node));
      }
    }
    const groupedNodes = [...related.values()];
    const rootTrendId = numericId(root.trend_item_id);
    if (rootTrendId) rootTrendIds.add(rootTrendId);
    const childIds = groupedNodes.filter(node => Number(node.id) !== rootId).map(node => numericId(node.trend_item_id)).filter((id): id is number => id != null);
    childIds.forEach(id => childTrendIds.add(id));
    const trendIds = [...new Set([...(rootTrendId ? [rootTrendId] : []), ...childIds])];
    const trendItem = rootTrendId ? items.find(item => Number(item.id) === rootTrendId) || null : null;
    const subjectSnaps = snaps.filter(snap => trendIds.includes(Number(snap.trend_item_id)));
    const snapshotTrendIds = new Set(subjectSnaps.map(snap => Number(snap.trend_item_id)));
    const resolvedNodes = groupedNodes.map(node => {
      const status = String(node.insight_status || '');
      return snapshotTrendIds.has(Number(node.trend_item_id)) && ['pending', 'ready', ''].includes(status)
        ? { ...node, insight_status: 'queried' }
        : node;
    });
    const counts = nodeCounts(resolvedNodes.filter(node => Number(node.id) !== rootId));
    const rootUpdated = latestTime(groupedNodes);
    const latestSnapshot = latestById(subjectSnaps);
    subjects.push({
      key: `tree:${rootId}`,
      kind: 'decomposition',
      title: String(root.component_name || '未命名物料'),
      categoryType: String(trendItem?.category_type || '分解洞察'),
      rootNodeId: rootId,
      nodes: resolvedNodes,
      trendItemId: rootTrendId,
      trendItemIds: trendIds,
      childTrendItemIds: childIds,
      trendItem,
      latestSnapshot,
      status: counts.status,
      nodeCount: resolvedNodes.filter(node => Number(node.id) !== rootId).length,
      totalNodes: counts.work.length,
      completedNodes: counts.completedNodes,
      failedNodes: counts.failedNodes,
      queuedNodes: counts.queuedNodes,
      runningNodes: counts.runningNodes,
      pausedNodes: counts.pausedNodes,
      pendingNodes: counts.pendingNodes,
      skippedNodes: counts.skippedNodes,
      updatedAt: [rootUpdated, latestTime(subjectSnaps)].sort().pop() || '',
      favorite: false,
      archived: false,
      historyCount: subjectSnaps.length,
    });
  }

  const directGroups = new Map<string, any[]>();
  for (const item of items) {
    const id = numericId(item?.id);
    if (!id || childTrendIds.has(id) || rootTrendIds.has(id)) continue;
    const key = directKey(item);
    directGroups.set(key, [...(directGroups.get(key) || []), item]);
  }
  for (const [key, groupedItems] of directGroups) {
    const trendItem = groupedItems.slice().sort((a, b) => {
      const aTime = String(a?.last_queried_at || a?.last_updated_at || a?.created_at || '');
      const bTime = String(b?.last_queried_at || b?.last_updated_at || b?.created_at || '');
      return bTime.localeCompare(aTime) || (Number(b.id) || 0) - (Number(a.id) || 0);
    })[0];
    const trendIds = groupedItems.map(item => Number(item.id)).filter(Number.isFinite);
    const subjectSnaps = snaps.filter(snap => trendIds.includes(Number(snap.trend_item_id)));
    const latestSnapshot = latestById(subjectSnaps);
    const completed = subjectSnaps.length > 0 || !!trendItem?.trend_direction || !!trendItem?.summary;
    subjects.push({
      key: `direct:${key}`,
      kind: 'direct',
      title: String(trendItem?.query_category || '未命名物料'),
      categoryType: String(trendItem?.category_type || '直接查询'),
      rootNodeId: null,
      nodes: [],
      trendItemId: Number(trendItem.id),
      trendItemIds: trendIds,
      childTrendItemIds: [],
      trendItem,
      latestSnapshot,
      status: completed ? 'completed' : 'pending',
      nodeCount: 0,
      totalNodes: 1,
      completedNodes: completed ? 1 : 0,
      failedNodes: 0,
      queuedNodes: 0,
      runningNodes: 0,
      pausedNodes: 0,
      pendingNodes: completed ? 0 : 1,
      skippedNodes: 0,
      updatedAt: [latestTime(groupedItems), latestTime(subjectSnaps)].sort().pop() || '',
      favorite: false,
      archived: false,
      historyCount: subjectSnaps.length,
      needsReview: !['quick', 'auto'].includes(String(trendItem?.source_type || '')),
    });
  }

  // Keep orphaned nodes out of the parent list; they remain available through their raw tree rows.
  return subjects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.title.localeCompare(b.title));
}

export async function getMaterialInsightSubjects(): Promise<MaterialInsightSubject[]> {
  try {
    const d = await getDb();
    const [items, nodes, snapshots] = await Promise.all([
      d.select<any[]>('SELECT * FROM trend_items ORDER BY id DESC'),
      d.select<any[]>('SELECT * FROM decomposition_tree ORDER BY id'),
      d.select<any[]>('SELECT * FROM trend_snapshots ORDER BY id DESC'),
    ]);
    const subjects = groupMaterialInsightRows(items, nodes, snapshots);
    let metas: any[] = [];
    try { metas = await d.select<any[]>('SELECT * FROM analysis_item_meta WHERE item_key LIKE ?', ['material_subject:%']); } catch { }
    const metaMap = new Map(metas.map(meta => [String(meta.item_key), meta]));
    return subjects
      .map(subject => ({ ...subject, favorite: Boolean(Number(metaMap.get(`material_subject:${subject.key}`)?.favorite)), archived: Boolean(Number(metaMap.get(`material_subject:${subject.key}`)?.archived)) }))
      .filter(subject => !subject.archived);
  } catch {
    return [];
  }
}

export async function updateMaterialInsightSubjectMeta(key: string, patch: { favorite?: boolean; archived?: boolean }) {
  const d = await getDb();
  await d.execute(`CREATE TABLE IF NOT EXISTS analysis_item_meta (item_key TEXT PRIMARY KEY, domain TEXT DEFAULT '', object_type TEXT DEFAULT '', object_id TEXT DEFAULT '', object_name TEXT DEFAULT '', favorite INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  const itemKey = `material_subject:${key}`;
  const current = (await d.select<any[]>('SELECT * FROM analysis_item_meta WHERE item_key=?', [itemKey]))[0] || {};
  await d.execute(`INSERT OR REPLACE INTO analysis_item_meta (item_key,domain,object_type,object_id,object_name,favorite,archived,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`, [
    itemKey, 'material', current.object_type || '', current.object_id || key, current.object_name || '', patch.favorite ?? Boolean(Number(current.favorite)), patch.archived ?? Boolean(Number(current.archived)),
  ]);
}

export async function getDirectTrendItemByCategory(category: string, categoryType = '直接查询') {
  try {
    return (await (await getDb()).select<any[]>(`SELECT t.* FROM trend_items t WHERE t.query_category = ? AND t.category_type = ? AND NOT EXISTS (SELECT 1 FROM decomposition_tree n WHERE n.trend_item_id = t.id) ORDER BY t.id DESC LIMIT 1`, [category, categoryType]))[0] || null;
  } catch {
    return getTrendItemByCategory(category, categoryType);
  }
}


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
  // 2026-08-16：自动洞察（autoInsight，source_type='auto'）的物料也出现在洞察列表，可点击查看详情
  return (await getDb()).select<any[]>(
    "SELECT * FROM trend_items WHERE source_type IN ('quick','auto') ORDER BY last_queried_at DESC, id DESC"
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



export function getMaterialInsightDeleteIds(subjects: Array<Pick<MaterialInsightSubject, 'key' | 'rootNodeId' | 'trendItemIds'>>) {
  return {
    rootNodeIds: [...new Set(subjects.map(subject => Number(subject.rootNodeId)).filter(id => Number.isFinite(id) && id > 0))],
    trendItemIds: [...new Set(subjects.flatMap(subject => subject.trendItemIds).map(Number).filter(id => Number.isFinite(id) && id > 0))],
    subjectKeys: [...new Set(subjects.map(subject => subject.key))],
  };
}

/** 洞察决策上下文：物料映射到哪些项目 BOM，以及当前金额/数量。 */
export async function getTrendProjectContext(trendItemId: number) {
  return (await getDb()).select<any[]>(`SELECT p.id AS part_id, p.name AS part_name, p.model AS part_model,
    pr.id AS project_id, pr.code AS project_code, pr.name AS project_name,
    pb.module_name, pb.quantity,
    CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END AS unit_cost,
    (CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END) * COALESCE(pb.quantity, 1) AS line_cost
    FROM trend_items ti
    JOIN parts p ON (
      EXISTS (SELECT 1 FROM trend_part_mapping tpm WHERE tpm.trend_item_id = ti.id AND tpm.part_id = p.id)
      OR lower(trim(p.name)) = lower(trim(ti.query_category))
      OR lower(trim(p.model)) = lower(trim(ti.query_category))
    )
    JOIN project_boms pb ON pb.part_id = p.id AND COALESCE(pb.is_deleted, 0) = 0
    JOIN projects pr ON pr.id = pb.project_id AND COALESCE(pr.is_deleted, 0) = 0
    WHERE ti.id = ?
    ORDER BY pr.code, pb.module_name, p.name`, [trendItemId]);
}

export async function deleteTrendItem(id: number) {
  await invoke('delete_material_insight_subjects', { request: { rootNodeIds: [], trendItemIds: [id], subjectKeys: [] } });
}

export async function deleteMaterialInsightSubjects(subjects: Array<Pick<MaterialInsightSubject, 'key' | 'rootNodeId' | 'trendItemIds'>>) {
  const plan = getMaterialInsightDeleteIds(subjects);
  await invoke('delete_material_insight_subjects', { request: {
    rootNodeIds: plan.rootNodeIds,
    trendItemIds: plan.trendItemIds,
    subjectKeys: plan.subjectKeys,
  } });
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
  const resultJson = typeof data.result_json === 'string'
    ? data.result_json
    : JSON.stringify(data.result ?? {});
  const r = await d.execute(
    'INSERT INTO trend_snapshots (trend_item_id, query_time, source_type, direction, confidence, confidence_level, summary, suggested_action, skill_used, magnitude_min, magnitude_max, magnitude_reference, result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [data.trend_item_id, data.query_time ?? localNow(), data.source_type || 'direct_query', data.direction, confidenceLevel, confidenceLevel, data.summary, data.suggested_action, data.skill_used, data.magnitude_min, data.magnitude_max, data.magnitude_reference, resultJson]
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
    'INSERT INTO rollup_contributions (parent_snapshot_id, child_component_id, cost_ratio_used, direction_used) VALUES (?,?,?,?)',
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
