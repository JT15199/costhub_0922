import type { LocalBackend, LocalModelOptions } from '../localBackend';

export interface ModelUsage {
  promptEvalCount?: number;
  evalCount?: number;
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalDurationNs?: number;
  evalDurationNs?: number;
  doneReason?: string;
}

export interface ModelProfile extends LocalModelOptions {
  backend?: LocalBackend;
  baseUrl: string;
  model: string;
  digest?: string;
  ollamaVersion?: string;
  advertisedContext?: number;
  effectiveContext: number;
  maxTokens: number;
  confidence: 'uncalibrated' | 'calibrated';
  checkedAt: number;
  lastUsage?: ModelUsage;
}

export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  safetyMargin: number;
  inputHard: number;
  inputSoft: number;
  compactTarget: number;
}

export type ContextSource = 'system' | 'messages' | 'tool_results' | 'tool_schemas';

export interface ContextUsage {
  contextWindow: number;
  currentTokens: number;
  systemTokens: number;
  messageTokens: number;
  workingStateTokens?: number;
  recentMessageTokens?: number;
  toolResultTokens: number;
  retrievedTokens?: number;
  toolSchemaTokens: number;
  toolContextTokens?: number;
  reservedOutput: number;
  safetyMargin: number;
  inputHard: number;
  inputSoft: number;
  inputUtilization: number;
  largestSource: ContextSource;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)) cjk++;
    else if (/[\x00-\x7f]/.test(char)) ascii++;
    else other++;
  }
  // Conservative estimate: CJK and non-ASCII text tokenize more densely than prose.
  return Math.max(1, Math.ceil(cjk * 1.5 + ascii / 4 + other * 1.25));
}

type NormalizedMessage = { message: { role: unknown; content: unknown } | unknown; imageTokens: number };

function normalizeMessages(messages: unknown[], preserveThinking: boolean): NormalizedMessage[] {
  return messages.map((message: any) => {
    if (!Array.isArray(message?.content)) return { message, imageTokens: 0 };
    let imageCount = 0;
    const content = message.content.filter((part: any) => preserveThinking || part?.type !== 'thinking').map((part: any) => {
      if (part?.type !== 'image') return part;
      imageCount++;
      return { type: 'image' };
    });
    return { message: { role: message.role, content }, imageTokens: imageCount * 2048 };
  });
}

function estimateMessageGroup(messages: NormalizedMessage[]): number {
  return estimateTokens(messages.map(entry => entry.message)) + messages.reduce((sum, entry) => sum + entry.imageTokens, 0);
}

function toolSchemaValues(tools: unknown[]): unknown[] {
  return tools.map((tool: any) => ({
    name: tool?.name,
    description: tool?.description,
    parameters: tool?.parameters,
  }));
}

export function estimateContextTokens(systemPrompt: unknown, messages: unknown[], tools: unknown[], preserveThinking = false): number {
  // Reasoning is transient UI detail, not conversation input. Counting it
  // here would trigger compaction for text that is intentionally not sent.
  // Image bytes are not text tokens. Without reliable dimensions, reserve a
  // conservative fixed amount instead of counting base64 characters.
  return estimateTokens(systemPrompt) + estimateMessageGroup(normalizeMessages(messages, preserveThinking)) + estimateTokens(toolSchemaValues(tools));
}

