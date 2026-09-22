// 用户原声分析数据层（v2.3.19，2026-08-18）：每个产品有自己的原声批次/分析结果（用户：导入的是某产品源声，加产品维度）
import { getDb } from './core';

const text = (value: unknown) => String(value ?? '').trim();

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
      project_id INTEGER DEFAULT 0,
      source_platform TEXT DEFAULT '',
      source_product TEXT DEFAULT '',
      collected_at TEXT DEFAULT '',
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
      project_id INTEGER DEFAULT 0,
      module_name TEXT DEFAULT '',
      kano_category TEXT DEFAULT '',
      decision TEXT DEFAULT '',
      rationale TEXT DEFAULT '',
      confirmed INTEGER DEFAULT 0,
      topic_key TEXT DEFAULT '',
      last_seen_run_id INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      spec_keys TEXT DEFAULT '',
      verification_status TEXT DEFAULT 'unverified',
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
      result_json TEXT DEFAULT '[]',
      error TEXT DEFAULT '',
      input_fingerprint TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  // 老库补列（幂等）
  try { await d.execute("ALTER TABLE voice_item ADD COLUMN product TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_item ADD COLUMN project_id INTEGER DEFAULT 0"); } catch { }
  try { await d.execute("ALTER TABLE voice_item ADD COLUMN source_platform TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_item ADD COLUMN source_product TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_item ADD COLUMN collected_at TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN product TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN project_id INTEGER DEFAULT 0"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN module_name TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN kind TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN kano_category TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN decision TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN rationale TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN confirmed INTEGER DEFAULT 0"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN topic_key TEXT DEFAULT ''"); } catch { }
  try { await d.execute('ALTER TABLE voice_dimension ADD COLUMN last_seen_run_id INTEGER DEFAULT 0'); } catch { }
  try { await d.execute('ALTER TABLE voice_dimension ADD COLUMN archived INTEGER DEFAULT 0'); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN spec_keys TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_dimension ADD COLUMN verification_status TEXT DEFAULT 'unverified'"); } catch { }
  try { await d.execute("ALTER TABLE voice_run ADD COLUMN product TEXT DEFAULT ''"); } catch { }
  try { await d.execute("ALTER TABLE voice_run ADD COLUMN project_id INTEGER DEFAULT 0"); } catch { }
  try { await d.execute("ALTER TABLE voice_run ADD COLUMN result_json TEXT DEFAULT '[]'"); } catch { }
  try { await d.execute("ALTER TABLE voice_run ADD COLUMN input_fingerprint TEXT DEFAULT ''"); } catch { }
  ensured = true;
}

