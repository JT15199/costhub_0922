import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('../ollama', () => ({ startOllamaStream: mocks.stream }));

import { runPiAgent } from '../ai/piRuntime';
import { emptyWorkingState } from '../ai/workingState';

it('compacts a long run through the real Pi transformContext and preserves Working State in the provider projection', async () => {
  const providerMessages: any[][] = [];
  const compactions: any[] = [];
  const gatewayEvents: any[] = [];
  // 2026-09-21：摘要契约从"7 字段 JSON"改为 DSH 式结构化检查点（固定 Markdown 章节 + <compacted-summary> 包裹），
  // 压缩调用也不再传 json:true。这里按提示词内容识别压缩调用并返回合法检查点。
  const CHECKPOINT = [
    '## 主要请求与意图 (Primary Request and Intent)', '- 保留当前任务并继续回答',
    '## 关键技术概念 (Key Technical Concepts)', '- Pi 原生工具循环与上下文检查点',
    '## 文件与代码 (Files and Code)', '- src/ai/contextPolicy.ts：压缩目标改为压到水位以下',
    '## 错误与修复 (Errors and Fixes)', '- (none)',
    '## 待办工作 (Pending Jobs)', '- 继续回答用户',
    '## 当前工作 (Current Work)', '- 正在压缩上下文',
    '## 下一步 (Next Step)', '- 继续回答',
    '## 关键上下文 (Critical Context)', '- 已确定使用 Pi',
  ].join('\n');
  mocks.stream.mockImplementation(async (...args: any[]) => {
    const isCompaction = JSON.stringify(args[2] || []).includes('上下文压缩引擎');
    if (isCompaction) args[3](CHECKPOINT);
    else { providerMessages.push(args[2]); args[3]('已完成'); }
    args[5]();
    return () => {};
  });
  const state = emptyWorkingState('session-compaction');
  state.decisions = [{ id: 'decision-pi', text: '已确定使用 Pi', sourceMessageIds: ['old'], sensitivity: 'internal', confidence: 'confirmed', status: 'active', priority: 'critical', provenance: { sourceType: 'user_message', sensitivity: 'internal', cloudSafe: false, priority: 'critical', sourceIds: ['old'] } }];
  const history = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `${index} ` + '历史报价证据与约束 '.repeat(120) }));
  const result = await runPiAgent({
    baseUrl: 'http://localhost', model: 'test', contextWindow: 8192, maxTokens: 1024, systemPrompt: '', userContent: '继续处理当前报价任务',
    tools: [], history, workingState: state, executeTool: vi.fn(),
    onEvent: { onCompaction: value => compactions.push(value) }, onGatewayTrace: event => gatewayEvents.push(event), onCheckpoint: async () => {},
  });

  expect(compactions.some(item => item.compacted && (item.level === 'orange' || item.level === 'red'))).toBe(true);
  expect(providerMessages.some(messages => messages.some(message => JSON.stringify(message).includes('已确定使用 Pi')))).toBe(true);
  expect(result.workingState.decisions.some(item => item.text.includes('已确定使用 Pi') && item.status === 'active')).toBe(true);
  expect(gatewayEvents.some(event => event.type === 'privacy_evaluation' && event.decision.classification === 'sensitive' && event.decision.candidateRoute === 'local')).toBe(true);
});