export function estimateContextUsage(systemPrompt: unknown, messages: unknown[], tools: unknown[], contextWindow: number, maxTokens = 0, preserveThinking = false): ContextUsage {
  const budget = contextBudget(contextWindow, maxTokens);
  const normalized = normalizeMessages(messages, preserveThinking);
  const toolResults = normalized.filter(entry => (entry.message as any)?.role === 'toolResult' || (entry.message as any)?.role === 'tool');
  const conversation = normalized.filter(entry => !toolResults.includes(entry));
  const systemTokens = estimateTokens(systemPrompt);
  const messageTokens = estimateMessageGroup(conversation);
  const workingStateTokens = estimateMessageGroup(conversation.filter(entry => {
    const content = (entry.message as any)?.content;
    const text = Array.isArray(content) ? content.map((part: any) => part?.text || '').join('') : String(content || '');
    return text.includes('【CostHub 结构化工作状态】');
  }));
  const toolResultTokens = estimateMessageGroup(toolResults);
  const toolSchemaTokens = estimateTokens(toolSchemaValues(tools));
  const currentTokens = estimateContextTokens(systemPrompt, messages, tools, preserveThinking);
  const sources: [ContextSource, number][] = [
    ['system', systemTokens],
    ['messages', messageTokens],
    ['tool_results', toolResultTokens],
    ['tool_schemas', toolSchemaTokens],
  ];
  const largestSource = sources.reduce((largest, source) => source[1] > largest[1] ? source : largest)[0];
  return {
    contextWindow: budget.contextWindow,
    currentTokens,
    systemTokens,
    messageTokens,
    workingStateTokens,
    recentMessageTokens: Math.max(0, messageTokens - workingStateTokens),
    toolResultTokens,
    // The current local projection has no separate retrieval channel; Tool
    // Results are the observable retrieved evidence for the UI breakdown.
    retrievedTokens: toolResultTokens,
    toolSchemaTokens,
    toolContextTokens: toolSchemaTokens,
    reservedOutput: budget.outputReserve,
    safetyMargin: budget.safetyMargin,
    inputHard: budget.inputHard,
    inputSoft: budget.inputSoft,
    inputUtilization: budget.inputHard ? currentTokens / budget.inputHard : 1,
    largestSource,
  };
}

export function contextBudget(contextWindow: number, maxTokens = 3072): ContextBudget {
  const context = Math.max(1024, Math.floor(contextWindow));
  const outputReserve = maxTokens > 0 ? Math.min(Math.max(1, Math.floor(maxTokens)), Math.floor(context * 0.35)) : Math.min(8192, Math.floor(context * 0.25));
  const safetyMargin = Math.min(Math.max(256, Math.ceil(context * 0.08)), Math.floor(context * 0.2));
  const inputHard = Math.max(1, context - outputReserve - safetyMargin);
  return { contextWindow: context, outputReserve, safetyMargin, inputHard, inputSoft: Math.floor(inputHard * 0.8), compactTarget: Math.floor(inputHard * 0.6) };
}

/**
 * 实际使用的上下文窗口上限（2026-09-21）。
 *
 * 为什么需要：`effectiveContext` 直接取模型**宣称**的上下文（/api/show 的 context_length），
 * 于是 qwen3 系（40960）或 gemma3/llama3.1（131072）的压缩水位线落在 1.7 万 / 6.7 万 token —— 日常会话
 * 永远够不到，自动压缩**从不触发**；而一旦真的超出，Ollama 会从最前面静默截断（用户看到的是"模型忘了前面"）。
 * 用户实测反馈"压缩上下文似乎没有作用"，有一半来自这里。
 *
 * 现在按 32768 封顶：num_ctx 请求值、水位线与预算都基于这个可达到的窗口计算；
 * KV 显存/内存占用也随之落在 CPU 机器可承受的范围。要放开就改这个常量（并在设置页说明）。
 */
export const LOCAL_CONTEXT_CAP = 32768;

export function createModelProfile(baseUrl: string, model: string, advertisedContext?: number): ModelProfile {
  // qwen3:4b is currently measured at 8192 on the target machine; larger values must be promoted only by a real calibration run.
  // Do not bake this machine's slow-model budget into every installation.
  // An unset output limit is passed through to the local backend.
  const advertised = Number.isFinite(advertisedContext) && Number(advertisedContext) >= 1024 ? Math.floor(Number(advertisedContext)) : 8192;
  const effectiveContext = Math.min(advertised, LOCAL_CONTEXT_CAP);
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, advertisedContext, effectiveContext, maxTokens: 0, confidence: 'uncalibrated', checkedAt: Date.now() };
}

export function profileKey(profile: Pick<ModelProfile, 'baseUrl' | 'model' | 'digest' | 'ollamaVersion'>) {
  return [profile.baseUrl.replace(/\/$/, ''), profile.model, profile.digest || '', profile.ollamaVersion || ''].join('|');
}
