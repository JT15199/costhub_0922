export type MaterialInsightMode = 'auto' | 'direct' | 'decompose';
export type ExplicitMaterialInsightMode = Exclude<MaterialInsightMode, 'auto'>;

export type MaterialInsightModeId = 'direct' | 'decomposition';
export function getMaterialInsightModeMeta(mode: ExplicitMaterialInsightMode): { id: MaterialInsightModeId; label: string; icon: 'thunderbolt' | 'branches' } {
  return mode === 'decompose'
    ? { id: 'decomposition', label: '分解型洞察', icon: 'branches' }
    : { id: 'direct', label: '直接洞察', icon: 'thunderbolt' };
}

export interface MaterialInsightLink {
  material?: string;
  projectId?: number;
  projectCode?: string;
  partId?: number;
  rootId?: number;
  prompt?: string;
  mode?: MaterialInsightMode;
}

export interface MaterialInsightListItem {
  label: string;
  text: string;
  direction?: string;
  evidenceIds: number[];
}

export interface MaterialInsightProjectImpact {
  projectId: number | null;
  projectName: string;
  value: number | null;
  baseline: number | null;
  target: number | null;
  unit: string;
  asOf: string;
}

export interface MaterialInsightResult {
  mode: ExplicitMaterialInsightMode;
  headline: string;
  direction: string;
  confidence: string;
  asOf: string;
  magnitudeMin: number | null;
  magnitudeMax: number | null;
  magnitudeReference: string;
  drivers: MaterialInsightListItem[];
  opportunities: MaterialInsightListItem[];
  risks: MaterialInsightListItem[];
  actions: MaterialInsightListItem[];
  projectImpacts: MaterialInsightProjectImpact[];
  dimensions: any[];
  keyEvents: any[];
  evidenceIds: number[];
  dataGaps: string[];
  rawText: string;
}

export interface DecompositionSynthesis extends MaterialInsightResult {
  coverage: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    rate: number;
    costRate: number | null;
  };
  contributions: DecompositionContribution[];
  additiveReliable: boolean;
}

export interface DecompositionContribution {
  nodeId: number;
  name: string;
  ratio: number;
  direction: string;
  score: number;
  confidence: string;
  asOf: string;
  sourceType: string;
}

export interface DirectTrendPoint {
  id: number | null;
  time: string;
  value: number;
  min: number | null;
  max: number | null;
  direction: string;
  confidence: string;
  sourceType: string;
  reference: string;
}

export interface InsightHistoryPoint {
  id: number | null;
  time: string;
  score: number;
  direction: string;
  confidence: string;
  summary: string;
  sourceCount: number;
  split: boolean;
}

export interface SimulatedTrendPoint extends InsightHistoryPoint {
  value: number;
  low: number;
  high: number;
}

export function safeHttpUrl(value: unknown): string {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function shouldUseSimulatedTrend(data: DirectTrendChartData): boolean {
  return data.kind === 'insufficient' || data.kind === 'single';
}

export type DirectTrendChartData =
  | { kind: 'range'; points: DirectTrendPoint[] }
  | { kind: 'points'; points: DirectTrendPoint[] }
  | { kind: 'single'; point: DirectTrendPoint }
  | { kind: 'insufficient'; reason: string };

const directionScore: Record<string, number> = { 上涨: 1, 下降: -1, 震荡: 0 };
const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
const textValue = (value: unknown) => String(value ?? '').trim();
const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const uniqueText = (values: unknown[]) => [...new Set(values.map(textValue).filter(Boolean))];
const uniqueIds = (values: unknown[]) => [...new Set(values.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0))];
const arrayValue = (...values: unknown[]) => values.find(value => Array.isArray(value)) as any[] | undefined;
const chronological = (snapshots: any[]) => (Array.isArray(snapshots) ? snapshots : []).slice().sort((a, b) => String(a?.query_time || a?.asOf || '').localeCompare(String(b?.query_time || b?.asOf || '')) || (Number(a?.id) || 0) - (Number(b?.id) || 0));

