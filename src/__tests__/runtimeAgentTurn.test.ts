import { describe, it, expect, vi, beforeEach } from 'vitest';

// 只替换执行器，不碰其他依赖：本文件验证的是「包一层」的正确性，
// 不是 piRuntime 自身的行为（那由既有测试覆盖）。
const runPiAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../ai/piRuntime', () => ({ runPiAgent: runPiAgentMock }));

import { runAgentTurn, collectAgentTurn } from '../ai/runtime/session';
import { resolveBudget, describeBudget, needsCompaction, FALLBACK_CONTEXT_WINDOW } from '../ai/runtime/budget';
import type { AgentRequest, RuntimeEvent } from '../ai/runtime/contract';

/** 构造一个最小可用请求；options 里刻意带上全部回调，用来验证转发。 */
function makeRequest(overrides: { runId?: string; options?: Record<string, unknown> } = {}): AgentRequest {
  return {
    sessionId: 7,
    runId: overrides.runId ?? 'run-1',
    userMessage: '分析 M270 的驱动板成本',
    intent: 'analysis',
    options: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:4b',
      systemPrompt: '你是成本分析助手',
      tools: [],
      executeTool: async () => ({ ok: true, text: 'ok' }),
      ...(overrides.options || {}),
    },
  };
}

const outcome = {
  finalText: '驱动板 ¥85.00 偏高。',
  rounds: 2,
  messages: [{ role: 'assistant', content: '驱动板 ¥85.00 偏高。' }],
  workingState: { version: 1, items: [], projects: [], files: [], artifacts: [], tasks: [] },
};

beforeEach(() => {
  runPiAgentMock.mockReset();
  runPiAgentMock.mockResolvedValue(outcome);
});

describe('runtime/budget — 上下文预算口径', () => {
  it('调用方显式指定窗口时视为已标定，不留回落标记', () => {
    const report = resolveBudget({ contextWindow: 16384, maxTokens: 2048 });
    expect(report.effectiveContext).toBe(16384);
    expect(report.calibrated).toBe(true);
    expect(report.fallbackUsed).toBeNull();
    expect(report.unlimitedOutput).toBe(false);
  });

  it('有 profile 且 confidence=calibrated 时视为已标定', () => {
    const report = resolveBudget({ profile: { effectiveContext: 32768, maxTokens: 4096, confidence: 'calibrated' } });
    expect(report.effectiveContext).toBe(32768);
    expect(report.calibrated).toBe(true);
    expect(report.fallbackUsed).toBeNull();
  });

  it('profile 存在但 confidence 非 calibrated 时不算已标定', () => {
    const report = resolveBudget({ profile: { effectiveContext: 32768, maxTokens: 0, confidence: 'uncalibrated' } });
    expect(report.effectiveContext).toBe(32768);
    expect(report.calibrated).toBe(false);
  });

  it('完全缺失标定信息时回落到默认窗口，并显式记录回落值', () => {
    const report = resolveBudget({});
    expect(report.effectiveContext).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(report.calibrated).toBe(false);
    expect(report.fallbackUsed).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  it('非法窗口（过小/NaN）不参与生效，退到回落并标记', () => {
    expect(resolveBudget({ contextWindow: 100 }).effectiveContext).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveBudget({ contextWindow: Number.NaN }).effectiveContext).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveBudget({ contextWindow: 100 }).calibrated).toBe(false);
  });

  it('maxTokens<=0 表示不截断输出（用户红线）', () => {
    expect(resolveBudget({ contextWindow: 16384 }).unlimitedOutput).toBe(true);
    expect(resolveBudget({ contextWindow: 16384, maxTokens: 0 }).unlimitedOutput).toBe(true);
    expect(resolveBudget({ contextWindow: 16384, maxTokens: 512 }).unlimitedOutput).toBe(false);
  });

  it('预算是纯函数：同输入必得同输出', () => {
    const input = { contextWindow: 16384, maxTokens: 1024 };
    expect(resolveBudget(input)).toEqual(resolveBudget(input));
  });

  it('describeBudget 明确指出是否回落（避免"压缩为何过早"只能靠读代码）', () => {
    expect(describeBudget(resolveBudget({ contextWindow: 16384 }))).toContain('来自模型标定');
    expect(describeBudget(resolveBudget({}))).toContain(String(FALLBACK_CONTEXT_WINDOW));
    expect(describeBudget(resolveBudget({ contextWindow: 16384 }))).toContain('不截断输出');
  });

  it('needsCompaction 按 inputHard 比例判定', () => {
    const report = resolveBudget({ contextWindow: 16384, maxTokens: 1024 });
    expect(needsCompaction(report.inputHard * 0.59, report)).toBe(false);
    expect(needsCompaction(report.inputHard * 0.61, report)).toBe(true);
    expect(needsCompaction(Number.NaN, report)).toBe(false);
  });
});

