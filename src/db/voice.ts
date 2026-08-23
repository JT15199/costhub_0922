// 用户原声分析数据层（v2.3.19，2026-08-18 用户：Excel 丢进去自主分析，自动分块汇总，找出最有价值特性）
// voice_item = 用户原声条目（Excel 导入）；voice_dimension = 分析提炼出的特性维度权重榜；voice_run = 分析批次（进度）
import { getDb } from './core';

let ensured = false;
async function ensureVoiceTables() {
  if (ensured) return;
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS voice_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS voice_dimension (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      weight REAL DEFAULT 0,
      count INTEGER DEFAULT 0,
      positive INTEGER DEFAULT 0,
      negative INTEGER DEFAULT 0,
      evidence TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS voice_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'running',
      total_items INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 0,
      done_chunks INTEGER DEFAULT 0,
      error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  ensured = true;
}

export async function clearVoiceItems() { await ensureVoiceTables(); const d = await getDb(); await d.execute('DELETE FROM voice_item'); await d.execute('DELETE FROM voice_dimension'); try { await d.execute('DELETE FROM voice_run'); } catch { } }
export async function getVoiceItemCount() { await ensureVoiceTables(); const r = await (await getDb()).select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item'); return r[0]?.c || 0; }
export async function getAllVoiceItems() { await ensureVoiceTables(); return (await getDb()).select<any[]>('SELECT * FROM voice_item ORDER BY id'); }
// 2026-08-18 去重：同内容原声不重复入库（防止重复上传 Excel 导致内容累加）；返回 0 = 已存在（跳过）
export async function addVoiceItem(content: string, source: string): Promise<number> {
  await ensureVoiceTables(); const d = await getDb();
  const ex = await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item WHERE content = ?', [content]);
  if ((ex[0]?.c || 0) > 0) return 0;
  const r = await d.execute('INSERT INTO voice_item (content, source) VALUES (?,?)', [content, source]);
  return Number(r.lastInsertId) || 0;
}
export async function replaceVoiceDimensions(list: { name: string; weight: number; count: number; positive: number; negative: number; evidence: string }[]) {
  await ensureVoiceTables(); const d = await getDb();
  await d.execute('DELETE FROM voice_dimension');
  for (const it of list) await d.execute('INSERT INTO voice_dimension (name, weight, count, positive, negative, evidence) VALUES (?,?,?,?,?,?)', [it.name, it.weight, it.count, it.positive, it.negative, it.evidence]);
}
export async function getVoiceDimensions() { await ensureVoiceTables(); return (await getDb()).select<any[]>('SELECT * FROM voice_dimension ORDER BY weight DESC'); }
export async function getRunningVoiceRun() { await ensureVoiceTables(); const r = await (await getDb()).select<any[]>("SELECT * FROM voice_run WHERE status='running' ORDER BY id DESC LIMIT 1"); return r[0] || null; }
export async function getLastVoiceRun() { await ensureVoiceTables(); const r = await (await getDb()).select<any[]>('SELECT * FROM voice_run ORDER BY id DESC LIMIT 1'); return r[0] || null; }
export async function startVoiceRun(totalItems: number, totalChunks: number) { await ensureVoiceTables(); const d = await getDb(); const r = await d.execute("INSERT INTO voice_run (status, total_items, total_chunks, done_chunks) VALUES ('running',?,?,0)", [totalItems, totalChunks]); return Number(r.lastInsertId) || 0; }
export async function updateVoiceRunProgress(id: number, doneChunks: number) { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_run SET done_chunks=? WHERE id=?', [doneChunks, id]); }
export async function finishVoiceRun(id: number, status: string, error = '') { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_run SET status=?, error=? WHERE id=?', [status, error, id]); }
