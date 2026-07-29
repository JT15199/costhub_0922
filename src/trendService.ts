/**
 * 物料趋势查询服务
 *
 * 安全约束（务必遵守）：
 * - 仅向外部 API 发送物料/原材料的通用名称
 * - 不读取、拼接、上传任何本地成本数据（采购价、供应商、BOM等）
 * - 所有 HTTP 请求通过 Rust 后端代理（绕过浏览器 CORS）
 */

import { invoke } from '@tauri-apps/api/core';
import { decryptText, hasSearchConfig } from './apiConfig';

// 从数据库加载活跃供应商（含解密）
async function getActiveProviders(): Promise<{ search: any[]; llm: any[] }> {
  try {
    const { getApiProviders } = await import('./db');
    const all = await getApiProviders();
    // 解密 api_key
    const decrypted = await Promise.all(all.map(async (p: any) => {
      if (p.api_key) {
        try { return { ...p, api_key: await decryptText(p.api_key) }; } catch { return { ...p, api_key: '' }; }
      }
      return p;
    }));
    return {
      search: decrypted.filter((p: any) => p.provider_type === 'search' && p.api_key).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)),
      llm: decrypted.filter((p: any) => p.provider_type === 'llm' && p.api_key).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)),
    };
  } catch {
    return { search: [], llm: [] };
  }
}

// 获取活跃的 LLM 配置（仅从数据库供应商）
async function resolveLLMConfig(): Promise<{ apiKey: string; provider: string; model: string; baseUrl: string } | null> {
  const providers = await getActiveProviders();
  if (providers.llm.length > 0) {
    const active = providers.llm.find((p: any) => p.is_active) || providers.llm[0];
    return {
      apiKey: active.api_key,
      provider: active.provider_name?.toLowerCase().includes('openai') || active.provider_name?.toLowerCase().includes('硅基') ? 'openai' : 'deepseek',
      model: active.model_name || 'deepseek-chat',
      baseUrl: active.base_url || 'https://api.deepseek.com/v1/chat/completions',
    };
  }
  return null;
}

// 获取活跃的搜索配置（仅从数据库供应商）
async function resolveSearchConfig(): Promise<{ apiKey: string; provider: string } | null> {
  const providers = await getActiveProviders();
  if (providers.search.length > 0) {
    const active = providers.search.find((p: any) => p.is_active) || providers.search[0];
    const name = active.provider_name?.toLowerCase() || '';
    return { apiKey: active.api_key, provider: name.includes('bing') ? 'bing' : (name.includes('tavily') ? 'tavily' : 'serper') };
  }
  return null;
}

// 带重试的 LLM 调用（按优先级降级）
async function callLLMWithFallback(
  systemPrompt: string,
  userPrompt: string,
  temperature: number = 0.3,
  maxTokens: number = 2000
): Promise<string> {
  const providers = await getActiveProviders();
  const llmProviders = providers.llm.filter((p: any) => p.api_key).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0));

  if (llmProviders.length === 0) throw new Error('未配置任何 LLM 供应商，请在设置页面添加并启用');

  let lastError: Error | null = null;
  for (const provider of llmProviders) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callSingleLLMProvider(provider, systemPrompt, userPrompt, temperature, maxTokens);
      } catch (e: any) {
        lastError = e;
        if (/HTTP 4\d\d/.test(e?.message || '')) break;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); // 重试前等1秒
      }
    }
    // 当前供应商失败，尝试下一个
    if (llmProviders.indexOf(provider) < llmProviders.length - 1) {
      console.log(`供应商 ${provider.provider_name} 失败，降级到下一个...`);
    }
  }
  throw new Error(`所有 LLM 供应商均调用失败${lastError ? `。最后一个错误: ${(lastError as any).message || lastError}` : '（无具体错误）'}`);
}

function normalizeChatCompletionUrl(baseUrl: string): string {
  const trimmed = (baseUrl || 'https://api.deepseek.com/chat/completions').replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

async function callSingleLLMProvider(
  provider: any,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.3,
  maxTokens = 2000,
): Promise<string> {
  const messages = [] as Array<{ role: string; content: string }>;
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });
  return callSingleLLMProviderMessages(provider, messages, temperature, maxTokens);
}

async function callSingleLLMProviderMessages(
  provider: any,
  messages: Array<{ role: string; content: string }>,
  temperature = 0.3,
  maxTokens = 2000,
): Promise<string> {
  const baseUrl = normalizeChatCompletionUrl(provider.base_url);
  const res = await rustPost(
    baseUrl,
    { Authorization: `Bearer ${provider.api_key}`, 'Content-Type': 'application/json' },
    JSON.stringify({
      model: provider.model_name || 'deepseek-chat',
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  );
  if (!res.success) {
    throw new Error(`${provider.provider_name} HTTP ${res.status}: ${res.body.slice(0, 400).replace(/\n/g, ' ')}`);
  }
  let data: any;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`${provider.provider_name} 返回非 JSON，请检查 Base URL：${res.body.slice(0, 160)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${provider.provider_name} 返回成功但没有 choices[0].message.content`);
  }
  return content;
}

// ====== Rust HTTP 代理 ======

interface HttpResponse {
  status: number;
  body: string;
  success: boolean;
}

async function rustPost(url: string, headers: Record<string, string>, body?: string): Promise<HttpResponse> {
  return invokeWithRequestLog('POST', url, headers, body || null);
}

async function rustGet(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  return invokeWithRequestLog('GET', url, headers, null);
}

function redactUrl(url: string): string {
  return url.replace(/([?&](?:api_?key|key|token)=)[^&]+/gi, '$1***');
}

async function invokeWithRequestLog(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body: string | null): Promise<HttpResponse> {
  const started = Date.now();
  let result: HttpResponse;
  try {
    result = await invoke<HttpResponse>(method === 'POST' ? 'http_post' : 'http_get', {
      request: { url, headers, body },
    });
  } catch (e: any) {
    result = { status: 0, body: e?.message || String(e), success: false };
  }
  try {
    const { logOutboundRequest } = await import('./db');
    await logOutboundRequest({
      method,
      url: redactUrl(url),
      status_code: result.status,
      response_time_ms: Date.now() - started,
      error_message: result.success ? '' : result.body.slice(0, 500),
    });
  } catch { }
  return result;
}

