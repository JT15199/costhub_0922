import { getDb, getProjects, getProjectBOMs, getTenderMatrix, getTenderOverview, getTenderQuoteBatches, localNow } from '../../db';
import { resolveProject } from '../entityResolver';
import { limitRows, sumBomCostStrict, toFiniteNumber, type AiToolResult, type EvidenceRef, type ToolCall } from '../contracts';

const text = (value: unknown) => String(value ?? '').trim();
const money = (value: number) => '¥' + value.toFixed(2);
const link = (id: number) => ({ page: 'projects', params: { projectId: id } });
const evidence = (refType: EvidenceRef['refType'], refId: number, label: string, field: string, value: string | number, projectId?: number): EvidenceRef => ({ refType, refId, label, field, value, observedAt: localNow(), ...(projectId ? { deepLink: link(projectId) } : {}) });
const success = <T>(summary: string, data: T, refs: EvidenceRef[], warnings: string[] = []): AiToolResult<T> => ({ ok: true, summary, data, evidence: refs, warnings, freshness: '本地 SQLite，查询于 ' + localNow(), display: { type: 'table' } });
const failure = <T>(summary: string): AiToolResult<T> => ({ ok: false, summary, data: null as T, evidence: [], warnings: [summary], freshness: '本地 SQLite，查询于 ' + localNow() });

export async function estimateSimilarProjects(args: Record<string, unknown>): Promise<AiToolResult<any>> {
  const input = text(args.project_code);
  const resolved = await resolveProject(input);
  if (!resolved.selected) return failure('项目未能唯一解析：' + input + (resolved.candidates.length ? '；候选：' + resolved.candidates.slice(0, 5).map(x => x.project.code).join('、') : ''));
  const target = resolved.selected;
  const projects = (await getProjects('', '', '')).filter((project: any) => !project.is_deleted && Number(project.id) !== Number(target.id));
  const specKeys = ['screen_size', 'resolution', 'refresh_rate', 'panel_type', 'tier'];
  const scored: any[] = [];
  const refs: EvidenceRef[] = [evidence('project', Number(target.id), '目标项目 ' + text(target.code), 'project_id', Number(target.id), Number(target.id))];
  const targetBom = (await getProjectBOMs(Number(target.id))).filter((row: any) => !row.is_deleted);
  const targetCostState = sumBomCostStrict(targetBom);
  if (targetCostState.missing.length) return failure('目标项目 ' + text(target.code) + ' 存在成本或数量证据缺口，暂不能做可靠的类似项目预估');
  const targetCost = targetCostState.total;
  refs.push(evidence('project', Number(target.id), text(target.code) + ' 当前 BOM 成本', 'bom_cost', targetCost, Number(target.id)));
  for (const project of projects) {
    const matches = specKeys.filter(key => text(project[key]) && text(project[key]) === text(target[key])).length;
    const similarity = matches / specKeys.length;
    if (similarity <= 0) continue;
    const boms = (await getProjectBOMs(Number(project.id))).filter((row: any) => !row.is_deleted);
    const costState = sumBomCostStrict(boms);
    if (costState.missing.length) continue;
    const cost = costState.total;
    scored.push({ projectId: Number(project.id), code: text(project.code), name: text(project.name), similarity: Math.round(similarity * 100), matchedFields: specKeys.filter(key => text(project[key]) && text(project[key]) === text(target[key])), bomCost: cost, costDelta: cost - targetCost, sampleCount: boms.length });
  }
  scored.sort((a, b) => b.similarity - a.similarity || Math.abs(a.costDelta) - Math.abs(b.costDelta));
  const limited = limitRows(scored, Math.min(Number(args.limit) || 3, 3));
  limited.rows.forEach(row => refs.push(evidence('project', row.projectId, '参考项目 ' + row.code + ' BOM 成本', 'bom_cost', row.bomCost, row.projectId)));
  if (!limited.rows.length) return success('没有找到可比历史项目，无法形成成本区间', { target: { code: text(target.code), bomCost: targetCost }, rows: [] }, refs, ['规格匹配样本不足']);
  const costs = limited.rows.map(row => row.bomCost).filter((value: number) => value > 0);
  const range = { min: Math.min(...costs), max: Math.max(...costs) };
  return success('项目 ' + text(target.code) + ' 找到 ' + limited.rows.length + ' 个可参考历史项目，成本区间 ' + money(range.min) + '～' + money(range.max) + '；相似度和差异字段已列明。', { target: { id: Number(target.id), code: text(target.code), bomCost: targetCost }, range, rows: limited.rows }, refs, [
    ...(costs.length < 3 ? ['历史可比样本少于 3 个，置信度降为中/低'] : []),
    ...(limited.truncated ? ['结果已按行数上限截断'] : []),
  ]);
}

