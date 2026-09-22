// 本地模型分析通道（2026-09-21）
// 用途：云端搜索/LLM 不可用（未配置、额度不足 402、鉴权失败、网络中断、被本地闸门拦住）时，
// 洞察等 AI 功能改用本机模型基于自身公开知识给结论——不再整条链路报错（用户反馈："洞察还是失败，这次要彻底解决"）。
//
// 约定（CLAUDE.md 二·3）：
//   · json:false 必传（native 端点默认 format:'json' 会把自由文本吞掉）
//   · num_predict 16384 不截断，模型想写多少写多少
//   · 不设硬超时：只在"完全没有任何输出"时判死（惰性看门狗），有 token 就无限等
//   · 思考 token 与正文 token 都算"有输出"（否则思考久的模型会被误杀）
// 数据边界：本地模型可以读本地数据，但本模块的输出永远不会被回填进任何云端提示词。

import { getSetting } from './db';
import { getLocalBackend } from './localBackend';
import { startOllamaStream } from './ollama';
import { detectOllama, type OllamaStatus } from './aiStatus';

const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';
const DEFAULT_LLAMA_BASE = 'http://127.0.0.1:8080';
/** 完全无输出多久算卡死（有输出则一直等）。 */
export const LOCAL_NO_OUTPUT_TIMEOUT_MS = 180_000;

export interface LocalModelStatus extends OllamaStatus {
  ready: boolean;
  /** 直接展示给用户的原因文案 */
  message: string;
}

/** 探测本地模型是否可用，并把状态翻译成用户能看懂的一句话。 */
export async function localModelStatus(): Promise<LocalModelStatus> {
  const status = await detectOllama();
  const message = status.connected
    ? `本地模型 ${status.model} 已就绪`
    : status.reason === 'no-model'
      ? '未选择本地模型：请到 设置 → 本地 AI 选择模型'
      : status.reason === 'model-missing'
        ? `本地模型「${status.model}」未下载：请到 设置 → 本地 AI 拉取或换一个已下载的模型`
        : status.reason === 'offline'
          ? '本地模型服务未运行（Ollama / llama.cpp 未启动）'
          : '本地模型状态未知';
  return { ...status, ready: status.connected, message };
}

export interface LocalTextOptions {
  temperature?: number;
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
  noOutputMs?: number;
  /** 允许思考（默认关：知识分析只要正文，快且不占上下文）。 */
  think?: boolean;
}

/**
 * 让本地模型一次性返回完整文本。
 * 用流式通道实现：可控 num_predict / 惰性超时 / 可取消 / 可把进度透给 UI。
 */
export async function collectLocalText(system: string, user: string, options: LocalTextOptions = {}): Promise<string> {
  const status = await localModelStatus();
  if (!status.ready) throw Object.assign(new Error(status.message), { name: 'LocalModelUnavailableError' });
  const base = status.baseUrl || (await getSetting('local_ai_base_url', (await getLocalBackend()) === 'llama.cpp' ? DEFAULT_LLAMA_BASE : DEFAULT_OLLAMA_BASE));
  let buffer = '';
  let lastOutputAt = Date.now();
  const noOutputMs = options.noOutputMs ?? LOCAL_NO_OUTPUT_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let cleanup: (() => void) | null = null;
    const timer = setInterval(() => {
      if (options.signal?.aborted) { finish(new Error('本地分析已取消')); return; }
      if (Date.now() - lastOutputAt > noOutputMs) {
        finish(new Error(`本地模型 ${Math.round(noOutputMs / 1000)} 秒没有任何输出（可能在加载模型或服务异常），已停止；请检查本地模型后重试`));
      }
    }, 500);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try { cleanup?.(); } catch { /* 清理失败不影响结果 */ }
      if (error) reject(error); else resolve();
    };
    const markOutput = (chunk: string) => {
      lastOutputAt = Date.now();
      buffer += chunk;
      options.onToken?.(chunk);
    };
    startOllamaStream(
      base,
      status.model,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      markOutput,
      chunk => { lastOutputAt = Date.now(); if (options.think) buffer += chunk; },
      () => finish(),
      error => finish(new Error(String(error || '本地模型调用失败'))),
      { endpoint: 'native', think: Boolean(options.think), json: false, num_predict: 16384, temperature: options.temperature ?? 0.3, signal: options.signal },
    ).then(cleanupFn => { cleanup = cleanupFn; if (settled) cleanupFn(); }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
  const text = buffer.trim();
  if (!text) throw new Error('本地模型没有返回正文');
  return text;
}

/** 从模型输出里抠出第一个 JSON 对象（本地模型常带前后解释）。 */
export function extractJsonObject(text: string): any | null {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 把云端失败原因压成一句给用户看的话（不泄露请求体）。 */
export function cloudFailureReason(error: unknown): string {
  const raw = String((error as any)?.message || error || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '云端不可用';
  if (/402|Insufficient Balance|余额|额度/i.test(raw)) return '云端账户额度不足（HTTP 402）';
  if (/401|invalid_api_key|Unauthorized|鉴权/i.test(raw)) return '云端 API Key 无效或已过期（HTTP 401）';
  if (/429|rate limit|频率/i.test(raw)) return '云端请求过于频繁（HTTP 429）';
  if (/未配置任何 LLM|API Key 未配置|未配置可用/.test(raw)) return '未配置云端 LLM 供应商';
  if (/HTTP 5\d\d/.test(raw)) return '云端服务异常（HTTP 5xx）';
  return raw.slice(0, 160);
}
