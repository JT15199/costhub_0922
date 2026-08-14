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
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { /* 已存在则忽略 */ }
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
  const old = await d.select<{ id: number; title: string; detail: string; status: string }[]>('SELECT id, title, detail, status FROM audit_findings');
  const key = (f: any) => f.type + '|' + f.title + '|' + f.detail;
  const newKeys = new Set(findings.map(key));
  // 已存在且内容相同 → 保持状态；内容变化 → 重置 unread
  const statusMap: Record<number, string> = {};
  old.forEach(o => {
    if (!newKeys.has(key(o))) statusMap[o.id] = 'dismissed';   // 不再发现 → 隐藏
    else if (o.status === 'unread') statusMap[o.id] = 'unread'; // 未读保持
    else statusMap[o.id] = o.status;                            // 已读保持
  });
  for (const o of old) {
    await d.execute('UPDATE audit_findings SET status = ? WHERE id = ?', [statusMap[o.id] ?? 'dismissed', o.id]);
  }
  // 新增
  let added = 0;
  for (const f of findings) {
    if (old.some(o => key(o) === key(f))) continue;
    await d.execute("INSERT INTO audit_findings (type, level, title, detail, objects, status, source, created_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))",
      [f.type, f.level, f.title, f.detail, f.objects || '[]', f.status || 'unread', f.source || 'rule']);
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
