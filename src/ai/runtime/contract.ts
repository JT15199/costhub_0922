// Agent Runtime V1 — 统一契约（纯类型，无运行时逻辑）
//
// 设计依据：AGENT_RUNTIME_V1_DESIGN.md §3.3
//
// 存在的理由：
//   当前调用方要驱动一次 Agent 运行，必须自己拼 `PiRunOptions`（30+ 字段）
//   并实现 **17 个回调钩子**（`onEvent` 内嵌 12 个 + 顶层 5 个）。
//   这既是样板负担，也让「可观测性」无法复用 —— `GatewayTraceState` 那 13 个字段
//   目前是 `AiPanel` 的局部状态，任何新调用方都得复制一遍。
//
//   本文件把「一次运行」抽象成 请求 → 事件流 → 结果：
//     调用方 for-await 消费 `RuntimeEvent`，UI / 审计 / 测试共用同一条流。
//
// 约束：本文件**只放类型与纯常量**，不放任何逻辑，便于被任意层安全引用。

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { AiToolResult } from '../contracts';
import type { AiGatewayRoute, AiGatewayTraceEvent } from '../gateway';
import type { PrivacyDecision } from '../privacyRouter';
import type { CompactionStats } from '../contextPolicy';
import type { ModelUsage } from '../modelProfile';
import type { WorkingState } from '../workingState';

// ---------------------------------------------------------------------------
// 运行阶段
// ---------------------------------------------------------------------------

/**
 * Agent 运行的固定阶段。
 * 与设计文档 §3.5 的流程图一一对应；用它替代散落在 UI 里的隐式阶段判断。
 */
export const AGENT_STAGES = ['plan', 'privacy', 'route', 'context', 'tool', 'approval', 'final'] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

/** 阶段状态。`skip` 表示该阶段本轮不适用（例如没有云端候选时 approval 被跳过）。 */
export type AgentStageStatus = 'start' | 'ok' | 'fail' | 'skip';

/** 调用方声明的意图。用于「意图 → 工具集」映射，替代 UI 里的散装判断。 */
export type AgentIntent =
  | 'chat'
  | 'analysis'
  | 'quote_review'
  | 'voice'
  | 'worklog_summary'
  | 'material_trend'
  | 'general';

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

export interface AgentPageContext {
  page: string;
  projectId?: number;
  selectedIds?: number[];
}

export interface AgentRequest {
  /** 会话 id（对应 local_ai_sessions）。 */
  sessionId: number;
  /** 本次运行 id，用于事件与持久化的关联键。 */
  runId: string;
  /** 用户这次说的话。 */
  userMessage: string;
  /** 附件图片（base64 或 data URL，交给底层解析）。 */
  images?: string[];
  /** 当前页面上下文。 */
  pageContext?: AgentPageContext;
  /** 意图；缺省为 'general'。 */
  intent?: AgentIntent;
  /**
   * 迁移期显式豁免标记。
   *
   * 设计文档 §3.3：允许旧代码继续直调模型，但**必须留痕**，
   * 这样「还剩几处旁路」是可查询的，而不是靠人记。
   * 非空时应在审计中记录该字符串。
   */
  legacyBypassReason?: string;
  /** 透传给底层的运行参数（保持与既有 PiRunOptions 兼容）。 */
  options: AgentRunOptions;
}

/**
 * 底层运行参数。
 *
 * 刻意**直接引用 `PiRunOptions` 的形状**而不是重新定义一遍：
 * Stage 1 的目标是「包一层」而不是「改底层」，重复定义会产生两套会漂移的类型。
 * `runPiAgent` 的必填/可选约束由 `AgentRunOptions` 在本文件内收窄表达。
 */
