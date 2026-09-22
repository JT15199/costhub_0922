// Acceptance probes: use production functions; model transport and DB are isolated.
// Run: npx vitest run docs/check-llama-acceptance.test.ts
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
const transport = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/db', () => ({ getProjects: async () => [], getSetting: async (_key: string, fallback: string) => fallback }));
vi.mock('../src/ollama', () => ({ startOllamaStream: async (_base: unknown, _model: unknown, _messages: unknown, token: any, _thinking: unknown, done: any, error: any) => { token(transport.fail ? '未完成的半句' : '完成'); if (transport.fail) error('连接中断，未收到结束标记'); else done(); return () => {}; } }));
import { runPiAgent } from '../src/ai/piRuntime';
import { executeTool } from '../src/aiTools';
import { getPiRequestPolicy } from '../src/ai/piStream';

async function readTool() {
  const workbook = XLSX.utils.book_new();
  for (let i = 0; i < 5; i++) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 450 }, (_, row) => Array.from({ length: 20 }, (_, col) => `报价明细-${row}-${col}`))), `sheet${i}`);
  let tool: any;
  await runPiAgent({ baseUrl: 'http://127.0.0.1:8080', backend: 'llama.cpp', model: 'test', systemPrompt: '', userContent: 'hello', tools: [], think: false,
    execution: { workspace: 'C:\\acceptance', dependencies: {}, diagnostics: [], skills: [], shellEnabled: false,
      env: { absolutePath: async (path: string) => ({ ok: true, value: path }), readBinaryFile: async () => ({ ok: true, value: XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) }) } } as any,
    executeTool: async () => { throw new Error('No business tool should run'); },
    onAgentReady: agent => { tool = agent.state.tools.find(item => item.name === 'read'); },
  });
  return tool;
}

describe('27B acceptance gaps', () => {
  it('does not resolve a broken stream as a completed answer', async () => {
    transport.fail = true;
    try {
      const request = runPiAgent({ baseUrl: 'http://127.0.0.1:8080', backend: 'llama.cpp', model: 'test', systemPrompt: '', userContent: 'hello', tools: [], think: false, executeTool: async () => ({ ok: true, text: '' }) });
      await expect(request).rejects.toThrow(/连接中断|结束标记/);
    } finally { transport.fail = false; }
  });
  it('reports a missing import target as failure', async () => {
    const result = await executeTool('import_bom_to_project', { project_code: 'DOES-NOT-EXIST', items: [{ name: 'sample', cost: 1, quantity: 1 }] }, { confirmed: true });
    console.log('missing-target result:', result);
    expect(result.ok).toBe(false);
  });
  it('advertises the worksheet selector in the actual Pi read schema', async () => {
    const tool = await readTool();
    console.log('read schema:', JSON.stringify(tool.parameters));
    expect(tool.parameters.properties).toHaveProperty('sheet');
  });
  it('keeps a wide workbook read within the next request budget', async () => {
    const tool = await readTool();
    const result = await tool.execute('read-test', { path: 'sample.xlsx' });
    const policy = getPiRequestPolicy({ contextWindow: 32768, maxTokens: 0 } as any, { systemPrompt: '', tools: [], messages: [{ role: 'toolResult', toolName: 'read', toolCallId: 'read-test', content: result.content }] } as any);
    console.log('wide workbook:', { responseCharacters: result.content[0].text.length, estimatedTokens: policy.contextTokens, inputHard: policy.inputHard });
    expect(policy.contextTokens).toBeLessThanOrEqual(policy.inputHard);
  });
});
