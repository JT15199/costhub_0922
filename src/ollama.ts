// 本地 Ollama 流式调用（供右侧 AI 协作窗与演示生成器共用）
// 纯搬移，行为不变
import { invoke } from '@tauri-apps/api/core';
import { normalizeLocalAiBaseUrl } from './securityPolicy';
import { buildLocalChatBody, getLocalBackend, type LocalBackend, type LocalModelOptions } from './localBackend';

export interface OllamaStreamOpts extends LocalModelOptions {
  num_predict?: number;
  num_ctx?: number;
  temperature?: number;
  think?: boolean;
  endpoint?: 'v1' | 'native';
  json?: boolean;
  tools?: any[];                       // Ollama function-calling 工具定义（本地模型自主调用云端助手）
  onToolCalls?: (tcs: any[]) => void;  // 工具调用回调
  onUsage?: (usage: { promptEvalCount?: number; evalCount?: number; totalDurationNs?: number; loadDurationNs?: number; promptEvalDurationNs?: number; evalDurationNs?: number; doneReason?: string }) => void;
  onTruncated?: () => void;
  signal?: AbortSignal;
  backend?: LocalBackend;
}

/**
 * 流式调用 Ollama（经 Rust http_stream 代理，纯本地）
 * - endpoint 'native'：/api/chat，format:'json' 强制输出合法 JSON（json:false 时跳过，用于文本类输出）
 * - endpoint 'v1'：/v1/chat/completions
 * 返回 cleanup 函数（取消监听）
 */
export async function startOllamaStream(
  baseUrl: string, model: string,
  messages: { role: string; content: string }[],
  onToken: (t: string) => void,
  onReasoning: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
  opts?: OllamaStreamOpts,
): Promise<() => void> {
  const { listen: listenEvent } = await import('@tauri-apps/api/event');
  const eventId = `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const backend = opts?.backend || await getLocalBackend();
  const base = normalizeLocalAiBaseUrl(baseUrl);
  // 原生 /api/chat 端点：think:false 确定生效（解决 qwen3 思考型模型复述规则的问题）
  const native = backend === 'ollama' && opts?.endpoint === 'native';
  const url = native ? `${base}/api/chat` : `${base}/v1/chat/completions`;
  const unlisteners: (() => void)[] = [];
  let settled = false;
  const fail = (error: string) => { if (settled) return; settled = true; cleanup(); onError(error); };
  const deltaToolCalls = new Map<number, { id?: string; name: string; arguments: string }>();
  const flushDeltaToolCalls = () => {
    if (!deltaToolCalls.size || !opts?.onToolCalls) return;
    opts.onToolCalls([...deltaToolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, function: { name: call.name, arguments: call.arguments || '{}' } })));
    deltaToolCalls.clear();
  };
  const cleanup = () => { unlisteners.splice(0).forEach(u => u()); opts?.signal?.removeEventListener('abort', onAbort); };
  const onAbort = () => { void invoke('cancel_http_stream', { eventId }).catch(() => undefined); fail('已取消'); };
  opts?.signal?.addEventListener('abort', onAbort, { once: true });
  const listen = async <T>(name: string, handler: (event: { payload: T }) => void) => {
    const unlisten = await listenEvent<T>(name, handler);
    if (settled) unlisten(); else unlisteners.push(unlisten);
  };
  try {
    if (opts?.signal?.aborted) { fail('已取消'); return cleanup; }
    await listen<string>(`llm-token-${eventId}`, ev => { if (!settled && ev.payload) onToken(ev.payload); });
    await listen<string>(`llm-reasoning-${eventId}`, ev => { if (!settled && ev.payload) onReasoning(ev.payload); });
    await listen(`llm-done-${eventId}`, () => { if (settled) return; flushDeltaToolCalls(); if (settled) return; settled = true; cleanup(); onDone(); });
    await listen<string>(`llm-toolcalls-${eventId}`, ev => {
      if (settled || !ev.payload || !opts?.onToolCalls) return;
      try { const arr = JSON.parse(ev.payload); if (!Array.isArray(arr)) throw new Error(); opts.onToolCalls(arr); } catch { fail('工具调用数据损坏，未执行本轮工具'); }
    });
    await listen<string>(`llm-toolcall-delta-${eventId}`, ev => {
      try {
        const items = JSON.parse(ev.payload || '[]');
        if (!Array.isArray(items)) throw new Error();
        for (const item of items) {
          const explicitIndex = Number.isSafeInteger(Number(item?.index)) ? Number(item.index) : undefined;
          const existingIndex = item?.id ? [...deltaToolCalls.entries()].find(([, call]) => call.id === String(item.id))?.[0] : undefined;
          const index = explicitIndex ?? existingIndex ?? (deltaToolCalls.size === 0 ? 0 : undefined);
          if (index === undefined) throw new Error('工具调用缺少 index/id');
          const current = deltaToolCalls.get(index) || { name: '', arguments: '' };
          if (item?.id) current.id = String(item.id);
          if (item?.function?.name) current.name += String(item.function.name);
          if (item?.function?.arguments) current.arguments += String(item.function.arguments);
          deltaToolCalls.set(index, current);
        }
      } catch { fail('工具调用分段数据损坏，未执行本轮工具'); }
    });
    await listen<string>(`llm-meta-${eventId}`, ev => { try { if (!settled) opts?.onUsage?.(JSON.parse(ev.payload || '{}')); } catch { /* 元数据损坏不影响正文 */ } });
    await listen(`llm-truncated-${eventId}`, () => { if (!settled) opts?.onTruncated?.(); });
    await listen<string>(`llm-error-${eventId}`, ev => fail(ev.payload));
    const body = buildLocalChatBody(native ? 'ollama' : backend, model, messages, {
      ...opts, stream: true, json: opts?.json ?? native,
      context: opts?.num_ctx, maxTokens: opts?.num_predict,
    });
    // Listeners must all be installed before dispatch; an abort during setup must not start a request.
    if (settled || opts?.signal?.aborted) { fail('已取消'); return cleanup; }
    void invoke('http_stream', {
      url, eventId,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      backend,
    }).catch(err => fail(String(err)));
  } catch (error) {
    fail(String((error as Error)?.message || error));
  }
  return cleanup;
}

// ===== 本地模型调用审计（v2.3.19）：本地 AI 的每一次访问也记录到 ai_request_logs，与云端同表可查 =====
// 数据安全：日志记录"发给了本地模型什么"，可供用户审查本地模型读取了哪些数据
export async function logLocalAICall(data: {
  request_type: string;         // quote_compare / project_health / snapshot_explain / global_ask / auto_audit / local_chat
  material_name?: string;
  system_prompt: string;
  user_prompt: string;
  response_summary: string;
  success: boolean;
  error_message?: string;
  model_name?: string;
}): Promise<void> {
  try {
    const { saveAIRequestLog } = await import('./db');
    await saveAIRequestLog({
        request_channel: 'local',
      request_type: data.request_type,
      material_name: data.material_name || '',
      system_prompt: data.system_prompt,
      user_prompt: data.user_prompt,
      response_summary: data.response_summary,
      success: data.success ? 1 : 0,
      error_message: data.error_message || '',
      provider_name: (await getLocalBackend()) + ' 本地',
      model_name: data.model_name || '',
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    } as any);
  } catch (e) { console.warn('本地模型日志记录失败:', e); }
}
