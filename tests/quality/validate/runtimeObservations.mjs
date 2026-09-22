// Agent Runtime Stage 3.5 — 观测探针
//
// 只做读取，不驱动应用。两条独立通道：
//   1) `window.__costhubRuntimeEvents`：开发构建下 RuntimeEvent 的旁路记录（顺序证据）
//   2) `local_ai_session_events`：应用自己持久化的会话事件（含 seq 与 run_id）
//
// 为什么两条都要：
//   记录器能给出**Runtime 事件**顺序（budget/privacy/route/tool_start…），
//   而持久化表给出**底层网关事件**（gateway_*）—— 后者正是判断"是否重复投递"的地方。
//   任一条单独都不足以证明链路正确。

import { createRequire } from 'node:module';
import path from 'node:path';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

/**
 * 打开夹具库读取。
 *
 * 注意：**不能以 readOnly 打开**。应用运行时处于 WAL 模式，
 * 新写入的 schema 与新事件可能还只在 `-wal` 里；只读连接无法创建/读取
 * shm 索引，会看到"表不存在"或 0 行 —— 之前正是这样把一次成功的运行误判成"没跑"。
 * 这里只做 SELECT，不写任何数据。
 */
function openForRead(dbPath) {
  return new DatabaseSync(path.resolve(dbPath));
}

/**
 * 读开发构建的 RuntimeEvent 记录器。
 *
 * 只取所需字段：`events` 里可能含较长 detail，按类型裁剪后再回传，
 * 避免把大对象拖过 CDP。
 */
export async function readRuntimeRecorder(cdp) {
  const raw = await cdp.evaluateJson(`JSON.stringify((() => {
    const recorder = window.__costhubRuntimeEvents;
    if (!recorder) return { available: false, types: [], events: [], gatewayTypes: [] };
    return {
      available: true,
      types: recorder.types(),
      events: recorder.events.map(entry => ({ seq: entry.seq, type: entry.type, detail: entry.detail })),
      gatewayTypes: recorder.gatewayTypes(),
    };
  })())`);
  return raw && typeof raw === 'object'
    ? raw
    : { available: false, types: [], events: [], gatewayTypes: [] };
}

/**
 * 读取最近一轮运行的完成状态。
 *
 * 完成判定用应用自己写的 `run_finished` 事件 —— 它是 AiPanel 里写死的常量字符串，
 * 不依赖任何 UI 细节，因此比"看按钮有没有消失"稳。
 */
export async function readLastRun(dbPath) {
  let db;
  try {
    db = openForRead(dbPath);
  } catch {
    return null;
  }
  try {
    const row = db.prepare(
      "SELECT id, run_id, payload_json FROM local_ai_session_events WHERE event_type='run_finished' ORDER BY id DESC LIMIT 1",
    ).get();
    if (!row) return null;
    let finalText = '';
    try {
      finalText = String(JSON.parse(row.payload_json || '{}').finalText || '');
    } catch { /* 载荷损坏时只影响 finalText 断言 */ }
    return { lastEventId: Number(row.id), runId: String(row.run_id || ''), finished: true, finalText };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 读取会话事件（升序，便于看真实发生顺序）。 */
export async function readSessionEvents(dbPath, { limit = 400 } = {}) {
  let db;
  try {
    db = openForRead(dbPath);
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(
      'SELECT id, session_id, run_id, seq, event_type, payload_json FROM local_ai_session_events ORDER BY id DESC LIMIT ?',
    ).all(Math.max(1, Math.min(Number(limit) || 400, 5000)));
    return rows.reverse().map(row => ({
      id: Number(row.id),
      sessionId: Number(row.session_id),
      runId: String(row.run_id || ''),
      seq: Number(row.seq ?? 0),
      event_type: String(row.event_type || ''),
      payload: safeParse(row.payload_json),
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function safeParse(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}
