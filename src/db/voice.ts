// 用户原声分析数据层（v2.3.19，2026-08-18）：每个产品有自己的原声批次/分析结果（用户：导入的是某产品源声，加产品维度）
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
      product TEXT DEFAULT '',
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
      kind TEXT DEFAULT '',
      product TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS voice_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'running',
      product TEXT DEFAULT '',
      total_items INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 0,
      done_chunks INTEGER DEFAULT 0,
      error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  // 老库补列（幂等）
  try { await d.execute("ALTER TABLE voice_item ADD COLUMN product TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN product TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN kind TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_run ADD COLUMN product TEXT DEFAULT ''"); } catch { }
  ensured = true;
}

export async function clearVoiceItems(product = '') { await ensureVoiceTables(); const d = await getDb(); if (product) { await d.execute('DELETE FROM voice_item WHERE product = ?', [product]); await d.execute('DELETE FROM voice_dimension WHERE product = ?', [product]); } else { await d.execute('DELETE FROM voice_item'); await d.execute('DELETE FROM voice_dimension'); } try { await d.execute('DELETE FROM voice_run'); } catch { } }
export async function getVoiceItemCount(product = '') { await ensureVoiceTables(); const d = await getDb(); const r = product ? await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item WHERE product = ?', [product]) : await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item'); return r[0]?.c || 0; }
export async function getAllVoiceItems(product = '') { await ensureVoiceTables(); const d = await getDb(); return product ? (await d.select<any[]>('SELECT * FROM voice_item WHERE product = ? ORDER BY id', [product])) : (await d.select<any[]>('SELECT * FROM voice_item ORDER BY id')); }
// 去重：同产品 + 同内容 不重复入库；返回 0 = 已存在
export async function addVoiceItem(content: string, source: string, product = ''): Promise<number> {
  await ensureVoiceTables(); const d = await getDb();
  const ex = await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item WHERE content = ? AND product = ?', [content, product]);
  if ((ex[0]?.c || 0) > 0) return 0;
  const r = await d.execute('INSERT INTO voice_item (content, source, product) VALUES (?,?,?)', [content, source, product]);
  return Number(r.lastInsertId) || 0;
}
export async function replaceVoiceDimensions(list: { name: string; weight: number; count: number; positive: number; negative: number; evidence: string; kind?: string }[], product = '') {
  await ensureVoiceTables(); const d = await getDb();
  await d.execute('DELETE FROM voice_dimension WHERE product = ?', [product]);
  for (const it of list) await d.execute('INSERT INTO voice_dimension (name, weight, count, positive, negative, evidence, kind, product) VALUES (?,?,?,?,?,?,?,?)', [it.name, it.weight, it.count, it.positive, it.negative, it.evidence, it.kind || '', product]);
}
export async function getVoiceDimensions(product = '') { await ensureVoiceTables(); const d = await getDb(); return product ? (await d.select<any[]>('SELECT * FROM voice_dimension WHERE product = ? ORDER BY weight DESC', [product])) : (await d.select<any[]>('SELECT * FROM voice_dimension ORDER BY weight DESC')); }
export async function getVoiceProducts() { await ensureVoiceTables(); return (await getDb()).select<any[]>('SELECT DISTINCT product FROM voice_item WHERE product != \'\' ORDER BY product'); }
export async function getRunningVoiceRun(product = '') { await ensureVoiceTables(); const d = await getDb(); const r = product ? await d.select<any[]>("SELECT * FROM voice_run WHERE status='running' AND product=? ORDER BY id DESC LIMIT 1", [product]) : await d.select<any[]>("SELECT * FROM voice_run WHERE status='running' ORDER BY id DESC LIMIT 1"); return r[0] || null; }
export async function getLastVoiceRun(product = '') { await ensureVoiceTables(); const d = await getDb(); const r = product ? await d.select<any[]>('SELECT * FROM voice_run WHERE product=? ORDER BY id DESC LIMIT 1', [product]) : await d.select<any[]>('SELECT * FROM voice_run ORDER BY id DESC LIMIT 1'); return r[0] || null; }
export async function startVoiceRun(totalItems: number, totalChunks: number, product = '') { await ensureVoiceTables(); const d = await getDb(); const r = await d.execute("INSERT INTO voice_run (status, product, total_items, total_chunks, done_chunks) VALUES ('running',?,?,?,0)", [product, totalItems, totalChunks]); return Number(r.lastInsertId) || 0; }
export async function updateVoiceRunProgress(id: number, doneChunks: number) { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_run SET done_chunks=? WHERE id=?', [doneChunks, id]); }
export async function finishVoiceRun(id: number, status: string, error = '') { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_run SET status=?, error=? WHERE id=?', [status, error, id]); }