// ====== 搜索 API ======

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function collapseText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isReadableText(text: string): boolean {
  const value = collapseText(text);
  if (!value) return false;
  const replacementCount = (value.match(/\uFFFD/g) || []).length;
  if (replacementCount > 0) return false;
  const controlCount = (value.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  if (controlCount > 0) return false;
  const letters = (value.match(/[\p{L}\p{N}\u4e00-\u9fff]/gu) || []).length;
  const symbols = (value.match(/[^\p{L}\p{N}\u4e00-\u9fff\s，。！？、：；（）《》“”‘’"'.,:;!?()[\]{}%+\-_/]/gu) || []).length;
  return letters >= 4 && symbols / Math.max(value.length, 1) < 0.18;
}

function sanitizeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return (results || [])
    .map(r => ({
      title: collapseText(r.title).slice(0, 160),
      url: collapseText(r.url),
      snippet: collapseText(r.snippet).slice(0, 600),
    }))
    .filter(r => r.title && r.url && isReadableText(`${r.title} ${r.snippet}`))
    .filter(r => {
      const key = r.url.replace(/#.*$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isRelevantSearchResult(result: SearchResult, terms: string[]): boolean {
  const text = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  return terms.some(term => text.includes(term.toLowerCase()));
}

async function searchSerper(query: string, apiKey: string, baseUrl = 'https://google.serper.dev/search'): Promise<SearchResult[]> {
  const res = await rustPost(
    baseUrl,
    { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    // tbs=qdr:m6 限制只搜最近6个月的结果
    JSON.stringify({ q: query, num: 8, gl: 'cn', hl: 'zh-CN', tbs: 'qdr:m6' })
  );
  if (!res.success) throw new Error(`Serper API 返回错误 (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.organic || []).map((r: any) => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
  }));
}

async function searchBing(query: string, apiKey: string, baseUrl = 'https://api.bing.microsoft.com/v7.0/search'): Promise<SearchResult[]> {
  const res = await rustGet(
    `${baseUrl}?q=${encodeURIComponent(query)}&count=8&mkt=zh-CN&freshness=Month`,
    { 'Ocp-Apim-Subscription-Key': apiKey }
  );
  if (!res.success) throw new Error(`Bing API 返回错误 (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.webPages?.value || []).map((r: any) => ({
    title: r.name || '',
    url: r.url || '',
    snippet: r.snippet || '',
  }));
}

async function searchBrave(query: string, apiKey: string, baseUrl: string): Promise<SearchResult[]> {
  const res = await rustGet(`${baseUrl}?q=${encodeURIComponent(query)}&count=8&search_lang=zh-hans&freshness=pm`, {
    Accept: 'application/json', 'X-Subscription-Token': apiKey,
  });
  if (!res.success) throw new Error(`Brave Search HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.web?.results || []).map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' }));
}

async function searchBocha(query: string, apiKey: string, baseUrl: string): Promise<SearchResult[]> {
  const res = await rustPost(baseUrl, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, JSON.stringify({ query, freshness: 'oneMonth', summary: true, count: 8 }));
  if (!res.success) throw new Error(`博查搜索 HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  const values = data.data?.webPages?.value || data.webPages?.value || [];
  return values.map((r: any) => ({ title: r.name || r.title || '', url: r.url || '', snippet: r.summary || r.snippet || '' }));
}

async function searchSearchApi(query: string, apiKey: string, baseUrl: string): Promise<SearchResult[]> {
  const res = await rustGet(`${baseUrl}?engine=google&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}`, {});
  if (!res.success) throw new Error(`SearchApi.io HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.organic_results || []).slice(0, 8).map((r: any) => ({ title: r.title || '', url: r.link || '', snippet: r.snippet || '' }));
}

async function searchExa(query: string, apiKey: string, baseUrl: string): Promise<SearchResult[]> {
  const res = await rustPost(baseUrl, { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, JSON.stringify({ query, numResults: 8, type: 'auto', contents: { text: { maxCharacters: 500 } } }));
  if (!res.success) throw new Error(`Exa Search HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.results || []).map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: r.text || r.highlights?.[0] || '' }));
}

async function searchWithProvider(provider: any, query: string): Promise<SearchResult[]> {
  const name = (provider.provider_name || '').toLowerCase();
  const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
  let results: SearchResult[];
  if (name.includes('tavily') || baseUrl.includes('tavily.com')) results = await searchTavily(query, provider.api_key, baseUrl);
  else if (name.includes('brave') || baseUrl.includes('search.brave.com')) results = await searchBrave(query, provider.api_key, baseUrl);
  else if (name.includes('博查') || name.includes('bocha') || baseUrl.includes('bochaai.com')) results = await searchBocha(query, provider.api_key, baseUrl);
  else if (name.includes('bing') || baseUrl.includes('bing.microsoft.com')) results = await searchBing(query, provider.api_key, baseUrl);
  else if (name.includes('searchapi') || baseUrl.includes('searchapi.io')) results = await searchSearchApi(query, provider.api_key, baseUrl);
  else if (name.includes('exa') || baseUrl.includes('exa.ai')) results = await searchExa(query, provider.api_key, baseUrl);
  else if (name.includes('serper') || baseUrl.includes('serper.dev')) results = await searchSerper(query, provider.api_key, baseUrl);
  else {
    throw new Error(`不支持的搜索供应商「${provider.provider_name}」，请从预置模板选择或检查 Base URL`);
  }
  return sanitizeSearchResults(results);
}

/** 搜索公开网页信息（多供应商降级） */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const providers = await getActiveProviders();
  const searchProviders = providers.search.filter((p: any) => p.api_key).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0));

  if (searchProviders.length === 0) throw new Error('搜索 API Key 未配置，请先在设置页面配置搜索服务');

  let lastError: Error | null = null;
  for (const provider of searchProviders) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await searchWithProvider(provider, query);
      } catch (e: any) {
        lastError = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw new Error(`所有搜索供应商均调用失败${lastError ? `。最后一个错误: ${(lastError as any).message || lastError}` : '（无具体错误）'}`);
}

// ====== 健壮 JSON 提取 ======
/** 从 LLM 返回文本中健壮地提取并解析 JSON（自动剥离 Markdown 代码块标记） */
function extractJSON(text: string): any {
  let cleaned = text.trim();
  // 去掉开头的 ```json 或 ``` 以及结尾的 ```
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  // 如果有多余的 ``` 残留（如```json ... ```中间还有外层包裹）
  cleaned = cleaned.replace(/```(?:json)?/gi, '');
  cleaned = cleaned.trim();

  // 尝试找第一个 JSON 对象或数组
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  const starts = [firstBrace, firstBracket].filter(i => i !== -1);
  const firstJson = starts.length ? Math.min(...starts) : -1;
  if (firstJson !== -1) {
    const endJson = firstJson === firstBracket && lastBracket > firstBracket
      ? lastBracket
      : lastBrace;
    if (endJson > firstJson) cleaned = cleaned.slice(firstJson, endJson + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e: any) {
    // 如果解析失败，尝试修复常见问题
    console.error('JSON解析失败，尝试修复:', e.message);
    console.error('原始文本片段:', text.slice(0, 300));

    // 修复1: 移除尾随逗号（如 "key": "value", }）
    let fixed = cleaned.replace(/,(\s*[}\]])/g, '$1');

    // 修复2: 修复数组中的尾随逗号（如 [1, 2, ]）
    fixed = fixed.replace(/,(\s*\])/g, '$1');

    // 修复3: 尝试在错误位置截断（如果JSON在某个位置中断）
    const errorMatch = e.message.match(/position (\d+)/);
    if (errorMatch) {
      const errorPos = parseInt(errorMatch[1], 10);
      // 尝试在错误位置之前找到完整的JSON对象
      const beforeError = fixed.slice(0, errorPos);
      const lastValidBrace = beforeError.lastIndexOf('}');
      if (lastValidBrace > 0) {
        const firstValidBrace = beforeError.indexOf('{');
        if (firstValidBrace !== -1) {
          fixed = beforeError.slice(firstValidBrace, lastValidBrace + 1);
        }
      }
    }

    // 修复4: 如果是"Unexpected end of JSON input"，尝试补全
    if (e.message.includes('Unexpected end')) {
      // 统计未闭合的括号
      const openBraces = (fixed.match(/\{/g) || []).length;
      const closeBraces = (fixed.match(/\}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;

      // 补全缺失的闭合括号
      fixed += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
      fixed += '}'.repeat(Math.max(0, openBraces - closeBraces));
    }

    try {
      return JSON.parse(fixed);
    } catch (e2: any) {
      console.error('JSON修复失败:', e2.message);

      // 最后的降级方案：返回一个包含原始文本的基本对象
      console.warn('使用降级方案：返回基本结构');
      return {
        trend_direction: '信号不明确',
        confidence_level: '低',
        summary: 'LLM返回格式异常，无法正常解析。建议重试或调整搜索关键词。',
        suggested_action: '观望',
        dimensions: [{
          dimension_type: '系统提示',
          content: '返回数据格式错误，请重试。原始文本：' + text.slice(0, 200),
          evidence_strength: '未验证',
        }],
        key_events: [],
        info_sufficiency: { sufficient: false, missing_dimensions: [], reason: 'JSON解析失败' },
        _parse_error: e.message,
        _original_text_snippet: text.slice(0, 500),
      };
    }
  }
}

export function extractLLMJson(text: string): any {
  return extractJSON(text);
}

export interface TrendAnalysisResult {
  trend_direction: string;
  confidence_level: string;
  magnitude_min?: number | null;
  magnitude_max?: number | null;
  magnitude_reference?: string;
  summary: string;
  suggested_action: string;
  /** v5: 结构化维度 */
  dimensions?: {
    dimension_type: string;
    dimension_order?: number;
    content: string;
    evidence_strength: string;
    source_title?: string;
    source_url?: string;
  }[];
  /** v5: 结构化关键事件 */
  key_events?: {
    event_date?: string;
    event_description: string;
    impact_direction?: string;
    source_title?: string;
    source_url?: string;
  }[];
  /** v5: 信息充分度自评 */
  info_sufficiency?: { sufficient: boolean; missing_dimensions: string[]; reason: string };
}

const ANALYSIS_SYSTEM_PROMPT = `你是一个物料成本趋势分析助手。当前时间是 ${new Date().getFullYear()} 年 ${new Date().getMonth() + 1} 月。

根据提供的公开市场搜索结果，分析物料当前的成本趋势。

## ⚠️ 时效性强制规则（最高优先级）
1. **只接受 ${new Date().getFullYear()} 年的数据**。旧数据必须标注"过期"
2. **拒绝使用旧数据外推**

## 输出格式
严格按以下 JSON 格式输出（不要输出其他内容）：
{
  "trend_direction": "上涨|下降|震荡|信号不明确",
  "confidence_level": "高|中|低",
  "magnitude_min": 数字或null,
  "magnitude_max": 数字或null,
  "magnitude_reference": "时间基准说明或空字符串",
  "summary": "整体判断一句话摘要",
  "suggested_action": "备料/锁价|观望|维持常规节奏",
  "dimensions": [
    {
      "dimension_type": "供需格局",
      "content": "分析内容",
      "evidence_strength": "强|中|弱|未验证",
      "source_title": "来源标题",
      "source_url": "来源URL"
    },
    {
      "dimension_type": "价格驱动",
      "content": "分析内容",
      "evidence_strength": "强|中|弱|未验证",
      "source_title": "来源标题",
      "source_url": "来源URL"
    },
    {
      "dimension_type": "卡点识别",
      "content": "分析内容（无相关信息可留空）",
      "evidence_strength": "强|中|弱|未验证"
    },
    {
      "dimension_type": "政策地缘",
      "content": "分析内容（无相关信息可留空）",
      "evidence_strength": "强|中|弱|未验证"
    },
    {
      "dimension_type": "展望",
      "content": "短期（1-3月）/中期（半年）价格预期",
      "evidence_strength": "强|中|弱|未验证"
    }
  ],
  "info_sufficiency": {
    "sufficient": true或false,
    "missing_dimensions": ["缺信息的维度列表"],
    "reason": "判断理由"
  }
}

## 维度说明
- **供需格局**：供给紧张/宽松程度、扩产难度、产能利用率
- **价格驱动**：原材料成本传导、技术或良率变化、产能利用率等具体驱动因素
- **卡点识别**：低供应商数量、长验证周期、扩产困难、客户认证严格等"卡脖子"环节
- **政策地缘**：关税、产业政策、地缘风险等（无信息则留空）
- **展望**：短期（1-3月）/中期（半年）价格预期

## 证据强度标准
- **强**：多个独立信源交叉印证，近期一手信息（企业公告、权威机构报告）
- **中**：单一信源但可信度较高（主流财经媒体）
- **弱**：来源模糊或信息较旧
- **未验证**：提及但无法核实

## 规则
1. 信息不足以支撑某一维度时，该维度content留空字符串，不强行填充
2. 每条信息来源需标注标题和URL（如搜索结果中有）
3. info_sufficiency 用于判断是否需要补充搜索`;

async function callLLM(
  _provider: string,
  _apiKey: string,
  _model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  return callLLMWithFallback(systemPrompt, userPrompt, 0.3, 4000);
}

/** 调用 LLM 分析趋势（需配置 LLM API Key） */
export async function analyzeTrend(
  materialName: string,
  categoryType: string,
  searchResults: SearchResult[]
): Promise<TrendAnalysisResult> {
  const llmConfig = await resolveLLMConfig();
  if (!llmConfig) throw new Error('大模型 API Key 未配置，请先在设置页面配置');

  const resultsText = searchResults.map((r, i) =>
    `[${i + 1}] 标题: ${r.title}\nURL: ${r.url}\n摘要: ${r.snippet}`
  ).join('\n\n');

  const prompt = `请分析以下物料的市场成本趋势：

物料名称：${materialName}
查询类型：${categoryType === '原材料映射' ? '原材料（结构件映射）' : '电器件直接查询'}

公开搜索结果：
${resultsText}

请根据以上搜索结果，给出趋势分析。`;

  let rawResponse = await callLLM('', '', '', ANALYSIS_SYSTEM_PROMPT, prompt);

  // 最多重试 2 次解析
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = extractJSON(rawResponse);
      // 如果解析成功,增加维度返回
      return {
        trend_direction: parsed.trend_direction || '信号不明确',
        confidence_level: parsed.confidence_level || '低',
        magnitude_min: parsed.magnitude_min ?? null,
        magnitude_max: parsed.magnitude_max ?? null,
        magnitude_reference: parsed.magnitude_reference || '',
        summary: parsed.summary || '分析完成',
        suggested_action: parsed.suggested_action || '观望',
        dimensions: parsed.dimensions || [],
        info_sufficiency: parsed.info_sufficiency || { sufficient: true, missing_dimensions: [], reason: '' },
      };
    } catch {
      if (attempt === 0) {
        // 第一次失败，让 LLM 重新输出（不含 Markdown）
        rawResponse = await callLLM(
          '', '', '',
          ANALYSIS_SYSTEM_PROMPT + '\n\n## ⚠️ 上次输出格式不正确\n请只输出纯 JSON，不要添加任何 markdown 代码块标记、不要添加额外说明文字。严格按要求的 JSON 格式输出。',
          prompt
        );
      }
    }
  }
  // 两次都失败，抛异常让上层感知"
  const preview = rawResponse.slice(0, 200).replace(/\n/g, ' ');
  throw new Error(`LLM 趋势分析结果解析失败，无法获取有效判断。原始返回: ${preview}...`);
}

/** 直接调用 LLM（用于追问，不需要搜索结果） */
export async function askLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const llmConfig = await resolveLLMConfig();
  if (!llmConfig) throw new Error('LLM API Key 未配置');
  return callLLMWithFallback(systemPrompt, userPrompt, 0.3, 2000);
}

// ====== 多轮对话（追问） ======

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 多轮对话：按标准 chat messages 格式调用 LLM，携带完整上下文 */
async function callLLMChat(_provider: string, _apiKey: string, _model: string, messages: ChatMessage[]): Promise<string> {
  const providers = await getActiveProviders();
  const llmProviders = providers.llm.filter((p: any) => p.api_key).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0));
  if (llmProviders.length === 0) throw new Error('未配置 LLM 供应商');

  let lastError: Error | null = null;
  for (const provider of llmProviders) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callSingleLLMProviderMessages(provider, messages, 0.5, 4000);
      } catch (e: any) { lastError = e; if (/HTTP 4\d\d/.test(e?.message || '')) break; if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); }
    }
  }
  throw new Error(`所有 LLM 供应商均调用失败${lastError ? `。最后一个错误: ${(lastError as any).message || lastError}` : '（无具体错误）'}`);
}

// ====== 信息质量评估 Skills（System Prompt） ======

const CONVERSATION_SYSTEM_PROMPT = `你是 CostHub 物料成本趋势分析助手。当前时间是 ${new Date().getFullYear()} 年 ${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日。你正在与用户进行多轮对话。

## ⚠️ 时效性强制规则（最高优先级）
1. **只认可 ${new Date().getFullYear()} 年的数据**。任何标注为 2024、2025 年的信息都是过期数据
2. 如果搜索结果/对话历史中的数据全部来自旧年份，必须明确告知用户"当前数据已过时，无法判断最新趋势，建议触发补充搜索"
3. 禁止用旧数据（2024-2025）推测或外推当前（${new Date().getFullYear()}）趋势
4. 每条引用数据时，必须标注其发布时间，让用户自行判断时效性

## 信息评估规则
1. **时效性检查**：每条信息先检查发布时间，超过90天的标记为"可能过时"
2. **来源可信度**：官方数据 > 行业报告 > 新闻媒体 > 自媒体
3. **诚实边界**：信息不足以支撑判断时，必须诚实说明，建议补充搜索

## 回复格式
- 先给结论，再列依据
- 涉及数据时标注（来源 + 发布时间）`;

/**
 * 多轮对话追问（标准 chat messages 格式，携带完整上下文）
 * @param searchContext - 原始搜索结果（JSON 字符串或文本）
 * @param searchDate - 上次搜索日期
 * @param conversationHistory - 历史对话 [{question, answer, created_at}, ...]
 * @param currentQuestion - 当前问题
 */
export async function multiTurnAsk(
  searchContext: string,
  searchDate: string,
  conversationHistory: { question: string; answer: string; created_at?: string }[],
  currentQuestion: string
): Promise<string> {
  const llmConfig = await resolveLLMConfig();
  if (!llmConfig) throw new Error('LLM API Key 未配置');

  const messages: ChatMessage[] = [];

  // System prompt with context
  const freshnessNote = searchDate
    ? `\n\n## 搜索数据时效性\n上次搜索时间：${searchDate}（距今约 ${Math.floor((Date.now() - new Date(searchDate).getTime()) / 86400000)} 天）。请注意信息可能已过时，分析时应考虑时效性。`
    : '\n\n## 搜索数据时效性\n搜索时间未知，请提醒用户注意信息时效性。';

  messages.push({
    role: 'system',
    content: CONVERSATION_SYSTEM_PROMPT + '\n\n## 本次分析的搜索数据\n' + (searchContext || '无搜索数据（纯知识库分析）') + freshnessNote,
  });

  // Historical conversation
  for (const c of conversationHistory) {
    messages.push({ role: 'user', content: c.question });
    messages.push({ role: 'assistant', content: c.answer });
  }

  // Current question
  messages.push({ role: 'user', content: currentQuestion });

  return callLLMChat('', '', '', messages);
}

/**
 * 补充搜索：针对追问中的具体话题进行定向搜索 + 分析
 */
export async function supplementarySearch(
  materialName: string,
  _categoryType: string,
  specificQuestion: string
): Promise<{ searchResults: SearchResult[]; analysis: string }> {
  const hasSearch = await hasSearchConfig();

  // 无搜索 API 时，LLM 基于自身知识回答
  if (!hasSearch) {
    const analysis = await callLLM(
      '', '', '',
      `你是物料分析助手。当前时间 ${new Date().getFullYear()}年${new Date().getMonth() + 1}月。基于你的知识回答用户问题。必须标注"基于 LLM 训练知识，未实时搜索"。`,
      `物料：${materialName}\n问题：${specificQuestion}\n\n请诚实回答，信息不足时明确说明。`
    );
    return {
      searchResults: [{ title: 'LLM 知识库（未使用搜索引擎）', url: '', snippet: '建议配置搜索 API 获取实时数据' }],
      analysis,
    };
  }

  // 构建更精准的搜索关键词
  const now = new Date();
  const query = `${materialName} ${specificQuestion.slice(0, 40)} ${now.getFullYear()}年${now.getMonth() + 1}月 最新`;
  const results = await searchWeb(query);

  if (results.length === 0) {
    return { searchResults: [], analysis: '未找到相关最新信息。' };
  }

  // 用 LLM 分析补充搜索结果
  const resultsText = results.map((r, i) =>
    `[${i + 1}] 标题: ${r.title}\nURL: ${r.url}\n摘要: ${r.snippet}`
  ).join('\n\n');

  const analysis = await callLLM(
    '', '', '',
    `你是物料成本分析助手。用户针对"${materialName}"提出了一个具体问题，以下是补充搜索结果。请基于这些结果直接回答用户的问题。如信息不足，如实说明。`,
    `用户问题：${specificQuestion}\n\n补充搜索结果：\n${resultsText}\n\n请回答用户的问题。`
  );

  return { searchResults: results, analysis };
}

/** Tavily 搜索 API */
async function searchTavily(query: string, apiKey: string, baseUrl = 'https://api.tavily.com/search'): Promise<SearchResult[]> {
  const res = await rustPost(
    baseUrl,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 8, include_answer: false })
  );
  if (!res.success) throw new Error(`Tavily API 返回错误 (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.results || []).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
  }));
}

export function buildSearchQuery(materialName: string, categoryType: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dateStr = `${year}年${month}月`;
  if (categoryType === '原材料映射') {
    return `${materialName} 原材料 价格 市场行情 ${dateStr} 最新`;
  }
  return `${materialName} 电子元器件 价格 市场行情 ${dateStr} 最新`;
}

// ====== 可配置的分析 Skills ======

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  searchQueries: string[]; // 预置搜索关键词模板
  maxSearchRounds: number;
  outputDimensions?: string[];
}

const EVIDENCE_LEVELS = ['强', '中', '弱', '未验证'];

function buildStructuredAnalysisPrompt(skill: SkillTemplate, sourceContext: string) {
  const dimensions = skill.outputDimensions || ['核心结论', '证据与依据', '展望'];
  const now = new Date();
  const currentTime = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  const currentYear = now.getFullYear();

  return `你是 CostHub 物料成本洞察专家。当前时间：${currentTime}。请采用「${skill.name}」的成熟方法论，对物料给出可执行、可审计的结论。

## 方法论说明
${skill.description}

## 输出维度（必须按顺序完整返回）
${dimensions.map((dimension, index) => `${index + 1}. ${dimension}`).join('\n')}

## 数据时效性要求（严格遵守）
- **优先采信${currentYear}年的数据**，特别是最近3个月内的信息
- **明确标注数据时间**：每条关键信息必须注明发布日期（如”2026年7月数据”）
- **旧数据处理**：${currentYear - 1}年及之前的数据必须明确标注为”历史数据”或”过期”
- **数据新鲜度评估**：如果最新数据超过6个月，在置信度中体现
- **避免使用模糊时间词**：不说”近期””最近”，改用具体月份
- **数据来源时间戳**：source_title中尽量包含发布日期

## 结论质量要求
- 基于公开信息，不得捏造价格、供应商或日期；证据不足时明确写”公开信息不足，需补充搜索”。
- 结论必须针对采购决策：说明风险、触发信号与建议动作，而非只复述资料。
- 每个维度给出一项证据强度：强 / 中 / 弱 / 未验证；仅当来源足够支撑时才能标”强”。
- 对每个维度尽量绑定最相关的一条来源（只能使用提供的来源 URL）；无来源时 source_url 留空。
- 至少给出 0-3 条关键事件。没有可独立验证的事件时返回空数组。

严格只输出 JSON（**总长度控制在3500字符内**）：
{
  “trend_direction”:”上涨|下降|震荡|信号不明确”,
  “confidence_level”:”高|中|低”,
  “magnitude_min”: null,
  “magnitude_max”: null,
  “magnitude_reference”:”时间基准说明（不超过30字）”,
  “summary”:”一句话采购结论（不超过80字）”,
  “suggested_action”:”备料/锁价|观望|维持常规节奏”,
  “dimensions”:[
    {“dimension_type”:”${dimensions[0]}”,”content”:”简洁结论（不超过120字）”,”evidence_strength”:”中”,”source_title”:”来源标题”,”source_url”:”https://...”}
    ${dimensions.slice(1).map(d => `,{“dimension_type”:”${d}”,”content”:”简洁结论（不超过120字）”,”evidence_strength”:”中”,”source_title”:””,”source_url”:””}`).join('')}
  ],
  “key_events”:[
    {“event_date”:”YYYY-MM-DD”,”event_description”:”事件描述（不超过60字）”,”impact_direction”:”利多上涨|利多下跌|中性”,”source_title”:””,”source_url”:””}
  ],
  “info_sufficiency”:{“sufficient”:true,”missing_dimensions”:[],”reason”:”说明（不超过40字）”}
}

**关键要求**：
1. 必须输出完整JSON，确保最后的}闭合
2. dimensions数组必须包含${dimensions.length}项，顺序与上述维度列表一致
3. 每个维度content严格控制在120字内，避免超长
4. key_events最多3项
5. 即使某维度搜不到信息，也必须输出该维度，content写”公开信息不足”，evidence_strength写”未验证”

## 可用来源
${sourceContext || '无实时来源；必须如实说明分析基于模型训练知识，时效性有限。'}`;
}

function normalizeStructuredResult(parsed: any, skill: SkillTemplate): TrendAnalysisResult {
  const dimensions = skill.outputDimensions || [];
  const resultDimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
  const normalizedDimensions = dimensions.map((dimension_type, dimension_order) => {
    const item = resultDimensions.find((dimension: any) => dimension?.dimension_type === dimension_type);
    return {
      dimension_type,
      dimension_order,
      content: item?.content || '公开信息不足，暂无法形成可靠结论。',
      evidence_strength: EVIDENCE_LEVELS.includes(item?.evidence_strength) ? item.evidence_strength : '未验证',
      source_title: item?.source_title || '',
      source_url: item?.source_url || '',
    };
  });

  return {
    trend_direction: parsed.trend_direction || '信号不明确',
    confidence_level: parsed.confidence_level || '低',
    magnitude_min: parsed.magnitude_min ?? null,
    magnitude_max: parsed.magnitude_max ?? null,
    magnitude_reference: parsed.magnitude_reference || '',
    summary: parsed.summary || '公开信息不足，建议补充搜索后再判断。',
    suggested_action: parsed.suggested_action || '观望',
    dimensions: normalizedDimensions,
    key_events: Array.isArray(parsed.key_events) ? parsed.key_events.slice(0, 3) : [],
    info_sufficiency: parsed.info_sufficiency || { sufficient: false, missing_dimensions: dimensions, reason: '未返回充分度评估' },
  };
}

// 内置 Skill 模板（systemPrompt留空，实际使用时由buildStructuredAnalysisPrompt动态生成）
export const BUILTIN_SKILLS: SkillTemplate[] = [
  {
    id: 'price-trend',
    name: '价格趋势分析',
    description: '聚焦价格走势、涨跌因素、历史对比 — 价格驱动四因子框架',
    icon: '📈',
    systemPrompt: '',
    searchQueries: ['价格 走势 涨跌', '原材料 成本', '供需 库存', '政策 影响'],
    maxSearchRounds: 1,
    outputDimensions: ['供给因子', '需求因子', '成本因子', '金融与政策因子', '展望'],
  },
  {
    id: 'supply-chain',
    name: '供应链分析',
    description: '上游原料、生产工艺、关键供应商 — 供应链全景扫描',
    icon: '🏭',
    systemPrompt: '',
    searchQueries: ['供应商 产能', '原材料 来源', '生产 工艺', '物流 交期'],
    maxSearchRounds: 1,
    outputDimensions: ['上游原料', '生产工艺', '关键供应商', '物流与交期', '风险点'],
  },
  {
    id: 'competition',
    name: '竞争格局分析',
    description: '主要供应商、市场份额、替代方案 — 波特五力框架',
    icon: '⚔️',
    systemPrompt: '',
    searchQueries: ['供应商 市场份额 排名', '竞争格局 变化', '替代方案 替代物料', '行业动态 并购 扩产'],
    maxSearchRounds: 1,
    outputDimensions: ['供应商议价能力', '买方议价能力', '行业内竞争强度', '替代品威胁', '新进入者威胁'],
  },
  {
    id: 'deep-research',
    name: '综合深度研究',
    description: '多维度全面分析，适合关键物料决策 — 五看三定框架',
    icon: '🔬',
    systemPrompt: '',
    searchQueries: ['价格 走势 行情 最新', '产能 供应 需求 库存', '供应商 竞争 市场份额', '政策 法规 影响', '技术 趋势 替代'],
    maxSearchRounds: 2,
    outputDimensions: ['看行业/趋势', '看市场/客户', '看竞争', '看自己', '看机会'],
  },
  {
    id: 'swot',
    name: 'SWOT分析',
    description: '优势劣势机会威胁 — 经典战略分析工具',
    icon: '🎯',
    systemPrompt: '',
    searchQueries: ['供应 稳定性', '价格 波动 风险', '新技术 替代', '供应商 变化'],
    maxSearchRounds: 1,
    outputDimensions: ['优势(Strengths)', '劣势(Weaknesses)', '机会(Opportunities)', '威胁(Threats)'],
  },
  {
    id: 'pest',
    name: 'PEST宏观分析',
    description: '政治经济社会技术 — 宏观环境扫描',
    icon: '🌍',
    systemPrompt: '',
    searchQueries: ['政策 法规 贸易', '汇率 经济 影响', '环保 标准 要求', '技术 创新 趋势'],
    maxSearchRounds: 1,
    outputDimensions: ['政治(Political)', '经济(Economic)', '社会(Social)', '技术(Technological)'],
  },
  {
    id: 'risk',
    name: '风险评估',
    description: '识别、评估、应对采购风险 — 风险矩阵法',
    icon: '⚠️',
    systemPrompt: '',
    searchQueries: ['供应商 风险 倒闭', '价格 暴涨 原因', '质量 问题 召回', '断供 事件'],
    maxSearchRounds: 1,
    outputDimensions: ['供应中断风险', '价格波动风险', '质量合规风险', '应对策略'],
  },
  {
    id: 'tco',
    name: 'TCO全生命周期成本',
    description: '不只看采购价，算总拥有成本 — TCO模型',
    icon: '💰',
    systemPrompt: '',
    searchQueries: ['使用 损耗 维护', '质量 问题 成本', '物流 仓储 费用'],
    maxSearchRounds: 1,
    outputDimensions: ['采购成本', '使用成本', '风险成本', '综合评估'],
  },
  {
    id: 'resilience',
    name: '供应链韧性分析',
    description: '评估供应链的抗风险能力 — 韧性三要素',
    icon: '🛡️',
    systemPrompt: '',
    searchQueries: ['备选 供应商', '交货周期 弹性', '库存 可见性', '供应链 中断'],
    maxSearchRounds: 1,
    outputDimensions: ['冗余度(Redundancy)', '灵活性(Flexibility)', '可见性(Visibility)', '韧性评分与建议'],
  },
  {
    id: 'custom',
    name: '自定义',
    description: '用户自定义分析框架',
    icon: '✏️',
    systemPrompt: '',
    searchQueries: [],
    maxSearchRounds: 1,
  },
];

// Skill 配置存储（localStorage，非加密——这些是提示词不是密钥）
const SKILL_STORAGE_KEY = 'costhub_skills_config';

export interface SkillConfig {
  activeSkillIds: string[]; // 改为数组，支持多选
  skillOverrides: Record<string, Partial<SkillTemplate>>; // 内置Skill的覆盖配置
  customSkills: SkillTemplate[]; // 用户创建的自定义Skill列表
  customPrompt: string; // 对自定义 skill 的 prompt（向后兼容）
  customSearchQueries: string; // 向后兼容
}

export function loadSkillConfig(): SkillConfig {
  try {
    const raw = localStorage.getItem(SKILL_STORAGE_KEY);
    if (raw) {
      const config = JSON.parse(raw);
      // 向后兼容：如果是旧格式的activeSkillId，转换为数组
      if (config.activeSkillId && !config.activeSkillIds) {
        config.activeSkillIds = [config.activeSkillId];
        delete config.activeSkillId;
      }
      return {
        activeSkillIds: config.activeSkillIds || ['price-trend'],
        skillOverrides: config.skillOverrides || {},
        customSkills: config.customSkills || [],
        customPrompt: config.customPrompt || '',
        customSearchQueries: config.customSearchQueries || '',
      };
    }
  } catch {}
  return { activeSkillIds: ['price-trend'], skillOverrides: {}, customSkills: [], customPrompt: '', customSearchQueries: '' };
}

export function saveSkillConfig(config: SkillConfig): void {
  localStorage.setItem(SKILL_STORAGE_KEY, JSON.stringify(config));
}

// 获取指定Skill（应用用户覆盖配置）
export function getSkill(skillId: string): SkillTemplate {
  const config = loadSkillConfig();

  // 先从内置Skill中查找
  const builtinSkill = BUILTIN_SKILLS.find(s => s.id === skillId);
  if (builtinSkill) {
    // 应用用户覆盖配置
    const override = config.skillOverrides[skillId] || {};
    return { ...builtinSkill, ...override };
  }

  // 再从自定义Skill中查找
  const customSkill = config.customSkills.find(s => s.id === skillId);
  if (customSkill) {
    return customSkill;
  }

  // 兜底返回第一个内置Skill
  return BUILTIN_SKILLS[0];
}

// 获取当前激活的Skill列表（向后兼容，返回第一个）
export function getActiveSkill(): SkillTemplate {
  const config = loadSkillConfig();
  const firstSkillId = config.activeSkillIds[0] || 'price-trend';
  return getSkill(firstSkillId);
}

// 获取所有激活的Skill
export function getActiveSkills(): SkillTemplate[] {
  const config = loadSkillConfig();
  return config.activeSkillIds.map(id => getSkill(id));
}

// ====== Agent 搜索循环（LLM 自主决定搜索策略） ======

const AGENT_SYSTEM_PROMPT = `你是一个物料成本趋势分析 Agent。你可以调用搜索引擎获取最新公开信息。

## 工作流程
你收到分析任务后，可以：
1. 先思考需要搜索什么信息
2. 调用搜索获取结果
3. 评估结果是否足够
4. 如有需要，换角度/关键词继续搜索
5. 最终综合所有搜索结果给出分析

## 输出格式（严格遵守）
每轮你必须输出以下 JSON 格式，不要输出其他内容：

如果你想搜索：
{"action":"search","queries":["搜索词1","搜索词2"]}

如果信息已充足，给出最终分析：
{"action":"final","trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","summary":"综合所有搜索结果的判断依据，分点列出，每点标注来源","suggested_action":"备料/锁价|观望|维持常规节奏"}

## 规则
- 每轮最多提 3 个搜索词，每个搜索词将返回前 5 条结果
- 最多进行 N 轮搜索（由系统配置）
- 搜索结果只包含标题、URL、摘要
- 信息不足时诚实输出"信号不明确"`;

interface AgentAction {
  action: 'search' | 'final';
  queries?: string[];
  trend_direction?: string;
  confidence_level?: string;
  magnitude_min?: number | null;
  magnitude_max?: number | null;
  magnitude_reference?: string;
  summary?: string;
  suggested_action?: string;
}

async function executeSearchRounds(queries: string[]): Promise<SearchResult[][]> {
  const results: SearchResult[][] = [];
  for (const q of queries) {
    try {
      const r = await searchWeb(q);
      results.push(r);
    } catch {
      results.push([]);
    }
  }
  return results;
}

function formatSearchResults(allResults: SearchResult[][]): string {
  let text = '';
  let globalIdx = 0;
  for (const results of allResults) {
    for (const r of results) {
      globalIdx++;
      text += `[${globalIdx}] ${r.title}\nURL: ${r.url}\n摘要: ${r.snippet}\n\n`;
    }
  }
  return text || '（未找到相关结果）';
}

/**
 * Agent 搜索循环：LLM 自主决定搜索策略，多轮迭代直到信息充足
 */
export async function agentSearchLoop(
  materialName: string,
  categoryType: string,
  skillId?: string,
  onProgress?: (msg: string) => void
): Promise<{
  trend_direction: string;
  confidence_level: string;
  magnitude_min: number | null;
  magnitude_max: number | null;
  magnitude_reference: string;
  summary: string;
  suggested_action: string;
  allSources: SearchResult[];
  searchRounds: number;
}> {
  const llmConfig = await resolveLLMConfig();
  if (!llmConfig) throw new Error('LLM API Key 未配置');
  const searchConfig = await resolveSearchConfig();
  const hasSearch = !!searchConfig;

  const skill = skillId
    ? (BUILTIN_SKILLS.find(s => s.id === skillId) || BUILTIN_SKILLS[0])
    : getActiveSkill();
  const maxRounds = hasSearch ? (skill.maxSearchRounds || 1) : 0;

  // 无搜索 API 时，LLM 使用自身知识做分析
  if (!hasSearch) {
    if (onProgress) onProgress('未配置搜索 API，LLM 基于自身知识分析...');
    const messages: ChatMessage[] = [
      { role: 'system', content: skill.systemPrompt + `\n\n⚠️ 注意：当前未配置搜索 API，请完全基于你的训练知识进行分析。必须标注"以下分析基于 LLM 训练知识，未使用实时搜索，时效性可能不足"。只采信${new Date().getFullYear()}年的趋势信息，旧数据请注明"历史参考"。` },
      { role: 'user', content: `请分析以下物料的市场趋势：${materialName}（${categoryType === '原材料映射' ? '原材料' : '电器件'}）\n\n请直接给出分析，诚实标注信息时效性。按照 JSON 格式输出：{"trend_direction":"...","confidence_level":"...","summary":"...","suggested_action":"..."}` },
    ];
    const rawResponse = await callLLMChat('', '', '', messages);
    try {
      const parsed = extractJSON(rawResponse);
      return {
        trend_direction: parsed.trend_direction || '信号不明确',
        confidence_level: parsed.confidence_level || '中',
        summary: parsed.summary || '分析完成（AI基于训练知识，无实时搜索）',
        suggested_action: parsed.suggested_action || '观望',
        magnitude_min: parsed.magnitude_min ?? null,
        magnitude_max: parsed.magnitude_max ?? null,
        magnitude_reference: parsed.magnitude_reference || '',
        allSources: [{ title: 'LLM 知识库分析（未使用搜索引擎）', url: '', snippet: '建议配置搜索 API 以获取实时数据' }],
        searchRounds: 0,
      };
    } catch {
      throw new Error(`LLM 无搜索分析结果解析失败，无法获取有效判断。原始返回: ${rawResponse.slice(0, 200)}...`);
    }
  }

  const allSources: SearchResult[] = [];
  const conversationMessages: { role: string; content: string }[] = [];

  // 初始任务
  const taskPrompt = `分析任务：${materialName}（${categoryType === '原材料映射' ? '原材料' : '电器件'}）

${skill.systemPrompt}

请开始分析。你可以先搜索相关信息。`;
  conversationMessages.push({ role: 'user', content: taskPrompt });

  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;
    if (onProgress) onProgress(`第 ${rounds} 轮搜索...`);

    // 构建完整的 messages 列表
    const messages: ChatMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT.replace('N 轮', `${maxRounds} 轮`) },
      ...conversationMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    // 调用 LLM
    const rawResponse = await callLLMChat('', '', '', messages);

    // 解析 LLM 响应
    let parsed: AgentAction;
    try {
      parsed = extractJSON(rawResponse);
      if (!parsed.action) throw new Error('Missing action');
    } catch {
      // 解析失败，给出明确错误而非静默降级
      return {
        trend_direction: '解析错误',
        confidence_level: '低',
        magnitude_min: null, magnitude_max: null, magnitude_reference: '',
        summary: `⚠️ LLM 返回格式解析失败，非真实趋势信号。原始返回: ${rawResponse.slice(0, 300)}`,
        suggested_action: '解析错误，请重试',
        allSources,
        searchRounds: rounds,
      };
    }

    // 记录 LLM 响应
    conversationMessages.push({ role: 'assistant', content: rawResponse });

    if (parsed.action === 'search' && parsed.queries && parsed.queries.length > 0) {
      // 执行搜索
      if (onProgress) onProgress(`搜索中: ${parsed.queries.slice(0, 2).join(', ')}...`);
      const searchResults = await executeSearchRounds(parsed.queries.slice(0, 3));

      // 收集来源
      const sourceCountBefore = allSources.length;
      for (const batch of searchResults) {
        for (const r of batch) {
          if (!allSources.find(s => s.url === r.url)) {
            allSources.push(r);
          }
        }
      }

      if (allSources.length === sourceCountBefore && rounds >= maxRounds) {
        return {
          trend_direction: '信号不明确',
          confidence_level: '低',
          magnitude_min: null,
          magnitude_max: null,
          magnitude_reference: '',
          summary: '搜索 API 可调用，但没有返回可读且相关的公开来源。本次未形成可靠趋势判断，请检查搜索供应商配置、配额或更换关键词。',
          suggested_action: '观望',
          allSources,
          searchRounds: rounds,
        };
      }

      // 将搜索结果反馈给 LLM
      const feedback = `搜索结果（第 ${rounds} 轮）：\n${formatSearchResults(searchResults)}\n\n请评估这些信息是否足够。如需更多信息，可以继续搜索（剩余 ${maxRounds - rounds} 轮）；如已充足，请给出最终分析。`;
      conversationMessages.push({ role: 'user', content: feedback });
      if (onProgress) onProgress(`第 ${rounds} 轮完成，获取 ${allSources.length} 条来源`);
    } else if (parsed.action === 'final') {
      // LLM 给出最终答案
      return {
        trend_direction: parsed.trend_direction || '信号不明确',
        confidence_level: parsed.confidence_level || '低',
        summary: parsed.summary || 'LLM 未提供分析内容',
        suggested_action: parsed.suggested_action || '观望',
        magnitude_min: (parsed as any).magnitude_min ?? null,
        magnitude_max: (parsed as any).magnitude_max ?? null,
        magnitude_reference: (parsed as any).magnitude_reference || '',
        allSources,
        searchRounds: rounds,
      };
    } else {
      // 格式不对，再给一次机会
      conversationMessages.push({
        role: 'user',
        content: `请按 JSON 格式输出。搜索请用 {"action":"search","queries":["词1","词2"]}，结束请用 {"action":"final",...}。剩余 ${maxRounds - rounds} 轮。`,
      });
    }
  }

  // 达到最大轮数，强制要求最终答案
  if (onProgress) onProgress('达到最大搜索轮数，正在整合分析...');
  const messages: ChatMessage[] = [
    { role: 'system', content: '请基于所有搜索结果给出最终分析。严格按 JSON 格式输出：{"action":"final","trend_direction":"...","confidence_level":"...","summary":"...","suggested_action":"..."}' },
    ...conversationMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: '请给出最终分析。' },
  ];

  let finalResponse = '';
  try {
    finalResponse = await callLLMChat('', '', '', messages);
    const parsed = extractJSON(finalResponse);
    return {
      trend_direction: parsed.trend_direction || '信号不明确',
      confidence_level: parsed.confidence_level || '低',
      magnitude_min: parsed.magnitude_min ?? null,
      magnitude_max: parsed.magnitude_max ?? null,
      magnitude_reference: parsed.magnitude_reference || '',
      summary: parsed.summary || '分析完成',
      suggested_action: parsed.suggested_action || '观望',
      allSources,
      searchRounds: rounds,
    };
  } catch {
    throw new Error(`Agent 最终答案解析失败。原始返回: ${(finalResponse || '').slice(0, 300)}...`);
  }
}

/**
 * 将搜索和 Agent 摘要转化为按 Skill 方法论组织的可持久化洞察。
 * 该步骤不重新搜索，只对既有来源做结论、证据与关键事件的结构化。
 */
export async function createStructuredInsight(
  materialName: string,
  skill: SkillTemplate,
  sources: SearchResult[],
  agentSummary: string
): Promise<TrendAnalysisResult> {
  const sourceContext = [
    `物料：${materialName}`,
    `已有初步摘要：${agentSummary || '无'}`,
    ...sources.slice(0, 10).map((source, index) => `[${index + 1}] 标题：${source.title}\nURL：${source.url}\n摘要：${source.snippet.slice(0, 200)}`),
  ].join('\n\n');

  console.log('[createStructuredInsight] 调用LLM，skill:', skill.name, '物料:', materialName);
  const raw = await callLLM('', '', '', buildStructuredAnalysisPrompt(skill, sourceContext), `请为「${materialName}」生成本次洞察的最终结构化结论。`);

  console.log('[createStructuredInsight] LLM原始返回长度:', raw.length);
  console.log('[createStructuredInsight] LLM原始返回内容（前500字符）:', raw.slice(0, 500));
  console.log('[createStructuredInsight] LLM原始返回内容（最后200字符）:', raw.slice(-200));

  try {
    const parsed = extractJSON(raw);
    console.log('[createStructuredInsight] JSON解析成功');
    return normalizeStructuredResult(parsed, skill);
  } catch (e: any) {
    console.error('[createStructuredInsight] JSON解析失败:', e.message);
    console.error('[createStructuredInsight] 完整原始文本:', raw);
    throw e;
  }
}

// ====== 独立连接测试 ======

export interface TestResult {
  success: boolean;
  message: string;
  detail?: string;
}

/** 单独测试搜索 API 连接 */
export async function testSearchConnection(): Promise<TestResult> {
  try {
    const providers = await getActiveProviders();
    const activeSearch = providers.search.find((p: any) => p.is_active) || providers.search[0];
    if (!activeSearch) {
      return { success: false, message: '未配置搜索 API Key', detail: '请先在设置页面添加并启用搜索供应商' };
    }

    const testQuery = '2026 铜价 上海有色网 LME copper price';
    let results: SearchResult[];

    results = await searchWithProvider(activeSearch, testQuery);
    const relevantTerms = ['铜', 'copper', 'lme', '金属', '价格', 'commodity', '有色', '期货'];
    const relevantResults = results.filter(r => isRelevantSearchResult(r, relevantTerms));

    if (relevantResults.length === 0) {
      return {
        success: false,
        message: '搜索 API 返回了结果，但没有可用的相关结果',
        detail: results.length === 0
          ? 'API Key 可能有效，但返回内容为空或被判定为不可读，请检查供应商配额、Base URL、地区限制。'
          : `返回结果与测试主题不相关，已拦截为失败，避免误判通过。\n\n${results.slice(0, 3).map(r => `• ${r.title}\n  ${r.snippet}`).join('\n\n')}`,
      };
    }

    return {
      success: true,
      message: `✅ 搜索 API 连接成功！获取到 ${relevantResults.length} 条有效结果`,
      detail: relevantResults.slice(0, 3).map(r => `• ${r.title}\n  ${r.snippet}`).join('\n\n'),
    };
  } catch (e: any) {
    return { success: false, message: '搜索 API 连接失败', detail: e.message || '未知错误' };
  }
}

/** 单独测试 LLM API 连接 */
export async function testLLMConnection(): Promise<TestResult> {
  try {
    const providers = await getActiveProviders();
    const activeLLM = providers.llm.find((p: any) => p.is_active) || providers.llm[0];
    if (!activeLLM) {
      return { success: false, message: '未配置大模型 API Key', detail: '请先在设置页面添加并启用 LLM 供应商' };
    }

    const response = await callSingleLLMProvider(
      activeLLM,
      '你是一个助手。只回复"OK"两个字，不要回复其他内容。',
      '请回复OK',
      0,
      32,
    );

    const trimmed = response.trim();
    if (!isReadableText(trimmed) || !/\bOK\b/i.test(trimmed)) {
      return {
        success: false,
        message: '大模型 API 返回异常内容',
        detail: `接口可访问，但未按要求返回 OK，可能是 Base URL、模型名或网关编码异常。\nLLM 响应: "${trimmed.slice(0, 200)}"${trimmed.length > 200 ? '...' : ''}`,
      };
    }
    return {
      success: true,
      message: `✅ LLM API 连接成功！`,
      detail: `LLM 响应: "${trimmed.slice(0, 200)}"${trimmed.length > 200 ? '...' : ''}`,
    };
  } catch (e: any) {
    return { success: false, message: '大模型 API 连接失败', detail: e.message || '未知错误' };
  }
}

/** 完整链路测试（搜索 + LLM，旧的统一测试入口，保留兼容） */
export async function testConnection(): Promise<{ success: boolean; message: string }> {
  const searchResult = await testSearchConnection();
  if (!searchResult.success) {
    return { success: false, message: `搜索层失败: ${searchResult.message}` };
  }

  const llmResult = await testLLMConnection();
  if (!llmResult.success) {
    return { success: false, message: `LLM层失败: ${llmResult.message}` };
  }

  return {
    success: true,
    message: `全部通过！搜索: ${searchResult.message.split('\n')[0].replace('✅ ', '')} | LLM: ${llmResult.message.split('\n')[0].replace('✅ ', '')}`,
  };
}
