import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { startOllamaStream } from '../ollama';
import { contextBudget, estimateContextTokens, estimateContextUsage, estimateTokens, type ModelProfile } from './modelProfile';
import type { DataSensitivity } from './contextMetadata';
import type { WorkingState } from './workingState';
import { buildLocalContext, projectWorkingState } from './contextBuilder';
import { buildCompactionInstruction, frameCheckpoint, missingCheckpointSections, checkpointBodyLength, COMPACTION_SECTIONS } from './compactionCheckpoint';

export type CompactionLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface CompactionPolicy {
  yellowRatio: number;
  orangeRatio: number;
  redRatio: number;
  recentTargetRatio: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  yellowRatio: 0.6,
  orangeRatio: 0.75,
  redRatio: 0.85,
  recentTargetRatio: 0.6,
};

export interface CompactionStats {
  compacted: boolean;
  sourceMessages: number;
  keptMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  sourceStart: number;
  sourceEnd: number;
  usedModel: boolean;
  error?: string;
  level?: CompactionLevel;
  utilization?: number;
  fallback?: 'prune';
  statePreserved?: boolean;
  criticalFacts?: number;
  decisions?: number;
  criticalFactsRequired?: number;
  criticalFactsIncluded?: number;
}

export interface CompactionState {
  summary: string;
  sourceEnd: number;
  summaryVersion?: number;
  coveredMessageRange?: { start: number; end: number };
  createdAt?: number;
  sensitivity?: DataSensitivity;
  workingState?: WorkingState;
}

export interface CompactionContext {
  systemPrompt?: string;
  tools?: unknown[];
  workingState?: WorkingState;
  policy?: Partial<CompactionPolicy>;
  /** Manual compaction ignores the green/yellow watermarks and forces a structured summary. */
  force?: boolean;
  /** 本次会话是否已有旧检查点（决定摘要指令是否要求"合并旧检查点"）。 */
  hasPriorCheckpoint?: boolean;
}

const messageText = (message: any, preserveThinking = false) => Array.isArray(message?.content)
  ? message.content.map((part: any) => part?.type === 'text' ? part.text : (part?.type === 'thinking' && preserveThinking ? part.thinking : (part?.type === 'toolCall' ? `[tool:${part.name}] ${JSON.stringify(part.arguments || {})}` : ''))).join('')
  : String(message?.content ?? '');

const render = (message: any, preserveThinking = false) => `${message.role}: ${messageText(message, preserveThinking)}`;
const isToolResult = (message: any) => message?.role === 'toolResult';

export function classifyCompactionLevel(utilization: number, policy: Partial<CompactionPolicy> = {}): CompactionLevel {
  const resolved = { ...DEFAULT_COMPACTION_POLICY, ...policy };
  const ratio = Number.isFinite(utilization) ? Math.max(0, utilization) : 1;
  if (ratio < resolved.yellowRatio) return 'green';
  if (ratio < resolved.orangeRatio) return 'yellow';
  if (ratio < resolved.redRatio) return 'orange';
  return 'red';
}

function cloneTextMessage(message: AgentMessage, text: string): AgentMessage {
  return { ...(message as any), content: [{ type: 'text', text }] } as AgentMessage;
}

function hasToolCall(message: any): boolean {
  return message?.role === 'assistant' && Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'toolCall');
}

/** Safe, non-summary cleanup used at the yellow watermark. */
export function lightPruneMessages(messages: AgentMessage[]): AgentMessage[] {
  const lastUser = [...messages].map((message, index) => message?.role === 'user' ? index : -1).reduce((max, index) => Math.max(max, index), -1);
  const protectedStart = Math.max(lastUser, messages.length - 8);
  const seenResults = new Set<string>();
  let changed = false;
  const next = messages.map((message, index) => {
    if (index >= protectedStart) return message;
    if (isToolResult(message)) {
      const key = `${String((message as any).toolName || '')}:${messageText(message)}`;
      if (key.length > 1 && seenResults.has(key)) {
        changed = true;
        return cloneTextMessage(message, '重复 Tool Result 已折叠；原始结果仍保留在本地 Session。');
      }
      if (key.length > 1) seenResults.add(key);
    }
    if (message?.role === 'assistant' && !hasToolCall(message)) {
      const text = messageText(message);
      if (text.length > 900 && /^(好的|明白|收到|我会|接下来|正在|下面)/u.test(text)) {
        changed = true;
        return cloneTextMessage(message, `${text.slice(0, 360)}\n[低信息量 assistant 文本已折叠；原始 Session 保留]`);
      }
    }
    return message;
  });
  return changed ? next : messages;
}

