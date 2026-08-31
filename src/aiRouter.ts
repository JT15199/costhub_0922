// 本地模型为主脑；只有公开行情需求才进入受控云端审查/审批。
export interface RouteDecision { target: 'local' | 'cloud'; reason: string; }

export function decideCloudRoute(call: { material_name?: string; question?: string }): RouteDecision {
  const q = (call.question || '').toLowerCase();
  const externalIntent = /行情|市场|价格趋势|最新价格|涨|降|缺货|汇率|近1-3月/.test(q);
  return externalIntent
    ? { target: 'cloud', reason: '需要公开行情；仅发送通用物料名/品类/问题，并先经过敏感审查与条件审批' }
    : { target: 'local', reason: '本地数据可回答，固定由本机模型与白名单工具处理' };
}
