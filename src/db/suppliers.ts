// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';



// ==================== 供应商档案（含Logo） ====================
export async function getSupplierProfiles() {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_profiles ORDER BY supplier_name');
}


export async function getSupplierProfile(name: string) {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_profiles WHERE supplier_name=?', [name]).then(r => r[0] || null);
}


export async function saveSupplierProfile(data: any) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT id FROM supplier_profiles WHERE supplier_name=?', [data.supplier_name]);
  if (existing.length) {
    await d.execute(
      "UPDATE supplier_profiles SET logo=?, category=?, contact=?, phone=?, rating=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.logo || '', data.category || '', data.contact || '', data.phone || '', data.rating || 0, data.remark || '', existing[0].id]
    );
    return existing[0].id;
  } else {
    const r = await d.execute(
      'INSERT INTO supplier_profiles (supplier_name, logo, category, contact, phone, rating, remark) VALUES (?,?,?,?,?,?,?)',
      [data.supplier_name, data.logo || '', data.category || '', data.contact || '', data.phone || '', data.rating || 0, data.remark || '']
    );
    return r.lastInsertId;
  }
}


export async function deleteSupplierProfile(id: number) {
  await (await getDb()).execute('DELETE FROM supplier_profiles WHERE id=?', [id]);
}