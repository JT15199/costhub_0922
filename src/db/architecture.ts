import { getDb, localNow } from './core';
import { getProjectBOMs } from './projects';
import { bomExtendedCostStrict, bomPriceState, bomQuantityState } from '../ai/contracts';

export type CostLayer = 'material' | 'packaging' | 'odm_processing';
export type BaselineStatus = 'candidate' | 'confirmed' | 'expired' | 'rejected';

const SPEC_TEMPLATES: Record<string, Array<[string, string, string, string, string]>> = {
  '显示器': [['screen_size', '屏幕尺寸', 'text', '英寸', 'exact_match'], ['resolution', '分辨率', 'text', '', 'exact_match'], ['refresh_rate', '刷新率', 'number', 'Hz', 'higher_better'], ['panel_type', '面板类型', 'text', '', 'exact_match'], ['brightness', '亮度', 'number', 'nit', 'higher_better']],
  '手写笔': [['tip_size', '笔尖尺寸', 'number', 'mm', 'exact_match'], ['pressure_levels', '压感级别', 'number', '级', 'higher_better'], ['latency', '延迟', 'number', 'ms', 'lower_better']],
  '鼠标': [['sensor_dpi', '传感器 DPI', 'number', 'DPI', 'higher_better'], ['weight', '重量', 'number', 'g', 'lower_better'], ['connection', '连接方式', 'text', '', 'exact_match']],
  '包': [['capacity', '容量', 'number', 'L', 'higher_better'], ['material', '材质', 'text', '', 'exact_match'], ['weight', '重量', 'number', 'g', 'lower_better']],
  'Dock': [['ports', '接口数量', 'number', '个', 'higher_better'], ['pd_power', '供电功率', 'number', 'W', 'higher_better'], ['display_outputs', '视频输出数', 'number', '个', 'higher_better']],
};

const VALID_LAYERS = new Set<CostLayer>(['material', 'packaging', 'odm_processing']);
let ready = false;

