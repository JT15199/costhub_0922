import { describe, expect, it } from 'vitest';
import { getPiRequestPolicy, toOllamaMessages } from '../ai/piStream';

const model = { reasoning: true, contextWindow: 16384, maxTokens: 4096 } as any;

describe('Pi request policy', () => {
  it('honors thinking and uses the model budget instead of a global 768 cap', () => {
    const policy = getPiRequestPolicy(model, { systemPrompt: '', messages: [{ role: 'user', content: '分析' }], tools: [] } as any, { reasoning: 'medium' } as any);
    expect(policy.think).toBe(true);
    expect(policy.numPredict).toBeGreaterThan(768);
  });

  it('gives the final answer the full configured output budget after tool results', () => {
    const policy = getPiRequestPolicy(model, { systemPrompt: '', messages: [{ role: 'toolResult', content: '真实结果' }], tools: [] } as any, { reasoning: undefined } as any);
    expect(policy.think).toBe(false);
    expect(policy.numPredict).toBe(4096);
  });

  it('does not add an artificial output cap when none is configured', () => {
    const policy = getPiRequestPolicy({ ...model, maxTokens: 0 }, { systemPrompt: '', messages: [{ role: 'user', content: '继续' }], tools: [] } as any, { reasoning: 'medium' } as any);
    expect(policy.numPredict).toBeUndefined();
  });

  it('does not replay private thinking as assistant input', () => {
    const messages = toOllamaMessages({ messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: '很长的内部推理' },
      { type: 'text', text: '最终答案' },
    ] }], tools: [] } as any);
    expect(messages[0].content).toBe('最终答案');
    expect(JSON.stringify(messages)).not.toContain('很长的内部推理');
  });
});