/**
 * 校验摘要：必须是"检查点"格式。
 * 移植 DSH 的 fail-closed 原则——章节缺失/正文为空都算失败，不提交压缩结果。
 * 与旧实现（7 字段严格 JSON）的区别：不再因为"JSON 少一个键"就整体拒绝，改成结构性检查 + 明确报错。
 */
export function validateSummary(output: string): string {
  const text = String(output || '').trim();
  if (!text) throw new Error('摘要为空');
  if (checkpointBodyLength(text) < 40) throw new Error('摘要正文过短（只有章节标题），未提交压缩结果');
  const missing = missingCheckpointSections(text);
  if (missing.length === COMPACTION_SECTIONS.length) throw new Error('摘要不是检查点格式（未包含任何规定章节）');
  return text;
}

export function buildCompactionSource(messages: AgentMessage[], state: CompactionState | undefined, prefixEnd: number): AgentMessage[] {
  return state?.summary
    ? [{ role: 'user', content: state.summary } as unknown as AgentMessage, ...messages.slice(1, prefixEnd)]
    : messages.slice(0, prefixEnd);
}

function safeTail(messages: AgentMessage[], targetTokens: number, preserveThinking = false): { start: number; messages: AgentMessage[] } {
  let start = messages.length;
  let total = 0;
  while (start > 0 && total < targetTokens) {
    start--;
    total += estimateTokens(render(messages[start], preserveThinking));
  }
  // Never leave a tool result without its preceding assistant tool call. Also
  // keep all consecutive results belonging to that call.
  while (start > 0 && isToolResult(messages[start])) start--;
  if (start > 0 && (messages[start] as any)?.role === 'assistant' && Array.isArray((messages[start] as any).content)
    && (messages[start] as any).content.some((part: any) => part?.type === 'toolCall')) {
    while (start > 0 && isToolResult(messages[start - 1])) start--;
  }
  return { start, messages: messages.slice(start) };
}

/**
 * 摘要调用（机制对齐 DSH：把压缩指令作为**最后一条 user 消息**追加在原文之后）。
 * 与旧实现的三处关键差异：
 *   ① json:false —— 现在要的是 Markdown 检查点，不是 JSON。旧实现用 json:true + num_predict≤768，
 *      在 CPU 机器上频繁截断/超时（实测 error:"摘要模型请求超时或已取消"），失败即退化成剪枝 = "压缩没作用"。
 *   ② num_predict 不设小值截断（用户红线：本地 AI 不截断，让他思考）；截断仍按 fail-closed 处理。
 *   ③ 超时改为**惰性看门狗**（默认 180s 完全无输出才放弃，有 token 无限等），不再硬性 240s 掐断慢模型。
 */
