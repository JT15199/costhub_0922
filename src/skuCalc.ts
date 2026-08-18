// SKU 成本计算纯函数（v2.3.19 从 Projects.tsx 抽出，供页面与单元测试共用）
// 口径：SKU 成本 = 基座 BOM 成本 + Σ差异（原始值计算，展示层才舍入）
//   add     = 新增器件：+ 单价 × 数量
//   remove  = 移除基座器件：- 基座行小计
//   replace = 替换型号/单价/数量：+ 新单价 × 新数量 - 基座行小计
// 按 名称+型号+模块 匹配基座，匹配不到 → 记入 issues（不计算该条）

export interface SkuDiff {
  id: number;
  diff_type: 'add' | 'remove' | 'replace';
  module_name?: string;
  part_name: string;
  part_model?: string;
  new_model?: string; // replace 时替换后的新型号（8GB→16GB）；空=只换单价/数量
  quantity?: number | null;
  unit_cost?: number;
  remark?: string;
}

export interface BomRow {
  part_name: string;
  part_model?: string;
  module_name?: string;
  part_cost?: number;
  quantity?: number;
  [k: string]: any;
}

export interface SkuCostResult {
  cost: number;
  delta: number;
  issues: string[];
}

export function calcSkuCost(boms: BomRow[], diffs: SkuDiff[], bomTotal: number): SkuCostResult {
  let delta = 0;
  const issues: string[] = [];
  for (const d of diffs) {
    if (d.diff_type === 'add') {
      delta += (d.unit_cost || 0) * (d.quantity ?? 1);
    } else {
      const m = boms.find(b => b.part_name === d.part_name && b.part_model === d.part_model && (!d.module_name || b.module_name === d.module_name));
      if (!m) { issues.push(`基座中找不到「${d.part_name} ${d.part_model}」`); continue; }
      const baseAmt = (m.part_cost || 0) * (m.quantity || 1);
      if (d.diff_type === 'remove') delta -= baseAmt;
      else if (d.diff_type === 'replace') delta += (d.unit_cost || 0) * (d.quantity ?? (m.quantity || 1)) - baseAmt;
    }
  }
  return { cost: bomTotal + delta, delta, issues };
}

// SKU 合并 BOM（基座 + 差异合成，含新增模块）：供详情展示——只展示不落库
export function buildSkuBom(boms: BomRow[], diffs: SkuDiff[]) {
  const rows: any[] = boms.map(b => {
    const rm = diffs.find(d => d.diff_type === 'remove' && d.part_name === b.part_name && d.part_model === b.part_model && (!d.module_name || d.module_name === b.module_name));
    const rp = diffs.find(d => d.diff_type === 'replace' && d.part_name === b.part_name && d.part_model === b.part_model && (!d.module_name || d.module_name === b.module_name));
    return {
      ...b,
      _skuStatus: rm ? 'removed' : rp ? 'replaced' : 'base',
      _newCost: rp ? (rp.unit_cost || 0) : null,
      _newQty: rp ? (rp.quantity ?? (b.quantity || 1)) : null,
      _newModel: rp ? (rp.new_model || '') : null,
    };
  });
  diffs.filter(d => d.diff_type === 'add').forEach(d => {
    rows.push({
      id: `add-${d.id}`, module_name: d.module_name || '新增模块', part_name: d.part_name, part_model: d.part_model,
      part_cost: d.unit_cost || 0, quantity: d.quantity ?? 1, main_category: '', sub_category: '', _skuStatus: 'added',
    });
  });
  // 按模块分组，模块小计（removed 不计入成本）
  const byMod: Record<string, { items: any[]; subtotal: number }> = {};
  rows.forEach(r => {
    const k = r.module_name || '未分模块';
    (byMod[k] = byMod[k] || { items: [], subtotal: 0 });
    byMod[k].items.push(r);
    if (r._skuStatus !== 'removed') byMod[k].subtotal += (r._skuStatus === 'replaced' ? (r._newCost || 0) : (r.part_cost || 0)) * (r._skuStatus === 'replaced' ? (r._newQty ?? (r.quantity || 1)) : (r.quantity || 1));
  });
  const total = Object.values(byMod).reduce((s, m) => s + m.subtotal, 0);
  return { rows, byMod, total };
}
