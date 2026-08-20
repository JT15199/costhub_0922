// AI 长期记忆（harness 阶段②，2026-08-18）：跨会话记住 事实/结论/用户处理结果
// 新对话概览自动注入最近记忆，避免重复分析同一话题（"上次分析过 X，结论 Y"）
import { getDb } from './core';

let memEnsured = false;
async function ensureMemoryTable() {
  if (memEnsured) return;
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS ai_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mem_key TEXT NOT NULL UNIQUE,
      kind TEXT DEFAULT 'fact',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT ''
    )`);
  } catch { /* 已存在则忽略 */ }
  memEnsured = true;
}

// 写入/更新记忆（同 key 覆盖，updated_at 刷新）
export async function setMemory(memKey: string, text: string, kind = 'fact'): Promise<void> {
  await ensureMemoryTable();
  const d = await getDb();
  try {
    await d.execute(`INSERT INTO ai_memory (mem_key, kind, text, updated_at) VALUES (?,?,?,datetime('now','localtime'))
      ON CONFLICT(mem_key) DO UPDATE SET text=excluded.text, kind=excluded.kind, updated_at=datetime('now','localtime')`, [memKey, kind, text]);
  } catch { /* 忽略 */ }
}

// 生成注入上下文的记忆摘要（最近 N 条）
export async function getMemoryContext(limit = 6): Promise<string> {
  await ensureMemoryTable();
  try {
    const rows = await (await getDb()).select<any[]>('SELECT kind, text FROM ai_memory ORDER BY updated_at DESC, id DESC LIMIT ?', [limit]);
    if (!rows || rows.length === 0) return '';
    return rows.map(r => '- [' + (r.kind === 'conclusion' ? '此前结论' : r.kind === 'user_action' ? '用户处理' : '记忆') + '] ' + String(r.text || '').slice(0, 140)).join('\n');
  } catch { return ''; }
}

export async function clearMemory(): Promise<void> {
  await ensureMemoryTable();
  try { await (await getDb()).execute('DELETE FROM ai_memory'); } catch { /* 忽略 */ }
}