export async function rankQuoteNegotiations(args: Record<string, unknown>): Promise<AiToolResult<any>> {
  const input = text(args.project_code);
  const resolved = await resolveProject(input);
  if (!resolved.selected) return failure('项目未能唯一解析：' + input);
  const projectId = Number(resolved.selected.id);
  const [overview, matrix] = await Promise.all([getTenderOverview(projectId), getTenderMatrix(projectId)]);
  const rows = matrix.filter(row => row.comparableLow).map(row => {
    const comparable = Object.values(row.offers).filter(offer => offer.relationType === 'exact' || offer.relationType === 'equivalent');
    const high = Math.max(...comparable.map(offer => offer.lineTotal));
    return { material: row.materialName, module: row.moduleName, model: row.model, comparableCount: comparable.length, low: row.comparableLow, opportunity: Math.max(0, high - row.comparableLow!.lineTotal), offers: comparable.map(offer => ({ supplier: offer.supplierName, unitPrice: offer.unitPrice, lineTotal: offer.lineTotal, relation: offer.relationType, quoteLineId: offer.quoteLineId })) };
  }).sort((a, b) => b.opportunity - a.opportunity);
  const limited = limitRows(rows, Math.min(Number(args.limit) || 20, 20));
  const refs: EvidenceRef[] = [evidence('project', projectId, '项目 ' + text(resolved.selected.code) + ' 理论组合底价', 'theoretical_low', overview.summary.theoreticalLow, projectId)];
  limited.rows.forEach(row => {
    for (const offer of row.offers) refs.push(evidence('quote_line', offer.quoteLineId, row.material + ' · ' + offer.supplier, 'line_total', offer.lineTotal, projectId));
  });
  const totalOpportunity = rows.reduce((sum, row) => sum + row.opportunity, 0);
  return success('项目 ' + text(resolved.selected.code) + ' 有 ' + rows.length + ' 个可比议价项，理论可争取金额 ' + money(totalOpportunity) + '；已按金额从高到低排序。', { project: { id: projectId, code: text(resolved.selected.code) }, summary: overview.summary, rows: limited.rows, theoreticalSavings: totalOpportunity }, refs, [
    ...(overview.summary.referenceCount + overview.summary.unmatchedCount > 0 ? ['reference/unmatched 报价不计入理论底价'] : []),
    ...(rows.length === 0 ? ['暂无 exact/equivalent 可比报价，请先确认报价行关系'] : []),
  ]);
}

