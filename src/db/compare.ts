// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';



// ==================== 器件报价比对：别名沉淀 + 识别缓存 ====================
// 名称归一化：trim + 全角→半角 + 小写 + 去空格/下划线/横线/斜杠（"DRV-100" = "DRV 100"）
export function normalizePartName(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s_\-/\\]+/g, '');
}


// 别名记录：module_name 作用域（空=全局）；source: user_confirmed=确认同一 / marked_different=标记不同（否定）
export async function getPartAliases(moduleName?: string) {
  const d = await getDb();
  if (moduleName) return d.select<any[]>('SELECT * FROM part_aliases WHERE module_name = ? OR module_name = \'\'', [moduleName]);
  return d.select<any[]>('SELECT * FROM part_aliases');
}


export async function savePartAlias(data: any) {
  // 去重：同模块 + 同别名名/型号 + 同来源已存在则跳过（确认组内多行同名时只沉淀一条）
  const d0 = await getDb();
  const dup = await d0.select<any[]>('SELECT id FROM part_aliases WHERE module_name = ? AND alias_name = ? AND alias_model = ? AND source = ? LIMIT 1',
    [data.module_name || '', data.alias_name, data.alias_model || '', data.source || 'user_confirmed']);
  if (dup?.[0]) return;
  await (await getDb()).execute('INSERT INTO part_aliases (module_name, alias_name, alias_model, canonical_name, canonical_model, main_category, sub_category, source) VALUES (?,?,?,?,?,?,?,?)',
    [data.module_name || '', data.alias_name, data.alias_model || '', data.canonical_name, data.canonical_model || '', data.main_category || '', data.sub_category || '', data.source || 'user_confirmed']);
}


export async function deletePartAlias(id: number) { await (await getDb()).execute('DELETE FROM part_aliases WHERE id = ?', [id]); }


// 识别缓存：按 品类+模块 唯一，指纹相同不重复识别
export async function getCompareCache(category: string, moduleName: string) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM part_compare_cache WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  return r[0] || null;
}


export async function saveCompareCache(category: string, moduleName: string, fingerprint: string, resultJson: string) {
  const d = await getDb();
  await d.execute('DELETE FROM part_compare_cache WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  await d.execute('INSERT INTO part_compare_cache (category, module_name, fingerprint, result_json, identified_at) VALUES (?,?,?,?,datetime(\'now\',\'localtime\'))',
    [category || '', moduleName, fingerprint, resultJson]);
}


// 差异情报（后台自动识别产生，未读提醒）
// ⚠️ 2026-08-17 重构（修复数据混乱）：原实现内容变化 DELETE+INSERT 整行 → handled_json（已处理记录）被清空、已处理模块被重置 unread
// 新规则：UPDATE 保留行（handled_json 不丢）；仅当出现【新组】才重置 unread（用户处理导致的组消失/变化不打扰）；无异常（空情报）不创建记录
function parseGroupNames(json: string): string[] {
  try { return (JSON.parse(json || '[]') || []).map((g: any) => String(g?.name || '')); } catch { return []; }
}
function hasNewGroups(oldJson: string, newJson: string): boolean {
  const oldSet = new Set(parseGroupNames(oldJson));
  return parseGroupNames(newJson).some(n => n && !oldSet.has(n));
}
export async function upsertInsight(category: string, moduleName: string, insightJson: string) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT * FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  if (old[0]) {
    if (old[0].insight_json === insightJson) return;
    // 出现新组（数据变化导致的新情报）→ unread；否则（用户处理/归档导致的变化）保持原状态
    const newStatus = hasNewGroups(old[0].insight_json, insightJson) ? 'unread' : old[0].status;
    await d.execute("UPDATE part_insights SET insight_json = ?, status = ?, updated_at = datetime('now','localtime') WHERE id = ?", [insightJson, newStatus, old[0].id]);
    return;
  }
  // 无异常（空情报）不创建记录——避免"已核对"空模块占住待处理
  let arr: any[] = [];
  try { arr = JSON.parse(insightJson || '[]'); } catch { arr = []; }
  if (arr.length === 0) return;
  await d.execute("INSERT INTO part_insights (category, module_name, insight_json, status) VALUES (?,?,?,'unread')", [category || '', moduleName, insightJson]);
}

// 历史脏数据一次性清理（2026-08-17）：无待处理组（已核对/已处理完）的模块不应停在待处理——统一归档为已读
export async function cleanupInsightStatus() {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT * FROM part_insights');
  for (const r of rows) {
    let data: any[] = [];
    try { data = JSON.parse(r.insight_json || '[]'); } catch { data = []; }
    if (data.length === 0 && r.status === 'unread') {
      await d.execute("UPDATE part_insights SET status = 'read' WHERE id = ?", [r.id]);
    }
  }
}


// ===== 已处理记录（确认/标记快照，供查看与撤销） =====
export async function appendHandledInsight(category: string, moduleName: string, item: any): Promise<number> {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT handled_json FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  let arr: any[] = [];
  try { arr = JSON.parse(rows?.[0]?.handled_json || '[]'); } catch { arr = []; }
  arr.push(item);
  await d.execute('UPDATE part_insights SET handled_json = ? WHERE category = ? AND module_name = ?', [JSON.stringify(arr), category || '', moduleName]);
  return arr.length - 1; // 新记录索引（撤销用）
}
export async function removeHandledInsight(category: string, moduleName: string, index: number) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT handled_json FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  let arr: any[] = [];
  try { arr = JSON.parse(rows?.[0]?.handled_json || '[]'); } catch { arr = []; }
  arr.splice(index, 1);
  await d.execute('UPDATE part_insights SET handled_json = ? WHERE category = ? AND module_name = ?', [JSON.stringify(arr), category || '', moduleName]);
}
// 精确删除别名（撤销确认/标记用）
export async function deletePartAliasExact(moduleName: string, aliasName: string, aliasModel: string, source: string) {
  const d = await getDb();
  await d.execute('DELETE FROM part_aliases WHERE module_name = ? AND alias_name = ? AND alias_model = ? AND source = ?', [moduleName || '', aliasName, aliasModel || '', source]);
}

export async function getInsights() {
  return (await getDb()).select<any[]>('SELECT * FROM part_insights ORDER BY created_at DESC');
}


export async function getUnreadInsightCount() {
  const r = await (await getDb()).select<any[]>("SELECT COUNT(*) as c FROM part_insights WHERE status = 'unread'");
  return r[0]?.c || 0;
}


export async function markInsightUnread(category: string, moduleName: string) {
  const d = await getDb();
  await d.execute("UPDATE part_insights SET status = 'unread' WHERE category = ? AND module_name = ?", [category || '', moduleName]);
}

export async function markInsightRead(category: string, moduleName: string) {
  await (await getDb()).execute("UPDATE part_insights SET status = 'read' WHERE category = ? AND module_name = ?", [category || '', moduleName]);
}