async function summarize(baseUrl: string, model: string, messages: AgentMessage[], profile: ModelProfile, signal: AbortSignal, hasPriorCheckpoint = false): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let output = '';
  let truncated = false;
  let cleanup: (() => void) | undefined;
  let lastOutputAt = Date.now();
  const noOutputMs = 180_000;
  const watchdog = setInterval(() => {
    if (Date.now() - lastOutputAt > noOutputMs) controller.abort();
  }, 1000);
  try {
    if (signal.aborted) throw new Error('摘要模型请求已取消');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      };
      void startOllamaStream(baseUrl, model,
        // 不另起一套 system：直接沿用会话原文 + 末尾的压缩指令（DSH 的做法，保持同一份前缀）。
        [{ role: 'user', content: `${messages.map(message => render(message, profile.preserveThinking)).join('\n\n')}\n\n---\n\n${buildCompactionInstruction(hasPriorCheckpoint)}` }],
        token => { lastOutputAt = Date.now(); output += token; }, () => {}, () => finish(), error => finish(error),
        { endpoint: 'native', backend: profile.backend, json: false, think: false, num_ctx: profile.effectiveContext, num_predict: 16384, onTruncated: () => { truncated = true; }, signal: controller.signal })
        .then(stop => { cleanup = stop; if (settled) stop(); })
        .catch(finish);
      controller.signal.addEventListener('abort', () => finish(new Error(`摘要模型 ${Math.round(noOutputMs / 1000)} 秒没有任何输出（模型可能在加载或异常），已放弃本次压缩；原始历史未改动`)), { once: true });
    });
    if (truncated) throw new Error('摘要输出因长度截断，未提交压缩结果（可换更强的本地模型或调大有效上下文后重试）');
    return validateSummary(output.trim());
  } finally {
    clearInterval(watchdog);
    cleanup?.();
    signal.removeEventListener('abort', abort);
  }
}

function interactionGroups(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  for (const message of messages) {
    const previous = groups[groups.length - 1];
    const isToolCall = message?.role === 'assistant' && Array.isArray((message as any).content)
      && (message as any).content.some((part: any) => part?.type === 'toolCall');
    if (isToolCall || (message?.role === 'toolResult' && previous?.[0]?.role === 'assistant')) {
      if (message?.role === 'toolResult' && previous?.[0]?.role === 'assistant') previous.push(message);
      else groups.push([message]);
    } else groups.push([message]);
  }
  return groups;
}

