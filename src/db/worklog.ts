import { executeSqliteWrite, getDb } from './core';

export type WorkLogRecord = { id: number; log_date: string; title: string; content: string; category: string; tags: string; is_todo: number; done: number; project_id: number; work_project: string; stage: string; record_type: string; impact: string; next_action: string; evidence: string[]; importance: string; due_at: string; created_at?: string; updated_at?: string };
export const WORK_LOG_TYPES = ['work_progress', 'decision', 'risk', 'reflection', 'outcome', 'follow_up', 'cost_progress'] as const;
const parseArray = (value: unknown): string[] => { try { const v = JSON.parse(String(value || '[]')); return Array.isArray(v) ? v.map(String).filter(Boolean) : []; } catch { return []; } };
export function parseWorkLogEvidence(value: unknown): string[] { return parseArray(value); }
export function normalizeWorkLogRow(row: any): WorkLogRecord {
  const todo = Number(row?.is_todo) === 1;
  return { ...row, id: Number(row?.id || 0), project_id: Number(row?.project_id || 0), is_todo: todo ? 1 : 0, done: Number(row?.done) === 1 ? 1 : 0, work_project: String(row?.work_project || ''), stage: String(row?.stage || ''), record_type: WORK_LOG_TYPES.includes(row?.record_type) ? row.record_type : todo ? 'follow_up' : 'work_progress', impact: String(row?.impact || ''), next_action: String(row?.next_action || ''), evidence: parseArray(row?.evidence_json), importance: String(row?.importance || 'normal'), due_at: String(row?.due_at || '') };
}
export function buildSummaryPrompts(type: string, start: string, end: string, rows: WorkLogRecord[]) {
  const evidence = rows.map(r => `[记录#${r.id}] ${r.log_date || ''} ${r.work_project ? `【${r.work_project}】` : ''} ${r.stage ? `【${r.stage}】` : ''} ${r.title ? r.title + '：' : ''}${r.content}${r.impact ? ` | 影响：${r.impact}` : ''}${r.next_action ? ` | 下一步：${r.next_action}` : ''}`).join('\n');
  const labels: Record<string, string> = { period: '周期工作总结', week: '周报', month: '月报', project_review: '项目复盘', performance: '绩效总结', growth: '成长复盘' };
  const system = `你是 CostHub 工作手账总结助手。只允许使用用户提供的原始记录，不得补造数字、金额、日期、项目结论或不存在的事实。所有关键成果、判断、风险和待跟进后面标注对应的 [记录#ID]；资料不足时明确写“记录中未明确”。输出${labels[type] || '工作总结'}，使用正式、克制的中文。`;
  const user = `总结范围：${start} 至 ${end}\n总结类型：${labels[type] || type}\n原始记录：\n${evidence || '无记录'}\n\n请按总结类型组织内容，保留证据索引，不要虚构。`;
  return { system, user, sourceLogIds: rows.map(r => r.id) };
}