export async function clearVoiceItems(product = '') { await ensureVoiceTables(); const d = await getDb(); if (product) { await d.execute('DELETE FROM voice_item WHERE product = ?', [product]); await d.execute('DELETE FROM voice_dimension WHERE product = ?', [product]); } else { await d.execute('DELETE FROM voice_item'); await d.execute('DELETE FROM voice_dimension'); } try { await d.execute(product ? 'DELETE FROM voice_run WHERE product = ?' : 'DELETE FROM voice_run', product ? [product] : []); } catch { } }
export async function getVoiceItemCount(product = '', projectId = 0) { await ensureVoiceTables(); const d = await getDb(); const where = product ? (projectId ? 'WHERE product = ? AND project_id = ?' : 'WHERE product = ?') : (projectId ? 'WHERE project_id = ?' : ''); const args = product ? (projectId ? [product, projectId] : [product]) : (projectId ? [projectId] : []); const r = await d.select<{ c: number }[]>(`SELECT COUNT(*) as c FROM voice_item ${where}`, args); return r[0]?.c || 0; }
export async function getAllVoiceItems(product = '', projectId = 0) { await ensureVoiceTables(); const d = await getDb(); const where = product ? (projectId ? 'WHERE product = ? AND project_id = ?' : 'WHERE product = ?') : (projectId ? 'WHERE project_id = ?' : ''); const args = product ? (projectId ? [product, projectId] : [product]) : (projectId ? [projectId] : []); return d.select<any[]>(`SELECT * FROM voice_item ${where} ORDER BY id`, args); }
// 去重：同产品 + 同内容 不重复入库；返回 0 = 已存在
export async function addVoiceItem(content: string, source: string, product = '', projectId = 0): Promise<number> {
  await ensureVoiceTables(); const d = await getDb();
  const ex = await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM voice_item WHERE content = ? AND product = ? AND project_id = ?', [content, product, projectId]);
  if ((ex[0]?.c || 0) > 0) return 0;
  const r = await d.execute('INSERT INTO voice_item (content, source, product, project_id) VALUES (?,?,?,?)', [content, source, product, projectId]);
  return Number(r.lastInsertId) || 0;
}
export async function replaceVoiceDimensions(list: { name: string; weight: number; count: number; positive: number; negative: number; evidence: string; kind?: string; specKeys?: string[] }[], product = '', projectId = 0, runId = 0) {
  await ensureVoiceTables(); const d = await getDb();
  const scope = projectId ? 'product = ? AND project_id = ?' : 'product = ? AND project_id = 0';
  const scopeArgs = projectId ? [product, projectId] : [product];
  const previous = await d.select<any[]>(`SELECT * FROM voice_dimension WHERE ${scope}`, scopeArgs);
  const key = (value: unknown) => text(value).toLowerCase().replace(/[\s\-_\/\\.,，。:：()（）\[\]【】]/g, '');
  const similarity = (a: string, b: string) => a === b ? 100 : a.includes(b) || b.includes(a) ? 80 : [...new Set(a)].filter(ch => b.includes(ch)).length >= 2 ? 50 : 0;
  const used = new Set<number>();
  await d.execute('BEGIN');
  try {
    await d.execute(`UPDATE voice_dimension SET archived=1 WHERE ${scope}`, scopeArgs);
    for (const it of list) {
      const topicKey = key(it.name);
      const old = previous.filter(row => !used.has(Number(row.id))).map(row => ({ row, score: similarity(topicKey, key(row.name)) })).sort((a, b) => b.score - a.score)[0]?.score >= 50
        ? previous.filter(row => !used.has(Number(row.id))).sort((a, b) => similarity(topicKey, key(b.name)) - similarity(topicKey, key(a.name)))[0]
        : undefined;
      const evidenceUnchanged = old && text(old.evidence) === text(it.evidence);
      if (old) {
        used.add(Number(old.id));
        const savedSpecKeys = text(old.spec_keys) || JSON.stringify(it.specKeys || []);
        await d.execute('UPDATE voice_dimension SET name=?, weight=?, count=?, positive=?, negative=?, evidence=?, kind=?, topic_key=?, last_seen_run_id=?, archived=0, spec_keys=?, verification_status=? WHERE id=?', [it.name, it.weight, it.count, it.positive, it.negative, it.evidence, it.kind || '', topicKey, runId, savedSpecKeys, text(old.verification_status) || (evidenceUnchanged ? 'unverified' : 'unverified'), old.id]);
      } else {
        await d.execute('INSERT INTO voice_dimension (name, weight, count, positive, negative, evidence, kind, product, project_id, topic_key, last_seen_run_id, spec_keys, verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [it.name, it.weight, it.count, it.positive, it.negative, it.evidence, it.kind || '', product, projectId, topicKey, runId, JSON.stringify(it.specKeys || []), 'unverified']);
      }
    }
    await d.execute('COMMIT');
  } catch (error) {
    await d.execute('ROLLBACK').catch(() => { });
    throw error;
  }
}
export async function getVoiceDimensions(product = '', projectId = 0) { await ensureVoiceTables(); const d = await getDb(); if (!product) return d.select<any[]>('SELECT * FROM voice_dimension WHERE COALESCE(archived,0)=0 ORDER BY weight DESC'); if (projectId) return d.select<any[]>('SELECT * FROM voice_dimension WHERE product = ? AND (project_id = ? OR project_id = 0) AND COALESCE(archived,0)=0 ORDER BY weight DESC', [product, projectId]); return d.select<any[]>('SELECT * FROM voice_dimension WHERE product = ? AND COALESCE(archived,0)=0 ORDER BY weight DESC', [product]); }
export async function updateVoiceDimensionDecision(id: number, kanoCategory: string, decision: string, rationale = '', confirmed = true, moduleName = '', specKeys: string[] = [], verificationStatus = 'unverified') { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_dimension SET kano_category=?, decision=?, rationale=?, confirmed=?, module_name=?, spec_keys=?, verification_status=? WHERE id=?', [kanoCategory, decision, rationale, confirmed ? 1 : 0, moduleName, JSON.stringify(specKeys), verificationStatus, id]); }
export async function getVoiceProducts() { await ensureVoiceTables(); return (await getDb()).select<any[]>('SELECT DISTINCT product FROM voice_item WHERE product != \'\' ORDER BY product'); }
export async function getRunningVoiceRun(product = '', projectId = 0) { await ensureVoiceTables(); const d = await getDb(); const r = product ? await d.select<any[]>(projectId ? "SELECT * FROM voice_run WHERE status IN ('running','paused','error') AND product=? AND project_id=? ORDER BY id DESC LIMIT 1" : "SELECT * FROM voice_run WHERE status IN ('running','paused','error') AND product=? ORDER BY id DESC LIMIT 1", projectId ? [product, projectId] : [product]) : await d.select<any[]>("SELECT * FROM voice_run WHERE status IN ('running','paused','error') ORDER BY id DESC LIMIT 1"); return r[0] || null; }
export async function getLastVoiceRun(product = '') { await ensureVoiceTables(); const d = await getDb(); const r = product ? await d.select<any[]>('SELECT * FROM voice_run WHERE product=? ORDER BY id DESC LIMIT 1', [product]) : await d.select<any[]>('SELECT * FROM voice_run ORDER BY id DESC LIMIT 1'); return r[0] || null; }
export async function startVoiceRun(totalItems: number, totalChunks: number, product = '', projectId = 0, inputFingerprint = '') { await ensureVoiceTables(); const d = await getDb(); const r = await d.execute("INSERT INTO voice_run (status, product, project_id, total_items, total_chunks, done_chunks, input_fingerprint) VALUES ('running',?,?,?,?,0,?)", [product, projectId, totalItems, totalChunks, inputFingerprint]); return Number(r.lastInsertId) || 0; }
export async function updateVoiceRunProgress(id: number, doneChunks: number, results?: unknown) { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_run SET done_chunks=?, result_json=COALESCE(?, result_json) WHERE id=?', [doneChunks, results === undefined ? null : JSON.stringify(results), id]); }
export async function finishVoiceRun(id: number, status: string, error = '') { await ensureVoiceTables(); await (await getDb()).execute('UPDATE voice_run SET status=?, error=? WHERE id=?', [status, error, id]); }
