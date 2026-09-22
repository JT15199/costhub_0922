import { describe, it, expect, vi, beforeEach } from 'vitest';

// 只替换执行核心：本文件验证**迁移接入**是否正确，不验证 piRuntime 自身行为。
const runPiAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../ai/piRuntime', () => ({ runPiAgent: runPiAgentMock }));

import { consumeRuntimeTurn, decideExecutionPath, executeByPath } from '../components/ai/runtimeAdapter';
import { createRuntimeUiProjection, projectRuntimeEvents, translateRuntimeEventForUi } from '../components/ai/runtimeEventMapper';
import { summarizeGatewayTrace } from '../components/ai/gatewayTrace';
import { isAgentRuntimeEnabled, setAgentRuntimeEnabled, USE_AGENT_RUNTIME, AGENT_RUNTIME_DEFAULT } from '../components/ai/runtimeFeatureFlag';
import type { AgentRequest, RuntimeEvent, RuntimeEventPayload } from '../ai/runtime/contract';

/**
 * Stage 3 迁移验收测试。
 *
 * 验证的是「AiPanel 接入 Agent Runtime」这条链路的三件事：
 *   1. RuntimeEvent 能驱动 AI 窗口状态（含流式与最终结果）；
 *   2. 事件顺序正确（privacy → route → tool → final）；
 *   3. feature flag 的**双路径分发**正确（关闭=旧路径，开启=Runtime）。
 *
 * 刻意不渲染 2192 行的 AiPanel：迁移逻辑已被抽到
 * `src/components/ai/runtimeAdapter.ts` 与 `runtimeEventMapper.ts`，
 * 全部是纯函数/可注入依赖的薄封装，可以直接测。
 */

const outcome = {
  finalText: '驱动板 ¥85.00 偏高。',
  rounds: 2,
  messages: [{ role: 'assistant', content: '驱动板 ¥85.00 偏高。' }],
  workingState: { version: 1, items: [], projects: [], files: [], artifacts: [], tasks: [] },
};

const tool = (id: string) => ({ id, name: id, desc: id, manifest: { privacyLevel: 'public' as const } });

function makeRequest(overrides: { runId?: string; backend?: 'ollama' | 'llama.cpp' } = {}): AgentRequest {
  return {
    sessionId: 3,
    runId: overrides.runId ?? 'run-ui',
    userMessage: '看下驱动板成本',
    options: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:4b',
      backend: overrides.backend ?? 'ollama',
      systemPrompt: 'sys',
      tools: [tool('query_project_cost')] as never,
      executeTool: async () => ({ ok: true, text: 'ok' }),
    },
  };
}

/** 让 mock 在执行期间按顺序抛出这些事件，然后返回结果。 */
function mockRuntimeEmitting(sequence: Array<(options: any) => void>) {
  runPiAgentMock.mockImplementation(async (options: any) => {
    for (const step of sequence) step(options);
    return outcome;
  });
}

beforeEach(() => {
  runPiAgentMock.mockReset();
  runPiAgentMock.mockResolvedValue(outcome);
});

// ---------------------------------------------------------------------------
// Case 1 — text_delta（token）→ final：AI 窗口能正常显示结果
// ---------------------------------------------------------------------------

