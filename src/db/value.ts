// 价值工程数据层（v2.3.19，2026-08-18 用户：价值工程按品类特性模板设计，价值由数据算不人为定义）
// cat_feature_templates = 品类特性维度+权重（显示器色域/亮度，手写笔续航/压感…）；
// value_scores = 项目/竞品 按品类特性的评分（0-10，独立于雷达评分）
import { getDb } from './core';

let ensured = false;
async function ensureValueTables() {
  if (ensured) return;
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS cat_feature_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      feature_label TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(category, feature_key)
    )`);
  } catch { /* 已存在 */ }
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS value_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_type TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      feature_key TEXT NOT NULL,
      score REAL DEFAULT 0,
      category TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(ref_type, ref_id, feature_key)
    )`);
  } catch { /* 已存在 */ }
  // 默认品类特性模板（可改权重/增删）
  const DEFAULT_TEMPLATES: Record<string, [string, string][]> = {
    '显示器': [['color_gamut','色域'],['brightness','亮度'],['refresh_rate','刷新率'],['resolution','分辨率'],['panel_type','面板类型'],['id','ID外观'],['stand','支架功能'],['ports','接口']],
    '手写笔': [['battery','续航'],['pressure','压感等级'],['latency','延迟'],['connect','连接方式'],['weight','重量'],['id','ID外观']],
    '鼠标': [['dpi','DPI'],['sensor','传感器'],['connect','连接方式'],['battery','续航'],['weight','重量'],['switch','微动']],
  };
  for (const [cat, feats] of Object.entries(DEFAULT_TEMPLATES)) {
    try {
      const cnt = await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM cat_feature_templates WHERE category = ?', [cat]);
      if ((cnt[0]?.c || 0) === 0) {
        for (let i = 0; i < feats.length; i++) {
          await d.execute('INSERT INTO cat_feature_templates (category, feature_key, feature_label, weight, sort_order) VALUES (?,?,?,1.0,?)', [cat, feats[i][0], feats[i][1], i]);
        }
      }
    } catch { /* 单品类种子失败忽略 */ }
  }
  ensured = true;
}

export async function getCatFeatureTemplates(category?: string) {
  await ensureValueTables();
  const d = await getDb();
  let q = 'SELECT * FROM cat_feature_templates'; const p: any[] = [];
  if (category) { q += ' WHERE category = ?'; p.push(category); }
  q += ' ORDER BY sort_order, id';
  return (await d.select<any[]>(q, p)) || [];
}

export async function saveCatFeatureTemplate(data: any) {
  await ensureValueTables();
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE cat_feature_templates SET category=?, feature_key=?, feature_label=?, weight=?, sort_order=? WHERE id=?',
      [data.category, data.feature_key, data.feature_label, data.weight ?? 1, data.sort_order ?? 0, data.id]);
    return data.id;
  }
  const r = await d.execute('INSERT INTO cat_feature_templates (category, feature_key, feature_label, weight, sort_order) VALUES (?,?,?,?,?)',
    [data.category, data.feature_key, data.feature_label, data.weight ?? 1, data.sort_order ?? 0]);
  return Number(r.lastInsertId) || 0;
}

export async function deleteCatFeatureTemplate(id: number) {
  await ensureValueTables();
  await (await getDb()).execute('DELETE FROM cat_feature_templates WHERE id = ?', [id]);
}

export async function getValueScores(refType: 'project' | 'competitor', refId: number) {
  await ensureValueTables();
  return (await getDb()).select<any[]>('SELECT * FROM value_scores WHERE ref_type = ? AND ref_id = ?', [refType, refId]) || [];
}

export async function saveValueScore(refType: 'project' | 'competitor', refId: number, featureKey: string, score: number, category = '') {
  await ensureValueTables();
  const d = await getDb();
  await d.execute(`INSERT INTO value_scores (ref_type, ref_id, feature_key, score, category, updated_at) VALUES (?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(ref_type, ref_id, feature_key) DO UPDATE SET score=excluded.score, category=excluded.category, updated_at=datetime('now','localtime')`,
    [refType, refId, featureKey, score, category]);
}

// 某对象全部特性评分（按 ref 聚合）
export async function getAllValueScoresByRef(refType: 'project' | 'competitor') {
  await ensureValueTables();
  return (await getDb()).select<any[]>('SELECT * FROM value_scores WHERE ref_type = ?', [refType]) || [];
}