export interface AgentRunOptions {
  baseUrl: string;
  model: string;
  backend?: AgentBackend;
  systemPrompt: string;
  tools: AgentToolLike[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  agentMessages?: AgentMessage[];
  execution?: unknown;
  think?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  profile?: unknown;
  sessionId?: number;
  workingState?: WorkingState;
  compactionState?: unknown;
  compactionPolicy?: Record<string, unknown>;
  privacySourceTypes?: string[];
  privacyMetadata?: unknown[];
  localPrivacyClassifier?: unknown;
  gatewayRoute?: AiGatewayRoute;
  cloud?: unknown;
  executeTool: AgentToolExecutor;
  /** 透传的其余字段（Stage 1 不逐一列举，避免与底层漂移）。 */
  [key: string]: unknown;
}

export type AgentBackend = 'ollama' | 'llama.cpp';

/** 工具执行器签名（与 aiTools.executeTool 对齐）。 */
export type AgentToolExecutor = (
  id: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  callId?: string,
  trace?: (event: AiGatewayTraceEvent) => void,
) => Promise<{ ok: boolean; text: string; result?: AiToolResult<unknown> }>;

/** Stage 1 只要求工具对象具备 id/name/desc 的可辨识形状，不做契约收紧。 */
export interface AgentToolLike {
  id: string;
  name?: string;
  desc?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 事件流
// ---------------------------------------------------------------------------

/** 事件公共字段。 */
interface RuntimeEventBase {
  runId: string;
  /** 事件序号，从 0 单调递增；用于跨会话回放与去重。 */
  seq: number;
  at: number;
}

/**
 * 统一事件流。
 *
 * 覆盖现有 17 个回调所能表达的全部信息，且**信息不丢**：
 * 每个事件都保留了原始 payload，便于 UI 与审计各自取用。
 */
export type RuntimeEvent =
  | (RuntimeEventBase & { type: 'stage'; stage: AgentStage; status: AgentStageStatus; detail?: unknown })
  | (RuntimeEventBase & { type: 'privacy'; decision: PrivacyDecision })
  | (RuntimeEventBase & { type: 'route'; route: AiGatewayRoute; provider: string; model: string })
  | (RuntimeEventBase & { type: 'round'; round: number })
  | (RuntimeEventBase & { type: 'thought'; text: string })
  | (RuntimeEventBase & { type: 'token'; text: string })
  | (RuntimeEventBase & { type: 'tool_start'; toolId: string; args: unknown; callId: string })
  | (RuntimeEventBase & { type: 'tool_progress'; toolId: string; text: string; callId: string })
  | (RuntimeEventBase & {
    type: 'tool_result';
    toolId: string;
    args: unknown;
    ok: boolean;
    text: string;
    callId?: string;
    result?: AiToolResult<unknown>;
  })
  | (RuntimeEventBase & { type: 'cloud_result'; args: unknown; ok: boolean; text: string })
  | (RuntimeEventBase & { type: 'usage'; usage: ModelUsage })
  | (RuntimeEventBase & { type: 'compaction'; stats: CompactionStats })
  | (RuntimeEventBase & { type: 'execution_ready'; workspace: string; diagnostics: string[] })
  | (RuntimeEventBase & { type: 'chart'; artifact: unknown })
  | (RuntimeEventBase & { type: 'gateway'; event: AiGatewayTraceEvent })
  | (RuntimeEventBase & { type: 'budget'; budget: AgentBudgetReport })
  | (RuntimeEventBase & { type: 'final'; text: string; rounds: number })
  | (RuntimeEventBase & { type: 'error'; message: string; fatal: boolean });

export type RuntimeEventType = RuntimeEvent['type'];

/**
 * 分配式 Omit。
 *
 * 注意：TS 内建的 `Omit<A | B, K>` **不分配** —— 它会把联合塌缩成单一对象类型，
 * 只保留公共字段，于是 `event.stage` / `event.text` 这类分支字段全部报错。
 * 这里用条件类型把 Omit 逐分支应用再合并，保证联合结构不变。
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 事件载荷：调用方提供的部分，`runId` / `seq` / `at` 由 Runtime 统一填充。 */
export type RuntimeEventPayload = DistributiveOmit<RuntimeEvent, 'runId' | 'seq' | 'at'>;

// ---------------------------------------------------------------------------
// 结果与预算
// ---------------------------------------------------------------------------

export interface AgentResult {
  runId: string;
  /** 最终给用户的文本。 */
  finalText: string;
  /** 模型轮次。 */
  rounds: number;
  /** 完整消息轨迹（供持久化）。 */
  messages: AgentMessage[];
  /** 结束后的结构化工作状态。 */
  workingState: WorkingState;
  /** 本次运行的上下文预算实况（见 budget.ts）。 */
  budget: AgentBudgetReport;
  /** 是否正常结束（false 表示被取消或失败）。 */
  ok: boolean;
  /** 失败/取消原因。 */
  error?: string;
}

/**
 * 上下文预算实况。
 *
 * 为什么单独成一个类型：设计文档 §1.4 指出 `effectiveContext` 会**静默回落**到 8192
 * （`piRuntime.ts:409`），导致压缩过早触发且无人察觉。
 * `calibrated` 字段把「是否标定过」变成可观测事实，而不是靠推测。
 */
export interface AgentBudgetReport {
  /** 实际生效的上下文窗口。 */
  effectiveContext: number;
  /** 是否来自真实标定（true=模型探测成功；false=回落默认值）。 */
  calibrated: boolean;
  /** 回落时使用的默认值（便于对比诊断）。 */
  fallbackUsed: number | null;
  /** 输出预留 token。 */
  outputReserve: number;
  /** 硬输入上限。 */
  inputHard: number;
  /** 软输入上限（压缩水位参考）。 */
  inputSoft: number;
  /** 压缩目标。 */
  compactTarget: number;
  /** 是否声明了不截断输出。 */
  unlimitedOutput: boolean;
}

/** 事件流消费方（与 AsyncIterable 配套，便于测试注入）。 */
export interface RuntimeEventSink {
  push: (event: RuntimeEvent) => void;
  close: () => void;
}
