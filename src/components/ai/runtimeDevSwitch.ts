// Agent Runtime Stage 3.5 — 开发环境手动验证开关
//
// 目的：能**快速**把 `USE_AGENT_RUNTIME` 打开去跑真实链路，并随时关回去。
//
// 设计约束（Stage 3.5 要求）：
//   * **不改变默认关闭状态** —— `AGENT_RUNTIME_DEFAULT` 仍是 `false`，
//     本模块只提供"怎么手动打开"，不参与任何默认值判定。
//   * **不影响生产行为** —— 命令分发只在**开发工具开关**打开时生效
//     （见 `devTools.ts`，缺省关闭）；否则用户输入原样当普通消息处理。
//   * **保留快速回滚能力** —— `/runtime off` 一条命令即可回到旧路径；
//     也可直接清掉 localStorage 键（缺省即关闭）。
//
// 为什么做成"对话命令"而不是 devtools 控制台函数：
//   真实链路验证跑在打包后的桌面窗口（WebView2）里，默认不开 devtools；
//   用命令触发不需要额外开窗口，验证步骤可以完全自动化，也不引入任何新 UI。
//
// 本模块是纯函数（除了显式的 storage 读写），因此可直接单测。

import {
  AGENT_RUNTIME_DEFAULT,
  isAgentRuntimeEnabled,
  setAgentRuntimeEnabled,
} from './runtimeFeatureFlag';
import { isDevToolsEnabled } from './devTools';

/** `/runtime` 支持的动作。 */
export type RuntimeCommandAction = 'on' | 'off' | 'status' | 'help';

export interface RuntimeCommand {
  action: RuntimeCommandAction;
  /** 用户请求的目标状态（仅 on/off 有意义）。 */
  target: boolean;
  /** 命令是否真的改变了开关（仅 on/off 有意义）。 */
  changed: boolean;
  /** 可直接回显给用户的说明文本。 */
  reply: string;
}

/** 助手名称（回显用）。 */
const AGENT = 'Agent Runtime';
const CMD = '/runtime';

function usage(backend: string): string {
  return [
    `${AGENT} 手动验证开关（仅开发环境可用）`,
    `当前：${backend}`,
    '',
    `  ${CMD} on      切到 Runtime 链路（runAgentTurn）`,
    `  ${CMD} off     回到旧链路（runPiAgent）`,
    `  ${CMD} status  查看当前链路`,
    '',
    '两种链路共用同一个工具闸门与审批流程，切换不影响任何安全策略。',
  ].join('\n');
}

function describe(enabled: boolean, override: string | null): string {
  const fallback = AGENT_RUNTIME_DEFAULT ? '开' : '关';
  // 只用普通空格分隔：全角空格会触发 no-irregular-whitespace（lint 基线门禁）
  return `${enabled ? 'Runtime（runAgentTurn）' : '旧链路（runPiAgent）'}`
    + ` · 覆盖值 ${override ?? '（未设置，用默认）'} · 默认 ${fallback}`;
}

/**
 * 尝试把一条用户输入理解为 `/runtime` 命令。
 *
 * @returns 命中则返回执行结果；不命中返回 `null`（调用方应继续正常处理这条输入）。
 */
export function parseRuntimeCommand(raw: string): RuntimeCommandAction | null {
  const match = /^\/(runtime|agent-runtime)\b\s*([a-z]*)\s*$/i.exec((raw || '').trim());
  if (!match) return null;
  const arg = (match[2] || '').toLowerCase();
  if (!arg) return 'status';
  if (arg === 'on' || arg === 'off' || arg === 'status' || arg === 'help') return arg;
  return null;
}

/**
 * 执行一条 `/runtime` 命令。
 *
 * 刻意把「识别」与「执行」分开：`parseRuntimeCommand` 是纯字符串判断，
 * 本函数才碰 localStorage —— 这样两者都能单独测。
 */
export function runRuntimeCommand(
  raw: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): RuntimeCommand | null {
  const action = parseRuntimeCommand(raw);
  if (!action) return null;

  const readOverride = (): string | null => {
    try {
      const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
      return store?.getItem('costhub-use-agent-runtime') ?? null;
    } catch {
      return null;
    }
  };

  if (action === 'help') {
    return { action, target: isAgentRuntimeEnabled(storage), changed: false, reply: usage(describe(isAgentRuntimeEnabled(storage), readOverride())) };
  }

  if (action === 'status') {
    const enabled = isAgentRuntimeEnabled(storage);
    return { action, target: enabled, changed: false, reply: describe(enabled, readOverride()) };
  }

  const target = action === 'on';
  const before = isAgentRuntimeEnabled(storage);
  const written = setAgentRuntimeEnabled(target, storage);
  const after = isAgentRuntimeEnabled(storage);

  if (!written) {
    return {
      action,
      target,
      changed: false,
      reply: `无法写入本地存储，开关未改变。当前：${describe(after, readOverride())}`,
    };
  }

  const already = before === after;
  return {
    action,
    target,
    changed: !already,
    reply: `${already ? '开关已是目标状态' : '已切换'}：${describe(after, readOverride())}`
      + (after ? '\n下一条消息起走 Runtime 链路（runAgentTurn）。' : '\n已回到旧链路（runPiAgent）。'),
  };
}

/**
 * 在 send 入口处拦截 `/runtime` 命令。
 *
 * 开发工具开关关闭时永远返回 `null`，用户输入按普通消息处理，
 * 行为与 Stage 3 完全一致。
 *
 * @param isDev 显式注入开关状态，便于单测两种模式。
 */
export function handleRuntimeCommand(
  raw: string,
  options: { storage?: Pick<Storage, 'getItem' | 'setItem'> | null; isDev?: boolean } = {},
): RuntimeCommand | null {
  const isDev = options.isDev ?? isDevToolsEnabled(options.storage);
  if (!isDev) return null;
  return runRuntimeCommand(raw, options.storage);
}