export async function explainQuoteChange(args: Record<string, unknown>): Promise<AiToolResult<any>> {
  const input = text(args.project_code);
  const resolved = await resolveProject(input);
  if (!resolved.selected) return failure('项目未能唯一解析：' + input);
  const projectId = Number(resolved.selected.id);
  const batches = (await getTenderQuoteBatches(projectId)).sort((a, b) => a.id - b.id);
  if (batches.length < 2) return failure('项目 ' + text(resolved.selected.code) + ' 少于两个报价批次，无法做轮次归因');
  const d = await getDb();
  const [before, after] = batches.slice(-2);
  const loadLines = (batchId: number) => d.select<any[]>('SELECT * FROM supplier_quote_lines WHERE batch_id=? ORDER BY id', [batchId]);
  const [oldLines, newLines] = await Promise.all([loadLines(before.id), loadLines(after.id)]);
  const oldMap = new Map(oldLines.map(row => [text(row.canonical_key) || text(row.raw_name), row]));
  const newMap = new Map(newLines.map(row => [text(row.canonical_key) || text(row.raw_name), row]));
  const changes: any[] = [];
  const refs: EvidenceRef[] = [evidence('quote_batch', before.id, before.supplierName + ' 第' + before.batchNo + '批报价', 'total_amount', before.totalAmount, projectId), evidence('quote_batch', after.id, after.supplierName + ' 第' + after.batchNo + '批报价', 'total_amount', after.totalAmount, projectId)];
  for (const [key, row] of newMap) {
    const old = oldMap.get(key);
    if (!old) { changes.push({ type: '新增物料', key, name: row.raw_name, quantity: toFiniteNumber(row.quantity, 1), unitPrice: toFiniteNumber(row.unit_price), impact: toFiniteNumber(row.line_total) }); refs.push(evidence('quote_line', Number(row.id), row.raw_name + ' 新增', 'line_total', toFiniteNumber(row.line_total), projectId)); continue; }
    const quantityDelta = toFiniteNumber(row.quantity, 1) - toFiniteNumber(old.quantity, 1);
    const unitPriceDelta = toFiniteNumber(row.unit_price) - toFiniteNumber(old.unit_price);
    const impact = toFiniteNumber(row.line_total) - toFiniteNumber(old.line_total);
    if (Math.abs(quantityDelta) > 0.0001 || Math.abs(unitPriceDelta) > 0.0001) changes.push({ type: '数量/单价变化', key, name: row.raw_name, quantityDelta, unitPriceDelta, impact });
    refs.push(evidence('quote_line', Number(row.id), row.raw_name + ' 新批次小计', 'line_total', toFiniteNumber(row.line_total), projectId));
  }
  for (const [key, row] of oldMap) if (!newMap.has(key)) { changes.push({ type: '删除物料', key, name: row.raw_name, quantity: toFiniteNumber(row.quantity, 1), unitPrice: toFiniteNumber(row.unit_price), impact: -toFiniteNumber(row.line_total) }); refs.push(evidence('quote_line', Number(row.id), row.raw_name + ' 删除', 'line_total', toFiniteNumber(row.line_total), projectId)); }
  const oldTotal = before.totalAmount || oldLines.reduce((sum, row) => sum + toFiniteNumber(row.line_total), 0);
  const newTotal = after.totalAmount || newLines.reduce((sum, row) => sum + toFiniteNumber(row.line_total), 0);
  const delta = newTotal - oldTotal;
  return success('已拆分 ' + before.supplierName + ' 第' + before.batchNo + '批 → 第' + after.batchNo + '批：报价变化 ' + (delta >= 0 ? '+' : '') + money(delta) + '，识别 ' + changes.length + ' 项数量/单价/新增删除变化。', { before: { id: before.id, batchNo: before.batchNo, total: oldTotal }, after: { id: after.id, batchNo: after.batchNo, total: newTotal }, delta, changes }, refs, ['规格基线独立记录在项目规格版本中；本次金额归因只基于报价行数量、单价和新增/删除']);
}

export const SKILL_TOOL_IDS = ['estimate_similar_projects', 'rank_quote_negotiations', 'explain_quote_change'] as const;

export async function executeSkillTool(call: ToolCall): Promise<AiToolResult<unknown>> {
  switch (call.name) {
    case 'estimate_similar_projects': return estimateSimilarProjects(call.args);
    case 'rank_quote_negotiations': return rankQuoteNegotiations(call.args);
    case 'explain_quote_change': return explainQuoteChange(call.args);
    default: return failure('未知 Skill 工具：' + call.name);
  }
}
