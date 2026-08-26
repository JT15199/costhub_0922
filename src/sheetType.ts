// 表格类型识别（v2.3.19，2026-08-19 用户：丢 Excel 应该直接分析表格，不是把内容当 prompt）
// 按表头/样例识别：BOM 表 / 用户原声 / 供应商报价 / 竞品数据 / 通用表格 → 引导 AI 走对应工具
export interface SheetType { type: 'bom' | 'voice' | 'supplier' | 'competitor' | 'other'; label: string; }

export function detectSheetType(headers: string[], _sampleRows: any[][]): SheetType {
  const h = (headers || []).map(x => String(x || '').toLowerCase());
  const joined = h.join(',');
  const has = (...kws: string[]) => kws.some(k => joined.includes(k));
  // 原声表：评价/评论/反馈/内容/意见/点评/满意度
  if (has('评价', '评论', '反馈', '意见', '点评', '口碑', '满意度')) return { type: 'voice', label: '用户原声' };
  // 供应商报价：供应商列是强特征（即使同时有器件列）
  if (has('供应商', 'supplier')) return { type: 'supplier', label: '供应商报价' };
  if (has('报价') || (has('价格') && has('份额'))) return { type: 'supplier', label: '供应商报价' };
  // BOM 表：器件/物料/型号/数量/单价/成本 + 名称
  if (has('bom', '器件', '物料', '料号', 'name')) return { type: 'bom', label: 'BOM 表' };
  if (has('型号') && has('数量')) return { type: 'bom', label: 'BOM 表' };
  if (has('型号') && has('单价')) return { type: 'bom', label: 'BOM 表' };
  // 竞品：竞品/品牌/售价/市场价
  if (has('竞品', '品牌', '售价', '市场价')) return { type: 'competitor', label: '竞品数据' };
  return { type: 'other', label: '通用表格' };
}
