import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextMetadata, ContextPriority, DataSensitivity } from './contextMetadata';

export type StateSensitivity = Exclude<DataSensitivity, 'unknown'>;
export type StateConfidence = 'confirmed' | 'inferred' | 'temporary';
export type StateStatus = 'active' | 'superseded' | 'closed';
export type StateScope = 'shared' | 'project';

export interface StateItem {
  id: string;
  text: string;
  sourceMessageIds: string[];
  sensitivity: StateSensitivity;
  confidence: StateConfidence;
  status: StateStatus;
  priority: ContextPriority;
  provenance: ContextMetadata;
  scope?: StateScope;
  projectKey?: string;
  subject?: string;
}

export interface ProjectRef {
  key?: string;
  code?: string;
  name?: string;
  stage?: string;
  supplierScope?: string;
  currentGoal?: string;
  currentTask?: string;
}

export interface FileRef {
  path: string;
  label?: string;
  sensitivity?: StateSensitivity;
  scope?: StateScope;
  projectKey?: string;
}

export interface ArtifactRef {
  id: string;
  label?: string;
  path?: string;
  sensitivity?: StateSensitivity;
  scope?: StateScope;
  projectKey?: string;
}

export interface ToolState {
  name: string;
  status: 'active' | 'completed' | 'failed';
  lastUsedAt: number;
  sourceMessageIds: string[];
}

export interface TaskStep {
  id: string;
  text: string;
  status: 'completed' | 'active' | 'pending' | 'blocked';
  sourceMessageIds: string[];
  priority: ContextPriority;
  scope?: StateScope;
  projectKey?: string;
}

export interface BusinessStateItem extends StateItem {
  key?: string;
}

export interface WorkingState {
  sessionId: string;
  activeProject?: ProjectRef;
  projectContexts: ProjectRef[];
  currentGoal: string;
  currentTask: string;
  userConstraints: StateItem[];
  confirmedFacts: StateItem[];
  decisions: StateItem[];
  openQuestions: StateItem[];
  activeFiles: FileRef[];
  activeArtifacts: ArtifactRef[];
  activeTools: ToolState[];
  completedSteps: TaskStep[];
  nextSteps: TaskStep[];
  businessContext: BusinessStateItem[];
  lastUpdatedAt: number;
}

export interface WorkingStateDelta {
  activeProject?: ProjectRef;
  currentGoal?: string;
  currentTask?: string;
  userConstraints?: StateItem[];
  confirmedFacts?: StateItem[];
  decisions?: StateItem[];
  openQuestions?: StateItem[];
  closedQuestionTexts?: string[];
  activeFiles?: FileRef[];
  activeArtifacts?: ArtifactRef[];
  activeTools?: ToolState[];
  completedSteps?: TaskStep[];
  nextSteps?: TaskStep[];
  businessContext?: BusinessStateItem[];
}

export interface WorkingStateExtractionInput {
  sessionId: string;
  messages: AgentMessage[];
  activeProject?: ProjectRef;
  sourcePrefix?: string;
  now?: number;
}

const textOf = (message: any): string => Array.isArray(message?.content)
  ? message.content.map((part: any) => part?.type === 'text' ? String(part.text || '') : part?.type === 'thinking' ? '' : part?.type === 'toolCall' ? `[tool:${part.name || ''}]` : '').join('')
  : String(message?.content ?? '');

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const clip = (value: string, max = 240) => value.replace(/\s+/g, ' ').trim().slice(0, max);
const hash = (value: string) => {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(16);
};
const stableId = (prefix: string, subject: string, text: string) => `${prefix}_${hash(`${subject}:${normalize(text)}`)}`;
const sourceId = (message: any, index: number, prefix = 'message') => typeof message?.id === 'string' ? message.id : `${prefix}:${index}`;

/** Assign once at the durable message boundary so state and raw history share the same source key. */
export function withStableMessageId(message: AgentMessage, id: string): AgentMessage {
  const existing = (message as any)?.id;
  return typeof existing === 'string' && existing.trim() ? message : { ...(message as any), id } as AgentMessage;
}

