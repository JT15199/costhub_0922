import type { ContextMetadata } from './contextMetadata';
import { evaluatePrivacy, reviewedPublicClassifier } from './privacyRouter';
import type { PrivacyDecision } from './privacyRouter';
import { visibleStateItems, type StateItem, type WorkingState } from './workingState';

export const CLOUD_SYSTEM_PROMPT = '你是 CostHub 公共信息助手。只能依据本次提供的公开内容回答；不要索取、推断或复原任何本地项目、BOM、报价、成本、供应商、文件或内部工具信息。证据不足时明确说明未知。';

export interface ApprovedCloudMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  approved: boolean;
  metadata?: ContextMetadata;
}

export interface ApprovedCloudRetrieval {
  id: string;
  text: string;
  approved: boolean;
  metadata?: ContextMetadata;
}

export interface CloudSafeStateItem {
  id: string;
  text: string;
  priority: StateItem['priority'];
}

export interface CloudSafeMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface CloudSafeContext {
  systemPrompt: string;
  workingState: CloudSafeStateItem[];
  messages: CloudSafeMessage[];
  retrieved: Array<{ id: string; content: string }>;
  tools: readonly [];
}

export interface CloudSafeContextInput {
  privacyDecision: PrivacyDecision;
  workingState?: WorkingState;
  approvedMessages?: ApprovedCloudMessage[];
  approvedRetrieval?: ApprovedCloudRetrieval[];
  /** Candidate preview is local-only; final send must rebuild with approved metadata. */
  allowUserCandidate?: boolean;
}

export interface CloudSafeDropCounts {
  stateItems: number;
  messages: number;
  retrieved: number;
}

export interface CloudSafeBuildResult {
  context: CloudSafeContext;
  dropped: CloudSafeDropCounts;
}

export const MAX_CLOUD_CONTEXT_CHARS = 200_000;

const publicMetadata = (sourceId: string): ContextMetadata => ({
  sourceType: 'public_approved_content', sensitivity: 'public', cloudSafe: true, priority: 'normal', sourceIds: [sourceId], verified: true,
});

// Keep the approved projection byte-for-byte readable. Oversized payloads are
// rejected by the approval gate instead of silently becoming a different request.
const exactText = (value: string) => {
  if (value.length > MAX_CLOUD_CONTEXT_CHARS) throw new Error('云端审批载荷过大，未生成截断后的请求');
  return value;
};

function stateItems(state: WorkingState | undefined): StateItem[] {
  if (!state) return [];
  return [
    ...visibleStateItems(state.userConstraints, state.activeProject),
    ...visibleStateItems(state.confirmedFacts, state.activeProject),
    ...visibleStateItems(state.decisions, state.activeProject),
    ...visibleStateItems(state.openQuestions, state.activeProject),
    ...visibleStateItems(state.businessContext, state.activeProject),
  ];
}

function isPublicText(text: string, metadata: ContextMetadata | undefined, allowUserCandidate = false) {
  if (allowUserCandidate && !metadata) {
    const candidate = evaluatePrivacy({ text, sourceTypes: ['user_selected_cloud_candidate'], metadata: [], classifier: () => ({ classification: 'public', reasonCode: 'user_selected_cloud_candidate' }) });
    return candidate.classification === 'public' && candidate.cloudSafe;
  }
  const decision = evaluatePrivacy({
    text,
    sourceTypes: ['public_approved_content'],
    metadata: [metadata || publicMetadata('approved')],
    classifier: reviewedPublicClassifier,
  });
  return decision.classification === 'public' && decision.cloudSafe;
}

/**
 * Build a new cloud projection from approved public inputs only. It never
 * accepts the raw Agent Context, so local history/tool results cannot leak by
 * accidental spreading.
 */
export function buildCloudSafeContext(input: CloudSafeContextInput): CloudSafeBuildResult {
  const decision = input.privacyDecision;
  const localCandidate = input.allowUserCandidate && decision.classification === 'unknown';
  if (!localCandidate && (decision.classification !== 'public' || !decision.cloudSafe || decision.candidateRoute !== 'cloud_candidate')) {
    throw new Error(`Cloud Route 已阻止：隐私判定为 ${decision.classification}/${decision.reasonCode}`);
  }

  const allState = stateItems(input.workingState);
  const workingState = allState
    .filter(item => item.status === 'active' && item.sensitivity === 'public' && item.provenance?.cloudSafe && isPublicText(item.text, item.provenance, input.allowUserCandidate))
    .map(item => ({ id: item.id, text: exactText(item.text), priority: item.priority }));

  const approvedMessages = input.approvedMessages || [];
  const messages = approvedMessages
    .filter(message => message.approved && Boolean(message.id) && isPublicText(message.text, message.metadata, input.allowUserCandidate))
    .map(message => ({ id: message.id, role: message.role, content: exactText(message.text) }));

  const approvedRetrieval = input.approvedRetrieval || [];
  const retrieved = approvedRetrieval
    .filter(item => item.approved && Boolean(item.id) && isPublicText(item.text, item.metadata, input.allowUserCandidate))
    .map(item => ({ id: item.id, content: exactText(item.text) }));

  return {
    context: { systemPrompt: CLOUD_SYSTEM_PROMPT, workingState, messages, retrieved, tools: [] },
    dropped: {
      stateItems: allState.length - workingState.length,
      messages: approvedMessages.length - messages.length,
      retrieved: approvedRetrieval.length - retrieved.length,
    },
  };
}