function normalizeList(value: unknown, label: string): MaterialInsightListItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map(item => {
    if (typeof item === 'string') return { label, text: item.trim(), evidenceIds: [] };
    const row = asRecord(item);
    const rawDirection = textValue(row.direction || row.impact_direction);
    return {
      label: textValue(row.label || row.title || row.name || label) || label,
      text: textValue(row.text || row.content || row.summary || row.description),
      direction: rawDirection.replace('上行', '上涨').replace('下行', '下降') || undefined,
      evidenceIds: uniqueIds([...(Array.isArray(row.evidenceIds) ? row.evidenceIds : []), row.evidence_id, row.source_id]),
    };
  }).filter(item => item.text);
}

/**
 * Parse model/legacy/persisted output into the small UI contract. Missing facts
 * remain gaps; this function never invents amounts, dates, ratios or evidence.
 */
export function parseMaterialInsightResult(input: unknown, context: { mode?: ExplicitMaterialInsightMode; asOf?: string; rawText?: string; dataGaps?: string[]; evidenceIds?: unknown[] } = {}): MaterialInsightResult {
  const value = asRecord(input);
  const direction = textValue(value.direction || value.trend_direction || value.trend) || '信号不明确';
  const confidence = textValue(value.confidence || value.confidence_level) || '低';
  const headline = textValue(value.headline || value.oneLineConclusion || value.summary || value.conclusion);
  const asOf = textValue(context.asOf || value.asOf || value.as_of || value.query_time);
  const info = asRecord(value.info_sufficiency);
  const magnitudeMin = finiteNumber(value.magnitudeMin ?? value.magnitude_min);
  const magnitudeMax = finiteNumber(value.magnitudeMax ?? value.magnitude_max);
  const dimensions = Array.isArray(value.dimensions) ? value.dimensions : [];
  const events = Array.isArray(value.keyEvents) ? value.keyEvents : (Array.isArray(value.key_events) ? value.key_events : []);
  const dimensionItems = dimensions.map((item: any) => ({ ...item, label: textValue(item?.dimension_type || item?.label || '维度'), text: textValue(item?.content || item?.observation) }));
  const eventItems = events.map((item: any) => ({ ...item, label: '关键事件', text: textValue(item?.event_description || item?.description), direction: textValue(item?.impact_direction) }));
  const fallbackDrivers = dimensionItems.filter((item: any) => /驱动|供需|价格|上行|下行|原料|需求|供给/.test(item.label)).map((item: any) => ({ ...item, direction: item.direction || (/下降|下行|收缩|走弱/.test(`${item.label}${item.text}`) ? '下降' : '上涨') }));
  const fallbackOpportunities = dimensionItems.filter((item: any) => /机会|展望|替代|降价|窗口/.test(item.label));
  const fallbackRisks = [...dimensionItems.filter((item: any) => /风险|卡点|政策|中断|威胁/.test(item.label)), ...eventItems.filter((item: any) => /上涨|风险|negative|down/i.test(item.direction))];
  const fallbackActions = [
    ...dimensionItems.filter((item: any) => /行动|建议|采购|谈判|应对/.test(item.label)),
    ...(textValue(value.suggested_action) ? [{ label: '建议动作', text: textValue(value.suggested_action) }] : []),
  ];
  const drivers = normalizeList(arrayValue(value.drivers, value.drivingFactors, value.upDownDrivers) || fallbackDrivers, '驱动');
  const opportunities = normalizeList(arrayValue(value.opportunities, value.opportunity) || fallbackOpportunities, '机会');
  const risks = normalizeList(arrayValue(value.risks, value.risk) || fallbackRisks, '风险');
  const actions = normalizeList(arrayValue(value.actions, value.suggestedActions) || fallbackActions, '行动');
  const projectImpacts = (arrayValue(value.projectImpacts, value.project_impacts) || []).slice(0, 12).map(item => {
    const row = asRecord(item);
    return {
      projectId: finiteNumber(row.projectId ?? row.project_id),
      projectName: textValue(row.projectName || row.project_name || row.name),
      value: finiteNumber(row.value ?? row.actual ?? row.impact),
      baseline: finiteNumber(row.baseline),
      target: finiteNumber(row.target),
      unit: textValue(row.unit),
      asOf: textValue(row.asOf || row.as_of || row.query_time),
    };
  }).filter(item => item.projectName || item.projectId);
  const evidenceIds = uniqueIds([
    ...(Array.isArray(context.evidenceIds) ? context.evidenceIds : []),
    ...(Array.isArray(value.evidenceIds) ? value.evidenceIds : []),
    ...(Array.isArray(value.evidence_ids) ? value.evidence_ids : []),
    ...drivers.flatMap(item => item.evidenceIds),
    ...opportunities.flatMap(item => item.evidenceIds),
    ...risks.flatMap(item => item.evidenceIds),
    ...actions.flatMap(item => item.evidenceIds),
  ]);
  const dataGaps = uniqueText([
    ...(Array.isArray(context.dataGaps) ? context.dataGaps : []),
    ...(Array.isArray(value.dataGaps) ? value.dataGaps : []),
    ...(Array.isArray(value.data_gaps) ? value.data_gaps : []),
    ...(Array.isArray(info.missing_dimensions) ? info.missing_dimensions : []),
    !headline ? '缺少一句话结论' : '',
    !asOf ? '缺少数据时点' : '',
    evidenceIds.length === 0 ? '缺少可追溯证据ID' : '',
    drivers.length === 0 ? '缺少上下行驱动拆分' : '',
    magnitudeMin == null && magnitudeMax == null ? '缺少可计算的价格幅度' : '',
  ]);
  return {
    mode: context.mode || (value.mode === 'decompose' ? 'decompose' : 'direct'),
    headline: headline || '暂无结构化结论',
    direction,
    confidence,
    asOf,
    magnitudeMin,
    magnitudeMax,
    magnitudeReference: textValue(value.magnitudeReference || value.magnitude_reference),
    drivers,
    opportunities,
    risks,
    actions,
    projectImpacts,
    dimensions,
    keyEvents: events,
    evidenceIds,
    dataGaps,
    rawText: textValue(context.rawText || value.rawText || value.raw_text || value.summary),
  };
}

