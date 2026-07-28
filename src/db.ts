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
export async function getMainCategories(): Promise<string[]> {
  const d = await getDb();
  const r = await d.select<{ mc: string }[]>('SELECT DISTINCT main_category as mc FROM parts UNION SELECT DISTINCT domain as mc FROM project_targets ORDER BY mc');
  const defaults = ['硬件类', '结构类', '电源类', '线材类', '包材类', '加工费类', '软件类', '其他'];
  return [...new Set([...defaults, ...r.map(x => x.mc)])];
}
export async function getSubCategories(mainCat: string): Promise<string[]> {
  const r = await (await getDb()).select<{ sc: string }[]>('SELECT DISTINCT sub_category as sc FROM parts WHERE main_category = ? ORDER BY sc', [mainCat]);
  return r.map(x => x.sc).filter(Boolean);
}

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
export async function addBOMItem(projectId: number, partId: number, quantity = 1, moduleName = '', remark = '', refProjectId = 0) {
  await (await getDb()).execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id) VALUES (?,?,?,?,?,?)', [projectId, partId, moduleName, quantity, remark, refProjectId]);
}
export async function updateBOMItem(id: number, quantity: number, moduleName: string, remark: string) {
  await (await getDb()).execute('UPDATE project_boms SET quantity=?, module_name=?, remark=? WHERE id=?', [quantity, moduleName, remark, id]);
}
export async function updateBOMRefProject(moduleName: string, projectId: number, refProjectId: number) {
  await (await getDb()).execute('UPDATE project_boms SET ref_project_id=? WHERE project_id=? AND module_name=?', [refProjectId, projectId, moduleName]);
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

// ==================== Project Targets ====================
export async function getTargets(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_targets WHERE project_id = ? ORDER BY domain', [projectId]); }
export async function saveTarget(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_targets SET domain=?, target_cost=?, remark=? WHERE id=?', [data.domain, data.target_cost || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_targets (project_id, domain, target_cost, remark) VALUES (?,?,?,?)', [data.project_id, data.domain, data.target_cost || 0, data.remark || '']); return r.lastInsertId; }
}
export async function deleteTarget(id: number) { await (await getDb()).execute('DELETE FROM project_targets WHERE id = ?', [id]); }

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

// ==================== Trend Tracking ====================
export { getDb };

export async function getTrendItem(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_items WHERE id = ?', [id]).then(r => r[0] || null);
}

export async function getTrendItemByCategory(category: string, categoryType: string) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_items WHERE query_category = ? AND category_type = ?', [category, categoryType]).then(r => r[0] || null);
}

export async function getTrendItemsWithDetails() {
  const items = await (await getDb()).select<any[]>('SELECT * FROM trend_items ORDER BY query_category');
  const result = [];
  for (const item of items) {
    const mappedParts = await (await getDb()).select<any[]>('SELECT p.* FROM parts p JOIN trend_part_mapping tpm ON p.id = tpm.part_id WHERE tpm.trend_item_id = ?', [item.id]);
    result.push({ ...item, mapped_parts: mappedParts });
  }
  return result;
}

export async function saveTrendItem(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      'UPDATE trend_items SET query_category=?, category_type=?, trend_direction=?, confidence_level=?, summary=?, suggested_action=?, raw_search_results=?, last_updated_at=?, magnitude_min=?, magnitude_max=?, magnitude_reference=? WHERE id=?',
      [data.query_category, data.category_type, data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO trend_items (query_category, category_type, trend_direction, confidence_level, summary, suggested_action, raw_search_results, last_updated_at, magnitude_min, magnitude_max, magnitude_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [data.query_category, data.category_type || '直接查询', data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference]
    );
    return r.lastInsertId;
  }
}

export async function deleteTrendItem(id: number) {
  await (await getDb()).execute('DELETE FROM trend_items WHERE id = ?', [id]);
}

export async function addTrendMapping(trendItemId: number, partId: number) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM trend_part_mapping WHERE trend_item_id = ? AND part_id = ?', [trendItemId, partId]);
  if (existing.length === 0) {
    await d.execute('INSERT INTO trend_part_mapping (trend_item_id, part_id) VALUES (?,?)', [trendItemId, partId]);
  }
}

