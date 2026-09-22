// 公开检索查询词 —— 必须与 Rust 网关的绑定规则**逐字对齐**（这是硬约束，改这里必须同时看 src-tauri/src/lib.rs）
//
// Rust `validate_public_query_binding`（src-tauri/src/lib.rs:2678）对 C1 检索请求做的是**严格相等**校验：
//     expected = normalize_public_query(format!("{material} {question}"))   // 折叠空白 + 转小写
//     normalize_public_query(body.q) == expected                            // 不等就直接拦截
// 也就是说：**实际发出去的查询词必须恰好等于「已批准物料名 + 一个空格 + 已批准问题」**，多一个词都过不去。
//
// ⚠️ 2026-09-21 真实事故（用户实测"还是显示公开信息不足"，查库取证）：
//   我把关键词直接拼进查询词（`${material} 价格 行情 报价 涨价 供需`），网关立刻拦下
//   「云端请求已拦截：查询词超出已批准的公开主题范围」(outbound_request_logs id=64/65, status_code=0)，
//   搜索一条来源都没取回 → 所有维度退化成"公开信息不足"。
//   教训：**不要在查询词上做任何"加工"**。要提升召回质量，就把关键词做成"问题"本身——
//   问题同样是已批准字段（会显示在审批卡上），expected 与 actual 天然一致，既拿到关键词召回质量，
//   又不越过安全边界（网关仍然能保证"发出的内容不超出已批准主题"）。

/** 价格类公开检索的"问题"（关键词形态——它就是最终查询词里物料名后面的部分）。 */
export const PUBLIC_PRICE_QUERY_QUESTION = '价格 行情 报价 涨价 供需';

/** 公开型号/规格类公开检索的"问题"。 */
export const PUBLIC_MODEL_QUERY_QUESTION = '规格 参数 型号 兼容';

/**
 * 与 Rust `normalize_public_query` 同构：按空白切分后再用一个空格连接，并转小写。
 * 保持同构是为了让测试能**在本地镜像网关的校验逻辑**（见 insightPipeline.test.ts）。
 */
export function normalizePublicQuery(value: string): string {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * 构造实际发出的检索查询词。
 * ⚠️ 只允许返回 `material + ' ' + question`，**不得追加任何其他内容**（网关严格相等校验）。
 */
export function buildPublicSearchQuery(material: string, question = ''): string {
  const name = String(material || '').replace(/\s+/g, ' ').trim();
  const asked = String(question || '').replace(/\s+/g, ' ').trim();
  return `${name} ${asked}`.trim();
}

/**
 * 网关侧的期望值（镜像 Rust 的 expected 计算）。
 * 生产代码用它做自检；测试用它断言"我们发的东西一定过得去"。
 */
export function gatewayExpectedQuery(material: string, question = ''): string {
  return normalizePublicQuery(buildPublicSearchQuery(material, question));
}
