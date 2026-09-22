// Agent Runtime V1（Stage 2）— 隐私与路由阶段
//
// 从 `session.ts` 拆出（Stage 1 收尾时 session.ts 已 299 行，加入本阶段逻辑后到 360 行，
// 超出 300 行上限）。拆分原则与设计文档一致：**按职责拆，不提高上限**。
//
// 本模块负责「运行前的两个阶段」：隐私判定 → 路由决策。
// 它返回**事件载荷**而不直接 emit，因此：
//   * 可被独立单测（不需要驱动整个会话）；
//   * 事件顺序仍由 `session.ts` 单一处决定，不会两处各发一遍。
//
// 关键约束：**不复制 privacyRouter 的逻辑**，只调用 `evaluatePrivacy`。
// 工具声明的翻译在 `toolPrivacy.ts`，本模块只做编排。

import { evaluatePrivacy, type PrivacyDecision } from '../privacyRouter';
import { aggregateToolPrivacy, buildPrivacySourceTypes, decideRoute, type PrivacyDeclaringTool, type ToolPrivacyAggregate } from './toolPrivacy';
import type { AgentRequest, RuntimeEventPayload } from './contract';

export interface PreflightResult {
  /** 隐私判定结果（原样来自 privacyRouter）。 */
  decision: PrivacyDecision;
  /** 工具隐私聚合结果。 */
  toolPrivacy: ToolPrivacyAggregate;
  /** 实际传入 evaluatePrivacy 的来源标签（审计用）。 */
  sourceTypes: string[];
  /** 路由决策。 */
  route: 'local' | 'cloud';
  /** 按顺序应发出的事件载荷。 */
  events: RuntimeEventPayload[];
}

export interface PreflightInput {
  request: AgentRequest;
  /** 由 session 提供，保证 provider 字段与运行参数一致。 */
  provider: string;
  model: string;
}

/**
 * 执行「隐私 → 路由」两个阶段。
 *
 * 顺序与设计文档 §3.5 一致：先判定敏感度，再决定是否允许云端候选。
 * 任何一步不确定都落在本地（`decideRoute` 内部 fail-closed）。
 */
export function runPreflight({ request, provider, model }: PreflightInput): PreflightResult {
  const tools = (request.options.tools || []) as PrivacyDeclaringTool[];
  const toolPrivacy = aggregateToolPrivacy(tools);
  const sourceTypes = buildPrivacySourceTypes(
    toolPrivacy,
    Array.isArray(request.options.privacySourceTypes) ? (request.options.privacySourceTypes as string[]) : [],
  );

  const events: RuntimeEventPayload[] = [
    {
      type: 'stage',
      stage: 'privacy',
      status: 'start',
      detail: { strictestToolPrivacy: toolPrivacy.strictest, undeclaredTools: toolPrivacy.undeclaredCount },
    },
  ];

  const decision = evaluatePrivacy({
    text: request.userMessage,
    sourceTypes,
    metadata: Array.isArray(request.options.privacyMetadata) ? (request.options.privacyMetadata as never[]) : [],
    // 未显式提供分类器时使用 evaluatePrivacy 的内部默认分类器（不在此处另造一套）。
    classifier: request.options.localPrivacyClassifier as never,
  });

  events.push({ type: 'privacy', decision });
  events.push({
    type: 'stage',
    stage: 'privacy',
    status: decision.cloudSafe ? 'ok' : 'skip',
    detail: { classification: decision.classification, reasonCode: decision.reasonCode, cloudEligible: toolPrivacy.cloudEligible },
  });

  events.push({ type: 'stage', stage: 'route', status: 'start' });

  const route = decideRoute({
    requestedRoute: request.options.gatewayRoute,
    cloudSafe: decision.cloudSafe,
    toolCloudEligible: toolPrivacy.cloudEligible,
  });

  events.push({ type: 'route', route, provider: route === 'cloud' ? 'cloud' : provider, model });
  events.push({
    type: 'stage',
    stage: 'route',
    status: 'ok',
    detail: {
      route,
      // 明确区分"用户选的是候选路径"与"实际会外发"：路由 != 外发
      requested: request.options.gatewayRoute || 'local',
      cloudSafe: decision.cloudSafe,
      toolCloudEligible: toolPrivacy.cloudEligible,
    },
  });

  return { decision, toolPrivacy, sourceTypes, route, events };
}
