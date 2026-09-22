// Regression checks converted from the 2026-09-08 audit reproductions.
// Run: npx vitest run docs/review-pi-20260908.test.ts
import { beforeEach, expect, test, vi } from 'vitest';
import { win32 } from 'node:path';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), stream: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class { onmessage = () => {}; } }));
vi.mock('../src/db', () => ({ getDb: async () => ({ execute: mocks.execute }) }));
vi.mock('../src/ollama', () => ({ startOllamaStream: mocks.stream }));
vi.mock('../src/thinkEngine', () => ({ compressMessages: (messages: unknown[]) => messages }));
import { createPiExecutionContext } from '../src/ai/piExecution';
import { savePiState } from '../src/aiPanelChat';
import { createCostHubPiStream } from '../src/ai/piStream';
import { runPiAgent } from '../src/ai/piRuntime';

beforeEach(() => {
  vi.resetAllMocks();
  // Mirror the Rust workspace-only path boundary. No real files or commands run.
  mocks.invoke.mockImplementation(async (name, payload) => {
    if (name === 'execution_create_workspace') return 'D:\\app\\ai-workspaces\\task1';
    if (name === 'execution_dependencies') return {};
    if (name === 'execution_skill_dirs') return ['D:\\app\\ai-workspaces\\task1\\.skills'];
    if (name === 'execution_fs') {
      const { workspace, path } = payload.request;
      if (win32.isAbsolute(path) && !win32.resolve(path).startsWith(workspace + '\\')) throw Error('文件路径越过任务目录边界');
      const target = win32.resolve(workspace, path);
      const root = workspace + '\\.skills';
      const skill = root + '\\SKILL.md';
      if (payload.request.op === 'info') return { name: target === root ? '.skills' : 'SKILL.md', path: target, kind: target === root ? 'directory' : 'file', size: 1, mtimeMs: 0 };
      if (payload.request.op === 'list') return [{ name: 'SKILL.md', path: skill, kind: 'file', size: 1, mtimeMs: 0 }];
      if (payload.request.op === 'join') return target;
      if (payload.request.op === 'exists') return target === skill || target === root;
      if (payload.request.op === 'read_text') return '---\nname: sample\ndescription: Analyze quotes\n---\nRead real data.';
      throw Error('unexpected fs request');
    }
    if (name === 'execution_exec') return { stdout: 'ran', stderr: '', exitCode: 0, cancelled: false, timedOut: false };
  });
});

test('Skills loader can read the packaged workspace skill', async () => {
  const context = await createPiExecutionContext();
  expect(context.skills.map(s => s.name)).toEqual(['sample']);
  expect(context.diagnostics.join()).not.toContain('越过任务目录边界');
});

test('already aborted signal never dispatches a command', async () => {
  const context = await createPiExecutionContext();
  const signal = AbortSignal.abort();
  const result = await context.env.exec('Write-Output ran', { abortSignal: signal });
  expect(mocks.invoke.mock.calls.some(([name]) => name === 'execution_exec')).toBe(false);
  expect(result.ok).toBe(false);
});

test('large recovery state remains valid JSON', async () => {
  await savePiState(1, JSON.stringify([{ role: 'user', content: 'a'.repeat(2_000_010) }]));
  const stored = mocks.execute.mock.calls[0][1][0];
  expect(stored.length).toBeGreaterThan(2_000_000);
  expect(JSON.parse(stored)[0].content).toHaveLength(2_000_010);
});

test('transport preserves long file results and images', async () => {
  mocks.stream.mockImplementation(async (...args) => { args[5](); });
  const context = {
    systemPrompt: '',
    messages: [{ role: 'toolResult', toolName: 'read', toolCallId: 'r1', content: [
      { type: 'text', text: 'a'.repeat(4000) + 'IMPORTANT_TAIL' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ], timestamp: 0 }],
  };
  const stream = createCostHubPiStream('http://localhost', 'test')({ id: 'test' } as any, context as any);
  await stream.result();
  const tool = mocks.stream.mock.calls[0][2][1];
  expect(tool.content).toContain('IMPORTANT_TAIL');
  expect(tool.images).toEqual(['aW1hZ2U=']);
});

test('real Pi loop creates chart artifact without shell and checkpoints tool result', async () => {
  const writeFile = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const onChart = vi.fn(), onToolStart = vi.fn(), onToolResult = vi.fn(), checkpoint = vi.fn(async () => {});
  const spec = { title: '报价比较', takeaway: '测试数据', type: 'bar', unit: '元', source: '测试附件', basis: '同税率', labels: ['A', 'B'], series: [{ name: '报价', values: [120, 100] }] };
  let request = 0;
  mocks.stream.mockImplementation(async (...args) => {
    const names = args[7].tools.map((tool: any) => tool.function.name);
    expect(names).toContain('render_analysis_chart');
    expect(names).not.toContain('powershell');
    if (request++ === 0) args[7].onToolCalls([{ id: 'chart1', function: { name: 'render_analysis_chart', arguments: { spec: JSON.stringify(spec) } } }]);
    else args[3]('已生成图表');
    args[5]();
  });
  const result = await runPiAgent({ baseUrl: 'http://localhost', model: 'test', systemPrompt: '', userContent: '比较附件报价', tools: [], execution: { workspace: 'workspace', env: { writeFile } as any, dependencies: {}, skills: [], diagnostics: [], shellEnabled: false }, executeTool: vi.fn(), onCheckpoint: checkpoint, onEvent: { onChart, onToolStart, onToolResult } });
  expect(writeFile.mock.calls[0][1]).toContain('<svg');
  expect(onChart).toHaveBeenCalledTimes(1);
  expect(onToolStart).toHaveBeenCalledTimes(1);
  expect(onToolResult).toHaveBeenCalledTimes(1);
  expect(result.finalText).toBe('已生成图表');
  expect(result.messages.some(m => m.role === 'toolResult')).toBe(true);
  expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(3);
});

test('continuing a session reuses its workspace', async () => {
  const workspace = 'D:\\app\\ai-workspaces\\task1';
  expect((await createPiExecutionContext(workspace)).workspace).toBe(workspace);
  expect(mocks.invoke.mock.calls.some(([name]) => name === 'execution_create_workspace')).toBe(false);
});
