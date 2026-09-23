// Agent Runtime V1（Stage 3）— RuntimeEvent → AI 协作窗 UI 状态
//
// 解决的问题（Stage 3 要求 2）：
//   `AiPanel` 目前**手工维护** `GatewayTraceState`（13 个字段，分散在
//   onGatewayTrace / onCloudResult / onUsage 等多个回调里拼装）。
//   本模块把 `runAgentTurn` 的 `RuntimeEvent` 流翻译成 UI 已经认识的形状，
//   让 UI 不再需要知道"哪个回调该更新哪个字段"。
//
// 关键设计：**复用既有形状，不发明第二套 UI 状态。**
//   `RuntimeEvent` 先被翻译回 `AiGatewayTraceEvent`（UI 早已认识的那一族），
//   再交给**同一个** `summarizeGatewayTrace` 归约。
//   这样旧链路与新链路得到的状态结构完全一致，UI 渲染代码一行都不用改，
//   也不存在"两套汇总逻辑漂移"的风险。
//
// 本模块是纯函数，无副作用、无 React 依赖 —— 因此可直接单测。

import type { AiGatewayTraceEvent } from '../../ai/gateway';
import type { LocalBackend } from '../../localBackend';
import type { ContextUsage } from '../../ai/modelProfile';
import type { RuntimeEvent } from '../../ai/runtime/contract';
import { summarizeGatewayTrace, type GatewayTraceState } from './gatewayTrace';

/** 翻译上下文：provider 必须来自真实运行参数，不能凭空构造。 */
export interface RuntimeUiContext {
  /** 本地后端；UI 的 provider 字段在本地路由下显示它（`'ollama' | 'llama.cpp'`）。 */
  backend?: LocalBackend;
  /** 云端 provider 名称（仅 route==='cloud' 时使用）。 */
  cloudProvider?: string;
}

/** 轨迹卡描述（UI 用于渲染"隐私检查 / 路由选择"等步骤）。 */
export interface RuntimeTraceCard {
  kind: 'tool' | 'cloud' | 'privacy' | 'route' | 'budget';
  name: string;
  detail: string;
}

export interface RuntimeUiProjection {
  /** 翻译后的网关事件（与旧链路同族，可直接喂给 GatewayTracePanel / summarizeGatewayTrace）。 */
  gatewayEvents: AiGatewayTraceEvent[];
  /** 归约后的状态（与旧链路同一个归约函数产出）。 */
  trace: GatewayTraceState;
  /** 供 UI 渲染的轨迹卡（隐私/路由/工具/预算）。 */
  cards: RuntimeTraceCard[];
}

const EMPTY_USAGE: ContextUsage = {
  contextWindow: 0, currentTokens: 0, systemTokens: 0, messageTokens: 0, toolResultTokens: 0,
  toolSchemaTokens: 0, reservedOutput: 0, safetyMargin: 0, inputHard: 0, inputSoft: 0,
  inputUtilization: 0, largestSource: 'messages',
};

/** 隐私判定的人话摘要（与 AiPanel 既有的 privacyTraceDetail 语义一致）。 */
function privacyCardDetail(event: Extract<RuntimeEvent, { type: 'privacy' }>): string {
  const decision = event.decision;
  const policy = decision.reasonCode.startsWith('source_policy:')
    ? decision.reasonCode.slice('source_policy:'.length).toUpperCase()
    : decision.reasonCode;
  const guard = decision.regexMatches.length
    ? `规则命中 ${decision.regexMatches.join('、')}`
    : '未发现规则命中';
  return `${decision.classification.toUpperCase()} · ${policy} · ${guard} · 云端${decision.cloudSafe ? '允许候选' : '已阻止'}`;
}

/**
 * 把一条 `RuntimeEvent` 翻译成 UI 认识的事件/卡片。
 * 返回 `{}` 表示该事件不产生 UI 影响（例如 thought / token 由别处处理）。
 */
