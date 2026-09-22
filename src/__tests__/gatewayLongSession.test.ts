import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('../ollama', () => ({ startOllamaStream: mocks.stream }));

import { buildCloudSafeContext } from '../ai/cloudContext';
import { compactContext } from '../ai/contextPolicy';
import { createAiGatewayStream } from '../ai/gateway';
import { buildLocalContext, renderWorkingState } from '../ai/contextBuilder';
import { estimateContextTokens, estimateContextUsage, createModelProfile } from '../ai/modelProfile';
import { evaluatePrivacy } from '../ai/privacyRouter';
import { createResultStore, externalizeAgentToolResult } from '../ai/resultStore';
import { emptyWorkingState, updateWorkingState, type WorkingState } from '../ai/workingState';

function execution() {
  const files = new Map<string, string>();
  const env: any = {
    writeFile: async (path: string, content: string) => { files.set(path, content); return { ok: true, value: undefined }; },
    readTextFile: async (path: string) => files.has(path) ? { ok: true, value: files.get(path) } : { ok: false, error: new Error('not found') },
    absolutePath: async (path: string) => ({ ok: true, value: path }),
  };
  return { context: { workspace: 'scenario', env } as any, files };
}

function user(text: string, id: string) {
  return { role: 'user', content: [{ type: 'text', text }], id, timestamp: Date.now() } as any;
}

function assistant(text: string, id: string) {
  return { role: 'assistant', content: [{ type: 'text', text }], id, timestamp: Date.now() } as any;
}

