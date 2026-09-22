import { getSetting } from './db';
import { invoke } from '@tauri-apps/api/core';
import { normalizeLocalAiBaseUrl } from './securityPolicy';

export type LocalBackend = 'ollama' | 'llama.cpp';

export function normalizeLocalBackend(value: unknown): LocalBackend {
  return value === 'llama.cpp' ? 'llama.cpp' : 'ollama';
}

export async function getLocalBackend(): Promise<LocalBackend> {
  return normalizeLocalBackend(await getSetting('local_ai_backend', 'ollama'));
}

export function localModelsPath(backend: LocalBackend): string {
  return backend === 'llama.cpp' ? '/v1/models' : '/api/tags';
}

export function localChatPath(backend: LocalBackend): string {
  return backend === 'llama.cpp' ? '/v1/chat/completions' : '/api/chat';
}

export interface LocalModelOptions {
  reasoningEffort?: 'low' | 'medium' | 'xhigh';
  preserveThinking?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export function modelOptionsKey(backend: LocalBackend, base: string, model: string): string {
  return `local_model_options:${backend}:${base.replace(/\/$/, '')}:${model}`;
}

export async function loadModelOptions(backend: LocalBackend, base: string, model: string): Promise<LocalModelOptions> {
  let value: LocalModelOptions = {};
  try { value = JSON.parse(await getSetting(modelOptionsKey(backend, base, model), '{}')) || {}; } catch { /* use defaults */ }
  return {
    reasoningEffort: ['low', 'medium', 'xhigh'].includes(value.reasoningEffort || '') ? value.reasoningEffort : 'medium',
    preserveThinking: typeof value.preserveThinking === 'boolean' ? value.preserveThinking : /qwen[\s._-]*3[._-]*8/i.test(model),
    ...(typeof value.temperature === 'number' && value.temperature >= 0 && value.temperature <= 2 ? { temperature: value.temperature } : {}),
    maxTokens: Number.isSafeInteger(value.maxTokens) && Number(value.maxTokens) > 0 ? value.maxTokens : 0,
  };
}

export interface LocalChatOptions extends LocalModelOptions {
  stream?: boolean;
  think?: boolean;
  json?: boolean;
  context?: number;
  tools?: unknown[];
}

export function buildLocalChatBody(backend: LocalBackend, model: string, messages: unknown[], opts: LocalChatOptions = {}) {
  const qwen38 = /qwen[\s._-]*3[._-]*8/i.test(model);
  const sampling = {
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    ...(qwen38 ? { top_p: opts.think === false ? 0.8 : 0.95, top_k: 20, min_p: 0, presence_penalty: opts.think === false ? 1.5 : 0, repeat_penalty: 1 } : {}),
  };
  const common = { model, messages, stream: opts.stream ?? false, ...(opts.tools?.length ? { tools: opts.tools } : {}) };
  if (backend === 'ollama') return {
    ...common, ...(opts.json ? { format: 'json' } : {}),
    ...(opts.think !== undefined ? { think: opts.think } : {}),
    options: { ...sampling, ...(opts.context ? { num_ctx: opts.context } : {}), ...(opts.maxTokens && opts.maxTokens > 0 ? { num_predict: opts.maxTokens } : {}) },
    keep_alive: '30m',
  };
  return {
    ...common, ...sampling,
    ...(opts.maxTokens && opts.maxTokens > 0 ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    ...(opts.think !== false ? { reasoning_effort: opts.reasoningEffort || 'medium' } : {}),
    chat_template_kwargs: { ...(opts.think !== undefined ? { enable_thinking: opts.think } : {}), preserve_thinking: opts.preserveThinking ?? false },
  };
}

/** Shared non-streaming path for briefs, advisor and the local/cloud bridge. */
export async function localCompletion(system: string, user: string, temperature = 0.3): Promise<string> {
  const backend = await getLocalBackend();
  const base = normalizeLocalAiBaseUrl(await getSetting('local_ai_base_url', backend === 'llama.cpp' ? 'http://127.0.0.1:8080' : 'http://localhost:11434'));
  const model = await getSetting('local_ai_model', '');
  if (!model) throw new Error('未配置本地模型');
  const options = await loadModelOptions(backend, base, model);
  const response = await invoke<{ success: boolean; status: number; body: string }>('http_post', { request: {
    url: base + localChatPath(backend), backend, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLocalChatBody(backend, model, [{ role: 'system', content: system }, { role: 'user', content: user }], { ...options, temperature: options.temperature ?? temperature, think: false })),
  } });
  if (!response.success) throw new Error(`本地模型 HTTP ${response.status}`);
  const parsed = JSON.parse(response.body);
  const content = backend === 'llama.cpp' ? parsed?.choices?.[0]?.message?.content : parsed?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('本地模型没有返回正文');
  return content;
}
