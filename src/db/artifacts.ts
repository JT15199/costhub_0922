import { getDb } from './core';

export type AnalysisDomain = 'material' | 'project' | 'quote' | 'product' | 'unclassified';
export type AnalysisResultForm = 'material_overview' | 'material_decomposition' | 'project_cost' | 'quote_review' | 'product_voice' | 'generic_ai';
export interface AnalysisArtifactInput { type?: string; title: string; summary?: string; data: unknown; source?: unknown; dataFingerprint?: string; sourceVersionIds?: unknown; sessionId?: number | null; }
export interface AnalysisArtifact { id: number; artifact_type: string; artifact_source?: string; title: string; summary: string; data_json: string; source_json: string; data_fingerprint?: string; source_version_ids?: string; session_id: number; created_at: string; updated_at: string; }
export interface AnalysisLibraryItem extends AnalysisArtifact { item_key: string; domain: AnalysisDomain; result_form: AnalysisResultForm; object_type: string; object_id: string; object_name: string; favorite: boolean; archived: boolean; freshness?: 'current' | 'stale' | 'draft'; }

const json = (value: unknown, fallback: unknown) => { try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); } };
const parse = <T,>(value: unknown, fallback: T): T => { try { const v = JSON.parse(String(value || '')); return v ?? fallback; } catch { return fallback; } };
const fingerprint = (value: unknown) => { let hash = 2166136261; for (const ch of JSON.stringify(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); };

export function classifyArtifact(input: { artifactSource?: string; artifactType?: string; toolIds?: string[] }): { domain: AnalysisDomain; resultForm: AnalysisResultForm } {
  const source = input.artifactSource || input.artifactType || '';
  if (source === 'trend_snapshot' || source === 'material') return { domain: 'material', resultForm: 'material_overview' };
  if (source === 'project_analysis' || source === 'project' || input.artifactType === 'phase_cost_package') return { domain: 'project', resultForm: 'project_cost' };
  if (source === 'quote_review' || source === 'quote') return { domain: 'quote', resultForm: 'quote_review' };
  if (source === 'selling_analysis' || source === 'product') return { domain: 'product', resultForm: 'product_voice' };
  const tools = new Set(input.toolIds || []);
  if ([...tools].some(id => ['insight_material_trend', 'query_material_insight', 'query_supplier_trend'].includes(id))) return { domain: 'material', resultForm: 'material_overview' };
  if ([...tools].some(id => ['query_project_cost', 'query_project_bom', 'query_target_status', 'query_project_health', 'query_project_module_value'].includes(id))) return { domain: 'project', resultForm: 'project_cost' };
  if ([...tools].some(id => ['quote_review', 'query_tender_analysis', 'rank_quote_negotiations', 'explain_quote_change'].includes(id))) return { domain: 'quote', resultForm: 'quote_review' };
  if ([...tools].some(id => ['query_voice_dims', 'save_selling_analysis'].includes(id))) return { domain: 'product', resultForm: 'product_voice' };
  return { domain: 'unclassified', resultForm: 'generic_ai' };
}
const itemKey = (source: string, id: number) => `${source}:${id}`;
const toolIds = (data: any) => Array.isArray(data?.steps) ? data.steps.map((s: any) => String(s?.name || '')).filter(Boolean) : [];
function objectFrom(data: any, domain: AnalysisDomain, fallback = '') {
  const args = Array.isArray(data?.steps) ? data.steps.map((s: any) => s?.args || {}).reduce((a: any, b: any) => ({ ...a, ...b }), {}) : {};
  if (domain === 'project') return { type: 'project', id: String(data?.projectId || args.project_id || ''), name: String(args.project_code || args.project_name || data?.projectCode || fallback) };
  if (domain === 'material') return { type: 'material', id: String(args.material_name || args.material || ''), name: String(args.material_name || args.material || fallback) };
  if (domain === 'product') return { type: 'product', id: String(args.product || ''), name: String(args.product || fallback) };
  if (domain === 'quote') return { type: 'quote_batch', id: String(args.project_code || ''), name: String(args.project_code || fallback || '报价批次') };
  return { type: '', id: '', name: fallback };
}
async function ensureArtifactTables() {
  const d = await getDb();
  await d.execute(`CREATE TABLE IF NOT EXISTS analysis_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_type TEXT NOT NULL DEFAULT 'ai_analysis', title TEXT NOT NULL, summary TEXT DEFAULT '', data_json TEXT NOT NULL DEFAULT '{}', source_json TEXT NOT NULL DEFAULT '[]', data_fingerprint TEXT DEFAULT '', source_version_ids TEXT DEFAULT '{}', session_id INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  await d.execute("ALTER TABLE analysis_artifacts ADD COLUMN data_fingerprint TEXT DEFAULT ''").catch(() => { });
  await d.execute("ALTER TABLE analysis_artifacts ADD COLUMN source_version_ids TEXT DEFAULT '{}'").catch(() => { });
  await d.execute(`CREATE TABLE IF NOT EXISTS analysis_item_meta (item_key TEXT PRIMARY KEY, domain TEXT DEFAULT '', object_type TEXT DEFAULT '', object_id TEXT DEFAULT '', object_name TEXT DEFAULT '', favorite INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now','localtime')))`);
}
export async function saveAnalysisArtifact(input: AnalysisArtifactInput) {
  await ensureArtifactTables();
  const r = await (await getDb()).execute('INSERT INTO analysis_artifacts (artifact_type,title,summary,data_json,source_json,data_fingerprint,source_version_ids,session_id) VALUES (?,?,?,?,?,?,?,?)', [input.type || 'ai_analysis', input.title.slice(0, 160), (input.summary || '').slice(0, 2000), json(input.data, {}), json(input.source, []), String(input.dataFingerprint || ''), json(input.sourceVersionIds, {}), input.sessionId || 0]);
  return Number(r.lastInsertId || 0);
}
export async function getAnalysisArtifacts(limit = 100): Promise<AnalysisArtifact[]> { await ensureArtifactTables(); return (await getDb()).select<AnalysisArtifact[]>('SELECT * FROM analysis_artifacts ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(limit, 300))]); }
function viewItem(row: any, meta: any = {}): AnalysisLibraryItem {
  const data = parse<any>(row.data_json, {});
  const source = String(row.artifact_source || 'ai_panel');
  const info = classifyArtifact({ artifactSource: source === 'ai_panel' ? '' : source, artifactType: row.artifact_type, toolIds: toolIds(data) });
  const fallback = String(row.object_name || row.title || '');
  const object = objectFrom(data, meta.domain || info.domain, fallback);
  return { ...row, item_key: itemKey(source, Number(row.id)), domain: (meta.domain || info.domain) as AnalysisDomain, result_form: info.domain === 'material' && data.decomposition ? 'material_decomposition' : info.resultForm, object_type: meta.object_type || object.type, object_id: meta.object_id || object.id, object_name: meta.object_name || object.name || fallback, favorite: Boolean(Number(meta.favorite)), archived: Boolean(Number(meta.archived)) };
}
export async function getAnalysisLibraryItems(limit = 120): Promise<AnalysisLibraryItem[]> {
  await ensureArtifactTables();
  const [saved, projects, quotes, recommendations] = await Promise.all([getAnalysisArtifacts(limit), import('./projects').then(m => m.getProjectAnalysis(limit)).catch(() => [] as any[]), import('./projects').then(m => m.getQuoteReviewLogs(limit)).catch(() => [] as any[]), import('./ai').then(m => m.getRecommendations()).catch(() => [] as any[])]);
  const d = await getDb();
  let selling: any[] = [], trends: any[] = [];
  try { selling = await d.select<any[]>('SELECT * FROM selling_point_analysis ORDER BY id DESC LIMIT ?', [limit]); } catch { }
  try { trends = await d.select<any[]>('SELECT ts.*, ti.query_category, ti.id AS trend_item_id FROM trend_snapshots ts LEFT JOIN trend_items ti ON ti.id = ts.trend_item_id ORDER BY ts.id DESC LIMIT ?', [limit]); } catch { }
  const legacy = [
    ...projects.map((r: any) => ({ id: r.id, artifact_source: 'project_analysis', artifact_type: 'project_analysis', title: `项目分析 · ${r.project_code || '未命名项目'}`, summary: r.conclusion || '', data_json: json({ answer: r.conclusion || '', project_code: r.project_code }, {}), source_json: '[]', session_id: 0, created_at: r.created_at || '', updated_at: r.created_at || '', object_type: 'project', object_id: String(r.project_id || ''), object_name: r.project_code || '' })),
    ...quotes.map((r: any) => ({ id: r.id, artifact_source: 'quote_review', artifact_type: 'quote_review', title: '报价审价记录', summary: r.verdict_summary || '', data_json: json({ answer: r.verdict_summary || '', quote_input: r.quote_input }, {}), source_json: '[]', session_id: 0, created_at: r.created_at || '', updated_at: r.created_at || '', object_type: 'quote_batch', object_id: String(r.id), object_name: '报价批次' })),
    ...selling.map((r: any) => ({ id: r.id, artifact_source: 'selling_analysis', artifact_type: 'selling_analysis', title: `产品洞察 · ${r.product || '未命名产品'}`, summary: r.conclusion || '', data_json: json({ answer: r.conclusion || '', product: r.product }, {}), source_json: '[]', session_id: 0, created_at: r.created_at || '', updated_at: r.created_at || '', object_type: 'product', object_id: String(r.project_id || ''), object_name: r.product || '' })),
    ...trends.map((r: any) => ({ id: r.id, artifact_source: 'trend_snapshot', artifact_type: 'trend_snapshot', title: `物料洞察 · ${r.query_category || '未命名物料'}`, summary: [r.direction, r.summary, r.suggested_action].filter(Boolean).join('；'), data_json: json({ answer: r.summary || '', material_name: r.query_category, trend_item_id: r.trend_item_id }, {}), source_json: '[]', session_id: 0, created_at: r.query_time || '', updated_at: r.query_time || '', object_type: 'material', object_id: String(r.trend_item_id || ''), object_name: r.query_category || '' })),
    ...recommendations.map((r: any) => ({ id: r.id, artifact_source: 'recommendation', artifact_type: 'recommendation', title: `待处理建议 · ${r.title || '未命名建议'}`, summary: r.conclusion || '', data_json: json({ answer: r.conclusion || '' }, {}), source_json: json(r.evidence, []), session_id: 0, created_at: r.createdAt || '', updated_at: r.createdAt || '' })),
  ];
  // 阶段成本包仅按冻结版本判断源数据是否已换代，避免为每张成果卡重新跑全量成本计算。
  const phaseProjects = [...new Set(saved.filter(row => row.artifact_type === 'phase_cost_package').map(row => Number(parse<any>(row.data_json, {}).projectId || 0)).filter(Boolean))];
  const latestByProject = new Map<number, { bom: number; target: number }>();
  const currentFingerprintByProject = new Map<number, string>();
  if (phaseProjects.length) {
    const categoryByProject = new Map<number, string>();
    const feeRateByProject = new Map<number, number>();
    try { const rows = await d.select<any[]>(`SELECT id, category, platform_fee_rate FROM projects WHERE id IN (${phaseProjects.map(() => '?').join(',')})`, phaseProjects); rows.forEach(row => { categoryByProject.set(Number(row.id), String(row.category || '显示器')); feeRateByProject.set(Number(row.id), Number(row.platform_fee_rate || 0)); }); } catch { }
    try {
      const placeholders = phaseProjects.map(() => '?').join(',');
      const [bomRows, targetRows] = await Promise.all([
        d.select<any[]>(`SELECT project_id, MAX(id) AS id FROM project_bom_versions WHERE status='frozen' AND project_id IN (${placeholders}) GROUP BY project_id`, phaseProjects),
        d.select<any[]>(`SELECT project_id, MAX(id) AS id FROM project_target_versions WHERE status='frozen' AND project_id IN (${placeholders}) GROUP BY project_id`, phaseProjects),
      ]);
      phaseProjects.forEach(id => latestByProject.set(id, { bom: Number(bomRows.find(row => Number(row.project_id) === id)?.id || 0), target: Number(targetRows.find(row => Number(row.project_id) === id)?.id || 0) }));
    } catch { /* 旧数据库还没有版本表时保留成果，不阻断成果库 */ }
    try {
      const projectStore = await import('./projects');
      const architectureStore = await import('./architecture');
      const bomFingerprint = (rows: any[]) => {
        let hash = 2166136261;
        const value = rows.map(row => ({ id: row.id, part: row.part_id, module: row.module_name, quantity: row.quantity, cost: row.part_cost ?? row.unit_cost ?? 0, priceState: row.price_state || 'unknown', layer: row.cost_layer || 'material' }));
        for (const ch of JSON.stringify(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
        return (hash >>> 0).toString(16).padStart(8, '0');
      };
      const specValues = (version: any) => {
        try {
          const snapshot = JSON.parse(String(version?.project_snapshot_json || '{}'));
          return snapshot?.spec_json && typeof snapshot.spec_json === 'object' && Object.keys(snapshot.spec_json).length ? snapshot.spec_json : null;
        } catch { return null; }
      };
      const applySpec = (profile: any[], values: any) => profile.map(field => ({ ...field, value_text: Object.prototype.hasOwnProperty.call(values || {}, field.field_key) ? String(values[field.field_key] ?? '').trim() : '' }));
      const currentRows = await Promise.all(phaseProjects.map(async projectId => {
        const get = (name: string) => (projectStore as any)[name] || (architectureStore as any)[name];
        const maybe = (name: string, fallback: any) => typeof get(name) === 'function' ? get(name)(projectId).catch(() => fallback) : Promise.resolve(fallback);
        const [boms, targets, measures, reviews, snapshots, profile, versions, skus, packages, tenderOverview, tenderDecision] = await Promise.all([
          projectStore.getProjectBOMs(projectId), projectStore.getTargets(projectId), projectStore.getMeasures(projectId), projectStore.getCostReviews(projectId), projectStore.getProjectCostSnapshots(projectId),
          get('getProjectSpecProfile')(projectId, categoryByProject.get(projectId) || '显示器').catch(() => []), get('getProjectBOMVersions')(projectId).catch(() => []),
          get('getSkus')?.(projectId).catch(() => []) || Promise.resolve([]), get('getChangePackages')?.(projectId).catch(() => []) || Promise.resolve([]),
          maybe('getTenderOverview', null), maybe('getTenderDecision', null),
        ]);
        const frozen = (versions || []).find((row: any) => row.status === 'frozen');
        const currentIsFrozen = Boolean(frozen && String(frozen.data_fingerprint || '') === bomFingerprint(boms));
        const baseline = currentIsFrozen ? specValues(frozen) : null;
        const latest = currentIsFrozen ? null : await get('getLatestProjectSpecBaseline')(projectId).catch(() => null);
        const specs = currentIsFrozen ? (baseline ? applySpec(profile, baseline) : []) : (latest?.spec_json ? applySpec(profile, JSON.parse(String(latest.spec_json))) : profile);
        const skuDiffs = get('getAllSkuDiffs') && skus?.length ? await get('getAllSkuDiffs')(skus.map((row: any) => Number(row.id))).catch(() => ({})) : {};
        const skuSnapshot = (currentIsFrozen && Array.isArray(parse<any>(frozen?.sku_snapshot_json, null)))
          ? parse<any[]>(frozen.sku_snapshot_json, [])
          : (skus || []).map((sku: any) => ({ ...sku, diffs: skuDiffs[Number(sku.id)] || [] }));
        const packageRefs = (packages || []).map((row: any) => ({ id: Number(row.id || 0), status: String(row.status || 'draft').trim(), sourceVersionId: Number(row.source_version_id || 0), implementedVersionId: Number(row.implemented_version_id || 0) }));
        const feeRate = currentIsFrozen && Number.isFinite(Number(frozen?.platform_fee_rate)) ? Number(frozen.platform_fee_rate) : Number(feeRateByProject.get(projectId) || 0);
        return { projectId, fingerprint: fingerprint({ projectId, boms, targets, measures, reviews, snapshots, specs, skuSnapshot, packageRefs, feeRate, tenderOverview, tenderDecision }) };
      }));
      currentRows.forEach(row => currentFingerprintByProject.set(row.projectId, row.fingerprint));
    } catch { /* 成果仍可打开；无法读取当前源数据时仅按版本 ID 判断 */ }
  }
  const savedWithFreshness = saved.map(row => {
    if (row.artifact_type !== 'phase_cost_package') return { ...row, artifact_source: 'ai_panel' };
    const data = parse<any>(row.data_json, {});
    const source = parse<any>(row.source_version_ids, {});
    const current = latestByProject.get(Number(data.projectId || 0));
    const currentFingerprint = currentFingerprintByProject.get(Number(data.projectId || 0));
    const fingerprintStale = Boolean(row.data_fingerprint && currentFingerprint && row.data_fingerprint !== currentFingerprint);
    const versionStale = !current || (Number(source.bom || 0) && Number(source.bom) !== current.bom) || (Number(source.target || 0) && Number(source.target) !== current.target);
    const freshness = fingerprintStale || versionStale ? 'stale' : (!Number(source.bom || 0) ? 'draft' : 'current');
    return { ...row, artifact_source: 'ai_panel', freshness };
  });
  const metas = await d.select<any[]>('SELECT * FROM analysis_item_meta');
  const metaMap = new Map(metas.map(m => [m.item_key, m]));
  return [...savedWithFreshness, ...legacy].map(r => viewItem(r, metaMap.get(itemKey(String(r.artifact_source || 'ai_panel'), Number(r.id))))).filter(r => !r.archived).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, Math.max(1, Math.min(limit, 300)));
}
export async function updateAnalysisItemMeta(key: string, patch: Partial<Pick<AnalysisLibraryItem, 'domain' | 'object_type' | 'object_id' | 'object_name' | 'favorite' | 'archived'>>) {
  await ensureArtifactTables();
  const current = (await (await getDb()).select<any[]>('SELECT * FROM analysis_item_meta WHERE item_key=?', [key]))[0] || {};
  const value = { ...current, ...patch, item_key: key };
  await (await getDb()).execute(`INSERT OR REPLACE INTO analysis_item_meta (item_key,domain,object_type,object_id,object_name,favorite,archived,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`, [key, value.domain || '', value.object_type || '', value.object_id || '', value.object_name || '', value.favorite ? 1 : 0, value.archived ? 1 : 0]);
}
export async function deleteAnalysisArtifact(id: number) { await ensureArtifactTables(); await (await getDb()).execute('DELETE FROM analysis_artifacts WHERE id=?', [id]); }
