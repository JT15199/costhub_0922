import { describe, expect, it, vi } from 'vitest';

vi.mock('../ollama', () => ({
  startOllamaStream: vi.fn(async (...args: any[]) => {
    args[3]('not-json');
    args[5]();
    return () => {};
  }),
}));

import { compactContext } from '../ai/contextPolicy';

describe('context compaction failure', () => {
  it('falls back to conservative pruning when the summary is invalid', async () => {
    const messages = Array.from({ length: 32 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index} ` + '早期约束与证据 '.repeat(180) })) as any;
    const state = { summary: '旧摘要', sourceEnd: 4 };
    const stats: any[] = [];
    const result = await compactContext(messages, { baseUrl: 'http://localhost:11434', model: 'test', effectiveContext: 8192, maxTokens: 1536, confidence: 'calibrated', checkedAt: 0 }, state, new AbortController().signal, value => stats.push(value));
    expect(result.messages).not.toBe(messages);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.state).toBe(state);
    expect(stats[0]).toMatchObject({ compacted: false, usedModel: false, fallback: 'prune' });
  });
});