describe('runtime/session — runAgentTurn 统一入口', () => {
  it('返回 AsyncIterable，且事件 seq 从 0 单调递增、runId 与请求一致', async () => {
    const turn = runAgentTurn(makeRequest({ runId: 'run-seq' }));
    const events: RuntimeEvent[] = [];
    for (;;) {
      const next = await turn.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.every(event => event.runId === 'run-seq')).toBe(true);
    expect(events.every(event => typeof event.at === 'number')).toBe(true);
  });

  it('先发 budget 事件，让"是否回落"在失败前也可见', async () => {
    runPiAgentMock.mockRejectedValue(new Error('模型炸了'));
    const turn = runAgentTurn(makeRequest());
    const first = await turn.next();
    expect(first.done).toBe(false);
    expect((first.value as RuntimeEvent).type).toBe('budget');
    await turn.return?.(undefined as never);
  });

  it('正常结束：返回 AgentResult 且末事件为 final', async () => {
    const { events, result } = await collectAgentTurn(makeRequest());
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe(outcome.finalText);
    expect(result.rounds).toBe(2);
    expect(result.runId).toBe('run-1');
    expect(result.budget.effectiveContext).toBeGreaterThan(0);
    expect(events.some(event => event.type === 'final')).toBe(true);
  });

  it('把底层回调转换为事件：thought / token / tool / round / usage / compaction', async () => {
    runPiAgentMock.mockImplementation(async (options: any) => {
      options.onEvent.onRoundStart(1);
      options.onEvent.onThought('先看模块成本');
      options.onEvent.onToolStart('query_project_cost', { projectId: 1 }, 'call-1');
      options.onEvent.onToolResult('query_project_cost', { projectId: 1 }, true, '¥85.00', undefined, 'call-1');
      options.onEvent.onUsage({ promptEvalCount: 10, evalCount: 20 });
      options.onEvent.onCompaction({ compacted: true, sourceMessages: 4, keptMessages: 2, tokensBefore: 900, tokensAfter: 300, sourceStart: 0, sourceEnd: 4, usedModel: true });
      options.onEvent.onAnswer('结论：');
      return outcome;
    });
    const { events } = await collectAgentTurn(makeRequest());
    const types = events.map(event => event.type);
    expect(types).toContain('round');
    expect(types).toContain('thought');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_result');
    expect(types).toContain('usage');
    expect(types).toContain('compaction');
    expect(types).toContain('token');

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<RuntimeEvent, { type: 'tool_result' }>;
    expect(toolResult.toolId).toBe('query_project_cost');
    expect(toolResult.ok).toBe(true);
    expect(toolResult.callId).toBe('call-1');
  });

  it('转发既有回调（不吞掉调用方原本的行为）', async () => {
    const seen: string[] = [];
    runPiAgentMock.mockImplementation(async (options: any) => {
      options.onEvent.onThought('t');
      options.onGatewayTrace({ type: 'route_selected' });
      options.onMetrics({ rounds: 1 });
      return outcome;
    });
    await collectAgentTurn(makeRequest({
      options: {
        onEvent: { onThought: () => seen.push('thought') },
        onGatewayTrace: () => seen.push('gateway'),
        onMetrics: () => seen.push('metrics'),
      },
    }));
    expect(seen).toEqual(['thought', 'gateway', 'metrics']);
  });

  it('gateway 轨迹同时成为事件（审计可直接落库）', async () => {
    runPiAgentMock.mockImplementation(async (options: any) => {
      options.onGatewayTrace({ type: 'privacy_evaluation' });
      return outcome;
    });
    const { events } = await collectAgentTurn(makeRequest());
    const gateway = events.filter(event => event.type === 'gateway');
    expect(gateway.length).toBe(1);
  });

  it('失败：先发 error 事件，再把原始异常抛给调用方', async () => {
    runPiAgentMock.mockRejectedValue(new Error('模型炸了'));
    const turn = runAgentTurn(makeRequest());
    const events: RuntimeEvent[] = [];
    let thrown: unknown;
    for (;;) {
      const next = await turn.next().catch((error: unknown) => { thrown = error; return { done: true as const, value: undefined as never }; });
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.some(event => event.type === 'error')).toBe(true);
    const errorEvent = events.find(event => event.type === 'error') as Extract<RuntimeEvent, { type: 'error' }>;
    expect(errorEvent.message).toBe('模型炸了');
    expect(errorEvent.fatal).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('模型炸了');
  });

  it('执行器未返回结果时也走失败路径（不静默成功）', async () => {
    runPiAgentMock.mockResolvedValue(undefined);
    let thrown: unknown;
    try {
      await collectAgentTurn(makeRequest());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  it('流式语义：事件在结果返回前就已产出（边跑边出，不必等运行结束）', async () => {
    let release: (() => void) | undefined;
    runPiAgentMock.mockImplementation(async (options: any) => {
      options.onEvent.onThought('第一段');
      await new Promise<void>(resolve => { release = resolve; });
      options.onEvent.onThought('第二段');
      return outcome;
    });

    const turn = runAgentTurn(makeRequest());
    const seen: RuntimeEvent[] = [];

    // 读事件直到看到第一段；此时 release 尚未调用 —— 运行还没结束。
    // 这证明事件是"边跑边出"而不是"跑完再一次性吐出来"。
    let sawFirst = false;
    let finished = false;
    for (let guard = 0; guard < 20 && !sawFirst; guard += 1) {
      const step = await turn.next();
      if (step.done) { finished = true; break; }
      seen.push(step.value);
      if (step.value.type === 'thought' && (step.value as Extract<RuntimeEvent, { type: 'thought' }>).text === '第一段') sawFirst = true;
    }

    expect(finished).toBe(false);
    expect(sawFirst).toBe(true);
    expect(release).toBeDefined();

    // 放行后半段
    release?.();
    for (;;) {
      const step = await turn.next();
      if (step.done) break;
      seen.push(step.value);
    }
    expect(seen.some(event => event.type === 'thought' && event.text === '第二段')).toBe(true);
    expect(seen.some(event => event.type === 'final')).toBe(true);
  });

  it('把请求参数透传给底层执行器（不丢字段）', async () => {
    await collectAgentTurn(makeRequest({ options: { systemPrompt: '自定义提示词', think: false, model: 'qwen3:4b' } }));
    const passed = runPiAgentMock.mock.calls[0][0];
    expect(passed.systemPrompt).toBe('自定义提示词');
    expect(passed.think).toBe(false);
    expect(passed.model).toBe('qwen3:4b');
  });
});
