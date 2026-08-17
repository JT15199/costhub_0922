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

/** 最近一次 LLM 调用的元数据（provider/model/token），供 AI 请求日志记录使用 */
let lastLLMMeta: { provider_name?: string; model_name?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
export function getLastLLMMeta() { return lastLLMMeta; }
export function setLastLLMMeta(m: Partial<typeof lastLLMMeta>) { lastLLMMeta = { ...lastLLMMeta, ...m }; }

// 从数据库加载活跃供应商（含解密）——必须 is_active=1 才算活跃
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
      search: decrypted.filter((p: any) => p.provider_type === 'search' && p.api_key && p.is_active).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)),
      llm: decrypted.filter((p: any) => p.provider_type === 'llm' && p.api_key && p.is_active).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)),
    };
  } catch {
    return { search: [], llm: [] };
  }
}

// 获取活跃的 LLM 配置（仅从数据库供应商，getActiveProviders 已过滤 is_active）
async function resolveLLMConfig(): Promise<{ apiKey: string; provider: string; model: string; baseUrl: string } | null> {
  const providers = await getActiveProviders();
  if (providers.llm.length > 0) {
    const active = providers.llm[0];
    return {
      apiKey: active.api_key,
      provider: active.provider_name?.toLowerCase().includes('openai') || active.provider_name?.toLowerCase().includes('硅基') ? 'openai' : 'deepseek',
      model: active.model_name || 'deepseek-chat',
      baseUrl: active.base_url || 'https://api.deepseek.com/v1/chat/completions',
    };
  }
  return null;
}

