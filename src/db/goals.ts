// AI 目标/任务管理（v2.3.19 harness 化阶段①，2026-08-18）
// 用户下达目标 → 后台 autoThink 优先推进未完成目标（注入概览+结论回写进度）→ 完成自动关闭
// 运行时兜底建表（同 ai_think_logs 模式：模块级缓存标志，每次访问前确保）
import { getDb } from './core';

export interface AiGoal {
  id: number;
  text: string;
  status: 'active' | 'paused' | 'done';
  progress: string;
  linked_project: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
}

let goalsEnsured = false;
async function ensureGoalsTable() {
  if (goalsEnsured) return;
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS ai_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      progress TEXT DEFAULT '',
      linked_project TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT ''
    )`);
  } catch { /* 已存在则忽略 */ }
  goalsEnsured = true;
}

export async function getGoals(status?: string): Promise<AiGoal[]> {
  await ensureGoalsTable();
  const d = await getDb();
  let q = 'SELECT * FROM ai_goals';
  const p: any[] = [];
  if (status) { q += ' WHERE status = ?'; p.push(status); }
  q += ' ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'paused\' THEN 1 ELSE 2 END, id DESC';
  return (await d.select<AiGoal[]>(q, p)) || [];
}

export async function getActiveGoals(): Promise<AiGoal[]> {
  try { return await getGoals('active'); } catch { return []; }
}

export async function saveGoal(text: string, linkedProject = ''): Promise<number> {
  await ensureGoalsTable();
  const d = await getDb();
  const r = await d.execute(
    "INSERT INTO ai_goals (text, status, progress, linked_project, updated_at) VALUES (?, 'active', '', ?, datetime('now','localtime'))",
    [text, linkedProject]
  );
  return Number(r.lastInsertId) || 0;
}

export async function updateGoalStatus(id: number, status: 'active' | 'paused' | 'done'): Promise<void> {
  await ensureGoalsTable();
  const d = await getDb();
  await d.execute(
    "UPDATE ai_goals SET status = ?, updated_at = datetime('now','localtime'), completed_at = CASE WHEN ? = 'done' THEN datetime('now','localtime') ELSE '' END WHERE id = ?",
    [status, status, id]
  );
}

// 追加进度（每轮自主分析结论回写；保留最近 5 段，带时间戳）
export async function appendGoalProgress(id: number, entry: string): Promise<void> {
  await ensureGoalsTable();
  const d = await getDb();
  try {
    const rows = await d.select<{ progress: string }[]>('SELECT progress FROM ai_goals WHERE id = ?', [id]);
    const old = rows[0]?.progress || '';
    const ts = new Date().toLocaleString('zh-CN', { hour12: false }).slice(5);
    const parts = old ? old.split('\n').filter(Boolean).slice(-4) : [];
    parts.push('[' + ts + '] ' + entry.slice(0, 160));
    await d.execute("UPDATE ai_goals SET progress = ?, updated_at = datetime('now','localtime') WHERE id = ?", [parts.join('\n'), id]);
  } catch { /* 忽略 */ }
}

export async function deleteGoal(id: number): Promise<void> {
  await ensureGoalsTable();
  await (await getDb()).execute('DELETE FROM ai_goals WHERE id = ?', [id]);
}