describe('Phase 9 gateway long-session scenario', () => {
  it('keeps state and evidence bounded across 100 turns and failure switches', async () => {
    mocks.stream.mockImplementation(async (...args: any[]) => {
      const options = args[7] || {};
      if (options.json) {
        args[3](JSON.stringify({ goal: '继续当前成本任务', constraints: [], facts: [], evidence_ids: [], pending: [], failed_or_unknown: [], next_step: '继续处理' }));
      } else {
        args[3]('本地测试响应');
      }
      args[5]();
      return () => {};
    });

    const { context: executionContext, files } = execution();
    const resultStore = createResultStore(executionContext);
    const profile = { ...createModelProfile('http://127.0.0.1:11434', 'scenario-model'), effectiveContext: 4096, maxTokens: 512 };
    const tools = [{ name: 'query_project_bom', description: '查询项目 BOM', parameters: { type: 'object' } }];
    const systemPrompt = 'CostHub 长会话测试系统提示';
    let state: WorkingState = emptyWorkingState('phase9-scenario');
    let compactionState: any;
    let activeMessages: any[] = [];
    const rawSession: any[] = [];
    const compactions: any[] = [];
    const snapshots: Record<number, { activeTokens: number; stateText: string }> = {};
    let largeResultReference = '';

    for (let turn = 1; turn <= 100; turn++) {
      const turnText = turn === 1
        ? '项目名称：项目 A，目标成本 400，供应商范围：供应商 X。已确定使用 Pi。'
        : turn === 10
          ? '目标成本改成 390。'
          : turn === 40
            ? '项目名称：项目 B，供应商范围：供应商 Y。'
            : turn === 50
              ? '切换到子任务：验证成本差异。'
              : turn === 60
                ? '已经确定先核对 BOM 来源再谈价。'
                : turn === 70
                  ? '待确认：某驱动板价格来源。'
                  : `第 ${turn} 轮继续处理当前项目，保留约束和证据 ${'context-evidence '.repeat(18)}`;
      const currentUser = user(turnText, `turn-user-${turn}`);
      const currentAssistant = assistant(`第 ${turn} 轮已记录：${'response '.repeat(16)}`, `turn-assistant-${turn}`);
      const turnMessages: any[] = [currentUser, currentAssistant];
      if (turn % 4 === 0) {
        turnMessages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `call-${turn}`, name: 'query_project_bom', arguments: { project: turn < 40 ? 'A' : 'B' } }], timestamp: Date.now() });
        for (let call = 0; call < 4; call++) {
          let content = JSON.stringify({ tool: 'query_project_bom', turn, call, rows: [{ part: `P-${turn}-${call}`, unitCost: 12 + call }] });
          if (turn === 20 && call === 0) {
            content = JSON.stringify({ rows: Array.from({ length: 180 }, (_, index) => ({ part: `BOM-${index}`, unitCost: index + 1, supplier: '供应商 X' })), tailMarker: 'BOM-TAIL-LOCAL-ONLY-' + 'x'.repeat(300) });
            const externalized = await externalizeAgentToolResult(resultStore, 'query_project_bom', { content: [{ type: 'text', text: content }] });
            expect(externalized).toBeDefined();
            largeResultReference = externalized!.content[0].text;
            content = largeResultReference;
          }
          turnMessages.push({ role: 'toolResult', toolCallId: `call-${turn}-${call}`, toolName: 'query_project_bom', content: [{ type: 'text', text: content }], timestamp: Date.now() });
        }
      }

      rawSession.push(...turnMessages);
      activeMessages.push(...turnMessages);
      state = updateWorkingState(state, { sessionId: state.sessionId, sourcePrefix: `scenario-${turn}`, messages: [currentUser, ...turnMessages.filter(message => message.role === 'toolResult')] });

      if (turn % 10 === 0) {
        const compacted = await compactContext(activeMessages, profile, compactionState, new AbortController().signal, stats => compactions.push(stats), { systemPrompt, tools, workingState: state });
        activeMessages = compacted.messages;
        compactionState = compacted.state;
        const projected = buildLocalContext({ systemPrompt, messages: activeMessages, tools } as any, state);
        const usage = estimateContextUsage(projected.systemPrompt, projected.messages, projected.tools || [], profile.effectiveContext, profile.maxTokens);
        snapshots[turn] = { activeTokens: usage.currentTokens, stateText: renderWorkingState(state) };
        expect(usage.currentTokens, `turn=${turn} messages=${activeMessages.length}`).toBeLessThanOrEqual(usage.inputHard);
      }
    }

    const finalStateText = renderWorkingState(state);
    const activeContext = buildLocalContext({ systemPrompt, messages: activeMessages, tools } as any, state);
    const finalUsage = estimateContextUsage(activeContext.systemPrompt, activeContext.messages, activeContext.tools || [], profile.effectiveContext, profile.maxTokens);
    const rawTokens = estimateContextTokens(systemPrompt, rawSession, tools);

    expect(rawSession.length).toBeGreaterThanOrEqual(200);
    expect(rawTokens).toBeGreaterThan(finalUsage.currentTokens);
    expect(compactions.length).toBeGreaterThanOrEqual(5);
    expect(compactions.every(item => item.statePreserved)).toBe(true);
    expect(compactions.some(item => (item.criticalFacts ?? 0) >= 1)).toBe(true);
    expect(snapshots[30].stateText).toContain('目标成本 390');
    expect(finalStateText).not.toContain('目标成本 390');
    expect(finalStateText).not.toContain('目标成本 400');
    expect(finalStateText).toContain('项目 B');
    expect(finalStateText).toContain('供应商 Y');
    expect(finalStateText).toContain('先核对 BOM 来源再谈价');
    expect(finalStateText).toContain('某驱动板价格来源');
    expect(snapshots[50].stateText).not.toContain('目标成本 390');
    expect(snapshots[100].stateText).toContain('项目 B');
    expect(finalUsage.currentTokens).toBeLessThanOrEqual(finalUsage.inputHard);
    expect(finalUsage.workingStateTokens).toBeGreaterThan(0);
    expect(finalUsage.retrievedTokens).toBe(finalUsage.toolResultTokens);
    expect(largeResultReference).toContain('resultId');
    expect(largeResultReference).not.toContain('BOM-TAIL-LOCAL-ONLY-');
    expect([...files.values()].some(value => value.includes('BOM-TAIL-LOCAL-ONLY-'))).toBe(true);

    const publicDecision = evaluatePrivacy({ text: '公开市场趋势', sourceTypes: ['public_market_data'], metadata: [{ sourceType: 'public_market_data', sensitivity: 'public', cloudSafe: true, priority: 'normal', sourceIds: ['trend-test'], verified: true }] });
    const sensitiveDecision = evaluatePrivacy({ text: '供应商报价和目标成本', sourceTypes: ['supplier_quote'] });
    const classifierFailure = evaluatePrivacy({ text: '公开市场趋势', sourceTypes: ['public_market_data'], classifier: () => { throw new Error('classifier down'); } });
    expect(publicDecision.classification).toBe('public');
    expect(sensitiveDecision.classification).toBe('sensitive');
    expect(classifierFailure).toMatchObject({ classification: 'unknown', candidateRoute: 'local', cloudSafe: false });

    const cloudSafe = buildCloudSafeContext({
      privacyDecision: publicDecision,
      workingState: state,
      approvedMessages: [
        { id: 'public-1', role: 'user', text: '公开市场趋势', approved: true },
        { id: 'sensitive-1', role: 'user', text: '供应商报价 390', approved: true, metadata: { sourceType: 'supplier_quote', sensitivity: 'sensitive', cloudSafe: false, priority: 'critical', sourceIds: ['sensitive-1'] } },
        { id: 'unapproved-1', role: 'assistant', text: '公开但未批准', approved: false },
      ],
      approvedRetrieval: [{ id: 'public-r1', text: '公开来源摘要', approved: true }],
    }).context;
    expect(cloudSafe.tools).toEqual([]);
    expect(cloudSafe.messages.map(item => item.content)).toEqual(['公开市场趋势']);
    expect(cloudSafe.retrieved.map(item => item.content)).toEqual(['公开来源摘要']);
    expect(JSON.stringify(cloudSafe.messages)).not.toContain('供应商报价 390');

    const cloudTrace: any[] = [];
    const cloudFailure = createAiGatewayStream({ baseUrl: '', route: 'cloud', model: 'public-model', cloud: {
      context: cloudSafe, privacyDecision: publicDecision, localMessageCount: rawSession.length,
      provider: async () => { throw new Error('cloud down'); },
    } }, { onEvent: event => cloudTrace.push(event) });
    const cloudResult = await cloudFailure({ api: 'costhub' } as any, {} as any, {} as any).result();
    expect((cloudResult as any).stopReason).toBe('error');
    expect(cloudTrace.some(event => event.type === 'cloud_context' && event.outboundCount === null && event.outboundStatus === 'not_attempted' && event.tools === 0)).toBe(true);
    expect(cloudTrace.some(event => event.type === 'network_request' && event.status === 'attempted' && event.outbound === true)).toBe(true);
    expect(cloudTrace.some(event => event.type === 'network_request' && event.status === 'failed' && event.outbound === true)).toBe(true);

    const localTrace: any[] = [];
    mocks.stream.mockImplementation(async (...args: any[]) => {
      args[6]('local down');
      return () => {};
    });
    const localFailure = createAiGatewayStream({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b', backend: 'ollama', privacy: { sourceTypes: ['supplier_quote'] } }, { onEvent: event => localTrace.push(event) });
    const localResult = await localFailure({ api: 'costhub', contextWindow: 4096, maxTokens: 512, reasoning: false } as any, { systemPrompt: '', messages: [{ role: 'user', content: [{ type: 'text', text: '供应商报价' }] }], tools: [] } as any, {} as any).result();
    expect((localResult as any).stopReason).toBe('error');
    expect(localTrace.some(event => event.type === 'route_selected' && event.route === 'local')).toBe(true);
    expect(localTrace.some(event => event.type === 'context_usage')).toBe(true);
    expect(localTrace.some(event => event.type === 'privacy_evaluation' && event.decision.classification === 'sensitive')).toBe(true);
  });
});
