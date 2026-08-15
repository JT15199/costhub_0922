// 本地 Ollama 流式调用（从 LocalAIAssistant 抽出，供本地 AI 助手与演示生成器共用）
// 纯搬移，行为不变
import { invoke } from '@tauri-apps/api/core';

export interface OllamaStreamOpts {
  num_predict?: number;
  temperature?: number;
  think?: boolean;
  endpoint?: 'v1' | 'native';
  json?: boolean;
  tools?: any[];                       // Ollama function-calling 工具定义（本地模型自主调用云端助手）
  onToolCalls?: (tcs: any[]) => void;  // 工具调用回调
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
  const base = baseUrl.replace(/\/$/, '');
  // 原生 /api/chat 端点：think:false 确定生效（解决 qwen3 思考型模型复述规则的问题）
  const url = opts?.endpoint === 'native' ? `${base}/api/chat` : `${base}/v1/chat/completions`;
  const unlisteners: (() => void)[] = [];
  const cleanup = () => { unlisteners.forEach(u => u()); };

  const u1 = await listenEvent<string>(`llm-token-${eventId}`, ev => {
    if (ev.payload) { console.log('[流式] token 事件, 长度:', ev.payload.length, 'eventId:', eventId.slice(0, 12)); onToken(ev.payload); }
  });
  const u2 = await listenEvent<string>(`llm-reasoning-${eventId}`, ev => {
    if (ev.payload) onReasoning(ev.payload);
  });
  const u3 = await listenEvent<string>(`llm-done-${eventId}`, () => { console.log('[流式] done 事件, eventId:', eventId.slice(0, 12)); cleanup(); onDone(); });
  const u4t = await listenEvent<string>(`llm-toolcalls-${eventId}`, ev => {
    if (ev.payload && opts?.onToolCalls) {
      try { const arr = JSON.parse(ev.payload); opts.onToolCalls(Array.isArray(arr) ? arr : []); } catch { /* 忽略 */ }
    }
  });
  unlisteners.push(u4t);
  const u4 = await listenEvent<string>(`llm-error-${eventId}`, ev => { console.log('[流式] error 事件:', ev.payload, 'eventId:', eventId.slice(0, 12)); cleanup(); onError(ev.payload); });
  unlisteners.push(u1, u2, u3, u4);
  let body: any;
  if (opts?.endpoint === 'native') {
    // Ollama 原生 /api/chat 格式
    body = {
      model, messages, stream: true,
      // format:'json' 强制模型只能输出合法JSON——彻底阻止复述规则/散文（json:false 时跳过，用于文本总结等场景）
      ...(opts?.json === false ? {} : { format: 'json' }),
      // 工具调用（本地模型自主调用云端助手）：tools 定义由调用方传入
      ...(opts?.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      options: {
        temperature: opts?.temperature ?? 0.3,
        num_predict: opts?.num_predict ?? 1200,
      },
      keep_alive: '30m',
    };
    if (opts?.think === false) {
      body.think = false;
      body.options.enable_thinking = false; // 双保险：Ollama 原生参数也关闭思考
    }
  } else {
    body = {
      model, messages, stream: true,
      temperature: opts?.temperature ?? 0.3,
      num_predict: opts?.num_predict ?? 1200,
      max_tokens: opts?.num_predict ?? 1200, // /v1 端点认 max_tokens，双保险
      keep_alive: '30m',
    };
    if (opts?.think === false) {
      body.think = false;
      body.enable_thinking = false;
      body.reasoning_effort = 'none';
      body.chat_template_kwargs = { enable_thinking: false };
    }
  }

  console.log('[流式] 发起 http_stream:', url, 'model:', model, 'eventId:', eventId.slice(0, 12));
  invoke('http_stream', {
    url, eventId,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(err => { console.log('[流式] invoke 失败:', err); cleanup(); onError(String(err)); });

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
      request_type: data.request_type,
      material_name: data.material_name || '',
      system_prompt: data.system_prompt,
      user_prompt: data.user_prompt,
      response_summary: data.response_summary,
      success: data.success ? 1 : 0,
      error_message: data.error_message || '',
      provider_name: 'Ollama 本地',
      model_name: data.model_name || '',
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    } as any);
  } catch (e) { console.warn('本地模型日志记录失败:', e); }
}
