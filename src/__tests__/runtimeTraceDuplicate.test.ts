import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { AiGatewayTraceEvent } from '../ai/gateway';
import type { AgentRequest, RuntimeEvent } from '../ai/runtime/contract';
import { consumeRuntimeTurn, executeByPath } from '../components/ai/runtimeAdapter';
import { summarizeGatewayTrace } from '../components/ai/gatewayTrace';
import { translateRuntimeEventForUi } from '../components/ai/runtimeEventMapper';

const runPiAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../ai/piRuntime', () => ({ runPiAgent: runPiAgentMock }));

const outcome = {
  finalText: 'ok',
  rounds: 1,
  messages: [{ role: 'assistant', content: 'ok' }],
  workingState: { version: 1, items: [], projects: [], files: [], artifacts: [], tasks: [] },
};

const networkOutbound = (requestId: string): AiGatewayTraceEvent => ({
  type: 'network_request', status: 'attempted', outbound: true,
  transport: 'confirmed', channel: 'cloud_tool', route: 'cloud',
  provider: 'cloud', model: 'qwen3:4b', requestId,
});

function makeRequest(onGatewayTrace?: (event: AiGatewayTraceEvent) => void): AgentRequest {
  return {
    sessionId: 1,
    runId: 'r1',
    userMessage: 'hello',
    options: {
      baseUrl: 'http://127.0.0.1:11434',
      backend: 'ollama',
      model: 'qwen3:4b',
      systemPrompt: 'sys',
      tools: [],
      executeTool: async () => ({ ok: true, text: 'ok' }),
      onGatewayTrace,
    },
  };
}

beforeEach(() => {
  runPiAgentMock.mockReset();
  runPiAgentMock.mockResolvedValue(outcome);
});

describe('Runtime gateway event delivery', () => {
  it('removes the duplicate callback source and preserves every real event, including identical ones', async () => {
    const delivered: AiGatewayTraceEvent[] = [];
    const uiHandler = (event: AiGatewayTraceEvent) => delivered.push(event);
    const events = [
      networkOutbound('same-request-id'),
      networkOutbound('same-request-id'), // 内容相同的第二次真实发生，必须保留
      { type: 'route_selected', route: 'cloud', provider: 'cloud', model: 'qwen3:4b' } as AiGatewayTraceEvent,
    ];
    runPiAgentMock.mockImplementation(async (options: any) => {
      for (const event of events) options.onGatewayTrace(event);
      return outcome;
    });

    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(uiHandler), {
      onEvent: event => {
        seen.push(event);
        if (event.type !== 'gateway') return;
        const translated = translateRuntimeEventForUi(event, { backend: 'ollama' });
        if (translated.gateway) uiHandler(translated.gateway);
      },
    });

    // If the old callback still reached the UI, each of these would be delivered twice.
    expect(delivered).toEqual(events);
    expect(seen.filter(event => event.type === 'gateway')).toHaveLength(3);
    const trace = summarizeGatewayTrace(delivered);
    expect(trace.outboundAttemptCount).toBe(2);
    expect(trace.toolRequests).toBe(2);
  });

  it('legacy dispatch keeps the old gateway callback and does not consume Runtime events', async () => {
    const event = networkOutbound('legacy-request');
    const delivered: AiGatewayTraceEvent[] = [];
    const runtimeEvents: RuntimeEvent[] = [];
    const oldGatewayCallback = (value: AiGatewayTraceEvent) => delivered.push(value);
    const result = await executeByPath({
      path: 'legacy',
      request: makeRequest(oldGatewayCallback),
      onEvent: value => runtimeEvents.push(value),
      runLegacy: async () => {
        // Legacy AiPanel passes the original options straight to runPiAgent.
        oldGatewayCallback(event);
        return outcome;
      },
    });

    expect(result.path).toBe('legacy');
    expect(delivered).toEqual([event]);
    expect(runtimeEvents).toEqual([]);
    expect(runPiAgentMock).not.toHaveBeenCalled();
  });
});