function text(value: unknown) { return String(value ?? '').trim(); }
function num(value: unknown, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function json(value: unknown, fallback: any) { try { return JSON.parse(text(value) || JSON.stringify(fallback)); } catch { return fallback; } }
function fingerprint(value: unknown) {
  let hash = 2166136261;
  for (const ch of JSON.stringify(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function inferredLayer(row: any): CostLayer {
  if (VALID_LAYERS.has(row?.cost_layer)) return row.cost_layer;
  const category = `${row?.main_category || ''}${row?.sub_category || ''}${row?.module_name || ''}`;
  if (category.includes('包材') || category.includes('包装')) return 'packaging';
  if (category.includes('加工') || category.includes('制造')) return 'odm_processing';
  return 'material';
}

export async function ensureArchitectureData() {
  if (ready) return;
  const d = await getDb();
  await d.execute("ALTER TABLE project_boms ADD COLUMN cost_layer TEXT DEFAULT 'material'").catch(() => { });
  await d.execute("UPDATE project_boms SET cost_layer=CASE WHEN (COALESCE(main_category,'')||COALESCE(sub_category,'')||COALESCE(module_name,'')) LIKE '%包材%' OR (COALESCE(main_category,'')||COALESCE(sub_category,'')||COALESCE(module_name,'')) LIKE '%包装%' THEN 'packaging' WHEN (COALESCE(main_category,'')||COALESCE(sub_category,'')||COALESCE(module_name,'')) LIKE '%加工%' OR (COALESCE(main_category,'')||COALESCE(sub_category,'')||COALESCE(module_name,'')) LIKE '%制造%' THEN 'odm_processing' ELSE 'material' END WHERE COALESCE(cost_layer,'')='' OR cost_layer='material'").catch(() => { });
  await d.execute("UPDATE category_spec_fields SET field_key='tip_size' WHERE category_name='手写笔' AND field_key='screen_size' AND NOT EXISTS (SELECT 1 FROM category_spec_fields WHERE category_name='手写笔' AND field_key='tip_size')").catch(() => { });
  const fields = await d.select<any[]>('SELECT category_name, field_key FROM category_spec_fields');
  const existing = new Set(fields.map(row => `${row.category_name}|${row.field_key}`));
  for (const [category, template] of Object.entries(SPEC_TEMPLATES)) {
    for (const [index, [fieldKey, label, dataType, unit, direction]] of template.entries()) {
      if (existing.has(`${category}|${fieldKey}`)) continue;
      await d.execute('INSERT INTO category_spec_fields (category_name, field_key, field_label, data_type, unit, compare_direction, sort_order, required) VALUES (?,?,?,?,?,?,?,?)', [category, fieldKey, label, dataType, unit, direction, index, 0]);
    }
  }
  ready = true;
}

export async function getCategorySpecFields(category: string) {
  await ensureArchitectureData();
  return (await getDb()).select<any[]>('SELECT * FROM category_spec_fields WHERE category_name=? AND active=1 ORDER BY sort_order, id', [category || '显示器']);
}

export async function getProjectSpecProfile(projectId: number, category: string) {
  await ensureArchitectureData();
  const d = await getDb();
  const project = (await d.select<any[]>('SELECT * FROM projects WHERE id=?', [projectId]))[0] || {};
  const fields = await getCategorySpecFields(category || project.category || '显示器');
  const values = await d.select<any[]>('SELECT field_id, value_text FROM project_spec_values WHERE project_id=?', [projectId]);
  const valueMap = new Map(values.map(row => [Number(row.field_id), text(row.value_text)]));
  const legacy: Record<string, string> = { screen_size: text(project.screen_size), resolution: text(project.resolution), refresh_rate: text(project.refresh_rate), panel_type: text(project.panel_type), specs: text(project.specs), tip_size: text(project.screen_size) };
  return fields.map(field => ({ ...field, value_text: valueMap.get(Number(field.id)) ?? legacy[field.field_key] ?? '' }));
}

export async function saveProjectSpecValues(projectId: number, values: Array<{ fieldId: number; value: unknown }>) {
  await ensureArchitectureData();
  const d = await getDb();
  for (const value of values || []) {
    await d.execute("INSERT INTO project_spec_values (project_id, field_id, value_text, updated_at) VALUES (?,?,?,datetime('now','localtime')) ON CONFLICT(project_id, field_id) DO UPDATE SET value_text=excluded.value_text, updated_at=excluded.updated_at", [projectId, value.fieldId, text(value.value)]);
  }
}

export async function freezeProjectSpecBaseline(projectId: number, category: string, sourceType = 'manual') {
  const profile = await getProjectSpecProfile(projectId, category);
  const spec = Object.fromEntries(profile.map(field => [field.field_key, field.value_text]));
  const d = await getDb();
  const latest = (await d.select<any[]>('SELECT * FROM project_spec_baselines WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0];
  const fp = fingerprint(spec);
  if (latest?.fingerprint === fp) return latest.id;
  const previous = json(latest?.spec_json, {});
  const changed = Object.keys(spec).filter(key => text(previous[key]) !== text(spec[key]));
  const version = num(latest?.version_no) + 1;
  const result = await d.execute('INSERT INTO project_spec_baselines (project_id, version_no, fingerprint, spec_json, changed_fields_json, source_type) VALUES (?,?,?,?,?,?)', [projectId, version, fp, JSON.stringify(spec), JSON.stringify(changed), sourceType]);
  return Number(result.lastInsertId);
}

export async function getLatestProjectSpecBaseline(projectId: number) {
  await ensureArchitectureData();
  return (await (await getDb()).select<any[]>('SELECT * FROM project_spec_baselines WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0] || null;
}

async function currentBOM(projectId: number) {
  const rows = await getProjectBOMs(projectId);
  return rows.map(row => ({ ...row, cost_layer: inferredLayer(row), unit_cost: num(row.part_cost), price_state: bomPriceState(row), quantity_state: bomQuantityState(row), line_total: bomExtendedCostStrict(row), relation_key: `${text(row.part_name)}|${text(row.part_model)}|${text(row.part_specs)}` }));
}

export async function getCostLayerSummary(projectId: number) {
  const rows = await currentBOM(projectId);
  const layers: Record<CostLayer, number> = { material: 0, packaging: 0, odm_processing: 0 };
  rows.forEach(row => { if (row.price_state === 'confirmed' && row.quantity_state === 'confirmed' && row.line_total !== null) layers[row.cost_layer as CostLayer] += row.line_total; });
  const project = (await (await getDb()).select<any[]>('SELECT platform_fee_rate FROM projects WHERE id=?', [projectId]))[0] || {};
  const decomposable = Object.values(layers).reduce((sum, value) => sum + value, 0);
  const platformFee = decomposable * num(project.platform_fee_rate) / 100;
  const missingCostRows = rows.filter(row => row.price_state !== 'confirmed' || row.quantity_state !== 'confirmed').map(row => ({ id: row.id, name: row.part_name, model: row.part_model, module: row.module_name, layer: row.cost_layer, reason: row.quantity_state !== 'confirmed' ? (row.quantity_state === 'invalid' ? '数量无效' : '数量未确认') : '价格未确认' }));
  return { layers, decomposable, platformFee, standardCost: missingCostRows.length ? null : decomposable + platformFee, rows, missingCostRows, costStatus: missingCostRows.length ? 'unknown' : 'confirmed' };
}

export function calculateTargetAllocation(domains: Array<{ domain: string; baseline: number }>, challengeGap: number, opportunities: Record<string, number>) {
  const total = Object.values(opportunities).reduce((sum, value) => sum + Math.max(0, num(value)), 0);
  return domains.map(row => {
    const opportunity = Math.max(0, num(opportunities[row.domain]));
    const allocated = total ? Math.min(opportunity, challengeGap * opportunity / total) : 0;
    return { ...row, opportunity, allocated, target: Math.max(0, num(row.baseline) - allocated) };
  });
}

export function buildTargetDomainRows(bomRows: any[], decisions: any[], _projectId = 0) {
  const groups: Record<string, { domain: string; current: number; baseline: number }> = {};
  const materialBaselines = new Map<string, number>();
  for (const decision of decisions || []) {
    if (decision.baseline_type === 'material' && /^part:\d+$/.test(text(decision.scope_key)) && num(decision.value) >= 0) {
      const key = text(decision.scope_key);
      materialBaselines.set(key, Math.min(materialBaselines.get(key) ?? Infinity, num(decision.value)));
    }
  }
  for (const row of bomRows || []) {
    const domain = text(row.main_category) || '其他';
    const currentValue = bomExtendedCostStrict(row);
    const current = currentValue === null ? 0 : currentValue;
    const materialBaseline = materialBaselines.get(`part:${num(row.part_id)}`);
    const baseline = materialBaseline ? Math.min(current, materialBaseline * num(row.quantity, 1)) : current;
    const group = groups[domain] || { domain, current: 0, baseline: 0 };
    group.current += current;
    group.baseline += baseline;
    groups[domain] = group;
  }
  // 模块/项目决策不能凭 category 把整个领域压成一个数字；只有逐器件物料基线能安全汇总。
  return Object.values(groups).map(row => ({ ...row, opportunity: Math.max(0, row.current - row.baseline) }));
}

/**
 * 只把人工确认、且没有标记为已计入基线的变更包净机会送入目标分配。
 * 一个变更包可能同时包含节省项和必需增加项，必须先按包对账再分配，不能逐行重复扣减。
 */
export function buildConfirmedPackageOpportunities(packageLines: any[], bomRows: any[]) {
  const vector = buildConfirmedPackageDeltaVector(packageLines, bomRows);
  return Object.fromEntries(Object.entries(vector).map(([domain, delta]) => [domain, Math.max(0, -num(delta))]));
}

/** 返回已确认、证据完整、尚未计入基线的变更包完整领域向量：after-before。 */
export function buildConfirmedPackageDeltaVector(packageLines: any[], bomRows: any[]) {
  const moduleDomains = new Map<string, string>();
  for (const row of bomRows || []) {
    const module = text(row.module_name) || '其他';
    moduleDomains.set(module, text(row.main_category) || '其他');
  }
  const groups = new Map<string, any[]>();
  for (const [index, line] of (packageLines || []).entries()) {
    if (!['confirmed', 'feasibility_confirmed', 'selected'].includes(text(line.package_status))) continue;
    const key = num(line.package_id) > 0 ? `package:${num(line.package_id)}` : `line:${index}`;
    const group = groups.get(key) || [];
    group.push({ line, domain: moduleDomains.get(text(line.module_name)) || '其他' });
    groups.set(key, group);
  }
  const deltas: Record<string, number> = {};
  for (const group of groups.values()) {
    const invalid = group.some(({ line }) => {
      const evidence = json(line.evidence_json, {});
      return !Object.keys(evidence || {}).length
        || !(evidence.sourceVersionId || evidence.sourceLineId || evidence.source_version_id || evidence.source_line_id || evidence.referenceVersionId || evidence.evidence_ref)
        || [line.cost_before, line.cost_after].some(value => value === undefined || value === null || value === '' || !Number.isFinite(Number(value)))
        || evidence.baseline_included === true || evidence.baselineIncluded === true
        || evidence.opportunity_status === 'implemented' || evidence.implementation_status === 'implemented'
        || num(evidence.referenceVersionId) > 0;
    });
    if (invalid) continue;
    for (const { line, domain } of group) {
      const delta = num(line.cost_after) - num(line.cost_before);
      deltas[domain] = (deltas[domain] || 0) + delta;
    }
  }
  return deltas;
}

export async function freezeProjectBOMVersion(projectId: number, input: { versionName?: string; sourceType?: string; sourceRefId?: number; stage?: string } = {}) {
  await ensureArchitectureData();
  const d = await getDb();
  await d.execute('BEGIN');
  try {
    // 冻结所需的项目、BOM、规格、SKU 与差异必须来自同一事务，避免并发编辑混入一半新一半旧。
    const rows = await currentBOM(projectId);
    // Charter 的参考版本只作为来源留痕，冻结内容必须来自用户当前正在评估的 BOM。
    const fingerprintValue = fingerprint(rows.map(row => ({ id: row.id, part: row.part_id, module: row.module_name, quantity: row.quantity, cost: row.unit_cost, priceState: row.price_state || 'unknown', layer: row.cost_layer || 'material' })));
    const latest = (await d.select<any[]>('SELECT version_no FROM project_bom_versions WHERE project_id=? ORDER BY version_no DESC LIMIT 1', [projectId]))[0];
    const versionNo = num(latest?.version_no) + 1;
    const missingCostCount = rows.filter(row => row.price_state !== 'confirmed' || row.quantity_state !== 'confirmed').length;
    if (missingCostCount) throw new Error(`当前 BOM 有 ${missingCostCount} 行价格或数量证据缺口，不能冻结 BOM 版本`);
    const totalCost = missingCostCount ? null : rows.reduce((sum, row) => sum + row.line_total, 0);
    await d.execute("UPDATE project_bom_versions SET status='superseded' WHERE project_id=? AND status='frozen'", [projectId]);
    const project = (await d.select<any[]>('SELECT * FROM projects WHERE id=?', [projectId]))[0] || {};
    const specBaseline = (await d.select<any[]>('SELECT id, version_no, fingerprint, spec_json FROM project_spec_baselines WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0] || null;
    const skus = await d.select<any[]>('SELECT * FROM project_skus WHERE project_id=? ORDER BY id', [projectId]);
    const skuIds = skus.map(row => num(row.id)).filter(Boolean);
    const diffRows = skuIds.length ? await d.select<any[]>(`SELECT * FROM sku_diffs WHERE sku_id IN (${skuIds.map(() => '?').join(',')}) ORDER BY id`, skuIds) : [];
    const skuSnapshot = skus.map(sku => ({ ...sku, diffs: diffRows.filter(diff => num(diff.sku_id) === num(sku.id)) }));
    const projectSnapshot = { ...project, spec_baseline_id: specBaseline?.id || 0, spec_version_no: specBaseline?.version_no || 0, spec_json: json(specBaseline?.spec_json, {}), sku_snapshot: skuSnapshot, captured_at: localNow() };
    const header = await d.execute('INSERT INTO project_bom_versions (project_id, version_no, version_name, source_type, source_ref_id, stage, status, data_fingerprint, total_cost, platform_fee_rate, spec_baseline_id, project_snapshot_json, sku_snapshot_json, cost_status, missing_cost_count, frozen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [projectId, versionNo, text(input.versionName) || `BOM v${versionNo}`, text(input.sourceType) || 'manual', num(input.sourceRefId), text(input.stage), 'frozen', fingerprintValue, totalCost, num(project.platform_fee_rate), num(specBaseline?.id), JSON.stringify(projectSnapshot), JSON.stringify(skuSnapshot), missingCostCount ? 'unknown' : 'confirmed', missingCostCount, localNow()]);
    for (const row of rows) {
      await d.execute('INSERT INTO project_bom_version_lines (version_id, source_bom_id, canonical_part_id, module_name, part_name, part_model, specs, quantity, unit_cost, line_total, cost_layer, relation_key, raw_json, price_state, main_category, sub_category, source_created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [header.lastInsertId, row.id, row.part_id || 0, row.module_name || '', row.part_name || '', row.part_model || '', row.part_specs || row.specs || '', row.quantity ?? 1, row.unit_cost, row.line_total, row.cost_layer, row.relation_key, JSON.stringify(row), row.price_state, row.main_category || '', row.sub_category || '', row.created_at || '']);
    }
    await d.execute('COMMIT');
    void import('./worklog').then(({ recordSystemWorkLog }) => recordSystemWorkLog(projectId, text(input.stage) || 'PDCP', 'BOM版本冻结', `已冻结${text(input.versionName) || `BOM v${versionNo}`}，标准成本 ${totalCost == null ? '待补证据' : totalCost.toFixed(2)} 元。`, [`project_bom_versions#${header.lastInsertId}`])).catch(() => { });
    return Number(header.lastInsertId);
  } catch (error) {
    await d.execute('ROLLBACK').catch(() => { });
    throw error;
  }
}

export async function getProjectBOMVersions(projectId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM project_bom_versions WHERE project_id=? ORDER BY version_no DESC', [projectId]); }
export async function getProjectBOMVersionLines(versionId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM project_bom_version_lines WHERE version_id=? ORDER BY module_name, id', [versionId]); }

export async function getChangePackages(projectId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM project_change_packages WHERE project_id=? ORDER BY id DESC', [projectId]); }
export async function createChangePackage(input: any) {
  await ensureArchitectureData();
  const d = await getDb();
  await d.execute('BEGIN');
  try {
    const result = await d.execute('INSERT INTO project_change_packages (project_id, title, trigger_type, trigger_field, before_value, after_value, source_version_id, status, confidence, rationale) VALUES (?,?,?,?,?,?,?,?,?,?)', [input.projectId, text(input.title), text(input.triggerType) || 'other', text(input.triggerField), text(input.beforeValue), text(input.afterValue), num(input.sourceVersionId), 'draft', num(input.confidence), text(input.rationale)]);
    for (const line of input.lines || []) await d.execute('INSERT INTO project_change_package_lines (package_id, action, before_line_id, after_part_id, module_name, quantity_before, quantity_after, cost_before, cost_after, dependency_role, evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [result.lastInsertId, text(line.action) || 'add', num(line.beforeLineId), num(line.afterPartId), text(line.moduleName), num(line.quantityBefore), num(line.quantityAfter), num(line.costBefore), num(line.costAfter), text(line.dependencyRole) || 'optional', JSON.stringify(line.evidence || {})]);
    await d.execute('COMMIT');
    return Number(result.lastInsertId);
  } catch (error) {
    await d.execute('ROLLBACK').catch(() => { });
    throw error;
  }
}
export async function setChangePackageStatus(id: number, status: 'confirmed' | 'feasibility_confirmed' | 'selected' | 'rejected' | 'draft') {
  await ensureArchitectureData();
  const d = await getDb();
  if (['confirmed', 'feasibility_confirmed', 'selected'].includes(status)) {
    const lines = await d.select<any[]>('SELECT * FROM project_change_package_lines WHERE package_id=? ORDER BY id', [id]);
    if (!lines.length) throw new Error('变更包没有明细，不能确认');
    const invalid = lines.some(line => {
      const evidence = json(line.evidence_json, {});
      return !Object.keys(evidence || {}).length
        || !(evidence.sourceVersionId || evidence.sourceLineId || evidence.source_version_id || evidence.source_line_id || evidence.referenceVersionId || evidence.evidence_ref)
        || [line.cost_before, line.cost_after].some(value => value === undefined || value === null || value === '' || !Number.isFinite(Number(value)));
    });
    if (invalid) throw new Error('变更包存在缺少证据或成本的明细，不能确认');
  }
  await d.execute("UPDATE project_change_packages SET status=?, confirmed_at=CASE WHEN ? IN ('confirmed','feasibility_confirmed','selected') THEN datetime('now','localtime') ELSE confirmed_at END WHERE id=?", [status, status, id]);
}
export async function getChangePackageLines(packageId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM project_change_package_lines WHERE package_id=? ORDER BY id', [packageId]); }
export async function updateChangePackageLine(id: number, input: { quantityBefore?: number; quantityAfter?: number; costBefore?: number; costAfter?: number; dependencyRole?: string; evidence?: unknown }) {
  await ensureArchitectureData();
  const d = await getDb();
  const evidence = input.evidence === undefined ? undefined : JSON.stringify(input.evidence || {});
  await d.execute("UPDATE project_change_package_lines SET quantity_before=COALESCE(?,quantity_before), quantity_after=COALESCE(?,quantity_after), cost_before=COALESCE(?,cost_before), cost_after=COALESCE(?,cost_after), dependency_role=COALESCE(NULLIF(?,''),dependency_role), evidence_json=COALESCE(?,evidence_json) WHERE id=? AND package_id IN (SELECT id FROM project_change_packages WHERE status='draft')", [input.quantityBefore ?? null, input.quantityAfter ?? null, input.costBefore ?? null, input.costAfter ?? null, input.dependencyRole || '', evidence ?? null, id]);
}
export async function markChangePackageImplemented(id: number, resultVersionId: number, evidence: unknown = {}) {
  await ensureArchitectureData();
  if (!resultVersionId) throw new Error('实施必须关联已冻结的 BOM 版本');
  const d = await getDb();
  const pkg = (await d.select<any[]>('SELECT * FROM project_change_packages WHERE id=? AND status IN (\'confirmed\',\'feasibility_confirmed\',\'selected\')', [id]))[0];
  if (!pkg) throw new Error('变更包不存在、已拒绝或已实施');
  const version = (await d.select<any[]>('SELECT id FROM project_bom_versions WHERE id=? AND project_id=? AND status=\'frozen\'', [resultVersionId, pkg.project_id]))[0];
  if (!version) throw new Error('实施结果必须是同一项目的已冻结 BOM 版本');
  const lines = await getChangePackageLines(id);
  if (!lines.length) throw new Error('变更包没有明细，不能标记实施');
  await d.execute("UPDATE project_change_packages SET status='implemented', implemented_version_id=?, implementation_evidence_json=?, implemented_at=datetime('now','localtime') WHERE id=? AND status IN ('confirmed','feasibility_confirmed','selected')", [resultVersionId, JSON.stringify({ ...((evidence && typeof evidence === 'object') ? evidence : {}), lineIds: lines.map(line => line.id) }), id]);
}

export async function getBaselineDecisions(projectId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM cost_baseline_decisions WHERE project_id=? OR project_id=0 ORDER BY status, id DESC', [projectId]); }
export async function createBaselineDecision(input: any) {
  await ensureArchitectureData();
  const d = await getDb();
  const existing = (await d.select<any[]>('SELECT id FROM cost_baseline_decisions WHERE project_id=? AND baseline_type=? AND scope_key=? AND ABS(value-?)<0.000001 AND status IN (\'candidate\',\'confirmed\') ORDER BY id DESC LIMIT 1', [input.projectId || 0, input.baselineType || 'module', text(input.scopeKey), num(input.value)]))[0];
  if (existing) return Number(existing.id);
  const result = await d.execute('INSERT INTO cost_baseline_decisions (project_id, baseline_type, category, scope_key, source_type, source_ref_id, value, comparable_rule_json, status, rationale) VALUES (?,?,?,?,?,?,?,?,?,?)', [input.projectId || 0, input.baselineType || 'module', text(input.category), text(input.scopeKey), text(input.sourceType) || 'project_bom', num(input.sourceRefId), num(input.value), JSON.stringify(input.comparableRule || {}), 'candidate', text(input.rationale)]);
  return Number(result.lastInsertId);
}
export async function setBaselineDecisionStatus(id: number, status: BaselineStatus, rationale = '') { await ensureArchitectureData(); await (await getDb()).execute("UPDATE cost_baseline_decisions SET status=?, rationale=CASE WHEN ?<>'' THEN ? ELSE rationale END, confirmed_at=CASE WHEN ?='confirmed' THEN datetime('now','localtime') ELSE confirmed_at END WHERE id=?", [status, rationale, rationale, status, id]); }
export async function updateBaselineDecision(id: number, value: number, rationale = '') { await ensureArchitectureData(); await (await getDb()).execute('UPDATE cost_baseline_decisions SET value=?, status=\'candidate\', confirmed_at=\'\', rationale=CASE WHEN ?<>\'\' THEN ? ELSE rationale END WHERE id=?', [Math.max(0, num(value)), rationale, rationale, id]); }

export async function previewProjectTargetVersion(projectId: number, targetCost: number, platformFeeRate: number) {
  await ensureArchitectureData();
  const d = await getDb();
  const summary = await getCostLayerSummary(projectId);
  const decomposableTarget = num(targetCost) / (1 + num(platformFeeRate) / 100);
  const decisions = await d.select<any[]>('SELECT project_id, baseline_type, category, scope_key, value FROM cost_baseline_decisions WHERE (project_id=? OR project_id=0) AND status=\'confirmed\'', [projectId]);
  const versionRow = (await d.select<any[]>('SELECT version_no FROM project_target_versions WHERE project_id=? ORDER BY version_no DESC LIMIT 1', [projectId]))[0];
  const versionNo = num(versionRow?.version_no) + 1;
  // 与标准成本口径复用同一份 BOM 行，避免旧行只有 parts.cost 而快照列为 0 时目标被低估。
  const targetRows = buildTargetDomainRows(summary.rows, decisions, projectId);
  const baselineCost = targetRows.reduce((sum, row) => sum + row.baseline, 0);
  const challengeGap = Math.max(0, baselineCost - decomposableTarget);
  // 基线已体现在 baselineCost 中；只接入独立、人工确认的变更包机会，避免重复扣减。
  const packageLines = await d.select<any[]>("SELECT p.id AS package_id, p.status AS package_status, l.module_name, l.cost_before, l.cost_after, l.evidence_json, l.dependency_role FROM project_change_packages p JOIN project_change_package_lines l ON l.package_id=p.id WHERE p.project_id=? AND p.status IN ('confirmed','feasibility_confirmed','selected')", [projectId]).catch(() => []);
  const packageDelta = buildConfirmedPackageDeltaVector(packageLines, summary.rows);
  const opportunityTotal = Math.max(0, -Object.values(packageDelta).reduce((sum, value) => sum + num(value), 0));
  // 变更包对每个领域的完整 delta 直接落位，禁止把包净额按领域比例摊薄。
  const result = targetRows.map(row => { const delta = num(packageDelta[row.domain]); const target = Math.max(0, row.baseline + delta); return { ...row, opportunity: Math.max(0, -delta), allocated: Math.max(0, row.baseline - target), target, packageDelta: delta }; });
  return { versionNo, decomposableTarget, baselineCost, challengeGap, confirmedOpportunity: opportunityTotal, uncoveredGap: Math.max(0, challengeGap - opportunityTotal), missingCostRows: summary.missingCostRows, rows: result };
}

export async function createProjectTargetVersion(projectId: number, targetCost: number, platformFeeRate: number, sourceVersionIds: Record<string, number> = {}) {
  const preview = await previewProjectTargetVersion(projectId, targetCost, platformFeeRate);
  const { versionNo, decomposableTarget, baselineCost, challengeGap, confirmedOpportunity: opportunityTotal, rows: result, missingCostRows } = preview;
  if (missingCostRows.length) throw new Error(`当前 BOM 有 ${missingCostRows.length} 行成本或数量证据缺口，不能冻结目标版本`);
  await ensureArchitectureData();
  const d = await getDb();
  let header: any;
  await d.execute('BEGIN');
  try {
    await d.execute("UPDATE project_targets SET status='superseded' WHERE project_id=? AND COALESCE(status,'draft')<>'superseded'", [projectId]);
    header = await d.execute('INSERT INTO project_target_versions (project_id, version_no, target_cost, baseline_cost, challenge_gap, status, source_version_ids, frozen_at) VALUES (?,?,?,?,?,?,?,?)', [projectId, versionNo, num(targetCost), baselineCost, challengeGap, 'frozen', JSON.stringify(sourceVersionIds), localNow()]);
    for (const row of result) await d.execute('INSERT INTO project_targets (project_id, domain, target_cost, remark, version_id, baseline_cost, opportunity_amount, allocated_challenge, status) VALUES (?,?,?,?,?,?,?,?,?)', [projectId, row.domain, row.target, `目标版本 v${versionNo}`, header.lastInsertId, row.baseline, row.opportunity, row.allocated, 'frozen']);
    await d.execute('COMMIT');
  } catch (error) {
    await d.execute('ROLLBACK').catch(() => { });
    throw error;
  }
  void import('./worklog').then(({ recordSystemWorkLog }) => recordSystemWorkLog(projectId, 'CDCP', '目标成本冻结', `已冻结目标版本 v${versionNo}，目标 ${num(targetCost).toFixed(2)} 元，未覆盖缺口 ${Math.max(0, challengeGap - opportunityTotal).toFixed(2)} 元。`, [`project_target_versions#${header.lastInsertId}`])).catch(() => { });
  return { id: Number(header.lastInsertId), versionNo, baselineCost, decomposableTarget, challengeGap, confirmedOpportunity: opportunityTotal, uncoveredGap: Math.max(0, challengeGap - opportunityTotal), missingCostRows, rows: result };
}

export async function getProjectTargetVersions(projectId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM project_target_versions WHERE project_id=? ORDER BY version_no DESC', [projectId]); }
export async function getProjectTargetRows(versionId: number) { await ensureArchitectureData(); return (await getDb()).select<any[]>('SELECT * FROM project_targets WHERE version_id=? ORDER BY domain, id', [versionId]); }
