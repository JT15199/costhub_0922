// Agent Runtime Stage 3 — Runtime 适配层
//
// 职责（严格限定）：
//   * 调用 `runAgentTurn`
//   * 消费 `AsyncIterable<RuntimeEvent>`
//   * 对每条事件做 **中立的顺序转发**（逐条交给调用方与映射器）
//
// 本文件**不认识 UI 状态**（那是 `runtimeEventMapper.ts` 的职责），
// 也**不认识 AiPanel** —— 因此它可以被独立单测，不必渲染 2000 行组件。
//
// 为什么要有这一层（而不是把循环塞进 AiPanel）：
//   AiPanel 已经 2200+ 行，继续往里加"异步迭代 + 事件分发"会让迁移逻辑
//   与渲染逻辑缠在一起，无法单独测试。适配层把这段机制抽出来后，
//   AiPanel 只保留一次调用（见 §AiPanel 中的 `runPiAgentWithRuntime`）。

import { runAgentTurn } from '../../ai/runtime/session';
import type { AgentRequest, AgentResult, RuntimeEvent } from '../../ai/runtime/contract';

/** 事件监听器：一条事件到达即回调（流式，不缓冲）。 */
export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface ConsumeRuntimeTurnOptions {
  /** 每条事件的即时回调 —— UI 用它做实时渲染。 */
  onEvent?: RuntimeEventListener;
  /** 运行是否应中止（例如用户点了停止）。返回 true 则停止消费并返回已产生的结果。 */
  shouldAbort?: () => boolean;
}

export interface ConsumeRuntimeTurnResult {
  /** 底层运行结果；被中止时为 `undefined`。 */
  result?: AgentResult;
  /** 已消费的事件数量。 */
  eventCount: number;
  /** 是否因 `shouldAbort` 而提前结束。 */
  aborted: boolean;
}

/**
 * 驱动一次 Agent 运行，逐条转发事件。
 *
 * 关键：**边跑边出。** `for await` 会在每个事件到达时立即调用 `onEvent`，
 * 而不是等运行结束再一次性分发 —— 这是"保持流式输出体验"的落点。
 *
 * 中止语义：
 *   `shouldAbort()` 在**每个事件边界**检查。返回 true 时停止消费，
 *   并通过 `return()` 关闭生成器（触发其 finally 清理）。
 *   真正的模型取消仍由 `AgentRequest.options.signal` 负责 —— 这里只负责停止消费。
 */
export async function consumeRuntimeTurn(
  request: AgentRequest,
  options: ConsumeRuntimeTurnOptions = {},
): Promise<ConsumeRuntimeTurnResult> {
  const { onEvent, shouldAbort } = options;
  const turn = runAgentTurn(request);
  let eventCount = 0;

  for (;;) {
    const next = await turn.next();
    if (next.done) {
      return { result: next.value, eventCount, aborted: false };
    }

    eventCount += 1;
    onEvent?.(next.value);

    if (shouldAbort?.()) {
      // 显式关闭生成器，让它走 finally 分支（避免悬挂的 pending promise）
      await turn.return?.(undefined as never);
      return { eventCount, aborted: true };
    }
  }
}

/**
 * 便捷包装：直接把 `runAgentTurn` 的事件流交给调用方处理，返回最终结果。
 * 与 `consumeRuntimeTurn` 的区别：不检查中止，也不统计（用于简单场景）。
 */
export async function runTurnWithListener(
  request: AgentRequest,
  onEvent?: RuntimeEventListener,
): Promise<AgentResult | undefined> {
  const { result } = await consumeRuntimeTurn(request, { onEvent });
  return result;
}

// ---------------------------------------------------------------------------
// 双路径分发（feature flag）
// ---------------------------------------------------------------------------

export type AgentExecutionPath = 'runtime' | 'legacy';

/**
 * 决定本轮走哪条执行路径。
 *
 * 刻意抽成纯函数：这样"开关关闭走旧路径 / 开启走 Runtime"这条**关键回滚语义**
 * 可以被直接单测，而不必渲染 2200 行的 AiPanel。
 * 组件侧只调用它并分支，不含任何判断逻辑。
 *
 * @param enabled 来自 `isAgentRuntimeEnabled()`（默认 false）
 */
export function decideExecutionPath(enabled: boolean): AgentExecutionPath {
  return enabled ? 'runtime' : 'legacy';
}

/**
 * 按路径执行：`runtime` 走事件流驱动，`legacy` 保持原样。
 *
 * `legacy` 分支由调用方以回调形式传入 —— 适配层不 import `piRuntime`，
 * 以免把执行核心的依赖关系拉进 UI 层（也便于测试注入）。
 */
export async function executeByPath(input: {
  path: AgentExecutionPath;
  request: AgentRequest;
  onEvent?: RuntimeEventListener;
  shouldAbort?: () => boolean;
  runLegacy: () => Promise<unknown>;
}): Promise<{ path: AgentExecutionPath; runtime?: ConsumeRuntimeTurnResult; legacy?: unknown }> {
  if (input.path === 'legacy') {
    const legacy = await input.runLegacy();
    return { path: 'legacy', legacy };
  }
  const runtime = await consumeRuntimeTurn(input.request, { onEvent: input.onEvent, shouldAbort: input.shouldAbort });
  return { path: 'runtime', runtime };
}
