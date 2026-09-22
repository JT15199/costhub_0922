export type CostDimension = 'project' | 'domain' | 'module' | 'part' | 'supplier' | 'quote_round' | 'spec_version';
export type CostMetric = 'unit_cost' | 'extended_cost' | 'target_gap' | 'price_delta' | 'quote_low' | 'quote_median' | 'confidence';

export interface CostQuerySpec {
  scope: { projectIds?: number[]; category?: string; dateFrom?: string; dateTo?: string };
  dimensions: CostDimension[];
  metrics: CostMetric[];
  filters?: Array<{ field: string; op: 'eq' | 'in' | 'gte' | 'lte' | 'contains'; value: unknown }>;
  limit?: number;
}

export type EvidenceRefType = 'project' | 'bom' | 'part' | 'quote_batch' | 'quote_line' | 'snapshot' | 'history' | 'target';

export interface EvidenceRef {
  refType: EvidenceRefType;
  refId: number;
  label: string;
  field?: string;
  value?: string | number;
  observedAt?: string;
  deepLink?: { page: string; params: Record<string, string | number> };
}

export interface DisplaySpec {
  type: 'table' | 'chart' | 'summary';
  title?: string;
  columns?: string[];
}

export interface AiToolResult<T> {
  ok: boolean;
  summary: string;
  data: T;
  evidence: EvidenceRef[];
  warnings: string[];
  freshness: string;
  display?: DisplaySpec;
}

export interface AiRecommendation {
  id?: number;
  title: string;
  conclusion: string;
  evidence: EvidenceRef[];
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  expectedImpact?: { min: number; max: number; currency: 'CNY' };
  action: { label: string; type: 'open' | 'todo' | 'draft' };
  dataGaps: string[];
  risks: string[];
  status?: 'open' | 'useful' | 'not_useful' | 'adopted' | 'dismissed' | 'done';
  source?: string;
  createdAt?: string;
}

export interface VerifyResult {
  ok: boolean;
  reasons: string[];
  unverifiedNumbers: Array<{ num: number; context: string }>;
  evidence: EvidenceRef[];
}

export interface AnalysisRequest {
  question: string;
  pageContext?: { page: string; projectId?: number; selectedIds?: number[] };
  preferredSkill?: string;
}

export interface AnalysisRunResult {
  runId: string;
  answer: string;
  recommendations: AiRecommendation[];
  evidence: EvidenceRef[];
  warnings: string[];
  skillId: string;
  skillVersion: string;
}

export type AiToolKind = 'read' | 'calculate' | 'write' | 'cloud';
export type AiToolRisk = 'low' | 'medium' | 'high';
export type EvidencePolicy = 'required' | 'optional' | 'none';

export interface AiToolManifest {
  id: string;
  kind: AiToolKind;
  risk: AiToolRisk;
  requiresConfirmation: boolean;
  requiredData: string[];
  outputSchema: string;
  evidencePolicy: EvidencePolicy;
  maxRows?: number;

  // ── Agent Runtime V1（Stage 2）新增：全部可选，42 个既有 manifest 不改也能跑 ──

  /**
   * 该工具读取数据的敏感级别。
   * 缺省（未声明）时按 `internal` 处理 —— 见 `resolveToolPrivacyLevel`。
   */
  privacyLevel?: ToolPrivacyLevel;
  /**
   * 该工具输出是否允许参与云端上下文。
   *
   * **fail-closed 规则（`resolveToolCloudEligible`）**：
   *   * `privacyLevel === 'sensitive'` → 恒为 false（即使显式写 true 也不放行）
   *   * 未显式声明 → 仅 `privacyLevel === 'public'` 时为 true
   * 因此「漏标」的默认结果是**不可上云**，而不是默认放行。
   */
  cloudEligible?: boolean;
}

/** 工具数据的敏感级别。 */
export type ToolPrivacyLevel = 'public' | 'internal' | 'sensitive';

/** 未声明 `privacyLevel` 时的保守缺省。 */
export const DEFAULT_TOOL_PRIVACY_LEVEL: ToolPrivacyLevel = 'internal';

/** 隐私级别严格度排序（数值越大越敏感），用于跨工具取最严。 */
const PRIVACY_SEVERITY: Record<ToolPrivacyLevel, number> = { public: 0, internal: 1, sensitive: 2 };

/**
 * 解析单个工具的有效隐私级别。
 * 未声明 → `internal`（保守缺省，不假设为 public）。
 */
export function resolveToolPrivacyLevel(manifest?: Pick<AiToolManifest, 'privacyLevel'> | null): ToolPrivacyLevel {
  const declared = manifest?.privacyLevel;
  return declared === 'public' || declared === 'internal' || declared === 'sensitive'
    ? declared
    : DEFAULT_TOOL_PRIVACY_LEVEL;
}

