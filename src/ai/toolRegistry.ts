import { analyzeBom } from './bomAnalysis';
import { normalizeEntity } from './entityResolver';
import {
  getProjects,
  getProjectBOMs,
  getTargets,
  getProjectCostSnapshots,
  getTenderOverview,
  getTenderMatrix,
  localNow,
} from '../db';
import { computeTargetStatuses } from '../targetInsight';
import type { AiToolManifest, AiToolResult, EvidenceRef, RunContext, ToolCall, ToolPrivacyLevel } from './contracts';
import { bomExtendedCost, bomPriceState, bomQuantity, bomQuantityState, bomUnitCost, sumBomCostStrict, toFiniteNumber } from './contracts';
import { executeSkillTool, SKILL_TOOL_IDS } from './skills/core';

function pageRows<T>(rows: T[], args: Record<string, unknown>) {
  const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 200);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('分页参数无效：offset 为非负整数，limit 为 1–200');
  const nextOffset = offset + limit < rows.length ? offset + limit : null;
  const pagination = { totalRows: rows.length, offset, returnedRows: rows.slice(offset, offset + limit).length, nextOffset };
  return { rows: rows.slice(offset, offset + limit), truncated: nextOffset !== null || offset > 0, pagination, warning: `分页 ${JSON.stringify(pagination)}；需要完整明细时继续用 nextOffset 查询，合计口径不随分页改变。` };
}

/**
 * Manifest 构造器（Stage 2：隐私声明改为**显式参数**）
 *
 * 为什么把 privacyLevel 做成必填参数而不是写在注释里：
 *   注释会被忽略，类型不会。构造器强制每个新工具在登记时就回答
 *   「它读的数据是什么敏感级别」，而不是事后补。
 *
 * cloudEligible 不在此处手写，而是由 `resolveToolCloudEligible` 从 privacyLevel 推导
 * （sensitive 恒 false、非 public 一律 false）—— 避免两处声明互相矛盾。
 */
const read = (requiredData: string[], outputSchema: string, maxRows = 200, privacyLevel: ToolPrivacyLevel = 'internal'): AiToolManifest => ({
  id: '', kind: 'read', risk: 'low', requiresConfirmation: false, requiredData, outputSchema, evidencePolicy: 'required', maxRows, privacyLevel,
});
const calculate = (requiredData: string[], outputSchema: string, privacyLevel: ToolPrivacyLevel = 'internal'): AiToolManifest => ({
  id: '', kind: 'calculate', risk: 'low', requiresConfirmation: false, requiredData, outputSchema, evidencePolicy: 'optional', privacyLevel,
});
/** 写工具一律 sensitive：它们落库的是本地业务数据（BOM/报价/目标/原声），不得参与云端上下文。 */
const write = (requiredData: string[], outputSchema: string, risk: 'medium' | 'high' = 'medium', privacyLevel: ToolPrivacyLevel = 'sensitive'): AiToolManifest => ({
  id: '', kind: 'write', risk, requiresConfirmation: true, requiredData, outputSchema, evidencePolicy: 'optional', privacyLevel,
});
/**
 * 云工具特殊：它们**发起**外发，而不是把本地数据喂给云端。
 * 外发内容受隐私路由与审批双重约束（只发通用物料名/品类/公开问题），
 * 因此其输出本身可参与云端上下文 —— 标 public 是**如实声明**，不是放宽。
 */
const cloud = (requiredData: string[], outputSchema: string, privacyLevel: ToolPrivacyLevel = 'public'): AiToolManifest => ({
  id: '', kind: 'cloud', risk: 'high', requiresConfirmation: true, requiredData, outputSchema, evidencePolicy: 'required', privacyLevel,
});