const metadata = (sourceType: string, sensitivity: StateSensitivity, priority: ContextPriority, sourceIds: string[]): ContextMetadata => ({
  sourceType, sensitivity, cloudSafe: sensitivity === 'public', priority, sourceIds: [...new Set(sourceIds)],
});

function item(
  prefix: string,
  subject: string,
  text: string,
  sourceMessageIds: string[],
  sourceType: string,
  sensitivity: StateSensitivity,
  confidence: StateConfidence,
  priority: ContextPriority,
): StateItem {
  return {
    id: stableId(prefix, subject, text), text: clip(text), sourceMessageIds: [...new Set(sourceMessageIds)], sensitivity,
    confidence, status: 'active', priority, provenance: metadata(sourceType, sensitivity, priority, sourceMessageIds), scope: 'shared', subject,
  };
}

function extractTargetCost(text: string, messageId: string, role: string): StateItem | undefined {
  const matches = [...text.matchAll(/(?:目标(?:成本|价|价格)|(?:改成|调整为|变更为|设为))[^\d¥￥]{0,24}[¥￥]?\s*(\d+(?:\.\d+)?)/giu)];
  if (!matches.length) return undefined;
  const value = matches[matches.length - 1][1];
  const uncertain = /(可能|大约|大概|预计|暂定|估计|也许|待确认|待核实)/u.test(text);
  const confidence: StateConfidence = role === 'user' && !uncertain ? 'confirmed' : uncertain ? 'temporary' : 'inferred';
  return item('fact', 'target_cost', `目标成本 ${value}`, [messageId], role === 'user' ? 'user_message' : 'tool_result', 'sensitive', confidence, 'critical');
}

