// 云端发送前确认（v2.3.19，2026-08-17 重构为「非打断式待确认队列」）
// 背景 v1：autoInsight 后台轮询时直接弹 antd Modal.confirm——用户反馈"弹窗自己弹、不知从哪看，UI 不好用"
// 方案 v2（非打断式）：
//   settings ai_bridge_review === 'preview' → 自动链路不直发：挂入全局待确认队列（内存 + 事件广播）
//   → 底部横幅「🔐 N 个洞察待确认」（CloudConfirmBar，App 级挂载，任何页面可见），随时查看/确认/跳过
//   → 确认后触发 costhub-insight-request（App 监听 → scheduleAppInsight 继续自动洞察）
//   'preview'（默认）→ 新主题进入条件审批；'auto' → 仅复用已落库且未过期的精确主题授权；设置读取失败 → 拒绝
// C1 跳过记录保存 30 天；同一会话额外内存去重，防 60s 轮询反复打扰。C2 仍只在本会话忽略。
import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './db';
import { c2BodyHash, sanitizeC2Payload, type C2Payload } from './ai/c2Bridge';
import { validateCloudQueryArgs, validateNativeSearchArgs, validatePublicModelQueryArgs } from './ai/security';
import { reviewQuery, suggestSafeQuery, type QueryRiskItem, type SafeQuerySuggestion } from './ai/safeQuery';
import { buildSearchRequestFromUrl, searchRequestHashText, searchRequestPreview } from './ai/searchRequest';
import { buildPublicSearchQuery } from './ai/searchQuery';

export interface CloudConfirmPayload {
  material: string;   // 物料通用名称
  category: string;   // 品类
  question?: string;  // 查询问题描述
  scopeLevel?: 'C1' | 'C1_PUBLIC_MODEL' | 'C1_PUBLIC_CONTEXT' | 'C1_NATIVE_SEARCH' | 'C2';
  previewJson?: string;
  payloadHash?: string;
  /** C1 search: bind exact GET URL / POST body in addition to the theme. */
  fullRequestBinding?: boolean;
  requestUrl?: string;
  baseRequestUrl?: string;
  requestMethod?: string;
  /** Local conversation binding; it is never used as a reusable global grant key. */
  sessionId?: string;
  runId?: string;
  messageId?: string;
  requestId?: string;
  payloadVersion?: number;
  sourceType?: 'user_message' | 'retrieval' | 'tool_request' | 'background_task';
  /** 审批上下文：这条请求是谁发起的、因为什么需求。 */
  requirementKind?: string;
  requirementTitle?: string;
  localAudit?: { status: 'not_run' | 'pass' | 'warn' | 'blocked' | 'unknown'; matches: string[]; checkedAt?: string };
  /** 本地脱敏评审：命中了哪条规则、哪段文字（用户要能看见"哪里有问题"）。 */
  riskItems?: QueryRiskItem[];
  riskLevel?: 'clear' | 'soft' | 'hard';
  riskVerdict?: string;
  /** 工具自动给出的"换个名字"替代方案（一键采用）。 */
  suggestedQuery?: SafeQuerySuggestion;
  /** 网关（数字禁令 + 内部字段词表）是否会接受这条内容。 */
  gatewayAcceptable?: boolean;
  /** 用户勾选"记住此主题"：签发长效主题票（公开检索主题最长 7 天不再重复询问）。 */
  rememberTheme?: boolean;
  /** 用户在明确知悉软风险后强制批准。 */
  userOverride?: boolean;
  /** 本次请求属于哪个物料主题：同一轮洞察内"搜索票已批准 → 紧随的模型分析票自动放行"，不再问第二遍。 */
  topicMaterial?: string;
  topicCategory?: string;
  /** 正文由本应用的公开投影代码生成（cloudSafePublicText + 内置模板），不含新增本地数据。 */
  publicProjection?: boolean;
}

export interface PendingConfirm extends CloudConfirmPayload {
  id: string;
  addedAt: string;
}

const PENDING_STORAGE_KEY = 'costhub-pending-approvals-v1';
const APPROVAL_HISTORY_KEY = 'costhub-approval-history-v1';

export interface ApprovalHistoryEntry {
  eventId: string;
  requestId?: string;
  sessionId?: string;
  material: string;
  category?: string;
  scopeLevel?: string;
  status: 'approved' | 'auto_approved' | 'rejected' | 'ignored_30d' | 'cancelled' | 'expired';
  at: string;
  previewJson?: string;
  /** 自动放行的依据（用户核对审计时用）。 */
  note?: string;
}

function readApprovalHistory(): ApprovalHistoryEntry[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(APPROVAL_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function recordApprovalHistory(entry: Omit<ApprovalHistoryEntry, 'eventId' | 'at'>) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const history = readApprovalHistory();
    history.unshift({ ...entry, eventId: crypto.randomUUID(), at: new Date().toLocaleString('zh-CN', { hour12: false }) });
    window.localStorage.setItem(APPROVAL_HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
  } catch { /* 历史记录失败不影响审批 */ }
}

export function getApprovalHistory(limit = 50): ApprovalHistoryEntry[] {
  return readApprovalHistory().slice(0, Math.max(1, Math.min(100, limit)));
}

let pendingList: PendingConfirm[] = (() => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(PENDING_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is PendingConfirm => Boolean(item && item.id && item.material)) : [];
  } catch { return []; }
})();