// 获取活跃的搜索配置（仅从数据库供应商，getActiveProviders 已过滤 is_active）
async function resolveSearchConfig(): Promise<{ apiKey: string; provider: string } | null> {
  const providers = await getActiveProviders();
  if (providers.search.length > 0) {
    const active = providers.search[0];
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

  // 增强的错误处理：捕获更多细节
  let res;
  try {
    res = await rustPost(
      baseUrl,
      { Authorization: `Bearer ${provider.api_key}`, 'Content-Type': 'application/json' },
      JSON.stringify({
        model: provider.model_name || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    );
  } catch (e: any) {
    // 网络层错误
    throw new Error(`${provider.provider_name} 网络请求失败: ${e.message || String(e)}`);
  }

  if (!res.success) {
    // HTTP 错误
    const errorDetail = res.body.slice(0, 500).replace(/\n/g, ' ');
    throw new Error(`${provider.provider_name} HTTP ${res.status}: ${errorDetail}`);
  }

  // 检查响应体是否为空
  if (!res.body || res.body.trim() === '') {
    throw new Error(`${provider.provider_name} 返回空响应体。可能原因：API配额耗尽、请求被拒绝、或网络中断。`);
  }

  let data: any;
  try {
    data = JSON.parse(res.body);
  } catch (parseError: any) {
    throw new Error(`${provider.provider_name} 返回非 JSON 格式。请检查 Base URL 是否正确。响应内容: ${res.body.slice(0, 200)}`);
  }

  // 详细日志：查看完整响应结构

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${provider.provider_name} 返回成功但没有 choices[0].message.content。完整响应: ${JSON.stringify(data).slice(0, 500)}`);
  }

  // ====== Token 用量记录（用于设置页统计外部模型消耗） ======
  try {
    const usage = data.usage || {};
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const totalTokens = Number(usage.total_tokens) || (promptTokens + completionTokens);
    if (totalTokens > 0) {
      const { saveAIUsageLog } = await import('./db');
      await saveAIUsageLog({
        provider_name: provider.provider_name || '',
        model_name: provider.model_name || '',
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      });
      // 同步给 AI 请求日志（provider/model/token）
      setLastLLMMeta({
        provider_name: provider.provider_name || '',
        model_name: provider.model_name || '',
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      });
    } else {
      // 响应无 usage 时也记录 provider/model（失败/降级时也能看到用谁）
      setLastLLMMeta({ provider_name: provider.provider_name || '', model_name: provider.model_name || '' });
    }
  } catch { /* 用量记录失败不影响主流程 */ }

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
  // 如果用户提供的baseUrl不包含完整路径，自动补全
  let finalUrl = baseUrl;
  if (baseUrl && !baseUrl.includes('/search')) {
    finalUrl = baseUrl.replace(/\/+$/, '') + '/search';
  }
  if (!finalUrl) {
    finalUrl = 'https://google.serper.dev/search';
  }

        
  const res = await rustPost(
    finalUrl,
    { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    // tbs=qdr:m3 限制只搜最近3个月的结果
    JSON.stringify({ q: query, num: 8, gl: 'cn', hl: 'zh-CN', tbs: 'qdr:m3' })
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

/** 健壮 JSON 提取 */
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
    console.error('[extractJSON] 首次解析失败:', e.message);
    console.error('[extractJSON] 清理后的文本片段:', cleaned.slice(0, 300));

    // 修复1: 移除尾随逗号（如 "key": "value", }）
    let fixed = cleaned.replace(/,(\s*[}\]])/g, '$1');

    // 修复2: 修复数组中的尾随逗号（如 [1, 2, ]）
    fixed = fixed.replace(/,(\s*\])/g, '$1');

    // 修复3: 尝试在错误位置截断（如果JSON在某个位置中断）
    const errorMatch = e.message.match(/position (\d+)/);
    if (errorMatch) {
      const errorPos = parseInt(errorMatch[1], 10);
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
      const openBraces = (fixed.match(/\{/g) || []).length;
      const closeBraces = (fixed.match(/\}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;

      fixed += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
      fixed += '}'.repeat(Math.max(0, openBraces - closeBraces));
    }

    try {
      return JSON.parse(fixed);
    } catch (e2: any) {
      console.error('[extractJSON] 修复后仍然失败:', e2.message);

      // 最后的降级方案：返回一个包含原始文本的基本对象
      console.warn('[extractJSON] 使用降级方案：返回基本结构');
      return {
        trend_direction: '信号不明确',
        confidence_level: '低',
        summary: 'LLM返回格式异常，无法正常解析。原因可能是：1) 响应被截断 2) LLM未按JSON格式返回。建议重试或调整搜索关键词。',
        suggested_action: '观望',
        dimensions: [{
          dimension_type: '系统提示',
          content: '返回数据格式错误，请重试。' + (text.length > 200 ? '响应可能被截断。' : ''),
          evidence_strength: '未验证',
        }],
        key_events: [],
        info_sufficiency: { sufficient: false, missing_dimensions: [], reason: 'JSON解析失败: ' + e.message },
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
  // max_tokens 8000：多维度结构化 JSON 输出（5维度+关键事件+充分度评估）4000 易截断
  return callLLMWithFallback(systemPrompt, userPrompt, 0.3, 8000);
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

  try {
    const response = await callLLMWithFallback(systemPrompt, userPrompt, 0.3, 2000);

    // 记录成功的AI请求日志
    try {
      const { saveAIRequestLog } = await import('./db');
      await saveAIRequestLog({
        request_type: 'general',
        system_prompt: systemPrompt.slice(0, 500),  // 只保存前500字符
        user_prompt: userPrompt.slice(0, 500),
        response_summary: response.slice(0, 200),  // 只保存前200字符
        success: true,
        provider_name: lastLLMMeta.provider_name || '',
        model_name: lastLLMMeta.model_name || '',
        prompt_tokens: lastLLMMeta.prompt_tokens ?? 0,
        completion_tokens: lastLLMMeta.completion_tokens ?? 0,
        total_tokens: lastLLMMeta.total_tokens ?? 0,
      });
    } catch (logErr) {
      console.error('保存AI日志失败:', logErr);
    }

    return response;
  } catch (error: any) {
    // 记录失败的AI请求日志
    try {
      const { saveAIRequestLog } = await import('./db');
      await saveAIRequestLog({
        request_type: 'general',
        system_prompt: systemPrompt.slice(0, 500),
        user_prompt: userPrompt.slice(0, 500),
        response_summary: '',
        success: false,
        error_message: error.message || String(error),
        provider_name: lastLLMMeta.provider_name || '',
        model_name: lastLLMMeta.model_name || '',
      });
    } catch (logErr) {
      console.error('保存AI日志失败:', logErr);
    }

    throw error;
  }
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

  // 限制 sourceContext 长度，防止 prompt 过长
  const maxSourceLength = 2000;
  const truncatedSource = sourceContext.length > maxSourceLength
    ? sourceContext.slice(0, maxSourceLength) + '\n...(来源过多，已截断)'
    : sourceContext;

  return `你是 CostHub 物料成本洞察专家。当前时间：${currentTime}。请采用「${skill.name}」的成熟方法论，对物料给出可执行、可审计的结论。

## 方法论说明
${skill.description}
${skill.systemPrompt ? `

## ${skill.name}方法论详情（必须严格遵守）
${skill.systemPrompt}` : ''}

## 输出维度（必须按顺序完整返回）
${dimensions.map((dimension, index) => `${index + 1}. ${dimension}`).join('\n')}

## 数据时效性要求（最高优先级，必须严格遵守）
- **当前时间：${currentTime}**。分析只针对当前时点，任何结论必须基于时效内的信息
- **时效分级**：
  - 最近 3 个月内信息 = 有效（可用于当前判断）
  - 3-6 个月前信息 = 参考（标注"历史参考"）
  - 超过 6 个月的信息 = **过期**，只能作为历史背景，**严禁作为当前趋势的依据**
- **每条关键信息必须标注数据时间**（如"2026年6月数据"）；无法确定时间的信息标注"时间未知，时效性存疑"
- **严禁使用模糊时间词**："近期""最近""今年以来"等一律改为具体月份
- **旧数据不得外推**：禁止用过期数据推测当前趋势（如用 2025 年的价格判断 2026 年走势）
- **时效性影响置信度**：最新数据超过 3 个月时，置信度上限为中；超过 6 个月时，置信度上限为低
- 若提供的来源全部过期或与当前时间差距过大，明确输出"信号不明确"并在 summary 中说明原因

## 反幻觉硬约束（最高优先级，必须严格遵守）
- **只许用提供的来源信息**：所有价格、数字、事件、供应商名称必须来自"可用来源"章节；**严禁编造**来源中没有的数字或事实
- **严禁用训练知识补充具体数字**：模型记忆中可能有的旧价格/旧数据，**不得**当作当前行情使用；确需引用时标注"训练知识，非实时数据"
- **严禁编造来源**：source_url 只能使用提供的 URL，不得虚构链接；无来源支撑的内容写"公开信息不足"
- **区分事实与推测**：有来源支撑 = 事实（标注来源）；无来源 = 推测（必须标注"推测"）
- **不确定就说不确定**：信息不足时，方向写"信号不明确"、置信度写"低"，绝不强行给结论
- **输出前自检**：每个维度的每个数字，问自己"这个数字在提供的来源里出现过吗？"——没有就删掉

## 结论质量要求
- 基于公开信息，不得捏造价格、供应商或日期；证据不足时明确写”公开信息不足，需补充搜索”。
- 结论必须针对采购决策：说明风险、触发信号与建议动作，而非只复述资料。
- 每个维度给出一项证据强度：强 / 中 / 弱 / 未验证；仅当来源足够支撑时才能标”强”。
- 对每个维度尽量绑定最相关的一条来源（只能使用提供的来源 URL）；无来源时 source_url 留空。
- 至少给出 0-3 条关键事件。没有可独立验证的事件时返回空数组。

## 数字口径约束（最高优先级，必须严格遵守）
- **magnitude_min / magnitude_max 只表示该物料近期（近1-3个月）采购价格的变化幅度百分比**，严禁使用以下口径：
  - 市场规模 / 市场容量 / 产值及其增长率（如"市场规模达XX亿美元"、"年复合增长率CAGR"）
  - 某一时期累计涨幅（如"过去一年累计上涨XX%"）——只用近1-3个月的环比/近期价格变化
  - 个别企业财报、个别新闻中的单点涨幅
- **方向与幅度必须一致**：trend_direction=上涨 → 幅度为正；下降 → 幅度为负；震荡 → 幅度绝对值在0-5%之间（若价格稳定，magnitude_min/max 填 null 或 0）
- **幅度合理性上限**：电子元器件/原材料近1-3个月价格变化幅度一般不超过 ±30%；若搜索结果中出现超大幅度的数字，优先怀疑口径错误（市场规模/CAGR），不得直接采信
- 若无法确定近期价格变化幅度，magnitude_min/max 一律填 null，并在 magnitude_reference 说明"无法获取近期价格变化数据"

## 输出 JSON 格式示例（严格只输出 JSON，**总长度控制在3500字符内**）：
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
${truncatedSource || '无实时来源；必须如实说明分析基于模型训练知识，时效性有限。'}`;
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

  const result: TrendAnalysisResult = {
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

  // ====== 方向-幅度一致性校验 + 异常幅度拦截（模型不守口径时的兜底） ======
  const SANE_MAGNITUDE = 30; // 电子元器件/原材料近1-3月价格波动一般不超过±30%
  let { magnitude_min: mn, magnitude_max: mx } = result;
  const dir = result.trend_direction;

  // 1) 方向与幅度符号一致性
  const signOf = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  if (dir === '上涨' && mx != null && signOf(mx) < 0) { mn = mx = null; }
  if (dir === '下降' && mn != null && signOf(mn) > 0) { mn = mx = null; }

  // 2) 异常幅度拦截：超出±30%视为口径错误（市场规模/CAGR等），置空并标注
  const outOfRange = (v: number) => Math.abs(v) > SANE_MAGNITUDE;
  if ((mn != null && outOfRange(mn)) || (mx != null && outOfRange(mx))) {
    console.warn(`[normalizeStructuredResult] 异常幅度拦截: 方向=${dir}, 幅度=${mn}~${mx}（疑似市场规模/CAGR口径，已置空）`);
    mn = mx = null;
    result.magnitude_reference = (result.magnitude_reference ? result.magnitude_reference + '；' : '') + '已剔除异常口径数据（市场规模/CAGR等非价格涨幅）';
  }

  // 3) 震荡方向的幅度应是小幅（>5%视为方向判断不一致，置空幅度）
  if (dir === '震荡' && mn != null && Math.abs(mn) > 5) { mn = mx = null; }
  if (dir === '信号不明确') { mn = mx = null; }

  result.magnitude_min = mn;
  result.magnitude_max = mx;
  return result;
}

// 内置 Skill 模板（systemPrompt留空，实际使用时由buildStructuredAnalysisPrompt动态生成）
export const BUILTIN_SKILLS: SkillTemplate[] = [
  {
    id: 'price-trend',
    name: '价格趋势分析',
    description: '聚焦价格走势、涨跌因素、历史对比 — 价格驱动四因子框架',
    icon: '📈',
    systemPrompt: `### 分析步骤
1. **识别价格水平**：从来源中提取该物料当前市场价格水平（如"32寸LCD open cell 均价 ¥680"），注明时间点
2. **梳理四因子**：供给因子（产能/稼动率/库存）、需求因子（下游出货/备货周期）、成本因子（原材料/人工/运费传导）、金融与政策因子（汇率/关税/补贴）
3. **判断方向与幅度**：综合四因子给出近1-3个月价格方向与幅度；多因子方向冲突时，按影响权重加权判断，并在内容中说明冲突

### 证据要求
- 每个因子必须给出具体证据（数字/事件/来源），不能只写"供需平衡"
- 只有来源中出现明确的"价格上涨/下跌 X%"表述，幅度才可填具体数字；否则填 null
- 区分"报价"与"成交价"、"现货"与"合约价"，口径不同不得混用

### 判断规则
- 供给收缩 + 需求平稳 → 上涨
- 供给过剩 + 需求走弱 → 下降
- 多因子方向抵消 → 震荡
- 来源不足以判断 → 信号不明确，置信度降为低

### 时效性规则（专属）
- 价格判断**只认最近 3 个月内的价格数据**；3-6 个月的只能作为趋势背景
- 超过 6 个月的价格点**严禁**作为当前价格水平的依据（标注"历史价格"）
- 每个因子引用数据时必须注明"X年X月"，无时间信息的数据不得用于方向判断
- 价格数据冲突时（如不同来源价格不同），优先采信时间最新 + 口径一致的来源，并在内容中说明`,
    searchQueries: ['价格 走势 涨跌', '原材料 成本', '供需 库存', '政策 影响'],
    maxSearchRounds: 1,
    outputDimensions: ['供给因子', '需求因子', '成本因子', '金融与政策因子', '展望'],
  },
  {
    id: 'supply-chain',
    name: '供应链分析',
    description: '上游原料、生产工艺、关键供应商 — 供应链全景扫描',
    icon: '🏭',
    systemPrompt: `### 分析步骤
1. **上游原料**：该物料的上游原材料（如面板→玻璃基板/偏光片/驱动IC），上游价格或供应变化对物料成本的影响传导
2. **生产工艺**：关键工艺环节（如切割/贴合/组装）的产能瓶颈、良率水平、扩产/停产动态
3. **关键供应商**：主要供应商名单、产能份额、近期产能动态（扩产/减产/关厂/并购）
4. **物流与交期**：交期变化、物流成本、地区集中度风险
5. **风险点**：识别供应链脆弱环节（单一供应商、地区集中、材料瓶颈）

### 证据要求
- 供应商名称、产能数字必须来自来源，不得编造
- 区分"已确认事件"（如关厂公告）与"市场传闻"（如可能减产），后者需注明

### 判断规则
- 供应链风险结论应给出对采购的直接影响：交期延长 X 周 / 供应紧张 / 无风险
- 上游材料涨价传导到本物料的时滞约 1-3 个月，判断趋势时考虑传导期

### 时效性规则（专属）
- 供应商产能动态（扩产/减产/关厂）**必须注明公告或报道时间**；超过 6 个月的产能信息只能作为背景
- 区分"当前有效"（3 个月内）与"已过时"（超过 6 个月）的供应信息，过时信息不得作为"当前供应紧张/宽松"的依据
- 交期/物流信息时效更短：超过 3 个月的交期数据必须标注"可能已变化"
- 上游原料价格传导判断，必须基于**传导期内的价格数据**（近 1-3 个月），旧价格不构成当前传导依据`,
    searchQueries: ['供应商 产能', '原材料 来源', '生产 工艺', '物流 交期'],
    maxSearchRounds: 1,
    outputDimensions: ['上游原料', '生产工艺', '关键供应商', '物流与交期', '风险点'],
  },
  {
    id: 'competition',
    name: '竞争格局分析',
    description: '主要供应商、市场份额、替代方案 — 波特五力框架',
    icon: '⚔️',
    systemPrompt: `### 分析步骤（波特五力框架）
1. **供应商议价能力**：头部供应商集中度（CR3/CR5），供应商是否强势（技术壁垒/专利）
2. **买方议价能力**：采购方集中度、订单规模、替代选项多少
3. **行业内竞争强度**：竞争者数量、产能过剩程度、价格战迹象
4. **替代品威胁**：新材料/新技术方案（如国产替代、新工艺），替代成熟度与成本优势
5. **新进入者威胁**：新产能投产计划、跨界进入者

### 证据要求
- 市场份额数字（如"京东方市占 25%"）必须来自来源
- 替代方案必须说明成熟度（实验室/小批量/量产）与成本对比（如"国产替代成本低 20%"）

### 判断规则
- 竞争格局结论要落到采购端：该物料是"卖方市场"（供方强势，价格易涨）还是"买方市场"（买方强势，可压价）
- 格局变化对价格的影响：集中度提升 → 议价空间收窄；替代方案成熟 → 原物料价格承压

### 时效性规则（专属）
- 市场份额、集中度数据**必须注明统计时间**（如"2025年市占"）；超过一年的份额数据标注"历史份额，仅供参考"
- 格局动态（并购/扩产/退出）必须是 6 个月内的信息才可作为"当前格局变化"的依据
- 替代方案成熟度判断必须基于近期信息：量产状态超过 6 个月未更新的，标注"状态待确认"
- 竞争格局变化对价格的影响有时滞（通常 1-2 个季度），判断时注明预期生效时间`,
    searchQueries: ['供应商 市场份额 排名', '竞争格局 变化', '替代方案 替代物料', '行业动态 并购 扩产'],
    maxSearchRounds: 1,
    outputDimensions: ['供应商议价能力', '买方议价能力', '行业内竞争强度', '替代品威胁', '新进入者威胁'],
  },
  {
    id: 'deep-research',
    name: '综合深度研究',
    description: '多维度全面分析，适合关键物料决策 — 五看三定框架',
    icon: '🔬',
    systemPrompt: `### 分析步骤（五看三定框架）
**第一看：看行业/趋势** —— 判断物料所处行业周期位置
- 供需大周期：行业处于扩产期/收缩期/平衡期？产能新增与退出情况（在建产线、关厂公告）
- 价格长短期走势：近1-3月实际价格变化（必填口径），以及年初至今的阶段性变化（仅作背景，不作为幅度口径）
- 技术演进：该物料是否面临技术替代窗口（如新工艺、新材料路线）

**第二看：看市场/客户** —— 判断需求侧强弱
- 下游需求结构：该物料主要应用领域及各自占比（如显示面板→电视/显示器/笔记本）
- 需求趋势：下游出货量、备货周期、库存水位（渠道/品牌/工厂）
- 季节性与周期性：当前处于需求旺季/淡季？历史同期对比

**第三看：看竞争** —— 判断供给侧格局
- 供应商格局：头部厂商及份额（CR3/CR5）、产能集中度
- 竞争动态：扩产/减产/并购/关厂等结构性变化
- 替代方案：替代物料/技术的成熟度（实验室/小批量/量产）与成本差

**第四看：看自己** —— 判断对本企业的影响
- （无法获取内部数据时）评估行业共性影响：该物料在整机BOM中的成本占比等级（高/中/低敏感性）、采购模式（现货/长协）下的风险敞口
- 明确标注：此维度基于公开信息的推断，内部数据需结合企业实际

**第五看：看机会** —— 给出可操作的机会窗口
- 价格窗口：当前是否处于价格低位/高位，未来1-3个月变化方向
- 谈判筹码：供应商产能过剩/竞品压价/替代方案成熟等可借力因素
- 时间敏感度：建议动作的最迟时点（如"Q4 长协签约窗口"）

### 三定（汇总定论）
1. **定向**：综合五看，确定趋势方向（上涨/下降/震荡/信号不明确）——方向必须由多数维度的证据支持，冲突时说明采信理由
2. **定量**：给出近1-3个月价格变化幅度区间（无明确数据则 null，严禁用市场规模/CAGR口径）
3. **定策**：给出明确的采购策略建议（备料/锁价/观望/压价/分散供应），含触发条件与时机

### 证据要求（分级）
- **强证据**：官方公告、行业协会数据、权威媒体明确数字（标注日期与来源）
- **中证据**：多家媒体一致报道、分析师观点
- **弱证据**：单一来源、市场传闻、推测（必须标注"推测"）
- 每个维度至少 1 条证据支撑；证据不足的维度如实写"公开信息不足"，不得编造

### 置信度评分规则
- 高：≥4 个维度有强/中证据，且方向一致
- 中：≥3 个维度有证据，或存在部分冲突
- 低：证据零散或时效性差（>6个月）
- 五看结论冲突较大时，置信度自动降一档

### 输出约束
- summary 必须是一段连贯的采购结论（含方向+关键依据+建议动作），不是要点罗列
- suggested_action 必须具体可执行（含对象/时点/条件），禁止"持续关注""灵活应对"等空话
- 若整体证据不足，明确输出"信号不明确"，并列出最需要补充的信息点

### 时效性规则（专属）
- 五看的每一看，引用数据都必须标注时间；超过 6 个月的数据只能作为"历史背景"，不得支撑当前判断
- **跨年份数据必须标注年份**（如"2025年产能数据"），当前年份（${new Date().getFullYear()}）数据优先
- 机会窗口判断（第五看）时效性最强：只能用近 1-3 个月的信息判断"当前窗口"，旧信息不得用于判断"现在是否该动手"
- 汇总时明确标注：结论基于哪些时间点的数据，若最新数据超过 3 个月，在 summary 开头注明"数据时效有限"`,
    searchQueries: ['价格 走势 行情 最新', '产能 供应 需求 库存', '供应商 竞争 市场份额', '政策 法规 影响', '技术 趋势 替代'],
    maxSearchRounds: 2,
    outputDimensions: ['看行业/趋势', '看市场/客户', '看竞争', '看自己', '看机会'],
  },
  {
    id: 'swot',
    name: 'SWOT分析',
    description: '优势劣势机会威胁 — 经典战略分析工具',
    icon: '🎯',
    systemPrompt: `### 分析步骤
1. **优势(Strengths)**：该物料当前有利的供应/价格/质量因素（如供应充足、价格低位、供应商配合度高）
2. **劣势(Weaknesses)**：不利因素（如供应集中、价格高位、质量波动）
3. **机会(Opportunities)**：未来可把握的有利变化（如新供应商进入、产能释放、替代材料降价）
4. **威胁(Threats)**：未来风险（如涨价、断供、合规收紧、技术替代）

### 判断规则
- 每个条目必须是"可验证的事实或趋势"，注明时间与来源；猜测性内容标注"推测"
- 内外部交叉：机会/威胁 → 外部环境；优势/劣势 → 当前状态
- 结论：基于 SWOT 四象限给出采购策略倾向（积极备货/观望/压价/分散供应）
- 机会与威胁必须区分时间尺度（短期<3个月 / 中期3-12个月）

### 时效性规则（专属）
- 优势/劣势必须基于**当前（3个月内）状态**，旧优势可能已消失（如"供应充足"若已是半年前的信息则需标注）
- 机会必须标注"机会窗口"时间（如"Q3 窗口"），过期机会不得列为当前机会
- 威胁区分"已发生"（注明时间）与"潜在"（标注可能发生的时间窗）
- 超过 6 个月的条目一律标注"历史参考"，不得作为当前 S/W/O/T 的依据`,
    searchQueries: ['供应 稳定性', '价格 波动 风险', '新技术 替代', '供应商 变化'],
    maxSearchRounds: 1,
    outputDimensions: ['优势(Strengths)', '劣势(Weaknesses)', '机会(Opportunities)', '威胁(Threats)'],
  },
  {
    id: 'pest',
    name: 'PEST宏观分析',
    description: '政治经济社会技术 — 宏观环境扫描',
    icon: '🌍',
    systemPrompt: `### 分析步骤
1. **政治(Political)**：贸易政策、关税、出口管制、产业补贴、地缘政治（如对华关税、芯片管制）
2. **经济(Economic)**：汇率波动、通胀、行业景气度、下游需求周期
3. **社会(Social)**：消费趋势、环保要求、ESG 约束（如碳足迹要求）
4. **技术(Technological)**：技术迭代、新工艺、新材料替代对现有物料的影响

### 判断规则
- 每项宏观因素必须说明**对物料成本的传导路径**（如"关税上调 → 进口料成本+5%"），无传导路径的不列入
- 区分"已生效政策"与"提案/传闻"，后者标注不确定性
- 宏观因素 → 成本影响量级（无具体数字时用"轻微/中等/显著"）
- 结论：宏观环境对采购决策的影响是"支持锁价/支持观望/无显著影响"

### 时效性规则（专属）
- 政策类信息**必须注明生效/实施时间**（"2026年7月生效"）；未生效的标注"提案中/待生效"
- 已过时的政策（如已取消的关税）不得作为当前影响因素
- 汇率/宏观数据（通胀、利率）必须标注数据月份；超过 3 个月的经济数据标注"可能已变化"
- 技术类信息（新工艺/新材料）区分"已量产/试产/实验室"，并标注信息时间
- 宏观因素时效性判断优先级：政策生效时间 > 数据发布时间 > 报道时间`,
    searchQueries: ['政策 法规 贸易', '汇率 经济 影响', '环保 标准 要求', '技术 创新 趋势'],
    maxSearchRounds: 1,
    outputDimensions: ['政治(Political)', '经济(Economic)', '社会(Social)', '技术(Technological)'],
  },
  {
    id: 'risk',
    name: '风险评估',
    description: '识别、评估、应对采购风险 — 风险矩阵法',
    icon: '⚠️',
    systemPrompt: `### 分析步骤（风险矩阵法）
1. **识别风险**：供应中断（供应商倒闭/罢工/自然灾害）、价格波动（暴涨/暴跌）、质量合规（召回/认证失效/环保违规）
2. **评估概率与影响**：每个风险给出发生概率（高/中/低）与影响程度（高/中/低），组合为风险等级（高=概率高×影响高）
3. **制定应对**：
   - 高风险：立即行动（备货/双供/替代方案启动）
   - 中风险：监控+预案（设定触发信号）
   - 低风险：定期复查

### 证据要求
- 每个风险必须有事实依据（来源中的事件/数据），不凭空猜测
- 风险事件注明时间（已发生/正在发生/可能发生）

### 判断规则
- 输出每个风险项的风险等级与应对动作
- 结论给综合风险等级与首要应对措施

### 时效性规则（专属）
- 每个风险必须标注"已发生（日期）/正在发生/潜在"，**只评估当前及未来 3-6 个月的风险**
- 超过 6 个月前的风险事件（如旧的召回/停产）若已解决，不得列为当前风险；未解决的需注明"仍在持续"
- 风险概率判断只能基于近期（3 个月内）信息；旧的风险评估不构成当前概率依据
- 风险缓解措施的状态需注明时间（如"备选供应商 2026年Q2 完成认证"）
- 无近期风险信号时如实写"近期未发现显著风险信号"，不得为凑内容编造风险`,
    searchQueries: ['供应商 风险 倒闭', '价格 暴涨 原因', '质量 问题 召回', '断供 事件'],
    maxSearchRounds: 1,
    outputDimensions: ['供应中断风险', '价格波动风险', '质量合规风险', '应对策略'],
  },
  {
    id: 'tco',
    name: 'TCO全生命周期成本',
    description: '不只看采购价，算总拥有成本 — TCO模型',
    icon: '💰',
    systemPrompt: `### 分析步骤（TCO 模型）
1. **采购成本**：单价、价格趋势、采购批量影响
2. **使用成本**：良率影响、维护/更换频率、能耗、配套物料成本
3. **风险成本**：断供损失、涨价风险、质量问题带来的隐形成本
4. **综合评估**：加权比较不同方案的总拥有成本

### 判断规则
- 无法获取内部使用数据时，基于行业常识给出**定性**判断（如"该物料良率对整机成本影响大/小"），并注明"需结合内部数据验证"
- 不得编造具体使用成本数字；无数据时写"公开信息不足"
- 结论：该物料的成本敏感点（价格敏感/质量敏感/供应敏感）与降本方向建议
- 明确说明 TCO 视角与单纯价格视角的差异（如"价格低 5% 但良率损失可能抵消"）

### 时效性规则（专属）
- TCO 计算中的采购价格必须是**当前（近 1-3 个月）**价格，旧价格不得用于 TCO 对比
- 使用成本/维护成本数据注明时间；超过一年的 TCO 相关数据标注"历史参考"
- 风险成本（断供/涨价损失）基于当前风险水平评估，旧风险等级不适用
- 结论中注明"基于 X 月价格水平的 TCO 评估"`,
    searchQueries: ['使用 损耗 维护', '质量 问题 成本', '物流 仓储 费用'],
    maxSearchRounds: 1,
    outputDimensions: ['采购成本', '使用成本', '风险成本', '综合评估'],
  },
  {
    id: 'resilience',
    name: '供应链韧性分析',
    description: '评估供应链的抗风险能力 — 韧性三要素',
    icon: '🛡️',
    systemPrompt: `### 分析步骤（韧性三要素框架）
1. **冗余度(Redundancy)**：备选供应商数量、安全库存水平、双源/多源供应情况
2. **灵活性(Flexibility)**：交期弹性、产能调配能力、替代物料切换难度
3. **可见性(Visibility)**：供应链透明度、库存可见性、供应风险预警能力

### 判断规则
- 每项给出等级评估（高/中/低），并说明依据
- 冗余度低 + 灵活性低 = 高脆弱性：需重点提示
- 韧性评估要落到采购动作：是否需要增加备选供应商、提高安全库存、签订长协
- 无内部数据时基于行业公开信息评估，并注明"评估基于公开信息，内部数据需补充"
- 结论给综合韧性评分（高/中/低）与提升建议

### 时效性规则（专属）
- 韧性三要素的评估依据必须来自近期（6 个月内）信息；旧数据标注时间并降权
- 备选供应商/双源信息注明确认时间（如"2026年Q1 完成验证"）
- 交期弹性、库存可见性等是**动态指标**：超过 3 个月的信息标注"可能已变化"
- 历史中断事件（如 2024 年断供）只能作为背景参考，不得作为当前韧性等级的直接依据`,
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
  // 并行执行多个搜索查询（各查询相互独立，可同时发起）
  const settled = await Promise.allSettled(queries.map(q => searchWeb(q)));
  return settled.map(s => s.status === 'fulfilled' ? s.value : []);
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

// ====== DeepSeek 原生联网搜索（Responses API 的 web_search 工具，官方托管搜索） ======
// 检测 LLM 供应商是否为 DeepSeek（支持原生搜索）
export async function isDeepSeekNativeSearchAvailable(): Promise<boolean> {
  try {
    const { getApiProviders } = await import('./db');
    const all = await getApiProviders();
    const activeLLM = all.filter((p: any) => p.provider_type === 'llm' && p.api_key && p.is_active)
      .sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0))[0];
    if (!activeLLM) return false;
    const name = (activeLLM.provider_name || '').toLowerCase();
    const baseUrl = (activeLLM.base_url || '').toLowerCase();
    return name.includes('deepseek') || baseUrl.includes('deepseek');
  } catch { return false; }
}

// 读取"模型原生搜索"开关（settings 表 ai_native_search，默认开启）
export async function isNativeSearchEnabled(): Promise<boolean> {
  try {
    const { getDb } = await import('./db');
    const rows = await (await getDb()).select<any[]>('SELECT value FROM settings WHERE key=?', ['ai_native_search']);
    return rows.length === 0 || rows[0].value !== '0';
  } catch { return true; }
}

// 用 DeepSeek Responses API 执行一次"搜索+分析"（官方 web_search 工具）
// 返回：分析文本 + 搜索来源列表
async function deepSeekNativeSearch(
  llmConfig: { apiKey: string; baseUrl: string; model: string },
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; sources: SearchResult[] }> {
  // Responses API 端点：把 chat/completions 换成 responses
  const base = (llmConfig.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const responsesUrl = base.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '') + '/responses';

  const res = await rustPost(
    responsesUrl,
    { Authorization: `Bearer ${llmConfig.apiKey}`, 'Content-Type': 'application/json' },
    JSON.stringify({
      model: llmConfig.model,
      tools: [{ type: 'web_search' }],
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_output_tokens: 8000,
    })
  );

  if (!res.success) {
    throw new Error(`DeepSeek 原生搜索 HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }

  const data = JSON.parse(res.body);

  // 提取输出文本（Responses API 格式：output 数组中的 message.output_text）
  let text = '';
  const outputs: any[] = data.output || [];
  for (const o of outputs) {
    if (o.type === 'message' && o.content) {
      for (const c of o.content) {
        if (c.type === 'output_text') text += c.text || '';
      }
    }
  }
  if (!text) text = data.output_text || '';

  // 提取搜索来源（web_search_call 结果）
  const sources: SearchResult[] = [];
  for (const o of outputs) {
    if (o.type === 'web_search_call' && o.result) {
      const items: any[] = o.result.results || o.result.web_results || [];
      items.forEach((r: any) => {
        sources.push({
          title: r.title || '',
          url: r.url || '',
          snippet: r.snippet || r.content || r.summary || '',
        });
      });
    }
  }

  return { text, sources };
}

// Agent 搜索循环的返回结构
interface AgentSearchResult {
  trend_direction: string;
  confidence_level: string;
  magnitude_min: number | null;
  magnitude_max: number | null;
  magnitude_reference: string;
  summary: string;
  suggested_action: string;
  allSources: SearchResult[];
  searchRounds: number;
}

// 尝试用 DeepSeek 原生搜索完成洞察（成功返回结果，失败/不支持返回 null）
export async function tryDeepSeekNativeInsight(
  materialName: string,
  categoryType: string,
  skill: SkillTemplate,
): Promise<AgentSearchResult | null> {
  try {
    if (!(await isNativeSearchEnabled())) return null;
    const llmConfig = await resolveLLMConfig();
    if (!llmConfig) return null;
    const name = (llmConfig.provider || '').toLowerCase();
    const isDeepSeek = name.includes('deepseek') || (llmConfig.baseUrl || '').toLowerCase().includes('deepseek');
    if (!isDeepSeek) return null;
    // 判断是否走 Responses API（deepseek 官方 baseUrl 或含 v1 的官方端点）
    const baseUrl = (llmConfig.baseUrl || '').toLowerCase();
    if (!baseUrl.includes('deepseek')) return null;

    const systemPrompt = `你是 CostHub 物料成本洞察专家。请使用联网搜索工具获取最新信息，然后基于搜索结果分析物料市场趋势。
${skill.systemPrompt || ''}

## 输出要求（严格 JSON）
{"trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","magnitude_min":数字|null,"magnitude_max":数字|null,"magnitude_reference":"时间基准","summary":"采购结论（含关键依据）","suggested_action":"备料/锁价|观望|维持常规节奏"}

## 硬约束
- 只基于本次联网搜索获得的信息，严禁用训练知识补具体数字
- 幅度只表示近1-3个月价格变化，严禁市场规模/CAGR口径
- 信息不足时 direction 写"信号不明确"、confidence 写"低"
- 每条关键信息标注数据时间（如"2026年6月"）`;

    const userPrompt = `请分析物料「${materialName}」的市场成本趋势（${categoryType === '原材料映射' ? '原材料' : '电器件'}）。请先联网搜索最新行情，再给出结构化结论。`;

    const { text, sources } = await deepSeekNativeSearch(llmConfig, systemPrompt, userPrompt);

    // 解析 JSON
    let parsed: any;
    try {
      parsed = extractJSON(text);
      if (parsed._parse_error) throw new Error(parsed._parse_error);
    } catch (e: any) {
      console.warn('[DeepSeek原生搜索] 解析失败，退回标准流程:', e.message);
      return null;
    }

    const result: AgentSearchResult = {
      trend_direction: parsed.trend_direction || '信号不明确',
      confidence_level: parsed.confidence_level || '低',
      magnitude_min: parsed.magnitude_min ?? null,
      magnitude_max: parsed.magnitude_max ?? null,
      magnitude_reference: parsed.magnitude_reference || '',
      summary: parsed.summary || text.slice(0, 300),
      suggested_action: parsed.suggested_action || '观望',
      allSources: sources.length > 0 ? sources : [{ title: 'DeepSeek 原生联网搜索', url: '', snippet: '搜索来源' }],
      searchRounds: 1,
    };

    // 归一化校验（方向-幅度一致性、异常幅度拦截）
    const normalizeResult = (r: any) => {
      const SANE = 30;
      let mn = r.magnitude_min, mx = r.magnitude_max;
      const dir = r.trend_direction;
      const signOf = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
      if (dir === '上涨' && mx != null && signOf(mx) < 0) { mn = mx = null; }
      if (dir === '下降' && mn != null && signOf(mn) > 0) { mn = mx = null; }
      if ((mn != null && Math.abs(mn) > SANE) || (mx != null && Math.abs(mx) > SANE)) { mn = mx = null; }
      if (dir === '震荡' && mn != null && Math.abs(mn) > 5) { mn = mx = null; }
      if (dir === '信号不明确') { mn = mx = null; }
      r.magnitude_min = mn; r.magnitude_max = mx;
      return r;
    };
    return normalizeResult(result);
  } catch (e: any) {
    console.warn('[DeepSeek原生搜索] 调用失败，退回标准流程:', e.message);
    return null;
  }
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

  // ====== DeepSeek 原生联网搜索（官方 web_search 工具，无需第三方搜索 key） ======
  // 开启时优先使用：一轮调用完成"搜索+分析"，返回带真实来源
  if (await isNativeSearchEnabled()) {
    const native = await tryDeepSeekNativeInsight(materialName, categoryType, skill);
    if (native) {
      if (onProgress) onProgress('使用 DeepSeek 原生联网搜索...');
      // ⚠️ 审计修复（2026-08-16）：原生搜索路径曾在此提前 return，未写 ai_request_logs → 审计日志无记录
      try {
        const { saveAIRequestLog } = await import('./db');
        await saveAIRequestLog({
          request_type: 'trend_insight',
          material_name: materialName,
          system_prompt: (skill.systemPrompt || '').slice(0, 500),
          user_prompt: '分析物料: ' + materialName,
          response_summary: (native.summary || '').slice(0, 500),
          success: true,
          provider_name: 'DeepSeek 原生搜索',
          model_name: '',
          prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        });
      } catch (err) { console.error('保存AI日志失败:', err); }
      return native;
    }
  }

  // 记录AI请求日志
  const logRequestStart = async () => {
    try {
      const { saveAIRequestLog } = await import('./db');
      return await saveAIRequestLog({
        request_type: 'trend_insight',
        material_name: materialName,
        system_prompt: skill.systemPrompt.slice(0, 500),
        user_prompt: `分析物料: ${materialName}`,
        response_summary: '分析中...',
        success: true,
        provider_name: lastLLMMeta.provider_name || '',
        model_name: lastLLMMeta.model_name || '',
      });
    } catch (err) {
      console.error('保存AI日志失败:', err);
      return null;
    }
  };

  await logRequestStart();

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
  // 限制 sources 长度，防止 prompt 过长
  const maxSources = 8;
  const limitedSources = sources.slice(0, maxSources);

  const sourceContext = [
    `物料：${materialName}`,
    `已有初步摘要：${agentSummary || '无'}`,
    ...limitedSources.map((source, index) =>
      `[${index + 1}] 标题：${source.title.slice(0, 100)}\nURL：${source.url}\n摘要：${source.snippet.slice(0, 150)}`
    ),
  ].join('\n\n');


  try {
    const raw = await callLLM(
      '', '', '',
      buildStructuredAnalysisPrompt(skill, sourceContext),
      `请为「${materialName}」生成本次洞察的最终结构化结论。`
    );


    const parsed = extractJSON(raw);
    // 兜底对象（解析失败降级）必须显式失败，不能静默存库/展示
    if (parsed && parsed._parse_error) {
      console.error('[createStructuredInsight] LLM返回JSON解析失败:', parsed._parse_error);
      throw new Error(
        'LLM返回格式解析失败。可能原因：\n' +
        '1. 响应被截断（num_predict 不足）\n' +
        '2. LLM未按JSON格式返回\n' +
        '建议：重试或更换LLM供应商\n' +
        `原始错误: ${parsed._parse_error}`
      );
    }
    return normalizeStructuredResult(parsed, skill);
  } catch (e: any) {
    console.error('[createStructuredInsight] 错误详情:', e);

    // 提供更友好的错误信息
    if (e.message?.includes('Failed to read response')) {
      throw new Error(
        '生成结构化洞察时响应读取失败。可能原因：\n' +
        '1. 网络不稳定或连接中断\n' +
        '2. API响应超时（已设置120秒）\n' +
        '3. 响应体格式异常\n' +
        '建议：重试或检查网络连接'
      );
    }

    if (e.message?.includes('JSON解析失败') || e.message?.includes('parse')) {
      throw new Error(
        'LLM返回格式解析失败。可能原因：\n' +
        '1. LLM未按JSON格式返回\n' +
        '2. 响应被截断\n' +
        '建议：重试或更换LLM供应商\n' +
        `原始错误: ${e.message}`
      );
    }

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
    console.log('开始测试搜索连接...');
    const providers = await getActiveProviders();
    console.log('搜索供应商列表:', providers.search);

    // 只测试启用中的供应商；全部停用时明确报错（不再降级取第一个）
    const activeSearch = providers.search.find((p: any) => p.is_active);
    if (!activeSearch) {
      console.error('未找到启用的搜索供应商');
      return { success: false, message: '未配置启用的搜索 API Key', detail: '请先在设置页面添加并启用搜索供应商（当前所有搜索服务均已停用或未配置）' };
    }

    console.log('使用搜索供应商:', activeSearch.provider_name);
    const testQuery = '2026 铜价 上海有色网 LME copper price';
    let results: SearchResult[];

    console.log('发送搜索请求...');
    results = await searchWithProvider(activeSearch, testQuery);
    console.log('搜索返回结果数:', results.length);

    const relevantTerms = ['铜', 'copper', 'lme', '金属', '价格', 'commodity', '有色', '期货'];
    const relevantResults = results.filter(r => isRelevantSearchResult(r, relevantTerms));
    console.log('相关结果数:', relevantResults.length);

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
    console.error('搜索测试失败:', e);
    return { success: false, message: '搜索 API 连接失败', detail: e.message || String(e) || '未知错误' };
  }
}

/** 单独测试 LLM API 连接 */
export async function testLLMConnection(): Promise<TestResult> {
  try {
    console.log('开始测试LLM连接...');
    const providers = await getActiveProviders();
    console.log('LLM供应商列表:', providers.llm);

    const activeLLM = providers.llm.find((p: any) => p.is_active) || providers.llm[0];
    if (!activeLLM) {
      console.error('未找到活跃的LLM供应商');
      return { success: false, message: '未配置大模型 API Key', detail: '请先在设置页面添加并启用 LLM 供应商' };
    }

    console.log('使用LLM供应商:', activeLLM.provider_name, 'model:', activeLLM.model_name);
    console.log('Base URL:', activeLLM.base_url);

    const response = await callSingleLLMProvider(
      activeLLM,
      '你是一个助手。只回复"OK"两个字，不要回复其他内容。',
      '请回复OK',
      0,
      32,
    );

    
    const trimmed = response.trim();
    // 检查是否包含OK（不使用isReadableText，因为"OK"只有2个字符）
    if (!trimmed || !/\bOK\b/i.test(trimmed)) {
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
    console.error('LLM测试失败:', e);
    return { success: false, message: '大模型 API 连接失败', detail: e.message || String(e) || '未知错误' };
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
