// 云端供应商健康冷却（2026-09-21）
// 背景：云端额度不足（HTTP 402）/ Key 失效（401）时，旧逻辑每次洞察都还会再问一遍审批、再撞一次墙——
// 用户体感就是"反复弹审批、还是失败"。这里按错误类型记冷却：额度/鉴权类 30 分钟不再尝试，
// 网络类 2 分钟，其他 1 分钟；成功的调用立即清除记录。
// 目的：① 少打扰（不再为注定失败的调用申请审批）② 快速转入本地模型兜底。

export type ProviderFailureKind = 'quota' | 'auth' | 'network' | 'other';

interface FailureRecord { kind: ProviderFailureKind; message: string; at: number }

const STORAGE_KEY = 'costhub-provider-health-v1';
const COOLDOWN_MS: Record<ProviderFailureKind, number> = {
  quota: 30 * 60_000,
  auth: 30 * 60_000,
  network: 2 * 60_000,
  other: 60_000,
};

const memory = new Map<string, FailureRecord>();

function readStore(): Record<string, FailureRecord> {
  const stored: Record<string, FailureRecord> = {};
  try {
    if (typeof localStorage === 'undefined') return stored;
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed as Record<string, FailureRecord>)) {
        if (value && typeof value.at === 'number') stored[key] = value;
      }
    }
  } catch { /* 存储不可用时只用内存 */ }
  return stored;
}

function writeStore(store: Record<string, FailureRecord>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch { /* 忽略 */ }
}

/** 把云端错误归类：额度不足/鉴权失败是可预期的"别急着重试"信号。 */
export function classifyProviderError(message: string): ProviderFailureKind {
  const text = String(message || '');
  if (/402|Insufficient Balance|余额|额度|quota|欠费/i.test(text)) return 'quota';
  if (/401|403|invalid_api_key|Unauthorized|鉴权|api key/i.test(text)) return 'auth';
  if (/HTTP 0|网络|timeout|超时|连接|dns|socket|Failed to fetch/i.test(text)) return 'network';
  return 'other';
}

export function providerFailureMessage(kind: ProviderFailureKind, message: string): string {
  const detail = String(message || '').slice(0, 160);
  if (kind === 'quota') return `云端额度不足（${detail}）`;
  if (kind === 'auth') return `云端 API Key 无效或已过期（${detail}）`;
  if (kind === 'network') return `云端网络不通（${detail}）`;
  return detail || '云端调用失败';
}

/** 记录一次失败（写内存 + 本地存储）。 */
export function markProviderFailure(providerKey: string, message: string): ProviderFailureKind {
  const key = String(providerKey || '').trim() || 'unknown';
  const kind = classifyProviderError(message);
  const record: FailureRecord = { kind, message: String(message || '').slice(0, 240), at: Date.now() };
  memory.set(key, record);
  const store = readStore();
  store[key] = record;
  writeStore(store);
  return kind;
}

export function clearProviderFailure(providerKey: string): void {
  const key = String(providerKey || '').trim() || 'unknown';
  if (!memory.has(key) && !readStore()[key]) return;
  memory.delete(key);
  const store = readStore();
  if (store[key]) { delete store[key]; writeStore(store); }
}

/** 该供应商是否仍在冷却期（冷却期内不再发起真实请求、也不再申请审批）。 */
export function providerCooldown(providerKey: string, now = Date.now()): { cooling: boolean; reason?: string; until?: number; kind?: ProviderFailureKind } {
  const key = String(providerKey || '').trim() || 'unknown';
  const record = memory.get(key) || readStore()[key];
  if (!record) return { cooling: false };
  const untilAt = record.at + COOLDOWN_MS[record.kind];
  if (untilAt <= now) return { cooling: false };
  const minutes = Math.max(1, Math.ceil((untilAt - now) / 60_000));
  return { cooling: true, until: untilAt, kind: record.kind, reason: `${providerFailureMessage(record.kind, record.message)}，已暂停尝试约 ${minutes} 分钟（可到 设置 → AI 服务 处理后再试）` };
}

export function providerCooldownReason(providerKey: string, now = Date.now()): string {
  return providerCooldown(providerKey, now).reason || '';
}

/** 测试用：清空全部记录。 */
export function resetProviderHealth(): void {
  memory.clear();
  writeStore({});
}
