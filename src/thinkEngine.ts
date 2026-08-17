// 自主分析引擎（v2.3.19，2026-08-17 用户需求：像 DSH 一样自主思考 + 按需申请云端）
// 设计原则：
//   · 本地模型 token 免费、不涉安全 → 思考不设限（流式渲染思考过程，多轮工具循环）
//   · 云端调用需申请——"申请发送什么提示词给云端 LLM"，preview 模式就地审批（auto 直接放行）
//   · 尺寸/面积只是思考思路之一（注入提示词引导灵活推理），不是机械规则
// 循环协议（Ollama 原生 function calling）：
//   流式思考（onReasoning）→ 模型输出 tool_calls → 本地工具直接执行 /
//   cloud_market_query 走审批后 agentSearchLoop → 结果回填继续（≤MAX_THINK_ROUNDS）→ 无工具调用即输出结论

export const MAX_THINK_ROUNDS = 8;

// 云端虚拟工具定义（Ollama tools 格式）：模型"申请"调云端时必须用它
export function buildCloudToolDef() {
  return {
    type: 'function',
    function: {
      name: 'cloud_market_query',
      description:
        '申请调用云端模型联网查询某物料/品类的市场行情（近1-3月价格趋势）。仅当本地数据不足以判断行情时才使用。' +
        '调用前会请求用户审批，云端只会收到：物料通用名称 + 品类 + 查询问题，不含任何本地成本/供应商/项目数据。',
      parameters: {
        type: 'object',
        properties: {
          material_name: { type: 'string', description: '物料通用名称，如 液晶面板（不得含型号/厂家/金额数字）' },
          category: { type: 'string', description: '品类，如 硬件类，可空' },
          question: { type: 'string', description: '要问云端的行情问题（近1-3月价格趋势分析）' },
        },
        required: ['material_name', 'question'],
      },
    },
  };
}

// 本地工具 → Ollama tools 定义（参数 schema 自动生成）
export function buildLocalToolDefs(tools: { id: string; desc: string; params: { key: string; type: string; required?: boolean; desc: string }[] }[]) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.id,
      description: t.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(t.params.map(p => [p.key, { type: p.type === 'number' ? 'number' : 'string', description: p.desc }])),
        required: t.params.filter(p => p.required).map(p => p.key),
      },
    },
  }));
}

// 自主思考 system prompt：本地思考不限、云端申请、灵活思路（尺寸/面积只是思路之一）
export function buildThinkSystemPrompt(toolNames: string[], prefCtx = ''): string {
  return (
    '你是 CostHub 的自主分析助手。你可以：1) 调用本地工具读取项目成本数据；2) 申请调用云端模型查询市场行情；3) 基于两者综合分析，给出结论。\n' +
    '【思考原则】先想清楚再动手：分析成本问题要先查本地数据（BOM、供应商报价、规格、历史趋势）。推理要灵活多样、结合具体情况选最合理的思路，不要机械套用固定公式——例如带尺寸的物料（PCB/结构件）可以考虑单位面积成本、按同样尺寸折算；也可以考虑数量阶梯、工艺差异、供应商结构、规格差异、采购渠道等思路。\n' +
    '【工具】可用工具：' + toolNames.join('、') + '。需要数据就调用工具，观察结果后继续思考。\n' +
    '【云端】仅当本地数据不足以判断行情时才申请调用 cloud_market_query。每次申请都会请求用户审批并展示将发送的提示词，申请时要说明为什么需要（如：本地无近期行情数据）。\n' +
    '【输出】思考过程可以持续；当你得出最终结论时，直接输出结论文本，不要再调用工具。' +
    (prefCtx ? '\n\n【用户偏好】\n' + prefCtx : '')
  );
}

// 云端申请时展示给用户的提示词（脱敏摘要：仅物料名/品类/问题三字段）
export function buildCloudReviewPrompt(call: { material_name?: string; category?: string; question?: string }): string {
  return (
    '【云端模型查询申请】将发送以下提示词给云端 LLM（已脱敏，仅含物料名/品类/问题，无任何本地成本/供应商/项目数据）：\n\n' +
    '物料：' + (call.material_name || '') + '\n' +
    '品类：' + (call.category || '未指定') + '\n' +
    '问题：' + (call.question || '近1-3月价格趋势分析（price-trend）')
  );
}

// 云端返回 → 模型可消费的文本（结构来自 trendService agentSearchLoop）
export function formatCloudResult(r: any): string {
  return (
    '云端行情：趋势 ' + (r.trend_direction || '信号不明确') +
    '，置信度 ' + (r.confidence_level || '中') +
    (r.magnitude_min != null ? '，近1-3月幅度约 ' + r.magnitude_min + '%~' + (r.magnitude_max ?? '') + '%' : '') +
    '\n摘要：' + (r.summary || '') +
    (r.suggested_action ? '\n建议：' + r.suggested_action : '')
  );
}