function splitSource(messages: AgentMessage[], targetTokens: number, preserveThinking = false): AgentMessage[][] {
  const chunks: AgentMessage[][] = [];
  let chunk: AgentMessage[] = [];
  let tokens = 0;
  for (const group of interactionGroups(messages)) {
    const groupTokens = group.reduce((sum, message) => sum + estimateTokens(render(message, preserveThinking)), 0);
    if (groupTokens > targetTokens) throw new Error('单个工具交互超过模型输入预算，未提交压缩请求');
    if (chunk.length && tokens + groupTokens > targetTokens) {
      chunks.push(chunk);
      chunk = [];
      tokens = 0;
    }
    chunk.push(...group);
    tokens += groupTokens;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function summarizeSource(baseUrl: string, model: string, source: AgentMessage[], profile: ModelProfile, targetTokens: number, signal: AbortSignal, hasPriorCheckpoint = false): Promise<string> {
  let pending = splitSource(source, targetTokens, profile.preserveThinking);
  while (pending.length > 1) {
    const summaries: AgentMessage[] = [];
    for (const chunk of pending) {
      if (signal.aborted) throw new Error('摘要模型请求已取消');
      summaries.push({ role: 'user', content: await summarize(baseUrl, model, chunk, profile, signal, hasPriorCheckpoint) } as unknown as AgentMessage);
    }
    pending = splitSource(summaries, targetTokens, profile.preserveThinking);
  }
  return summarize(baseUrl, model, pending[0] || [], profile, signal, hasPriorCheckpoint);
}

export async function compactContext(messages: AgentMessage[], profile: ModelProfile, state: CompactionState | undefined, signal: AbortSignal, onStats?: (stats: CompactionStats) => void, context: CompactionContext = {}): Promise<{ messages: AgentMessage[]; state?: CompactionState }> {
  const budget = contextBudget(profile.effectiveContext, profile.maxTokens);
  const project = (nextMessages: AgentMessage[]) => buildLocalContext({ systemPrompt: context.systemPrompt || '', messages: nextMessages, tools: context.tools || [] } as any, context.workingState);
  const projectedMessages = project(messages).messages;
  const stateOnlyMessages = project([]).messages;
  const stateTokens = estimateContextTokens('', stateOnlyMessages, []);
  const fixedTokens = estimateTokens(context.systemPrompt || '') + estimateTokens(context.tools || []) + (projectedMessages.length > messages.length ? stateTokens : 0);
  // The provider receives the Local projection, so its Working State injection
  // must be included before deciding whether the active context is safe.
  const usage = estimateContextUsage(context.systemPrompt || '', projectedMessages, context.tools || [], budget.contextWindow, profile.maxTokens, profile.preserveThinking);
  const projectedTokens = (nextMessages: AgentMessage[]) => estimateContextTokens(context.systemPrompt || '', project(nextMessages).messages, context.tools || [], profile.preserveThinking);
  const fitProjected = (candidate: AgentMessage[]) => {
    let next = candidate;
    while (next.length > 1 && projectedTokens(next) > budget.inputHard) {
      let drop = 1;
      if (next[0]?.role === 'assistant' && hasToolCall(next[0])) while (drop < next.length && isToolResult(next[drop])) drop++;
      next = next.slice(drop);
    }
    return next;
  };
  const policy = { ...DEFAULT_COMPACTION_POLICY, ...(context.policy || {}) };
  const detectedLevel = classifyCompactionLevel(usage.inputUtilization, policy);
  const level: CompactionLevel = context.force
    ? (detectedLevel === 'green' || detectedLevel === 'yellow' ? 'orange' : detectedLevel)
    : detectedLevel;
  const tokensBefore = usage.currentTokens;
  const stateProjection = projectWorkingState(context.workingState);
  // Count the state that the provider actually receives, not raw state rows
  // that may belong to another project or be outside the projection budget.
  const criticalFacts = stateProjection.criticalIncluded;
  const criticalFactsRequired = stateProjection.criticalRequired;
  const decisions = context.workingState?.decisions.filter(item => item.status === 'active').length || 0;
  const keepState = (next: CompactionState | undefined) => context.workingState && next ? { ...next, workingState: context.workingState } : next;
  if (level === 'green') return { messages, state: keepState(state) };
  if (level === 'yellow') {
    const pruned = lightPruneMessages(messages);
    if (pruned !== messages) onStats?.({ compacted: false, sourceMessages: messages.length, keptMessages: pruned.length, tokensBefore, tokensAfter: estimateContextTokens(context.systemPrompt || '', project(pruned).messages, context.tools || [], profile.preserveThinking), sourceStart: 0, sourceEnd: 0, usedModel: false, level, utilization: usage.inputUtilization, statePreserved: Boolean(context.workingState), criticalFacts, criticalFactsRequired, criticalFactsIncluded: criticalFacts, decisions });
    return { messages: pruned, state: keepState(state) };
  }
  const tailBudget = budget.inputHard - fixedTokens;
  const fallbackPrune = () => {
    const target = Math.max(1, Math.min(Math.floor(budget.inputHard * policy.recentTargetRatio), Math.max(1, tailBudget)));
    const tail = safeTail(messages, target, profile.preserveThinking);
    const summaryMessage = state?.summary ? [{ role: 'user', content: state.summary } as unknown as AgentMessage] : [];
    return fitProjected([...summaryMessage, ...tail.messages]);
  };
  const reportFailure = (error: string) => {
    const fallback = fallbackPrune();
    onStats?.({ compacted: false, sourceMessages: messages.length, keptMessages: fallback.length, tokensBefore, tokensAfter: estimateContextTokens(context.systemPrompt || '', project(fallback).messages, context.tools || [], profile.preserveThinking), sourceStart: 0, sourceEnd: 0, usedModel: false, error, level, utilization: usage.inputUtilization, fallback: 'prune', statePreserved: Boolean(context.workingState), criticalFacts, criticalFactsRequired, criticalFactsIncluded: criticalFacts, decisions });
    return { messages: fallback, state: keepState(state) };
  };
  if (tailBudget <= 0) return reportFailure('系统提示和工具 schema 已超过模型输入预算，已保留最小近期窗口');
  // ⚠️ 2026-09-21 修复"压缩了但上下文没变小"（实测 tokensBefore 5805 → tokensAfter 5882，越压越大）：
  // 旧目标 min(0.6·inputHard, 可用空间) 只保证"不超过硬上限"，压完仍停在 yellow/orange 触发带内，
  // 于是下一轮立刻再次触发摘要，每轮净收益 ≈ 0。现在把目标定在 **yellow 水位以下并留 20% 余量**，
  // 并且要求**最小收益**（至少省 10%），达不到就放弃并如实报错——不报告假的"已压缩"。
  const yellowTokens = Math.floor(budget.inputHard * policy.yellowRatio);
  const targetAfterSummary = Math.max(1, Math.floor(yellowTokens * 0.8) - fixedTokens);
  const recentTarget = Math.max(1, Math.min(targetAfterSummary, Math.floor(tailBudget * policy.recentTargetRatio), tailBudget));
  const tail = safeTail(messages, recentTarget, profile.preserveThinking);
  const prefixEnd = tail.start;
  if (prefixEnd <= 0) return reportFailure('单条消息超过模型输入预算，已保留最小近期窗口');
  // After the first pass, index 0 is the previous summary and the remaining
  // messages are the retained tail plus new work. Reusing the old absolute
  // sourceEnd here can skip that tail on the next pass.
  const source = buildCompactionSource(messages, state, prefixEnd);
  const hasPriorCheckpoint = context.hasPriorCheckpoint ?? Boolean(state?.summary);
  const instructionTokens = estimateTokens(buildCompactionInstruction(hasPriorCheckpoint));
  let summary = state?.summary || '';
  let usedModel = false;
  let error: string | undefined;
  try {
    const sourceBudget = budget.inputHard - fixedTokens - instructionTokens - 64;
    if (sourceBudget <= 0) throw new Error('摘要提示和工具 schema 已超过模型输入预算');
    summary = await summarizeSource(profile.baseUrl, profile.model, source, profile, sourceBudget, signal, hasPriorCheckpoint);
    usedModel = true;
  } catch (cause) {
    error = String((cause as Error)?.message || cause).slice(0, 240);
    return reportFailure(error);
  }
  // qwythos-9b's native template requires a real user query after tool turns;
  // a compacted summary is the replacement query, not an assistant answer.
  const checkpointText = `${frameCheckpoint(summary)}\n\n（更早的原始消息仍完整保留在本机会话历史里，需要细节时可用 search_history / read_evidence 找回。）`;
  const compacted: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: checkpointText }], timestamp: Date.now() } as unknown as AgentMessage, ...tail.messages];
  const tokensAfter = estimateContextTokens(context.systemPrompt || '', project(compacted).messages, context.tools || [], profile.preserveThinking);
  if (tokensAfter > budget.inputHard) return reportFailure(`压缩后上下文仍超过模型输入预算（${tokensAfter}/${budget.inputHard}）`);
  // 最小收益判据：压不动就别假装压过（否则用户看到"已压缩 X→Y"却毫无变化）。
  const minGain = Math.max(64, Math.floor(tokensBefore * 0.1));
  if (tokensBefore - tokensAfter < minGain) {
    return reportFailure(`当前对话已经足够精简（${tokensBefore} → ${tokensAfter} tokens，未达到最小收益 ${minGain}），无需压缩，已保留原始历史`);
  }
  const stats: CompactionStats = { compacted: true, sourceMessages: messages.length, keptMessages: compacted.length, tokensBefore, tokensAfter, sourceStart: 0, sourceEnd: prefixEnd, usedModel, error, level, utilization: usage.inputUtilization, statePreserved: Boolean(context.workingState), criticalFacts, criticalFactsRequired, criticalFactsIncluded: criticalFacts, decisions };
  onStats?.(stats);
  return {
    messages: compacted,
    state: keepState({ summary, sourceEnd: prefixEnd, summaryVersion: 2, coveredMessageRange: { start: 0, end: prefixEnd - 1 }, createdAt: Date.now(), sensitivity: 'internal' }),
  };
}
