// 洞察研判的「本机内部事实」构造（2026-09-21）
//
// 用途：留给**本地**研判模型的一段内部数据摘要（涉及项目/模块/用量/单价/金额）。
// 为什么需要：研判提示词原先只有公开来源，于是 Skill 里"看自己""成本因子"这类维度只能写
// 「本次未提供自身 BOM、用量、库存或历史采购价，无法评估敞口」——用户看到的"洞察没有有效信息"一半来自这里。
//
// 安全边界（不可放松）：
//   · 本函数的输出只在 `createStructuredInsight` 的**本地模型分支**使用（localContext 参数），
//     云端分支拿到的仍是已脱敏的公开来源，结构上没有这个字段的位置。
//   · 输出为纯文本，不含任何 API key / 供应商联系人等无关信息；只含成本与用量事实，供本机研判。

export interface InsightProjectRow {
  part_name?: string | null;
  part_model?: string | null;
  project_code?: string | null;
  project_name?: string | null;
  module_name?: string | null;
  quantity?: number | string | null;
  unit_cost?: number | string | null;
  line_cost?: number | string | null;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
const text = (value: unknown): string => String(value ?? '').trim();

/**
 * 把 `getTrendProjectContext` 的行集合压成一段给本地模型看的事实清单。
 * 行数很多时只保留金额最大的若干条明细，但**聚合值始终按全量计算**（不因为截断而失真）。
 */
export function buildInsightLocalContext(rows: InsightProjectRow[] | null | undefined, options: { maxRows?: number } = {}): string {
  const list = (rows || []).filter(Boolean);
  if (list.length === 0) return '';
  const maxRows = options.maxRows ?? 12;

  let totalLineCost = 0;
  let totalQuantity = 0;
  const projects = new Set<string>();
  for (const row of list) {
    totalLineCost += num(row.line_cost);
    totalQuantity += num(row.quantity) || 1;
    const project = text(row.project_code) || text(row.project_name);
    if (project) projects.add(project);
  }
  const weightedUnit = totalQuantity > 0 ? totalLineCost / totalQuantity : 0;

  const sorted = [...list].sort((a, b) => num(b.line_cost) - num(a.line_cost));
  const shown = sorted.slice(0, maxRows);
  const lines = shown.map(row => {
    const bits = [
      text(row.project_code) || text(row.project_name) || '未命名项目',
      text(row.module_name) ? `模块 ${text(row.module_name)}` : '',
      `用量 ${num(row.quantity) || 1}`,
      `单价 ¥${money(num(row.unit_cost))}`,
      `金额 ¥${money(num(row.line_cost))}`,
      text(row.part_model) ? `本机型号 ${text(row.part_model)}` : '',
    ].filter(Boolean);
    return '· ' + bits.join(' · ');
  });

  const head = [
    `该物料在本机共命中 ${list.length} 条项目用量记录，覆盖 ${projects.size} 个项目。`,
    `合计用量 ${totalQuantity}，合计金额 ¥${money(totalLineCost)}，加权平均单价 ¥${money(weightedUnit)}。`,
  ];
  const tail = sorted.length > shown.length ? [`（明细按金额从大到小，仅列前 ${shown.length} 条；聚合值仍为全量）`] : [];
  return [...head, ...lines, ...tail].join('\n');
}
