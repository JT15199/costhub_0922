import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { startOllamaStream } from '../ollama';
import { contextBudget, estimateContextUsage } from './modelProfile';
import type { ContextUsage } from './modelProfile';
import type { LocalBackend } from '../localBackend';
import { buildLocalContext } from './contextBuilder';
import { evaluatePrivacy, type PrivacyDecision, type PrivacyEvaluationInput } from './privacyRouter';
import type { AiNetworkTraceSink } from './networkTrace';

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
// Thinking is display-only. Replaying it as assistant.content makes every
// turn pay the reasoning tokens again and can crowd the next answer out.
const textOf = (content: any) => Array.isArray(content) ? content.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join('') : String(content || '');
const imageOf = (content: any): ImageContent[] => Array.isArray(content) ? content.filter((part: any) => part?.type === 'image') : [];

export function toOllamaMessages(context: Context): any[] {
  return context.messages.map((message: any) => {
    if (message.role === 'toolResult') return { role: 'tool', tool_name: message.toolName, content: textOf(message.content), ...(imageOf(message.content).length ? { images: imageOf(message.content).map(image => image.data) } : {}) };
    if (message.role === 'assistant') {
      const toolCalls = (message.content || []).filter((part: any) => part?.type === 'toolCall').map((part: any) => ({ function: { name: part.name, arguments: part.arguments || {} } }));
      return { role: 'assistant', content: textOf(message.content), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    }
    return { role: message.role, content: textOf(message.content), ...(imageOf(message.content).length ? { images: imageOf(message.content).map(image => image.data) } : {}) };
  });
}

export function toLlamaMessages(context: Context, preserveThinking = false): any[] {
  const contentOf = (message: any) => {
    const images = imageOf(message.content);
    return images.length ? [{ type: 'text', text: textOf(message.content) }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : textOf(message.content);
  };
  return context.messages.map((message: any) => {
    if (message.role === 'toolResult') return { role: 'tool', tool_call_id: String(message.toolCallId || ''), content: contentOf(message) };
    if (message.role === 'assistant') {
      const toolCalls = (message.content || []).filter((part: any) => part?.type === 'toolCall').map((part: any, index: number) => ({
        id: String(part.id || message.toolCallId || `pi-tool-${index}`), type: 'function', function: { name: part.name, arguments: JSON.stringify(part.arguments || {}) },
      }));
      const reasoning = (message.content || []).filter((part: any) => part.type === 'thinking').map((part: any) => part.thinking || '').join('');
      return { role: 'assistant', content: textOf(message.content), ...(preserveThinking && reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    }
    return { role: message.role, content: contentOf(message) };
  });
}

function makePartial(model: Model<any>, content: any[] = [], stopReason: AssistantMessage['stopReason'] = 'pending'): AssistantMessage {
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason, timestamp: Date.now() };
}

function ollamaTools(context: Context): any[] | undefined {
  const tools = (context.tools || []).map((tool: any) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  return tools.length ? tools : undefined;
}

export function getPiRequestPolicy(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  const configuredMax = Number(options?.maxTokens) || Number(model.maxTokens) || 0;
  const unlimited = Boolean((model as any).__unlimitedOutput) || configuredMax <= 0;
  const maxTokens = unlimited ? 0 : Math.max(1, configuredMax);
  const contextWindow = Math.max(1024, Number(model.contextWindow) || 8192);
  const budget = contextBudget(contextWindow, maxTokens);
  const requested = maxTokens || undefined;
  const contextUsage = estimateContextUsage(context.systemPrompt || '', context.messages, context.tools || [], contextWindow, maxTokens, Boolean((model as any).preserveThinking));
  return {
    think: options?.reasoning !== undefined && model.reasoning !== false,
    numCtx: contextWindow,
    numPredict: requested,
    contextUsage,
    contextTokens: contextUsage.currentTokens,
    inputHard: budget.inputHard,
  };
}

/** Pi streamFn backed exclusively by the existing Rust http_stream/Ollama path. */
export function createCostHubPiStream(baseUrl: string, modelName: string, hooks?: { onUsage?: (usage: any) => void; onContextUsage?: (usage: ContextUsage) => void; buildContext?: (context: Context) => Context; privacy?: Omit<PrivacyEvaluationInput, 'text'> & { sourceTypesFrom?: (messages: unknown[]) => string[] }; onPrivacy?: (decision: PrivacyDecision) => void; onNetwork?: AiNetworkTraceSink }, backend: LocalBackend = 'ollama') {
  return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const localContext = hooks?.buildContext ? hooks.buildContext(context) : buildLocalContext(context);
    const modelForRequest = { ...model, id: modelName, name: modelName, baseUrl };
    const parts: any[] = [];
    let textIndex = -1;
    let thinkingIndex = -1;
    let toolCallCount = 0;
    let settled = false;
    let truncated = false;
    let measuredUsage = usage();
    const requestId = crypto.randomUUID();
    let requestStarted = false;
    let networkStatus: 'attempted' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | undefined;
    const traceNetwork = (status: typeof networkStatus, error?: string) => {
      networkStatus = status;
      hooks?.onNetwork?.({ type: 'network_request', channel: 'main_model', route: 'local', provider: backend, model: modelName, requestId, status: status!, outbound: false, error });
    };
    const partial = () => ({ ...makePartial(modelForRequest, [...parts]), usage: measuredUsage });
    stream.push({ type: 'start', partial: partial() });
    const addText = (delta: string, thinking = false) => {
      if (!delta) return;
      const indexRef = thinking ? thinkingIndex : textIndex;
      if (indexRef < 0) {
        const index = parts.length;
        parts.push(thinking ? { type: 'thinking', thinking: delta } : { type: 'text', text: delta });
        if (thinking) thinkingIndex = index; else textIndex = index;
        stream.push({ type: thinking ? 'thinking_start' : 'text_start', contentIndex: index, partial: partial() } as any);
      } else if (thinking) parts[indexRef].thinking += delta;
      else parts[indexRef].text += delta;
      stream.push({ type: thinking ? 'thinking_delta' : 'text_delta', contentIndex: thinking ? thinkingIndex : textIndex, delta, partial: partial() } as any);
    };
    const finish = (error?: string, aborted = false) => {
      if (settled) return;
      settled = true;
      traceNetwork(aborted ? 'cancelled' : error ? (requestStarted ? 'failed' : 'blocked') : 'succeeded', error);
      options?.signal?.removeEventListener('abort', onAbort);
      if (error) {
        const message = makePartial(modelForRequest, [...parts], aborted ? 'aborted' : 'error');
        message.usage = measuredUsage;
        message.errorMessage = error;
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
        stream.end(message);
        return;
      }
      if (textIndex >= 0) stream.push({ type: 'text_end', contentIndex: textIndex, content: parts[textIndex].text, partial: partial() } as any);
      if (thinkingIndex >= 0) stream.push({ type: 'thinking_end', contentIndex: thinkingIndex, content: parts[thinkingIndex].thinking, partial: partial() } as any);
      const message = makePartial(modelForRequest, [...parts], truncated ? 'length' : toolCallCount ? 'toolUse' : 'stop');
      message.usage = measuredUsage;
      stream.push({ type: 'done', reason: message.stopReason as any, message });
      stream.end(message);
    };
    const onAbort = () => finish('已取消', true);
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (options?.signal?.aborted) { onAbort(); return stream; }
    const policy = getPiRequestPolicy(modelForRequest, localContext, options);
    hooks?.onContextUsage?.(policy.contextUsage);
    // ⚠️ 2026-09-21：来源标签现在按**本轮真实消息**推导（sourceTypesFrom），不再是一个写死的常量。
    // 只有确实带本地库数据/工具结果时才会命中"来源敏感"，纯用户提问会真正走内容级正则 + 分类器。
    const privacyHook = hooks?.privacy || {};
    const privacySourceTypes = privacyHook.sourceTypesFrom ? privacyHook.sourceTypesFrom(localContext.messages) : privacyHook.sourceTypes;
    hooks?.onPrivacy?.(evaluatePrivacy({
      ...privacyHook,
      sourceTypes: privacySourceTypes,
      text: localContext.messages.map((message: any) => textOf(message.content)).join('\n'),
    }));
    if (policy.contextTokens > policy.inputHard) {
      finish(`上下文超过模型输入预算（${policy.contextTokens}/${policy.inputHard}），未发送请求`);
      return stream;
    }
    requestStarted = true;
    traceNetwork('attempted');
    startOllamaStream(
      baseUrl,
      modelName,
      [{ role: 'system', content: localContext.systemPrompt || '' }, ...(backend === 'llama.cpp' ? toLlamaMessages(localContext, Boolean((model as any).preserveThinking)) : toOllamaMessages(localContext))] as any,
      token => addText(token),
      thinking => addText(thinking, true),
      () => finish(),
      error => finish(String(error || 'Ollama 请求失败').slice(0, 400)),
      {
        endpoint: 'native', backend, think: policy.think, json: false,
        reasoningEffort: (model as any).reasoningEffort, preserveThinking: (model as any).preserveThinking,
        temperature: (model as any).temperature,
        num_predict: policy.numPredict,
        num_ctx: policy.numCtx,
        tools: ollamaTools(localContext), signal: options?.signal,
        onUsage: usageInfo => {
          (modelForRequest as any).__lastUsage = usageInfo;
          measuredUsage.input = usageInfo.promptEvalCount ?? measuredUsage.input;
          measuredUsage.output = usageInfo.evalCount ?? measuredUsage.output;
          measuredUsage.totalTokens = measuredUsage.input + measuredUsage.output;
          if (String(usageInfo?.doneReason || '') === 'length') truncated = true;
          hooks?.onUsage?.(usageInfo);
        },
        onTruncated: () => { truncated = true; },
        onToolCalls: calls => calls.forEach((call: any, index: number) => {
          const fn = call?.function || call || {};
          const name = String(fn.name || '').trim();
          if (!name) { finish('工具调用缺少名称，未执行本轮工具'); return; }
          let args: unknown;
          // Preserve malformed input for Pi's schema validator: it returns an error to the model without executing the tool.
          try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments ?? {}); } catch { args = fn.arguments; }
          const toolCall = { type: 'toolCall', id: String(call?.id || `pi-${Date.now()}-${index}`), name, arguments: args } as any;
          const contentIndex = parts.length;
          parts.push(toolCall);
          toolCallCount++;
          stream.push({ type: 'toolcall_start', contentIndex, partial: partial() } as any);
          stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: partial() } as any);
        }),
      },
    ).catch(error => finish(String(error?.message || error).slice(0, 400)));
    return stream;
  };
}
