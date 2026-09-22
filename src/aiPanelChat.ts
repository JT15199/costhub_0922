// 右侧 AI 互动窗 · 会话持久化（v2.3.19，2026-08-18 用户：功能页右侧放 AI 互动窗，替代独立本地 AI 助手页）
// 仅会话存取（local_ai_sessions / local_ai_messages）；对话引擎复用 thinkEngine.runThinkLoop（文本协议+全部工具）
import { getDb } from './db';

export interface ChatMessage { id?: number; role: 'user' | 'assistant'; content: string; reasoning?: string; artifacts_json?: string; created_at?: string; }
export interface Session { id: number; title: string; updated_at: string; pi_state_json?: string; }

let agentTablesReady: Promise<void> | undefined;
async function ensureAgentTables() {
  if (!agentTablesReady) agentTablesReady = (async () => {
    const db = await getDb();
    await db.execute(`CREATE TABLE IF NOT EXISTS local_ai_session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, run_id TEXT DEFAULT '', seq INTEGER NOT NULL DEFAULT 0, event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now','localtime')))`);
    await db.execute('CREATE INDEX IF NOT EXISTS idx_local_ai_session_events_session ON local_ai_session_events(session_id, id)');
    await db.execute(`CREATE TABLE IF NOT EXISTS local_ai_action_ledger (action_id TEXT PRIMARY KEY, session_id INTEGER NOT NULL, run_id TEXT DEFAULT '', tool_id TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, result_json TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  })();
  return agentTablesReady;
}

export type PiActionStatus = 'prepared' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface PiAction { action_id: string; session_id: number; run_id: string; tool_id: string; args_json: string; status: PiActionStatus; result_json: string; }

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
  await ensureAgentTables();
  await db.execute("DELETE FROM local_ai_session_events WHERE session_id=?", [id]);
  await db.execute("DELETE FROM local_ai_action_ledger WHERE session_id=?", [id]);
  await db.execute("DELETE FROM local_ai_sessions WHERE id=?", [id]);
}
export async function loadMessages(sessionId: number): Promise<ChatMessage[]> {
  return (await getDb()).select<ChatMessage[]>("SELECT * FROM local_ai_messages WHERE session_id=? ORDER BY id", [sessionId]);
}
export async function saveMsg(sessionId: number, role: string, content: string, reasoning = '', artifacts: unknown[] = []) {
  const db = await getDb();
  await db.execute("INSERT INTO local_ai_messages (session_id,role,content,reasoning,artifacts_json) VALUES (?,?,?,?,?)", [sessionId, role, content, reasoning, JSON.stringify(artifacts)]);
  await db.execute("UPDATE local_ai_sessions SET updated_at=datetime('now','localtime') WHERE id=?", [sessionId]);
}

export async function savePiState(sessionId: number, state: string) {
  JSON.parse(state); // Never persist a truncated or invalid recovery record.
  await (await getDb()).execute("UPDATE local_ai_sessions SET pi_state_json=?, updated_at=datetime('now','localtime') WHERE id=?", [state, sessionId]);
}

export async function appendPiEvent(sessionId: number, eventId: string, runId: string, seq: number, eventType: string, payload: unknown) {
  await ensureAgentTables();
  const db = await getDb();
  await db.execute('INSERT OR IGNORE INTO local_ai_session_events (session_id,event_id,run_id,seq,event_type,payload_json) VALUES (?,?,?,?,?,?)', [sessionId, eventId, runId, seq, eventType, JSON.stringify(payload ?? {})]);
  return (await db.select<{ id: number }[]>('SELECT id FROM local_ai_session_events WHERE event_id=?', [eventId]))[0];
}

/** Append the complete Pi message before any later context compaction can replace it. */
export async function appendPiMessage(sessionId: number, runId: string, seq: number, message: unknown) {
  return appendPiEvent(sessionId, `${runId}:message:${seq}`, runId, seq, 'message_raw', { message });
}

export async function loadPiEvents(sessionId: number, limit = 500) {
  await ensureAgentTables();
  return (await getDb()).select<any[]>('SELECT * FROM local_ai_session_events WHERE session_id=? ORDER BY id DESC LIMIT ?', [sessionId, Math.max(1, Math.min(limit, 5000))]);
}

/** Gateway 回放只读取轨迹与 checkpoint，并按游标分页，避免长会话被固定窗口截断。 */
export async function loadGatewayTraceEvents(sessionId: number, runId = '', beforeId?: number, limit = 200) {
  await ensureAgentTables();
  const params: unknown[] = [sessionId];
  let where = "session_id=? AND (event_type LIKE 'gateway_%' OR event_type='checkpoint')";
  if (runId) { where += ' AND run_id=?'; params.push(runId); }
  if (beforeId != null) { where += ' AND id<?'; params.push(beforeId); }
  params.push(Math.max(1, Math.min(limit, 500)));
  return (await getDb()).select<any[]>(`SELECT * FROM local_ai_session_events WHERE ${where} ORDER BY id DESC LIMIT ?`, params);
}

// ponytail: scan one session's raw messages; add a payload-id index only if history size makes this measurable.
export async function loadPiSourceMessages(sessionId: number, sourceId: string) {
  await ensureAgentTables();
  const rows = await (await getDb()).select<any[]>('SELECT payload_json FROM local_ai_session_events WHERE session_id=? AND event_type=? ORDER BY id', [sessionId, 'message_raw']);
  return rows.flatMap(row => {
    try {
      const message = JSON.parse(row.payload_json || '{}')?.message;
      return message && typeof message === 'object' && String(message.id || '') === sourceId ? [message] : [];
    } catch { return []; }
  });
}

export async function preparePiAction(actionId: string, sessionId: number, runId: string, toolId: string, args: unknown): Promise<PiAction | null> {
  await ensureAgentTables();
  const db = await getDb();
  await db.execute('INSERT OR IGNORE INTO local_ai_action_ledger (action_id,session_id,run_id,tool_id,args_json,status) VALUES (?,?,?,?,?,?)', [actionId, sessionId, runId, toolId, JSON.stringify(args ?? {}), 'prepared']);
  const rows = await db.select<PiAction[]>('SELECT * FROM local_ai_action_ledger WHERE action_id=?', [actionId]);
  return rows[0] || null;
}

export async function updatePiAction(actionId: string, status: PiActionStatus, result: unknown = '') {
  await ensureAgentTables();
  await (await getDb()).execute("UPDATE local_ai_action_ledger SET status=?, result_json=?, updated_at=datetime('now','localtime') WHERE action_id=?", [status, JSON.stringify(result ?? ''), actionId]);
}

export async function getPiAction(actionId: string): Promise<PiAction | null> {
  await ensureAgentTables();
  const rows = await (await getDb()).select<PiAction[]>('SELECT * FROM local_ai_action_ledger WHERE action_id=?', [actionId]);
  return rows[0] || null;
}

export async function getUnfinishedPiActions(sessionId: number): Promise<PiAction[]> {
  await ensureAgentTables();
  return (await (await getDb()).select<PiAction[]>('SELECT * FROM local_ai_action_ledger WHERE session_id=? AND status IN (\'prepared\',\'executing\',\'unknown\') ORDER BY created_at', [sessionId]));
}

/** 搜索会话：按消息内容/标题关键词匹配（2026-08-19 用户：会话可搜索） */
export async function searchSessions(keyword: string): Promise<Session[]> {
  const k = String(keyword || '').trim();
  if (!k) return loadSessions();
  const d = await getDb();
  return d.select<Session[]>('SELECT DISTINCT s.* FROM local_ai_sessions s JOIN local_ai_messages m ON m.session_id = s.id WHERE m.content LIKE ? OR s.title LIKE ? ORDER BY s.updated_at DESC LIMIT 30', ['%' + k + '%', '%' + k + '%']);
}

const stateMessageText = (message: any) => Array.isArray(message?.content)
  ? message.content.map((part: any) => part?.text ?? part?.thinking ?? (part?.type === 'toolCall' ? `[tool:${part.name}] ${JSON.stringify(part.arguments || {})}` : '')).join('')
  : String(message?.content ?? '');

/** Search only the active session's durable chat, Pi state and event ledger. */
export async function searchSessionHistory(sessionId: number, keyword: string, limit = 8) {
  const query = String(keyword || '').trim();
  if (!query) return { sessionId, matches: [] };
  const db = await getDb();
  const max = Math.max(1, Math.min(Number(limit) || 8, 20));
  const needle = query.toLocaleLowerCase();
  const matches: any[] = [];
  const messages = await db.select<any[]>('SELECT id, role, content, created_at FROM local_ai_messages WHERE session_id=? ORDER BY id', [sessionId]);
  for (const row of messages) {
    if (String(row.content || '').toLocaleLowerCase().includes(needle)) {
      matches.push({ reference: `message:${row.id}`, role: row.role, createdAt: row.created_at, preview: String(row.content || '').slice(0, 600) });
      if (matches.length >= max) return { sessionId, matches };
    }
  }
  const session = (await db.select<any[]>('SELECT pi_state_json FROM local_ai_sessions WHERE id=?', [sessionId]))[0];
  try {
    const state = JSON.parse(String(session?.pi_state_json || '{}'));
    for (let index = 0; index < (Array.isArray(state.messages) ? state.messages.length : 0); index++) {
      const preview = stateMessageText(state.messages[index]);
      if (preview.toLocaleLowerCase().includes(needle)) {
        matches.push({ reference: `state:${index}`, role: state.messages[index]?.role, preview: preview.slice(0, 600) });
        if (matches.length >= max) return { sessionId, matches };
      }
    }
  } catch { /* damaged recovery state is reported by the regular resume path */ }
  await ensureAgentTables();
  const events = await db.select<any[]>('SELECT id, event_type, payload_json, created_at FROM local_ai_session_events WHERE session_id=? ORDER BY id', [sessionId]);
  for (const row of events) {
    const preview = String(row.payload_json || '');
    if (preview.toLocaleLowerCase().includes(needle)) {
      matches.push({ reference: `event:${row.id}`, eventType: row.event_type, createdAt: row.created_at, preview: preview.slice(0, 600) });
      if (matches.length >= max) break;
    }
  }
  return { sessionId, matches };
}

/**
 * 读取 searchSessionHistory 返回的一条证据引用（限定在当前会话内）。
 *
 * ⚠️ 2026-09-21（子代理实测：本地模型在「证据引用格式无效」上**反复重试到没有结论**）：
 * 旧实现只认严格写法 `message:<id>` / `event:<id>` / `state:<index>`，9B 模型写成
 * `证据1` / `msg:12` / `消息 12` / 裸数字 `12` 就被判无效，于是它换一种写法再试、再被判无效……
 * 把整轮预算烧光也拿不出结论。现在：
 *   ① 宽容解析常见变体（裸数字 / msg / message / event / state / 中文「消息/事件/状态」/ 带 # 或空格）
 *   ② 真解析不出来时，返回**可照抄的正确示例**，而不是一句"格式无效"让模型继续猜
 */
export async function readSessionEvidence(sessionId: number, reference: string) {
  const raw = String(reference || '').trim();
  const parsed = parseEvidenceReference(raw);
  if (!parsed) {
    const samples = await sampleEvidenceReferences(sessionId);
    return {
      ok: false,
      error: `证据引用「${raw}」无法识别。正确写法只有三种：message:<消息id>、event:<事件id>、state:<序号>（例如 ${samples.length ? samples.join('、') : 'message:1'}）。`
        + '请直接照抄 search_history 返回结果里的 reference 字段；若已经拿不到有效引用，就基于当前已有信息直接作答，不要再尝试新的引用写法。',
      validExamples: samples,
    };
  }
  const { kind, id } = parsed;
  const db = await getDb();
  if (kind === 'message') {
    const row = (await db.select<any[]>('SELECT id, role, content, reasoning, artifacts_json, created_at FROM local_ai_messages WHERE session_id=? AND id=?', [sessionId, id]))[0];
    return row ? { ok: true, reference: `message:${id}`, row } : { ok: false, error: '当前会话找不到该消息证据' };
  }
  if (kind === 'event') {
    await ensureAgentTables();
    const row = (await db.select<any[]>('SELECT id, event_type, payload_json, created_at FROM local_ai_session_events WHERE session_id=? AND id=?', [sessionId, id]))[0];
    return row ? { ok: true, reference: `event:${id}`, row } : { ok: false, error: '当前会话找不到该事件证据' };
  }
  const session = (await db.select<any[]>('SELECT pi_state_json FROM local_ai_sessions WHERE id=?', [sessionId]))[0];
  try {
    const state = JSON.parse(String(session?.pi_state_json || '{}'));
    const row = Array.isArray(state.messages) ? state.messages[id] : undefined;
    return row ? { ok: true, reference: `state:${id}`, row } : { ok: false, error: '当前会话找不到该状态证据' };
  } catch { return { ok: false, error: '当前会话恢复状态损坏，无法读取证据' }; }
}

/**
 * 宽容解析证据引用：把本地模型常写的变体统一成 `{kind,id}`。
 * 认得的写法：`message:12` / `msg:12` / `消息 12` / `事件:3` / `状态 2` / `#12` / 裸数字 `12`（裸数字按 message 解析）。
 */
export function parseEvidenceReference(reference: string): { kind: 'message' | 'event' | 'state'; id: number } | null {
  const raw = String(reference || '').trim();
  if (!raw) return null;
  const explicit = /^(message|msg|消息|event|事件|state|状态)\s*[:：#\-\s]\s*(\d+)$/i.exec(raw);
  if (explicit) {
    const label = explicit[1].toLowerCase();
    const id = Number(explicit[2]);
    if (!Number.isSafeInteger(id) || id < 0) return null;
    if (label === 'event' || label === '事件') return { kind: 'event', id };
    if (label === 'state' || label === '状态') return { kind: 'state', id };
    return { kind: 'message', id };
  }
  // 裸数字 / #12：按消息解析（模型最常这么写）
  const bare = /^[#＃]?\s*(\d+)$/.exec(raw);
  if (bare) {
    const id = Number(bare[1]);
    return Number.isSafeInteger(id) && id >= 0 ? { kind: 'message', id } : null;
  }
  return null;
}

/** 给出几条真实可照抄的引用示例，避免模型在"格式无效"上反复试错。 */
async function sampleEvidenceReferences(sessionId: number): Promise<string[]> {
  const samples: string[] = [];
  try {
    const db = await getDb();
    const messages = await db.select<any[]>('SELECT id FROM local_ai_messages WHERE session_id=? ORDER BY id DESC LIMIT 2', [sessionId]);
    for (const row of messages) samples.push(`message:${row.id}`);
    const events = await db.select<any[]>('SELECT id FROM local_ai_session_events WHERE session_id=? ORDER BY id DESC LIMIT 1', [sessionId]);
    for (const row of events) samples.push(`event:${row.id}`);
  } catch { /* 取不到示例不影响主流程 */ }
  return samples;
}
