import { describe, it, expect, vi, beforeEach } from 'vitest';

// 只替换执行器：本文件验证**隐私策略边界**，不验证 piRuntime 行为。
const runPiAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../ai/piRuntime', () => ({ runPiAgent: runPiAgentMock }));

import { runAgentTurn } from '../ai/runtime/session';
import { runPreflight } from '../ai/runtime/preflight';
import { aggregateToolPrivacy, decideRoute } from '../ai/runtime/toolPrivacy';
import { resolveToolPrivacyLevel, resolveToolCloudEligible } from '../ai/contracts';
import { AI_TOOL_MANIFESTS } from '../ai/toolRegistry';
import { reviewedPublicClassifier } from '../ai/privacyRouter';
import type { AgentRequest, RuntimeEvent } from '../ai/runtime/contract';

/**
 * 本文件钉住 Agent Runtime 隐私策略的**三条边界**。
 *
 * 策略名：**available tools based privacy check**（执行前保守检查）。
 * 判定依据是「本轮**可用**的工具集」，而不是「本轮**实际调用**的工具」——
 * 详见 `src/ai/runtime/README.md` 的「隐私边界」一节。
 *
 * 未来会由 Tool Gateway 升级为 actual tool invocation based privacy check。
 * 在那之前，这三条边界不得放宽。
 */

const outcome = {
  finalText: 'ok',
  rounds: 1,
  messages: [{ role: 'assistant', content: 'ok' }],
  workingState: { version: 1, items: [], projects: [], files: [], artifacts: [], tasks: [] },
};

/** 用**真实 manifest**构造工具，避免用假声明把测试测成"自证"。 */
const toolFromManifest = (id: keyof typeof AI_TOOL_MANIFESTS) => {
  const manifest = AI_TOOL_MANIFESTS[id];
  if (!manifest) throw new Error(`unknown tool manifest: ${String(id)}`);
  return { id: String(id), manifest };
};

function makeRequest(overrides: {
  tools?: ReturnType<typeof toolFromManifest>[];
  gatewayRoute?: 'local' | 'cloud';
  userMessage?: string;
  cloudSafeSeam?: boolean;
} = {}): AgentRequest {
  return {
    sessionId: 1,
    runId: 'run-policy',
    userMessage: overrides.userMessage ?? '分析这个项目的成本',
    options: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:4b',
      systemPrompt: 'sys',
      tools: (overrides.tools ?? []) as never,
      gatewayRoute: overrides.gatewayRoute,
      executeTool: async () => ({ ok: true, text: 'ok' }),
      // 云端用例需要与真实调用方一致的"分类器 + 已验证公开来源"接缝。
      // 缺少它时 evaluatePrivacy 会 fail-closed 归为 unknown —— 那是**正确**行为，
      // 但不是 Case 2 要验证的路径。
      ...(overrides.cloudSafeSeam
        ? {
          privacySourceTypes: ['public_approved_content'],
          privacyMetadata: [{
            sourceType: 'public_approved_content',
            sensitivity: 'public',
            cloudSafe: true,
            priority: 'normal',
            sourceIds: ['public-1'],
            verified: true,
          }],
          localPrivacyClassifier: reviewedPublicClassifier,
        }
        : {}),
    },
  };
}

const preflightOf = (request: AgentRequest) => runPreflight({ request, provider: 'ollama', model: 'qwen3:4b' });