export function getMaterialInsightResult(snapshot: unknown, mode?: ExplicitMaterialInsightMode): MaterialInsightResult {
  const row = asRecord(snapshot);
  let persisted: unknown = null;
  if (row.result_json && typeof row.result_json === 'string') {
    try { persisted = JSON.parse(row.result_json); } catch { persisted = null; }
  } else if (row.result_json && typeof row.result_json === 'object') persisted = row.result_json;
  const persistedValue = asRecord(persisted);
  const merged = Object.keys(persistedValue).length > 0
    ? { ...row, ...persistedValue, dimensions: persistedValue.dimensions ?? row.dimensions, keyEvents: persistedValue.keyEvents ?? row.key_events, suggested_action: persistedValue.suggested_action ?? row.suggested_action }
    : row;
  return parseMaterialInsightResult(merged, {
    mode,
    asOf: textValue(row.query_time),
    rawText: textValue(row.summary),
  });
}

export function suggestMaterialInsightMode(mode: ExplicitMaterialInsightMode, input: string, materialCount = 1): { mode: ExplicitMaterialInsightMode; reason: string } | null {
  if (!String(input || '').trim()) return null;
  const inferred = inferMaterialInsightMode(input, materialCount);
  return inferred.mode === mode ? null : { ...inferred, reason: `当前选择为${mode === 'direct' ? '直接洞察' : '分解型洞察'}；${inferred.reason}` };
}