const manifestRows: Record<string, AiToolManifest> = {
  query_projects: read(['projects', 'project_boms'], 'ProjectOverview[]'),
  query_project_bom: read(['projects', 'project_boms', 'parts'], 'ProjectBomResult'),
  query_project_cost: read(['projects', 'project_boms'], 'ProjectCostResult'),
  query_part_suppliers: read(['parts', 'part_suppliers'], 'PartSupplierResult'),
  query_supplier_trend: read(['parts', 'part_supplier_price_history'], 'SupplierTrendResult'),
  query_target_status: read(['projects', 'project_targets', 'project_boms'], 'TargetStatus[]'),
  query_cost_snapshots: read(['projects', 'project_cost_snapshots'], 'ProjectSnapshotResult[]'),
  query_price_insights: read(['part_insights'], 'PriceInsight[]'),
  query_advisor_insights: read(['ai_advisor_insights'], 'AdvisorInsight[]'),
  query_worklog: read(['work_logs'], 'WorkLog[]'),
  query_todos: read(['work_logs'], 'Todo[]'),
  compare_subcategory_cost: read(['projects', 'project_boms'], 'SubcategoryCostComparison'),
  insight_material_trend: cloud(['public market data'], 'MaterialTrendInsight', 'public'),
  cloud_abstract_analysis: cloud(['C2 abstract feature payload'], 'AbstractMarketInsight', 'public'),
  quote_review: write(['quote text', 'parts', 'part_suppliers'], 'QuoteReview[]', 'medium', 'sensitive'),
  query_project_module_value: read(['projects', 'project_boms', 'selling_points'], 'ModuleValue[]'),
  query_project_health: read(['projects', 'project_boms', 'project_targets', 'project_cost_snapshots'], 'ProjectHealth'),
  read_excel: read(['user selected file'], 'TabSeparatedText', 200, 'sensitive'),
  calc: calculate(['expression'], 'number', 'public'),
  now: calculate([], 'local datetime', 'public'),
  create_todo: write(['work_logs'], 'Todo', 'medium', 'sensitive'),
  add_goal: write(['ai_goals'], 'Goal', 'medium', 'sensitive'),
  query_voice_dims: read(['voice_dimensions'], 'VoiceDimension[]'),
  query_competitor_bom: read(['competitors', 'competitor_boms'], 'CompetitorBom[]'),
  query_data_readiness: read(['data readiness scan'], 'DataReadiness'),
  query_material_insight: read(['trend_items', 'trend_snapshots'], 'MaterialTrendInsight'),
  save_selling_analysis: write(['projects', 'selling_points'], 'SellingAnalysis', 'medium', 'sensitive'),
  save_project_analysis: write(['projects', 'project_analysis_logs'], 'ProjectAnalysis', 'medium', 'sensitive'),
  import_bom_to_project: write(['user selected BOM', 'projects', 'parts', 'project_boms'], 'ImportStats', 'high', 'sensitive'),
  import_supplier_quote: write(['user selected quote', 'supplier_quote_batches'], 'ImportStats', 'high', 'sensitive'),
  import_competitor_bom: write(['user selected competitor BOM', 'competitors', 'competitor_boms'], 'ImportStats', 'high', 'sensitive'),
  import_voice_items: write(['user selected user voice', 'voice_items'], 'ImportStats', 'high', 'sensitive'),
  generate_report: write(['analysis results', 'export directory'], 'ExportFile', 'high', 'sensitive'),
  write_excel: write(['analysis results', 'export directory'], 'ExportFile', 'high', 'sensitive'),
  ask_user: read(['user input'], 'UserAnswer', 12),
  query_supplier_profile: read(['part_suppliers'], 'SupplierProfile[]'),
  canonicalize_project: write(['projects', 'project_boms', 'parts'], 'CanonicalizeResult', 'high', 'sensitive'),
  query_tender_analysis: read(['projects', 'tender rounds', 'supplier quote batches', 'supplier quote lines'], 'TenderAnalysis'),
  visualize_cost_analysis: calculate(['projects', 'project_boms'], 'ChartData'),
  estimate_similar_projects: read(['projects', 'project_boms'], 'SimilarProjectEstimate'),
  rank_quote_negotiations: read(['tender rounds', 'supplier quote batches', 'supplier quote lines'], 'NegotiationRanking'),
  explain_quote_change: read(['supplier quote batches', 'supplier quote lines', 'project_spec_baselines'], 'QuoteChangeAttribution'),
};

export const AI_TOOL_MANIFESTS: Record<string, AiToolManifest> = Object.fromEntries(
  Object.entries(manifestRows).map(([id, manifest]) => [id, { ...manifest, id }]),
);

