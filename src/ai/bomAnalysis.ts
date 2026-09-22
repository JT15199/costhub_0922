import { bomExtendedCostStrict, bomPriceState, bomUnitCost, bomQuantityState, sumBomCostStrict } from './contracts';

/** Compute over all matching BOM rows before limiting the response. No model arithmetic. */
export function analyzeBom(rows: any[], args: Record<string, unknown>) {
  const view = String(args.view || 'summary');
  const metric = String(args.metric || 'unit_cost');
  const order = String(args.order || 'desc');
  const groupBy = String(args.group_by || 'module');
  const limit = Number(args.limit ?? 5);
  if (!['summary', 'rank', 'group'].includes(view) || !['unit_cost', 'extended_cost'].includes(metric) || !['asc', 'desc'].includes(order) || !['module', 'category', 'sub_category'].includes(groupBy) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('统计参数无效');
  const matched = rows.filter(row => !row.is_deleted
    && (!args.module || row.module_name === args.module)
    && (!args.category || row.main_category === args.category || row.sub_category === args.category)
    && (!args.keyword || `${row.part_name || ''} ${row.part_model || ''}`.toLowerCase().includes(String(args.keyword).toLowerCase())));
  const cost = sumBomCostStrict(matched);
  const complete = matched.length > 0 && cost.missing.length === 0;
  const ranked = matched.map(row => ({
    bomId: Number(row.id), name: row.part_name || '', model: row.part_model || '', module: row.module_name || '未分模块',
    unitCost: bomPriceState(row) === 'confirmed' ? bomUnitCost(row) : null,
    quantity: bomQuantityState(row) === 'confirmed' ? Number(row.quantity) : null,
    extendedCost: bomExtendedCostStrict(row),
  }));
  const key = metric === 'unit_cost' ? 'unitCost' : 'extendedCost';
  const valid = ranked.filter(row => row[key] != null).sort((a, b) => (order === 'asc' ? 1 : -1) * (a[key]! - b[key]!) || a.bomId - b.bomId);
  const groups = new Map<string, any[]>();
  if (view === 'group') for (const row of matched) {
    const name = String(row[groupBy === 'module' ? 'module_name' : groupBy === 'category' ? 'main_category' : 'sub_category'] || '未分类');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(row);
  }
  const groupRows = [...groups].map(([name, items]) => { const c = sumBomCostStrict(items); return { name, count: items.length, missingCount: c.missing.length, knownSubtotal: c.total, total: c.missing.length ? null : c.total, sharePercent: complete && cost.total > 0 ? c.total / cost.total * 100 : null }; })
    .sort((a, b) => a.total == null ? b.total == null ? a.name.localeCompare(b.name) : 1 : b.total == null ? -1 : (order === 'asc' ? 1 : -1) * (a.total - b.total));
  return {
    view, scope: '全部匹配 BOM 行计算后再取前 N 项', matchedCount: matched.length,
    total: complete ? cost.total : null, knownSubtotal: cost.total, missingCount: cost.missing.length,
    metric, order, excludedFromRanking: ranked.length - valid.length,
    min: valid.length ? valid[order === 'asc' ? 0 : valid.length - 1][key] : null,
    max: valid.length ? valid[order === 'asc' ? valid.length - 1 : 0][key] : null,
    average: valid.length ? valid.reduce((sum,row)=>sum+row[key]!,0) / valid.length : null,
    // Ties are reported even when only one row is requested.
    tiedAtBoundary: valid.length && view !== 'group' ? valid.filter(row=>row[key] === valid[Math.min(limit,valid.length)-1][key]).length : 0,
    rows: view === 'group' ? groupRows.slice(0,limit) : view === 'rank' ? valid.slice(0,limit) : [],
    groupCount: view === 'group' ? groupRows.length : undefined,
  };
}