export function resolveMaterialInsightMode(value: unknown): ExplicitMaterialInsightMode {
  return value === 'decompose' ? 'decompose' : 'direct';
}

export function getInsightTreeBranchIds(nodes: any[], focusId?: number | null): number[] {
  const rows = Array.isArray(nodes) ? nodes : [];
  if (!focusId) return rows.map(node => Number(node.id)).filter(Number.isFinite);
  const byId = new Map(rows.map(node => [Number(node.id), node]));
  const ids = new Set<number>();
  let current = byId.get(Number(focusId));
  while (current && !ids.has(Number(current.id))) {
    ids.add(Number(current.id));
    current = byId.get(Number(current.parent_id));
  }
  const visit = (parentId: number) => rows.filter(node => Number(node.parent_id) === parentId).forEach(node => { const id = Number(node.id); if (!ids.has(id)) { ids.add(id); visit(id); } });
  visit(Number(focusId));
  return rows.map(node => Number(node.id)).filter(id => ids.has(id));
}

export type InsightTreeFilter = 'all' | 'high-impact' | 'failed' | 'selected';

export type MaterialInsightTaskModeFilter = 'all' | 'direct' | 'decomposition';
export type MaterialInsightTaskStatusFilter = 'all' | 'ready' | 'pending' | 'running' | 'completed' | 'partial' | 'failed';

export function filterMaterialInsightSubjects(subjects: any[], keyword = '', mode: MaterialInsightTaskModeFilter = 'all', status: MaterialInsightTaskStatusFilter = 'all'): any[] {
  const query = String(keyword || '').trim().toLocaleLowerCase();
  return (Array.isArray(subjects) ? subjects : []).filter(subject => {
    const matchesKeyword = !query || `${subject?.title || ''} ${subject?.categoryType || ''}`.toLocaleLowerCase().includes(query);
    const matchesMode = mode === 'all' || subject?.kind === mode;
    const matchesStatus = status === 'all' || (status === 'pending' && ['draft', 'ready', 'pending', 'queued', 'paused'].includes(subject?.status)) || subject?.status === status;
    return matchesKeyword && matchesMode && matchesStatus;
  });
}

export function filterInsightTreeNodes(nodes: any[], filter: InsightTreeFilter, selectedIds: Iterable<number> = [], focusId?: number | null): any[] {
  const rows = Array.isArray(nodes) ? nodes : [];
  const branchIds = new Set(getInsightTreeBranchIds(rows, focusId));
  const selected = new Set([...selectedIds].map(Number));
  const matching = rows.filter(node => {
    const id = Number(node.id);
    if (!branchIds.has(id)) return false;
    if (filter === 'failed') return ['failed', 'error'].includes(String(node.insight_status));
    if (filter === 'selected') return selected.has(id);
    if (filter === 'high-impact') return Number(node.cost_ratio_estimate) >= 10;
    return true;
  });
  const visible = new Set(matching.map(node => Number(node.id)));
  matching.forEach(node => {
    let parent = rows.find(row => Number(row.id) === Number(node.parent_id));
    while (parent && branchIds.has(Number(parent.id)) && !visible.has(Number(parent.id))) { visible.add(Number(parent.id)); parent = rows.find(row => Number(row.id) === Number(parent.parent_id)); }
  });
  return rows.filter(node => visible.has(Number(node.id)));
}