function extractConstraints(text: string, messageId: string): StateItem[] {
  const patterns = [
    /不可外发/gu,
    /禁止外发/gu,
    /不(?:改|修改)(?:动)?\s*Pi(?:\s*内核)?/giu,
    /保持现有(?:的)?\s*UI(?:\s*风格)?/giu,
    /(?:只|仅)修改[^。；;\n]{1,80}/gu,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(clip(match[0]));
  return [...found].map(value => item(
    'constraint', normalize(value), value, [messageId], 'user_message', /外发|Pi|UI/u.test(value) ? 'restricted' : 'internal', 'confirmed', 'high',
  ));
}

function decisionSubject(text: string): string {
  if (/Pi(?:\s*内核|\s*core|\s*runtime)?/iu.test(text)) return 'decision:pi';
  if (/privacy\s*router|隐私路由|隐私/u.test(text)) return 'decision:privacy';
  if (/cloud\s*tools?|云端工具/u.test(text)) return 'decision:cloud-tools';
  return `decision:${normalize(text).slice(0, 32)}`;
}

function extractDecisions(text: string, messageId: string): StateItem[] {
  const found = new Set<string>();
  for (const pattern of [
    /(?:已经|已)?确定(?:使用|采用)?\s*([^。；;\n]{2,100})/gu,
    /决定(?:使用|采用)?\s*([^。；;\n]{2,100})/gu,
  ]) for (const match of text.matchAll(pattern)) if (match[1]) found.add(clip(match[1]));
  return [...found].map(value => item('decision', decisionSubject(value), `已确定：${value}`, [messageId], 'user_message', 'internal', 'confirmed', 'high'));
}

function extractOpenQuestions(text: string, messageId: string): StateItem[] {
  const found = new Set<string>();
  for (const pattern of [/(?:待确认|待核实|需要确认|需要验证|未知|无法确定)[：:：]?\s*([^。；;\n]{0,100})/gu, /是否[^。；;\n]{2,80}/gu]) {
    for (const match of text.matchAll(pattern)) found.add(clip(match[1] || match[0]));
  }
  return [...found].filter(Boolean).map(value => item('question', normalize(value), value, [messageId], 'user_message', 'internal', 'temporary', 'normal'));
}

function extractSteps(text: string, messageId: string): { completed: TaskStep[]; next: TaskStep[] } {
  const make = (value: string, status: TaskStep['status']): TaskStep => ({ id: stableId('step', status, value), text: clip(value, 180), status, sourceMessageIds: [messageId], priority: 'normal' });
  const completed = [...text.matchAll(/(?:已完成|完成了)[：:：]?\s*([^。；;\n]{1,120})/gu)].map(match => make(match[1], 'completed'));
  const next = [...text.matchAll(/(?:下一步|接下来)[：:：]?\s*([^。；;\n]{1,120})/gu)].map(match => make(match[1], 'pending'));
  return { completed, next };
}

export function emptyWorkingState(sessionId: string): WorkingState {
  return {
    sessionId, projectContexts: [], currentGoal: '', currentTask: '', userConstraints: [], confirmedFacts: [], decisions: [], openQuestions: [],
    activeFiles: [], activeArtifacts: [], activeTools: [], completedSteps: [], nextSteps: [], businessContext: [], lastUpdatedAt: 0,
  };
}

export function normalizeWorkingState(value: unknown, sessionId: string): WorkingState {
  const source = value && typeof value === 'object' ? value as Partial<WorkingState> : {};
  const base = emptyWorkingState(typeof source.sessionId === 'string' ? source.sessionId : sessionId);
  const legacyProjectKey = projectKey(source.activeProject);
  const scopeLegacy = <T extends OwnedRef>(items: unknown): T[] => Array.isArray(items)
    ? items.map(item => legacyProjectKey && item && typeof item === 'object' && !(item as OwnedRef).scope && !(item as OwnedRef).projectKey
      ? { ...(item as T), scope: 'project' as const, projectKey: legacyProjectKey }
      : item as T)
    : [];
  const confirmedFacts = Array.isArray(source.confirmedFacts)
    ? source.confirmedFacts.map(fact => fact.subject === 'target_cost' && !fact.scope && !fact.projectKey
      ? { ...fact, scope: 'project' as const, ...(legacyProjectKey ? { projectKey: legacyProjectKey } : {}) }
      : fact)
    : [];
  return {
    ...base,
    ...source,
    sessionId: base.sessionId,
    projectContexts: Array.isArray(source.projectContexts) ? source.projectContexts : [],
    currentGoal: typeof source.currentGoal === 'string' ? source.currentGoal : '',
    currentTask: typeof source.currentTask === 'string' ? source.currentTask : '',
    userConstraints: Array.isArray(source.userConstraints) ? source.userConstraints : [],
    // Legacy target-cost facts have no owner. Keep them in local history, but
    // never expose them as shared context after project ownership was added.
    confirmedFacts,
    decisions: scopeLegacy(source.decisions),
    openQuestions: scopeLegacy(source.openQuestions),
    activeFiles: scopeLegacy(source.activeFiles),
    activeArtifacts: scopeLegacy(source.activeArtifacts),
    activeTools: Array.isArray(source.activeTools) ? source.activeTools : [],
    completedSteps: scopeLegacy(source.completedSteps),
    nextSteps: scopeLegacy(source.nextSteps),
    businessContext: Array.isArray(source.businessContext) ? source.businessContext : [],
    lastUpdatedAt: Number.isFinite(source.lastUpdatedAt) ? Number(source.lastUpdatedAt) : 0,
  };
}

const normalizedProjectText = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export function projectKey(project?: ProjectRef): string | undefined {
  if (!project) return undefined;
  const value = project.key || project.code || project.name;
  const normalized = normalizedProjectText(value);
  return normalized ? normalized.slice(0, 120) : undefined;
}

function stateScope(item: StateItem): StateScope {
  return item.scope || (item.projectKey ? 'project' : 'shared');
}

type OwnedRef = { scope?: StateScope; projectKey?: string };

function ownedRefVisible(item: OwnedRef, activeProject?: ProjectRef): boolean {
  if (item.scope !== 'project' && !item.projectKey) return true;
  const activeKey = projectKey(activeProject);
  return Boolean(activeKey && item.projectKey === activeKey);
}

export function visibleOwnedRefs<T extends OwnedRef>(items: T[] = [], activeProject?: ProjectRef): T[] {
  return items.filter(item => ownedRefVisible(item, activeProject));
}

export function isStateItemVisible(item: StateItem, activeProject?: ProjectRef): boolean {
  if (stateScope(item) === 'shared') return true;
  const activeKey = projectKey(activeProject);
  return Boolean(activeKey && item.projectKey && item.projectKey === activeKey);
}

export function visibleStateItems<T extends StateItem>(items: T[] = [], activeProject?: ProjectRef): T[] {
  return items.filter(item => isStateItemVisible(item, activeProject));
}

function extractProjectRef(text: string): ProjectRef | undefined {
  const projectCode = text.match(/\b[A-Za-z]{1,4}\s?[-_]?[0-9]{2,}\b/u)?.[0];
  const namedProject = text.match(/项目[名称代号]*[：:]\s*([^，,。；;\n]{1,60})/u)?.[1]
    || text.match(/(?:切换到|回到|进入)\s*(项目\s*[^，,。；;\n]{1,40})/u)?.[1];
  const stage = text.match(/(?:当前)?阶段[：:]\s*([^，,。；;\n]{1,40})/u)?.[1];
  const supplierScope = text.match(/供应商(?:范围|名单)?[：:]\s*([^，,。；;\n]{1,80})/u)?.[1];
  if (!projectCode && !namedProject && !stage && !supplierScope) return undefined;
  return {
    ...(projectCode ? { code: projectCode.replace(/\s+/g, '') } : {}),
    ...(namedProject ? { name: clip(namedProject, 60) } : {}),
    ...(stage ? { stage: clip(stage, 40) } : {}),
    ...(supplierScope ? { supplierScope: clip(supplierScope, 80) } : {}),
  };
}

// ponytail: deterministic extraction keeps every Turn cheap and fail-safe; add a
// temperature-0 local structured call only when heuristic coverage is measured insufficient.
export function extractWorkingStateDelta(input: WorkingStateExtractionInput): WorkingStateDelta {
  const delta: WorkingStateDelta = { userConstraints: [], confirmedFacts: [], decisions: [], openQuestions: [], activeTools: [], completedSteps: [], nextSteps: [] };
  let latestUser = '';
  input.messages.forEach((message, index) => {
    const role = String((message as any)?.role || '');
    const text = textOf(message);
    if (!text.trim()) return;
    const id = sourceId(message, index, input.sourcePrefix);
    if (role === 'user') {
      latestUser = text;
      const target = extractTargetCost(text, id, role);
      if (target) delta.confirmedFacts!.push(target);
      delta.userConstraints!.push(...extractConstraints(text, id));
      delta.decisions!.push(...extractDecisions(text, id));
      delta.openQuestions!.push(...extractOpenQuestions(text, id));
      const steps = extractSteps(text, id);
      delta.completedSteps!.push(...steps.completed); delta.nextSteps!.push(...steps.next);
      if (/(?:已确认|确认了|确认为|解决了)/u.test(text)) delta.closedQuestionTexts = [...(delta.closedQuestionTexts || []), clip(text)];
    } else if (role === 'toolResult') {
      const toolName = String((message as any)?.toolName || 'tool');
      delta.activeTools!.push({ name: toolName, status: (message as any)?.isError ? 'failed' : 'completed', lastUsedAt: Number((message as any)?.timestamp) || input.now || Date.now(), sourceMessageIds: [id] });
      const details = (message as any)?.details;
      const filePath = details && typeof details === 'object' ? (typeof details.fullResultPath === 'string' ? details.fullResultPath : typeof details.fullOutputPath === 'string' ? details.fullOutputPath : undefined) : undefined;
      if (filePath) (delta.activeFiles ||= []).push({ path: filePath, sensitivity: 'sensitive' });
      const target = extractTargetCost(text, id, role);
      if (target) delta.confirmedFacts!.push(target);
    }
  });
  const parsedProject = extractProjectRef(latestUser);
  if (parsedProject) delta.activeProject = parsedProject;
  // A turn may only update a project field (supplier/stage). Merge that
  // partial ref into the current entity before assigning ownership.
  const currentProject = parsedProject
    ? projectKey(parsedProject) ? parsedProject : { ...input.activeProject, ...parsedProject }
    : input.activeProject;
  const currentProjectKey = projectKey(currentProject);
  const scopeProjectRefs = <T extends OwnedRef>(items: T[]) => currentProjectKey
    ? items.map(value => ({ ...value, scope: 'project' as const, projectKey: value.projectKey || currentProjectKey }))
    : items;
  delta.decisions = scopeProjectRefs(delta.decisions || []);
  delta.openQuestions = scopeProjectRefs(delta.openQuestions || []);
  delta.activeFiles = scopeProjectRefs(delta.activeFiles || []);
  delta.activeArtifacts = scopeProjectRefs(delta.activeArtifacts || []);
  delta.completedSteps = scopeProjectRefs(delta.completedSteps || []);
  delta.nextSteps = scopeProjectRefs(delta.nextSteps || []);
  delta.confirmedFacts = (delta.confirmedFacts || []).map(fact => fact.subject === 'target_cost' && currentProjectKey
    ? { ...fact, scope: 'project', projectKey: currentProjectKey }
    : fact);
  if (latestUser.trim()) {
    delta.currentTask = clip(latestUser);
    if (/(?:目标|需要|希望|想要|请|实现|修改|依据)/u.test(latestUser)) delta.currentGoal = clip(latestUser);
  }
  return delta;
}

function mergeItems(existing: StateItem[], incoming: StateItem[]): StateItem[] {
  const result = existing.map(value => ({ ...value, sourceMessageIds: [...(value.sourceMessageIds || [])], provenance: { ...value.provenance, sourceIds: [...(value.provenance?.sourceIds || [])] } }));
  const sameScope = (left: StateItem, right: StateItem) => stateScope(left) === stateScope(right) && (left.projectKey || '') === (right.projectKey || '');
  for (const candidate of incoming) {
    const sameSubject = candidate.subject ? result.find(value => value.status === 'active' && sameScope(value, candidate) && value.subject === candidate.subject) : undefined;
    const sameText = result.find(value => value.status === 'active' && sameScope(value, candidate) && normalize(value.text) === normalize(candidate.text));
    const current = sameSubject || sameText;
    if (current && normalize(current.text) === normalize(candidate.text)) {
      current.sourceMessageIds = [...new Set([...current.sourceMessageIds, ...candidate.sourceMessageIds])];
      current.provenance.sourceIds = [...new Set([...current.provenance.sourceIds, ...candidate.provenance.sourceIds])];
      continue;
    }
    if (sameSubject && current!.confidence === 'confirmed' && candidate.confidence !== 'confirmed') continue;
    if (sameSubject && candidate.confidence === 'confirmed') current!.status = 'superseded';
    result.push(candidate);
  }
  return result;
}

function mergeSteps(existing: TaskStep[], incoming: TaskStep[]): TaskStep[] {
  const result = existing.map(step => ({ ...step, sourceMessageIds: [...(step.sourceMessageIds || [])] }));
  for (const candidate of incoming) {
    const current = result.find(step => normalize(step.text) === normalize(candidate.text)
      && (step.projectKey || '') === (candidate.projectKey || '')
      && (step.scope || 'shared') === (candidate.scope || 'shared'));
    if (current) { current.status = candidate.status; current.sourceMessageIds = [...new Set([...current.sourceMessageIds, ...candidate.sourceMessageIds])]; }
    else result.push(candidate);
  }
  return result;
}

export function applyWorkingStateDelta(state: WorkingState, delta: WorkingStateDelta, now = Date.now()): WorkingState {
  const next = normalizeWorkingState(state, state.sessionId);
  const previousProjectKey = projectKey(next.activeProject);
  if (delta.activeProject || next.activeProject) {
    const requestedKey = projectKey(delta.activeProject) || projectKey(next.activeProject);
    if (requestedKey && previousProjectKey && requestedKey !== previousProjectKey) {
      const previousIndex = next.projectContexts.findIndex(project => projectKey(project) === previousProjectKey);
      const previous = { ...next.activeProject, currentGoal: next.currentGoal, currentTask: next.currentTask };
      if (previousIndex >= 0) next.projectContexts[previousIndex] = previous;
      else next.projectContexts.push(previous);
    }
    const known = requestedKey ? next.projectContexts.find(project => projectKey(project) === requestedKey) : next.activeProject;
    const currentKey = projectKey(next.activeProject);
    const base = requestedKey && requestedKey === currentKey ? next.activeProject : known;
    const activeProject = { ...base, ...delta.activeProject, ...(requestedKey ? { key: requestedKey } : {}) };
    next.activeProject = activeProject;
    if (requestedKey && requestedKey !== previousProjectKey) {
      next.currentGoal = activeProject.currentGoal || '';
      next.currentTask = activeProject.currentTask || '';
    }
    if (requestedKey) {
      const index = next.projectContexts.findIndex(project => projectKey(project) === requestedKey);
      if (index >= 0) next.projectContexts[index] = activeProject;
      else next.projectContexts.push(activeProject);
    }
  }
  if (delta.currentGoal?.trim()) next.currentGoal = clip(delta.currentGoal);
  if (delta.currentTask?.trim()) next.currentTask = clip(delta.currentTask);
  const activeProjectAfterUpdate = projectKey(next.activeProject);
  if (activeProjectAfterUpdate) {
    const index = next.projectContexts.findIndex(project => projectKey(project) === activeProjectAfterUpdate);
    if (index >= 0) next.projectContexts[index] = { ...next.projectContexts[index], currentGoal: next.currentGoal, currentTask: next.currentTask };
  }
  next.userConstraints = mergeItems(next.userConstraints, delta.userConstraints || []);
  const scopeProjectItems = (items: StateItem[]) => items.map(item => item.scope === 'project' || item.projectKey
    ? { ...item, scope: 'project' as const }
    : item);
  next.confirmedFacts = mergeItems(next.confirmedFacts, scopeProjectItems(delta.confirmedFacts || []));
  next.decisions = mergeItems(next.decisions, scopeProjectItems(delta.decisions || []));
  next.openQuestions = mergeItems(next.openQuestions, scopeProjectItems(delta.openQuestions || []));
  for (const closed of delta.closedQuestionTexts || []) {
    for (const question of next.openQuestions) if (question.status === 'active' && (normalize(closed).includes(normalize(question.text)) || normalize(question.text).includes(normalize(closed)))) question.status = 'closed';
  }
  next.activeFiles = [...new Map([...(next.activeFiles || []), ...(delta.activeFiles || [])].map(file => [`${file.projectKey || 'shared'}:${file.path}`, file])).values()];
  next.activeArtifacts = [...new Map([...(next.activeArtifacts || []), ...(delta.activeArtifacts || [])].map(artifact => [`${artifact.projectKey || 'shared'}:${artifact.id}`, artifact])).values()];
  next.activeTools = [...new Map([...(next.activeTools || []), ...(delta.activeTools || [])].map(tool => [tool.name, { ...tool, sourceMessageIds: [...new Set(tool.sourceMessageIds || [])] }])).values()];
  next.completedSteps = mergeSteps(next.completedSteps, delta.completedSteps || []);
  next.nextSteps = mergeSteps(next.nextSteps, delta.nextSteps || []);
  next.businessContext = mergeItems(next.businessContext, delta.businessContext || []) as BusinessStateItem[];
  for (const completed of delta.completedSteps || []) {
    const pending = next.nextSteps.find(step => normalize(step.text) === normalize(completed.text)
      && (step.projectKey || '') === (completed.projectKey || '')
      && (step.scope || 'shared') === (completed.scope || 'shared'));
    if (pending) pending.status = 'completed';
  }
  next.lastUpdatedAt = now;
  return next;
}

export function updateWorkingState(state: WorkingState, input: WorkingStateExtractionInput): WorkingState {
  return applyWorkingStateDelta(state, extractWorkingStateDelta({ ...input, activeProject: input.activeProject || state.activeProject }), input.now || Date.now());
}
