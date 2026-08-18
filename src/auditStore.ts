// AI 自主巡检发现存储（v2.3.19）
// 独立模块：自己确保 audit_findings 表存在（幂等），不依赖 db 拆分生成文件
import { getDb } from './db/core';

export interface AuditFinding {
  id?: number;
  type: string;        // rule_xxx / ai_xxx
  level: 'danger' | 'warn' | 'info';
  title: string;
  detail: string;
  objects: string;     // 涉及对象（JSON 数组字符串：项目代号/器件名等）
  suggestion?: string; // 建议/思路（AI 或规则给出，机会点导向）
  status: 'unread' | 'read' | 'dismissed';
  source: 'rule' | 'ai';
  created_at?: string;
}

async function ensureAuditTable() {
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS audit_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT DEFAULT '',
      level TEXT DEFAULT 'info',
      title TEXT NOT NULL,
      detail TEXT DEFAULT '',
      objects TEXT DEFAULT '',
      status TEXT DEFAULT 'unread',
      source TEXT DEFAULT 'rule',
      suggestion TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { /* 已存在则忽略 */ }
    // 旧表补列（幂等）
    try { await d.execute("ALTER TABLE audit_findings ADD COLUMN suggestion TEXT DEFAULT ''"); } catch { /* 已有 */ }
}

export async function getAuditFindings(): Promise<AuditFinding[]> {
  await ensureAuditTable();
  return (await getDb()).select<AuditFinding[]>('SELECT * FROM audit_findings WHERE status != ? ORDER BY id DESC', ['dismissed']);
}

export async function getUnreadAuditCount(): Promise<number> {
  await ensureAuditTable();
  const r = await (await getDb()).select<{ c: number }[]>('SELECT COUNT(*) as c FROM audit_findings WHERE status = ?', ['unread']);
  return r[0]?.c || 0;
}

// 全量替换巡检结果（内容变化才更新，保持已读状态；与 part_insights 的 upsert 语义一致）
export async function replaceAuditFindings(findings: Omit<AuditFinding, 'id' | 'created_at'>[]): Promise<number> {
  await ensureAuditTable();
  const d = await getDb();
  // 陈旧已读自动归档（2026-08-18 用户反馈：反复是那几条）：已读超 7 天的发现不再长期挂着，自动隐藏
  try {
    await d.execute("UPDATE audit_findings SET status='dismissed' WHERE status='read' AND created_at < datetime('now','localtime','-7 days')");
  } catch { /* 忽略 */ }
  const old = await d.select<{ id: number; type: string; title: string; detail: string; objects: string; status: string }[]>('SELECT id, type, title, detail, objects, status FROM audit_findings');
  // 稳定键 = 类型 + 涉及对象（不含 title/detail 的动态数字）：
  // 已读/忽略的同源发现即使数字微变（如占比 89%→90%）也保持原状态，不重新弹出；
  // 只有"新类型/新对象"才作为新发现标 unread
  const stableKey = (f: any) => String(f.type || '') + '|' + String(f.objects || '[]');
  const newKeys = new Set(findings.map(stableKey));
  const statusMap: Record<number, string> = {};
  old.forEach(o => {
    if (!newKeys.has(stableKey(o))) statusMap[o.id] = 'dismissed'; // 不再发现 → 隐藏
    else statusMap[o.id] = o.status;                                // 同源发现 → 保持原状态（read/dismissed/unread 都不重置）
  });
  for (const o of old) {
    await d.execute('UPDATE audit_findings SET status = ? WHERE id = ?', [statusMap[o.id] ?? 'dismissed', o.id]);
  }
  // 同源但内容变化 → 更新 title/detail（状态保持，不打扰）
  for (const f of findings) {
    const match = old.find(o => stableKey(o) === stableKey(f));
    if (match && (match.title !== f.title || match.detail !== f.detail)) {
      await d.execute('UPDATE audit_findings SET title = ?, detail = ?, suggestion = ? WHERE id = ?',
        [f.title, f.detail, f.suggestion || '', match.id]);
    }
  }
  // 新增（稳定键不存在的）
  let added = 0;
  for (const f of findings) {
    if (old.some(o => stableKey(o) === stableKey(f))) continue;
    await d.execute("INSERT INTO audit_findings (type, level, title, detail, objects, status, source, suggestion, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))",
      [f.type, f.level, f.title, f.detail, f.objects || '[]', f.status || 'unread', f.source || 'rule', f.suggestion || '']);
    added++;
  }
  return added;
}

export async function markAuditRead(id: number) {
  await ensureAuditTable();
  await (await getDb()).execute('UPDATE audit_findings SET status = ? WHERE id = ?', ['read', id]);
}

export async function dismissAuditFinding(id: number) {
  await ensureAuditTable();
  await (await getDb()).execute('UPDATE audit_findings SET status = ? WHERE id = ?', ['dismissed', id]);
}

// 最近器件价格变动（驾驶舱"最近成本变动"汇总：用户自己输入的事实，不叫 AI）
export async function getRecentPartPriceChanges(limit = 8) {
  await ensureAuditTable();
  try {
    const rows = await (await getDb()).select<any[]>(
      `SELECT ph.id, ph.part_id, p.name, p.model, ph.old_cost, ph.new_cost, ph.changed_at
       FROM part_price_history ph JOIN parts p ON ph.part_id = p.id
       ORDER BY ph.changed_at DESC, ph.id DESC LIMIT ?`, [limit]);
    return rows;
  } catch { return []; }
}
