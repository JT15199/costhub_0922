type QuoteLine = Record<string, any>;
export function buildQuoteReviewRows(current: QuoteLine[], reference: QuoteLine[] | null) {
  const group = (lines: QuoteLine[]) => {
    const groups = new Map<string, { total: number; complete: boolean }>();
    for (const line of lines) {
      const name = String(line.module_name || line.main_category || '未分类');
      const row = groups.get(name) || { total: 0, complete: true };
      const known = line.line_total != null && Number.isFinite(Number(line.line_total)) && Number.isFinite(Number(line.quantity)) && Number(line.quantity) >= 0
        && (!line.quantity_state || line.quantity_state === 'confirmed')
        && (line.price_state ? line.price_state === 'confirmed' : Number(line.unit_cost) > 0);
      row.complete &&= known;
      if (known) row.total += Number(line.line_total);
      groups.set(name, row);
    }
    return groups;
  };
  const now = group(current), before = group(reference || []);
  return [...new Set([...now.keys(), ...before.keys()])].map(module => {
    const a = now.get(module), b = before.get(module);
    const currentCost = a?.complete ? a.total : null;
    const referenceCost = b?.complete ? b.total : null;
    const difference = currentCost !== null && referenceCost !== null ? Math.round((currentCost - referenceCost) * 100) / 100 : null;
    const status = !a ? '本轮无此模块' : !a.complete ? '本轮待补价格/数量' : reference === null ? '待询价' : !b ? '参考无此模块' : !b.complete ? '参考信息不完整' : difference! > 0 ? '高于参考' : difference! < 0 ? '低于参考' : '与参考一致';
    return { module, current: currentCost, reference: referenceCost, difference, status };
  });
}
