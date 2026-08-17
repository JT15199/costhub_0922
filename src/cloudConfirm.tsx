// 云端发送前确认（v2.3.19，2026-08-17 重构为「非打断式待确认队列」）
// 背景 v1：autoInsight 后台轮询时直接弹 antd Modal.confirm——用户反馈"弹窗自己弹、不知从哪看，UI 不好用"
// 方案 v2（非打断式）：
//   settings ai_bridge_review === 'preview' → 自动链路不直发：挂入全局待确认队列（内存 + 事件广播）
//   → 底部横幅「🔐 N 个洞察待确认」（CloudConfirmBar，App 级挂载，任何页面可见），随时查看/确认/跳过
//   → 确认后触发 costhub-insight-request（App 监听 → scheduleAppInsight 继续自动洞察）
//   'auto'（默认）→ 直接放行；设置读取失败 → 放行
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
  pendingList.forEach(x => confirmedKeys.add(pendingKey(x)));
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
  try {
    const mode = await getSetting('ai_bridge_review', 'auto');
    if (mode !== 'preview') return true;
  } catch { return true; }
  const key = pendingKey(payload);
  if (confirmedKeys.has(key)) return true;
  if (skippedKeys.has(key)) return false;
  if (pendingList.some(x => pendingKey(x) === key)) return false; // 已在队列中，不重复入队
  addPendingConfirm({
    material: payload.material,
    category: payload.category,
    question: payload.question || '近 1-3 月价格趋势分析（price-trend）',
  });
  return false;
}