/** 收集事件流（含结果）。 */
async function collect(request: AgentRequest): Promise<{ events: RuntimeEvent[]; result: unknown }> {
  const turn = runAgentTurn(request);
  const events: RuntimeEvent[] = [];
  for (;;) {
    const next = await turn.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

beforeEach(() => {
  runPiAgentMock.mockReset();
  runPiAgentMock.mockResolvedValue(outcome);
});

// ---------------------------------------------------------------------------
// Case 1 — sensitive 工具存在但未被调用 ⇒ 仍然 local
// ---------------------------------------------------------------------------

describe('Case 1 — 存在 sensitive 工具（read_excel）但实际没有调用', () => {
  it('read_excel 的声明确实是 sensitive 且不可上云（前置事实）', () => {
    const manifest = AI_TOOL_MANIFESTS.read_excel;
    expect(resolveToolPrivacyLevel(manifest)).toBe('sensitive');
    expect(resolveToolCloudEligible(manifest)).toBe(false);
  });

  it('仅在工具集中"可用"（本轮不调用）就足以让 route 落在 local', () => {
    // 模拟：模型本轮只可能用 calc，但 read_excel 也在可用工具集里
    const request = makeRequest({ tools: [toolFromManifest('calc'), toolFromManifest('read_excel')], gatewayRoute: 'cloud' });
    const preflight = preflightOf(request);

    expect(preflight.toolPrivacy.strictest).toBe('sensitive');
    expect(preflight.toolPrivacy.cloudEligible).toBe(false);
    expect(preflight.route).toBe('local');
  });

  it('整个运行的事件流中 route 事件为 local（不是只有内部变量对）', async () => {
    const request = makeRequest({ tools: [toolFromManifest('calc'), toolFromManifest('read_excel')], gatewayRoute: 'cloud' });
    const { events } = await collect(request);

    // 断言 piRuntime 收到的工具集里确实带着 read_excel —— 证明"可用但未调用"这个前提成立
    const passedTools = (runPiAgentMock.mock.calls[0][0] as any).tools as Array<{ id: string }>;
    expect(passedTools.map(tool => tool.id)).toContain('read_excel');
    // 且运行中没有任何 tool_start 事件提到它 —— 证明它确实没被调用
    expect(events.some(event => event.type === 'tool_start' && event.toolId === 'read_excel')).toBe(false);

    const routeEvent = events.find(event => event.type === 'route') as Extract<RuntimeEvent, { type: 'route' }>;
    expect(routeEvent.route).toBe('local');
  });

  it('sensitive 工具还会推导出 private_workspace 来源标签，使判定 fail-closed', () => {
    const preflight = preflightOf(makeRequest({ tools: [toolFromManifest('read_excel')] }));
    expect(preflight.sourceTypes).toContain('private_workspace');
    expect(preflight.decision.cloudSafe).toBe(false);
  });

  it('策略说明：安全优先，宁可误判，不允许风险外发', () => {
    // 显式记录这条取舍：可用集 ⊇ 实际调用集，因此判定偏严但不会漏放
    const withSensitiveButUnused = aggregateToolPrivacy([toolFromManifest('calc'), toolFromManifest('read_excel')]);
    const withPublicOnly = aggregateToolPrivacy([toolFromManifest('calc')]);
    expect(withSensitiveButUnused.cloudEligible).toBe(false);
    expect(withPublicOnly.cloudEligible).toBe(true);
    // 同一个用户请求、同一个路由请求，仅因"工具集里多了一个未使用的 sensitive 工具"就被降级
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: true, toolCloudEligible: withSensitiveButUnused.cloudEligible })).toBe('local');
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: true, toolCloudEligible: withPublicOnly.cloudEligible })).toBe('cloud');
  });
});

// ---------------------------------------------------------------------------
// Case 2 — 全部 public 工具 + 显式请求 cloud + 判定 cloudSafe ⇒ route = cloud
// ---------------------------------------------------------------------------

