import { expect, it } from 'vitest';
import { buildLocalContext, projectWorkingState } from '../ai/contextBuilder';
import { emptyWorkingState } from '../ai/workingState';

it('creates a non-destructive local projection for the current Pi context', () => {
  const messages = [{ role: 'user', content: '保留原始会话' }] as any;
  const tools = [{ name: 'result_read' }] as any;
  const context = { systemPrompt: '本地规则', messages, tools } as any;
  const projection = buildLocalContext(context);

  expect(projection).toMatchObject(context);
  expect(projection.messages).toEqual(messages);
  expect(projection.tools).toEqual(tools);
  expect(projection.messages).not.toBe(messages);
  expect(projection.tools).not.toBe(tools);
});

it('injects bounded structured state without mutating the raw transcript', () => {
  const messages = [{ role: 'user', content: '原始请求' }] as any;
  const state = emptyWorkingState('session-1');
  state.currentTask = '核对 M270 报价';
  state.decisions = [{ id: 'decision-1', text: '已确定使用 Pi', sourceMessageIds: ['m1'], sensitivity: 'internal', confidence: 'confirmed', status: 'active', priority: 'critical', provenance: { sourceType: 'user_message', sensitivity: 'internal', cloudSafe: false, priority: 'critical', sourceIds: ['m1'] } }];
  const projection = buildLocalContext({ systemPrompt: '', messages, tools: [] } as any, state);

  expect((projection.messages[0] as any).content[0].text).toContain('核对 M270 报价');
  expect((projection.messages[0] as any).content[0].text).toContain('已确定使用 Pi');
  expect(messages).toEqual([{ role: 'user', content: '原始请求' }]);
  expect(projection.messages.at(-1)).toBe(messages[0]);
});

it('keeps every visible critical fact instead of silently applying the eight-item cap', () => {
  const state = emptyWorkingState('critical-facts');
  state.confirmedFacts = Array.from({ length: 9 }, (_, index) => ({
    id: `critical-${index}`,
    text: `关键事实 ${index + 1}`,
    sourceMessageIds: [`m-${index}`],
    sensitivity: 'internal' as const,
    confidence: 'confirmed' as const,
    status: 'active' as const,
    priority: 'critical' as const,
    provenance: { sourceType: 'user_message', sensitivity: 'internal' as const, cloudSafe: false, priority: 'critical' as const, sourceIds: [`m-${index}`] },
  }));

  const projection = projectWorkingState(state);
  expect(projection.criticalRequired).toBe(9);
  expect(projection.criticalIncluded).toBe(9);
  expect(projection.text).toContain('关键事实 9');
});

it('reports optional facts omitted only when the character budget omits them', () => {
  const state = emptyWorkingState('optional-facts');
  state.confirmedFacts = Array.from({ length: 33 }, (_, index) => ({
    id: `fact-${index}`,
    text: `普通事实 ${index + 1}`,
    sourceMessageIds: [`m-${index}`],
    sensitivity: 'internal' as const,
    confidence: 'confirmed' as const,
    status: 'active' as const,
    priority: 'normal' as const,
    provenance: { sourceType: 'user_message', sensitivity: 'internal' as const, cloudSafe: false, priority: 'normal' as const, sourceIds: [`m-${index}`] },
  }));

  const projection = projectWorkingState(state, 100000);
  expect(projection.included).toHaveLength(33);
  expect(projection.omitted).toHaveLength(0);
});
