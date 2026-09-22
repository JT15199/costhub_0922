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
