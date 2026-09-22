// Agent Runtime Stage 3.5 — 开发环境 RuntimeEvent 记录器
//
// 目的：真实链路验证时需要**按顺序**看到 `runAgentTurn` 实际发出了哪些事件，
// 用来核对事件顺序、确认隐私/路由/预算事件真的到达 UI，
// 以及确认底层网关事件有没有被重复投递。
//
// 边界（不越界）：
//   * 只在**开发工具开关**打开时记录（见 `devTools.ts`）；缺省关闭，
//     因此生产构建与生产用户都不会进入记录分支。
//   * **只写内存**，不落库、不打印、不发网络 —— 不产生任何持久化副作用。
//   * 长文本（token / 工具结果）只保留长度，避免把整篇回答堆进数组。
//   * 不改变事件本身，也不改变任何执行顺序（纯旁路）。
//
// 读取方式：桌面窗口里执行
//   JSON.parse(JSON.stringify(window.__costhubRuntimeEvents.types()))

import { isDevToolsEnabled } from './devTools';

/** 允许记录的事件类型（白名单，避免将来新增字段被无意记录）。 */
const RECORDED_TYPES = [
  'budget', 'privacy', 'route', 'stage', 'token', 'thought',
  'tool_start', 'tool_result', 'tool_progress', 'cloud_result',
  'gateway', 'round', 'usage', 'compaction', 'execution_ready',
  'chart', 'final', 'error',
] as const;

/** 长文本字段只留长度：这些字段内容可能上千字，且与顺序验证无关。 */
const LENGTH_ONLY_FIELDS = ['text', 'args', 'result', 'usage', 'stats', 'artifact'];

export interface RecordedRuntimeEvent {
  seq: number;
  type: string;
  /** 关键字段摘要（长文本折叠为字符数）。 */
  detail: Record<string, unknown>;
}

interface RuntimeEventRecorder {
  events: RecordedRuntimeEvent[];
  /** 事件类型序列（顺序验证的主证据）。 */
  types(): string[];
  reset(): void;
  /** 只保留指定类型的完整记录（便于精确核对某一类事件）。 */
  pick(type: string): RecordedRuntimeEvent[];
  /** 底层网关事件的类型序列 —— 用于确认是否重复投递。 */
  gatewayTypes(): string[];
}

function isDev(): boolean {
  return isDevToolsEnabled();
}

/** 把一条事件压成可安全保存的摘要。 */
function summarize(type: string, event: Record<string, unknown>): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type' || key === 'runId' || key === 'seq' || key === 'at') continue;
    if (LENGTH_ONLY_FIELDS.includes(key)) {
      if (typeof value === 'string') { detail[`${key}Chars`] = value.length; continue; }
      if (value !== undefined && value !== null) { detail[`${key}Present`] = true; continue; }
      continue;
    }
    if (type === 'privacy' && key === 'decision') {
      // 隐私判定只留结论性字段；regexMatches 只留数量（可能有敏感命中词）
      const decision = value as Record<string, unknown> | undefined;
      detail.decision = decision ? {
        classification: decision.classification,
        cloudSafe: decision.cloudSafe,
        candidateRoute: decision.candidateRoute,
        reasonCode: decision.reasonCode,
        matchCount: Array.isArray(decision.regexMatches) ? decision.regexMatches.length : 0,
      } : null;
      continue;
    }
    if (type === 'gateway' && key === 'event') {
      const inner = value as Record<string, unknown> | undefined;
      detail.gatewayType = inner?.type ?? null;
      detail.gatewayRoute = inner?.route ?? null;
      // 去重判定需要能区分"同一条事件投递两次"与"两条不同的同类事件"，
      // 因此这里保留少量判别字段（不含任何内容/凭据）。
      if (inner?.type === 'network_request') {
        detail.channel = inner.channel ?? null;
        detail.status = inner.status ?? null;
        detail.outbound = inner.outbound ?? null;
        detail.transport = inner.transport ?? null;
        detail.requestId = inner.requestId ?? null;
      }
      continue;
    }
    if (type === 'tool_start' || type === 'tool_result') {
      if (key === 'args') { detail.argsPresent = value !== undefined; continue; }
    }
    if (typeof value === 'string') { detail[key] = value.slice(0, 120); continue; }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') { detail[key] = value; continue; }
    if (typeof value === 'object') { detail[`${key}Keys`] = Object.keys(value as object).slice(0, 20); continue; }
  }
  return detail;
}

/**
 * 创建记录器核心（**不接触 window**，因此可在 node 环境下直接单测）。
 *
 * 事件的过滤与摘要都在这里；`installRuntimeEventRecorder` 只负责把它挂到 window。
 */
export function createRuntimeEventRecorder(): RuntimeEventRecorder {
  const events: RecordedRuntimeEvent[] = [];

  const recorder: RuntimeEventRecorder = {
    events,
    types: () => events.map(entry => entry.type),
    reset: () => { events.length = 0; },
    pick: (type: string) => events.filter(entry => entry.type === type),
    gatewayTypes: () => events
      .filter(entry => entry.type === 'gateway')
      .map(entry => String(entry.detail.gatewayType ?? 'unknown')),
  };

  return recorder;
}

/**
 * 记录一条事件（纯函数式：只依赖传入的 runtime）。
 *
 * 开发工具开关关闭、未安装记录器、或类型不在白名单时都是空操作。
 *
 * @param runtime 承载记录器的对象（浏览器里传 `window`）
 * @param isDevEnv 是否记录；缺省读开发工具开关
 */
export function recordRuntimeEventInto(
  runtime: Record<string, unknown> | undefined,
  event: { type?: string } & Record<string, unknown>,
  isDevEnv?: boolean,
): void {
  const dev = isDevEnv ?? isDev();
  if (!dev) return;
  if (!runtime) return;

  const type = String(event?.type ?? '');
  if (!RECORDED_TYPES.includes(type as (typeof RECORDED_TYPES)[number])) return;

  const recorder = runtime.__costhubRuntimeEvents as RuntimeEventRecorder | undefined;
  if (!recorder) return;

  recorder.events.push({
    seq: recorder.events.length,
    type,
    detail: summarize(type, event as Record<string, unknown>),
  });
}

/**
 * 安装记录器（幂等）。返回记录器；传入非对象时返回 `null`。
 *
 * 刻意做成显式安装而不是模块加载即写 window：
 * 这样"是否安装"在调用点一眼可见，也便于测试注入。
 */
export function installRuntimeEventRecorder(target: Record<string, unknown> | undefined): RuntimeEventRecorder | null {
  if (!target) return null;
  const existing = target.__costhubRuntimeEvents as RuntimeEventRecorder | undefined;
  if (existing) return existing;

  const recorder = createRuntimeEventRecorder();
  Object.defineProperty(target, '__costhubRuntimeEvents', {
    value: recorder, configurable: true, writable: true, enumerable: false,
  });
  return recorder;
}

/** 浏览器入口：记录到 `window`（开发工具开关关闭时为空操作）。 */
export function recordRuntimeEvent(event: { type?: string } & Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  recordRuntimeEventInto(window as unknown as Record<string, unknown>, event);
}
