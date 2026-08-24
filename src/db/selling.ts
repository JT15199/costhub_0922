// 卖点价值分析数据层（v2.3.19，2026-08-18）：卖点 = 用户原声(声量/反响) 与 BOM(成本) 之间的桥梁
// 卖点挂项目（成本来源）；同一模块可被多个卖点引用 → 成本均分分摊（不重复计算）
import { getDb } from './core';

let ensured = false;
async function ensureSellingTables() {
  if (ensured) return;
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS selling_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      product TEXT DEFAULT '',
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      positive INTEGER DEFAULT 0,
      negative INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch { }
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS selling_point_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      selling_point_id INTEGER NOT NULL,
      module_name TEXT NOT NULL
    )`);
  } catch { }
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS selling_point_dims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      selling_point_id INTEGER NOT NULL,
      voice_dimension_id INTEGER NOT NULL
    )`);
  } catch { }
  try { await d.execute("ALTER TABLE selling_points ADD COLUMN positive INTEGER DEFAULT 0"); } catch { }
  try { await d.execute("ALTER TABLE selling_points ADD COLUMN negative INTEGER DEFAULT 0"); } catch { }
  ensured = true;
}

export async function getSellingPoints(projectId: number) {
  await ensureSellingTables();
  const d = await getDb();
  return d.select<any[]>('SELECT * FROM selling_points WHERE project_id = ? ORDER BY sort_order, id', [projectId]);
}
export async function addSellingPoint(projectId: number, product: string, name: string, description = '') {
  await ensureSellingTables();
  const d = await getDb();
  const r = await d.execute('INSERT INTO selling_points (project_id, product, name, description) VALUES (?,?,?,?)', [projectId, product, name, description]);
  return Number(r.lastInsertId) || 0;
}
export async function updateSellingPoint(id: number, name: string, description = '') {
  await ensureSellingTables();
  await (await getDb()).execute('UPDATE selling_points SET name=?, description=? WHERE id=?', [name, description, id]);
}
export async function setSellingPointVoice(id: number, positive: number, negative: number) {
  await ensureSellingTables();
  await (await getDb()).execute('UPDATE selling_points SET positive=?, negative=? WHERE id=?', [positive, negative, id]);
}
export async function deleteSellingPoint(id: number) {
  await ensureSellingTables();
  const d = await getDb();
  await d.execute('DELETE FROM selling_points WHERE id=?', [id]);
  await d.execute('DELETE FROM selling_point_modules WHERE selling_point_id=?', [id]);
  await d.execute('DELETE FROM selling_point_dims WHERE selling_point_id=?', [id]);
}
export async function setSellingPointModules(spId: number, moduleNames: string[]) {
  await ensureSellingTables();
  const d = await getDb();
  await d.execute('DELETE FROM selling_point_modules WHERE selling_point_id=?', [spId]);
  for (const m of moduleNames) await d.execute('INSERT INTO selling_point_modules (selling_point_id, module_name) VALUES (?,?)', [spId, m]);
}
export async function setSellingPointDims(spId: number, dimIds: number[]) {
  await ensureSellingTables();
  const d = await getDb();
  await d.execute('DELETE FROM selling_point_dims WHERE selling_point_id=?', [spId]);
  for (const di of dimIds) await d.execute('INSERT INTO selling_point_dims (selling_point_id, voice_dimension_id) VALUES (?,?)', [spId, di]);
}
// 一次性取项目下所有卖点的模块/维度映射
export async function getSellingPointMaps(projectId: number): Promise<{ modules: Record<number, string[]>; dims: Record<number, number[]> }> {
  await ensureSellingTables();
  const d = await getDb();
  const mods = await d.select<any[]>('SELECT spm.selling_point_id, spm.module_name FROM selling_point_modules spm JOIN selling_points sp ON sp.id = spm.selling_point_id WHERE sp.project_id = ?', [projectId]);
  const dimRows = await d.select<any[]>('SELECT spd.selling_point_id, spd.voice_dimension_id FROM selling_point_dims spd JOIN selling_points sp ON sp.id = spd.selling_point_id WHERE sp.project_id = ?', [projectId]);
  const modules: Record<number, string[]> = {};
  const dims: Record<number, number[]> = {};
  for (const m of mods) (modules[m.selling_point_id] = modules[m.selling_point_id] || []).push(m.module_name);
  for (const di of dimRows) (dims[di.selling_point_id] = dims[di.selling_point_id] || []).push(di.voice_dimension_id);
  return { modules, dims };
}