function persistPendingList() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pendingList));
  } catch { /* 本地存储不可用时保持内存队列 */ }
}

let approvalBinding: Partial<CloudConfirmPayload> | null = null;
/** AiPanel sets this before a tool call so the approval card belongs to the current conversation. */
export function setApprovalBinding(binding: Partial<CloudConfirmPayload> | null): void { approvalBinding = binding; }
export function clearApprovalBinding(): void { approvalBinding = null; }

const confirmedKeys = new Set<string>(); // 本会话已确认放行（后续轮询直接放行）
const skippedKeys = new Set<string>();   // 本会话已跳过（后续轮询不再询问）
const approvedScopes = new Map<string, CloudConfirmPayload & { grantId?: number; payloadHash?: string; expiresAt?: string }>(); // 专用云端网关的一次会话审批范围
const approvedByPendingId = new Map<string, CloudConfirmPayload & { grantId?: number; payloadHash?: string; expiresAt?: string }>();
const approvedC2 = new Map<string, CloudConfirmPayload & { grantId?: number; payloadHash?: string; expiresAt?: string }>();
/** 已批准过的物料主题（物料名 → 过期时间）：同一轮洞察的后续步骤据此自动放行。 */
const approvedTopics = new Map<string, number>();

function topicKeyOf(material?: string): string {
  return String(material || '').trim();
}

/** 记录"这个物料主题已获批准"（仅供同一轮洞察的模型分析票复用，不再问第二次）。 */
export function markTopicApproved(material?: string, _category?: string, ttlMs = 30 * 60_000): void {
  const key = topicKeyOf(material);
  // "公开上下文"是 C1_PUBLIC_CONTEXT 的固定 scope 名，不是物料主题，不能进主题表。
  if (!key || key === '公开上下文') return;
  approvedTopics.set(key, Date.now() + ttlMs);
}

export function isTopicApproved(material?: string, _category?: string, now = Date.now()): boolean {
  const expiry = approvedTopics.get(topicKeyOf(material));
  return Boolean(expiry && expiry > now);
}

/**
 * 「审查通过的公开主题自动放行」开关。
 *
 * ⚠️ 2026-09-21 默认值从「关」改为「开」（用户明确要求）：
 *   用户原话："我们有自己的信息审查机构啊，像铜这种有什么敏感的么？可以直接自己通过"。
 *   本应用有**两层不可关闭的代码级审查**——safeQuery 的硬/软规则 + Rust 网关的字段/域名/载荷绑定，
 *   人点一下并不增加安全性，只是增加打扰。所以现在默认：审查零命中 + 网关可接受 → 直接签发。
 *   仍然强制出卡的情形：命中硬规则的（金额/供应商/项目/内部字段）、C2 抽象分析、非公开投影的整份正文、
 *   以及审查结果缺失（unreviewed）。用户随时可以在 设置 → AI 协作 把开关关回"每次都要我确认"。
 */
const AUTO_APPROVE_CLEAN_KEY = 'cloud_auto_approve_clean';
export async function isCleanAutoApproveEnabled(): Promise<boolean> {
  try { return (await getSetting(AUTO_APPROVE_CLEAN_KEY, '1')) !== '0'; } catch { return true; }
}
export async function setCleanAutoApprove(enabled: boolean): Promise<void> {
  await setSetting(AUTO_APPROVE_CLEAN_KEY, enabled ? '1' : '0');
}
export const C1_SKIP_TTL_DAYS = 30;
const SKIPPED_SETTING = 'ai_insight_skipped_keys_v1';
const persistedSkippedUntil = new Map<string, number>();
let skippedLoaded: Promise<void> | null = null;

async function loadPersistedSkipped(): Promise<void> {
  if (!skippedLoaded) {
    skippedLoaded = (async () => {
      try {
        const raw = await getSetting(SKIPPED_SETTING, '{}');
        const stored = JSON.parse(raw || '{}') as Record<string, unknown>;
        const now = Date.now();
        Object.entries(stored).forEach(([key, until]) => {
          const expiresAt = Number(until);
          if (Number.isFinite(expiresAt) && expiresAt > now) persistedSkippedUntil.set(key, expiresAt);
        });
      } catch { /* 老库/设置不可用时退回会话级去重 */ }
    })();
  }
  await skippedLoaded;
}

async function persistSkippedKey(key: string): Promise<void> {
  await loadPersistedSkipped();
  const expiresAt = Date.now() + C1_SKIP_TTL_DAYS * 86400000;
  persistedSkippedUntil.set(key, expiresAt);
  try {
    await setSetting(SKIPPED_SETTING, JSON.stringify(Object.fromEntries(persistedSkippedUntil)));
  } catch { /* 持久化失败仍保留本次会话的跳过结果 */ }
}

function pendingKey(p: CloudConfirmPayload): string {
  return [
    p.scopeLevel || 'C1',
    p.sessionId || '',
    p.runId || '',
    p.messageId || '',
    p.requestId || '',
    String(p.payloadVersion || 1),
    p.sourceType || '',
    p.material,
    p.category || '',
    p.question || '',
    p.requestMethod || '',
    p.requestUrl || '',
    p.previewJson || '',
  ].join('||');
}

