// 云端发送前确认（v2.3.19，2026-08-17 重构为「非打断式待确认队列」）
// 背景 v1：autoInsight 后台轮询时直接弹 antd Modal.confirm——用户反馈"弹窗自己弹、不知从哪看，UI 不好用"
// 方案 v2（非打断式）：
//   settings ai_bridge_review === 'preview' → 自动链路不直发：挂入全局待确认队列（内存 + 事件广播）
//   → 底部横幅「🔐 N 个洞察待确认」（CloudConfirmBar，App 级挂载，任何页面可见），随时查看/确认/跳过
//   → 确认后触发 costhub-insight-request（App 监听 → scheduleAppInsight 继续自动洞察）
//   'preview'（默认）→ 新主题进入条件审批；'auto' → 严格审查通过后直接放行；设置读取失败 → 拒绝
// 会话级去重：同一物料只入队一次（防 60s 轮询反复打扰）；确认/跳过后的物料本会话不再重复询问
import { getSetting } from './db';

export interface CloudConfirmPayload {
  material: string;   // 物料通用名称
  category: string;   // 品类
  question?: string;  // 查询问题描述
}

export interface PendingConfirm extends CloudConfirmPayload {
  id: string;
  addedAt: string;
}

let pendingList: PendingConfirm[] = [];
const confirmedKeys = new Set<string>(); // 本会话已确认放行（后续轮询直接放行）
const skippedKeys = new Set<string>();   // 本会话已跳过（后续轮询不再询问）
const approvedScopes = new Map<string, CloudConfirmPayload>(); // 专用云端网关的一次会话审批范围

function pendingKey(p: CloudConfirmPayload): string {
  return p.material + '||' + p.category;
}

function notifyPending() {
  try { window.dispatchEvent(new CustomEvent('costhub-cloud-pending')); } catch { /* 非浏览器环境忽略 */ }
}

function addPendingConfirm(payload: CloudConfirmPayload): PendingConfirm {
  const item: PendingConfirm = {
    ...payload,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    addedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
  };
  pendingList.push(item);
  notifyPending();
  return item;
}

export function getPendingConfirms(): PendingConfirm[] {
  return [...pendingList];
}

export function removePendingConfirm(id: string): void {
  pendingList = pendingList.filter(x => x.id !== id);
  notifyPending();
}

export function clearAllPending(): void {
  pendingList = [];
  notifyPending();
}

/** 确认某条：移除队列 + 本会话放行该物料 */
export function confirmPending(id: string): boolean {
  const item = pendingList.find(x => x.id === id);
  if (!item) return false;
  confirmedKeys.add(pendingKey(item));
  approvedScopes.set(pendingKey(item), { material: item.material, category: item.category, question: item.question });
  removePendingConfirm(id);
  return true;
}

/** 跳过某条：移除队列 + 本会话不再询问该物料 */
export function skipPending(id: string): boolean {
  const item = pendingList.find(x => x.id === id);
  if (!item) return false;
  skippedKeys.add(pendingKey(item));
  removePendingConfirm(id);
  return true;
}

export function confirmAllPending(): void {
  pendingList.forEach(x => {
    confirmedKeys.add(pendingKey(x));
    approvedScopes.set(pendingKey(x), { material: x.material, category: x.category, question: x.question });
  });
  clearAllPending();
}

export function skipAllPending(): void {
  pendingList.forEach(x => skippedKeys.add(pendingKey(x)));
  clearAllPending();
}

/**
 * 自动链路（autoInsight 等）请求云端发送：
 *   auto → true（直接发送，审计照常记录）
 *   preview → 未处理过 → 挂入待确认队列并返回 false（本轮跳过，等用户确认后 costhub-insight-request 继续）
 *              本会话已确认 → true；已跳过 → false（都不再打扰）
 */
export async function requestCloudConfirm(payload: CloudConfirmPayload): Promise<boolean> {
  const { validateCloudQueryArgs } = await import('./aiBridge');
  const validation = validateCloudQueryArgs({ material: payload.material, category: payload.category, question: payload.question || '近 1-3 月公开市场价格趋势' });
  if (!validation.ok || !validation.clean) return false;
  payload = { material: validation.clean.material, category: validation.clean.category, question: validation.clean.question };
  try {
    const mode = await getSetting('ai_bridge_review', 'preview');
    if (mode !== 'preview') {
      approvedScopes.set(pendingKey(payload), { ...payload, question: payload.question || '近 1-3 月公开市场价格趋势' });
      return true;
    }
  } catch { return false; }
  const key = pendingKey(payload);
  if (confirmedKeys.has(key)) {
    if (!approvedScopes.has(key)) approvedScopes.set(key, { ...payload, question: payload.question || '近 1-3 月公开市场价格趋势' });
    return true;
  }
  if (skippedKeys.has(key)) return false;
  if (pendingList.some(x => pendingKey(x) === key)) return false; // 已在队列中，不重复入队
  addPendingConfirm({
    material: payload.material,
    category: payload.category,
    question: payload.question || '近 1-3 月价格趋势分析（price-trend）',
  });
  return false;
}

/** trendService 只能取得已通过条件审批的结构化范围，不能自造 approval。 */
export function getCloudApproval(material: string, category = ''): (CloudConfirmPayload & { reviewed: true }) | null {
  const exact = approvedScopes.get(pendingKey({ material, category }));
  const fallback = exact || [...approvedScopes.values()].find(x => x.material === material);
  return fallback ? { ...fallback, reviewed: true } : null;
}

export function findCloudApprovalForRequest(content: string): (CloudConfirmPayload & { reviewed: true }) | null {
  let decoded = content || '';
  try { decoded = decodeURIComponent(decoded); } catch { /* 保留原文 */ }
  const scope = [...approvedScopes.values()].find(x => decoded.includes(x.material) || (!!x.category && decoded.includes(x.category)));
  return scope ? { ...scope, reviewed: true } : null;
}

/**
 * 设置页的“测试连接”按钮属于用户当次明确发起的外发操作。
 * 这里只登记固定的公开测试主题，不能传入动态内容，因此不会成为绕过业务审批的通道。
 */
export function approveSafeConnectionTest(): CloudConfirmPayload & { reviewed: true } {
  const payload: CloudConfirmPayload = {
    material: '铜',
    category: '原材料',
    question: '云端服务连接测试，不包含任何本地数据',
  };
  approvedScopes.set(pendingKey(payload), payload);
  return { ...payload, reviewed: true };
}
