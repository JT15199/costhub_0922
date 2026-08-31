// 招标工作台数据访问层：报价原文、轮次、规格基线和过程事件均只保存在本机 SQLite。
import { getDb, localNow } from './core';

export type MatchRelation = 'exact' | 'equivalent' | 'reference' | 'incomparable' | 'unmatched';

export interface TenderQuoteLineInput {
  source_row: number;
  raw_name: string;
  raw_model?: string;
  raw_specs?: string;
  module_name?: string;
  quantity?: number;
  unit_price?: number;
  line_total?: number;
  remark?: string;
  raw_json?: string;
  canonical_key?: string;
}

export interface ImportTenderQuoteInput {
  project_id: number;
  supplier_name: string;
  source_file_name: string;
  source_file_hash: string;
  quoted_at?: string;
  stage?: string;
  total_amount?: number;
  currency?: string;
  tax_mode?: string;
  pricing_mode?: string;
  lines: TenderQuoteLineInput[];
}

export interface TenderOffer {
  quoteLineId: number;
  batchId: number;
  supplierName: string;
  unitPrice: number;
  lineTotal: number;
  quantity: number;
  relationType: MatchRelation;
  confidence: number;
  roundNo: number;
  quotedAt: string;
  sourceFileName: string;
  rawModel: string;
  rawSpecs: string;
  remark: string;
}

export interface TenderMatrixRow {
  key: string;
  moduleName: string;
  materialName: string;
  model: string;
  specs: string;
  quantity: number;
  offers: Record<string, TenderOffer>;
  comparableLow?: { unitPrice: number; lineTotal: number; supplierName: string; quoteLineId: number };
  opportunity: number;
}

export interface QuoteBatch {
  id: number;
  projectId: number;
  roundId: number;
  roundNo: number;
  roundName: string;
  supplierName: string;
  batchNo: number;
  sourceFileName: string;
  sourceFileHash: string;
  quotedAt: string;
  status: string;
  currency: string;
  taxMode: string;
  pricingMode: string;
  totalAmount: number;
  createdAt: string;
}

export interface TenderOverview {
  currentSpec?: { id: number; versionNo: number; fingerprint: string; changedFields: string[]; createdAt: string; spec: Record<string, string> };
  currentRound?: { id: number; roundNo: number; name: string; stage: string; specBaselineId: number; createdAt: string };
  batches: QuoteBatch[];
  summary: {
    supplierCount: number;
    lineCount: number;
    comparableCount: number;
    referenceCount: number;
    unmatchedCount: number;
    comparableCoverage: number;
    theoreticalLow: number;
    bestFullQuote: number;
    opportunity: number;
  };
  events: Array<{ id: number; eventType: string; summary: string; detail: string; actor: string; createdAt: string }>;
}

export interface NegotiationItemInput {
  quoteLineId?: number;
  moduleName?: string;
  materialName: string;
  specs?: string;
  benchmarkSupplier?: string;
  benchmarkPrice?: number;
  targetSupplier?: string;
  targetPrice?: number;
  currentPrice?: number;
  note?: string;
}

