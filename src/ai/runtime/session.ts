// Agent Runtime V1 — 统一运行入口
//
// 设计依据：AGENT_RUNTIME_V1_DESIGN.md §3.3
//
// 本文件的作用是**收口，不是重写**：
//   `runAgentTurn()` 内部调用现有的 `runPiAgent()`，把它的 17 个回调钩子
//   转换成一条 `AsyncIterable<RuntimeEvent>`，并在运行前后补上预算阶段事件。
//
// Stage 1 边界（明确不做的事）：
//   * 不改 `piRuntime.ts`（执行器照旧）；不改 `privacyRouter.ts`；不改 `AiPanel.tsx`
//   * 不迁移任何业务页面
//   * 不改变现有行为：所有回调都被转发，事件数与信息量只增不减
//
// 关键实现约束：**必须边跑边出事件**。
//   `runPiAgent` 是「回调 + 最后返回结果」的形状；若等它 resolve 再逐条 yield，
//   流式输出就退化成一次性输出，流式体验会丢失。
//   因此这里用「回调推入队列 / 生成器从队列拉取」的桥接，保证 token 到达即出事件。

import { runPiAgent, type PiRunOptions } from '../piRuntime';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { resolveBudget, type BudgetInput } from './budget';
import { createAsyncQueue } from './queue';
import { runPreflight } from './preflight';
import { buildCallbacks } from './sessionCallbacks';
import type {
  AgentRequest,
  AgentResult,
  AgentRunOptions,
  RuntimeEvent,
  RuntimeEventPayload,
} from './contract';

/** `runPiAgent` 的返回形状（Stage 1 直接复用，不重新定义）。 */
type PiRunOutcome = Awaited<ReturnType<typeof runPiAgent>>;

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 运行一轮 Agent，产出统一事件流。
 *
 * 用法：
 * ```ts
 * const turn = runAgentTurn(request);
 * let next = await turn.next();
 * while (!next.done) {
 *   handle(next.value);            // RuntimeEvent
 *   next = await turn.next();
 * }
 * const result: AgentResult = next.value;
 * ```
 *
 * 保证：
 *   * 事件序号 `seq` 从 0 单调递增，`runId` 与请求一致；
 *   * 抛错时**先发 `error` 事件，再抛出** —— 消费方既能渲染失败，也能用 try/catch 处理；
 *   * 无论成功失败，都发一条 `budget` 事件（让"是否回落"可见）。
 */
export async function* runAgentTurn(request: AgentRequest): AsyncGenerator<RuntimeEvent, AgentResult, undefined> {
  const runId = request.runId;
  const queue = createAsyncQueue<RuntimeEvent>();
  const startedAt = Date.now();
  let seq = 0;

  const emit = (event: RuntimeEventPayload) => {
    queue.push({ ...event, runId, seq: seq++, at: Date.now() } as RuntimeEvent);
  };

  /**
   * 运行是否已结束（成功或失败）。
   *
   * 为什么必须显式跟踪（第一版踩过的坑）：
   * 若事件恰好全部在 `runPiAgent` resolve **之前**被消费掉，`drain()` 会在
   * 队列仍打开时挂起等待新元素 —— 而此时运行已经结束、不会再有事件，
   * 也永远等不到 `close()`，形成死锁（表现为测试 5 秒超时）。
   * 因此这里用一个信号量表达"生产者已停工"，让消费者能确定性退出。
   */
  let runSettled = false;
  let settleSignal: (() => void) | null = null;
  const markSettled = () => {
    runSettled = true;
    const pending = settleSignal;
    settleSignal = null;
    if (pending) pending();
  };
  const waitForSettle = () => {
    if (runSettled) return Promise.resolve();
    return new Promise<void>(resolve => { settleSignal = resolve; });
  };

  const budget = resolveBudget({
    profile: (request.options.profile ?? null) as BudgetInput['profile'],
    contextWindow: request.options.contextWindow,
    maxTokens: request.options.maxTokens,
  });

  // 预算事件先发：即使后续立即失败，消费方也已经知道本次用的是哪个窗口
  emit({ type: 'budget', budget });
  emit({ type: 'stage', stage: 'context', status: 'start', detail: { effectiveContext: budget.effectiveContext } });

  // ---- 隐私 + 路由阶段（Stage 2）-------------------------------------------
  // 编排在 preflight.ts，本文件只负责按顺序 emit —— 事件顺序单一来源。
  // preflight 内部调用现有 privacyRouter.evaluatePrivacy，不复制其逻辑。
  const preflight = runPreflight({
    request,
    provider: String(request.options.backend || 'local'),
    model: request.options.model,
  });
  for (const event of preflight.events) emit(event);

  const callbacks = buildCallbacks(request.options as Record<string, any>, emit);
  const piOptions = { ...request.options, ...callbacks } as unknown as PiRunOptions;

  let outcome: PiRunOutcome | undefined;
  let failure: unknown;

  // 先启动运行（不 await 完成），让生成器可以先消费已产生的事件
  const runPromise = (async () => {
    try {
      outcome = await runPiAgent(piOptions);
    } catch (error) {
      failure = error;
    } finally {
      markSettled();
    }
  })();

  // 阶段一：边跑边出（流式）。
  // 语义：吐出已缓冲事件 → 若运行已结束则进入收尾 → 否则等"有新事件或运行结束"。
  for (;;) {
    yield* queue.drain();
    if (runSettled) break;
    await Promise.race([queue.waitForWork(), waitForSettle()]);
  }

  await runPromise;

  // 阶段二：收尾事件。必须在 close 之前 emit，否则永远不会被消费。
  emit({ type: 'stage', stage: 'context', status: 'ok' });
  if (failure !== undefined || outcome === undefined) {
    const reason = failure ?? new Error('runPiAgent 未返回结果');
    emit({ type: 'error', message: reason instanceof Error ? reason.message : String(reason), fatal: true });
  } else {
    emit({ type: 'final', text: outcome.finalText, rounds: outcome.rounds });
    emit({ type: 'stage', stage: 'final', status: 'ok', detail: { rounds: outcome.rounds, elapsedMs: Date.now() - startedAt } });
  }

  // 阶段三：关闭并吐出剩余事件
  queue.close();
  yield* queue.drain();

  if (failure !== undefined || outcome === undefined) {
    const reason = failure ?? new Error('runPiAgent 未返回结果');
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  return {
    runId,
    finalText: outcome.finalText,
    rounds: outcome.rounds,
    messages: outcome.messages as AgentMessage[],
    workingState: outcome.workingState,
    budget,
    ok: true,
  };
}


/**
 * 便捷消费器：把事件流收集成数组 + 结果。
 *
 * 仅供**测试与批处理**使用；UI 应直接用 `for await` 以便实时渲染。
 * 不做流式渲染的原因：收集会等到跑完，会丢失流式体验 —— 这里用命名表达这个取舍。
 */
export async function collectAgentTurn(request: AgentRequest): Promise<{ events: RuntimeEvent[]; result: AgentResult }> {
  const turn = runAgentTurn(request);
  const events: RuntimeEvent[] = [];
  for (;;) {
    const next = await turn.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

export type { AgentRunOptions };
