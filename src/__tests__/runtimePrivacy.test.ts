import { describe, it, expect, vi, beforeEach } from 'vitest';

// 只替换执行器：本文件验证「隐私与工具安全控制」的正确性，不验证 piRuntime 自身行为。
const runPiAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../ai/piRuntime', () => ({ runPiAgent: runPiAgentMock }));

import { collectAgentTurn } from '../ai/runtime/session';
import { runPreflight } from '../ai/runtime/preflight';
import { aggregateToolPrivacy, buildPrivacySourceTypes, decideRoute } from '../ai/runtime/toolPrivacy';
import {
  resolveToolPrivacyLevel,
  resolveToolCloudEligible,
  strictestPrivacyLevel,
  allCloudEligible,
  DEFAULT_TOOL_PRIVACY_LEVEL,
  type AiToolManifest,
  type ToolPrivacyLevel,
} from '../ai/contracts';
import { AI_TOOL_MANIFESTS } from '../ai/toolRegistry';
import type { AgentRequest, RuntimeEvent, RuntimeEventType } from '../ai/runtime/contract';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const outcome = {
  finalText: '分析完成。',
  rounds: 1,
  messages: [{ role: 'assistant', content: '分析完成。' }],
  workingState: { version: 1, items: [], projects: [], files: [], artifacts: [], tasks: [] },
};

type ToolStub = { id: string; manifest?: Pick<AiToolManifest, 'privacyLevel' | 'cloudEligible'> };

const tool = (id: string, privacyLevel?: ToolPrivacyLevel, cloudEligible?: boolean): ToolStub => ({
  id,
  manifest: privacyLevel === undefined && cloudEligible === undefined ? {} : { privacyLevel, cloudEligible },
});

function makeRequest(overrides: { tools?: ToolStub[]; gatewayRoute?: 'local' | 'cloud'; userMessage?: string } = {}): AgentRequest {
  return {
    sessionId: 1,
    runId: 'run-priv',
    userMessage: overrides.userMessage ?? '看下这个项目的成本',
    options: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:4b',
      systemPrompt: 'sys',
      tools: (overrides.tools ?? []) as never,
      gatewayRoute: overrides.gatewayRoute,
      executeTool: async () => ({ ok: true, text: 'ok' }),
    },
  };
}

/** 取出事件流里的事件类型序列。 */
function typesOf(events: RuntimeEvent[]): RuntimeEventType[] {
  return events.map(event => event.type);
}

/** 只保留「阶段骨架」事件，忽略运行中产生的 thought/token/tool 等。 */
function skeleton(events: RuntimeEvent[]): string[] {
  return events
    .filter(event => ['budget', 'privacy', 'route', 'final', 'error'].includes(event.type))
    .map(event => event.type);
}

const preflightOf = (request: AgentRequest) => runPreflight({ request, provider: 'local', model: request.options.model });

beforeEach(() => {
  runPiAgentMock.mockReset();
  runPiAgentMock.mockResolvedValue(outcome);
});

// ---------------------------------------------------------------------------
// Task 1：契约推导规则（fail-closed）
// ---------------------------------------------------------------------------

