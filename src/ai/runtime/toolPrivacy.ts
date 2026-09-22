// Agent Runtime V1（Stage 2）— 工具隐私聚合与来源标签推导
//
// 设计依据：AGENT_RUNTIME_V1_DESIGN.md §3.4 / §3.5
//
// 这个模块回答一个问题：
//   **「本轮可用的工具集，会让什么级别的数据进入上下文？」**
//
// 为什么单独成一个文件：
//   1. `session.ts` 已接近 300 行上限（Stage 1 收尾时 299 行），不能继续膨胀；
//   2. 这段逻辑是纯函数，独立出来才能被直接单测，而不是只能通过驱动整个会话间接验证；
//   3. 它是「工具声明」与「隐私判定」之间的唯一接缝 —— 放在一处便于审计。
//
// 注意：本模块**不判断隐私**，只把工具声明翻译成 `evaluatePrivacy` 能吃的输入。
// 真正的判定仍然由 `src/ai/privacyRouter.ts` 完成（不复制、不绕过）。

import {
  allCloudEligible,
  resolveToolCloudEligible,
  resolveToolPrivacyLevel,
  strictestPrivacyLevel,
  type AiToolManifest,
  type ToolPrivacyLevel,
} from '../contracts';
import { SENSITIVE_SOURCE_TYPES } from '../privacyRouter';

/** 可解析 privacyLevel 的最小工具形状（兼容 AiTool 与裸 manifest）。 */
export interface PrivacyDeclaringTool {
  id?: string;
  manifest?: Pick<AiToolManifest, 'privacyLevel' | 'cloudEligible'> | null;
  privacyLevel?: ToolPrivacyLevel;
  cloudEligible?: boolean;
}

export interface ToolPrivacyAggregate {
  /** 本轮涉及的隐私级别（去重、按严格度降序）。 */
  levels: ToolPrivacyLevel[];
  /** 跨工具取最严的级别。 */
  strictest: ToolPrivacyLevel;
  /** 是否所有工具的输出都可进入云端上下文（任一不可 → false）。 */
  cloudEligible: boolean;
  /** 未声明 privacyLevel 的工具数量（观测用：说明有多少工具还在"缺省保守"状态）。 */
  undeclaredCount: number;
  /** 明确声明为 sensitive 的工具 id 列表（观测/审计用）。 */
  sensitiveToolIds: string[];
}

/** 取一个工具的有效 manifest 视图（兼容 `manifest` 包装与字段直挂两种形状）。 */
function viewOf(tool: PrivacyDeclaringTool): Pick<AiToolManifest, 'privacyLevel' | 'cloudEligible'> {
  if (tool.manifest) return tool.manifest;
  return { privacyLevel: tool.privacyLevel, cloudEligible: tool.cloudEligible };
}

/**
 * 聚合一组工具的隐私声明。
 *
 * 空集合的处理（重要）：返回 `cloudEligible: false`。
 * 理由 —— 「没有任何工具声明」不构成"可以上云"的证据；
 * 在 fail-closed 体系里，证据缺失的默认答案必须是否定。
 */
export function aggregateToolPrivacy(tools: PrivacyDeclaringTool[] = []): ToolPrivacyAggregate {
  if (tools.length === 0) {
    return { levels: [], strictest: 'internal', cloudEligible: false, undeclaredCount: 0, sensitiveToolIds: [] };
  }

  const levels: ToolPrivacyLevel[] = [];
  const flags: boolean[] = [];
  const sensitiveToolIds: string[] = [];
  let undeclaredCount = 0;

  for (const tool of tools) {
    const view = viewOf(tool);
    if (view.privacyLevel === undefined) undeclaredCount += 1;
    const level = resolveToolPrivacyLevel(view);
    levels.push(level);
    if (level === 'sensitive' && tool.id) sensitiveToolIds.push(tool.id);
    flags.push(resolveToolCloudEligible(view));
  }

  return {
    levels: [...new Set(levels)].sort(),
    strictest: strictestPrivacyLevel(levels),
    cloudEligible: allCloudEligible(flags),
    undeclaredCount,
    sensitiveToolIds,
  };
}

/**
 * 由工具隐私级别推导"来源标签"，供 `evaluatePrivacy({ sourceTypes })` 使用。
 *
 * 关键点：这里**复用 `privacyRouter.SENSITIVE_SOURCE_TYPES` 里的既有词表**，
 * 而不是自造一套标签。`private_workspace` 表示"本轮上下文含本地库数据"，
 * 是 privacyRouter 已经认识且会 fail-closed 的标签。
 *
 * 为什么这层映射是必要且充分的：
 *   `evaluatePrivacy` 的输入是「文本 + 来源标签」，它并不认识"工具"这个概念。
 *   工具读了本地 BOM，等价于"上下文里出现了本地工作区数据" —— 映射到
 *   `private_workspace` 既语义准确，又不需要改动 privacyRouter。
 */
export function buildPrivacySourceTypes(aggregate: ToolPrivacyAggregate, extra: string[] = []): string[] {
  const derived: string[] = [];
  if (aggregate.strictest === 'sensitive') {
    // 断言该标签确实在 privacyRouter 的敏感词表里；否则这里就是一条静默失效的映射。
    if ((SENSITIVE_SOURCE_TYPES as readonly string[]).includes('private_workspace')) {
      derived.push('private_workspace');
    }
  }
  return [...new Set([...derived, ...extra.filter(Boolean)])];
}

/**
 * 路由决策：本轮是否允许走云端。
 *
 * fail-closed：只有在
 *   ① 调用方**显式**请求了 cloud 路由，且
 *   ② 隐私判定认为 `cloudSafe`，且
 *   ③ 工具集全部 `cloudEligible`
 * 三者同时成立时才返回 `cloud`；否则一律 `local`。
 *
 * 换句话说：任何一项缺失或不确定 → 留在本地。
 */
export function decideRoute(input: {
  requestedRoute?: 'local' | 'cloud';
  cloudSafe: boolean;
  toolCloudEligible: boolean;
}): 'local' | 'cloud' {
  if (input.requestedRoute !== 'cloud') return 'local';
  if (!input.cloudSafe) return 'local';
  if (!input.toolCloudEligible) return 'local';
  return 'cloud';
}
