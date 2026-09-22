/**
 * 物料趋势查询服务
 *
 * 安全约束（务必遵守）：
 * - 仅向外部 API 发送物件/原材料的通用名称
 * - 不读取、拼接、上传任何本地成本数据（采购价、供应商、BOM等）
 * - 所有 HTTP 请求通过 Rust 后端代理（绕过浏览器 CORS）
 */

import { invoke } from '@tauri-apps/api/core';
import { diagnoseSearchConfig, hasSearchConfig } from './apiConfig';
import { canonicalC2Body, c2BodyHash, c2SafeSystemPrompt, sanitizeC2Payload, type C2Payload } from './ai/c2Bridge';
import { approveSafeConnectionTest, findCloudApprovalForRequest, getCloudApproval, requestC2Approval, requestCloudConfirm, requestPublicModelConfirm, takeC2Approval, waitForCloudApproval } from './cloudConfirm';
import { validateCloudQueryArgs, validateNativeSearchArgs, validatePublicModelQueryArgs } from './ai/security';
import { cloudFailureReason, collectLocalText, extractJsonObject, localModelStatus } from './localAnalysis';
import { clearProviderFailure, markProviderFailure, providerCooldown } from './ai/providerHealth';
import { collectNativeSources, collectNativeText, describeNativeShape } from './ai/nativeSearchSources';
import { logLocalAICall } from './ollama';
import type { AiNetworkStatus, AiNetworkTraceSink, AiNetworkTransport } from './ai/networkTrace';
import type { CloudProvider } from './ai/cloudProvider';
import { CLOUD_SYSTEM_PROMPT, type CloudSafeContext } from './ai/cloudContext';
import { buildSearchRequest, inferSearchProviderKind, normalizeSearchEndpoint as normalizeSearchRequestEndpoint, searchRequestPreview, type SearchRequest } from './ai/searchRequest';
import { buildPublicSearchQuery, gatewayExpectedQuery, PUBLIC_PRICE_QUERY_QUESTION, normalizePublicQuery } from './ai/searchQuery';
import { findDimension } from './ai/skillDimensions';
import { gateSources, materialTerms, describeSourceQuality } from './ai/sourceQuality';

/** 最近一次 LLM 调用的元数据（provider/model/token），供 AI 请求日志记录使用 */
let lastLLMMeta: { provider_name?: string; model_name?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
let lastNativeSearchError = '';
export function getLastNativeSearchError() { return lastNativeSearchError; }
export function getLastLLMMeta() { return lastLLMMeta; }
export function setLastLLMMeta(m: Partial<typeof lastLLMMeta>) { lastLLMMeta = { ...lastLLMMeta, ...m }; }

// 从数据库加载活跃供应商；密钥始终留在 Rust 保险库，只返回配置状态。
async function getActiveProviders(): Promise<{ search: any[]; llm: any[] }> {
  try {
    const dbModule = await import('./db');
    if (Object.prototype.hasOwnProperty.call(dbModule, 'ensureConfiguredSearchActive')) {
      await (dbModule as any).ensureConfiguredSearchActive().catch(() => false);
    }
    const all = await dbModule.getApiProviders();
    const configured = await Promise.all(all.map(async (p: any) => {
      let credential_configured = Boolean(p.credential_configured);
      if (p.credential_configured !== true) {
        try { credential_configured = await invoke<boolean>('provider_secret_status', { providerId: Number(p.id) }); }
        catch { /* 保留设置页已经读到的状态，避免瞬时读取失败被伪装成未配置 */ }
      }
      return { ...p, credential_configured };
    }));
        return {
      search: configured.filter((p: any) => p.provider_type === 'search' && p.credential_configured && p.is_active).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)),
      llm: configured.filter((p: any) => p.provider_type === 'llm' && p.credential_configured && p.is_active).sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)),
    };
  } catch {
    return { search: [], llm: [] };
  }
}

function normalizeSearchEndpoint(provider: any): string {
  return normalizeSearchRequestEndpoint(String(provider?.provider_name || ''), String(provider?.base_url || ''));
}

// 获取活跃的 LLM 配置（仅从数据库供应商，getActiveProviders 已过滤 is_active）
async function resolveLLMConfig(): Promise<{ apiKey: string; providerId: number; provider: string; providerName: string; model: string; baseUrl: string } | null> {
    const providers = await getActiveProviders();
  if (providers.llm.length > 0) {
    const active = providers.llm[0];
        return {
      apiKey: '',
      providerId: Number(active.id),
      provider: active.provider_name?.toLowerCase().includes('openai') || active.provider_name?.toLowerCase().includes('硅基') ? 'openai' : 'deepseek',
      providerName: String(active.provider_name || ''),
      model: active.model_name || 'deepseek-chat',
      baseUrl: active.base_url || 'https://api.deepseek.com/v1/chat/completions',
    };
  }
      return null;
}

// 获取活跃的搜索配置（仅从数据库供应商，getActiveProviders 已过滤 is_active）
async function resolveSearchConfig(): Promise<{ apiKey: string; providerId: number; provider: string; baseUrl: string } | null> {
    const providers = await getActiveProviders();
  if (providers.search.length > 0) {
    const active = providers.search[0];
    const name = active.provider_name?.toLowerCase() || '';
    return { apiKey: '', providerId: Number(active.id), provider: name.includes('bing') ? 'bing' : (name.includes('tavily') ? 'tavily' : 'serper'), baseUrl: normalizeSearchEndpoint(active) };
  }
      return null;
}

export async function getSearchApprovalEndpoint(): Promise<string> {
  return (await resolveSearchConfig())?.baseUrl || '';
}

async function throwIfSearchProviderNeedsAttention(): Promise<void> {
  const diagnostic = await diagnoseSearchConfig();
  if (diagnostic.inactiveConfigured.length) {
    throw new Error('检测到已配置的搜索 API（' + diagnostic.inactiveConfigured.join('、') + '）但未启用；请在 设置 -> AI 服务 中启用该供应商后重试。');
  }
  if (diagnostic.missingCredential.length) {
    throw new Error('搜索供应商（' + diagnostic.missingCredential.join('、') + '）已启用，但本机 API Key 不可读；请在 设置 -> AI 服务 中重新录入 API Key 后重试。');
  }
}

const CLOUD_SAFE_MAIN_SCOPE = {
  material: '公开上下文',
  category: '公开模型上下文',
        question: '模型原生联网搜索公开物料行情',
  scopeLevel: 'C1_PUBLIC_CONTEXT' as const,
};

export async function getLLMApprovalEndpoint(): Promise<string> {
  const config = await resolveLLMConfig();
  return config ? normalizeChatCompletionUrl(config.baseUrl) : '';
}

export async function getConfiguredLLMModel(): Promise<string> {
  return (await resolveLLMConfig())?.model || '';
}

function cloudSafeMessages(context: CloudSafeContext): Array<{ role: string; content: string }> {
  return [
    { role: 'system', content: context.systemPrompt },
    ...context.workingState.map(item => ({ role: 'system', content: `公开工作状态：${item.text}` })),
    ...context.messages.map(message => ({ role: message.role, content: message.content })),
    ...(context.retrieved.length ? [{ role: 'system', content: `公开检索摘要：\n${context.retrieved.map(item => item.content).join('\n')}` }] : []),
  ];
}

/** The approval preview and the actual provider request share this serializer. */
export function createCloudSafeRequestBody(model: string, context: CloudSafeContext): string {
  return JSON.stringify({ model, messages: cloudSafeMessages(context) });
}

export async function requestCloudSafeMainModelApproval(previewJson: string, binding: { sessionId?: string; runId?: string; messageId?: string; requestId?: string; payloadVersion?: number; sourceType?: 'user_message' | 'retrieval' | 'tool_request' | 'background_task'; localAudit?: { status: 'not_run' | 'pass' | 'blocked' | 'unknown'; matches: string[] } } = {}): Promise<boolean> {
  const requestUrl = await getLLMApprovalEndpoint();
  if (!requestUrl || !previewJson || previewJson.length > 200_000) return false;
  return requestCloudConfirm({ ...CLOUD_SAFE_MAIN_SCOPE, previewJson, payloadHash: await c2BodyHash(previewJson), requestUrl, requestMethod: 'POST', ...binding });
}

/** Provider for the optional main-model CloudSafe route. The caller supplies only the rebuilt public projection. */
export async function createCloudSafeProvider(previewJson: string, requestId = ''): Promise<CloudProvider> {
    const providers = await getActiveProviders();
  const provider = providers.llm[0];
  if (!provider) throw new Error('未配置可用的云端 LLM 供应商');
  const requestUrl = normalizeChatCompletionUrl(provider.base_url);
  // 用户可在审批卡内修改候选副本；按 requestId 取回最终批准版本，并让它与实际发送体逐字节一致。
  const approval = getCloudApproval(CLOUD_SAFE_MAIN_SCOPE.material, CLOUD_SAFE_MAIN_SCOPE.category, requestUrl, '', requestId);
  if (!approval) throw new Error('云端主模型尚未获得本轮公开上下文授权');
  const approvedPreview = approval.previewJson || previewJson;
  let approvedMessages: Array<{ role: string; content: string }> | undefined;
  try {
    const parsed = JSON.parse(approvedPreview) as { messages?: Array<{ role?: unknown; content?: unknown }> };
    if (Array.isArray(parsed?.messages)) {
      approvedMessages = parsed.messages
        .filter(message => message && typeof message.role === 'string')
        .map(message => ({ role: String(message.role), content: String(message.content ?? '') }));
    }
  } catch { /* 审批前已经校验过 JSON；旧载荷缺字段时退回本地重新构建 */ }
  return async ({ model, context, signal }) => {
    let transport: AiNetworkTransport = 'unknown';
    const messages = approvedMessages || cloudSafeMessages(context);
    try {
      const text = await callSingleLLMProviderMessages({ ...provider, model_name: model || provider.model_name }, messages, 0.3, 4000, approval, event => {
        transport = event.transport || (event.transported ? 'confirmed' : transport);
      }, signal);
      const finalTransport = transport as AiNetworkTransport;
      return { text, transport: finalTransport, transported: finalTransport === 'confirmed' };
    } catch (error) {
      const finalTransport = transport as AiNetworkTransport;
      (error as any).transport = finalTransport;
      (error as any).transported = finalTransport === 'confirmed';
      throw error;
    }
  };
}

// 带重试的 LLM 调用（按优先级降级）
async function callLLMWithFallback(
  systemPrompt: string,
  userPrompt: string,
  temperature: number = 0.3,
  maxTokens: number = 2000,
  approvalTopic?: { material?: string; category?: string }
): Promise<string> {
    const providers = await getActiveProviders();
  const llmProviders = providers.llm;

  if (llmProviders.length === 0) throw new Error('未配置任何 LLM 供应商，请在设置页面添加并启用');

  let lastError: Error | null = null;
  let attempted = 0;
  let coolingReason = '';
  for (const provider of llmProviders) {
    const cooldown = providerCooldown(String(provider.provider_name || ''));
    if (cooldown.cooling) { coolingReason = cooldown.reason || ''; continue; }
    attempted += 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callSingleLLMProvider(provider, systemPrompt, userPrompt, temperature, maxTokens, undefined, undefined, undefined, approvalTopic);
      } catch (e: any) {
        if (e?.name === 'CloudApprovalError' || e?.name === 'CloudApprovalUnavailableError') throw e;
        lastError = e;
        if (/HTTP (?:0|4\d\d)/.test(e?.message || '')) break;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); // 重试前等1秒
      }
    }
    // 当前供应商失败，尝试下一个
    if (llmProviders.indexOf(provider) < llmProviders.length - 1) {
          }
  }
  if (attempted === 0 && coolingReason) throw new Error(coolingReason);
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
  approvedScope?: ApprovedCloudScope,
  networkTrace?: AiNetworkTraceSink,
  signal?: AbortSignal,
  approvalTopic?: { material?: string; category?: string },
): Promise<string> {
  const messages = [] as Array<{ role: string; content: string }>;
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });
  return callSingleLLMProviderMessages(provider, messages, temperature, maxTokens, approvedScope, networkTrace, signal, approvalTopic);
}

