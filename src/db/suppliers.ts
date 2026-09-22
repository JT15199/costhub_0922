// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';
import { getSetting, setSetting } from './settings';

const CATEGORY_DICT_KEY = 'supplier_categories_v1';
/** 用户未维护时的初始品类词表（用户可自由增删） */
const DEFAULT_SUPPLIER_CATEGORIES = ['显示器', '鼠标', '手写笔', '键盘', '平板', 'PC', '耳机', '充电器', '包装'];

/** 供应商↔品类多值关联表（运行时兜底建表，不动 schema 版本）。 */
async function ensureSupplierCategoryTable(): Promise<void> {
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS supplier_category_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT NOT NULL,
      category TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(supplier_name, category)
    )`);
  } catch { /* 表已存在或旧库不支持时忽略，读取侧有兜底 */ }
}

/** 供应商品类字典：settings 里维护 + 项目品类 + 已用过的品类，合并去重。 */
export async function getSupplierCategories(): Promise<string[]> {
  const names = new Set<string>();
  try {
    const stored = JSON.parse((await getSetting(CATEGORY_DICT_KEY, '[]')) || '[]');
    if (Array.isArray(stored)) stored.forEach(value => { const name = String(value || '').trim(); if (name) names.add(name); });
  } catch { /* 字典损坏时用默认词表 */ }
  if (!names.size) DEFAULT_SUPPLIER_CATEGORIES.forEach(name => names.add(name));
  try {
    const projectRows = await (await getDb()).select<{ category: string }[]>("SELECT DISTINCT category FROM projects WHERE COALESCE(is_deleted,0)=0 AND TRIM(COALESCE(category,''))<>''");
    projectRows.forEach(row => { const name = String(row.category || '').trim(); if (name && name !== '未分类') names.add(name); });
  } catch { /* 项目表不可用时只用字典 */ }
  try {
    await ensureSupplierCategoryTable();
    const used = await (await getDb()).select<{ category: string }[]>("SELECT DISTINCT category FROM supplier_category_links WHERE TRIM(COALESCE(category,''))<>''");
    used.forEach(row => names.add(String(row.category).trim()));
  } catch { /* 关联表不可用 */ }
  DEFAULT_SUPPLIER_CATEGORIES.forEach(name => names.add(name));
  return [...names];
}

/** 新增/删除品类（字典与已分配关系一起维护）。 */
export async function saveSupplierCategories(names: string[]): Promise<string[]> {
  const clean = [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
  await setSetting(CATEGORY_DICT_KEY, JSON.stringify(clean));
  await ensureSupplierCategoryTable();
  try {
    const d = await getDb();
    const linked = await d.select<{ category: string }[]>('SELECT DISTINCT category FROM supplier_category_links');
    const keep = new Set(clean);
    for (const row of linked) {
      const name = String(row.category || '').trim();
      if (name && !keep.has(name)) await d.execute('DELETE FROM supplier_category_links WHERE category=?', [name]);
    }
  } catch { /* 清理失败不影响字典 */ }
  return clean;
}

/** 供应商品类映射：供应商名 → 品类数组（地图筛选与资料展示共用）。 */
export async function getSupplierCategoryMap(): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  try {
    await ensureSupplierCategoryTable();
    const rows = await (await getDb()).select<any[]>('SELECT supplier_name, category FROM supplier_category_links ORDER BY sort_order, id');
    rows.forEach(row => {
      const name = String(row.supplier_name || '').trim();
      const category = String(row.category || '').trim();
      if (!name || !category) return;
      map[name] = [...(map[name] || []), category];
    });
  } catch { /* 旧库无表时返回空映射 */ }
  return map;
}

/** 覆盖写某供应商的品类（同时把第一个品类回填到 supplier_profiles.category 保持旧展示兼容）。 */
export async function setSupplierCategories(supplierName: string, categories: string[]): Promise<void> {
  const name = String(supplierName || '').trim();
  if (!name) throw new Error('供应商名称不能为空');
  const clean = [...new Set(categories.map(category => String(category || '').trim()).filter(Boolean))];
  await ensureSupplierCategoryTable();
  const d = await getDb();
  await d.execute('DELETE FROM supplier_category_links WHERE supplier_name=?', [name]);
  for (let index = 0; index < clean.length; index += 1) {
    await d.execute('INSERT OR IGNORE INTO supplier_category_links (supplier_name, category, sort_order) VALUES (?,?,?)', [name, clean[index], index]);
  }
  if (clean.length) {
    await d.execute("UPDATE supplier_profiles SET category=?, updated_at=datetime('now','localtime') WHERE TRIM(supplier_name)=?", [clean[0], name]);
  }
  if (clean.length) {
    const dictionary = await getSupplierCategories();
    await setSetting(CATEGORY_DICT_KEY, JSON.stringify([...new Set([...dictionary, ...clean])]));
  }
}

export interface SupplierProjectRow {
  projectId: number;
  projectCode: string;
  projectName: string;
  projectCategory: string;
  partCount: number;
  /** 该项目中"由本供应商供货的器件"按库内成本口径的金额 */
  supplierAmount: number;
  /** 该供应商对这部分的平均报价（元） */
  avgPrice: number;
  /** 该项目整机 BOM 成本合计（占比分母） */
  projectBomAmount: number;
  /** 本供应商金额 / 项目 BOM 成本 */
  sharePct: number;
}

export interface SupplierProjectCoverage {
  supplierName: string;
  parts: SupplierProjectRow[];
  odm: { projectId: number; projectCode: string; projectName: string; quotedPrice: number; shareRatio: number; isActive: number }[];
  batches: { projectId: number; projectCode: string; projectName: string; batchCount: number; quotedAmount: number; lastQuotedAt: string }[];
  totals: { projectCount: number; partCount: number; supplierAmount: number; bomAmount: number; sharePct: number };
}

/**
 * 某供应商的供应项目情况：器件供货（按项目聚合金额与占比）+ 整机承接 + 招标报价批次。
 * 金额口径：库内成本 = CASE WHEN pb.part_cost>0 THEN pb.part_cost ELSE parts.cost（快照优先，CLAUDE.md 铁律）；
 * 份额按 part_suppliers.share_ratio 视为百分比（0 或未填 = 100%，避免把未填份额算成 0）。
 */
export async function getSupplierProjectCoverage(supplierName: string): Promise<SupplierProjectCoverage> {
  const name = String(supplierName || '').trim();
  const empty: SupplierProjectCoverage = { supplierName: name, parts: [], odm: [], batches: [], totals: { projectCount: 0, partCount: 0, supplierAmount: 0, bomAmount: 0, sharePct: 0 } };
  if (!name) return empty;
  const d = await getDb();
  const unitCost = 'CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE COALESCE(p2.cost,0) END';
  const rows = await d.select<any[]>(`
    SELECT pr.id AS project_id, pr.code AS project_code, pr.name AS project_name, COALESCE(pr.category,'未分类') AS project_category,
           COUNT(DISTINCT pb.part_id) AS part_count,
           ROUND(SUM(${unitCost} * COALESCE(pb.quantity,1) * (CASE WHEN COALESCE(rel.share_ratio,0) > 0 THEN rel.share_ratio/100.0 ELSE 1 END)), 2) AS supplier_amount,
           ROUND(AVG(rel.avg_price), 2) AS avg_price,
           ROUND((SELECT SUM(CASE WHEN b.part_cost > 0 THEN b.part_cost ELSE COALESCE(p3.cost,0) END * COALESCE(b.quantity,1))
                  FROM project_boms b LEFT JOIN parts p3 ON p3.id = b.part_id
                  WHERE b.project_id = pr.id AND COALESCE(b.is_deleted,0)=0), 2) AS project_bom_amount
    FROM (SELECT ps.part_id, MAX(COALESCE(ps.share_ratio,0)) AS share_ratio, AVG(COALESCE(ps.price,0)) AS avg_price
          FROM part_suppliers ps
          WHERE TRIM(ps.supplier_name) = ? AND COALESCE(ps.is_active,1) = 1
          GROUP BY ps.part_id) rel
    JOIN project_boms pb ON pb.part_id = rel.part_id AND COALESCE(pb.is_deleted,0)=0
    JOIN projects pr ON pr.id = pb.project_id AND COALESCE(pr.is_deleted,0)=0
    LEFT JOIN parts p2 ON p2.id = pb.part_id
    GROUP BY pr.id
    ORDER BY supplier_amount DESC
  `, [name]);
  const parts: SupplierProjectRow[] = rows.map(row => {
    const supplierAmount = Number(row.supplier_amount) || 0;
    const projectBomAmount = Number(row.project_bom_amount) || 0;
    return {
      projectId: Number(row.project_id),
      projectCode: String(row.project_code || ''),
      projectName: String(row.project_name || ''),
      projectCategory: String(row.project_category || '未分类'),
      partCount: Number(row.part_count) || 0,
      supplierAmount,
      avgPrice: Number(row.avg_price) || 0,
      projectBomAmount,
      sharePct: projectBomAmount > 0 ? Math.round((supplierAmount / projectBomAmount) * 1000) / 10 : 0,
    };
  });
  let odm: SupplierProjectCoverage['odm'] = [];
  try {
    const odmRows = await d.select<any[]>(`
      SELECT ps.project_id, pr.code AS project_code, pr.name AS project_name, COALESCE(ps.quoted_price,0) AS quoted_price,
             COALESCE(ps.share_ratio,0) AS share_ratio, COALESCE(ps.is_active,1) AS is_active
      FROM project_suppliers ps JOIN projects pr ON pr.id = ps.project_id AND COALESCE(pr.is_deleted,0)=0
      WHERE TRIM(ps.supplier_name) = ? ORDER BY is_active DESC, ps.id DESC
    `, [name]);
    odm = odmRows.map(row => ({
      projectId: Number(row.project_id), projectCode: String(row.project_code || ''), projectName: String(row.project_name || ''),
      quotedPrice: Number(row.quoted_price) || 0, shareRatio: Number(row.share_ratio) || 0, isActive: Number(row.is_active) || 0,
    }));
  } catch { /* 无整机关系表时忽略 */ }
  let batches: SupplierProjectCoverage['batches'] = [];
  try {
    const batchRows = await d.select<any[]>(`
      SELECT b.project_id, pr.code AS project_code, pr.name AS project_name,
             COUNT(DISTINCT b.id) AS batch_count, ROUND(SUM(COALESCE(b.total_amount,0)),2) AS quoted_amount, MAX(b.quoted_at) AS last_quoted_at
      FROM supplier_quote_batches b JOIN projects pr ON pr.id = b.project_id
      WHERE TRIM(b.supplier_name) = ? GROUP BY b.project_id ORDER BY quoted_amount DESC
    `, [name]);
    batches = batchRows.map(row => ({
      projectId: Number(row.project_id), projectCode: String(row.project_code || ''), projectName: String(row.project_name || ''),
      batchCount: Number(row.batch_count) || 0, quotedAmount: Number(row.quoted_amount) || 0, lastQuotedAt: String(row.last_quoted_at || ''),
    }));
  } catch { /* 无招标表时忽略 */ }
  const projectIds = new Set<number>([...parts.map(row => row.projectId), ...odm.map(row => row.projectId), ...batches.map(row => row.projectId)]);
  const supplierAmount = parts.reduce((sum, row) => sum + row.supplierAmount, 0);
  const bomAmount = parts.reduce((sum, row) => sum + row.projectBomAmount, 0);
  return {
    supplierName: name,
    parts,
    odm,
    batches,
    totals: {
      projectCount: projectIds.size,
      partCount: parts.reduce((sum, row) => sum + row.partCount, 0),
      supplierAmount: Math.round(supplierAmount * 100) / 100,
      bomAmount: Math.round(bomAmount * 100) / 100,
      sharePct: bomAmount > 0 ? Math.round((supplierAmount / bomAmount) * 1000) / 10 : 0,
    },
  };
}



// ==================== 供应商档案（含Logo） ====================
export async function getSupplierProfiles() {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_profiles ORDER BY supplier_name');
}


export async function getSupplierProfile(name: string) {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_profiles WHERE supplier_name=?', [name]).then(r => r[0] || null);
}

export async function getSupplierSites(supplierName?: string) {
  const d = await getDb();
  return supplierName
    ? d.select<any[]>('SELECT * FROM supplier_sites WHERE supplier_name=? ORDER BY is_primary DESC, id', [supplierName])
    : d.select<any[]>('SELECT * FROM supplier_sites ORDER BY supplier_name, is_primary DESC, id');
}

export async function saveSupplierSite(data: any) {
  const d = await getDb();
  const values = [data.supplier_name, data.site_name || '总部 / 主厂', data.address || '', data.province || '', data.city || '', data.longitude || 0, data.latitude || 0, data.contact || '', data.phone || '', data.is_primary ? 1 : 0, data.remark || ''];
  if (data.is_primary) await d.execute('UPDATE supplier_sites SET is_primary=0 WHERE supplier_name=?', [data.supplier_name]);
  if (data.id) {
    await d.execute('UPDATE supplier_sites SET supplier_name=?, site_name=?, address=?, province=?, city=?, longitude=?, latitude=?, contact=?, phone=?, is_primary=?, remark=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [...values, data.id]);
    return data.id;
  }
  const result = await d.execute('INSERT INTO supplier_sites (supplier_name, site_name, address, province, city, longitude, latitude, contact, phone, is_primary, remark) VALUES (?,?,?,?,?,?,?,?,?,?,?)', values);
  return result.lastInsertId;
}

export async function deleteSupplierSite(id: number) {
  await (await getDb()).execute('DELETE FROM supplier_sites WHERE id=?', [id]);
}


export async function saveSupplierProfile(data: any) {
  data = { ...data, supplier_name: String(data.supplier_name || '').trim() };
  if (!data.supplier_name) throw new Error('供应商名称不能为空');
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM supplier_profiles WHERE TRIM(supplier_name)=? ORDER BY id LIMIT 1', [data.supplier_name]);
  if (existing.length) {
    const current = existing[0];
    await d.execute(
      "UPDATE supplier_profiles SET logo=?, category=?, contact=?, phone=?, rating=?, remark=?, address=?, province=?, city=?, longitude=?, latitude=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.logo ?? current.logo ?? '', data.category ?? current.category ?? '', data.contact ?? current.contact ?? '', data.phone ?? current.phone ?? '', data.rating ?? current.rating ?? 0, data.remark ?? current.remark ?? '', data.address ?? current.address ?? '', data.province ?? current.province ?? '', data.city ?? current.city ?? '', data.longitude ?? current.longitude ?? 0, data.latitude ?? current.latitude ?? 0, current.id]
    );
    return current.id;
  } else {
    const r = await d.execute(
      'INSERT INTO supplier_profiles (supplier_name, logo, category, contact, phone, rating, remark, address, province, city, longitude, latitude) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [data.supplier_name, data.logo || '', data.category || '', data.contact || '', data.phone || '', data.rating || 0, data.remark || '', data.address || '', data.province || '', data.city || '', data.longitude || 0, data.latitude || 0]
    );
    return r.lastInsertId;
  }
}


export async function deleteSupplierProfile(id: number) {
  await (await getDb()).execute('DELETE FROM supplier_profiles WHERE id=?', [id]);
}

/** Shared supplier names: maintained profiles plus names already used in business records. */
export async function getSupplierResources() {
  const rows = await (await getDb()).select<any[]>(`
    SELECT supplier_name, category, contact, phone, remark, address, province, city, longitude, latitude, '档案' AS source FROM supplier_profiles
    UNION ALL SELECT DISTINCT supplier_name, '', '', '', '', '', '', '', 0, 0, '器件' FROM part_suppliers
    UNION ALL SELECT DISTINCT supplier_name, '', '', '', '', '', '', '', 0, 0, '整机' FROM project_suppliers
    UNION ALL SELECT DISTINCT supplier_name, '', '', '', '', '', '', '', 0, 0, '报价' FROM supplier_quote_batches
  `);
  const resources = new Map<string, { supplier_name: string; category: string; contact: string; phone: string; remark: string; address: string; province: string; city: string; longitude: number; latitude: number; sources: string[] }>();
  for (const row of rows) {
    const name = String(row.supplier_name || '').trim();
    if (!name) continue;
    const entry = resources.get(name) || { supplier_name: name, category: '', contact: '', phone: '', remark: '', address: '', province: '', city: '', longitude: 0, latitude: 0, sources: [] };
    if (row.source === '档案') {
      for (const key of ['category', 'contact', 'phone', 'remark', 'address', 'province', 'city'] as const) entry[key] = String(row[key] || '');
      entry.longitude = Number(row.longitude) || 0;
      entry.latitude = Number(row.latitude) || 0;
    }
    if (!entry.sources.includes(row.source)) entry.sources.push(row.source);
    resources.set(name, entry);
  }
  return [...resources.values()].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name, 'zh-CN'));
}