function notifyPending() {
  try { window.dispatchEvent(new CustomEvent('costhub-cloud-pending')); } catch { /* 非浏览器环境忽略 */ }
}

function removePendingByKey(key: string): void {
  const next = pendingList.filter(item => pendingKey(item) !== key);
  if (next.length !== pendingList.length) {
    pendingList = next;
    persistPendingList();
    notifyPending();
  }
}

function dedupePending(): void {
  const seen = new Set<string>();
  pendingList = pendingList.filter(item => {
    const key = pendingKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addPendingConfirm(payload: CloudConfirmPayload): PendingConfirm {
  const item: PendingConfirm = {
    ...payload,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    addedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
  };
  dedupePending();
  const existing = pendingList.find(current => pendingKey(current) === pendingKey(item));
  if (existing) return existing;
  pendingList = [...pendingList, item];
  persistPendingList();
  notifyPending();
  return item;
}

export function getPendingConfirms(): PendingConfirm[] {
  dedupePending();
  return [...pendingList];
}

export function removePendingConfirm(id: string): void {
  pendingList = pendingList.filter(x => x.id !== id);
  persistPendingList();
  notifyPending();
}

export function clearAllPending(): void {
  pendingList = [];
  persistPendingList();
  notifyPending();
}

/** Update a pending card's candidate payload after the user edits it (main CloudSafe/C1_PUBLIC_CONTEXT path). */
export function updatePendingConfirmPreview(id: string, previewJson: string): boolean {
  const item = pendingList.find(x => x.id === id);
  if (!item) return false;
  const next = pendingList.map(current => current.id === id
    ? { ...current, previewJson, payloadHash: undefined, payloadVersion: (current.payloadVersion || 1) + 1, fullRequestBinding: current.scopeLevel === 'C1_NATIVE_SEARCH' ? true : false, localAudit: { status: 'unknown' as const, matches: [] } }
    : current);
  pendingList = next;
  persistPendingList();
  notifyPending();
  return true;
}

/** 修改搜索主题后重建候选载荷，保留 pending，等待用户重新批准。 */
export async function revisePendingConfirm(id: string, patch: { material?: string; category?: string; question?: string }): Promise<boolean> {
  const item = pendingList.find(x => x.id === id);
  if (!item) return false;
  const nextBase: CloudConfirmPayload = {
    ...item,
    ...patch,
    previewJson: undefined,
    payloadHash: undefined,
    fullRequestBinding: false,
    payloadVersion: (item.payloadVersion || 1) + 1,
    requestUrl: item.baseRequestUrl || item.requestUrl,
    localAudit: { status: 'unknown' as const, matches: [] },
  };
  try {
    const rebuilt = await prepareCloudConfirmPayload(nextBase);
    pendingList = pendingList.map(current => current.id === id ? { ...rebuilt, id: current.id, addedAt: current.addedAt } : current);
    persistPendingList();
    notifyPending();
    return true;
  } catch {
    return false;
  }
}

export function getApprovedCloudRequest(requestId: string): CloudConfirmPayload | undefined {
  if (!requestId) return undefined;
  return [...approvedScopes.values()].find(item => item.requestId === requestId)
    || pendingList.find(item => item.requestId === requestId);
}

export function clearCloudApprovals(): void {
  confirmedKeys.clear();
  approvedScopes.clear();
  approvedC2.clear();
  approvedTopics.clear();
}

async function cloudNetworkMode(): Promise<'local_only' | 'preview' | 'auto'> {
  let fallback: 'local_only' | 'preview' | 'auto' = 'local_only';
  try {
    const stored = await getSetting('cloud_network_mode', 'local_only');
    fallback = stored === 'preview' || stored === 'auto' ? stored : 'local_only';
  } catch { /* 按纯本地处理 */ }
  // 浏览器合成测试/预览没有 Rust 桥，使用业务库回退；桌面运行时以授权库为准。
  if (typeof window === 'undefined' || !(window as any).__TAURI__?.invoke) return fallback;
  try {
    const mode = await invoke<string>('get_cloud_network_mode');
    if (mode === 'preview' || mode === 'auto') return mode;
    return 'local_only';
  } catch {
    return fallback;
  }
}

async function cloudNetworkEnabled(): Promise<boolean> {
  try {
    return (await cloudNetworkMode()) !== 'local_only';
  } catch {
    return false;
  }
}

/**
 * 网关二次校验的可预期结果（Rust validate_cloud_request_internal + create_cloud_approval_grant）：
 *   · 非公开型号类作用域的物料名不允许出现 ASCII 数字（型号/规格数字只能走「公开型号」通道）；
 *   · 任何字段都不允许出现内部业务字段词表。
 * 提前算出结果，是为了不给出"点了批准也发不出去"的按钮。
 */
const GATEWAY_BANNED_FIELDS = /project_code|supplier_name|bom_cost|market_price|part_model|项目代号|内部成本|我司成本/i;
export function isGatewayAcceptable(scopeLevel: string, input: { material: string; category?: string; question?: string }): boolean {
  const scope = scopeLevel || 'C1';
  const digitsAllowed = scope === 'C1_PUBLIC_MODEL' || scope === 'C1_PUBLIC_CONTEXT' || scope === 'C1_NATIVE_SEARCH';
  if (!digitsAllowed && /[0-9]/.test(input.material || '')) return false;
  return !GATEWAY_BANNED_FIELDS.test(`${input.material} ${input.category || ''} ${input.question || ''}`);
}

function localAuditStatus(riskLevel: CloudConfirmPayload['riskLevel']): NonNullable<CloudConfirmPayload['localAudit']>['status'] {
  return riskLevel === 'hard' ? 'blocked' : riskLevel === 'soft' ? 'warn' : 'pass';
}

/** Normalize a request before queueing: local audit, conversation binding, full search request binding. */
export async function prepareCloudConfirmPayload(payload: CloudConfirmPayload): Promise<CloudConfirmPayload> {
  const withBinding = payload.sourceType === 'background_task' ? { ...payload } : { ...(approvalBinding || {}), ...payload };
  const question = withBinding.question || '近 1-3 月公开市场价格趋势';
  const scopeLevel = withBinding.scopeLevel || 'C1';
  const allowModel = scopeLevel === 'C1_PUBLIC_MODEL' || scopeLevel === 'C1_NATIVE_SEARCH';
  const review = reviewQuery({ material: withBinding.material, category: withBinding.category || '', question }, { allowModel });
  // 旧的三段严格校验保留为最终闸门；它挡下的内容不再静默丢弃，而是带着"命中什么"进卡给用户看。
  const strict = scopeLevel === 'C1_PUBLIC_MODEL'
    ? validatePublicModelQueryArgs({ material: withBinding.material, category: withBinding.category, question })
    : scopeLevel === 'C1_NATIVE_SEARCH'
      ? validateNativeSearchArgs({ material: withBinding.material, category: withBinding.category, question })
      : validateCloudQueryArgs({ material: withBinding.material, category: withBinding.category, question });
  const material = strict.clean?.material ?? String(withBinding.material || '').trim();
  const category = strict.clean?.category ?? String(withBinding.category || '').trim();
  const cleanQuestion = strict.clean?.question ?? question;
  const hardCount = review.hardCount;
  const riskLevel: CloudConfirmPayload['riskLevel'] = hardCount ? 'hard' : review.softCount ? 'soft' : 'clear';
  const suggestedQuery = review.ok ? undefined : suggestSafeQuery({ material, category, question: cleanQuestion });
  let prepared: CloudConfirmPayload = {
    ...withBinding,
    scopeLevel,
    material,
    category,
    question: cleanQuestion,
    riskItems: review.items,
    riskLevel,
    riskVerdict: review.verdict,
    suggestedQuery,
    gatewayAcceptable: isGatewayAcceptable(scopeLevel, { material, category, question: cleanQuestion }),
    localAudit: {
      status: localAuditStatus(riskLevel),
      matches: review.items.map(item => `${item.rule}：${item.sample}`),
      checkedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    },
  };
  if (prepared.scopeLevel === 'C1_NATIVE_SEARCH') {
    if (!prepared.previewJson || !prepared.requestUrl) throw Object.assign(new Error('原生搜索审批缺少完整请求体或目标地址'), { name: 'CloudApprovalValidationError' });
    prepared = {
      ...prepared,
      requestMethod: 'POST',
      payloadHash: await c2BodyHash(prepared.previewJson),
      fullRequestBinding: true,
    };
  } else if ((prepared.scopeLevel === 'C1' || prepared.scopeLevel === 'C1_PUBLIC_MODEL') && !prepared.previewJson && prepared.requestUrl) {
    const baseRequestUrl = prepared.baseRequestUrl || prepared.requestUrl;
    // ⚠️ 2026-09-21：这里是审批卡上「将要发出去的内容」与网关载荷哈希的唯一来源。
    // 原先是 `${material} ${question}`——question 是常量句子，等于把一整句疑问句当检索关键词发给搜索 API，
    // 召回质量崩坏（实测召回过赌博站与招股书 PDF）。改为由已批准字段重建的**关键词**，
    // 并且与 trendService.executeSearchRounds 实际发请求时用同一个纯函数，保证逐字节一致（否则网关会拦）。
    const request = buildSearchRequestFromUrl(baseRequestUrl, buildPublicSearchQuery(prepared.material, prepared.question));
    prepared = {
      ...prepared,
      baseRequestUrl,
      requestUrl: request.url,
      requestMethod: request.method,
      previewJson: searchRequestPreview(request),
      payloadHash: await c2BodyHash(searchRequestHashText(request)),
      fullRequestBinding: true,
    };
  }
  return prepared;
}

/** 是否允许这条卡走到"签发授权"（硬命中与网关不接受的内容一律不发，只能改名/换通道）。 */
export function approvalGate(item: CloudConfirmPayload): { ok: boolean; reason?: string } {
  if (item.riskLevel === 'hard' && !item.userOverride) {
    return { ok: false, reason: '命中本地业务信息（金额/供应商/项目/内部字段），网关不允许外发——请用「建议通用名」后再发。' };
  }
  if (item.gatewayAcceptable === false) {
    const digits = /[0-9]/.test(item.material || '');
    return {
      ok: false,
      reason: digits
        ? '物料名含数字（型号/规格）：普通检索通道不允许外发，请用「建议通用名」，或改用「公开型号通道」。'
        : '内容含网关禁止的内部字段，请用「建议通用名」后重试。',
    };
  }
  return { ok: true };
}

/** 确认某条：移除队列 + 本会话放行该物料；remember=true 时签发可复用主题票（最长 7 天）。 */
export async function confirmPending(id: string, options: { remember?: boolean } = {}): Promise<boolean> {
  return (await approvePending(id, options)).ok;
}

/**
 * 这条请求能否不打扰用户直接放行：
 *   ① 同一轮洞察里，搜索主题刚刚由用户批准过 → 紧随其后的"公开模型分析"票自动放行（内容就是把已批准的公开搜索结果交给模型整理）；
 *   ② 用户打开了「审查通过的公开主题自动放行」→ 本地审查零命中（无金额/供应商/项目/型号/规格）+ 网关可接受 → 直接签发。
 * 任何命中、C2 抽象分析、以及非公开投影的整份正文，仍然照常出卡让用户决定。
 */
async function autoApproveDecision(item: CloudConfirmPayload): Promise<{ ok: boolean; reason?: string }> {
  if (item.scopeLevel === 'C2') return { ok: false };
  const clean = item.riskLevel === 'clear' && item.gatewayAcceptable !== false;
  const policyOn = await isCleanAutoApproveEnabled();
  if (item.scopeLevel === 'C1_PUBLIC_CONTEXT') {
    // 同一轮洞察的"公开模型分析"票：搜索主题刚由用户批准过，这一步只是把已批准的公开结果交给模型整理。
    if (!item.publicProjection) return { ok: false };
    if (isTopicApproved(item.topicMaterial, item.topicCategory)) return { ok: true, reason: '同一轮洞察的搜索主题刚刚已获批准' };
    return clean && policyOn ? { ok: true, reason: '公开投影正文 + 本地审查零命中（已开启自动放行）' } : { ok: false };
  }
  // 其他作用域仍按"新主题先审批"：只有用户开启"审查通过自动放行"时才自动签发。
  return clean && policyOn ? { ok: true, reason: '本地审查未命中任何敏感规则（已开启自动放行）' } : { ok: false };
}

/** 签发授权（用户批准与自动放行共用同一条路径，保证审计一致）。 */
async function issueGrant(item: CloudConfirmPayload & { id?: string }, record?: string): Promise<CloudConfirmPayload & { grantId?: number; payloadHash?: string; expiresAt?: string }> {
  const remember = Boolean(item.rememberTheme);
  const themeGrant = remember && (item.scopeLevel === 'C1' || item.scopeLevel === 'C1_PUBLIC_MODEL' || !item.scopeLevel);
  const key = pendingKey(item);
  const payload = { material: item.material, category: item.category, question: item.question };
  const { createApprovalGrant } = await import('./db/ai');
  const grant = await createApprovalGrant({
    ...payload,
    scopeLevel: item.scopeLevel || 'C1',
    payloadHash: item.payloadHash,
    previewJson: item.previewJson,
    expiresMinutes: themeGrant ? 10080 : 30,
    grantClass: themeGrant ? 'theme' : 'payload',
    requestUrl: item.requestUrl,
    requestMethod: item.requestMethod,
  });
  const approved = { ...item, grantId: Number(grant.id), payloadHash: grant.payload_hash, expiresAt: grant.expires_at };
  if (item.id) approvedByPendingId.set(item.id, approved);
  if (record) recordApprovalHistory({ requestId: item.requestId, sessionId: item.sessionId, material: item.material, category: item.category, scopeLevel: item.scopeLevel, status: 'auto_approved', previewJson: item.previewJson, note: record });
  if (item.scopeLevel === 'C2') approvedC2.set(key, approved);
  else { confirmedKeys.add(key); approvedScopes.set(key, { ...approved, ...payload }); }
  markTopicApproved(item.topicMaterial || item.material, item.topicCategory || item.category);
  try { window.dispatchEvent(new Event('costhub-cloud-approval-changed')); } catch { }
  // ⚠️ 2026-09-21（用户："让我反复确认云端行情查询提交，这个是个大bug"）——
  // 根因：`costhub-insight-request` 这个"批准后继续"的事件**只有监听方、从来没有派发方**，
  // 所以点批准之后什么都不会发生：既不会继续当前调用栈，也不会自动重跑，用户只能自己重新发一遍
  // （于是又看到一次审批流程）＝"反复确认"。
  // 现在签发授权后立刻派发，并带上物料/品类，让监听方即使没有记住原始提问也能直接继续云端查询。
  try {
    window.dispatchEvent(new CustomEvent('costhub-insight-request', {
      detail: {
        material: item.material,
        category: item.category,
        requirementKind: item.requirementKind,
        scopeLevel: item.scopeLevel || 'C1',
        pendingId: item.id,
      },
    }));
  } catch { /* 非浏览器环境忽略 */ }
  return approved;
}

/**
 * "这个工具调用只是排进了审批队列、云端还没发"的**机器可读标记**。
 * ⚠️ 2026-09-21：以前靠匹配工具返回文案里的"等待云端发送确认"来判断，结果 aiTools 把文案改写成
 * "已生成真实待审批请求…"之后，判断永久失效（用户表现为"批准了没反应、要反复确认"）。
 * 现在由工具在返回文本里带上这个标记，判断只看标记，不再看文案措辞。
 */
export const APPROVAL_PENDING_MARKER = '[[APPROVAL_PENDING]]';

/** 判断一段工具输出是否表示"已入审批队列、尚未真正发送"（标记优先，兼容旧文案）。 */
export function textMeansApprovalPending(text: unknown): boolean {
  const value = String(text ?? '');
  return value.includes(APPROVAL_PENDING_MARKER)
    || /等待云端发送确认|需审批|待审批请求|待审批中心|批准本次发送/.test(value);
}

/** 把标记从给用户/模型看的文本里去掉（标记只用于内部判断）。 */
export function stripApprovalMarker(text: unknown): string {
  return String(text ?? '').split(APPROVAL_PENDING_MARKER).join('').trim();
}

/** 与 confirmPending 相同，但把失败原因带出来给卡片显示（用户要知道"为什么点不动"）。 */
export async function approvePending(id: string, options: { remember?: boolean; force?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
  const item = pendingList.find(x => x.id === id);
  if (!item) return { ok: false, reason: '这条审批已经处理过了' };
  if (!(await cloudNetworkEnabled())) return { ok: false, reason: '当前是纯本地模式，云端发送已关闭（设置 → AI 协作）' };
  const target: CloudConfirmPayload = options.force ? { ...item, userOverride: true, riskLevel: item.riskLevel === 'hard' ? 'hard' : 'clear' } : item;
  const gate = approvalGate(target);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  await issueGrant({ ...target, rememberTheme: Boolean(options.remember ?? item.rememberTheme) }, '用户批准');
  recordApprovalHistory({ requestId: item.requestId, sessionId: item.sessionId, material: item.material, category: item.category, scopeLevel: item.scopeLevel, status: 'approved', previewJson: item.previewJson });
  removePendingConfirm(id);
  return { ok: true };
}

/** 采用工具给出的脱敏替代名（原地重建这张卡，用户再确认一次即可）。 */
export async function applySuggestedQuery(id: string): Promise<{ ok: boolean; reason?: string }> {
  const item = pendingList.find(x => x.id === id);
  if (!item) return { ok: false, reason: '这条审批已经处理过了' };
  const suggestion = item.suggestedQuery;
  if (!suggestion) return { ok: false, reason: '这条内容没有可用的替代方案' };
  const ok = await revisePendingConfirm(id, { material: suggestion.material, category: suggestion.category, question: suggestion.question });
  return ok ? { ok: true } : { ok: false, reason: '重建审批卡失败，请刷新后重试' };
}

/** 改用「公开型号」通道发送（型号/规格数字唯一被网关允许的检索通道）。 */
export async function switchPendingToPublicModel(id: string): Promise<{ ok: boolean; reason?: string }> {
  const item = pendingList.find(x => x.id === id);
  if (!item) return { ok: false, reason: '这条审批已经处理过了' };
  const base: CloudConfirmPayload = {
    ...item,
    scopeLevel: 'C1_PUBLIC_MODEL',
    category: '公开型号',
    previewJson: undefined,
    payloadHash: undefined,
    fullRequestBinding: false,
    payloadVersion: (item.payloadVersion || 1) + 1,
    requestUrl: item.baseRequestUrl || item.requestUrl,
    userOverride: true,
  };
  try {
    const rebuilt = await prepareCloudConfirmPayload(base);
    pendingList = pendingList.map(current => current.id === id ? { ...rebuilt, id: current.id, addedAt: current.addedAt } : current);
    persistPendingList();
    notifyPending();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message || error) };
  }
}

/** 跳过某条：默认只作用本次；只有显式 longTerm 才进入 30 天同类忽略。 */
export async function skipPending(id: string, options: { longTerm?: boolean } = {}): Promise<boolean> {
  const item = pendingList.find(x => x.id === id);
  if (!item) return false;
  const key = pendingKey(item);
  const longTerm = Boolean(options.longTerm && item.scopeLevel !== 'C2');
  if (longTerm) { skippedKeys.add(key); await persistSkippedKey(key); }
  recordApprovalHistory({ requestId: item.requestId, sessionId: item.sessionId, material: item.material, category: item.category, scopeLevel: item.scopeLevel, status: longTerm ? 'ignored_30d' : 'rejected', previewJson: item.previewJson });
  removePendingConfirm(id);
  return true;
}

export async function confirmAllPending(): Promise<void> {
  const items = [...pendingList];
  for (const item of items) {
    if (!(await confirmPending(item.id))) throw new Error('未能批准发送，请检查是否处于纯本地模式');
  }
}

export async function skipAllPending(options: { longTerm?: boolean } = {}): Promise<void> {
  const items = [...pendingList];
  for (const item of items) {
    const key = pendingKey(item);
    if (options.longTerm && item.scopeLevel !== 'C2') { skippedKeys.add(key); await persistSkippedKey(key); }
  }
  clearAllPending();
}

/** C2 每次都要审批：确认后只提供一次精确请求体放行，不复用历史主题。 */
export async function requestC2Approval(input: C2Payload & { previewJson: string; requestUrl?: string }): Promise<boolean> {
  if (!(await cloudNetworkEnabled())) return false;
  const checked = sanitizeC2Payload(input);
  if (!checked.ok || !input.previewJson || input.previewJson.length > 200_000) return false;
  const payload: CloudConfirmPayload = {
    material: checked.payload.domain,
    category: 'C2',
    question: checked.payload.question,
    scopeLevel: 'C2',
    previewJson: input.previewJson,
    payloadHash: await c2BodyHash(input.previewJson),
    requestUrl: input.requestUrl || '',
    requestMethod: 'POST',
    requirementKind: 'analysis',
    requirementTitle: 'C2 抽象分析 · ' + checked.payload.domain,
  };
  const key = pendingKey(payload);
  if (approvedC2.has(key)) return true;
  if (skippedKeys.has(key) || pendingList.some(item => pendingKey(item) === key)) return false;
  addPendingConfirm(payload);
  return false;
}

export function takeC2Approval(input: C2Payload & { previewJson: string; requestUrl?: string }): (CloudConfirmPayload & { reviewed: true; grantId?: number; payloadHash?: string; expiresAt?: string }) | null {
  const payload: CloudConfirmPayload = {
    material: input.domain,
    category: 'C2',
    question: input.question,
    scopeLevel: 'C2',
    previewJson: input.previewJson,
    requestUrl: input.requestUrl || '',
  };
  const key = pendingKey(payload);
  const approval = approvedC2.get(key);
  if (!approval) return null;
  approvedC2.delete(key);
  return { ...approval, reviewed: true };
}

/**
 * 自动链路（autoInsight 等）请求云端发送：
 *   auto → 仅已有未过期精确授权时 true，否则进入待确认队列
 *   preview → 未处理过 → 挂入待确认队列并返回 false（本轮跳过，等用户确认后 costhub-insight-request 继续）
 *              本会话已确认 → true；已跳过 → false（都不再打扰）
 */
export async function requestCloudConfirm(payload: CloudConfirmPayload): Promise<boolean> {
  if (!(await cloudNetworkEnabled())) return false;
  let prepared: CloudConfirmPayload;
  try { prepared = await prepareCloudConfirmPayload(payload); } catch { return false; }
  const key = pendingKey(prepared);
  try {
    await loadPersistedSkipped();
    const { approvalPayloadHash, getValidApprovalGrant } = await import('./db/ai');
    let payloadHash = prepared.payloadHash;
    if (!payloadHash) {
      payloadHash = prepared.scopeLevel === 'C1_PUBLIC_CONTEXT' && prepared.previewJson
        ? await c2BodyHash(prepared.previewJson)
        : await approvalPayloadHash({ material: prepared.material, category: prepared.category, question: prepared.question });
    }
    const grant = await getValidApprovalGrant({
      material: prepared.material,
      category: prepared.category,
      question: prepared.question,
      payloadHash,
      scopeLevel: prepared.scopeLevel || 'C1',
      requestUrl: prepared.requestUrl,
    });
    if (grant) {
      approvedScopes.set(key, { ...prepared, grantId: Number(grant.id), payloadHash: grant.payload_hash, expiresAt: grant.expires_at });
      markTopicApproved(prepared.topicMaterial || prepared.material, prepared.topicCategory || prepared.category);
      return true;
    }
    confirmedKeys.delete(key);
    approvedScopes.delete(key);
    // 能不打扰就不打扰：同一轮洞察的后续步骤、以及"审查零命中 + 用户开启自动放行"的公开主题，直接签发。
    try {
      const decision = await autoApproveDecision(prepared);
      if (decision.ok) {
        await issueGrant(prepared, decision.reason || '自动放行');
        recordApprovalHistory({
          requestId: prepared.requestId, sessionId: prepared.sessionId, material: prepared.material, category: prepared.category,
          scopeLevel: prepared.scopeLevel, status: 'auto_approved', previewJson: prepared.previewJson, note: decision.reason,
        });
        return true;
      }
    } catch { /* 自动放行失败则照常出卡，不阻断流程 */ }
    if (skippedKeys.has(key) || (persistedSkippedUntil.get(key) || 0) > Date.now()) return false;
    if (pendingList.some(item => pendingKey(item) === key)) return false;
    addPendingConfirm(prepared);
    return false;
  } catch {
    confirmedKeys.delete(key);
    approvedScopes.delete(key);
    return false;
  }
}

/** 保留当前调用栈，批准后继续当前步骤；不重放前面的搜索或写入。 */
export async function waitForCloudApproval(payload: CloudConfirmPayload, signal?: AbortSignal) {
  const stopped = (message: string) => Object.assign(new Error(message), { name: 'CloudApprovalError' });
  const unavailable = (message: string) => Object.assign(new Error(message), { name: 'CloudApprovalUnavailableError' });
  if (signal?.aborted) throw stopped('云端请求已取消');
  let prepared: CloudConfirmPayload;
  try { prepared = await prepareCloudConfirmPayload(payload); } catch (error) {
    throw Object.assign(new Error(String((error as Error)?.message || error)), { name: 'CloudApprovalValidationError' });
  }
  await requestCloudConfirm(prepared);
  const key = pendingKey(prepared);
  const initialPending = pendingList.find(item => pendingKey(item) === key);
  const trackedId = initialPending?.id;
  const approval = () => trackedId ? approvedByPendingId.get(trackedId) : approvedScopes.get(key);
  if (approval()) return { ...approval()!, reviewed: true as const };
  if (!(trackedId ? pendingList.some(item => item.id === trackedId) : pendingList.some(item => pendingKey(item) === key))) {
    const mode = await cloudNetworkMode();
    throw unavailable(mode === 'local_only'
      ? '云端发送未获批准：当前是纯本地模式，未生成待审批卡；请在设置 → AI 协作中选择“新主题先审批”后重试'
      : '云端发送未获批准：本次内容未生成待审批卡，请检查查询内容或已跳过的审批');
  }
  return new Promise<CloudConfirmPayload & { reviewed: true; grantId?: number; payloadHash?: string; expiresAt?: string }>((resolve, reject) => {
    const finish = (error?: Error, cleanup = false) => {
      clearTimeout(timer);
      window.removeEventListener('costhub-cloud-pending', check);
      signal?.removeEventListener('abort', abort);
      if (cleanup) { removePendingByKey(key); if (trackedId) approvedByPendingId.delete(trackedId); }
      if (error) reject(error);
      else resolve({ ...approval()!, reviewed: true });
    };
    const check = () => {
      const stillPending = trackedId ? pendingList.some(item => item.id === trackedId) : pendingList.some(item => pendingKey(item) === key);
      if (stillPending) return;
      finish(approval() ? undefined : stopped('已取消本次云端发送'));
    };
    const abort = () => finish(stopped('云端请求已取消'), true);
    const timer = setTimeout(() => finish(stopped('等待发送确认超时，请重新发起洞察'), true), 30 * 60_000);
    window.addEventListener('costhub-cloud-pending', check);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else check();
  });
}

/** 受控公开型号查询入口：允许型号数字，但仍需单独审批、固定公开主题和白名单搜索端点。 */
export async function requestPublicModelConfirm(input: { material: string; question: string; requestUrl?: string }): Promise<boolean> {
  return requestCloudConfirm({ material: input.material, category: '公开型号', question: input.question, scopeLevel: 'C1_PUBLIC_MODEL', requestUrl: input.requestUrl, requirementKind: 'public_model', requirementTitle: '公开型号查询 · ' + input.material });
}

/** trendService 只能取得已通过条件审批的结构化范围，不能自造 approval。 */
export function getCloudApproval(material: string, category = '', requestUrl = '', previewJson = '', requestId = ''): (CloudConfirmPayload & { reviewed: true; grantId?: number; payloadHash?: string; expiresAt?: string }) | null {
  const sameRequest = (x: CloudConfirmPayload) => !requestId || x.requestId === requestId;
  const urlMatches = (x: CloudConfirmPayload) => {
    if (!requestUrl) return true;
    const stored = String(x.requestUrl || '');
    return stored === requestUrl || (!!stored && stored.startsWith(requestUrl));
  };
  const exact = [...approvedScopes.values()].find(x => sameRequest(x) && x.material === material && x.category === category && urlMatches(x) && (!previewJson || x.previewJson === previewJson) && (!x.expiresAt || new Date(x.expiresAt.replace(' ', 'T')).getTime() > Date.now()));
  const fallback = exact || (!requestUrl && requestId ? [...approvedScopes.values()].find(x => sameRequest(x) && x.material === material && x.category === category && (!x.expiresAt || new Date(x.expiresAt.replace(' ', 'T')).getTime() > Date.now())) : null);
  if (fallback?.expiresAt && new Date(fallback.expiresAt.replace(' ', 'T')).getTime() <= Date.now()) {
    approvedScopes.delete(pendingKey(fallback));
    confirmedKeys.delete(pendingKey(fallback));
    return null;
  }
  return fallback ? { ...fallback, reviewed: true } : null;
}

export function findCloudApprovalForRequest(content: string): (CloudConfirmPayload & { reviewed: true; grantId?: number; payloadHash?: string; expiresAt?: string }) | null {
  let decoded = content || '';
  try { decoded = decodeURIComponent(decoded); } catch { /* 保留原文 */ }
  const scope = [...approvedScopes.values()].find(x => (!x.expiresAt || new Date(x.expiresAt.replace(' ', 'T')).getTime() > Date.now()) && (decoded.includes(x.material) || (!!x.category && decoded.includes(x.category))));
  return scope ? { ...scope, reviewed: true } : null;
}

/**
 * 设置页的“测试连接”按钮属于用户当次明确发起的外发操作。
 * 这里只登记固定的公开测试主题，不能传入动态内容，因此不会成为绕过业务审批的通道。
 */
export async function approveSafeConnectionTest(): Promise<CloudConfirmPayload & { reviewed: true; grantId: number; payloadHash: string; expiresAt: string }> {
  if (!(await cloudNetworkEnabled())) throw new Error('纯本地模式已启用：云端连接测试已关闭');
  const payload: CloudConfirmPayload = {
    material: '铜',
    category: '原材料',
    question: '云端服务连接测试，不包含任何本地数据',
  };
  const { createApprovalGrant } = await import('./db/ai');
  const grant = await createApprovalGrant({ ...payload, scopeLevel: 'C1', expiresMinutes: 30 });
  approvedScopes.set(pendingKey(payload), { ...payload, grantId: Number(grant.id), payloadHash: grant.payload_hash, expiresAt: grant.expires_at });
  try { window.dispatchEvent(new Event('costhub-cloud-approval-changed')); } catch { }
  return { ...payload, grantId: Number(grant.id), payloadHash: grant.payload_hash, expiresAt: grant.expires_at, reviewed: true };
}
