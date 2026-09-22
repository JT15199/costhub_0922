import { sha256 } from '../db';

export type C2Level = 'low' | 'medium' | 'high' | 'unknown';

export interface C2Payload {
  domain: string;
  features: Record<string, C2Level>;
  question: string;
}

export interface C2Request extends C2Payload {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
}

const FEATURE_KEYS = new Set([
  'size_band', 'resolution_band', 'refresh_band', 'panel_band', 'tier_band',
  'module_band', 'supply_signal', 'demand_signal', 'availability_signal',
]);
const BLOCKED = /项目|物料编码|型号|规格|供应商|公司|客户|BOM|成本|价格|报价|金额|采购|订单|合同|¥|￥|\$|\d/i;

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export function sanitizeC2Payload(input: Partial<C2Payload>): { ok: true; payload: C2Payload } | { ok: false; reason: string } {
  const domain = cleanText(input.domain, 80);
  const question = cleanText(input.question, 200);
  if (!domain || !question) return { ok: false, reason: 'C2 缺少抽象领域或问题' };
  if (BLOCKED.test(domain) || BLOCKED.test(question)) return { ok: false, reason: 'C2 只允许不含编号、金额和业务标识的抽象文本' };
  if (!input.features || typeof input.features !== 'object' || Array.isArray(input.features)) return { ok: false, reason: 'C2 特征必须是对象' };
  const entries = Object.entries(input.features);
  if (entries.length === 0 || entries.length > 9) return { ok: false, reason: 'C2 至少需要一个、最多九个抽象特征' };
  const features: Record<string, C2Level> = {};
  for (const [key, value] of entries) {
    if (!FEATURE_KEYS.has(key)) return { ok: false, reason: 'C2 特征字段不在白名单：' + key };
    if (!['low', 'medium', 'high', 'unknown'].includes(String(value))) return { ok: false, reason: 'C2 特征值必须是 low/medium/high/unknown' };
    features[key] = value as C2Level;
  }
  return { ok: true, payload: { domain, features: Object.fromEntries(Object.entries(features).sort()), question } };
}

export function canonicalC2Body(input: C2Request): string {
  return JSON.stringify({ model: input.model, messages: input.messages });
}

export async function c2BodyHash(body: string): Promise<string> {
  return sha256(body);
}

export function c2SafeSystemPrompt(): string {
  return '你是公开行业趋势分析助手。只能根据抽象领域和等级特征回答，输出趋势方向、风险等级和下一步建议；不要扩展具体业务对象和数值。';
}