export const STRUCTURED_TOOL_IDS = [
  'query_projects',
  'query_project_bom',
  'query_target_status',
  'query_tender_analysis',
  'query_cost_snapshots',
  ...SKILL_TOOL_IDS,
] as const;

export const WRITE_TOOL_IDS = Object.values(AI_TOOL_MANIFESTS)
  .filter(manifest => manifest.kind === 'write')
  .map(manifest => manifest.id);

export function listToolManifests(): AiToolManifest[] {
  return Object.values(AI_TOOL_MANIFESTS);
}

export function getToolManifest(id: string): AiToolManifest | undefined {
  return AI_TOOL_MANIFESTS[id];
}

export function toolRequiresConfirmation(id: string): boolean {
  return AI_TOOL_MANIFESTS[id]?.requiresConfirmation === true;
}

export interface ProjectOverviewRow {
  projectId: number;
  code: string;
  name: string;
  projectType: string;
  tier: string;
  status: string;
  bomCost: number | null;
  costStatus: 'confirmed' | 'unknown';
  bomItemCount: number;
  updatedAt: string;
}

export interface ProjectBomRow {
  bomId: number;
  module: string;
  name: string;
  model: string;
  quantity: number | null;
  unitCost: number | null;
  extendedCost: number | null;
  priceState: string;
  category: string;
}

export interface TargetStatusRow {
  projectId: number;
  code: string;
  domain: string;
  actual: number | null;
  target: number;
  gap: number | null;
  achievementRate: number | null;
  missed: boolean;
}

export interface ProjectSnapshotRow {
  snapshotId: number;
  projectId: number;
  projectCode: string;
  bomCost: number;
  totalCost: number;
  deltaFromNewer: number;
  changeReason: string;
  observedAt: string;
}

const money = (value: number | null) => value == null ? '待补证据' : '¥' + value.toFixed(2);
const text = (value: unknown) => String(value ?? '').trim();
const nullableNumber = (value: unknown) => value === undefined || value === null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const argsOf = (call: ToolCall) => call.args || {};
const currentFreshness = () => '本地 SQLite，查询于 ' + localNow();

function projectLink(projectId: number) {
  return { page: 'projects', params: { projectId } };
}

function ref(
  refType: EvidenceRef['refType'],
  refId: number,
  label: string,
  field: string,
  value: string | number,
  observedAt?: string,
  deepLink?: EvidenceRef['deepLink'],
): EvidenceRef {
  return { refType, refId, label, field, value, observedAt, deepLink };
}

function failure<T = null>(summary: string, warning = summary): AiToolResult<T> {
  return { ok: false, summary, data: null as T, evidence: [], warnings: [warning], freshness: currentFreshness() };
}

function success<T>(summary: string, data: T, evidence: EvidenceRef[], warnings: string[] = [], display?: AiToolResult<T>['display']): AiToolResult<T> {
  return { ok: true, summary, data, evidence, warnings, freshness: currentFreshness(), ...(display ? { display } : {}) };
}

async function findProject(code: string): Promise<any | null> {
  const projects = (await getProjects('', '', '')).filter((project: any) => !project.is_deleted);
  const matches = projects.filter((project: any) => normalizeEntity(project.code) === normalizeEntity(code) || normalizeEntity(project.name) === normalizeEntity(code));
  return matches.length === 1 ? matches[0] : null;
}

