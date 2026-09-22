// Agent Runtime V1 — 上下文预算口径
//
// 设计依据：AGENT_RUNTIME_V1_DESIGN.md §3.6
//
// 存在的理由（一个具体问题）：
//   `piRuntime.ts:409` 在调用方未提供 profile/contextWindow 时**静默回落**到
//   `effectiveContext: options.contextWindow || 8192`。
//   回落本身是合理的防御，但**没有任何地方把它暴露出来**，
//   于是「压缩为什么这么早触发」变成一个只能靠读代码才能回答的问题。
//
// 本模块把预算计算收口成一个纯函数，并显式回答「这个数字是标定来的，还是回落来的」。
// 纯函数、无副作用、无网络、无数据库 —— 便于单测与复用。

import {
  contextBudget,
  type ContextBudget,
  type ModelProfile,
} from '../modelProfile';

import type { AgentBudgetReport } from './contract';

/**
 * `piRuntime` 在缺少标定信息时使用的回落窗口。
 * 与 `piRuntime.ts:409` 的 `options.contextWindow || 8192` 保持一致。
 * 若底层改了那个字面量，本常量必须同步 —— 由单测 `budget.test.ts` 钉住。
 */
export const FALLBACK_CONTEXT_WINDOW = 8192;

/** 底层在 maxTokens 缺省时使用的输出上限（`piRuntime.ts:413`）。 */
export const UNLIMITED_OUTPUT_TOKENS = 16384;

/** 预算解析的输入。刻意只要求必要信息，便于在没有完整 profile 时也能算。 */
export interface BudgetInput {
  /** 已标定的模型画像；缺失表示未标定。 */
  profile?: Pick<ModelProfile, 'effectiveContext' | 'maxTokens' | 'confidence'> | null;
  /** 调用方显式指定的窗口（优先级高于 profile）。 */
  contextWindow?: number;
  /** 调用方显式指定的输出上限。 */
  maxTokens?: number;
}

/** 校验一个候选窗口是否可用（正整数且不低于 1024，与 contextBudget 的下限一致）。 */
function usableWindow(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1024) return null;
  return Math.floor(numeric);
}

/**
 * 解析本次运行的上下文预算。
 *
 * 优先级（与底层 piRuntime 的实际取值顺序一致）：
 *   1. 调用方显式 `contextWindow`
 *   2. 已标定 profile 的 `effectiveContext`
 *   3. 回落常量 `FALLBACK_CONTEXT_WINDOW`（此时 `calibrated=false`）
 *
 * 纯函数：同样输入必得同样输出，不读环境、不读时间。
 */
export function resolveBudget(input: BudgetInput = {}): AgentBudgetReport {
  const explicit = usableWindow(input.contextWindow);
  const fromProfile = usableWindow(input.profile?.effectiveContext);

  let effectiveContext: number;
  let calibrated: boolean;
  let fallbackUsed: number | null = null;

  if (explicit !== null) {
    // 调用方显式指定：这是明确的意图，不标记为回落
    effectiveContext = explicit;
    calibrated = true;
  } else if (fromProfile !== null) {
    effectiveContext = fromProfile;
    // profile 只有在 confidence 为 calibrated 时才算真正标定过
    calibrated = input.profile?.confidence === 'calibrated';
  } else {
    effectiveContext = FALLBACK_CONTEXT_WINDOW;
    calibrated = false;
    fallbackUsed = FALLBACK_CONTEXT_WINDOW;
  }

  const requestedMax = Number(input.maxTokens ?? input.profile?.maxTokens ?? 0);
  const unlimitedOutput = !Number.isFinite(requestedMax) || requestedMax <= 0;
  const maxTokens = unlimitedOutput ? 0 : Math.floor(requestedMax);

  const budget: ContextBudget = contextBudget(effectiveContext, maxTokens);

  return {
    effectiveContext: budget.contextWindow,
    calibrated,
    fallbackUsed,
    outputReserve: budget.outputReserve,
    inputHard: budget.inputHard,
    inputSoft: budget.inputSoft,
    compactTarget: budget.compactTarget,
    unlimitedOutput,
  };
}

/**
 * 人话描述，供轨迹面板与日志使用。
 * 让「是否回落」在 UI 上直接可见，而不是只出现在类型里。
 */
export function describeBudget(report: AgentBudgetReport): string {
  const source = report.calibrated
    ? '来自模型标定'
    : report.fallbackUsed === null
      ? '来自调用方指定'
      : `回落默认值 ${report.fallbackUsed}`;
  const output = report.unlimitedOutput ? '不截断输出' : `输出预留 ${report.outputReserve}`;
  return `上下文预算 ${report.effectiveContext} tokens（${source}）；输入上限 ${report.inputHard}；${output}`;
}

/**
 * 判断给定用量是否已达到需要压缩的水位。
 * 复用 `contextPolicy` 的四级水位语义，但只回答布尔问题，供 Runtime 阶段决策使用。
 */
export function needsCompaction(currentTokens: number, report: AgentBudgetReport, threshold = 0.6): boolean {
  if (!Number.isFinite(currentTokens) || report.inputHard <= 0) return false;
  const ratio = Math.max(0, threshold);
  return currentTokens >= report.inputHard * ratio;
}