export function buildDirectTrendChartData(snapshots: any[]): DirectTrendChartData {
  const points = chronological(snapshots).map(snapshot => {
    const min = finiteNumber(snapshot.magnitude_min ?? snapshot.magnitudeMin);
    const max = finiteNumber(snapshot.magnitude_max ?? snapshot.magnitudeMax);
    const value = min != null && max != null ? (min + max) / 2 : min ?? max;
    return value == null ? null : {
      id: finiteNumber(snapshot.id),
      time: textValue(snapshot.query_time || snapshot.asOf),
      value,
      min,
      max,
      direction: textValue(snapshot.direction || snapshot.trend_direction) || '信号不明确',
      confidence: textValue(snapshot.confidence_level || snapshot.confidence) || '低',
      sourceType: textValue(snapshot.source_type) || 'direct_query',
      reference: textValue(snapshot.magnitude_reference),
    } satisfies DirectTrendPoint;
  }).filter((point): point is DirectTrendPoint => point !== null);
  if (points.length === 0) return { kind: 'insufficient', reason: '没有可绘制的数字价格幅度' };
  if (points.length === 1) return { kind: 'single', point: points[0] };
  if (points.length >= 2 && points.every(point => point.min != null && point.max != null)) return { kind: 'range', points };
  return { kind: 'points', points };
}

export function buildInsightHistoryChartData(snapshots: any[]): InsightHistoryPoint[] {
  return chronological(snapshots).map(snapshot => {
    const direction = textValue(snapshot.direction || snapshot.trend_direction) || '信号不明确';
    return {
      id: finiteNumber(snapshot.id),
      time: textValue(snapshot.query_time || snapshot.asOf),
      score: directionScore[direction] ?? 0,
      direction,
      confidence: textValue(snapshot.confidence_level || snapshot.confidence) || '低',
      summary: textValue(snapshot.summary),
      sourceCount: finiteNumber(snapshot.source_count ?? snapshot.sourceCount) || 0,
      split: direction === '分化',
    };
  });
}

/** Deterministic visual aid only; it is never a market-price estimate. */
export function buildSimulatedTrendChartData(snapshots: any[]): SimulatedTrendPoint[] {
  let value = 100;
  return buildInsightHistoryChartData(snapshots).map((point, index) => {
    const step = point.direction === '上涨' ? (point.confidence === '高' ? 4 : point.confidence === '中' ? 2.5 : 1.5)
      : point.direction === '下降' ? -(point.confidence === '高' ? 4 : point.confidence === '中' ? 2.5 : 1.5)
        : point.direction === '分化' ? (index % 2 ? -1 : 1) : point.direction === '震荡' ? (index % 2 ? -0.6 : 0.6) : 0;
    value += step;
    const band = point.confidence === '高' ? 2 : point.confidence === '中' ? 4 : 6;
    return { ...point, value: Number(value.toFixed(2)), low: Number((value - band).toFixed(2)), high: Number((value + band).toFixed(2)) };
  });
}

export function buildDecompositionContributionData(nodes: any[], snapshots: any[]): { kind: 'bidir' | 'insufficient'; points: DecompositionContribution[]; coverage: DecompositionSynthesis['coverage']; reason?: string; additiveReliable: boolean } {
  const rows = (Array.isArray(nodes) ? nodes : []).filter(node => node?.node_type === 'terminal');
  const byTrend = new Map((Array.isArray(snapshots) ? snapshots : []).map(snapshot => [Number(snapshot.trend_item_id), snapshot]));
  const completed = rows.filter(node => ['queried', 'completed'].includes(String(node.insight_status)) || byTrend.has(Number(node.trend_item_id))).length;
  const failed = rows.filter(node => ['failed', 'error'].includes(String(node.insight_status))).length;
  const skipped = rows.filter(node => ['ready', 'skipped'].includes(String(node.insight_status))).length;
  const ratios = rows.map(node => finiteNumber(node.cost_ratio_estimate)).filter((value): value is number => value != null && value >= 0);
  const completedRatios = rows.filter(node => ['queried', 'completed'].includes(String(node.insight_status)) || byTrend.has(Number(node.trend_item_id))).map(node => finiteNumber(node.cost_ratio_estimate)).filter((value): value is number => value != null && value >= 0);
  const coverage = { total: rows.length, completed, failed, skipped, rate: rows.length ? completed / rows.length : 0, costRate: ratios.length ? completedRatios.reduce((a, b) => a + b, 0) / ratios.reduce((a, b) => a + b, 0) : null };
  const points = rows.map(node => {
    const ratio = finiteNumber(node.cost_ratio_estimate);
    const snapshot = byTrend.get(Number(node.trend_item_id));
    const direction = textValue(snapshot?.direction || snapshot?.trend_direction);
    const score = directionScore[direction];
    if (ratio == null || score == null) return null;
    return { nodeId: Number(node.id), name: textValue(node.component_name) || `节点 #${node.id}`, ratio, direction, score: ratio * score, confidence: textValue(snapshot?.confidence_level || snapshot?.confidence) || '低', asOf: textValue(snapshot?.query_time), sourceType: textValue(snapshot?.source_type) || 'direct_query' } satisfies DecompositionContribution;
  }).filter((point): point is DecompositionContribution => point !== null).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const totalRatio = ratios.reduce((a, b) => a + b, 0);
  const additiveReliable = rows.length > 0 && points.length === rows.length && totalRatio >= 99 && totalRatio <= 101;
  if (points.length === 0) return { kind: 'insufficient', points, coverage, additiveReliable, reason: '子节点缺少可同时确认的成本占比和趋势方向' };
  return { kind: 'bidir', points, coverage, additiveReliable };
}

