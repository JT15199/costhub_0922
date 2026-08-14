// 项目 AI 体检（v2.3.19）：规则驱动的健康检查，嵌入项目管理页顶部
// 覆盖：BOM 完整性 / 目标超支 / 成本快照异动 / 同品类模块报价价差
// 纯规则保证稳定可用（不依赖模型）；本地 AI 小结为可选增强（见 Projects.tsx）

export interface HealthIssue {
  level: 'danger' | 'warn' | 'info';
  type: string;
  title: string;
  detail: string;
  actionTab?: string;   // 建议跳转的 tab（bom/analysis 等）
}

export interface HealthContext {
  projectId: number;
  code: string;
  boms: { part_name: string; part_model?: string; module_name?: string; main_category?: string; part_cost?: number; quantity?: number }[];
  targets: { domain: string; target_cost: number }[];
  snapshots: { id: number; bom_cost: number; change_reason?: string; created_at?: string }[];
  // 同品类其他项目的 BOM（模块价差对比用）
  peerBoms?: { projectId: number; code: string; boms: { module_name?: string; part_name: string; part_model?: string; part_cost?: number; quantity?: number }[] }[];
}

// 模块价差阈值（与报价比对一致：价差 ≥¥10 且 ≥10%）
const GAP_MIN_ABS = 10;
const GAP_MIN_PCT = 0.1;

export function computeProjectHealth(ctx: HealthContext): HealthIssue[] {
  const issues: HealthIssue[] = [];

  // 1) BOM 完整性
  const noCost = ctx.boms.filter(b => !(b.part_cost && b.part_cost > 0));
  const zeroQty = ctx.boms.filter(b => !b.quantity || b.quantity <= 0);
  if (noCost.length > 0) {
    issues.push({
      level: noCost.length >= 5 ? 'danger' : 'warn',
      type: 'bom_no_cost',
      title: `${noCost.length} 个器件缺单价`,
      detail: `${noCost.slice(0, 3).map(b => b.part_name).join('、')}${noCost.length > 3 ? ' 等' : ''} 成本为 0，BOM 总成本可能偏低`,
      actionTab: 'bom',
    });
  }
  if (zeroQty.length > 0) {
    issues.push({
      level: 'warn',
      type: 'bom_zero_qty',
      title: `${zeroQty.length} 个器件数量为 0`,
      detail: `${zeroQty.slice(0, 3).map(b => b.part_name).join('、')}${zeroQty.length > 3 ? ' 等' : ''} 为占位/待定项，不计入成本`,
      actionTab: 'bom',
    });
  }

  // 2) 目标超支
  const byDomain: Record<string, number> = {};
  ctx.boms.forEach(b => { const d = b.main_category || '其他'; byDomain[d] = (byDomain[d] || 0) + (b.part_cost || 0) * (b.quantity || 1); });
  for (const t of ctx.targets) {
    const actual = byDomain[t.domain] || 0;
    if (t.target_cost > 0 && actual > t.target_cost) {
      const rate = Math.round((2 - actual / t.target_cost) * 100);
      issues.push({
        level: 'danger',
        type: 'target_over',
        title: `${t.domain} 超目标 ¥${(actual - t.target_cost).toFixed(2)}`,
        detail: `目标 ¥${t.target_cost.toFixed(2)}，实际 ¥${actual.toFixed(2)}，达成率 ${rate}%`,
        actionTab: 'analysis',
      });
    }
  }

  // 3) 成本快照异动（最近两条）
  const sorted = [...ctx.snapshots].sort((a, b) => b.id - a.id);
  if (sorted.length >= 2) {
    const oldCost = sorted[1].bom_cost || 0;
    const newCost = sorted[0].bom_cost || 0;
    if (oldCost > 0) {
      const pct = ((newCost - oldCost) / oldCost) * 100;
      if (Math.abs(pct) >= 1) {
        issues.push({
          level: pct > 0 ? 'warn' : 'info',
          type: 'snapshot_change',
          title: `BOM 成本 ${pct > 0 ? '上涨' : '下降'} ${Math.abs(pct).toFixed(1)}%`,
          detail: `¥${oldCost.toFixed(2)} → ¥${newCost.toFixed(2)}${sorted[0].change_reason ? '（' + sorted[0].change_reason + '）' : ''}`,
          actionTab: 'snapshots',
        });
      }
    }
  }

  // 4) 同品类模块报价价差（对比其他项目同名模块器件）
  if (ctx.peerBoms && ctx.peerBoms.length > 0) {
    const mine: Record<string, { name: string; model: string; cost: number }[]> = {};
    ctx.boms.forEach(b => {
      if (!b.module_name) return;
      (mine[b.module_name] = mine[b.module_name] || []).push({ name: b.part_name, model: b.part_model || '', cost: b.part_cost || 0 });
    });
    const gaps: string[] = [];
    for (const peer of ctx.peerBoms) {
      for (const [mod, myRows] of Object.entries(mine)) {
        for (const row of myRows) {
          if (row.cost <= 0) continue;
          const peerRow = peer.boms.find(pb => pb.module_name === mod && pb.part_name === row.name && (pb.part_model || '') === row.model);
          if (!peerRow || !(peerRow.part_cost && peerRow.part_cost > 0)) continue;
          const diff = row.cost - peerRow.part_cost;
          if (diff >= GAP_MIN_ABS && diff / peerRow.part_cost >= GAP_MIN_PCT) {
            gaps.push(`「${row.name}」比 ${peer.code} 贵 ¥${diff.toFixed(2)}（${peerRow.part_cost.toFixed(2)} → ${row.cost.toFixed(2)}）`);
          }
        }
      }
    }
    if (gaps.length > 0) {
      issues.push({
        level: 'warn',
        type: 'module_price_gap',
        title: `${gaps.length} 处器件报价高于同类项目`,
        detail: gaps.slice(0, 3).join('；'),
        actionTab: 'bom',
      });
    }
  }

  return issues;
}
