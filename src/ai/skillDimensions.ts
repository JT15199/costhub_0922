// Skill 维度匹配（2026-09-21）
//
// 为什么需要这一层：页面和落库都用 `dims.find(x => x.dimension_type === key)` 做**完全相等**匹配，
// 而"该维度写什么"是由模型决定的。实测（用户："还是显示公开信息不足"）本地 9B 模型极容易写成
// 「供给面」「供给因子：」「1. 成本因子」「成本因子（Cost）」这类变体，甚至用全角冒号/多余空格——
// 一旦名字对不上，模型写好的内容会被整段丢掉，页面显示兜底文案"公开信息不足"。
// 这是**同一个症状的第二条独立成因**（第一条是检索被网关拦、零来源）。
//
// 本模块是纯函数：把"模型写的名字"与"Skill 期望的名字"做归一化后比较，并给出逐级降级策略，
// 保证"模型给了内容就一定展示出来"，而不是因为命名细节把它扔掉。

export interface DimensionLike {
  dimension_type?: string;
  content?: string;
  evidence_strength?: string;
  source_title?: string;
  source_url?: string;
  [key: string]: unknown;
}

/**
 * 归一化维度名：全角转半角、去所有空白、去序号/项目符号、去括号补充、去标点、转小写。
 * 例：「1. 成本因子（Cost）」→「成本因子cost」；「供给因子：」→「供给因子」。
 */
export function normalizeDimensionKey(value: unknown): string {
  return String(value ?? '')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[#*·•\-—–\d.、)）:：]+/, '')
    .replace(/[（(][^（()）]*[)）]/g, '')
    .replace(/[：:、,，.。;；!！?？"'“”‘’《》<>[\]/\\|]+/g, '')
    .toLowerCase();
}

/**
 * 在模型返回的维度数组里找与期望名对应的那一项。
 * 逐级降级（每一级都只在前一级找不到时才用）：
 *   ① 归一化全等
 *   ② 归一化后互相包含（长度≥2，避免"看"这种单字误配）
 *   ③ 公共前缀 ≥2 字（处理本地模型把「供给因子」写成「供给面」「供给」的情况）——只在唯一最优时采用
 *   ④ 按位置兜底（调用方传 position 时才用；提示词明确要求 dimensions 按维度顺序输出）
 * 目的只有一个：**模型写了内容就一定展示出来**，绝不因为命名细节把它换成"公开信息不足"。
 */
export function findDimension<T extends DimensionLike>(dims: T[] | null | undefined, expected: string, position?: number): T | undefined {
  const list = Array.isArray(dims) ? dims.filter(Boolean) : [];
  if (list.length === 0) return undefined;
  const target = normalizeDimensionKey(expected);
  if (!target) return undefined;

  const exact = list.find(item => normalizeDimensionKey(item?.dimension_type) === target);
  if (exact) return exact;

  const contained = list.find(item => {
    const key = normalizeDimensionKey(item?.dimension_type);
    return key.length >= 2 && (key.includes(target) || target.includes(key));
  });
  if (contained) return contained;

  // ③ 公共前缀：模型常把「XX因子」写成「XX面」「XX情况」「XX方面」——前缀相同即认为是同一维度。
  // 只在"唯一最长前缀"时采用，避免在「看竞争/看机会/看自己」这类同前缀维度上误配。
  const prefixHits = list
    .map(item => ({ item, prefix: commonPrefixLength(normalizeDimensionKey(item?.dimension_type), target) }))
    .filter(hit => hit.prefix >= 2);
  if (prefixHits.length > 0) {
    const best = Math.max(...prefixHits.map(hit => hit.prefix));
    const winners = prefixHits.filter(hit => hit.prefix === best);
    if (winners.length === 1) return winners[0].item;
  }

  if (position != null && position >= 0 && position < list.length) {
    const candidate = list[position];
    // 只在"内容非空"时才用位置兜底，避免用空占位覆盖
    if (String(candidate?.content ?? '').trim()) return candidate;
  }
  return undefined;
}

/** 两个归一化字符串的公共前缀长度。 */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

/** 常见"什么都没说"的占位片段（含兜底文案与模型常写的变体）。 */
const PLACEHOLDER_SEGMENT = /^(公开信息不足|暂无法形成可靠结论|未获取可点击公开来源|未获取可点击来源|未获取可点击的公开来源|仅模型归纳|无法核实|无法判断|数据不足|信息不足|证据不足|无|暂无|none)$/i;

/** 维度内容是否可展示（非空，且不是"整段都是占位话术"）。 */
export function hasUsableDimensionContent(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const segments = text.split(/[。，,.;；、\s()（）【】\[\]]+/).filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.every(segment => PLACEHOLDER_SEGMENT.test(segment));
}
