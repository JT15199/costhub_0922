import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { CloudSafeContext } from './cloudContext';
import type { AiNetworkStatus, AiNetworkTraceSink, AiNetworkTransport } from './networkTrace';

export interface CloudProviderRequest {
  model: string;
  context: CloudSafeContext;
  signal?: AbortSignal;
  networkTrace?: AiNetworkTraceSink;
}

export interface CloudProviderResponse {
  text: string;
  usage?: unknown;
  transport?: AiNetworkTransport;
  transported?: boolean;
}

export type CloudProvider = (request: CloudProviderRequest) => Promise<CloudProviderResponse>;

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Adapter for an approved cloud completion. The provider receives no tools. */
export function createCloudProviderStream(modelName: string, context: CloudSafeContext, provider: CloudProvider, onNetwork?: AiNetworkTraceSink, approvedRequestId?: string) {
  return (model: Model<any>, _agentContext: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const modelForRequest = { ...model, id: modelName, name: modelName, provider: 'costhub-cloud', baseUrl: '' } as any;
    let settled = false;
    let text = '';
    const requestId = approvedRequestId || crypto.randomUUID();
    let networkStatus: AiNetworkStatus | undefined;
    const traceNetwork = (status: AiNetworkStatus, outbound: boolean, error?: string, transport?: AiNetworkTransport) => {
      networkStatus = status;
      onNetwork?.({ type: 'network_request', channel: 'main_model', route: 'cloud', provider: 'cloud', model: modelName, requestId, status, outbound, ...(transport === undefined ? {} : { transport, transported: transport === 'confirmed' }), ...(error ? { error } : {}) });
    };
    const partial = (stopReason: AssistantMessage['stopReason'] = 'pending'): AssistantMessage => ({ role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: modelForRequest.api, provider: modelForRequest.provider, model: modelForRequest.id, usage: emptyUsage(), stopReason, timestamp: Date.now() } as any);
    const finishError = (message: string, aborted = false, transport: AiNetworkTransport = networkStatus === 'attempted' ? 'unknown' : 'not_sent') => {
      if (settled) return;
      settled = true;
      if (networkStatus !== 'succeeded') traceNetwork(aborted ? 'cancelled' : 'failed', networkStatus === 'attempted', message, transport);
      const error = partial(aborted ? 'aborted' : 'error');
      (error as any).errorMessage = message;
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error } as any);
      stream.end(error);
    };
    const onAbort = () => finishError('云端请求已取消', true);
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    stream.push({ type: 'start', partial: partial() } as any);
    void (async () => {
      try {
        if (options?.signal?.aborted) return onAbort();
        traceNetwork('attempted', true, undefined, 'unknown');
        const result = await provider({ model: modelName, context, signal: options?.signal });
        if (settled || options?.signal?.aborted) return onAbort();
        traceNetwork('succeeded', true, undefined, result.transport || (result.transported === false ? 'unknown' : 'confirmed'));
        if (!String(result?.text || '').trim()) return finishError('云端 Provider 返回空内容');
        text = String(result.text);
        stream.push({ type: 'text_start', contentIndex: 0, partial: partial() } as any);
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: partial() } as any);
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: partial() } as any);
        settled = true;
        const message = { ...partial('stop'), usage: result.usage || emptyUsage() } as any;
        stream.push({ type: 'done', reason: 'stop', message } as any);
        stream.end(message);
      } catch (error) {
        finishError(String((error as Error)?.message || error).slice(0, 400), false, (error as any)?.transport || ((error as any)?.transported ? 'confirmed' : undefined));
      } finally {
        options?.signal?.removeEventListener('abort', onAbort);
      }
    })();
    return stream;
  };
}
