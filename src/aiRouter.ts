// 模型路由决策（harness 阶段④，2026-08-18）：本地/云端安全分工，可审计
// 原则：涉及本地库数据的分析 → 本地模型（不涉密不花钱）；只有需要外部行情/最新市场信息才申请云端；
// 云端永远只发 物料名/品类/问题（三字段边界由审批+脱敏+审计三层保障）
export interface RouteDecision { target: 'local' | 'cloud'; reason: string; }

export function decideCloudRoute(call: { material_name?: string; question?: string }): RouteDecision {
  const q = (call.question || '').toLowerCase();
  // 明确的外部信息需求：行情/市场/价格趋势/最新/涨价/降价/缺货/汇率/供应
  if (/行情|市场|价格趋势|最新价格|涨|降|缺货|汇率|供应|报价趋势|近1-3月/.test(q)) {
    return { target: 'cloud', reason: '需要外部市场行情（本地库无此信息），发送内容仅物料名/品类/问题' };
  }
  if (/本地|成本|项目|bom|占比|供应商|目标|历史|快照|工作/.test(q)) {
    return { target: 'local', reason: '本地数据可回答，无需云端（不占用审批）' };
  }
  return { target: 'cloud', reason: '模型判断需要外部信息，按审批流程申请云端（仅脱敏三字段）' };
}