export interface NegotiationItem extends NegotiationItemInput {
  id: number;
  projectId: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenderDecisionInput {
  selectedSupplier?: string;
  finalQuote?: number;
  status?: 'draft' | 'selected' | 'cancelled';
  rationale?: string;
  reviewSummary?: string;
  decidedAt?: string;
}

export interface TenderDecision extends TenderDecisionInput { id: number; projectId: number; createdAt: string; updatedAt: string; }

function text(value: unknown): string { return String(value ?? '').trim(); }
function jsonObject(value: unknown, fallback: any = {}) {
  try { return JSON.parse(text(value) || JSON.stringify(fallback)); } catch { return fallback; }
}
function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function normalize(value: unknown): string {
  return text(value).toLowerCase().replace(/[\s\u3000\-_\/\\.,，。:：()（）\[\]【】]/g, '');
}
export function makeTenderCanonicalKey(name: string, specs = '') {
  return `${normalize(name)}|${normalize(specs)}`;
}
function projectSpec(project: any): Record<string, string> {
  return {
    code: text(project?.code), name: text(project?.name), tier: text(project?.tier),
    screen_size: text(project?.screen_size), resolution: text(project?.resolution),
    refresh_rate: text(project?.refresh_rate), panel_type: text(project?.panel_type), specs: text(project?.specs),
  };
}
function fingerprintSpec(spec: Record<string, string>): string {
  // 规格指纹只用于本地幂等和版本判断，不作为安全哈希或对外标识。
  let hash = 2166136261;
  for (const ch of JSON.stringify(spec)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function ensureSpecBaseline(d: any, projectId: number, stage: string) {
  const projectRows = await d.select('SELECT * FROM projects WHERE id=?', [projectId]);
  const spec = projectSpec(projectRows[0] || {});
  const fingerprint = fingerprintSpec(spec);
  const latest = (await d.select('SELECT * FROM project_spec_baselines WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0] as any;
  if (latest?.fingerprint === fingerprint) return latest;
  const previousSpec = latest ? jsonObject(latest.spec_json, {}) : {};
  const changedFields = Object.keys(spec).filter(key => text(previousSpec[key]) !== text(spec[key]));
  const versionNo = numberValue(latest?.version_no, 0) + 1;
  const result = await d.execute(
    'INSERT INTO project_spec_baselines (project_id, version_no, fingerprint, spec_json, changed_fields_json, source_type) VALUES (?,?,?,?,?,?)',
    [projectId, versionNo, fingerprint, JSON.stringify(spec), JSON.stringify(changedFields), stage ? `quote_import:${stage}` : 'quote_import']
  );
  await recordTenderEventWithDb(d, projectId, 'spec_baseline_created', `规格基线 v${versionNo} 已冻结`, JSON.stringify({ changedFields, fingerprint }));
  return { id: result.lastInsertId, project_id: projectId, version_no: versionNo, fingerprint, spec_json: JSON.stringify(spec), changed_fields_json: JSON.stringify(changedFields), created_at: localNow() };
}

async function ensureRound(d: any, projectId: number, baseline: any, stage: string) {
  const latest = (await d.select('SELECT * FROM tender_rounds WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0] as any;
  if (latest && latest.spec_baseline_id === baseline.id && latest.stage === stage) return latest;
  const roundNo = numberValue(latest?.round_no, 0) + 1;
  const name = stage || '摸底报价';
  const result = await d.execute(
    'INSERT INTO tender_rounds (project_id, round_no, name, stage, spec_baseline_id) VALUES (?,?,?,?,?)',
    [projectId, roundNo, name, stage || '摸底报价', baseline.id]
  );
  await recordTenderEventWithDb(d, projectId, 'tender_round_created', `已创建第${roundNo}轮${name}`, JSON.stringify({ roundNo, stage, specBaselineId: baseline.id }));
  return { id: result.lastInsertId, project_id: projectId, round_no: roundNo, name, stage: stage || '摸底报价', spec_baseline_id: baseline.id, created_at: localNow() };
}

async function recordTenderEventWithDb(d: any, projectId: number, eventType: string, summary: string, detail = '') {
  const result = await d.execute('INSERT INTO project_process_events (project_id, event_type, summary, detail) VALUES (?,?,?,?)', [projectId, eventType, summary, detail]);
  return result.lastInsertId as number;
}

export async function recordTenderEvent(projectId: number, eventType: string, summary: string, detail = '') {
  return recordTenderEventWithDb(await getDb(), projectId, eventType, summary, detail);
}

export async function importTenderQuoteBatch(input: ImportTenderQuoteInput) {
  const d = await getDb();
  const duplicate = (await d.select<any[]>('SELECT id FROM supplier_quote_batches WHERE project_id=? AND source_file_hash=? LIMIT 1', [input.project_id, input.source_file_hash]))[0];
  if (duplicate) {
    return { batchId: duplicate.id as number, roundId: 0, specBaselineId: 0, duplicate: true, importedLines: 0, roundLabel: '已导入' };
  }
  const stage = text(input.stage) || '摸底报价';
  const baseline = await ensureSpecBaseline(d, input.project_id, stage);
  const round = await ensureRound(d, input.project_id, baseline, stage);
  const previous = await d.select<any[]>('SELECT l.canonical_key, l.raw_model, b.supplier_name FROM supplier_quote_lines l JOIN supplier_quote_batches b ON b.id=l.batch_id WHERE l.canonical_key<>?', ['']);
  // 只有跨供应商的相同键才自动标记 exact；同一供应商重复行不能制造“可比价”。
  const previousOtherSupplier = new Set(previous.filter(row => text(row.canonical_key) && text(row.supplier_name) !== text(input.supplier_name)).map(row => `${row.canonical_key}|${normalize(row.raw_model)}`));
  const batchNo = numberValue((await d.select<any[]>('SELECT MAX(batch_no) as max_no FROM supplier_quote_batches WHERE project_id=? AND supplier_name=?', [input.project_id, input.supplier_name]))[0]?.max_no, 0) + 1;
  const batchResult = await d.execute(
    'INSERT INTO supplier_quote_batches (project_id, tender_round_id, supplier_name, batch_no, source_file_name, source_file_hash, quoted_at, currency, tax_mode, pricing_mode, total_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [input.project_id, round.id, text(input.supplier_name), batchNo, text(input.source_file_name), text(input.source_file_hash), text(input.quoted_at) || localNow(), text(input.currency) || 'CNY', text(input.tax_mode) || 'exclusive', text(input.pricing_mode) || 'one_time', numberValue(input.total_amount)]
  );
  let importedLines = 0;
  for (const line of input.lines || []) {
    const name = text(line.raw_name);
    if (!name) continue;
    const quantity = numberValue(line.quantity, 1) || 1;
    const unitPrice = numberValue(line.unit_price);
    const lineTotal = numberValue(line.line_total, unitPrice * quantity);
    const canonicalKey = text(line.canonical_key) || makeTenderCanonicalKey(name, line.raw_specs);
    const relation: MatchRelation = previousOtherSupplier.has(`${canonicalKey}|${normalize(line.raw_model)}`) ? 'exact' : 'unmatched';
    const confidence = relation === 'exact' ? 0.98 : 0;
    const lineResult = await d.execute(
      'INSERT INTO supplier_quote_lines (batch_id, source_row, raw_name, raw_model, raw_specs, module_name, quantity, unit_price, line_total, remark, raw_json, canonical_key, relation_type, match_confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [batchResult.lastInsertId, numberValue(line.source_row, importedLines + 1), name, text(line.raw_model), text(line.raw_specs), text(line.module_name), quantity, unitPrice, lineTotal, text(line.remark), text(line.raw_json) || JSON.stringify(line), canonicalKey, relation, confidence]
    );
    await d.execute('INSERT INTO quote_line_matches (quote_line_id, relation_type, confidence, source, remark) VALUES (?,?,?,?,?)', [lineResult.lastInsertId, relation, confidence, 'rule', relation === 'exact' ? '名称+规格+型号标准化键一致' : '等待人工确认']);
    importedLines += 1;
  }
  await recordTenderEventWithDb(d, input.project_id, 'quote_imported', `${input.supplier_name} 第${batchNo}份报价已导入`, JSON.stringify({ batchId: batchResult.lastInsertId, supplierName: input.supplier_name, importedLines, sourceFileName: input.source_file_name }));
  return { batchId: batchResult.lastInsertId as number, roundId: round.id as number, specBaselineId: baseline.id as number, duplicate: false, importedLines, roundLabel: `第${round.round_no}轮 · ${round.name}` };
}

function mapBatch(row: any): QuoteBatch {
  return { id: row.id, projectId: row.project_id, roundId: row.round_id, roundNo: row.round_no, roundName: row.round_name, supplierName: row.supplier_name, batchNo: row.batch_no, sourceFileName: row.source_file_name, sourceFileHash: row.source_file_hash, quotedAt: row.quoted_at, status: row.status, currency: row.currency, taxMode: row.tax_mode, pricingMode: row.pricing_mode, totalAmount: numberValue(row.total_amount), createdAt: row.created_at };
}

export async function getTenderQuoteBatches(projectId: number): Promise<QuoteBatch[]> {
  const rows = await (await getDb()).select<any[]>(`SELECT b.*, r.round_no, r.name as round_name, r.id as round_id
    FROM supplier_quote_batches b JOIN tender_rounds r ON r.id=b.tender_round_id
    WHERE b.project_id=? ORDER BY b.id DESC`, [projectId]);
  return rows.map(mapBatch);
}

export async function getTenderMatrix(projectId: number): Promise<TenderMatrixRow[]> {
  const d = await getDb();
  const batches = await getTenderQuoteBatches(projectId);
  const currentRoundId = batches[0]?.roundId;
  const selected: QuoteBatch[] = [];
  for (const batch of batches) {
    if (currentRoundId && batch.roundId !== currentRoundId) continue;
    if (!selected.some(item => item.supplierName === batch.supplierName)) selected.push(batch);
  }
  if (!selected.length) return [];
  const placeholders = selected.map(() => '?').join(',');
  const rows = await d.select<any[]>(`SELECT l.*, b.supplier_name, b.id as batch_id, b.source_file_name, b.quoted_at, r.round_no
    FROM supplier_quote_lines l JOIN supplier_quote_batches b ON b.id=l.batch_id JOIN tender_rounds r ON r.id=b.tender_round_id
    WHERE l.batch_id IN (${placeholders}) ORDER BY l.module_name, l.id`, selected.map(batch => batch.id));
  const groups = new Map<string, TenderMatrixRow>();
  for (const row of rows) {
    const key = text(row.canonical_key) || makeTenderCanonicalKey(row.raw_name, row.raw_specs);
    const existing = groups.get(key) || { key, moduleName: text(row.module_name), materialName: text(row.raw_name), model: text(row.raw_model), specs: text(row.raw_specs), quantity: numberValue(row.quantity, 1), offers: {}, opportunity: 0 };
    const offer: TenderOffer = { quoteLineId: row.id, batchId: row.batch_id, supplierName: text(row.supplier_name), unitPrice: numberValue(row.unit_price), lineTotal: numberValue(row.line_total), quantity: numberValue(row.quantity, 1), relationType: (text(row.relation_type) || 'unmatched') as MatchRelation, confidence: numberValue(row.match_confidence), roundNo: numberValue(row.round_no), quotedAt: text(row.quoted_at), sourceFileName: text(row.source_file_name), rawModel: text(row.raw_model), rawSpecs: text(row.raw_specs), remark: text(row.remark) };
    existing.offers[offer.supplierName] = offer;
    if (!existing.moduleName) existing.moduleName = text(row.module_name);
    if (!existing.model) existing.model = text(row.raw_model);
    if (!existing.specs) existing.specs = text(row.raw_specs);
    groups.set(key, existing);
  }
  return Array.from(groups.values()).map(row => {
    const comparable = Object.values(row.offers).filter(offer => offer.relationType === 'exact' || offer.relationType === 'equivalent');
    if (comparable.length) {
      const low = comparable.reduce((best, item) => item.lineTotal < best.lineTotal ? item : best);
      row.comparableLow = { unitPrice: low.unitPrice, lineTotal: low.lineTotal, supplierName: low.supplierName, quoteLineId: low.quoteLineId };
      const prices = comparable.map(item => item.lineTotal);
      row.opportunity = Math.max(0, Math.max(...prices) - Math.min(...prices));
    }
    return row;
  });
}

export async function updateTenderLineMatch(lineId: number, relation: MatchRelation, confidence = 0, remark = '') {
  const d = await getDb();
  const line = (await d.select<any[]>('SELECT id, batch_id FROM supplier_quote_lines WHERE id=?', [lineId]))[0];
  if (!line) throw new Error('报价行不存在');
  await d.execute('UPDATE supplier_quote_lines SET relation_type=?, match_confidence=? WHERE id=?', [relation, confidence, lineId]);
  await d.execute('INSERT INTO quote_line_matches (quote_line_id, relation_type, confidence, source, remark) VALUES (?,?,?,?,?)', [lineId, relation, confidence, 'user', remark]);
  const batch = (await d.select<any[]>('SELECT project_id FROM supplier_quote_batches WHERE id=?', [line.batch_id]))[0];
  if (batch) await recordTenderEventWithDb(d, batch.project_id, 'quote_match_confirmed', `报价行已标记为${relation}`, JSON.stringify({ lineId, relation, confidence, remark }));
}

export async function getTenderOverview(projectId: number): Promise<TenderOverview> {
  const d = await getDb();
  const specRow = (await d.select<any[]>('SELECT * FROM project_spec_baselines WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0];
  const roundRow = (await d.select<any[]>('SELECT * FROM tender_rounds WHERE project_id=? ORDER BY id DESC LIMIT 1', [projectId]))[0];
  const batches = await getTenderQuoteBatches(projectId);
  const matrix = await getTenderMatrix(projectId);
  const currentBatches = roundRow ? batches.filter(batch => batch.roundId === roundRow.id) : batches;
  const offers = matrix.flatMap(row => Object.values(row.offers));
  const comparableCount = offers.filter(offer => offer.relationType === 'exact' || offer.relationType === 'equivalent').length;
  const referenceCount = offers.filter(offer => offer.relationType === 'reference').length;
  const unmatchedCount = offers.filter(offer => offer.relationType === 'unmatched').length;
  const theoreticalLow = matrix.reduce((sum, row) => sum + (row.comparableLow?.lineTotal || 0), 0);
  const fullQuotes = currentBatches.map(batch => batch.totalAmount).filter(value => value > 0);
  const bestFullQuote = fullQuotes.length ? Math.min(...fullQuotes) : 0;
  const opportunity = matrix.reduce((sum, row) => sum + row.opportunity, 0);
  const events = await d.select<any[]>('SELECT id, event_type, summary, detail, actor, created_at FROM project_process_events WHERE project_id=? ORDER BY id DESC LIMIT 30', [projectId]);
  return {
    currentSpec: specRow ? { id: specRow.id, versionNo: specRow.version_no, fingerprint: specRow.fingerprint, changedFields: jsonObject(specRow.changed_fields_json, []), createdAt: specRow.created_at, spec: jsonObject(specRow.spec_json, {}) } : undefined,
    currentRound: roundRow ? { id: roundRow.id, roundNo: roundRow.round_no, name: roundRow.name, stage: roundRow.stage, specBaselineId: roundRow.spec_baseline_id, createdAt: roundRow.created_at } : undefined,
    batches, summary: { supplierCount: new Set(currentBatches.map(batch => batch.supplierName)).size, lineCount: offers.length, comparableCount, referenceCount, unmatchedCount, comparableCoverage: offers.length ? comparableCount / offers.length : 0, theoreticalLow, bestFullQuote, opportunity },
    events: events.map(row => ({ id: row.id, eventType: row.event_type, summary: row.summary, detail: row.detail, actor: row.actor, createdAt: row.created_at })),
  };
}

export async function saveNegotiationItems(projectId: number, items: NegotiationItemInput[]) {
  const d = await getDb();
  let saved = 0;
  for (const item of items || []) {
    if (!text(item.materialName)) continue;
    const quoteLineId = numberValue(item.quoteLineId, 0) || null;
    const existing = quoteLineId ? (await d.select<any[]>('SELECT id FROM negotiation_items WHERE project_id=? AND quote_line_id=? AND target_supplier=? LIMIT 1', [projectId, quoteLineId, text(item.targetSupplier)]))[0] : null;
    const values = [projectId, quoteLineId, text(item.moduleName), text(item.materialName), text(item.specs), text(item.benchmarkSupplier), numberValue(item.benchmarkPrice), text(item.targetSupplier), numberValue(item.targetPrice), numberValue(item.currentPrice), text(item.note)];
    if (existing) {
      await d.execute('UPDATE negotiation_items SET module_name=?, material_name=?, specs=?, benchmark_supplier=?, benchmark_price=?, target_price=?, current_price=?, note=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [values[2], values[3], values[4], values[5], values[6], values[8], values[9], values[10], existing.id]);
    } else {
      await d.execute('INSERT INTO negotiation_items (project_id, quote_line_id, module_name, material_name, specs, benchmark_supplier, benchmark_price, target_supplier, target_price, current_price, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)', values);
    }
    saved += 1;
  }
  if (saved) await recordTenderEventWithDb(d, projectId, 'negotiation_items_created', `已沉淀${saved}条议价清单`, JSON.stringify({ saved }));
  return saved;
}

export async function getNegotiationItems(projectId: number): Promise<NegotiationItem[]> {
  const rows = await (await getDb()).select<any[]>('SELECT * FROM negotiation_items WHERE project_id=? ORDER BY CASE status WHEN \'draft\' THEN 0 WHEN \'sent\' THEN 1 WHEN \'agreed\' THEN 2 ELSE 3 END, id DESC', [projectId]);
  return rows.map(row => ({ id: row.id, projectId: row.project_id, quoteLineId: row.quote_line_id || undefined, moduleName: row.module_name, materialName: row.material_name, specs: row.specs, benchmarkSupplier: row.benchmark_supplier, benchmarkPrice: numberValue(row.benchmark_price), targetSupplier: row.target_supplier, targetPrice: numberValue(row.target_price), currentPrice: numberValue(row.current_price), status: row.status, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function updateNegotiationItemStatus(id: number, status: 'draft' | 'sent' | 'agreed' | 'closed', note = '') {
  const d = await getDb();
  const item = (await d.select<any[]>('SELECT project_id FROM negotiation_items WHERE id=?', [id]))[0];
  if (!item) throw new Error('议价项不存在');
  await d.execute('UPDATE negotiation_items SET status=?, note=CASE WHEN ?<>\'\' THEN ? ELSE note END, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [status, note, note, id]);
  await recordTenderEventWithDb(d, item.project_id, 'negotiation_status_changed', `议价项状态更新为${status}`, JSON.stringify({ id, status }));
}

export async function getTenderDecision(projectId: number): Promise<TenderDecision | null> {
  const row = (await (await getDb()).select<any[]>('SELECT * FROM tender_decisions WHERE project_id=? LIMIT 1', [projectId]))[0];
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, selectedSupplier: row.selected_supplier, finalQuote: numberValue(row.final_quote), status: row.status, rationale: row.rationale, reviewSummary: row.review_summary, decidedAt: row.decided_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function saveTenderDecision(projectId: number, input: TenderDecisionInput) {
  const d = await getDb();
  const existing = (await d.select<any[]>('SELECT id FROM tender_decisions WHERE project_id=? LIMIT 1', [projectId]))[0];
  const values = [text(input.selectedSupplier), numberValue(input.finalQuote), text(input.status) || 'draft', text(input.rationale), text(input.reviewSummary), text(input.decidedAt) || localNow()];
  if (existing) {
    await d.execute('UPDATE tender_decisions SET selected_supplier=?, final_quote=?, status=?, rationale=?, review_summary=?, decided_at=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [...values, existing.id]);
  } else {
    const result = await d.execute('INSERT INTO tender_decisions (project_id, selected_supplier, final_quote, status, rationale, review_summary, decided_at) VALUES (?,?,?,?,?,?,?)', [projectId, ...values]);
    await recordTenderEventWithDb(d, projectId, 'tender_decision_saved', `已保存定点/复盘记录（${values[0] || '供应商待定'}）`, JSON.stringify({ decisionId: result.lastInsertId, status: values[2] }));
    return result.lastInsertId as number;
  }
  await recordTenderEventWithDb(d, projectId, 'tender_decision_saved', `已更新定点/复盘记录（${values[0] || '供应商待定'}）`, JSON.stringify({ decisionId: existing.id, status: values[2] }));
  return existing.id as number;
}