export async function getTrendSources(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_sources WHERE trend_item_id = ? ORDER BY id', [trendItemId]);
}

export async function saveTrendSource(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_sources (trend_item_id, source_title, source_url, excerpt) VALUES (?,?,?,?)',
    [data.trend_item_id, data.source_title, data.source_url, data.excerpt]
  );
  return r.lastInsertId;
}

export async function clearTrendSources(trendItemId: number) {
  await (await getDb()).execute('DELETE FROM trend_sources WHERE trend_item_id = ?', [trendItemId]);
}

export async function getTrendConversations(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_conversations WHERE trend_item_id = ? ORDER BY created_at', [trendItemId]);
}

export async function saveTrendConversation(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_conversations (trend_item_id, question, answer, created_at) VALUES (?,?,?,datetime(\'now\',\'localtime\'))',
    [data.trend_item_id, data.question, data.answer]
  );
  return r.lastInsertId;
}

export async function getTrendSnapshots(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY query_time DESC', [trendItemId]);
}

export async function getLatestTrendSnapshot(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY query_time DESC LIMIT 1', [trendItemId]).then(r => r[0] || null);
}

export async function saveTrendSnapshot(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_snapshots (trend_item_id, query_time, direction, confidence, summary, suggested_action, skill_used, magnitude_min, magnitude_max, magnitude_reference) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [data.trend_item_id, data.query_time, data.direction, data.confidence, data.summary, data.suggested_action, data.skill_used, data.magnitude_min, data.magnitude_max, data.magnitude_reference]
  );
  return r.lastInsertId;
}

export async function getTrendInsightDimensions(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_insight_dimensions WHERE trend_snapshot_id = ? ORDER BY dimension_order', [snapshotId]);
}

export async function saveTrendInsightDimensions(snapshotId: number, dimensions: any[]) {
  const d = await getDb();
  await d.execute('DELETE FROM trend_insight_dimensions WHERE trend_snapshot_id = ?', [snapshotId]);
  for (const dim of dimensions) {
    await d.execute(
      'INSERT INTO trend_insight_dimensions (trend_snapshot_id, dimension_type, dimension_order, content, evidence_strength, data_points, source_title, source_url) VALUES (?,?,?,?,?,?,?,?)',
      [snapshotId, dim.dimension_type, dim.dimension_order, dim.content || dim.observation, dim.evidence_strength, dim.data_points, dim.source_title, dim.source_url]
    );
  }
}

export async function getTrendKeyEvents(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_key_events WHERE trend_snapshot_id = ? ORDER BY event_date DESC', [snapshotId]);
}

export async function saveTrendKeyEvent(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_key_events (trend_snapshot_id, event_date, event_description, impact_direction, source_title, source_url) VALUES (?,?,?,?,?,?)',
    [data.trend_snapshot_id, data.event_date || data.event_time, data.event_description, data.impact_direction || data.impact_level, data.source_title, data.source_url]
  );
  return r.lastInsertId;
}

export async function getMaterialCategories() {
  return (await getDb()).select<any[]>('SELECT * FROM material_categories ORDER BY category_name');
}

export async function addMaterialCategory(categoryName: string) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM material_categories WHERE category_name = ?', [categoryName]);
  if (existing.length === 0) {
    await d.execute('INSERT INTO material_categories (category_name) VALUES (?)', [categoryName]);
  }
}

export async function removeMaterialCategory(categoryName: string) {
  await (await getDb()).execute('DELETE FROM material_categories WHERE category_name = ?', [categoryName]);
}