async function projectOverview(args: Record<string, unknown>): Promise<AiToolResult<ProjectOverviewRow[]>> {
  const type = text(args.project_type);
  const projects = (await getProjects('', '', ''))
    .filter((project: any) => !project.is_deleted && (!type || text(project.project_type) === type));
  const limited = pageRows(projects, args);
  const rows: ProjectOverviewRow[] = [];
  const evidence: EvidenceRef[] = [];
  for (const project of limited.rows) {
    const boms = (await getProjectBOMs(Number(project.id))).filter((bom: any) => !bom.is_deleted);
    const cost = sumBomCostStrict(boms);
    const bomCost = cost.missing.length ? null : cost.total;
    rows.push({
      projectId: Number(project.id), code: text(project.code), name: text(project.name),
      projectType: text(project.project_type), tier: text(project.tier), status: text(project.status),
      bomCost, costStatus: cost.missing.length ? 'unknown' : 'confirmed', bomItemCount: boms.length, updatedAt: text(project.updated_at || project.created_at),
    });
    if (bomCost != null) evidence.push(ref('project', Number(project.id), '项目 ' + text(project.code), 'bom_cost', bomCost, text(project.updated_at || project.created_at), projectLink(Number(project.id))));
  }
  if (!rows.length && limited.pagination.offset > 0) return success<ProjectOverviewRow[]>('该分页没有更多项目；分页已结束', [], [], [limited.warning], { type: 'table', title: '项目概览' });
  if (!rows.length) return failure<ProjectOverviewRow[]>(type ? '没有找到类型为「' + type + '」的项目' : '没有找到项目');
  const summary = rows.map(row => row.code + '｜' + row.name + '｜BOM ' + money(row.bomCost) + '｜' + row.bomItemCount + ' 项').join('\n');
  return success('项目概览（' + rows.length + ' 个）：\n' + summary, rows, evidence, [...(rows.some(row => row.costStatus === 'unknown') ? ['部分项目存在未确认价格，合计不输出为 0'] : []), ...(limited.truncated ? [limited.warning] : [])], { type: 'table', title: '项目概览' });
}

async function projectBom(args: Record<string, unknown>): Promise<AiToolResult<any>> {
  const code = text(args.project_code);
  const project = await findProject(code);
  if (!project) return failure<{ project: { id: number; code: string; name: string }; total: number | null; rows: ProjectBomRow[] }>('未找到项目代号：' + code);
  const boms = (await getProjectBOMs(Number(project.id))).filter((bom: any) => !bom.is_deleted);
  if (args.view && args.view !== 'details') {
    const data = analyzeBom(boms, args);
    const code = text(project.code);
    const warnings = [ ...(data.missingCount ? [`${data.missingCount} 行价格或数量缺失，总成本未知；已知小计不是完整总额`] : []), ...(data.excludedFromRanking ? [`${data.excludedFromRanking} 行缺少排名所需字段，最高/最低仅针对已确认项`] : []), ...(data.tiedAtBoundary > 1 ? [`返回边界有 ${data.tiedAtBoundary} 项并列，勿称唯一`] : []) ];
    const evidence = [ref('project', Number(project.id), `${code} 全量 BOM 统计`, 'matched_rows', data.matchedCount, localNow(), projectLink(Number(project.id))),
      ...data.rows.filter((row:any)=>row.bomId).map((row:any)=>ref('bom',row.bomId,`${row.name} ${row.model}`,data.metric,data.metric === 'unit_cost' ? row.unitCost : row.extendedCost,undefined,projectLink(Number(project.id))))];
    return success(`${code}：已在工具内完成${data.view === 'rank' ? '全量排名' : data.view === 'group' ? '分组汇总' : '汇总/极值/平均值'}，共 ${data.matchedCount} 行。结果已计算，无需逐页读取或调用 calc 重算。`, {project:{id:project.id,code,name:project.name},...data}, evidence, warnings, {type:'table',title:`${code} 成本统计`});
  }
  const limited = pageRows(boms, args);
  const rows = limited.rows.map((bom: any): ProjectBomRow => ({
    bomId: Number(bom.id), module: text(bom.module_name) || '未分模块', name: text(bom.part_name), model: text(bom.part_model),
    quantity: bomQuantityState(bom) === 'confirmed' ? bomQuantity(bom) : null, unitCost: bomPriceState(bom) === 'confirmed' ? bomUnitCost(bom) : null, extendedCost: bomPriceState(bom) === 'confirmed' && bomQuantityState(bom) === 'confirmed' ? bomExtendedCost(bom) : null, priceState: bomPriceState(bom), category: text(bom.main_category),
  }));
  const cost = sumBomCostStrict(boms); const total = cost.missing.length ? null : cost.total;
  const evidence: EvidenceRef[] = total == null ? [] : [ref('project', Number(project.id), '项目 ' + code + ' BOM 合计', 'bom_cost', total, text(project.updated_at || project.created_at), projectLink(Number(project.id)))];
  rows.forEach(row => {
    if (row.unitCost != null) evidence.push(ref('bom', row.bomId, row.name + (row.model ? ' ' + row.model : ''), 'unit_cost', row.unitCost, undefined, projectLink(Number(project.id))));
    if (row.extendedCost != null) evidence.push(ref('bom', row.bomId, row.name + ' 小计', 'extended_cost', row.extendedCost, undefined, projectLink(Number(project.id))));
  });
  const detail = rows.map(row => '[' + row.module + '] ' + row.name + ' ' + row.model + ' ×' + row.quantity + ' @' + money(row.unitCost) + ' =' + money(row.extendedCost)).join('\n');
  return success('项目 ' + code + ' BOM 共 ' + boms.length + ' 项，合计 ' + money(total) + (detail ? '\n' + detail : ''), { project: { id: Number(project.id), code, name: text(project.name) }, total, rows, ...{ pagination: limited.pagination } }, evidence, [
    ...(boms.length === 0 ? ['项目暂无 BOM'] : []), ...(cost.missing.length ? [`${cost.missing.length} 行价格/数量未确认，合计标记为待补证据`] : []), ...(limited.truncated ? [limited.warning] : []),
  ], { type: 'table', title: code + ' BOM 明细' });
}

