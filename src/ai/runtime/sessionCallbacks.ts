// Agent Runtime V1 — 回调 → 事件 映射
//
// 从 `session.ts` 拆出（Stage 2 加入隐私/路由阶段后 session.ts 达 360 行，超 300 行上限）。
//
// 职责：把 `runPiAgent` 的 17 个回调钩子（`onEvent` 内 12 个 + 顶层 5 个）映射成
// `RuntimeEvent`，并**同时转发**给调用方原有的回调。
//
// 设计约束（Stage 1 已确立，此处保持）：
//   * **只加不减**：emit 事件之后仍然调用 `existing.onXxx`，
//     这样将来 `AiPanel` 迁移过来时，它原有的回调行为不会凭空消失。
//   * 本模块不改变事件顺序，只负责映射；顺序由 `session.ts` 单点决定。

import type { PiRunMetrics } from '../piRuntime';
import type { RuntimeEventPayload } from './contract';

export type EmitPayload = (event: RuntimeEventPayload) => void;

/** `request.options` 的宽松视图（既有的回调字段透传需要动态读取）。 */
type OptionsView = Record<string, any>;

/**
 * 构造传给 `runPiAgent` 的回调集合。
 *
 * @param options 调用方原始 options（用于转发既有回调）
 * @param emit    事件出口
 */
export function buildCallbacks(options: OptionsView, emit: EmitPayload) {
  return {
    onMetrics: (metrics: PiRunMetrics) => options.onMetrics?.(metrics),
    onGatewayTrace: (event: unknown) => {
      emit({ type: 'gateway', event: event as never });
      options.onGatewayTrace?.(event);
    },
    onAgentReady: (agent: unknown) => options.onAgentReady?.(agent),
    onRawMessage: (message: unknown) => options.onRawMessage?.(message),
    onCheckpoint: (messages: unknown, pending?: { id: string; name: string }, workingState?: unknown, compactionState?: unknown) =>
      options.onCheckpoint?.(messages, pending, workingState, compactionState),
    onEvent: {
      onExecutionReady: (workspace: string, diagnostics: string[]) => {
        emit({ type: 'execution_ready', workspace, diagnostics });
        options.onEvent?.onExecutionReady?.(workspace, diagnostics);
      },
      onChart: (artifact: unknown) => {
        emit({ type: 'chart', artifact });
        options.onEvent?.onChart?.(artifact);
      },
      onToolProgress: (toolId: string, text: string, callId: string) => {
        emit({ type: 'tool_progress', toolId, text, callId });
        options.onEvent?.onToolProgress?.(toolId, text, callId);
      },
      onThought: (text: string) => {
        emit({ type: 'thought', text });
        options.onEvent?.onThought?.(text);
      },
      onAnswer: (text: string) => {
        emit({ type: 'token', text });
        options.onEvent?.onAnswer?.(text);
      },
      onToolStart: (toolId: string, args: unknown, callId: string) => {
        emit({ type: 'tool_start', toolId, args, callId });
        options.onEvent?.onToolStart?.(toolId, args, callId);
      },
      onToolResult: (toolId: string, args: unknown, ok: boolean, text: string, result?: unknown, callId?: string) => {
        emit({ type: 'tool_result', toolId, args, ok, text, callId, result: result as never });
        options.onEvent?.onToolResult?.(toolId, args, ok, text, result, callId);
      },
      onCloudResult: (args: unknown, ok: boolean, text: string) => {
        emit({ type: 'cloud_result', args, ok, text });
        options.onEvent?.onCloudResult?.(args, ok, text);
      },
      onRoundStart: (round: number) => {
        emit({ type: 'round', round });
        options.onEvent?.onRoundStart?.(round);
      },
      onUsage: (usage: unknown) => {
        emit({ type: 'usage', usage: usage as never });
        options.onEvent?.onUsage?.(usage);
      },
      onCompaction: (stats: unknown) => {
        emit({ type: 'compaction', stats: stats as never });
        options.onEvent?.onCompaction?.(stats);
      },
    },
  };
}
