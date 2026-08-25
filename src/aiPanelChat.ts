// 右侧 AI 互动窗 · 会话持久化（v2.3.19，2026-08-18 用户：功能页右侧放 AI 互动窗，替代独立本地 AI 助手页）
// 仅会话存取（local_ai_sessions / local_ai_messages）；对话引擎复用 thinkEngine.runThinkLoop（文本协议+全部工具）
import { getDb } from './db';

export interface ChatMessage { id?: number; role: 'user' | 'assistant'; content: string; reasoning?: string; created_at?: string; }
export interface Session { id: number; title: string; updated_at: string; }

export async function loadSessions(): Promise<Session[]> {
  return (await getDb()).select<Session[]>("SELECT * FROM local_ai_sessions ORDER BY updated_at DESC LIMIT 60");
}
export async function newSession(title: string): Promise<number> {
  const r = await (await getDb()).execute("INSERT INTO local_ai_sessions (title) VALUES (?)", [title]);
  return r.lastInsertId!;
}
export async function deleteSession(id: number) {
  const db = await getDb();
  await db.execute("DELETE FROM local_ai_messages WHERE session_id=?", [id]);
  await db.execute("DELETE FROM local_ai_sessions WHERE id=?", [id]);
}
export async function loadMessages(sessionId: number): Promise<ChatMessage[]> {
  return (await getDb()).select<ChatMessage[]>("SELECT * FROM local_ai_messages WHERE session_id=? ORDER BY id", [sessionId]);
}
export async function saveMsg(sessionId: number, role: string, content: string, reasoning = '') {
  const db = await getDb();
  await db.execute("INSERT INTO local_ai_messages (session_id,role,content,reasoning) VALUES (?,?,?,?)", [sessionId, role, content, reasoning]);
  await db.execute("UPDATE local_ai_sessions SET updated_at=datetime('now','localtime') WHERE id=?", [sessionId]);
}
