import { createCostHubPiStream } from './piStream';
import type { LocalBackend } from '../localBackend';
import type { ContextUsage, ModelUsage } from './modelProfile';
import type { Context } from '@earendil-works/pi-ai';
import type { PrivacyDecision, PrivacyEvaluationInput } from './privacyRouter';
import { createCloudProviderStream, type CloudProvider } from './cloudProvider';
import type { CloudSafeContext, CloudSafeDropCounts } from './cloudContext';
import type { AiNetworkTraceEvent } from './networkTrace';

export type AiGatewayRoute = 'local' | 'cloud';

export interface AiGatewayConfig {
  route: AiGatewayRoute;
  backend: LocalBackend;
}

export interface AiGatewayStreamRequest {
  baseUrl: string;
  model: string;
  backend?: LocalBackend;
  onUsage?: (usage: ModelUsage) => void;
  onContextUsage?: (usage: ContextUsage) => void;
  buildContext?: (context: Context) => Context;
  privacy?: Omit<PrivacyEvaluationInput, 'text'>;
  onPrivacy?: (decision: PrivacyDecision) => void;
  onNetwork?: (event: AiNetworkTraceEvent) => void;
  route?: AiGatewayRoute;
  cloud?: { context: CloudSafeContext; privacyDecision: PrivacyDecision; provider: CloudProvider; localMessageCount?: number; dropped?: CloudSafeDropCounts; requestId?: string };
}

export type AiGatewayTraceEvent =
  | { type: 'route_selected'; route: AiGatewayRoute; provider: LocalBackend | 'cloud'; model: string }
  | { type: 'context_usage'; route: AiGatewayRoute; provider: LocalBackend; model: string; usage: ContextUsage }
  | { type: 'privacy_evaluation'; route: AiGatewayRoute; provider: LocalBackend | 'cloud'; model: string; decision: PrivacyDecision }
  | { type: 'context_preparation'; route: AiGatewayRoute; provider: LocalBackend | 'cloud'; model: string; status: 'running' | 'prepared' | 'blocked' | 'failed' | 'cancelled'; executor: 'host_rule' | 'backend' | 'local_model' | 'user'; sourceIds: string[]; includedIds?: string[]; excludedIds?: string[]; detail: string }
  | { type: 'cloud_context'; route: 'cloud'; provider: 'cloud'; model: string; publicMessages: number; localMessages?: number; retrieved: number; tools: number; outboundCount: number | null; outboundStatus: 'not_attempted' | 'unknown'; dropped?: CloudSafeDropCounts; includedStateIds?: string[]; includedMessageIds?: string[]; includedRetrievedIds?: string[] }
  | { type: 'approval'; route: 'cloud'; provider: 'cloud'; model: string; status: 'prepared' | 'checking' | 'waiting_user' | 'approved' | 'rejected' | 'modified' | 'rechecked' | 'sending' | 'succeeded' | 'failed' | 'cancelled' | 'expired'; executor: 'host_rule' | 'backend' | 'user'; requestId: string; approvalId?: string; payloadVersion: number; payloadHash?: string; sourceType?: string; sourceIds?: string[]; localAudit?: { status: 'not_run' | 'pass' | 'blocked' | 'unknown'; matches: string[] }; detail: string; /** Local session replay only; never sent as telemetry. */ previewJson?: string }
  | AiNetworkTraceEvent;

export interface AiGatewayTrace {
  onEvent?: (event: AiGatewayTraceEvent) => void;
}

export type AiGatewayProvider = (request: AiGatewayStreamRequest) => ReturnType<typeof createCostHubPiStream>;

export function resolveAiGatewayConfig(backend: LocalBackend = 'ollama', route: AiGatewayRoute = 'local'): AiGatewayConfig {
  return { route, backend };
}