describe('Task 1 — AiToolManifest 隐私字段的推导规则', () => {
  it('未声明 privacyLevel 时缺省为 internal（保守，不假设 public）', () => {
    expect(DEFAULT_TOOL_PRIVACY_LEVEL).toBe('internal');
    expect(resolveToolPrivacyLevel({})).toBe('internal');
    expect(resolveToolPrivacyLevel(undefined)).toBe('internal');
    expect(resolveToolPrivacyLevel({ privacyLevel: 'bogus' as ToolPrivacyLevel })).toBe('internal');
  });

  it('sensitive 工具恒不可上云 —— 即使显式声明 cloudEligible: true 也不放行', () => {
    expect(resolveToolCloudEligible({ privacyLevel: 'sensitive' })).toBe(false);
    expect(resolveToolCloudEligible({ privacyLevel: 'sensitive', cloudEligible: true })).toBe(false);
  });

  it('未声明 cloudEligible 时，仅 public 允许上云；internal 一律禁止', () => {
    expect(resolveToolCloudEligible({ privacyLevel: 'public' })).toBe(true);
    expect(resolveToolCloudEligible({ privacyLevel: 'internal' })).toBe(false);
    expect(resolveToolCloudEligible({})).toBe(false);
  });

  it('internal + 显式 cloudEligible:true 仍然禁止（不允许越过级别）', () => {
    expect(resolveToolCloudEligible({ privacyLevel: 'internal', cloudEligible: true })).toBe(false);
  });

  it('strictestPrivacyLevel 取最严；allCloudEligible 要求全为真', () => {
    expect(strictestPrivacyLevel(['public', 'internal'])).toBe('internal');
    expect(strictestPrivacyLevel(['public', 'sensitive', 'internal'])).toBe('sensitive');
    expect(allCloudEligible([true, true])).toBe(true);
    expect(allCloudEligible([true, false])).toBe(false);
    expect(allCloudEligible([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 2：42 个既有工具仍然兼容 + 云/写工具已声明
// ---------------------------------------------------------------------------

describe('Task 2 — 既有 manifest 兼容性与声明补全', () => {
  it('42 个工具全部仍有 manifest，且新增字段不破坏既有结构', () => {
    const manifests = Object.values(AI_TOOL_MANIFESTS);
    expect(manifests.length).toBe(42);
    for (const manifest of manifests) {
      expect(typeof manifest.id).toBe('string');
      expect(['read', 'calculate', 'write', 'cloud']).toContain(manifest.kind);
      expect(typeof manifest.requiresConfirmation).toBe('boolean');
      // 隐私级别即使未声明，也必须能推出一个确定值（不留 undefined）
      expect(['public', 'internal', 'sensitive']).toContain(resolveToolPrivacyLevel(manifest));
    }
  });

  it('所有 kind=cloud 工具声明为 public 且允许上云', () => {
    const cloudTools = Object.values(AI_TOOL_MANIFESTS).filter(manifest => manifest.kind === 'cloud');
    expect(cloudTools.length).toBeGreaterThan(0);
    for (const manifest of cloudTools) {
      expect(manifest.privacyLevel).toBe('public');
      expect(resolveToolCloudEligible(manifest)).toBe(true);
    }
  });

  it('所有 kind=write 工具声明为 sensitive 且禁止上云', () => {
    const writeTools = Object.values(AI_TOOL_MANIFESTS).filter(manifest => manifest.kind === 'write');
    expect(writeTools.length).toBeGreaterThan(0);
    for (const manifest of writeTools) {
      expect(manifest.privacyLevel).toBe('sensitive');
      expect(resolveToolCloudEligible(manifest)).toBe(false);
    }
  });

  it('文件读取类工具（read_excel）为 sensitive，不得上云', () => {
    const manifest = AI_TOOL_MANIFESTS.read_excel;
    expect(manifest.privacyLevel).toBe('sensitive');
    expect(resolveToolCloudEligible(manifest)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 验收点 1：sensitive 工具不能 cloud
// ---------------------------------------------------------------------------

describe('验收点 1 — sensitive 工具不能走云端', () => {
  it('工具集含 sensitive → 聚合 cloudEligible 为 false，最严级别为 sensitive', () => {
    const aggregate = aggregateToolPrivacy([tool('a', 'public'), tool('b', 'sensitive')]);
    expect(aggregate.cloudEligible).toBe(false);
    expect(aggregate.strictest).toBe('sensitive');
    expect(aggregate.sensitiveToolIds).toEqual(['b']);
  });

  it('即使用户显式请求 cloud，含 sensitive 工具时路由仍为 local', () => {
    const preflight = preflightOf(makeRequest({ tools: [tool('query_project_bom', 'sensitive')], gatewayRoute: 'cloud' }));
    expect(preflight.route).toBe('local');
    expect(preflight.toolPrivacy.cloudEligible).toBe(false);
  });

  it('sensitive 工具推导出 private_workspace 来源标签，隐私判定据此 fail-closed', () => {
    const request = makeRequest({ tools: [tool('query_project_bom', 'sensitive')] });
    const preflight = preflightOf(request);
    expect(preflight.sourceTypes).toContain('private_workspace');
    expect(preflight.decision.classification).toBe('sensitive');
    expect(preflight.decision.cloudSafe).toBe(false);
    expect(preflight.decision.reasonCode).toContain('source_policy');
  });

  it('decideRoute 是 fail-closed 合取：任一条件不满足即为 local', () => {
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: true, toolCloudEligible: true })).toBe('cloud');
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: false, toolCloudEligible: true })).toBe('local');
    expect(decideRoute({ requestedRoute: 'cloud', cloudSafe: true, toolCloudEligible: false })).toBe('local');
    expect(decideRoute({ requestedRoute: 'local', cloudSafe: true, toolCloudEligible: true })).toBe('local');
    expect(decideRoute({ cloudSafe: true, toolCloudEligible: true })).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// 验收点 2：缺失 privacyLevel 默认禁止 cloud
// ---------------------------------------------------------------------------

describe('验收点 2 — 未声明 privacyLevel 默认禁止 cloud', () => {
  it('未声明字段的工具按 internal 处理，且不可上云', () => {
    const aggregate = aggregateToolPrivacy([tool('x')]);
    expect(aggregate.strictest).toBe('internal');
    expect(aggregate.cloudEligible).toBe(false);
    expect(aggregate.undeclaredCount).toBe(1);
  });

  it('工具集为空时不构成"可上云"的证据 → 默认 false', () => {
    const aggregate = aggregateToolPrivacy([]);
    expect(aggregate.cloudEligible).toBe(false);
    expect(aggregate.strictest).toBe('internal');
  });

  it('全部未声明时，即使显式请求 cloud 也被拦回 local', () => {
    const preflight = preflightOf(makeRequest({ tools: [tool('p'), tool('q')], gatewayRoute: 'cloud' }));
    expect(preflight.route).toBe('local');
    expect(preflight.toolPrivacy.undeclaredCount).toBe(2);
  });

  it('只有 public 工具时才允许云端候选（证明上面的拦截不是恒假）', () => {
    const preflight = preflightOf(makeRequest({ tools: [tool('calc', 'public')], gatewayRoute: 'cloud' }));
    expect(preflight.toolPrivacy.cloudEligible).toBe(true);
    // 注意：本用例只证明"工具层面放行"；文本层面的 privacyRouter 判定独立生效，
    // 因此这里不断言最终 route 一定为 cloud（那取决于文本是否被判定为 public）。
    expect(preflight.decision.cloudSafe).toBe(false);
    expect(preflight.route).toBe('local');
  });

  it('buildPrivacySourceTypes 仅在 sensitive 时注入 private_workspace，并保留调用方标签', () => {
    const sensitive = aggregateToolPrivacy([tool('s', 'sensitive')]);
    const mild = aggregateToolPrivacy([tool('m', 'internal')]);
    expect(buildPrivacySourceTypes(sensitive)).toEqual(['private_workspace']);
    expect(buildPrivacySourceTypes(mild)).toEqual([]);
    expect(buildPrivacySourceTypes(mild, ['public_market_data'])).toEqual(['public_market_data']);
    expect(buildPrivacySourceTypes(sensitive, ['public_market_data'])).toEqual(['private_workspace', 'public_market_data']);
  });
});

// ---------------------------------------------------------------------------
// 验收点 3：RuntimeEvent 顺序 budget → privacy → route → final
// ---------------------------------------------------------------------------

describe('验收点 3 — RuntimeEvent 顺序', () => {
  it('阶段骨架顺序为 budget → privacy → route → final', async () => {
    const { events, result } = await collectAgentTurn(makeRequest({ tools: [tool('calc', 'public')] }));
    expect(skeleton(events)).toEqual(['budget', 'privacy', 'route', 'final']);
    expect(result.ok).toBe(true);
  });

  it('含 sensitive 工具时顺序不变，但 route 事件为 local', async () => {
    const { events } = await collectAgentTurn(makeRequest({ tools: [tool('query_project_bom', 'sensitive')], gatewayRoute: 'cloud' }));
    expect(skeleton(events)).toEqual(['budget', 'privacy', 'route', 'final']);
    const routeEvent = events.find(event => event.type === 'route') as Extract<RuntimeEvent, { type: 'route' }>;
    expect(routeEvent.route).toBe('local');
  });

  it('privacy 事件携带真实判定结果（来自 privacyRouter，不是占位）', async () => {
    const { events } = await collectAgentTurn(makeRequest({ tools: [tool('s', 'sensitive')] }));
    const privacyEvent = events.find(event => event.type === 'privacy') as Extract<RuntimeEvent, { type: 'privacy' }>;
    expect(privacyEvent.decision.classification).toBe('sensitive');
    expect(privacyEvent.decision.cloudSafe).toBe(false);
    expect(Array.isArray(privacyEvent.decision.sourceTypes)).toBe(true);
  });

  it('privacy / route 各有 start 与收尾 stage 事件（阶段可观测）', async () => {
    const { events } = await collectAgentTurn(makeRequest({ tools: [tool('calc', 'public')] }));
    const stages = events.filter(event => event.type === 'stage') as Array<Extract<RuntimeEvent, { type: 'stage' }>>;
    const privacyStages = stages.filter(stage => stage.stage === 'privacy').map(stage => stage.status);
    const routeStages = stages.filter(stage => stage.stage === 'route').map(stage => stage.status);
    expect(privacyStages).toEqual(['start', 'skip']);
    expect(routeStages).toEqual(['start', 'ok']);
  });

  it('失败时阶段骨架仍为 budget → privacy → route → error（隐私先于执行）', async () => {
    runPiAgentMock.mockRejectedValue(new Error('模型炸了'));
    const turn = (await import('../ai/runtime/session')).runAgentTurn(makeRequest({ tools: [tool('s', 'sensitive')] }));
    const events: RuntimeEvent[] = [];
    for (;;) {
      const next = await turn.next().catch(() => ({ done: true as const, value: undefined as never }));
      if (next.done) break;
      events.push(next.value);
    }
    expect(skeleton(events)).toEqual(['budget', 'privacy', 'route', 'error']);
  });

  it('seq 单调递增且事件带 runId（顺序可回放）', async () => {
    const { events } = await collectAgentTurn(makeRequest({ tools: [tool('calc', 'public')] }));
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.every(event => event.runId === 'run-priv')).toBe(true);
    expect(typesOf(events)).toContain('stage');
  });
});