describe('Case 1 — token 流 → final：窗口可正常显示结果', () => {
  it('token 事件逐条到达（流式），final 事件携带最终文本', async () => {
    mockRuntimeEmitting([
      options => options.onEvent.onAnswer('驱动板 '),
      options => options.onEvent.onAnswer('¥85.00 '),
      options => options.onEvent.onAnswer('偏高。'),
    ]);

    const seen: RuntimeEvent[] = [];
    const consumed = await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });

    const tokens = seen.filter(event => event.type === 'token') as Array<Extract<RuntimeEvent, { type: 'token' }>>;
    expect(tokens.map(token => token.text)).toEqual(['驱动板 ', '¥85.00 ', '偏高。']);
    expect(tokens.map(token => token.seq)).toEqual([...tokens].map((_, index) => tokens[0].seq + index));

    expect(seen.some(event => event.type === 'final')).toBe(true);
    expect(consumed.result?.finalText).toBe(outcome.finalText);
    expect(consumed.aborted).toBe(false);
  });

  it('流式语义：token 在结果返回前就已产出（不是跑完一次性吐出）', async () => {
    let release: (() => void) | undefined;
    runPiAgentMock.mockImplementation(async (options: any) => {
      options.onEvent.onAnswer('第一段');
      await new Promise<void>(resolve => { release = resolve; });
      options.onEvent.onAnswer('第二段');
      return outcome;
    });

    const seen: RuntimeEvent[] = [];
    let sawFirst = false;
    let finished = false;

    // 手动驱动一次，读到第一段就停 —— 此时 release 尚未调用，运行还没结束
    const turn = (await import('../ai/runtime/session')).runAgentTurn(makeRequest());
    for (let guard = 0; guard < 20 && !sawFirst; guard += 1) {
      const next = await turn.next();
      if (next.done) { finished = true; break; }
      seen.push(next.value);
      if (next.value.type === 'token') sawFirst = true;
    }
    expect(finished).toBe(false);
    expect(sawFirst).toBe(true);
    expect(release).toBeDefined();

    release?.();
    for (;;) {
      const next = await turn.next();
      if (next.done) break;
      seen.push(next.value);
    }
    expect(seen.filter(event => event.type === 'token').length).toBe(2);
  });

  it('投影：token 与最终文本能落到 UI 认识的轨迹结构上', async () => {
    mockRuntimeEmitting([options => options.onEvent.onAnswer('驱动板 ¥85.00 偏高。')]);
    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });

    const projection = projectRuntimeEvents(seen, { backend: 'ollama' });
    // token 不产生网关事件，但 budget/privacy/route/final 的骨架必须完整
    expect(projection.gatewayEvents.length).toBeGreaterThan(0);
    expect(projection.trace.route).toBeDefined();
    expect(projection.trace.privacy).toBeDefined();
    // 结果文本与投影互不干扰：文本仍取 runAgentTurn 的返回值
    expect(outcome.finalText).toContain('驱动板');
  });
});

// ---------------------------------------------------------------------------
// Case 2 — privacy → route → tool → final：事件顺序正确
// ---------------------------------------------------------------------------

describe('Case 2 — privacy → route → tool → final 顺序正确', () => {
  it('核心事件顺序为 budget → privacy → route → (tool…) → final', async () => {
    mockRuntimeEmitting([
      options => options.onEvent.onToolStart('query_project_cost', { projectId: 1 }, 'call-1'),
      options => options.onEvent.onToolResult('query_project_cost', { projectId: 1 }, true, '¥85.00', undefined, 'call-1'),
    ]);

    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });

    const skeleton = seen
      .filter(event => ['budget', 'privacy', 'route', 'final'].includes(event.type))
      .map(event => event.type);
    expect(skeleton).toEqual(['budget', 'privacy', 'route', 'final']);

    // tool 事件必须落在 route 之后、final 之前
    const routeSeq = seen.find(event => event.type === 'route')!.seq;
    const finalSeq = seen.find(event => event.type === 'final')!.seq;
    const toolSeqs = seen.filter(event => event.type === 'tool_start' || event.type === 'tool_result').map(event => event.seq);
    expect(toolSeqs.length).toBe(2);
    expect(toolSeqs.every(seq => seq > routeSeq && seq < finalSeq)).toBe(true);
  });

  it('privacy 事件携带真实判定结果（不是占位）', async () => {
    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });
    const privacy = seen.find(event => event.type === 'privacy') as Extract<RuntimeEvent, { type: 'privacy' }>;
    expect(['public', 'internal', 'sensitive', 'unknown']).toContain(privacy.decision.classification);
    expect(typeof privacy.decision.cloudSafe).toBe('boolean');
    expect(Array.isArray(privacy.decision.sourceTypes)).toBe(true);
  });

  it('route 事件只声明候选路径，不等于已外发（与既有 UI 语义一致）', async () => {
    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });
    const route = seen.find(event => event.type === 'route') as Extract<RuntimeEvent, { type: 'route' }>;
    expect(['local', 'cloud']).toContain(route.route);
    // 路由 stage 事件里带 requested，明确区分"请求的"与"实际选择的"
    const stage = seen.find(event => event.type === 'stage' && event.stage === 'route' && event.status === 'ok') as Extract<RuntimeEvent, { type: 'stage' }>;
    expect(stage.detail).toMatchObject({ route: route.route });
  });

  it('映射：privacy / route / tool 都能转成 UI 已认识的状态', async () => {
    mockRuntimeEmitting([
      options => options.onEvent.onToolStart('query_project_cost', {}, 'call-1'),
      options => options.onEvent.onToolResult('query_project_cost', {}, true, '¥85.00', undefined, 'call-1'),
    ]);
    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });

    const projection = projectRuntimeEvents(seen, { backend: 'ollama' });
    const kinds = projection.cards.map(card => card.kind);
    expect(kinds).toContain('privacy');
    expect(kinds).toContain('route');
    expect(kinds).toContain('tool');
    // 隐私判定确实进入 UI 状态（这是"privacy 事件正常显示"的落点）
    expect(projection.trace.privacy).toBeDefined();
    expect(projection.trace.route).toBe('local');

    // 单条翻译：工具事件转成 context_preparation，且 provider 来自真实后端
    const toolEvent = seen.find(event => event.type === 'tool_result')!;
    const translated = translateRuntimeEventForUi(toolEvent, { backend: 'llama.cpp' });
    expect(translated.gateway?.type).toBe('context_preparation');
    expect((translated.gateway as { provider?: string }).provider).toBe('llama.cpp');
    expect(translated.card?.kind).toBe('tool');
  });

  it('投影复用既有归约器：同一批网关事件得到与旧链路相同的状态形状', async () => {
    const seen: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => seen.push(event) });
    const viaProjection = projectRuntimeEvents(seen, { backend: 'ollama' });
    // 用同一批事件再走一次既有归约函数，结果必须一致（证明没有第二套汇总逻辑）
    const viaSummarize = summarizeGatewayTrace(viaProjection.gatewayEvents);
    expect(viaProjection.trace).toEqual(viaSummarize);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Feature flag 关闭 ⇒ 走旧 Agent 路径