/**
 * 解析单个工具的输出是否可进入云端上下文（fail-closed）。
 *
 * 这是「工具隐私声明」真正生效的地方：无论调用方怎么声明，
 * sensitive 一律 false；未声明的一律只有在显式 public 时才 true。
 */
export function resolveToolCloudEligible(manifest?: Pick<AiToolManifest, 'privacyLevel' | 'cloudEligible'> | null): boolean {
  const level = resolveToolPrivacyLevel(manifest);
  if (level === 'sensitive') return false;
  if (manifest?.cloudEligible === false) return false;
  if (manifest?.cloudEligible === true) return level === 'public';
  return level === 'public';
}

/** 跨多个工具取最严的隐私级别（用于「本轮有哪些工具可用 / 被调用」的聚合）。 */
export function strictestPrivacyLevel(levels: ToolPrivacyLevel[]): ToolPrivacyLevel {
  let worst: ToolPrivacyLevel = 'public';
  for (const level of levels) {
    if (PRIVACY_SEVERITY[level] > PRIVACY_SEVERITY[worst]) worst = level;
  }
  return worst;
}

/** 任一工具不可上云 → 整体不可上云。 */
export function allCloudEligible(flags: boolean[]): boolean {
  return flags.length > 0 && flags.every(Boolean);
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface RunContext {
  runId?: string;
  pageContext?: { page: string; projectId?: number; selectedIds?: number[] };
}

export interface ExecuteToolOptions {
  confirmed?: boolean;
  networkTrace?: import('./networkTrace').AiNetworkTraceSink;
}

export interface BomCostRow {
  part_cost?: number | string | null;
  cost?: number | string | null;
  quantity?: number | string | null;
  module_name?: string | null;
  main_category?: string | null;
  sub_category?: string | null;
  price_state?: PriceState | string | null;
}

export type PriceState = 'confirmed' | 'unknown' | 'invalid';

export function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bomUnitCost(row: BomCostRow): number {
  return toFiniteNumber(row.part_cost ?? row.cost);
}

export function bomPriceState(row: BomCostRow): PriceState {
  const value = row.part_cost ?? row.cost;
  if (value === undefined || value === null || value === '') return 'unknown';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 'invalid';
  if (row.price_state === 'confirmed' || row.price_state === 'unknown' || row.price_state === 'invalid') return row.price_state;
  // A zero price is only formal evidence when the row explicitly says confirmed;
  // legacy rows without a state cannot distinguish free from missing.
  return numeric > 0 ? 'confirmed' : 'unknown';
}

export function bomQuantity(row: BomCostRow): number {
  return row.quantity === undefined || row.quantity === null || row.quantity === ''
    ? 1
    : toFiniteNumber(row.quantity, 1);
}

export function bomQuantityState(row: BomCostRow): 'confirmed' | 'unknown' | 'invalid' {
  if (row.quantity === undefined || row.quantity === null || row.quantity === '') return 'unknown';
  return Number.isFinite(Number(row.quantity)) && Number(row.quantity) >= 0 ? 'confirmed' : 'invalid';
}

export function bomExtendedCost(row: BomCostRow): number {
  return bomUnitCost(row) * bomQuantity(row);
}

export function bomExtendedCostStrict(row: BomCostRow): number | null {
  return bomPriceState(row) === 'confirmed' && bomQuantityState(row) === 'confirmed' ? bomExtendedCost(row) : null;
}

export function sumBomCost(rows: BomCostRow[]): number {
  return rows.reduce((sum, row) => sum + bomExtendedCost(row), 0);
}

export function sumBomCostStrict(rows: BomCostRow[]) {
  const missing = rows.filter(row => bomExtendedCostStrict(row) === null);
  return { total: rows.reduce((sum, row) => sum + (bomExtendedCostStrict(row) ?? 0), 0), missing };
}

export function groupBomCost(rows: BomCostRow[], dimension: 'module' | 'main_category' | 'sub_category'): Map<string, number> {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[dimension === 'module' ? 'module_name' : dimension] || (dimension === 'module' ? '未分模块' : '未分类'));
    groups.set(key, (groups.get(key) || 0) + bomExtendedCost(row));
  }
  return groups;
}

export function limitRows<T>(rows: T[], limit = 200): { rows: T[]; truncated: boolean } {
  const safeLimit = Math.max(1, Math.min(Math.floor(toFiniteNumber(limit, 200)), 200));
  return { rows: rows.slice(0, safeLimit), truncated: rows.length > safeLimit };
}