function translate(event: RuntimeEvent, ctx: RuntimeUiContext): { gateway?: AiGatewayTraceEvent; card?: RuntimeTraceCard } {
  const localBackend: LocalBackend = ctx.backend || 'ollama';
  switch (event.type) {
    case 'privacy':
      return {
        gateway: { type: 'privacy_evaluation', route: 'local', provider: localBackend, model: '', decision: event.decision },
        card: { kind: 'privacy', name: '隐私检查', detail: privacyCardDetail(event) },
      };

    case 'route':
      return {
        gateway: {
          type: 'route_selected',
          route: event.route,
          provider: event.route === 'cloud' ? 'cloud' : localBackend,
          model: event.model,
        },
        card: {
          kind: 'route',
          name: '路由选择',
          detail: `${event.route === 'cloud' ? 'Cloud' : 'Local'} · ${event.route === 'cloud' ? (ctx.cloudProvider || 'cloud') : localBackend}${event.model ? ` · ${event.model}` : ''}`,
        },
      };

    case 'tool_start':
      return {
        gateway: {
          type: 'context_preparation', route: 'local', provider: localBackend, model: '',
          status: 'running', executor: 'backend', sourceIds: [event.toolId],
          detail: `工具 ${event.toolId}`,
        },
        card: { kind: 'tool', name: event.toolId, detail: '执行中' },
      };

    case 'tool_result':
      return {
        gateway: {
          type: 'context_preparation', route: 'local', provider: localBackend, model: '',
          status: event.ok ? 'prepared' : 'failed', executor: 'backend', sourceIds: [event.toolId],
          detail: `工具 ${event.toolId} ${event.ok ? '完成' : '失败'}`,
        },
        card: { kind: 'tool', name: event.toolId, detail: event.ok ? '完成' : '失败' },
      };

    case 'cloud_result':
      return {
        gateway: {
          type: 'cloud_context', route: 'cloud', provider: 'cloud', model: '',
          publicMessages: 0, retrieved: 0, tools: 0, outboundCount: null, outboundStatus: 'unknown',
        },
        card: { kind: 'cloud', name: '云端结果', detail: event.ok ? '已返回' : '失败' },
      };

    case 'budget': {
      // 预算事件 → context_usage，让既有的「上下文预算」展示位直接复用
      const usage: ContextUsage = {
        ...EMPTY_USAGE,
        contextWindow: event.budget.effectiveContext,
        inputHard: event.budget.inputHard,
        inputSoft: event.budget.inputSoft,
        reservedOutput: event.budget.outputReserve,
      };
      return {
        gateway: { type: 'context_usage', route: 'local', provider: localBackend, model: '', usage },
        card: {
          kind: 'budget',
          name: '上下文预算',
          detail: `${event.budget.effectiveContext} tokens · ${event.budget.calibrated ? '已标定' : `回落 ${event.budget.fallbackUsed ?? '-'}`}`,
        },
      };
    }

    case 'gateway':
      // 底层已经产出真正的网关事件：原样透传，不二次包装
      return { gateway: event.event };

    default:
      return {};
  }
}

/** 流式归约器：逐条喂事件，随时取当前投影。 */
export function createRuntimeUiProjection(ctx: RuntimeUiContext = {}) {
  const gatewayEvents: AiGatewayTraceEvent[] = [];
  const cards: RuntimeTraceCard[] = [];

  return {
    /** 消费一条事件。 */
    push(event: RuntimeEvent): void {
      const { gateway, card } = translate(event, ctx);
      if (gateway) gatewayEvents.push(gateway);
      if (card) cards.push(card);
    },
    /** 当前投影（每次都重新归约，保证与旧链路同一个函数产出）。 */
    snapshot(): RuntimeUiProjection {
      return {
        gatewayEvents: [...gatewayEvents],
        trace: summarizeGatewayTrace(gatewayEvents),
        cards: [...cards],
      };
    },
    get events() { return [...gatewayEvents]; },
    get cardList() { return [...cards]; },
  };
}

/** 一次性投影（便于测试与批处理）。 */
export function projectRuntimeEvents(events: RuntimeEvent[], ctx: RuntimeUiContext = {}): RuntimeUiProjection {
  const projection = createRuntimeUiProjection(ctx);
  for (const event of events) projection.push(event);
  return projection.snapshot();
}

/**
 * 单条事件的 UI 翻译（供 `AiPanel` 逐条驱动既有回调使用）。
 *
 * 返回 `undefined` 表示该事件不产生网关事件（例如 thought / token / final）。
 * `card` 为可选的轨迹卡描述，UI 若已有自己的步骤渲染可忽略。
 */
export function translateRuntimeEventForUi(event: RuntimeEvent, ctx: RuntimeUiContext = {}): { gateway?: AiGatewayTraceEvent; card?: RuntimeTraceCard } {
  return translate(event, ctx);
}