const localProvider: AiGatewayProvider = request => createCostHubPiStream(
  request.baseUrl,
  request.model,
  request.onUsage || request.onContextUsage || request.buildContext || request.privacy || request.onPrivacy || request.onNetwork ? {
    ...(request.onUsage ? { onUsage: request.onUsage } : {}),
    ...(request.onContextUsage ? { onContextUsage: request.onContextUsage } : {}),
    ...(request.buildContext ? { buildContext: request.buildContext } : {}),
    ...(request.privacy ? { privacy: request.privacy } : {}),
    ...(request.onPrivacy ? { onPrivacy: request.onPrivacy } : {}),
    ...(request.onNetwork ? { onNetwork: request.onNetwork } : {}),
  } : undefined,
  request.backend || 'ollama',
);

function createLocalStream(request: AiGatewayStreamRequest, trace?: AiGatewayTrace) {
  const config = resolveAiGatewayConfig(request.backend, 'local');
  const onContextUsage = request.onContextUsage || trace?.onEvent ? (usage: ContextUsage) => {
    request.onContextUsage?.(usage);
    trace?.onEvent?.({ type: 'context_usage', route: 'local', provider: config.backend, model: request.model, usage });
  } : undefined;
  const onPrivacy = request.onPrivacy || trace?.onEvent ? (decision: PrivacyDecision) => {
    request.onPrivacy?.(decision);
    trace?.onEvent?.({ type: 'privacy_evaluation', route: 'local', provider: config.backend, model: request.model, decision });
  } : undefined;
  const onNetwork = request.onNetwork || trace?.onEvent ? (event: AiNetworkTraceEvent) => {
    request.onNetwork?.(event);
    trace?.onEvent?.(event);
  } : undefined;
  return localProvider({ ...request, route: 'local', backend: config.backend, onContextUsage, onPrivacy, onNetwork });
}

export function createAiGatewayStream(request: AiGatewayStreamRequest, trace?: AiGatewayTrace) {
  const config = resolveAiGatewayConfig(request.backend, request.route || 'local');
  if (config.route === 'cloud') {
    const decision = request.cloud?.privacyDecision;
    const safe = decision?.classification === 'public' && decision.cloudSafe && decision.candidateRoute === 'cloud_candidate' && request.cloud?.context.tools.length === 0;
    if (!safe) {
      // Security failures never expose the Cloud projection; continue with
      // the existing Local provider using the final local-only decision.
      const fallbackPrivacy = decision ? {
        ...(request.privacy || {}),
        sourceTypes: decision.sourceTypes,
        classifier: () => ({ classification: decision.classification, reasonCode: decision.reasonCode }),
      } : request.privacy;
      trace?.onEvent?.({ type: 'route_selected', route: 'local', provider: config.backend, model: request.model });
      return createLocalStream({ ...request, route: 'local', privacy: fallbackPrivacy }, trace);
    }
    trace?.onEvent?.({ type: 'route_selected', route: 'cloud', provider: 'cloud', model: request.model });
    if (decision) {
      request.onPrivacy?.(decision);
      trace?.onEvent?.({ type: 'privacy_evaluation', route: 'cloud', provider: 'cloud', model: request.model, decision });
    }
    const context = request.cloud?.context || { systemPrompt: '', workingState: [], messages: [], retrieved: [], tools: [] as const };
    trace?.onEvent?.({ type: 'cloud_context', route: 'cloud', provider: 'cloud', model: request.model, publicMessages: context.messages.length, ...(request.cloud?.localMessageCount == null ? {} : { localMessages: request.cloud.localMessageCount }), retrieved: context.retrieved.length, tools: context.tools.length, outboundCount: null, outboundStatus: 'not_attempted', ...(request.cloud?.dropped ? { dropped: request.cloud.dropped } : {}), includedStateIds: context.workingState.map(item => item.id), includedMessageIds: context.messages.map(item => item.id), includedRetrievedIds: context.retrieved.map(item => item.id) });
    const provider = request.cloud?.provider || (async () => { throw new Error('Cloud Route 已阻止：缺少 Provider'); });
    return createCloudProviderStream(request.model, context, provider, event => {
      request.onNetwork?.(event);
      trace?.onEvent?.(event);
    }, request.cloud?.requestId);
  }
  trace?.onEvent?.({ type: 'route_selected', route: 'local', provider: config.backend, model: request.model });
  return createLocalStream(request, trace);
}