// ==================== API Providers ====================
export const PRESET_PROVIDERS = [
  { provider_name: 'Serper', provider_type: 'search', api_key: '', priority: 1, enabled: true, monthly_quota_note: '免费2500次/月', base_url: 'https://google.serper.dev', model_name: '', registration_url: 'https://serper.dev' },
  { provider_name: 'Tavily', provider_type: 'search', api_key: '', priority: 2, enabled: false, monthly_quota_note: '免费1000次/月', base_url: 'https://api.tavily.com', model_name: '', registration_url: 'https://tavily.com' },
  { provider_name: 'Bing', provider_type: 'search', api_key: '', priority: 3, enabled: false, monthly_quota_note: '按量计费', base_url: 'https://api.bing.microsoft.com', model_name: '', registration_url: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api' },
  { provider_name: 'OpenAI', provider_type: 'llm', api_key: '', priority: 1, enabled: true, monthly_quota_note: '按量计费', base_url: 'https://api.openai.com/v1', model_name: 'gpt-4o-mini', registration_url: 'https://platform.openai.com' },
  { provider_name: 'Anthropic', provider_type: 'llm', api_key: '', priority: 2, enabled: false, monthly_quota_note: '按量计费', base_url: 'https://api.anthropic.com', model_name: 'claude-3-haiku-20240307', registration_url: 'https://www.anthropic.com' },
];

export async function getApiProviders() {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers ORDER BY provider_type, priority');
}

export async function saveApiProvider(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      'UPDATE api_providers SET provider_name=?, provider_type=?, api_key=?, priority=?, enabled=? WHERE id=?',
      [data.provider_name, data.provider_type, data.api_key, data.priority, data.enabled ? 1 : 0, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO api_providers (provider_name, provider_type, api_key, priority, enabled) VALUES (?,?,?,?,?)',
      [data.provider_name, data.provider_type, data.api_key, data.priority || 0, data.enabled ? 1 : 0]
    );
    return r.lastInsertId;
  }
}

export async function deleteApiProvider(id: number) {
  await (await getDb()).execute('DELETE FROM api_providers WHERE id = ?', [id]);
}

export async function setActiveProvider(providerType: string, providerId: number) {
  const d = await getDb();
  await d.execute('UPDATE api_providers SET enabled = 0 WHERE provider_type = ?', [providerType]);
  await d.execute('UPDATE api_providers SET enabled = 1 WHERE id = ?', [providerId]);
}

export async function updateProviderPriorities(providers: any[]) {
  const d = await getDb();
  for (const p of providers) {
    await d.execute('UPDATE api_providers SET priority = ? WHERE id = ?', [p.priority, p.id]);
  }
}

export async function getOutboundRequestLogs(limit = 100) {
  return (await getDb()).select<any[]>('SELECT * FROM outbound_request_logs ORDER BY timestamp DESC LIMIT ?', [limit]);
}

export async function clearOutboundRequestLogs() {
  await (await getDb()).execute('DELETE FROM outbound_request_logs');
}

export async function logOutboundRequest(data: any) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO outbound_request_logs (timestamp, method, url, status_code, response_time_ms, error_message) VALUES (datetime(\'now\',\'localtime\'),?,?,?,?,?)',
    [data.method, data.url, data.status_code, data.response_time_ms, data.error_message]
  );
}

// ==================== Decomposition ====================
export async function getAllDecompositionNodes() {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree ORDER BY root_part_id, parent_id');
}

export async function getDecompositionTree(rootPartId: number) {
  const d = await getDb();
  const nodes = await d.select<any[]>('SELECT * FROM decomposition_tree WHERE root_part_id = ?', [rootPartId]);
  return nodes;
}

export async function getDecompositionNode(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree WHERE id = ?', [id]).then(r => r[0] || null);
}

export async function saveDecompositionNode(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      'UPDATE decomposition_tree SET node_name=?, node_type=?, estimated_cost=?, remark=?, ai_insights=? WHERE id=?',
      [data.node_name, data.node_type, data.estimated_cost, data.remark, data.ai_insights, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO decomposition_tree (root_part_id, parent_id, node_name, node_type, estimated_cost, remark, ai_insights, created_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
      [data.root_part_id, data.parent_id, data.node_name, data.node_type, data.estimated_cost || 0, data.remark, data.ai_insights]
    );
    return r.lastInsertId;
  }
}

export async function deleteDecompositionNode(id: number) {
  await (await getDb()).execute('DELETE FROM decomposition_tree WHERE id = ?', [id]);
}

export async function getDecompositionHistory(rootPartId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_history WHERE root_part_id = ? ORDER BY timestamp DESC', [rootPartId]);
}

export async function searchDecompositionNodes(query: string) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree WHERE node_name LIKE ? ORDER BY id', [`%${query}%`]);
}

