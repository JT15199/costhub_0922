// Agent Runtime V1（Stage 3）— AI 协作窗的网关轨迹状态与归约
//
// 为什么把这段从 `AiPanel.tsx` 移出来：
//   Stage 3 要让 UI 既能由旧回调驱动、也能由 `runAgentTurn` 的 `RuntimeEvent` 流驱动，
//   而两条路径必须产出**同一个** `GatewayTraceState`。
//   若归约逻辑留在 2141 行的组件里，runtime 路径就只能重新实现一遍 —— 两份实现必然漂移。
//
//   **本文件是原样搬迁，未修改任何行为。** `summarizeGatewayTrace` 与
//   `emptyGatewayTrace` 的实现逐字符保持原样，只是从组件内部挪到了共享模块，
//   以便 `runtime/uiBridge.ts` 复用同一个归约函数。

import type { AiGatewayTraceEvent } from '../../ai/gateway';
import type { AiNetworkTransport } from '../../ai/networkTrace';
import type { PrivacyDecision } from '../../ai/privacyRouter';
import type { WorkingState } from '../../ai/workingState';

/** AI 协作窗顶部状态条所依赖的轨迹汇总。 */
export interface GatewayTraceState {
  route?: 'local' | 'cloud';
  provider?: string;
  model?: string;
  privacy?: PrivacyDecision;
  publicMessages?: number;
  localMessages?: number;
  retrieved?: number;
  tools?: number;
  outboundCount: number | null;
  outboundAttemptCount: number;
  outboundTransport?: AiNetworkTransport;
  outboundStatus?: 'not_attempted' | 'unknown' | 'attempted' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  toolRequests: number;
}

/** 历史运行快照（面板可回看某一次运行）。 */
export interface GatewayRunSnapshot {
  runId: string;
  label: string;
  events: AiGatewayTraceEvent[];
  workingState?: WorkingState;
  workspace?: string;
}

export const emptyGatewayTrace = (): GatewayTraceState => ({ outboundCount: null, outboundAttemptCount: 0, toolRequests: 0 });

/**
 * 把网关事件序列归约成状态。
 *
 * ⚠️ 原样搬迁自 `AiPanel.tsx`（Stage 3 之前为组件内私有函数），逻辑未改。
 * 之所以能同时服务于旧链路与新链路：`runtime/uiBridge.ts` 把 `RuntimeEvent`
 * 转成**同一族** `AiGatewayTraceEvent`，因此两条路径共用这一个归约器。
 */
export const summarizeGatewayTrace = (events: AiGatewayTraceEvent[]): GatewayTraceState => {
  let state = emptyGatewayTrace();
  for (const event of events) {
    if (event.type === 'route_selected') state = { ...state, route: event.route, provider: event.provider, model: event.model };
    else if (event.type === 'privacy_evaluation') state = { ...state, privacy: event.decision };
    else if (event.type === 'cloud_context') state = { ...state, publicMessages: event.publicMessages, localMessages: event.localMessages, retrieved: event.retrieved, tools: event.tools, outboundCount: event.outboundCount, outboundStatus: event.outboundStatus };
    else if (event.type === 'network_request') {
      const attempted = event.status === 'attempted' && event.outbound;
      const transport = event.transport || (event.transported === true ? 'confirmed' : event.outbound ? 'unknown' : 'not_sent') as AiNetworkTransport;
      const transported = transport === 'confirmed';
      state = {
        ...state,
        outboundCount: event.channel === 'main_model' && !event.outbound && state.outboundCount == null ? 0 : transported ? (state.outboundCount || 0) + 1 : state.outboundCount,
        outboundAttemptCount: state.outboundAttemptCount + (attempted ? 1 : 0),
        outboundTransport: transport,
        outboundStatus: event.status,
        toolRequests: state.toolRequests + (event.channel === 'cloud_tool' && event.status === 'attempted' ? 1 : 0),
      };
    }
  }
  return state;
};