export function inferMaterialInsightMode(input: string, materialCount = 1): { mode: Exclude<MaterialInsightMode, 'auto'>; reason: string } {
  const text = String(input || '').trim();
  if (materialCount > 1 || /[、，,；;]/.test(text)) {
    return { mode: 'direct', reason: '检测到多个独立物料，按批量直接洞察处理。' };
  }
  if (/总成|模块|系统|产业链|供应链|整机|成本机会|全链|方案/.test(text)) {
    return { mode: 'decompose', reason: '主题范围较大，先生成可编辑分解预览，再选择高价值节点。' };
  }
  return { mode: 'direct', reason: '问题已明确到单一物料或型号，直接查询行情。' };
}

export function normalizeMaterialInsightLink(value: unknown): MaterialInsightLink {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const numberOrUndefined = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const mode = input.mode === 'direct' || input.mode === 'decompose' || input.mode === 'auto' ? input.mode : undefined;
  return {
    material: String(input.material || '').trim() || undefined,
    projectId: numberOrUndefined(input.projectId),
    projectCode: String(input.projectCode || '').trim() || undefined,
    partId: numberOrUndefined(input.partId),
    rootId: numberOrUndefined(input.rootId),
    prompt: String(input.prompt || '').trim() || undefined,
    mode,
  };
}

export function getSelectableInsightNodeIds(nodes: any[], selectedIds?: Iterable<number>): number[] {
  const selected = selectedIds ? new Set([...selectedIds].map(Number)) : null;
  return nodes
    .filter(node => node?.node_type === 'terminal' && node?.source_type !== 'ai_draft')
    .filter(node => !selected || selected.has(Number(node.id)))
    .map(node => Number(node.id))
    .filter(Number.isFinite);
}

export function getMaterialInsightPreviewNodes(nodes: any[], limit = 3): any[] {
  const count = Math.max(0, Math.floor(Number(limit) || 0));
  return (Array.isArray(nodes) ? nodes : [])
    .filter(node => node?.node_type === 'terminal' && node?.source_type !== 'ai_draft')
    .slice()
    .sort((a, b) => Number(b?.cost_ratio_estimate ?? -Infinity) - Number(a?.cost_ratio_estimate ?? -Infinity))
    .slice(0, count);
}

export function openMaterialInsightDraft(value: MaterialInsightLink = {}) {
  const context = normalizeMaterialInsightLink(value);
  try { localStorage.setItem('costhub-material-insight-pending', JSON.stringify(context)); } catch { }
  try { window.dispatchEvent(new CustomEvent('costhub-open-material-insight', { detail: context })); } catch { }
}
