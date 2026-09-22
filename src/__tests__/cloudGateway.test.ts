import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ localStream: {} }));
vi.mock('../ai/piStream', () => ({ createCostHubPiStream: vi.fn(() => mocks.localStream) }));

import { createAiGatewayStream } from '../ai/gateway';
import { CLOUD_SYSTEM_PROMPT, type CloudSafeContext } from '../ai/cloudContext';

const context: CloudSafeContext = { systemPrompt: CLOUD_SYSTEM_PROMPT, workingState: [], messages: [{ id: 'm1', role: 'user', content: '公开趋势' }], retrieved: [], tools: [] };
const decision = { classification: 'public' as const, candidateRoute: 'cloud_candidate' as const, cloudSafe: true, reasonCode: 'classifier_explicit_public_source', sourceTypes: ['public_market_data'], regexMatches: [], classifierUsed: true };

describe('Cloud Gateway Phase 7', () => {
  it('passes only the CloudSafe projection to an explicit cloud provider', async () => {
    const provider = vi.fn(async input => {
      expect(input.context.tools).toEqual([]);
      expect(JSON.stringify(input.context)).not.toContain('local_file');
      return { text: '公开信息结论' };
    });
    const trace = vi.fn();
    const streamFn = createAiGatewayStream({ baseUrl: '', route: 'cloud', model: 'public-model', cloud: { context, privacyDecision: decision, provider } }, { onEvent: trace });
    const result = await streamFn({ api: 'costhub' } as any, {} as any, {} as any).result();
    expect(result.content).toEqual([{ type: 'text', text: '公开信息结论' }]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: 'route_selected', route: 'cloud', provider: 'cloud' }));
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: 'privacy_evaluation', route: 'cloud', provider: 'cloud', decision }));
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: 'cloud_context', publicMessages: 1, retrieved: 0, tools: 0, outboundCount: null, outboundStatus: 'not_attempted' }));
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: 'network_request', channel: 'main_model', status: 'attempted', outbound: true, transported: false }));
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: 'network_request', channel: 'main_model', status: 'succeeded', outbound: true, transported: true }));
  });

  it('does not call a cloud provider and falls back to local on a non-public decision', () => {
    const provider = vi.fn(async () => ({ text: 'must not send' }));
    const streamFn = createAiGatewayStream({ baseUrl: '', route: 'cloud', model: 'public-model', cloud: { context, privacyDecision: { ...decision, classification: 'unknown', candidateRoute: 'local', cloudSafe: false, reasonCode: 'classifier_error' }, provider } });
    expect(streamFn).toBe(mocks.localStream);
    expect(provider).not.toHaveBeenCalled();
  });
});
