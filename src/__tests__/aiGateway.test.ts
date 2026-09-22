import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createCostHubPiStream: vi.fn() }));
vi.mock('../ai/piStream', () => ({ createCostHubPiStream: mocks.createCostHubPiStream }));

import { createAiGatewayStream, resolveAiGatewayConfig } from '../ai/gateway';

describe('AI Gateway Phase 1 local pass-through', () => {
  it('selects the existing local provider and preserves its stream', () => {
    const stream = {} as ReturnType<typeof createAiGatewayStream>;
    const onUsage = vi.fn();
    const trace = vi.fn();
    mocks.createCostHubPiStream.mockReturnValue(stream);

    const actual = createAiGatewayStream({ baseUrl: 'http://127.0.0.1:11434', model: 'test', onUsage }, { onEvent: trace });

    expect(actual).toBe(stream);
    expect(resolveAiGatewayConfig()).toEqual({ route: 'local', backend: 'ollama' });
    expect(mocks.createCostHubPiStream).toHaveBeenCalledWith(
      'http://127.0.0.1:11434',
      'test',
      expect.objectContaining({ onUsage, onContextUsage: expect.any(Function) }),
      'ollama',
    );
    expect(trace).toHaveBeenCalledWith({ type: 'route_selected', route: 'local', provider: 'ollama', model: 'test' });
    const usage = { contextWindow: 8192, currentTokens: 100, systemTokens: 20, messageTokens: 50, toolResultTokens: 10, toolSchemaTokens: 20, reservedOutput: 2048, safetyMargin: 655, inputHard: 5489, inputSoft: 4391, inputUtilization: 100 / 5489, largestSource: 'messages' } as const;
    mocks.createCostHubPiStream.mock.calls[0][2].onContextUsage(usage);
    expect(trace).toHaveBeenCalledWith({ type: 'context_usage', route: 'local', provider: 'ollama', model: 'test', usage });
    const decision = { classification: 'sensitive', candidateRoute: 'local', cloudSafe: false, reasonCode: 'source_policy:private_workspace', sourceTypes: ['private_workspace'], regexMatches: [], classifierUsed: false } as const;
    mocks.createCostHubPiStream.mock.calls[0][2].onPrivacy(decision);
    expect(trace).toHaveBeenCalledWith({ type: 'privacy_evaluation', route: 'local', provider: 'ollama', model: 'test', decision });
  });

  it('preserves the configured llama.cpp backend', () => {
    mocks.createCostHubPiStream.mockReturnValue({});

    createAiGatewayStream({ baseUrl: 'http://127.0.0.1:8080', model: 'test', backend: 'llama.cpp' });

    expect(resolveAiGatewayConfig('llama.cpp')).toEqual({ route: 'local', backend: 'llama.cpp' });
    expect(mocks.createCostHubPiStream).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8080',
      'test',
      undefined,
      'llama.cpp',
    );
  });
});
