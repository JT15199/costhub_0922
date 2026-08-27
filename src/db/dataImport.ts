// AI 数据工程导入层（v2.3.19，2026-08-18 用户：丢 BOM/报价表，AI 拆解后自动入库）
// 设计：AI 解析文件 → 传结构化条目 → 本层做 校验/去重/匹配 后写库 → 返回统计报告
// 安全：只写用户自己的库；器件去重=名称+型号完全相等才复用（铁律）；不覆盖用户手工编辑
import { getDb } from './core';

export interface BomImportItem { name: string; model?: string; quantity?: number; cost?: number; module?: string; mainCat?: string; sub?: string; remark?: string; }

/** BOM 拆解入库：器件去重（name+model 完全相等复用已有 parts）→ 写 parts + project_boms */
export async function importProjectBom(projectId: number, items: BomImportItem[]) {
  const d = await getDb();
  const stats: any = { total: items.length, created: 0, reused: 0, skipped: 0, byModule: {} };
  for (const it of items) {
    const name = String(it.name || '').trim();
    const model = String(it.model || '').trim();
    const qty = Math.max(1, Number(it.quantity) || 1);
    const cost = Number(it.cost) || 0;
    if (!name) { stats.skipped++; continue; }
    const part = (await d.select<any[]>('SELECT id FROM parts WHERE name = ? AND model = ? LIMIT 1', [name, model]))[0];
    let partId: number;
    if (part) { partId = part.id; stats.reused++; }
    else {
      const r = await d.execute('INSERT INTO parts (main_category, sub_category, category, name, model, cost, specs, projects, remark) VALUES (?,?,?,?,?,?,?,?,?)',
        [it.mainCat || '硬件类', it.sub || '', it.mainCat || '硬件类', name, model, cost, '', '', it.remark || '']);
      partId = Number(r.lastInsertId) || 0; stats.created++;
    }
    const ex = await d.select<any[]>('SELECT id FROM project_boms WHERE project_id=? AND part_id=? AND COALESCE(is_deleted,0)=0', [projectId, partId]);
    if (ex.length) { stats.skipped++; continue; }
    const module = it.module || '未归类';
    await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, part_name, part_model, part_cost, main_category, sub_category) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [projectId, partId, module, qty, it.remark || '', name, model, cost, it.mainCat || '硬件类', it.sub || '']);
    stats.byModule[module] = (stats.byModule[module] || 0) + 1;
  }
  return stats;
}

/** 供应商报价入库：按 name+model 匹配已有器件 → part_suppliers（未匹配的返回，提示先入器件库） */
export async function importSupplierQuotes(rows: { name: string; model?: string; supplier: string; price: number; share?: number; remark?: string }[]) {
  const d = await getDb();
  const stats: any = { total: rows.length, matched: 0, unmatched: 0, added: 0, unmatchedNames: [] };
  for (const r of rows) {
    const name = String(r.name || '').trim(); const model = String(r.model || '').trim();
    if (!name) { stats.unmatched++; continue; }
    const part = (await d.select<any[]>('SELECT id FROM parts WHERE name = ? AND model = ? LIMIT 1', [name, model]))[0];
    if (!part) { stats.unmatched++; stats.unmatchedNames.push(name + (model ? '(' + model + ')' : '')); continue; }
    stats.matched++;
    await d.execute('INSERT INTO part_suppliers (part_id, supplier_name, price, share_ratio, is_active, remark) VALUES (?,?,?,?,?,?)',
      [part.id, String(r.supplier || '').trim() || '未命名供应商', Number(r.price) || 0, Number(r.share) || 0, 1, r.remark || '']);
    stats.added++;
  }
  // 更新受影响器件的加权成本（同 addPartSupplier 行为）
  try {
    const { updatePartWeightedCost } = await import('./parts');
    const matchedPartIds = rows.map(r => String(r.name || '').trim()).filter(Boolean);
    const parts = await d.select<any[]>("SELECT id FROM parts WHERE name IN ('" + matchedPartIds.join("','") + "')");
    for (const p of parts) { try { await updatePartWeightedCost(p.id); } catch { } }
  } catch { }
  return stats;
}

/** 竞品 BOM 入库 */
export async function importCompetitorBom(competitorId: number, rows: { name: string; model?: string; cost: number; quantity?: number; module?: string }[]) {
  const d = await getDb();
  let added = 0;
  for (const r of rows) {
    const name = String(r.name || '').trim(); if (!name) continue;
    await d.execute('INSERT INTO competitor_boms (competitor_id, part_name, part_model, estimated_cost, quantity, module_name) VALUES (?,?,?,?,?,?)',
      [competitorId, name, String(r.model || ''), Number(r.cost) || 0, Number(r.quantity) || 1, r.module || '未归类']);
    added++;
  }
  return { total: rows.length, added };
}

/** 原声批量导入（content+product 去重） */
export async function importVoiceItems(product: string, contents: string[]) {
  const d = await getDb();
  let added = 0, dup = 0;
  for (const c of contents) {
    const content = String(c || '').trim(); if (!content) continue;
    const ex = await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item WHERE content = ? AND product = ?', [content, product]);
    if ((ex[0]?.c || 0) > 0) { dup++; continue; }
    await d.execute('INSERT INTO voice_item (content, source, product) VALUES (?,?,?)', [content, 'ai_import', product]);
    added++;
  }
  return { total: contents.length, added, dup };
}


// ===== 写操作审计（2026-08-19 用户：防止工具乱改数据库——每次 AI 写入留痕可追溯） =====
let auditEnsured = false;
async function ensureAuditTable() {
  if (auditEnsured) return;
  try {
    await (await getDb()).execute(`CREATE TABLE IF NOT EXISTS write_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id TEXT NOT NULL,
      args_summary TEXT DEFAULT '',
      result_summary TEXT DEFAULT '',
      source TEXT DEFAULT 'ai_panel',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  auditEnsured = true;
}
export async function logWriteAudit(toolId: string, argsSummary: string, resultSummary: string) {
  try {
    await ensureAuditTable();
    await (await getDb()).execute('INSERT INTO write_audit_logs (tool_id, args_summary, result_summary) VALUES (?,?,?)',
      [toolId, String(argsSummary || '').slice(0, 500), String(resultSummary || '').slice(0, 1000)]);
  } catch { /* 审计失败不影响主流程 */ }
}
export async function getWriteAuditLogs(limit = 20): Promise<any[]> {
  try { await ensureAuditTable(); return (await getDb()).select<any[]>('SELECT * FROM write_audit_logs ORDER BY id DESC LIMIT ?', [limit]); } catch { return []; }
}