async function targetStatus(args: Record<string, unknown>): Promise<AiToolResult<TargetStatusRow[]>> {
  const code = text(args.project_code);
  const projects = (await getProjects('', '', '')).filter((project: any) => !project.is_deleted && text(project.project_type) === '在研' && (!code || text(project.code) === code));
  if (!projects.length) return failure<TargetStatusRow[]>(code ? '没有找到符合条件的在研项目：' + code : '没有符合条件的在研项目');
  const targetsBy: Record<number, any[]> = {};
  const bomsBy: Record<number, any[]> = {};
  for (const project of projects) {
    targetsBy[Number(project.id)] = await getTargets(Number(project.id));
    bomsBy[Number(project.id)] = (await getProjectBOMs(Number(project.id))).filter((bom: any) => !bom.is_deleted);
  }
  const statuses = computeTargetStatuses(projects, targetsBy, bomsBy);
  if (!statuses.length) return success('所选项目未设定目标成本（需先在项目 → 成本分析设定）', [], [], ['未设定目标成本'], { type: 'table', title: '目标成本达成' });
  const limited = pageRows(statuses, args);
  const rows: TargetStatusRow[] = limited.rows.map((status: any) => ({
    projectId: Number(status.projectId), code: text(status.code), domain: text(status.domain), actual: status.unknown ? null : toFiniteNumber(status.actual), target: toFiniteNumber(status.target),
    gap: status.unknown ? null : toFiniteNumber(status.diff), achievementRate: status.unknown ? null : toFiniteNumber(status.rate), missed: Boolean(status.missed),
  }));
  const evidence: EvidenceRef[] = [];
  rows.forEach(row => {
    const target = (targetsBy[row.projectId] || []).find(item => text(item.domain) === row.domain);
    if (row.actual != null) evidence.push(ref('project', row.projectId, '项目 ' + row.code + ' ' + row.domain + ' 实际成本', 'actual_cost', row.actual, undefined, projectLink(row.projectId)));
    if (target?.id) {
      evidence.push(ref('target', Number(target.id), '项目 ' + row.code + ' ' + row.domain + ' 目标', 'target_cost', row.target, text(target.updated_at || target.created_at), projectLink(row.projectId)));
      if (row.gap != null) evidence.push(ref('target', Number(target.id), '项目 ' + row.code + ' ' + row.domain + ' 目标差', 'target_gap', row.gap, text(target.updated_at || target.created_at), projectLink(row.projectId)));
    }
  });
  const summary = rows.map(row => row.code + '｜' + row.domain + '：目标 ' + money(row.target) + '，实际 ' + money(row.actual) + '，达成率 ' + (row.achievementRate == null ? '待补证据' : row.achievementRate + '%') + (row.missed ? ' ⚠️未达标' : row.actual == null ? ' ⚠️待补证据' : ' ✓')).join('\n');
  return success('目标成本达成：\n' + summary, rows, evidence, [...(rows.some(row => row.actual == null) ? ['部分领域存在未确认价格，未给出达成率'] : []), ...(limited.truncated ? [limited.warning] : [])], { type: 'table', title: '目标成本达成' });
}

