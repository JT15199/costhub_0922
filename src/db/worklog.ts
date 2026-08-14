// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';



// ==================== 工作日志 ====================
export async function getWorkLogs(category = '', keyword = '', startDate = '', endDate = '', workProject = '') {
  const d = await getDb();
  let q = 'SELECT * FROM work_logs WHERE 1=1';
  const p: any[] = [];
  if (category) { q += ' AND category=?'; p.push(category); }
  if (keyword) { q += ' AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)'; const k = `%${keyword}%`; p.push(k, k, k); }
  if (startDate) { q += ' AND date(log_date) >= ?'; p.push(startDate); }
  if (endDate) { q += ' AND date(log_date) <= ?'; p.push(endDate); }
  if (workProject) {
    if (workProject === '(无项目)') { q += " AND (work_project IS NULL OR work_project = '')"; }
    else { q += ' AND work_project=?'; p.push(workProject); }
  }
  q += ' ORDER BY log_date DESC, id DESC';
  return d.select<any[]>(q, p);
}


/** 获取范围内按项目标签聚合的工作记录（用于 AI 总结：按项目分组，无项目归入公共/其他） */
export async function getWorkLogsGroupedByProject(startDate = '', endDate = '') {
  const d = await getDb();
  let q = 'SELECT work_project, COUNT(*) as cnt FROM work_logs WHERE is_todo=0';
  const p: any[] = [];
  if (startDate) { q += ' AND date(log_date) >= ?'; p.push(startDate); }
  if (endDate) { q += ' AND date(log_date) <= ?'; p.push(endDate); }
  q += ' GROUP BY work_project ORDER BY work_project';
  const rows = await d.select<any[]>(q, p);
  const total = rows.reduce((s, r) => s + (r.cnt || 0), 0);
  return { projects: rows, total };
}


export async function getWorkLog(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM work_logs WHERE id=?', [id]).then(r => r[0] || null);
}


export async function saveWorkLog(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      "UPDATE work_logs SET log_date=?, title=?, content=?, category=?, tags=?, work_project=?, is_todo=?, done=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.log_date, data.title || '', data.content, data.category || '其他', data.tags || '', data.work_project || '', data.is_todo ? 1 : 0, data.done ? 1 : 0, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO work_logs (log_date, title, content, category, tags, work_project, is_todo, done) VALUES (?,?,?,?,?,?,?,?)',
      [data.log_date, data.title || '', data.content, data.category || '其他', data.tags || '', data.work_project || '', data.is_todo ? 1 : 0, data.done ? 1 : 0]
    );
    return r.lastInsertId;
  }
}


export async function toggleWorkLogDone(id: number, done: boolean) {
  await (await getDb()).execute('UPDATE work_logs SET done=? WHERE id=?', [done ? 1 : 0, id]);
}


export async function deleteWorkLog(id: number) {
  await (await getDb()).execute('DELETE FROM work_logs WHERE id=?', [id]);
}


export async function getWorkLogCategories() {  return (await getDb()).select<{ c: string }[]>('SELECT DISTINCT category FROM work_logs ORDER BY category');
}



// ==================== 工作总结保存 ====================
export async function getWorkSummaries() {
  return (await getDb()).select<any[]>('SELECT * FROM work_summaries ORDER BY created_at DESC');
}


export async function saveWorkSummary(data: any) {
  const r = await (await getDb()).execute(
    'INSERT INTO work_summaries (title, content, start_date, end_date) VALUES (?,?,?,?)',
    [data.title || '', data.content, data.start_date || '', data.end_date || '']
  );
  return r.lastInsertId;
}


export async function deleteWorkSummary(id: number) {
  await (await getDb()).execute('DELETE FROM work_summaries WHERE id=?', [id]);
}