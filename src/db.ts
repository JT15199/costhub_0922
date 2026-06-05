import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

let db: Database | null = null;
let dbUrl: string | null = null;

async function getDbUrl(): Promise<string> {
  if (!dbUrl) { dbUrl = await invoke<string>('get_db_path'); }
  return dbUrl;
}
async function getDb(): Promise<Database> {
  if (!db) { db = await Database.load(await getDbUrl()); }
  return db;
}

// ==================== Parts ====================
export async function getParts(search = '', category = '', mainCategory = '') {
  const d = await getDb();
  let q = 'SELECT * FROM parts WHERE 1=1'; const p: any[] = [];
  if (search) { q += ' AND (name LIKE ? OR model LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  if (category) { q += ' AND category = ?'; p.push(category); }
  if (mainCategory) { q += ' AND main_category = ?'; p.push(mainCategory); }
  q += ' ORDER BY main_category, sub_category, name';
  return d.select<any[]>(q, p);
}
export async function getPart(id: number) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM parts WHERE id = ?', [id]);
  return r[0] || null;
}
export async function savePart(data: any) {
  const d = await getDb();
  if (data.id) {
    const old = await d.select<{ cost: number }[]>('SELECT cost FROM parts WHERE id = ?', [data.id]);
    if (old[0] && Math.abs(old[0].cost - (data.cost || 0)) > 0.0001) {
      await d.execute('INSERT INTO part_price_history (part_id, old_cost, new_cost) VALUES (?, ?, ?)', [data.id, old[0].cost, data.cost || 0]);
    }
    await d.execute(`UPDATE parts SET main_category=?, sub_category=?, category=?, name=?, model=?, cost=?, specs=?, projects=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '', data.id]);
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO parts (main_category, sub_category, category, name, model, cost, specs, projects, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '']);
    return r.lastInsertId;
  }
}
export async function deletePart(id: number) { await (await getDb()).execute('DELETE FROM parts WHERE id = ?', [id]); }
export async function getPriceHistory(partId: number) { return (await getDb()).select<any[]>('SELECT * FROM part_price_history WHERE part_id = ? ORDER BY changed_at DESC', [partId]); }
export async function getCategories() { return (await (await getDb()).select<{ category: string }[]>('SELECT DISTINCT category FROM parts ORDER BY category')).map(x => x.category); }

// ==================== Projects ====================
export async function getProjects(status = '', projectType = '') {
  const d = await getDb(); let q = 'SELECT * FROM projects WHERE 1=1'; const p: any[] = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (projectType) { q += ' AND project_type = ?'; p.push(projectType); }
  q += ' ORDER BY created_at DESC';
  return d.select<any[]>(q, p);
}
export async function getProject(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM projects WHERE id = ?', [id]); return r[0] || null; }
export async function saveProject(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(`UPDATE projects SET code=?,name=?,project_type=?,tier=?,status=?,screen_size=?,resolution=?,refresh_rate=?,panel_type=?,platform_fee_rate=?,profit_rate=?,image=? WHERE id=?`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '', data.id]);
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '']);
    return r.lastInsertId;
  }
}
export async function deleteProject(id: number) { await (await getDb()).execute('DELETE FROM projects WHERE id = ?', [id]); }
export async function copyProject(id: number, newCode: string, newName: string) {
  const d = await getDb(); const src = await d.select<any[]>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!src[0]) return 0;
  const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [newCode, newName, '在研', src[0].tier, '进行中', src[0].screen_size, src[0].resolution, src[0].refresh_rate, src[0].panel_type, src[0].platform_fee_rate, src[0].profit_rate]);
  const boms = await d.select<any[]>('SELECT * FROM project_boms WHERE project_id = ?', [id]);
  for (const b of boms) { await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark) VALUES (?,?,?,?,?)', [r.lastInsertId, b.part_id, b.module_name, b.quantity, b.remark]); }
  const mods = await d.select<any[]>('SELECT * FROM modules WHERE project_id = ?', [id]);
  for (const m of mods) {
    const mr = await d.execute('INSERT INTO modules (project_id, name, description) VALUES (?,?,?)', [r.lastInsertId, m.name, m.description]);
    const items = await d.select<any[]>('SELECT * FROM module_items WHERE module_id = ?', [m.id]);
    for (const mi of items) { await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [mr.lastInsertId, mi.part_id, mi.part_name, mi.part_model, mi.main_category, mi.sub_category, mi.cost, mi.quantity, mi.remark]); }
  }
  return r.lastInsertId;
}

// ==================== Project BOMs ====================
export async function getProjectBOMs(projectId: number) {
  return (await getDb()).select<any[]>(`SELECT pb.*, p.name as part_name, p.model as part_model, p.cost as part_cost, p.main_category, p.sub_category, p.category FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ? ORDER BY pb.module_name, p.main_category, p.sub_category, p.name`, [projectId]);
}
export async function addBOMItem(projectId: number, partId: number, quantity = 1, moduleName = '', remark = '') {
  await (await getDb()).execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark) VALUES (?,?,?,?,?)', [projectId, partId, moduleName, quantity, remark]);
}
export async function updateBOMItem(id: number, quantity: number, moduleName: string, remark: string) {
  await (await getDb()).execute('UPDATE project_boms SET quantity=?, module_name=?, remark=? WHERE id=?', [quantity, moduleName, remark, id]);
}
export async function deleteBOMItem(id: number) { await (await getDb()).execute('DELETE FROM project_boms WHERE id = ?', [id]); }

// ==================== Modules ====================
export async function getModules(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM modules WHERE project_id = ? ORDER BY name', [projectId]); }
export async function getModuleItems(moduleId: number) { return (await getDb()).select<any[]>('SELECT * FROM module_items WHERE module_id = ? ORDER BY main_category, sub_category, part_name', [moduleId]); }
export async function saveModule(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE modules SET name=?, description=? WHERE id=?', [data.name, data.description || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO modules (project_id, name, description) VALUES (?,?,?)', [data.project_id, data.name, data.description || '']); return r.lastInsertId; }
}
export async function deleteModule(id: number) { await (await getDb()).execute('DELETE FROM modules WHERE id = ?', [id]); }
export async function saveModuleItem(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE module_items SET part_id=?, part_name=?, part_model=?, main_category=?, sub_category=?, cost=?, quantity=?, remark=? WHERE id=?', [data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost || 0, data.quantity || 1, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [data.module_id, data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost || 0, data.quantity || 1, data.remark || '']); return r.lastInsertId; }
}
export async function deleteModuleItem(id: number) { await (await getDb()).execute('DELETE FROM module_items WHERE id = ?', [id]); }
export async function getModuleCost(moduleId: number) {
  const items = await getModuleItems(moduleId);
  return items.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0);
}
export async function getProjectModuleSummary(projectId: number) {
  const d = await getDb();
  const boms = await d.select<any[]>(`SELECT pb.module_name, pb.quantity, p.cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?`, [projectId]);
  const map: Record<string, number> = {};
  boms.forEach(b => {
    const m = b.module_name || '未归类';
    map[m] = (map[m] || 0) + (b.cost || 0) * (b.quantity || 1);
  });
  return Object.entries(map).map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }));
}

// ==================== Competitors ====================
export async function getCompetitors() { return (await getDb()).select<any[]>('SELECT * FROM competitors ORDER BY created_at DESC'); }
export async function getCompetitor(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM competitors WHERE id = ?', [id]); return r[0] || null; }
export async function saveCompetitor(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitors SET brand=?,model=?,tier=?,market_price=?,bom_cost=?,platform_fee_rate=?,remark=? WHERE id=?', [data.brand, data.model, data.tier, data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitors (brand,model,tier,market_price,bom_cost,platform_fee_rate,remark) VALUES (?,?,?,?,?,?,?)', [data.brand, data.model, data.tier, data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '']); return r.lastInsertId; }
}
export async function deleteCompetitor(id: number) { await (await getDb()).execute('DELETE FROM competitors WHERE id = ?', [id]); }
export async function getCompetitorBOMs(competitorId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM competitor_boms WHERE competitor_id = ? ORDER BY module_name, part_name', [competitorId]);
}
export async function addCompetitorBOMItem(competitorId: number, partName: string, partModel = '', estimatedCost = 0, quantity = 1, moduleName = '', ourPartName = '', ourPartModel = '', ourCost = 0, ourQuantity = 0) {
  await (await getDb()).execute('INSERT INTO competitor_boms (competitor_id, part_name, part_model, estimated_cost, quantity, module_name, our_part_name, our_part_model, our_cost, our_quantity) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [competitorId, partName, partModel, estimatedCost, quantity, moduleName, ourPartName, ourPartModel, ourCost, ourQuantity]);
}
export async function updateCompetitorBOMItem(id: number, partName: string, partModel: string, estimatedCost: number, quantity: number, moduleName: string) {
  await (await getDb()).execute('UPDATE competitor_boms SET part_name=?, part_model=?, estimated_cost=?, quantity=?, module_name=? WHERE id=?',
    [partName, partModel, estimatedCost, quantity, moduleName, id]);
}
export async function deleteCompetitorBOMItem(id: number) { await (await getDb()).execute('DELETE FROM competitor_boms WHERE id = ?', [id]); }
export async function getCompetitorParts() { return (await getDb()).select<any[]>('SELECT * FROM competitor_parts ORDER BY main_category, category, name'); }
export async function saveCompetitorPart(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitor_parts SET main_category=?,sub_category=?,category=?,name=?,model=?,cost=?,specs=?,remark=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [data.main_category || '硬件类', data.sub_category || '', data.category, data.name, data.model, data.cost || 0, data.specs || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitor_parts (main_category,sub_category,category,name,model,cost,specs,remark) VALUES (?,?,?,?,?,?,?,?)', [data.main_category || '硬件类', data.sub_category || '', data.category, data.name, data.model, data.cost || 0, data.specs || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteCompetitorPart(id: number) { await (await getDb()).execute('DELETE FROM competitor_parts WHERE id = ?', [id]); }

// ==================== Product Features & Scores (Radar) ====================
export async function getFeatures() { return (await getDb()).select<any[]>('SELECT * FROM product_features ORDER BY id'); }
export async function saveFeature(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE product_features SET name=?, weight=? WHERE id=?', [data.name, data.weight || 1, data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO product_features (name, weight) VALUES (?,?)', [data.name, data.weight || 1]); return r.lastInsertId; }
}
export async function deleteFeature(id: number) { await (await getDb()).execute('DELETE FROM product_features WHERE id = ?', [id]); }
export async function getScores(refType: string, refId: number) {
  const d = await getDb();
  const scores = await d.select<any[]>('SELECT * FROM product_scores WHERE ref_type = ? AND ref_id = ?', [refType, refId]);
  const map: Record<number, number> = {};
  scores.forEach(s => { map[s.feature_id] = s.score; });
  return map;
}
export async function saveScore(refType: string, refId: number, featureId: number, score: number) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT id FROM product_scores WHERE ref_type = ? AND ref_id = ? AND feature_id = ?', [refType, refId, featureId]);
  if (existing.length > 0) {
    await d.execute('UPDATE product_scores SET score = ? WHERE id = ?', [score, existing[0].id]);
  } else {
    await d.execute('INSERT INTO product_scores (ref_type, ref_id, feature_id, score) VALUES (?,?,?,?)', [refType, refId, featureId, score]);
  }
}
export async function getAllScoresForRefs(refType: string, refIds: number[]) {
  const d = await getDb();
  if (refIds.length === 0) return {} as Record<number, Record<number, number>>;
  const scores = await d.select<any[]>(`SELECT * FROM product_scores WHERE ref_type = ? AND ref_id IN (${refIds.map(() => '?').join(',')})`, [refType, ...refIds]);
  const result: Record<number, Record<number, number>> = {};
  scores.forEach(s => {
    if (!result[s.ref_id]) result[s.ref_id] = {};
    result[s.ref_id][s.feature_id] = s.score;
  });
  return result;
}

// ==================== Cost Reviews & Measures ====================
export async function getCostReviews(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_cost_reviews WHERE project_id = ? ORDER BY reviewed_at DESC', [projectId]); }
export async function saveCostReview(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_cost_reviews SET stage=?, reviewed_cost=?, reviewer=?, remark=? WHERE id=?', [data.stage, data.reviewed_cost, data.reviewer || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_cost_reviews (project_id, stage, reviewed_cost, reviewer, remark) VALUES (?,?,?,?,?)', [data.project_id, data.stage, data.reviewed_cost, data.reviewer || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteCostReview(id: number) { await (await getDb()).execute('DELETE FROM project_cost_reviews WHERE id = ?', [id]); }
export async function getMeasures(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_measures WHERE project_id = ? ORDER BY created_at DESC', [projectId]); }
export async function saveMeasure(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_measures SET main_category=?,measure=?,status=?,due_date=?,owner=?,remark=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [data.main_category, data.measure, data.status, data.due_date || '', data.owner || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_measures (project_id, main_category, measure, status, due_date, owner, remark) VALUES (?,?,?,?,?,?,?)', [data.project_id, data.main_category, data.measure, data.status, data.due_date || '', data.owner || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteMeasure(id: number) { await (await getDb()).execute('DELETE FROM project_measures WHERE id = ?', [id]); }

// ==================== Dashboard ====================
export async function getDashboardStats() {
  const d = await getDb();
  const totalParts = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM parts'))[0].c;
  const totalProjects = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM projects'))[0].c;
  const activeProjects = (await d.select<{ c: number }[]>("SELECT COUNT(*) as c FROM projects WHERE status='进行中'"))[0].c;
  const totalCompetitors = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM competitors'))[0].c;
  const projects = await d.select<{ id: number }[]>('SELECT id FROM projects');
  let totalCost = 0;
  for (const p of projects) {
    const boms = await d.select<{ quantity: number; cost: number }[]>('SELECT pb.quantity, p.cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?', [p.id]);
    totalCost += boms.reduce((s, b) => s + b.quantity * b.cost, 0);
  }
  const avgBomCost = projects.length > 0 ? Math.round(totalCost / projects.length * 100) / 100 : 0;
  const catDist = await d.select<{ main_category: string; c: number }[]>('SELECT main_category, COUNT(*) as c FROM parts GROUP BY main_category ORDER BY c DESC');
  const recentParts = await d.select<any[]>('SELECT * FROM parts ORDER BY updated_at DESC LIMIT 5');
  return { total_parts: totalParts, total_projects: totalProjects, active_projects: activeProjects, total_competitors: totalCompetitors, avg_bom_cost: avgBomCost, category_distribution: catDist.map(r => ({ category: r.main_category, count: r.c })), recent_parts: recentParts };
}