async function tenderAnalysis(args: Record<string, unknown>): Promise<AiToolResult<any>> {
  const code = text(args.project_code);
  const project = await findProject(code);
  if (!project) return failure('未找到项目代号：' + code);
  const [overview, matrix] = await Promise.all([getTenderOverview(Number(project.id)), getTenderMatrix(Number(project.id))]);
  const limited = pageRows(matrix, args);
  const rows = limited.rows.map((row: any) => ({
    key: text(row.key), module: text(row.moduleName), material: text(row.materialName), model: text(row.model), specs: text(row.specs), quantity: nullableNumber(row.quantity),
    offers: Object.values(row.offers || {}).map((offer: any) => ({ supplier: text(offer.supplierName), unitPrice: nullableNumber(offer.unitPrice), lineTotal: nullableNumber(offer.lineTotal), relation: text(offer.relationType), quoteLineId: Number(offer.quoteLineId), batchId: Number(offer.batchId) })),
    comparableLow: row.comparableLow ? { supplier: text(row.comparableLow.supplierName), unitPrice: nullableNumber(row.comparableLow.unitPrice), lineTotal: nullableNumber(row.comparableLow.lineTotal), quoteLineId: Number(row.comparableLow.quoteLineId) } : null,
    opportunity: nullableNumber(row.opportunity),
  }));
  const evidence: EvidenceRef[] = [];
  for (const batch of overview.batches || []) {
    if (toFiniteNumber(batch.totalAmount) > 0) evidence.push(ref('quote_batch', Number(batch.id), text(batch.supplierName) + ' 报价批次', 'total_amount', toFiniteNumber(batch.totalAmount), text(batch.quotedAt || batch.createdAt), projectLink(Number(project.id))));
  }
  rows.forEach(row => {
    row.offers.forEach((offer: any) => {
      if (offer.unitPrice != null) evidence.push(ref('quote_line', offer.quoteLineId, row.material + ' · ' + offer.supplier + ' 单价', 'unit_price', offer.unitPrice, undefined, projectLink(Number(project.id))));
      if (offer.lineTotal != null) evidence.push(ref('quote_line', offer.quoteLineId, row.material + ' · ' + offer.supplier + ' 小计', 'line_total', offer.lineTotal, undefined, projectLink(Number(project.id))));
    });
    if (row.comparableLow) {
      if (row.comparableLow.unitPrice != null) evidence.push(ref('quote_line', row.comparableLow.quoteLineId, row.material + ' · 可比最低单价', 'unit_price', row.comparableLow.unitPrice, undefined, projectLink(Number(project.id))));
      if (row.comparableLow.lineTotal != null) evidence.push(ref('quote_line', row.comparableLow.quoteLineId, row.material + ' · 可比最低小计', 'line_total', row.comparableLow.lineTotal, undefined, projectLink(Number(project.id))));
      if (row.opportunity != null) evidence.push(ref('quote_line', row.comparableLow.quoteLineId, row.material + ' · 可谈机会', 'opportunity', row.opportunity, undefined, projectLink(Number(project.id))));
    }
  });
  const summary = rows.map(row => {
    const offers = row.offers.map((offer: any) => offer.supplier + ' ' + money(offer.lineTotal) + '[' + offer.relation + ']').join('；');
    return '[' + (row.module || '未归类') + '] ' + row.material + (row.model ? ' ' + row.model : '') + '｜' + offers + '｜最低 ' + (row.comparableLow ? row.comparableLow.supplier + ' ' + money(row.comparableLow.lineTotal) : '待确认') + '｜机会 ' + money(row.opportunity);
  }).join('\n');
  const s = overview.summary;
  const theoreticalLow = nullableNumber(s.theoreticalLow), opportunity = nullableNumber(s.opportunity);
  if (theoreticalLow != null) evidence.push(ref('project', Number(project.id), '项目 ' + code + ' 理论组合底价', 'theoretical_low', theoreticalLow, undefined, projectLink(Number(project.id))));
  if (opportunity != null) evidence.push(ref('project', Number(project.id), '项目 ' + code + ' 可谈机会', 'opportunity', opportunity, undefined, projectLink(Number(project.id))));
  return success('项目 ' + code + ' 招标分析（当前轮次）\n供应商 ' + s.supplierCount + ' 家，明细 ' + s.lineCount + ' 行，可比覆盖率 ' + Math.round(s.comparableCoverage * 100) + '%，理论组合底价 ' + money(theoreticalLow) + '，可谈机会 ' + money(opportunity) + (summary ? '\n' + summary : ''), { project: { id: Number(project.id), code, name: text(project.name) }, round: overview.currentRound || null, summary: s, rows }, evidence, [
    ...(s.referenceCount || s.unmatchedCount ? ['参考价/待确认价不计入理论组合底价'] : []), ...(matrix.length === 0 ? ['项目尚无招标报价明细'] : []), ...(limited.truncated ? [limited.warning] : []),
  ], { type: 'table', title: code + ' 招标比价' });
}