export async function getWorkLogs(category = '', keyword = '', startDate = '', endDate = '', workProject: string | number = ''): Promise<WorkLogRecord[]> {
  const d = await getDb(); let q = 'SELECT * FROM work_logs WHERE 1=1'; const p: any[] = [];
  if (category) { q += ' AND category=?'; p.push(category); }
  if (keyword) { q += ' AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)'; const k = `%${keyword}%`; p.push(k, k, k); }
  if (startDate) { q += ' AND date(log_date) >= ?'; p.push(startDate); }
  if (endDate) { q += ' AND date(log_date) <= ?'; p.push(endDate); }
  if (workProject) { q += typeof workProject === 'number' ? ' AND project_id=?' : workProject === '(无项目)' ? " AND (project_id IS NULL OR project_id=0)" : ' AND work_project=?'; if (workProject !== '(无项目)') p.push(workProject); }
  q += ' ORDER BY log_date DESC, id DESC'; return (await d.select<any[]>(q, p)).map(normalizeWorkLogRow);
}
export async function getWorkLogsGroupedByProject(startDate = '', endDate = '') { const rows = await getWorkLogs('', '', startDate, endDate); const grouped = new Map<string, number>(); rows.filter(r => !r.is_todo).forEach(r => grouped.set(r.work_project || '公共/其他', (grouped.get(r.work_project || '公共/其他') || 0) + 1)); return { projects: [...grouped].map(([work_project, cnt]) => ({ work_project, cnt })), total: rows.filter(r => !r.is_todo).length }; }
export async function getWorkLog(id: number) { const rows = await (await getDb()).select<any[]>('SELECT * FROM work_logs WHERE id=?', [id]); return rows[0] ? normalizeWorkLogRow(rows[0]) : null; }
export async function saveWorkLog(data: Partial<WorkLogRecord> & { content: string; id?: number; evidence_json?: string }) {
  const d = await getDb(); const isTodo = data.is_todo !== undefined ? (data.is_todo ? 1 : 0) : undefined; const recordType = data.record_type || (isTodo ? 'follow_up' : undefined);
  let projectId = Number(data.project_id || 0);
  const project = projectId ? (await d.select<any[]>('SELECT id, name FROM projects WHERE id=? LIMIT 1', [projectId]))[0] : data.project_id === undefined && data.work_project ? (await d.select<any[]>('SELECT id, name FROM projects WHERE name=? OR code=? LIMIT 1', [data.work_project, data.work_project]))[0] : null;
  projectId = Number(project?.id || projectId || 0);
  const values: Record<string, any> = { log_date: data.log_date, title: data.title, content: data.content, category: data.category, tags: data.tags, project_id: projectId, work_project: project?.name || data.work_project, stage: data.stage, is_todo: isTodo, done: data.done === undefined ? undefined : (data.done ? 1 : 0), record_type: recordType, impact: data.impact, next_action: data.next_action, evidence_json: data.evidence_json !== undefined ? data.evidence_json : data.evidence ? JSON.stringify(data.evidence) : undefined, importance: data.importance, due_at: data.due_at };
  if (data.id) { const sets = Object.entries(values).filter(([, v]) => v !== undefined).map(([k]) => `${k}=?`); const vals = Object.entries(values).filter(([, v]) => v !== undefined).map(([, v]) => v); if (sets.length) { sets.push("updated_at=datetime('now','localtime')"); vals.push(data.id); await executeSqliteWrite(d, `UPDATE work_logs SET ${sets.join(', ')} WHERE id=?`, vals); } return data.id; }
  const cols = Object.entries(values).filter(([, v]) => v !== undefined); const names = cols.map(([k]) => k); const vals = cols.map(([, v]) => v); const r = await executeSqliteWrite(d, `INSERT INTO work_logs (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, vals); return Number(r.lastInsertId || 0);
}
export async function recordSystemWorkLog(projectId: number, stage: string, title: string, content: string, evidence: string[] = []) {
  try {
    return await saveWorkLog({ project_id: projectId, stage, title, content, category: '系统事件', tags: '系统事件', record_type: 'outcome', is_todo: 0, done: 1, evidence });
  } catch { return 0; }
}
export async function toggleWorkLogDone(id: number, done: boolean) { await (await getDb()).execute('UPDATE work_logs SET done=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [done ? 1 : 0, id]); }
export async function deleteWorkLog(id: number) { await (await getDb()).execute('DELETE FROM work_logs WHERE id=?', [id]); }
export async function getWorkLogCategories() { return (await getDb()).select<{ c: string }[]>('SELECT DISTINCT category AS c FROM work_logs ORDER BY category'); }
export async function getWorkSummaries() { return (await getDb()).select<any[]>('SELECT * FROM work_summaries ORDER BY created_at DESC').then(rows => rows.map(r => ({ ...r, source_log_ids: parseArray(r.source_log_ids_json) }))); }
export async function saveWorkSummary(data: any) { const r = await (await getDb()).execute('INSERT INTO work_summaries (title,content,start_date,end_date,summary_type,project_filter,source_log_ids_json) VALUES (?,?,?,?,?,?,?)', [data.title || '', data.content, data.start_date || '', data.end_date || '', data.summary_type || 'period', data.project_filter || '', data.source_log_ids_json || JSON.stringify(data.source_log_ids || [])]); return Number(r.lastInsertId || 0); }
export async function deleteWorkSummary(id: number) { await (await getDb()).execute('DELETE FROM work_summaries WHERE id=?', [id]); }