async function callSingleLLMProviderMessages(
  provider: any,
  messages: Array<{ role: string; content: string }>,
  temperature = 0.3,
  maxTokens = 2000,
  approvedScope?: ApprovedCloudScope,
  networkTrace?: AiNetworkTraceSink,
  signal?: AbortSignal,
  approvalTopic?: { material?: string; category?: string },
): Promise<string> {
  const baseUrl = normalizeChatCompletionUrl(provider.base_url);

  if (!approvedScope) {
    // 搜索主题票不能授权模型消息；展示并绑定本次实际正文和供应商端点。
    messages = [{ role: 'system', content: CLOUD_SYSTEM_PROMPT }, ...messages.flatMap(message => {
      const chunks: Array<{ role: string; content: string }> = [];
      for (let offset = 0; offset < message.content.length; offset += 3000) {
        chunks.push({ role: message.role, content: cloudSafePublicText(message.content.slice(offset, offset + 3000)) });
      }
      return chunks;
    })];
    const previewJson = JSON.stringify({ model: provider.model_name || 'deepseek-chat', messages });
    approvedScope = await waitForCloudApproval({
      ...CLOUD_SAFE_MAIN_SCOPE, previewJson, payloadHash: await c2BodyHash(previewJson),
      requestUrl: baseUrl, requestMethod: 'POST', sourceType: 'tool_request',
      requirementKind: 'insight', requirementTitle: '物料洞察 · 公开模型分析',
      // 同一轮洞察：搜索主题刚批准过就自动放行这一步（正文是本应用公开投影代码生成的，无新增本地数据）。
      topicMaterial: approvalTopic?.material, topicCategory: approvalTopic?.category, publicProjection: true,
      }, signal);
  }

  // 增强的错误处理：捕获更多细节
  let res;
  try {
    res = await rustPost(
      baseUrl,
    { 'Content-Type': 'application/json' },
      JSON.stringify(approvedScope?.scopeLevel === 'C1_PUBLIC_CONTEXT'
        ? { model: provider.model_name || 'deepseek-chat', messages }
        : { model: provider.model_name || 'deepseek-chat', messages, temperature, max_tokens: maxTokens }),
      approvedScope,
      Number(provider.id),
      { mode: 'bearer' },
      networkTrace,
      signal,
    );
  } catch (e: any) {
    // 网络层错误
    markProviderFailure(String(provider.provider_name || ''), `网络请求失败: ${e.message || String(e)}`);
    throw new Error(`${provider.provider_name} 网络请求失败: ${e.message || String(e)}`);
  }

  if (!res.success) {
    // HTTP 错误：额度/鉴权类会进入冷却，避免同一主题反复申请审批又反复失败。
    const errorDetail = res.body.slice(0, 500).replace(/\n/g, ' ');
    markProviderFailure(String(provider.provider_name || ''), `HTTP ${res.status}: ${errorDetail}`);
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
  // 调用成功：清除该供应商的冷却记录。
  clearProviderFailure(String(provider.provider_name || ''));

  // ====== Token 用量记录（用于设置页统计外部模型消耗） ======
  try {
    const usage = data.usage || {};
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const totalTokens = Number(usage.total_tokens) || (promptTokens + completionTokens);
    if (totalTokens > 0) {
      const { saveAIUsageLog } = await import('./db');
      await saveAIUsageLog({
        request_channel: 'cloud',
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
  transport?: AiNetworkTransport;
}

type SecretPlacement = { mode: 'bearer' | 'header' | 'query' | 'body'; name?: string };

async function rustPost(url: string, headers: Record<string, string>, body?: string, approvedScope?: ApprovedCloudScope, providerId?: number, secretPlacement?: SecretPlacement, networkTrace?: AiNetworkTraceSink, signal?: AbortSignal): Promise<HttpResponse> {
  return invokeWithRequestLog('POST', url, headers, body || null, approvedScope, providerId, secretPlacement, networkTrace, signal);
}

async function rustGet(url: string, headers: Record<string, string>, approvedScope?: ApprovedCloudScope, providerId?: number, secretPlacement?: SecretPlacement, networkTrace?: AiNetworkTraceSink, signal?: AbortSignal): Promise<HttpResponse> {
  return invokeWithRequestLog('GET', url, headers, null, approvedScope, providerId, secretPlacement, networkTrace, signal);
}

function redactUrl(url: string): string {
  return url.replace(/([?&](?:api_?key|key|token)=)[^&]+/gi, '$1***');
}

// ⚠️ 外发内容安全摘要（2026-08-18）：从请求体提取白名单字段（物料名/品类/问题/搜索词）供审计展示，
// 其余一律不记录（防 API key/本地数据意外入日志）；URL 域名展示，query 参数脱敏
function safePayloadSummary(body: string | null): string {
  if (!body) return '';
  try {
    const obj = JSON.parse(body);
    const pick = (keys: string[]) => {
      const out: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) out.push(v.trim().slice(0, 60));
      }
      return out;
    };
    const fields = pick(['material_name', 'material', 'category', 'question', 'query', 'name']);
    return fields.join(' / ').slice(0, 160);
  } catch {
    // 非 JSON（GET 无 body）：不记录内容
    return '';
  }
}

/**
 * 洞察外发时使用的"公开问题"。
 *
 * ⚠️ 2026-09-21（用户实测"还是显示公开信息不足"的根因修复）：
 * 网关对 C1 检索请求做的是**严格相等**绑定——`body.q` 必须恰好等于「已批准物料名 + 空格 + 这个字符串」
 * （Rust `validate_public_query_binding`，src-tauri/src/lib.rs:2678）。所以**关键词必须放在这里**，
 * 而不是在发请求时往查询词后面拼。曾经在 buildPublicSearchQuery 里追加关键词 → 网关拦截
 * 「查询词超出已批准的公开主题范围」→ 0 来源 → 全部维度退化成"公开信息不足"。
 *
 * 这个字符串同时会显示在审批卡的"公开问题"里，用户看到的就是关键词本身，信息透明。
 */
export const PUBLIC_TREND_QUESTION = PUBLIC_PRICE_QUERY_QUESTION;
type ApprovedCloudScope = { material: string; category: string; question?: string; scopeLevel?: 'C1' | 'C1_PUBLIC_MODEL' | 'C1_PUBLIC_CONTEXT' | 'C1_NATIVE_SEARCH' | 'C2'; grantId?: number; payloadHash?: string; expiresAt?: string; requestUrl?: string; requestMethod?: string; previewJson?: string; fullRequestBinding?: boolean };

function invokeAbortable<T>(request: Promise<T>, signal?: AbortSignal, abortRequest?: () => void): Promise<T> {
  if (!signal) return request;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      abortRequest?.();
      finish(() => reject(new Error('云端请求已取消')));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

async function invokeWithRequestLog(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body: string | null, approvedScope?: ApprovedCloudScope, providerId?: number, secretPlacement?: SecretPlacement, networkTrace?: AiNetworkTraceSink, signal?: AbortSignal): Promise<HttpResponse> {
  const started = Date.now();
  let result: HttpResponse;
  const requestId = crypto.randomUUID();
  const target = (() => { try { return new URL(url).hostname; } catch { return undefined; } })();
  let cloudAttempted = false;
  let cloudTraceStatus: AiNetworkStatus | undefined;
  let lastTransport: AiNetworkTransport | undefined;
  let cancelRequest: Promise<unknown> | undefined;
  let cancelRequestFailed = false;
  let egressAudit: { grantId: number; target: string; payloadHash: string; fields: string[] } | undefined;
  let egressAuditRecorded = false;
  const cancelProviderRequest = () => {
    cancelRequest = invoke('cancel_provider_cloud_http_request', { requestId })
      .then(() => undefined)
      .catch(() => { cancelRequestFailed = true; });
  };
  const traceCloud = (status: AiNetworkStatus, outbound: boolean, error?: string, auditRecorded?: boolean, transport?: AiNetworkTransport) => {
    cloudTraceStatus = status;
    if (transport) lastTransport = transport;
    networkTrace?.({ type: 'network_request', channel: 'cloud_tool', route: 'cloud', provider: providerId ? `provider:${providerId}` : 'cloud', requestId, status, outbound, ...(transport ? { transport, transported: transport === 'confirmed' } : {}), target, ...(auditRecorded === undefined ? {} : { auditRecorded }), ...(error ? { error: error.slice(0, 400) } : {}) });
  };
  try {
    if (signal?.aborted) {
      traceCloud('cancelled', false, '云端请求在调用前已取消', false, 'not_sent');
      throw new Error('云端搜索已拦截：实际请求体与已批准的完整载荷不一致，请重新发起审批');
    }
    const parsed = new URL(url);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase());
    if (loopback) {
      result = await invokeAbortable(invoke<HttpResponse>(method === 'POST' ? 'http_post' : 'http_get', { request: { url, headers, body } }), signal);
    } else {
      // 只有搜索请求才允许按已审批主题自动关联；模型请求必须显式绑定 C1_PUBLIC_CONTEXT 或 C2，
      // 防止一张 C1 搜索票被误当成任意云端模型调用的通行证。
      let isPublicSearch = parsed.pathname.includes('/search');
      if (!isPublicSearch && body) {
        try {
          const requestBody = JSON.parse(body);
          isPublicSearch = !!requestBody && typeof requestBody === 'object' && Object.keys(requestBody).some(key => ['query', 'q', 'search', 'keyword', 'text'].includes(key));
  } catch { /* 审批前已经校验过 JSON；旧载荷缺字段时退回本地重新构建 */ }
      }
      const scope = approvedScope || (isPublicSearch ? findCloudApprovalForRequest(url + '\n' + (body || '')) : null);
      if (!scope) {
        traceCloud('blocked', false, '授权记录不存在、已过期或主题哈希不匹配');
      throw new Error('云端搜索已拦截：实际请求体与已批准的完整载荷不一致，请重新发起审批');
      }
      const { approvalPayloadHash, getValidApprovalGrant, saveEgressAudit } = await import('./db/ai');
      const payloadHash = scope.scopeLevel === 'C2' || scope.scopeLevel === 'C1_PUBLIC_CONTEXT'
        ? (scope.payloadHash || await c2BodyHash(body || ''))
        : (scope.fullRequestBinding && scope.payloadHash ? scope.payloadHash : await approvalPayloadHash(scope));
      // 不直接信任内存中的 grantId/payloadHash：授权可能来自旧版本或已过期，统一回库按当前哈希复核。
      const grant = await getValidApprovalGrant({
        material: scope.material,
        category: scope.category || '',
        question: scope.question || '',
        payloadHash,
        scopeLevel: scope.scopeLevel || 'C1',
        requestUrl: scope.requestUrl,
      });
      if (!grant || grant.payload_hash !== payloadHash) {
        traceCloud('blocked', false, '授权记录不存在、已过期或主题哈希不匹配');
      throw new Error('云端搜索已拦截：实际请求体与已批准的完整载荷不一致，请重新发起审批');
      }
      const approval = {
        material: scope.material,
        category: scope.category || '',
        question: scope.question || '',
        reviewed: true,
        scope_level: scope.scopeLevel || 'C1',
        grant_id: Number(grant.id),
        payload_hash: grant.payload_hash,
        expires_at: grant.expires_at,
        request_url: scope.requestUrl || '',
        request_method: scope.requestMethod || method,
      };
      if (!providerId || !secretPlacement) {
        traceCloud('blocked', false, '授权记录不存在、已过期或主题哈希不匹配');
      throw new Error('云端搜索已拦截：实际请求体与已批准的完整载荷不一致，请重新发起审批');
      }
      let fields: string[] = [];
      try {
        const keys = scope.scopeLevel === 'C2' ? ['scope_level', 'domain', 'features', 'question'] : ['material', 'material_name', 'category', 'question', 'query', 'name'];
        const parsedBody = JSON.parse(body || '{}');
        fields = scope.scopeLevel === 'C2' ? keys : Object.keys(parsedBody).filter(key => keys.includes(key));
      } catch { }
      egressAudit = { grantId: Number(grant.id), target: new URL(url).hostname, payloadHash, fields };
      cloudAttempted = true;
      traceCloud('attempted', true, undefined, undefined, 'unknown');
      const providerRequest = invoke<HttpResponse>('provider_cloud_http_request', { request: { provider_id: providerId, url, method, headers, body, secret_mode: secretPlacement.mode, secret_name: secretPlacement.name || '', approval, request_id: requestId } });
      // 若取消通知与后端 future 终止之间存在竞态，保留迟到结果的审计记录，不把它静默丢掉。
      if (signal) void providerRequest.then(async lateResult => {
        if (!signal.aborted || !egressAudit) return;
        try {
          const { saveEgressAudit } = await import('./db/ai');
          await saveEgressAudit({ ...egressAudit, status: lateResult.success ? 'success' : 'failed', errorMessage: lateResult.success ? '' : lateResult.body });
        } catch { }
      }).catch(() => {});
      result = await invokeAbortable(providerRequest, signal, cancelProviderRequest);
      let auditRecorded = false;
      try {
        await saveEgressAudit({ ...egressAudit!, status: result.success ? 'success' : 'failed', errorMessage: result.success ? '' : result.body });
        auditRecorded = true;
      } catch { }
      egressAuditRecorded = auditRecorded;
      const transport = result.status > 0 ? 'confirmed' : 'unknown';
      traceCloud(result.success ? 'succeeded' : 'failed', true, result.success ? undefined : result.body, auditRecorded, transport);
      result.transport = transport;
    }
      } catch (e: any) {
    if (cancelRequest) await cancelRequest;
    const errorMessage = signal?.aborted && cancelRequestFailed
      ? '已停止等待；取消通知失败，后台请求可能仍在继续'
      : e?.message || String(e);
    result = { status: 0, body: e?.message || String(e), success: false, transport: cloudAttempted ? 'unknown' : (lastTransport || 'not_sent') };
    result.body = errorMessage;
    if (cloudAttempted && egressAudit) {
      try {
          const { saveEgressAudit } = await import('./db/ai');
        await saveEgressAudit({ ...egressAudit, status: signal?.aborted ? 'cancelled' : 'failed', errorMessage });
        egressAuditRecorded = true;
      } catch { }
    }
    if (cloudTraceStatus === 'attempted') traceCloud(signal?.aborted ? 'cancelled' : 'failed', true, result.body, egressAuditRecorded, 'unknown');
    else if (!cloudTraceStatus && !['localhost', '127.0.0.1', '::1'].includes((target || '').replace(/^\[|\]$/g, '').toLowerCase())) traceCloud(signal?.aborted ? 'cancelled' : 'blocked', false, result.body, undefined, signal?.aborted ? 'not_sent' : 'not_sent');
  }
  try {
    const { logOutboundRequest } = await import('./db');
    await logOutboundRequest({
      method,
      url: redactUrl(url),
      status_code: result.status,
      response_time_ms: Date.now() - started,
      error_message: result.success ? '' : result.body.slice(0, 500),
      payload_summary: safePayloadSummary(body),
    });
  } catch { }
  return result;
}

/** C2：将抽象等级特征组成标准 Chat 请求，审批通过后只发送这一份固定请求体。 */
export async function runC2AbstractAnalysis(input: C2Payload, networkTrace?: AiNetworkTraceSink): Promise<string> {
  const checked = sanitizeC2Payload(input);
  if (!checked.ok) throw new Error(checked.reason);
  const config = await resolveLLMConfig();
  if (!config) throw new Error('LLM API Key 未配置');
  const payload = checked.payload;
  const request = {
    ...payload,
    model: config.model,
    // 构建完整的 messages 列表
    messages: [
      { role: 'system' as const, content: c2SafeSystemPrompt() },
      { role: 'user' as const, content: JSON.stringify({ scope_level: 'C2', domain: payload.domain, features: payload.features, question: payload.question }) },
    ],
  };
  const body = canonicalC2Body(request);
  const requestUrl = normalizeChatCompletionUrl(config.baseUrl);
  if (!await requestC2Approval({ ...payload, previewJson: body, requestUrl })) {
    throw new Error('C2 抽象分析已进入待确认队列；请核对脱敏请求后重新执行');
  }
  const approval = takeC2Approval({ ...payload, previewJson: body, requestUrl });
  if (!approval) throw new Error('C2 单次审批已失效，请重新发起');
  const response = await invokeWithRequestLog('POST', requestUrl, {
    'Content-Type': 'application/json',
  }, body, approval, config.providerId, { mode: 'bearer' }, networkTrace);
  if (!response.success) throw new Error(`C2 云端分析 HTTP ${response.status}: ${response.body.slice(0, 300)}`);
  try {
    const data = JSON.parse(response.body);
    return data.choices?.[0]?.message?.content || data.output_text || response.body.slice(0, 2000);
  } catch {
    return response.body.slice(0, 2000);
  }
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

async function searchSerper(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustPost(
    request.url,
    { 'Content-Type': 'application/json' },
    request.body ?? undefined,
    approvedScope, providerId, { mode: 'header', name: 'X-API-KEY' }, networkTrace
  );
  if (!res.success) throw new Error(`Serper API 返回错误 (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.organic || []).map((r: any) => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
  }));
}

async function searchBing(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustGet(request.url, {}, approvedScope, providerId, { mode: 'header', name: 'Ocp-Apim-Subscription-Key' }, networkTrace);
  if (!res.success) throw new Error(`Bing API 返回错误 (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.webPages?.value || []).map((r: any) => ({
    title: r.name || '',
    url: r.url || '',
    snippet: r.snippet || '',
  }));
}

async function searchBrave(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustGet(request.url, { Accept: 'application/json' }, approvedScope, providerId, { mode: 'header', name: 'X-Subscription-Token' }, networkTrace);
  if (!res.success) throw new Error(`Brave Search HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.web?.results || []).map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' }));
}

async function searchBocha(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustPost(request.url, { 'Content-Type': 'application/json' }, request.body ?? undefined, approvedScope, providerId, { mode: 'bearer' }, networkTrace);
  if (!res.success) throw new Error(`博查搜索 HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  const values = data.data?.webPages?.value || data.webPages?.value || [];
  return values.map((r: any) => ({ title: r.name || r.title || '', url: r.url || '', snippet: r.summary || r.snippet || '' }));
}

async function searchSearchApi(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustGet(request.url, {}, approvedScope, providerId, { mode: 'query', name: 'api_key' }, networkTrace);
  if (!res.success) throw new Error(`SearchApi.io HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.organic_results || []).slice(0, 8).map((r: any) => ({ title: r.title || '', url: r.link || '', snippet: r.snippet || '' }));
}

async function searchExa(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustPost(request.url, { 'Content-Type': 'application/json' }, request.body ?? undefined, approvedScope, providerId, { mode: 'header', name: 'x-api-key' }, networkTrace);
  if (!res.success) throw new Error(`Exa Search HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  const data = JSON.parse(res.body);
  return (data.results || []).map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: r.text || r.highlights?.[0] || '' }));
}

async function searchWithProvider(provider: any, query: string, approvedScope?: ApprovedCloudScope, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const name = String(provider?.provider_name || '');
  const baseUrl = normalizeSearchRequestEndpoint(name, String(provider?.base_url || ''));
  const kind = inferSearchProviderKind(name, baseUrl);
  if (!baseUrl) throw new Error(`搜索供应商「${name || '未命名'}」缺少 Base URL`);
  const request = buildSearchRequest(kind, baseUrl, query);
  if (approvedScope?.fullRequestBinding && approvedScope.previewJson) {
    const actual = searchRequestPreview(request);
    if (actual !== approvedScope.previewJson) {
      throw new Error('云端搜索已拦截：实际请求体与已批准的完整载荷不一致，请重新发起审批');
    }
  }
    let results: SearchResult[];
  if (kind === 'tavily') results = await searchTavily(request, approvedScope, Number(provider.id), networkTrace);
  else if (kind === 'brave') results = await searchBrave(request, approvedScope, Number(provider.id), networkTrace);
  else if (kind === 'bocha') results = await searchBocha(request, approvedScope, Number(provider.id), networkTrace);
  else if (kind === 'bing') results = await searchBing(request, approvedScope, Number(provider.id), networkTrace);
  else if (kind === 'searchapi') results = await searchSearchApi(request, approvedScope, Number(provider.id), networkTrace);
  else if (kind === 'exa') results = await searchExa(request, approvedScope, Number(provider.id), networkTrace);
  else if (kind === 'serper') results = await searchSerper(request, approvedScope, Number(provider.id), networkTrace);
  else throw new Error(`不支持的搜索供应商「${provider.provider_name}」，请从预置模板选择或检查 Base URL`);
  return sanitizeSearchResults(results);
}

/** 搜索失败是否属于"重试也没用"的确定性拦截（网关拦截 / 审批失效 / 缺授权）。 */
export function isDeterministicCloudBlock(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return /云端请求已拦截|超出已批准|缺少与批准主题绑定|授权|未获批准|载荷不一致|纯本地模式|敏感审查未通过/.test(message);
}

/** 搜索公开网页信息（多供应商降级） */
export async function searchWeb(query: string, approvedScope?: ApprovedCloudScope, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
    const providers = await getActiveProviders();
  const searchProviders = providers.search;

  if (searchProviders.length === 0) throw new Error('搜索 API Key 未配置，请先在设置页面配置搜索服务');

  let lastError: Error | null = null;
  for (const provider of searchProviders) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await searchWithProvider(provider, query, approvedScope, networkTrace);
      } catch (e: any) {
        lastError = e;
        // ⚠️ 2026-09-21：网关拦截/审批失效这类失败是**确定性**的，重试一次只是白等一秒再失败一次
        //（实测 outbound_request_logs 里同一条拦截记录出现两次）。直接冒泡，把原因交给上层展示。
        if (isDeterministicCloudBlock(e)) throw e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw new Error(`所有搜索供应商均调用失败${lastError ? `。最后一个错误: ${(lastError as any).message || lastError}` : '（无具体错误）'}`);
}

/** 公开型号查询只走公开搜索结果，不把型号查询混入普通物料趋势授权。 */
export async function searchPublicModel(material: string, question = '公开规格、参数与兼容信息'): Promise<SearchResult[]> {
  const checked = validatePublicModelQueryArgs({ material, category: '公开型号', question });
  if (!checked.ok || !checked.clean) throw new Error(checked.reason || '公开型号查询未通过安全校验');
  const config = await resolveSearchConfig();
  if (!config) throw new Error('搜索 API Key 未配置，请先在设置页面配置搜索服务');
  if (!await requestPublicModelConfirm({ material: checked.clean.material, question: checked.clean.question, requestUrl: config.baseUrl })) {
      throw new Error('云端搜索已拦截：实际请求体与已批准的完整载荷不一致，请重新发起审批');
  }
  if (!getCloudApproval(checked.clean.material, '公开型号', config.baseUrl)) throw new Error('公开型号查询授权已失效，请重新确认');
  return searchWeb(`${checked.clean.material} ${checked.clean.question}`, getCloudApproval(checked.clean.material, '公开型号', config.baseUrl) || undefined);
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
          suggested_action: '重试',
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
  /** 结论来源：native-search=云端原生联网 / cloud=云端搜索分析 / local-knowledge=本地模型知识分析（未联网）*/
  source?: 'native-search' | 'cloud' | 'local-knowledge';
  /** 结论来源说明（例如"云端额度不足，已改用本地模型"），UI 直接展示。 */
  source_note?: string;
  magnitude_min?: number | null;
  magnitude_max?: number | null;
  magnitude_reference?: string;
  summary: string;
  suggested_action: string;
  /** v6: 结论摘要中的决策字段，供物料洞察页直接呈现。 */
  drivers?: { label: string; text: string; direction?: string; evidenceIds?: number[] }[];
  opportunities?: { label: string; text: string; evidenceIds?: number[] }[];
  risks?: { label: string; text: string; evidenceIds?: number[] }[];
  actions?: { label: string; text: string; evidenceIds?: number[] }[];
  project_impacts?: { project_id?: number | null; project_name?: string; value?: number | null; baseline?: number | null; target?: number | null; unit?: string; as_of?: string }[];
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
  userPrompt: string,
  approvalTopic?: { material?: string; category?: string }
): Promise<string> {
  // max_tokens 8000：多维度结构化 JSON 输出（5维度+关键事件+充分度评估）4000 易截断
  return callLLMWithFallback(systemPrompt, userPrompt, 0.3, 8000, approvalTopic);
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
        confidence_level: parsed.confidence_level || '中',
        magnitude_min: parsed.magnitude_min ?? null,
        magnitude_max: parsed.magnitude_max ?? null,
        magnitude_reference: parsed.magnitude_reference || '',
    summary: parsed.summary || '公开信息不足，建议补充搜索后再判断。',
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
  // 两次都失败"，抛异常让上层感知"
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
        request_channel: 'cloud',
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
        request_channel: 'cloud',
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
async function callLLMChat(_provider: string, _apiKey: string, _model: string, messages: ChatMessage[], networkTrace?: AiNetworkTraceSink, approvalTopic?: { material?: string; category?: string }): Promise<string> {
    const providers = await getActiveProviders();
  const llmProviders = providers.llm;
  if (llmProviders.length === 0) throw new Error('未配置任何 LLM 供应商，请在设置页面添加并启用');

  let lastError: Error | null = null;
  let attempted = 0;
  let coolingReason = '';
  for (const provider of llmProviders) {
    const cooldown = providerCooldown(String(provider.provider_name || ''));
    if (cooldown.cooling) { coolingReason = cooldown.reason || ''; continue; }
    attempted += 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callSingleLLMProviderMessages(provider, messages, 0.5, 4000, undefined, networkTrace, undefined, approvalTopic);
      } catch (e: any) { if (e?.name === 'CloudApprovalError' || e?.name === 'CloudApprovalUnavailableError') throw e; lastError = e; if (/HTTP (?:0|4\d\d)/.test(e?.message || '')) break; if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); }
    }
  }
  if (attempted === 0 && coolingReason) throw new Error(coolingReason);
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
  if (!hasSearch) await throwIfSearchProviderNeedsAttention();

  // 无搜索 API 时，LLM 使用自身知识做分析
  if (!hasSearch) {
    const analysis = await callLLM(
      '', '', '',
      `你是物料分析助手。当前时间 ${new Date().getFullYear()}年${new Date().getMonth() + 1}月。基于你的知识回答用户问题。必须标注"基于 LLM 训练知识，未实时搜索"。`,
      `物料近 ${materialName}\n问题：${specificQuestion}\n\n请诚实回答，信息不足时明确说明。`
    );
        return {
      searchResults: [{ title: 'LLM 知识库（未使用搜索引擎）', url: '', snippet: '建议配置搜索 API 获取实时数据' }],
      analysis,
    };
  }

  // 构建更精准的搜索关键词
  const { requestCloudConfirm, getCloudApproval } = await import('./cloudConfirm');
  const safeQuestion = PUBLIC_TREND_QUESTION;
  const endpoint = await getSearchApprovalEndpoint();
  if (!await requestCloudConfirm({ material: materialName, category: _categoryType, question: safeQuestion, requestUrl: endpoint, requirementKind: 'insight', requirementTitle: '补充搜索 · ' + materialName })) {
    throw new Error('补充搜索已进入待确认队列，请先确认公开主题');
  }
  const scope = getCloudApproval(materialName, _categoryType, endpoint);
  if (!scope) throw new Error('补充搜索授权已失效，请重新确认');
  const query = `${materialName} ${safeQuestion}`;
  const results = await searchWeb(query, scope);

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
async function searchTavily(request: SearchRequest, approvedScope?: ApprovedCloudScope, providerId?: number, networkTrace?: AiNetworkTraceSink): Promise<SearchResult[]> {
  const res = await rustPost(
    request.url,
    { 'Content-Type': 'application/json' },
    request.body ?? undefined,
    approvedScope, providerId, { mode: 'body', name: 'api_key' }, networkTrace
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
    return `${materialName} 原材料 价格 市场行情 ${dateStr} 最新`;
}

// ====== 可配置的分析 Skills ======

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string,
  searchQueries: string[]; // 预置搜索关键词模板
  maxSearchRounds: number;
  outputDimensions?: string[];
}

const EVIDENCE_LEVELS = ['强', '中', '弱', '未验证'];

function cloudSafePublicText(value: string): string {
  return value
    .replace(/\bproject_code\b/gi, 'business_object_id')
    .replace(/\bsupplier_name\b/gi, 'public_supplier_label')
    .replace(/\bbom_cost\b/gi, 'public_material_cost')
    .replace(/\bmarket_price\b/gi, 'public_market_value')
    .replace(/\bpart_model\b/gi, 'public_part_label')
    .replace(/项目代号/g, '业务对象')
    .replace(/供应商报价/g, '公开市场报价')
    .replace(/目标成本|内部成本|我司成本/g, '企业内部数据')
    .replace(/\bBOM\b/gi, '整机物料结构');
}

function buildStructuredAnalysisPrompt(skill: SkillTemplate, sourceContext: string) {
  const dimensions = skill.outputDimensions || ['核心结论', '证据与依据', '展望'];
  const now = new Date();
  const currentTime = `${now.getFullYear()}年${now.getMonth() + 1}月`;

  // 限制 sourceContext 长度，防止 prompt 过长
  const maxSourceLength = 2000;
  const truncatedSource = cloudSafePublicText(sourceContext.length > maxSourceLength
    ? sourceContext.slice(0, maxSourceLength) + '\n...(来源过多，已截断)'
    : sourceContext);

  return `你是 CostHub 物料成本洞察专家。当前时间：${currentTime}。请采用「${skill.name}」的成熟方法论，对物料给出可执行、可审计的结论。

## 方法论说明
${cloudSafePublicText(skill.description)}
${skill.systemPrompt ? `

## ${skill.name}方法论详情（必须严格遵守）
${cloudSafePublicText(skill.systemPrompt)}` : ''}

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
- **严禁编造来源**：source_url 只能使用提供的 URL，不得虚构链接；无来源支撑的内容写"公开信息不足：【缺什么】"（必须点明缺什么，不要只写四个字）
- **区分事实与推测**：有来源支撑 = 事实（标注来源）；无来源 = 推测（必须标注"推测"）
- **不确定就说不确定**：信息不足时，方向写"信号不明确"、置信度写"低"，绝不强行给结论；但**维度内容仍要写清"缺什么、建议查什么"**，不要用一句占位话术交差
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
  "trend_direction": "上涨|下降|震荡|信号不明确",
  "confidence_level": "高|中|低",
  "magnitude_min": null,
  "magnitude_max": null,
  "magnitude_reference": "时间基准说明（不超过30字）",
  "summary": "一句话采购结论（不超过80字）",
  "suggested_action": "备料/锁价|观望|维持常规节奏",
  "dimensions": [
    {"dimension_type": "${dimensions[0]}", "content": "简洁结论（不超过120字）", "evidence_strength": "中", "source_title": "来源标题", "source_url": "https://..."}
    ${dimensions.slice(1).map(d => `,{"dimension_type": "${d}", "content": "简洁结论（不超过120字）", "evidence_strength": "中", "source_title": "", "source_url": ""}`).join('')}
  ],
  "key_events": [
    {"event_date": "YYYY-MM-DD", "event_description": "事件描述（不超过60字）", "impact_direction": "利多上涨|利多下跌|中性", "source_title": "", "source_url": ""}
  ],
  "info_sufficiency": {"sufficient": true, "missing_dimensions": [], "reason": "说明（不超过40字）"}
}

**关键要求**：
1. 必须输出完整JSON，确保最后的}闭合；键名和字符串必须使用**英文半角双引号 "**（不要用中文引号 “ ”）
2. dimensions数组必须包含${dimensions.length}项，顺序与上述维度列表一致
3. 每个维度content严格控制在120字内，避免超长
4. key_events最多3项
5. ⚠️ **每个维度都必须写出有信息量的结论，不允许只写"公开信息不足"四个字**（用户反馈：收到五个"公开信息不足"等于什么都没得到）。按以下优先级作答，并遵守反幻觉约束（来源里没有的数字绝不编造）：
   ① 来源里有该维度的事实 → 直接用来源事实回答（标注来源序号与数据时间）
   ② 来源里没有该维度的直接数据、但有可类比的公开信息 → 给出**间接判断**，并写明"间接推断，依据是…"
   ③ 确实什么都得不到 → 写"公开信息不足：【具体缺什么】；建议：【下一步该查什么/该问谁】"——必须写出缺什么和建议，禁止只写占位话术

## 可用来源
${truncatedSource || '无实时来源；必须如实说明分析基于模型训练知识，时效性有限。'}`;
}

function normalizeStructuredResult(parsed: any, skill: SkillTemplate): TrendAnalysisResult {
  const dimensions = skill.outputDimensions || ['核心结论', '证据与依据', '展望'];
  const resultDimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
  // ⚠️ 2026-09-21：维度匹配改为**容错匹配 + 位置兜底 + 绝不丢模型内容**。
  // 旧实现是完全相等匹配，本地模型把「供给因子」写成「供给面」「1. 供给因子」「供给因子：」就匹配不上，
  // 于是模型写好的内容被整段替换成"公开信息不足，暂无法形成可靠结论。"——用户看到的就是"公开信息不足"。
  const normalizedDimensions = dimensions.map((dimension_type, dimension_order) => {
    const matched = findDimension(resultDimensions, dimension_type, dimension_order);
    const content = String(matched?.content ?? '').trim();
    return {
      dimension_type,
      dimension_order,
      content: content || '模型未返回该维度的内容（已如实标注，未编造）',
      evidence_strength: EVIDENCE_LEVELS.includes(String(matched?.evidence_strength ?? '')) ? String(matched?.evidence_strength) : '未验证',
      source_title: matched?.source_title || '',
      source_url: matched?.source_url || '',
    };
  });
  // 模型多给的维度（名字不在 Skill 清单里的）也保留下来，不要在入库时丢掉
  const extraDimensions = resultDimensions
    .filter((item: any) => item && String(item?.content ?? '').trim())
    .filter((item: any) => !dimensions.some(name => findDimension([item], name) !== undefined))
    .map((item: any, index: number) => ({
      dimension_type: String(item?.dimension_type || `补充维度 ${index + 1}`),
      dimension_order: dimensions.length + index,
      content: String(item.content).trim(),
      evidence_strength: EVIDENCE_LEVELS.includes(item?.evidence_strength) ? item.evidence_strength : '未验证',
      source_title: item?.source_title || '',
      source_url: item?.source_url || '',
    }));

  const result: TrendAnalysisResult = {
        trend_direction: parsed.trend_direction || '信号不明确',
        confidence_level: parsed.confidence_level || '中',
        magnitude_min: parsed.magnitude_min ?? null,
        magnitude_max: parsed.magnitude_max ?? null,
        magnitude_reference: parsed.magnitude_reference || '',
    summary: parsed.summary || '本节没有形成可靠判断：模型未返回结论摘要（不是"分析完成"，请重试或换模型）',
        suggested_action: parsed.suggested_action || '观望',
    dimensions: [...normalizedDimensions, ...extraDimensions],
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
- **跨年份数据必须标注年份**（如"2025年产能数据"），当前年份（\${new Date().getFullYear()}）数据优先
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
    systemPrompt: ``,
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

/**
 * 执行一次已批准的公开检索。
 * ⚠️ 2026-09-21：**不再吞掉失败**——旧实现用 Promise.allSettled 把错误变成空数组，
 * 于是"网关把请求拦了"和"搜索确实没结果"在上层完全一样，用户只看到一句"公开信息不足"，
 * 根本不知道是审批/绑定出了问题（实测就是这样排查了整整一轮）。现在把原因回传给调用方展示。
 */
async function executeSearchRounds(queries: string[], approvedScope: ApprovedCloudScope, networkTrace?: AiNetworkTraceSink): Promise<{ batches: SearchResult[][]; query: string; error?: string }> {
  // 查询词由审批范围重建；模型可以提出检索意图，但不能把任意文本带入已批准请求。
  // ⚠️ 查询词必须恰好是「物料名 + 空格 + 已批准问题」（Rust 网关严格相等校验），
  // 所以这里用 buildPublicSearchQuery（= 同一公式），**绝不追加任何关键词**。
  void queries;
  const safeQuery = buildPublicSearchQuery(approvedScope.material, approvedScope.question || PUBLIC_TREND_QUESTION);
  // 发请求前自检：如果算出来的查询词与网关期望值不一致，就是在做必然被拦的请求——当场报清楚，不要浪费一次审批。
  const expected = gatewayExpectedQuery(approvedScope.material, approvedScope.question || PUBLIC_TREND_QUESTION);
  if (normalizePublicQuery(safeQuery) !== expected) {
    return { batches: [], query: safeQuery, error: `本地自检失败：查询词「${safeQuery}」与网关期望的「${expected}」不一致，未发起请求` };
  }
  try {
    const results = await searchWeb(safeQuery, approvedScope, networkTrace);
    return { batches: [results], query: safeQuery };
  } catch (error: any) {
    return { batches: [], query: safeQuery, error: String(error?.message || error).slice(0, 300) };
  }
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

// 用 DeepSeek Responses API 执行一次"搜索+分析"（官方 web_search 工具）
// 检测 LLM 供应商是否为 DeepSeek（支持原生搜索）
export async function isDeepSeekNativeSearchAvailable(): Promise<boolean> {
  try {
    const activeLLM = (await getActiveProviders()).llm[0];
    if (!activeLLM) return false;
    const name = (activeLLM.provider_name || '').toLowerCase();
    const baseUrl = (activeLLM.base_url || '').toLowerCase();
    return name.includes('deepseek') || baseUrl.includes('deepseek');
  } catch { return false; }
}

// 读取"模型原生搜索"开关（settings 键 ai_native_search，默认开启）
export async function isNativeSearchEnabled(): Promise<boolean> {
  try {
    const { getDb } = await import('./db');
    const rows = await (await getDb()).select<any[]>('SELECT value FROM settings WHERE key=?', ['ai_native_search']);
    return rows.length === 0 || rows[0].value !== '0';
  } catch { return false; }
}

function buildDeepSeekResponsesUrl(baseUrl: string): string {
  const base = (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  return base.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '') + '/responses';
}

function buildDeepSeekNativeBody(
  llmConfig: { model: string },
  systemPrompt: string,
  userPrompt: string,
): string {
  return JSON.stringify({
    model: llmConfig.model,
    tools: [{ type: 'web_search' }],
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_output_tokens: 8000,
  });
}

// 用 DeepSeek Responses API 执行一次"搜索+分析"（官方 web_search 工具）
// 返回：分析文本 + 搜索来源列表
async function deepSeekNativeSearch(
  llmConfig: { apiKey: string; providerId: number; baseUrl: string; model: string; providerName?: string },
  systemPrompt: string,
  userPrompt: string,
  approvedScope?: ApprovedCloudScope,
  networkTrace?: AiNetworkTraceSink,
  bodyOverride?: string,
): Promise<{ text: string; sources: SearchResult[] }> {
    const responsesUrl = buildDeepSeekResponsesUrl(llmConfig.baseUrl);
  const bodyText = bodyOverride || buildDeepSeekNativeBody(llmConfig, systemPrompt, userPrompt);
  console.info('[洞察诊断] 原生搜索请求', { url: responsesUrl, model: llmConfig.model, bodyLength: bodyText.length });
  const res = await rustPost(
    responsesUrl,
    { 'Content-Type': 'application/json' },
    bodyText,
      approvedScope,
    llmConfig.providerId,
      { mode: 'bearer' },
      networkTrace,
  );

  if (!res.success) {
    console.error('[洞察诊断] 原生搜索 HTTP 失败', { status: res.status, bodyPreview: res.body.slice(0, 240) });
    markProviderFailure(String(llmConfig.providerName || llmConfig.baseUrl || ''), `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    throw new Error(`DeepSeek 原生搜索 HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  console.info('[洞察诊断] 原生搜索 HTTP 成功', { status: res.status, bodyLength: res.body.length, transport: res.transport || 'unknown' });

  const data = JSON.parse(res.body);

  // 文本与来源都走通用遍历（DeepSeek/OpenAI 的引用是嵌套 url_citation，旧实现取不到 → 来源数 0 → 空壳结论）
  const text = collectNativeText(data);

  if (!text.trim()) {
    console.error('[洞察诊断] 原生搜索响应无可解析文本', { shape: describeNativeShape(data) });
    throw new Error('DeepSeek 原生搜索未返回可解析文本（响应结构：' + describeNativeShape(data) + '）');
  }

  const sources = collectNativeSources(data);
  console.info('[洞察诊断] 原生搜索解析结果', { textLength: text.length, sourceCount: sources.length, hasWebSearch: JSON.stringify(data).includes('web_search') });
  return { text, sources };
}

// Agent 搜索循环的返回结构
interface AgentSearchResult {
  trend_direction: string;
  confidence_level: string;
  magnitude_min?: number | null;
  magnitude_max?: number | null;
  magnitude_reference?: string;
  summary: string;
  suggested_action: string;
  allSources: SearchResult[];
  searchRounds: number;
  /** 结论来源：native-search=云端原生联网搜索 / cloud=云端搜索+分析 / local-knowledge=本地模型知识分析（未联网）*/
  source?: 'native-search' | 'cloud' | 'local-knowledge';
  /** 实际发给搜索 API 的检索关键词（审计/排障用：旧实现把常量句子当关键词，是召回质量崩坏的根因）。 */
  searchQuery?: string;
  /** 来源质量闸门结论（剔除了多少垃圾来源 / 是否全部弱相关），直接展示给用户。 */
  sourceQuality?: string;
}

// 尝试用 DeepSeek 原生搜索完成洞察（成功返回结果，失败/不支持返回 null）
export async function tryDeepSeekNativeInsight(
  materialName: string,
  categoryType: string,
  skill: SkillTemplate,
  approvedScope?: ApprovedCloudScope,
  networkTrace?: AiNetworkTraceSink,
): Promise<AgentSearchResult | null> {
  try {
    lastNativeSearchError = '';
    if (!(await isNativeSearchEnabled())) return null;
    const llmConfig = await resolveLLMConfig();
    if (!llmConfig) return null;
    // 供应商处于冷却期（额度不足/鉴权失败）：不再申请审批，直接让上层走第三方搜索或本地兜底。
    const cooldown = providerCooldown(String(llmConfig.providerName || llmConfig.provider || ''));
    if (cooldown.cooling) {
      lastNativeSearchError = cooldown.reason || '云端供应商暂不可用';
      console.info('[洞察诊断] 原生搜索跳过：供应商处于冷却期', { provider: llmConfig.providerName, reason: lastNativeSearchError });
      return null;
    }
    const name = (llmConfig.provider || '').toLowerCase();
    const isDeepSeek = name.includes('deepseek') || (llmConfig.baseUrl || '').toLowerCase().includes('deepseek');
    if (!isDeepSeek) return null;
    // 判断是否走 Responses API（deepseek 官方 baseUrl 或含 v1 的官方端点）
    const baseUrl = (llmConfig.baseUrl || '').toLowerCase();
    if (!baseUrl.includes('deepseek')) return null;

    const systemPrompt = `你是 CostHub 物料成本洞察专家。请使用联网搜索工具获取最新信息，然后基于搜索结果分析物料市场趋势。
${cloudSafePublicText(skill.systemPrompt || '')}

## 输出要求（严格 JSON）
{"trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","magnitude_min":数字|null,"magnitude_max":数字|null,"magnitude_reference":"时间基准","summary":"采购结论（含关键依据）","suggested_action":"备料/锁价|观望|维持常规节奏"}

## 硬约束
- 只基于本次联网搜索获得的信息，严禁用训练知识补具体数字
- 幅度只表示近1-3个月价格变化，严禁市场规模/CAGR口径
- 信息不足时 direction 写"信号不明确"、confidence 写"低"
- 每条关键信息标注数据时间（如"2026年6月"）`;

    const userPrompt = `请分析物料「${materialName}」的市场成本趋势（${categoryType === '原材料映射' ? '原材料' : '电器件'}）。请先联网搜索最新行情，再给出结构化结论。`;
    const responsesUrl = buildDeepSeekResponsesUrl(llmConfig.baseUrl);
    const requestBody = approvedScope?.previewJson || buildDeepSeekNativeBody(llmConfig, systemPrompt, userPrompt);
    let effectiveScope = approvedScope;
    if (!effectiveScope) {
      console.info('[洞察诊断] 原生搜索等待用户审批', { url: responsesUrl, bodyLength: requestBody.length, material: materialName });
      effectiveScope = await waitForCloudApproval({
        material: materialName,
        category: categoryType,
        question: '模型原生联网搜索公开物料行情',
        scopeLevel: 'C1_NATIVE_SEARCH',
        previewJson: requestBody,
        requestUrl: responsesUrl,
        requestMethod: 'POST',
        sourceType: 'tool_request',
        requirementKind: 'insight',
        requirementTitle: '模型原生联网搜索 · ' + materialName,
      });
    }

    if (effectiveScope) console.info('[洞察诊断] 原生搜索审批已放行', { grantId: (effectiveScope as any).grantId, requestUrl: effectiveScope.requestUrl || responsesUrl });
    // 网络抖动（公司代理/弱网）常见：首次失败自动重试一次，再失败交外层兜底切换标准流程
    let native;
    try {
      native = await deepSeekNativeSearch(llmConfig, systemPrompt, userPrompt, effectiveScope, networkTrace, effectiveScope.previewJson || requestBody);
    } catch (firstErr) {
      const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (/云端请求已拦截|授权|审批/.test(message)) throw firstErr;
      console.warn('[洞察诊断] 原生搜索首次调用失败，准备重试', { message: message.slice(0, 200) });
      console.info('[原生搜索] 首次调用未成功，自动重试一次...');
      native = await deepSeekNativeSearch(llmConfig, systemPrompt, userPrompt, effectiveScope, networkTrace, effectiveScope.previewJson || requestBody);
    }
    const { text, sources } = native;
    // 来源质量闸门：原生搜索的引用同样要过（垃圾站/无关页一律不能进证据列表）。
    const nativeGated = gateSources(sources, materialName, { limit: 8 });
    const nativeQuality = describeSourceQuality(nativeGated, materialTerms(materialName));
    if (nativeGated.dropped.length > 0 || nativeGated.weak > 0) {
      console.warn('[洞察诊断] 原生搜索来源质量闸门', { material: materialName, raw: sources.length, kept: nativeGated.kept.length, dropped: nativeGated.dropped.length, weak: nativeGated.weak, note: nativeQuality });
    }

    // 解析 JSON
    let parsed: any;
    try {
      parsed = extractJSON(text);
      if (parsed._parse_error) throw new Error(parsed._parse_error);
      } catch (e: any) {
      lastNativeSearchError = '返回内容无法解析为结构化 JSON';
      console.error('[洞察诊断] 原生搜索 JSON 解析失败', { message: String(e?.message || e).slice(0, 200), textPreview: text.slice(0, 200) });
      console.info('[原生搜索] 返回内容无法解析，已自动切换标准搜索流程');
      return null;
    }

    const result: AgentSearchResult = {
        trend_direction: parsed.trend_direction || '信号不明确',
        confidence_level: parsed.confidence_level || '中',
        magnitude_min: parsed.magnitude_min ?? null,
        magnitude_max: parsed.magnitude_max ?? null,
        magnitude_reference: parsed.magnitude_reference || '',
      summary: parsed.summary || text.slice(0, 300),
        suggested_action: parsed.suggested_action || '观望',
      allSources: nativeGated.kept.length > 0 ? nativeGated.kept : [{ title: 'DeepSeek 原生联网搜索', url: '', snippet: '搜索来源' }],
      searchRounds: 1,
      source: 'native-search' as const,
      searchQuery: 'DeepSeek 原生联网搜索（模型自带 web_search）',
      sourceQuality: nativeQuality,
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
    if (['CloudApprovalError', 'CloudApprovalValidationError'].includes(String(e?.name || ''))) throw e;
    lastNativeSearchError = String(e?.message || e).slice(0, 240);
    console.error('[洞察诊断] 原生搜索最终失败', { message: (e?.message || String(e)).slice(0, 300) });
    console.info('[原生搜索] 调用未成功（' + (e?.message || '').slice(0, 100) + '），已自动切换标准搜索流程');
      return null;
  }
}

/**
 * Agent 搜索循环（对外的唯一入口，2026-09-21 起带本地兜底）
 *
 * 云端不可用（未配置供应商 / 额度不足 402 / Key 失效 401 / 网关拒绝 / 解析失败 / 搜索 API 缺失）时，
 * 自动改用本机模型基于自身公开知识给结论——绝不再让整条洞察链路直接失败（用户反馈："洞察还是失败，这次要彻底解决"）。
 * 唯一不兜底的情况：用户自己拒绝了云端发送（取消/纯本地模式）——那是明确的用户决定，不能偷偷换通道。
 */
export async function agentSearchLoop(
  materialName: string,
  categoryType: string,
  skillId?: string,
  onProgress?: (msg: string) => void,
  networkTrace?: AiNetworkTraceSink,
): Promise<AgentSearchResult> {
  try {
    return await agentSearchLoopCloud(materialName, categoryType, skillId, onProgress, networkTrace);
  } catch (error: any) {
    if (isUserStop(error)) throw error;
    return await localKnowledgeInsight(materialName, categoryType, skillId, error, onProgress);
  }
}

/** 用户明确的拒绝/取消，以及"必须重新审批"的确定性失败：不降级、不换通道。 */
function isUserStop(error: any): boolean {
  const name = String(error?.name || '');
  if (['CloudApprovalError', 'CloudApprovalValidationError', 'CloudApprovalUnavailableError'].includes(name)) return true;
  const message = String(error?.message || error || '');
  return /已取消本次云端发送|未获批准|云端请求已取消|本轮已跳过|纯本地模式|用户取消/.test(message);
}

/**
 * 本地模型知识分析：不联网、不外发任何内容，结论明确标注来源与时效限制。
 * 幅度数字一律置空（本地模型没有实时数据，不允许编造价位）。
 */
async function localKnowledgeInsight(
  materialName: string,
  categoryType: string,
  skillId: string | undefined,
  cloudError: unknown,
  onProgress?: (msg: string) => void,
): Promise<AgentSearchResult> {
  const reason = cloudFailureReason(cloudError);
  onProgress?.(`云端不可用（${reason}），改用本地模型分析（不联网）…`);
  console.warn('[洞察诊断] 云端不可用，转入本地模型知识分析', { material: materialName, reason });
  const skill = skillId ? (BUILTIN_SKILLS.find(s => s.id === skillId) || BUILTIN_SKILLS[0]) : getActiveSkill();
  const system = [
    '你是 CostHub 的物料成本与行情分析助手。当前没有联网能力，只能用你已有的公开行业知识作答。',
    '硬要求：',
    '1. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
    '2. 格式：{"trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","summary":"给采购的结论与依据","suggested_action":"备料/锁价|观望|维持常规节奏","data_note":"本次缺少实时数据，说明你依据的是哪类历史/公开知识"}',
    '3. 严禁编造具体价格、涨跌幅、日期等数字；拿不准就把 trend_direction 写"信号不明确"、confidence_level 写"低"。',
    '4. 不要提及任何本地项目、供应商、成本数据。',
    skill?.systemPrompt ? `分析视角参考：${String(skill.systemPrompt).slice(0, 800)}` : '',
  ].filter(Boolean).join('\n');
  const user = `物料：${materialName}\n品类：${categoryType || '未分类'}\n请基于公开行业知识给出该物料的市场趋势判断与采购建议。`;
  const localStatus = await localModelStatus();
  let text = '';
  try {
    text = await collectLocalText(system, user, { temperature: 0.3 });
  } catch (localError: any) {
    throw new Error(
      `洞察未能完成：云端不可用（${reason}），本地模型也不可用（${String(localError?.message || localError)}）。` +
      '请在 设置 → AI 服务 恢复云端额度或配置搜索 API，或到 设置 → 本地 AI 启动本地模型后重试。',
    );
  }
  await logLocalAICall({
    request_type: 'material_insight_local',
    material_name: materialName,
    system_prompt: system,
    user_prompt: user,
    response_summary: text.slice(0, 800),
    success: true,
    model_name: localStatus.model,
  });
  const parsed = extractJsonObject(text) || {};
  const summary = String(parsed.summary || '').trim() || text.slice(0, 900);
  const dataNote = String(parsed.data_note || '').trim();
  return {
    trend_direction: String(parsed.trend_direction || '信号不明确'),
    confidence_level: String(parsed.confidence_level || '低'),
    magnitude_min: null,
    magnitude_max: null,
    magnitude_reference: '本地知识分析：无实时行情数据，不提供幅度数字',
    summary: `${summary}\n\n[来源] 云端不可用（${reason}），本条由本地模型基于自身公开知识分析，未联网、时效性有限${dataNote ? `。${dataNote}` : ''}`,
    suggested_action: String(parsed.suggested_action || '观望'),
    allSources: [{
      title: '本地模型知识分析（未联网）',
      url: '',
      snippet: `云端不可用原因：${reason}。恢复云端额度 / API Key，或配置搜索 API，即可获得实时公开行情。`,
    }],
    searchRounds: 0,
    source: 'local-knowledge',
  };
}

/**
// ====== Agent 搜索循环（LLM 自主决定搜索策略） ======
 */
async function agentSearchLoopCloud(
  materialName: string,
  categoryType: string,
  skillId?: string,
  onProgress?: (msg: string) => void,
  networkTrace?: AiNetworkTraceSink,
): Promise<AgentSearchResult> {
  const nativeCandidate = await isNativeSearchEnabled() && await isDeepSeekNativeSearchAvailable();
  console.info('[洞察诊断] 启动', { material: materialName, category: categoryType, nativeCandidate });
  const validation = nativeCandidate
    ? validateNativeSearchArgs({ material: materialName, category: categoryType, question: PUBLIC_TREND_QUESTION })
    : validateCloudQueryArgs({ material: materialName, category: categoryType, question: PUBLIC_TREND_QUESTION });
  if (!validation.ok || !validation.clean) {
    console.warn('[洞察诊断] 校验未通过', { nativeCandidate, reason: validation.reason });
    // ⚠️ 2026-09-21：审查不通过必须**明确报给用户**（例如物料名里带了金额/型号），
    // 不能悄悄降级成本地知识分析——那样用户永远不知道"是名字里有敏感信息导致没联网"。
    // 用 CloudApprovalValidationError 这个名字 → agentSearchLoop 的 isUserStop 命中 → 不换通道、原因直达 UI。
    throw Object.assign(
      new Error('云端敏感审查未通过：' + (validation.reason || '请改用不含型号/金额/项目/供应商的物料通用名')),
      { name: 'CloudApprovalValidationError' },
    );
  }
  materialName = validation.clean.material;
  categoryType = validation.clean.category;
  console.info('[洞察诊断] 校验通过', { nativeCandidate, material: materialName, category: categoryType });
    const llmConfig = await resolveLLMConfig();
  if (!llmConfig) throw new Error('LLM API Key 未配置');
  const skill = skillId
    ? (BUILTIN_SKILLS.find(s => s.id === skillId) || BUILTIN_SKILLS[0])
    : getActiveSkill();

  // 优先使用已开启的模型原生联网搜索；它独立走完整请求审批，不依赖第三方搜索 API。
  if (nativeCandidate) {
    if (onProgress) onProgress('正在准备模型原生联网搜索审批；请查看右侧 AI 协作窗');
    console.info('[洞察诊断] 开始 DeepSeek 原生搜索', { material: materialName, skill: skill.id });
    const native = await tryDeepSeekNativeInsight(materialName, categoryType, skill, undefined, networkTrace);
    // ⚠️ 2026-09-21：原生搜索返回 200 但**一条引用都没有**时不能就这样交付（实测快照 36：
    // 原生搜索 HTTP 成功、来源为空 → 整条洞察退化成"未获取可点击公开来源"，用户说"并没有收集到任何东西"）。
    // 如果配了第三方搜索，就让它继续往下走真正的检索；只有没得选时才保留这份"仅模型归纳"的结论。
    const nativeHasClickableSources = Boolean(native && native.allSources.some(source => /^https?:\/\//i.test(String(source.url || ''))));
    const searchProviderAvailable = Boolean(await resolveSearchConfig());
    if (native && (nativeHasClickableSources || !searchProviderAvailable)) {
      console.info('[洞察诊断] 原生搜索返回结果', { material: materialName, summaryLength: native.summary.length, sources: native.allSources.length, clickable: nativeHasClickableSources, searchRounds: native.searchRounds });
      return native;
    }
    if (native) {
      lastNativeSearchError = '原生搜索未返回任何可点击引用';
      console.warn('[洞察诊断] 原生搜索无可点击来源，改用第三方搜索补充证据', { material: materialName });
    } else {
      console.warn('[洞察诊断] 原生搜索未返回结果，继续回退', { material: materialName, error: getLastNativeSearchError() });
    }
  } else {
    console.info('[洞察诊断] 未启用或不可用模型原生搜索', { material: materialName });
  }

  const searchConfig = await resolveSearchConfig();
  const hasSearch = !!searchConfig;
  console.info('[洞察诊断] 第三方搜索配置', { hasSearch, baseUrl: searchConfig?.baseUrl || '', nativeError: getLastNativeSearchError() });
  if (!hasSearch) await throwIfSearchProviderNeedsAttention();
  if (hasSearch) onProgress?.('正在准备云端审批；请查看右侧 AI 协作窗');
  const approvedScope = searchConfig ? await waitForCloudApproval({
        material: materialName,
        category: categoryType,
    question: PUBLIC_TREND_QUESTION,
    requestUrl: searchConfig.baseUrl,
        sourceType: 'tool_request',
        requirementKind: 'insight',
        requirementTitle: '模型原生联网搜索 · ' + materialName,
  }) : undefined;
  if (approvedScope) {
    materialName = approvedScope.material || materialName;
    categoryType = approvedScope.category || categoryType;
  }
  // ⚠️ 2026-09-21：不再按 skill.maxSearchRounds 反复搜索——网关载荷绑定决定了"一次审批=一个固定查询"，
  // 重复搜索只会拿到同一批结果（旧实现还因此误判"没有返回来源"而丢弃已拿到的来源）。检索关键词由
  // buildPublicSearchQuery 确定性重建，模型只负责整合，不负责换关键词。
  void skill;

  // 记录AI请求日志
  const logRequestStart = async () => {
    try {
      const { saveAIRequestLog } = await import('./db');
      return await saveAIRequestLog({
        request_channel: 'cloud',
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
    console.warn('[洞察诊断] 回退 LLM 知识分析', { material: materialName, nativeError: getLastNativeSearchError() });
    if (onProgress) onProgress('未配置搜索 API，LLM 基于自身知识分析...');
    const messages: ChatMessage[] = [
      { role: 'system', content: cloudSafePublicText(skill.systemPrompt + `\n\n⚠️ 注意：当前未配置搜索 API，请完全基于你的训练知识进行分析。必须标注以下分析基于 LLM 训练知识，未使用实时搜索，时效性可能不足。只采信${new Date().getFullYear()}年的趋势信息，旧数据请注明历史参考。`) },
      { role: 'user', content: `请分析以下物料的市场趋势：${materialName}（${categoryType === '原材料映射' ? '原材料' : '电器件'}）\n\n请直接给出分析，诚实标注信息时效性。按照 JSON 格式输出：{"trend_direction":"...","confidence_level":"...","summary":"...","suggested_action":"..."}` },
    ];
    const rawResponse = await callLLMChat('', '', '', messages, networkTrace, { material: materialName, category: categoryType });
    try {
      const parsed = extractJSON(rawResponse);
      const nativeNote = lastNativeSearchError ? '；模型原生搜索未成功：' + lastNativeSearchError : '';
        return {
        trend_direction: parsed.trend_direction || '信号不明确',
        confidence_level: parsed.confidence_level || '中',
        summary: (parsed.summary || '分析完成（AI基于训练知识，无实时搜索）') + nativeNote,
        suggested_action: parsed.suggested_action || '观望',
        magnitude_min: parsed.magnitude_min ?? null,
        magnitude_max: parsed.magnitude_max ?? null,
        magnitude_reference: parsed.magnitude_reference || '',
        allSources: [{ title: 'LLM 知识库分析（未使用搜索引擎）', url: '', snippet: (lastNativeSearchError ? '模型原生搜索未成功：' + lastNativeSearchError + '；' : '') + '建议配置搜索 API 以获取实时数据' }],
        searchRounds: 0,
      };
    } catch {
      throw new Error(`LLM 无搜索分析结果解析失败，无法获取有效判断。原始返回: ${rawResponse.slice(0, 200)}...`);
    }
  }

  const allSources: SearchResult[] = [];
  const conversationMessages: { role: string; content: string }[] = [];
  let sourceQuality = '';

  // 初始任务
  const taskPrompt = `分析任务：${materialName}（${categoryType === '原材料映射' ? '原材料' : '电器件'}）

${cloudSafePublicText(skill.description)}

本机已完成公开检索，来源见下一条消息；请只基于这些来源给出最终分析。`;
  conversationMessages.push({ role: 'user', content: taskPrompt });

  // ⚠️ 2026-09-21 结构简化（这是"洞察拿不到有效信息"的关键修复之一）：
  // 网关对搜索请求做**载荷哈希绑定**（一次审批 = 一份固定 body = 一个固定查询），
  // 因此多轮"让模型换关键词再搜"在物理上不可能生效——旧实现却按 maxRounds 反复搜同一句，
  // 并在最后一轮把"没有新增来源"误判成"没有返回可读且相关的公开来源"，把**已经拿到**的来源整个丢掉，
  // 直接返回一句错误结论（实测快照里多条 适配器/27寸面板 都是这么变成"未获取可点击公开来源"的）。
  // 现在：一轮关键词搜索 → 来源质量闸门 → 交给模型整合。来源确实为空才走降级。
  if (!approvedScope) throw new Error('缺少搜索授权，请重新发起洞察');
  const approvedQuery = buildPublicSearchQuery(materialName, PUBLIC_TREND_QUESTION);
  if (onProgress) onProgress(`正在检索公开来源：${approvedQuery}`);
  const searchOutcome = await executeSearchRounds([], approvedScope, networkTrace);
  const rawSources = searchOutcome.batches.flat();
  const searchError = searchOutcome.error || '';
  // 来源质量闸门：硬剔赌博/站群等垃圾站 + 按物料特征词排序（旧代码一条都不过滤，垃圾来源会直接进证据列表）
  const gated = gateSources(rawSources, materialName, { limit: 8 });
  allSources.push(...gated.kept);
  sourceQuality = [describeSourceQuality(gated, materialTerms(materialName)), searchError ? `检索失败：${searchError}` : ''].filter(Boolean).join('；');
  console.info('[洞察诊断] 来源质量闸门', {
    material: materialName, query: approvedQuery, providerQuery: searchOutcome.query,
    raw: rawSources.length, kept: gated.kept.length, dropped: gated.dropped.length, weak: gated.weak,
    searchError: searchError || undefined, note: sourceQuality,
  });
  if (onProgress) onProgress(`获取 ${allSources.length} 条来源${sourceQuality ? `（${sourceQuality}）` : ''}`);

  if (allSources.length === 0) {
    // ⚠️ 2026-09-21：这里必须让**真实原因**一路传到用户面前，并且**不要**再让研判模型去写
    // "公开信息不足"（那是"看起来像结论、其实什么都没说"的假结论）。
    // 两种失败分开处理：
    //   ① 审批/绑定类确定性失败（如网关拦截"查询词超出已批准主题范围"）→ 抛 CloudApprovalUnavailableError：
    //      agentSearchLoop 不会偷偷换通道（isUserStop 命中），Decomposition 会 message.warning 弹出可操作原因。
    //   ② 供应商真的没返回可读结果 → 抛普通错误 → agentSearchLoop 转入**本地模型知识分析**（明确标注未联网、
    //      幅度数字一律置空），用户拿到的是一份"基于公开知识"的判断，而不是五个"公开信息不足"。
    // 另外：原生联网搜索被关掉时明确提示——它是另一条能用的公开检索通道（用户实测曾把它关掉后只剩第三方搜索）。
    const nativeHint = (await isNativeSearchEnabled())
      ? ''
      : '（提示：模型原生联网搜索当前是关闭的，可在 设置 → AI 服务 打开它作为备用检索通道。）';
    if (searchError && isDeterministicCloudBlock(searchError)) {
      throw Object.assign(
        new Error(`本次洞察未发送成功：${searchError}。这属于审批/绑定问题——请重新发起一次洞察，重新审批后即可正常检索。${nativeHint}`),
        { name: 'CloudApprovalUnavailableError' },
      );
    }
    throw new Error(searchError
      ? `公开检索未完成：${searchError}${nativeHint}`
      : `搜索「${approvedQuery}」没有返回可读且相关的公开来源（供应商返回为空，或全部被相关性/垃圾来源过滤剔除）${nativeHint}`);
  }

  // 把来源回灌给模型做整合。弱相关时必须明说，否则模型会把泛新闻当成本物料的行情证据。
  const weakWarning = gated.weak > 0
    ? `\n\n⚠️ 重要：以上来源**均未直接提及「${materialName}」**（特征词：${materialTerms(materialName).join('/')}），只能作为行业背景参考。禁止把这些来源里的价格/涨跌数字当作「${materialName}」自身的行情；相关维度请如实写"公开信息不足"。`
    : '';
  const feedback = `检索关键词：${approvedQuery}\n公开来源（已按与「${materialName}」的相关度排序，共 ${allSources.length} 条）：\n${formatSearchResults([allSources])}${weakWarning}\n\n请基于这些来源给出最终分析。`;
  conversationMessages.push({ role: 'user', content: feedback });
  if (onProgress) onProgress('正在整合分析...');

  const messages: ChatMessage[] = [
    { role: 'system', content: '请基于给出的搜索结果给出最终分析。严格按 JSON 格式输出：{"action":"final","trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","summary":"采购结论与依据","suggested_action":"备料/锁价|观望|维持常规节奏"}；只许使用给出来源中的数字，来源没提到的数字一律不要写。' },
    ...conversationMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: '请给出最终分析。' },
  ];

  const finalResponse = await callLLMChat('', '', '', messages, networkTrace, { material: materialName, category: categoryType });
  try {
    const parsed = extractJSON(finalResponse);
    return {
      trend_direction: parsed.trend_direction || '信号不明确',
      confidence_level: parsed.confidence_level || '中',
      magnitude_min: parsed.magnitude_min ?? null,
      magnitude_max: parsed.magnitude_max ?? null,
      magnitude_reference: parsed.magnitude_reference || '',
      summary: parsed.summary || `公开来源未直接覆盖「${materialName}」，建议补充询价后再判断。`,
      suggested_action: parsed.suggested_action || '观望',
      allSources,
      searchRounds: 1,
      source: 'cloud',
      searchQuery: approvedQuery,
      sourceQuality,
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
  agentSummary: string,
  options: { localContext?: string; sourceQuality?: string } = {},
): Promise<TrendAnalysisResult> {
  const usableSources = sources.filter(source => /^https?:\/\//i.test(String(source.url || '').trim()));
  const agentEvidence = String(agentSummary || '').trim();
  // 原生联网搜索已给出结论但没有可点击链接时，不能直接扔掉——降级标注后仍然形成结论（用户实测"成功但什么都没收集到"）。
  if (!usableSources.length && !agentEvidence) {
    const dimensions = skill.outputDimensions || ['核心结论', '证据与依据', '展望'];
    return {
      trend_direction: '信号不明确',
      confidence_level: '低',
      magnitude_min: null,
      magnitude_max: null,
      magnitude_reference: '未获取可点击公开来源，无法计算近期价格幅度',
      summary: '未获取可点击公开来源，本次不形成可靠的涨跌判断。',
      suggested_action: '补充可核验来源后重试',
      drivers: [],
      opportunities: [],
      risks: [{ label: '证据风险', text: '来源链接缺失，当前结论不能作为采购或锁价依据。' }],
      actions: [{ label: '下一步', text: '先配置搜索 API 或可用的实时搜索，再重新洞察；项目影响由应用在本地计算。' }],
      project_impacts: [],
      dimensions: dimensions.map((dimension_type, dimension_order) => ({ dimension_type, dimension_order, content: '未获取可点击公开来源，暂无法形成可靠结论。', evidence_strength: '未验证', source_title: '', source_url: '' })),
        key_events: [],
      info_sufficiency: { sufficient: false, missing_dimensions: [...dimensions, '可点击公开来源', '项目影响（本地计算）'], reason: '没有可核验 URL' },
    };
  }
  // 证据 = 云端检索到的可点击来源（公开、已脱敏）。注意：外发正文只能包含来源本身，
  // 不能再塞"检索归纳"这类聚合文本（可能带本地线索）——安全回归测试 materialInsightApproval 会拦。
  const maxSources = 8;
  const limitedSources = usableSources.slice(0, maxSources);
  const noClickableSources = limitedSources.length === 0;

  const sourceContext = noClickableSources
    ? [
        `物料：${materialName}`,
        '[本次未返回可点击来源] 以下内容来自云端联网检索后的行情归纳（无链接可核验，证据强度自动降级为"仅模型归纳"）：',
        agentEvidence.slice(0, 3000),
      ].join('\n\n')
    : [
        `物料：${materialName}`,
        ...limitedSources.map((source, index) =>
          `[${index + 1}] 标题：${source.title.slice(0, 100)}\nURL：${source.url}\n摘要：${source.snippet.slice(0, 150)}`
        ),
      ].join('\n\n');
  // 本地模型研判才额外带上云端归纳与**本机内部事实**（本机可信，结构上永远不会进云端载荷）。
  const localContextText = String(options.localContext || '').trim();
  const localSourceContext = [
    sourceContext,
    agentEvidence && !noClickableSources ? `【云端检索归纳】（公开检索结果，供研判参考，不是最终结论）\n${agentEvidence.slice(0, 2000)}` : '',
    localContextText
      ? `【本机内部事实｜⚠️ 只在本机使用】\n以下是从本机数据库读出的真实数据，**仅用于本机研判**，任何情况下都不得出现在对云端发送的内容里。\n凡结论用到这里的数据，请在文字里注明"（内部数据）"。\n${localContextText}`
      : '',
  ].filter(Boolean).join('\n\n');


  let raw = '';
  let localNote = '';
  const structuredPrompt = buildStructuredAnalysisPrompt(skill, sourceContext);
  const judgeInstruction = `请为「${materialName}」生成本次洞察的最终结构化结论（只输出 JSON）。`;

  // ① 研判优先本地模型：云端只负责检索公开事实，结论与方法论套用（不同 Skill 的维度与格式）在本机完成。
  const localStatus = await localModelStatus();
  if (localStatus.ready) {
    try {
      raw = await collectLocalText(
        '你是 CostHub 物料成本洞察专家。你收到的"可用来源"是云端检索回来的公开资料，另有标注为「本机内部事实」的本地数据——后者只在本机使用，绝不可写进任何要外发的内容。请基于它们研判，严格按给定方法论与 JSON 格式输出；只输出一个 JSON 对象，不要解释、不要 Markdown 代码块；来源里没有的数字不得编造，本机内部事实里的数字可以引用但要注明"（内部数据）"。',
        `${buildStructuredAnalysisPrompt(skill, localSourceContext)}\n\n${judgeInstruction}`,
        { temperature: 0.2 },
      );
      localNote = `本机模型（${localStatus.model}）研判`;
    } catch (localError: any) {
      console.warn('[createStructuredInsight] 本地模型研判失败，改用云端模型', { error: String(localError?.message || localError) });
      raw = '';
    }
  } else {
    console.info('[createStructuredInsight] 本地模型不可用，改用云端模型研判', { reason: localStatus.message });
  }

  // ② 本地不可用（未启动/未选模型/推理失败）时才交给云端模型，保证功能不中断。
  if (!raw) {
    try {
      raw = await callLLM('', '', '', structuredPrompt, judgeInstruction, { material: materialName });
      localNote = '';
    } catch (cloudError: any) {
      if (isUserStop(cloudError)) throw cloudError;
      const reason = cloudFailureReason(cloudError);
      throw new Error(
        `结构化洞察未能完成：本地模型不可用（${localStatus.message}），云端也不可用（${reason}）。` +
        '请在 设置 → 本地 AI 启动本地模型，或到 设置 → AI 服务 恢复云端额度后重试。',
      );
    }
  }

  try {
    const parsed = extractJSON(raw);
    // 兜底对象（解析失败降级）必须显式失败，不能静默存库/展示
    if (parsed && parsed._parse_error) {
      console.error('[createStructuredInsight] 结论 JSON 解析失败:', parsed._parse_error);
      throw new Error(
        localNote
          ? `${localNote}返回格式解析失败\n建议：换一个更强的本地模型（本地 AI 设置里切换），或在 设置 → 本地 AI 关闭后由云端研判。原始输出: ${String(raw).slice(0, 240)}`
          : 'LLM返回格式解析失败。可能原因：\n' +
            '1. 响应被截断（num_predict 不足）\n' +
            '2. LLM未按JSON格式返回\n' +
            '建议：重试或更换LLM供应商\n' +
            `原始错误: ${parsed._parse_error}`
      );
    }
    const structured = normalizeStructuredResult(parsed, skill);
    // 透明标注"这份结论是谁研判的"（云端只负责检索公开事实，研判与 Skill 格式套用默认在本机完成）。
    const judgeNote = localNote || `云端模型（${lastLLMMeta.model_name || lastLLMMeta.provider_name || '云端'}）研判`;
    const qualityNote = String(options.sourceQuality || '').trim();
    structured.summary = `${structured.summary}\n\n[研判] ${judgeNote}${localContextText ? ' · 参考了本机内部数据（未外发）' : ''}${noClickableSources ? '；云端检索未返回可点击来源，证据强度已降级' : ''}${qualityNote ? `；${qualityNote}` : ''}`;
    if (noClickableSources) {
      // 无链接可核验：全部维度降级为"仅模型归纳"，并显式追加证据风险（不伪造 URL，也不假装有来源）。
      structured.dimensions = (structured.dimensions || []).map(dimension => ({
        ...dimension,
        evidence_strength: '仅模型归纳（无可点击来源）',
        source_title: '',
        source_url: '',
      }));
      structured.risks = [
        ...(structured.risks || []),
        { label: '证据风险', text: '本次联网搜索未返回可点击链接，结论仅依据模型归纳，请勿单独作为锁价/备料依据。' },
      ];
      const previous = structured.info_sufficiency;
      structured.info_sufficiency = {
        sufficient: false,
        missing_dimensions: [...new Set([...(previous?.missing_dimensions || []), '可点击公开来源'])],
        reason: previous?.reason ? `${previous.reason}；联网搜索未返回可点击链接` : '联网搜索成功但未返回可点击链接，证据强度已降级',
      };
    }
    return { ...structured, project_impacts: [], source: localNote ? 'local-knowledge' : 'cloud', source_note: [localNote, localContextText ? '研判参考了本机内部数据（未外发）' : '', qualityNote, noClickableSources ? '云端检索未返回可点击来源，证据强度已降级为"仅模型归纳"' : ''].filter(Boolean).join('；') || undefined };
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
    // 用户点击“测试搜索”即明确批准本次固定公开主题的连接测试，
    // 审批范围由 cloudConfirm 内部写死，无法携带数据库或页面中的动态数据。
    const approval = await approveSafeConnectionTest();
    const testQuery = `${approval.material} ${approval.question}`;
    let results: SearchResult[];

    console.log('开始测试搜索连接...');
    results = await searchWithProvider(activeSearch, testQuery, approval);
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
          : `返回结果与测试主题不相关，已拦截为失败，避免误判通过。\n\n${results.slice(0, 3).map(r => `· ${r.title}\n  ${r.snippet}`).join('\n\n')}`,
      };
    }

        return {
        success: true,
      message: `✅ 搜索 API 连接成功！获取到 ${relevantResults.length} 条有效结果`,
      detail: relevantResults.slice(0, 3).map(r => `· ${r.title}\n  ${r.snippet}`).join('\n\n'),
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

    // LLM 连接测试，C2：只发送固定抽象特征，不能复用 C1 公开检索票。
    const checked = sanitizeC2Payload({ domain: '公开行业', features: { supply_signal: 'unknown' }, question: '连接测试，仅回复 OK' });
  if (!checked.ok) throw new Error(checked.reason);
    const requestBody = canonicalC2Body({ ...checked.payload, model: activeLLM.model_name || 'deepseek-chat', messages: [
      { role: 'system', content: c2SafeSystemPrompt() },
      { role: 'user', content: JSON.stringify({ scope_level: 'C2', ...checked.payload }) },
    ] });
    const requestUrl = normalizeChatCompletionUrl(activeLLM.base_url);
    const { createApprovalGrant } = await import('./db/ai');
    const grant = await createApprovalGrant({ material: checked.payload.domain, category: 'C2', question: checked.payload.question, scopeLevel: 'C2', previewJson: requestBody, expiresMinutes: 5, requestUrl, requestMethod: 'POST' });
    const response = await rustPost(
      requestUrl,
    { 'Content-Type': 'application/json' },
      requestBody,
      { material: checked.payload.domain, ...checked.payload, category: 'C2', scopeLevel: 'C2', grantId: Number(grant.id), payloadHash: grant.payload_hash, expiresAt: grant.expires_at, requestUrl, requestMethod: 'POST' },
      Number(activeLLM.id),
      { mode: 'bearer' },
    );

    if (!response.success) throw new Error(`HTTP ${response.status}: ${response.body.slice(0, 300)}`);
    let responseText = response.body;
    try {
      const parsed = JSON.parse(response.body);
      responseText = parsed.choices?.[0]?.message?.content || parsed.output_text || response.body;
  } catch { /* 审批前已经校验过 JSON；旧载荷缺字段时退回本地重新构建 */ }
    const trimmed = responseText.trim();
    // 检查是否包含OK（不使用isReadableText，因为"OK"只有2个字符）
    if (!trimmed || !/\bOK\b/i.test(trimmed)) {
        return {
        success: false,
        message: '搜索 API 返回了结果，但没有可用的相关结果',
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
    message: `全部通过！搜索: ${searchResult.message.split('\n')[0].replace('✅', '')} | LLM: ${llmResult.message.split('\n')[0].replace('✅', '')}`,
  };
}