async function costSnapshots(args: Record<string, unknown>): Promise<AiToolResult<ProjectSnapshotRow[]>> {
  const code = text(args.project_code);
  const projects = (await getProjects('', '', '')).filter((project: any) => !project.is_deleted && (!code || text(project.code) === code));
  if (!projects.length) return failure<ProjectSnapshotRow[]>(code ? '未找到项目代号：' + code : '没有找到项目');
  const allRows: ProjectSnapshotRow[] = [];
  for (const project of projects) {
    const snapshots = await getProjectCostSnapshots(Number(project.id));
    const top = snapshots;
    top.forEach((snapshot: any, index: number) => {
      const bomCost = toFiniteNumber(snapshot.bom_cost);
      const row: ProjectSnapshotRow = {
        snapshotId: Number(snapshot.id), projectId: Number(project.id), projectCode: text(project.code), bomCost, totalCost: toFiniteNumber(snapshot.total_cost),
        deltaFromNewer: index === 0 ? 0 : bomCost - toFiniteNumber(top[index - 1].bom_cost), changeReason: text(snapshot.change_reason), observedAt: text(snapshot.created_at),
      };
      allRows.push(row);
    });
  }
  const limited = pageRows(allRows, args);
  const evidence: EvidenceRef[] = [];
  limited.rows.forEach((row, index) => {
    evidence.push(ref('snapshot', row.snapshotId, row.projectCode + ' BOM 成本快照', 'bom_cost', row.bomCost, row.observedAt, projectLink(row.projectId)));
    evidence.push(ref('snapshot', row.snapshotId, row.projectCode + ' 整机成本快照', 'total_cost', row.totalCost, row.observedAt, projectLink(row.projectId)));
    if (index > 0) evidence.push(ref('snapshot', row.snapshotId, row.projectCode + ' 快照变化', 'delta', row.deltaFromNewer, row.observedAt, projectLink(row.projectId)));
  });
  const summary = limited.rows.map(row => row.projectCode + '｜' + row.observedAt.slice(0, 16) + ' BOM ' + money(row.bomCost) + (row.deltaFromNewer ? '（变化 ' + (row.deltaFromNewer > 0 ? '+' : '') + money(row.deltaFromNewer) + '）' : '') + (row.changeReason ? '｜' + row.changeReason : '')).join('\n');
  return success('成本快照（' + limited.rows.length + ' 条）' + (summary ? '\n' + summary : '：暂无快照'), limited.rows, evidence, limited.truncated ? [limited.warning] : [], { type: 'table', title: '成本历史' });
}

export async function executeStructuredTool(call: ToolCall, context: RunContext = {}): Promise<AiToolResult<unknown>> {
  void context;
  try {
    const args = argsOf(call) as Record<string, unknown>;
    switch (call.name) {
      case 'query_projects': return projectOverview(args);
      case 'query_project_bom': return projectBom(args);
      case 'query_target_status': return targetStatus(args);
      case 'query_tender_analysis': return tenderAnalysis(args);
      case 'query_cost_snapshots': return costSnapshots(args);
      case 'estimate_similar_projects':
      case 'rank_quote_negotiations':
      case 'explain_quote_change': return executeSkillTool(call);
      default: return failure<unknown>('工具「' + call.name + '」尚未迁移到结构化结果适配器');
    }
  } catch (error: any) {
    return failure('结构化工具执行失败：' + String(error?.message || error).slice(0, 200));
  }
}
