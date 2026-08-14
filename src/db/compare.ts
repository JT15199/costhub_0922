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
// 内容与上次相同 → 保持原状态（已读不被重置）；内容变化 → 重置 unread（新情报）
export async function upsertInsight(category: string, moduleName: string, insightJson: string) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT insight_json FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  if (old[0] && old[0].insight_json === insightJson) return;
  await d.execute('DELETE FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  await d.execute("INSERT INTO part_insights (category, module_name, insight_json, status) VALUES (?,?,?,'unread')", [category || '', moduleName, insightJson]);
}


export async function getInsights() {
  return (await getDb()).select<any[]>('SELECT * FROM part_insights ORDER BY created_at DESC');
}


export async function getUnreadInsightCount() {
  const r = await (await getDb()).select<any[]>("SELECT COUNT(*) as c FROM part_insights WHERE status = 'unread'");
  return r[0]?.c || 0;
}


export async function markInsightRead(category: string, moduleName: string) {
  await (await getDb()).execute("UPDATE part_insights SET status = 'read' WHERE category = ? AND module_name = ?", [category || '', moduleName]);
}