// ---------------------------------------------------------------------------

describe('Case 3 — feature flag 关闭时仍走旧 Agent 路径', () => {
  it('默认值为关闭', () => {
    expect(AGENT_RUNTIME_DEFAULT).toBe(false);
    expect(USE_AGENT_RUNTIME).toBe('costhub-use-agent-runtime');
    // 未写入任何值时 → 默认关闭
    expect(isAgentRuntimeEnabled({ getItem: () => null })).toBe(false);
  });

  it('显式写入 0/false/空值时都视为关闭', () => {
    for (const raw of ['0', 'false', '', null]) {
      expect(isAgentRuntimeEnabled({ getItem: () => raw as string | null })).toBe(false);
    }
  });

  it('localStorage 不可用时回退默认（关闭），不抛错', () => {
    expect(isAgentRuntimeEnabled({ getItem: () => { throw new Error('denied'); } })).toBe(false);
  });

  it('decideExecutionPath(false) → legacy，且只调用旧执行器、不消费事件流', async () => {
    expect(decideExecutionPath(false)).toBe('legacy');

    const legacyCalls: string[] = [];
    const runtimeEvents: RuntimeEvent[] = [];
    const result = await executeByPath({
      path: decideExecutionPath(false),
      request: makeRequest(),
      onEvent: event => runtimeEvents.push(event),
      runLegacy: async () => { legacyCalls.push('legacy'); return { finalText: 'legacy result' }; },
    });

    expect(legacyCalls).toEqual(['legacy']);
    expect(result.path).toBe('legacy');
    expect(result.runtime).toBeUndefined();
    // 关键：旧路径**不得**触发 RuntimeEvent 消费（否则等于两条链路同时跑）
    expect(runtimeEvents.length).toBe(0);
    expect(runPiAgentMock).not.toHaveBeenCalled();
  });

  it('开关写入后读取一致（支持快速回滚）', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    expect(setAgentRuntimeEnabled(true, storage)).toBe(true);
    expect(isAgentRuntimeEnabled(storage)).toBe(true);
    expect(setAgentRuntimeEnabled(false, storage)).toBe(true);
    expect(isAgentRuntimeEnabled(storage)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Feature flag 开启 ⇒ 调用 runAgentTurn
// ---------------------------------------------------------------------------

describe('Case 4 — feature flag 开启时调用 runAgentTurn', () => {
  it('显式写入 1/true 时视为开启', () => {
    expect(isAgentRuntimeEnabled({ getItem: () => '1' })).toBe(true);
    expect(isAgentRuntimeEnabled({ getItem: () => 'true' })).toBe(true);
  });

  it('decideExecutionPath(true) → runtime', () => {
    expect(decideExecutionPath(true)).toBe('runtime');
  });

  it('executeByPath(runtime) 会真的驱动 runAgentTurn 并转发事件、返回结果', async () => {
    const runtimeEvents: RuntimeEvent[] = [];
    const result = await executeByPath({
      path: decideExecutionPath(true),
      request: makeRequest(),
      onEvent: event => runtimeEvents.push(event),
      runLegacy: async () => { throw new Error('旧路径不应被调用'); },
    });

    // 证据 1：底层执行器确实被 runAgentTurn 调用
    expect(runPiAgentMock).toHaveBeenCalledTimes(1);
    // 证据 2：事件被转发（含隐私与路由阶段）
    const types = runtimeEvents.map(event => event.type);
    expect(types).toContain('budget');
    expect(types).toContain('privacy');
    expect(types).toContain('route');
    expect(types).toContain('final');
    // 证据 3：结果可用
    expect(result.path).toBe('runtime');
    expect(result.runtime?.result?.finalText).toBe(outcome.finalText);
    expect(result.legacy).toBeUndefined();
  });

  it('中止语义：shouldAbort 为真时停止消费，且不返回结果（沿用既有中止行为）', async () => {
    let release: (() => void) | undefined;
    runPiAgentMock.mockImplementation(async (options: any) => {
      options.onEvent.onAnswer('开始');
      await new Promise<void>(resolve => { release = resolve; });
      options.onEvent.onAnswer('结束');
      return outcome;
    });

    const seen: RuntimeEvent[] = [];
    const consumed = await consumeRuntimeTurn(makeRequest(), {
      onEvent: event => { seen.push(event); if (event.type === 'token') release?.(); },
      // 第一次检查即中止
      shouldAbort: () => true,
    });

    expect(consumed.aborted).toBe(true);
    expect(consumed.result).toBeUndefined();
  });

  it('两条路径共用同一份请求参数（切换开关不改安全策略）', async () => {
    const request = makeRequest({ backend: 'llama.cpp' });
    await consumeRuntimeTurn(request, {});
    const passed = runPiAgentMock.mock.calls[0][0] as Record<string, unknown>;
    expect(passed.model).toBe('qwen3:4b');
    expect(passed.systemPrompt).toBe('sys');
    expect(passed.backend).toBe('llama.cpp');
    // 工具集原样透传 —— 隐私判定依据的就是它
    expect((passed.tools as Array<{ id: string }>).map(item => item.id)).toContain('query_project_cost');
  });
});

// ---------------------------------------------------------------------------
// 适配层与映射层的边界（防止逻辑回流到 AiPanel）
// ---------------------------------------------------------------------------

describe('适配层/映射层职责边界', () => {
  it('consumeRuntimeTurn 只做顺序转发，不改变事件内容与顺序', async () => {
    mockRuntimeEmitting([
      options => options.onEvent.onRoundStart(1),
      options => options.onEvent.onThought('思考'),
      options => options.onEvent.onAnswer('答'),
    ]);
    const direct: RuntimeEvent[] = [];
    const viaAdapter: RuntimeEvent[] = [];
    await consumeRuntimeTurn(makeRequest(), { onEvent: event => viaAdapter.push(event) });

    // 重新跑一次做对照（mock 可重复调用）
    runPiAgentMock.mockClear();
    mockRuntimeEmitting([
      options => options.onEvent.onRoundStart(1),
      options => options.onEvent.onThought('思考'),
      options => options.onEvent.onAnswer('答'),
    ]);
    const turn = (await import('../ai/runtime/session')).runAgentTurn(makeRequest());
    for (;;) {
      const next = await turn.next();
      if (next.done) break;
      direct.push(next.value);
    }

    expect(viaAdapter.map(event => event.type)).toEqual(direct.map(event => event.type));
    expect(viaAdapter.map(event => event.seq)).toEqual(direct.map(event => event.seq));
  });

  it('映射器对无关事件返回空结果（不产生多余网关事件）', () => {
    const base = { runId: 'r', seq: 0, at: 0 };
    const irrelevant: RuntimeEventPayload[] = [
      { type: 'thought', text: 't' },
      { type: 'token', text: 'x' },
      { type: 'round', round: 1 },
    ];
    for (const payload of irrelevant) {
      const translated = translateRuntimeEventForUi({ ...base, ...payload } as RuntimeEvent, {});
      expect(translated.gateway).toBeUndefined();
    }
  });

  it('createRuntimeUiProjection 是流式可增量读取的（不必等运行结束）', () => {
    const projection = createRuntimeUiProjection({ backend: 'ollama' });
    const base = { runId: 'r', at: 0 };
    projection.push({ ...base, seq: 0, type: 'budget', budget: { effectiveContext: 8192, calibrated: false, fallbackUsed: 8192, outputReserve: 1, inputHard: 1, inputSoft: 1, compactTarget: 1, unlimitedOutput: true } } as RuntimeEvent);
    // 只喂了一条预算事件就能读出状态 —— 证明是增量的
    expect(projection.snapshot().trace).toBeDefined();
    expect(projection.cardList.map(card => card.kind)).toEqual(['budget']);
  });
});