export async function saveRollupContribution(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO rollup_contributions (project_id, node_id, contribution_amount, contribution_type, remark) VALUES (?,?,?,?,?)',
    [data.project_id, data.node_id, data.contribution_amount, data.contribution_type, data.remark]
  );
  return r.lastInsertId;
}

export async function saveRollupFeedback(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO rollup_feedback (rollup_id, feedback_type, feedback_content, created_at) VALUES (?,?,?,datetime(\'now\',\'localtime\'))',
    [data.rollup_id, data.feedback_type, data.feedback_content]
  );
  return r.lastInsertId;
}

// ==================== Analysis Checklist ====================
export async function getAllChecklistWithLogs() {
  const d = await getDb();
  const items = await d.select<any[]>('SELECT * FROM analysis_checklist ORDER BY category, check_order');
  const logs = await d.select<any[]>('SELECT * FROM checklist_logs ORDER BY checked_at DESC LIMIT 1000');
  return { items, logs };
}

export async function updateChecklistActive(id: number, active: boolean) {
  await (await getDb()).execute('UPDATE analysis_checklist SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

export async function deleteAnalysisChecklistItem(id: number) {
  await (await getDb()).execute('DELETE FROM analysis_checklist WHERE id = ?', [id]);
}

export async function getRollupContributions(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM rollup_contributions WHERE project_id = ?', [projectId]);
}

export async function getAllRollupFeedback() {
  return (await getDb()).select<any[]>('SELECT * FROM rollup_feedback ORDER BY created_at DESC');
}

// ==================== Part Suppliers ====================
export async function getAllPartSuppliers() {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers ORDER BY part_id, priority');
}

export async function getPartSuppliers(partId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers WHERE part_id = ? ORDER BY priority', [partId]);
}

export async function addPartSupplier(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO part_suppliers (part_id, supplier_name, unit_price, moq, lead_time, priority, remark) VALUES (?,?,?,?,?,?,?)',
    [data.part_id, data.supplier_name, data.unit_price, data.moq, data.lead_time, data.priority || 0, data.remark]
  );
  return r.lastInsertId;
}

export async function updatePartSupplier(data: any) {
  const d = await getDb();
  await d.execute(
    'UPDATE part_suppliers SET supplier_name=?, unit_price=?, moq=?, lead_time=?, priority=?, remark=? WHERE id=?',
    [data.supplier_name, data.unit_price, data.moq, data.lead_time, data.priority, data.remark, data.id]
  );
  return data.id;
}

export async function deletePartSupplier(id: number) {
  await (await getDb()).execute('DELETE FROM part_suppliers WHERE id = ?', [id]);
}

export async function getProjectSuppliers(projectId: number) {
  return (await getDb()).select<any[]>('SELECT DISTINCT supplier_name FROM part_suppliers ps JOIN project_boms pb ON ps.part_id = pb.part_id WHERE pb.project_id = ?', [projectId]);
}

export async function getSupplierPriceHistory(partId: number, supplierName: string) {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_price_history WHERE part_id = ? AND supplier_name = ? ORDER BY recorded_at DESC', [partId, supplierName]);
}

// ==================== API Providers ====================
export async function getAllApiProviders() {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers ORDER BY provider_type, priority');
}

export async function getApiProvidersByType(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? ORDER BY priority', [type]);
}

export async function getActiveApiProviders(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? AND is_active = 1 ORDER BY priority', [type]);
}

export async function addApiProvider(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO api_providers (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [data.provider_type, data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.is_preset ? 1 : 0, data.monthly_quota_note || '', data.registration_url || '']
  );
  return r.lastInsertId;
}

export async function updateApiProvider(data: any) {
  const d = await getDb();
  await d.execute(
    'UPDATE api_providers SET provider_name=?, api_key=?, base_url=?, model_name=?, is_active=?, priority=?, monthly_quota_note=?, registration_url=? WHERE id=?',
    [data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.monthly_quota_note || '', data.registration_url || '', data.id]
  );
  return data.id;
}

export async function toggleApiProviderActive(id: number, isActive: boolean) {
  await (await getDb()).execute('UPDATE api_providers SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}