describe('Case 2 — 全部 public 工具 + 显式请求云端 + 文本判定安全 ⇒ route = cloud', () => {
  it('calc 与 now 都是 public 且可上云（前置事实）', () => {
    for (const id of ['calc', 'now'] as const) {
      const manifest = AI_TOOL_MANIFESTS[id];
      expect(resolveToolPrivacyLevel(manifest)).toBe('public');
      expect(resolveToolCloudEligible(manifest)).toBe(true);
    }
  });

  it('中立文本下 privacy 判定为 public/cloudSafe，route 落到 cloud', () => {
    // 用中立文本：privacyRouter 的正则守卫会命中「成本/报价/BOM」等业务敏感词，
    // 那属于**判定正确**地阻止云端，不是本用例要测的路径。
    const request = makeRequest({
      tools: [toolFromManifest('calc'), toolFromManifest('now')],
      gatewayRoute: 'cloud',
      userMessage: 'What is the weather like today?',
      cloudSafeSeam: true,
    });
    const preflight = preflightOf(request);

    expect(preflight.toolPrivacy.cloudEligible).toBe(true);
    expect(preflight.decision.cloudSafe).toBe(true);
    expect(preflight.route).toBe('cloud');
  });

  it('事件流中 route 事件为 cloud（证明不是"一律禁止云端"）', async () => {
    const request = makeRequest({
      tools: [toolFromManifest('calc'), toolFromManifest('now')],
      gatewayRoute: 'cloud',
      userMessage: 'What is the weather like today?',
      cloudSafeSeam: true,
    });
    const { events, result } = await collect(request);

    const routeEvent = events.find(event => event.type === 'route') as Extract<RuntimeEvent, { type: 'route' }>;
    expect(routeEvent.route).toBe('cloud');
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it('三个条件缺一即回落 local（合取判定，不是单一条件）', () => {
    // ① 未显式请求云端
    expect(decideRoute({ requestedRoute: undefined, cloudSafe: true, toolCloudEligible: true })).toBe('local');
    // ② 文本判定不安全
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: false, toolCloudEligible: true })).toBe('local');
    // ③ 工具不可上云
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: true, toolCloudEligible: false })).toBe('local');
    // 三者齐备才放行
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: true, toolCloudEligible: true })).toBe('cloud');
  });
});

// ---------------------------------------------------------------------------
// Case 3 — 工具未声明 privacyLevel ⇒ internal / cloudEligible=false / local
// ---------------------------------------------------------------------------

describe('Case 3 — 工具没有声明 privacyLevel', () => {
  const undeclaredTool = { id: 'legacy_undeclared_tool', manifest: {} as Record<string, unknown> };

  it('未声明 ⇒ privacyLevel 解析为 internal', () => {
    expect(resolveToolPrivacyLevel({})).toBe('internal');
    expect(resolveToolPrivacyLevel(undefined)).toBe('internal');
  });

  it('未声明 ⇒ cloudEligible 为 false（缺省保守）', () => {
    expect(resolveToolCloudEligible({})).toBe(false);
    expect(resolveToolCloudEligible(undeclaredTool.manifest as never)).toBe(false);
  });

  it('未声明 ⇒ route 落在 local（即使显式请求云端）', () => {
    const request = makeRequest({
      tools: [undeclaredTool as never],
      gatewayRoute: 'cloud',
      userMessage: 'What is the weather like today?',
    });
    const preflight = preflightOf(request);

    expect(preflight.toolPrivacy.strictest).toBe('internal');
    expect(preflight.toolPrivacy.undeclaredCount).toBe(1);
    expect(preflight.toolPrivacy.cloudEligible).toBe(false);
    expect(preflight.route).toBe('local');
  });

  it('空工具集同样不构成"可上云"的证据', () => {
    const request = makeRequest({ tools: [], gatewayRoute: 'cloud', userMessage: 'What is the weather like today?' });
    const preflight = preflightOf(request);
    expect(preflight.toolPrivacy.cloudEligible).toBe(false);
    expect(preflight.route).toBe('local');
  });

  it('未声明与显式 internal 等价（不能靠"忘记声明"绕过）', () => {
    const undeclared = aggregateToolPrivacy([undeclaredTool as never]);
    const explicitInternal = aggregateToolPrivacy([{ id: 'x', manifest: { privacyLevel: 'internal' } }]);
    expect(undeclared.strictest).toBe(explicitInternal.strictest);
    expect(undeclared.cloudEligible).toBe(explicitInternal.cloudEligible);
    expect(undeclared.cloudEligible).toBe(false);
  });

  it('反向验证：显式 public 才放行，证明上面的 false 不是恒假', () => {
    const explicitPublic = aggregateToolPrivacy([{ id: 'y', manifest: { privacyLevel: 'public' } }]);
    expect(explicitPublic.cloudEligible).toBe(true);
  });
});
