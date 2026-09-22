import { describe, expect, it } from 'vitest';
import { createResultStore, externalizeAgentToolResult } from '../ai/resultStore';

function execution() {
  const files = new Map<string, string>();
  const env: any = {
    writeFile: async (path: string, content: string) => { files.set(path, content); return { ok: true, value: undefined }; },
    readTextFile: async (path: string) => files.has(path) ? { ok: true, value: files.get(path) } : { ok: false, error: new Error('not found') },
    absolutePath: async (path: string) => ({ ok: true, value: path }),
  };
  return { context: { workspace: 'workspace', env } as any, files };
}

describe('local tool result store', () => {
  it('persists a result reference and reads it by range or query', async () => {
    const { context, files } = execution();
    const store = createResultStore(context);
    const stored = await store.store('query_project_bom', '第一行\n目标成本 390\n第三行\n供应商 X', '项目 BOM 摘要');

    expect(stored.id).toMatch(/^result_[0-9a-f-]{36}$/i);
    expect(files.has(`${stored.id ? '.costhub-results/' + stored.id : ''}.meta.json`)).toBe(true);
    const page = await store.read(stored.id, { offset: 1, limit: 2 });
    expect(page.lines).toEqual(['目标成本 390', '第三行']);
    expect(page.nextOffset).toBe(3);
    const matches = await store.read(stored.id, { query: '供应商' });
    expect(matches.matches).toEqual([{ line: 4, text: '供应商 X' }]);
  });

  it('puts only a resultId reference in the model-facing content', async () => {
    const { context } = execution();
    const store = createResultStore(context);
    const compacted = await externalizeAgentToolResult(store, 'query_project_bom', { content: [{ type: 'text', text: 'x'.repeat(7000) }] });
    expect(compacted).toBeDefined();
    const payload = JSON.parse(compacted!.content[0].text);
    expect(payload.resultId).toMatch(/^result_/);
    expect(payload.instruction).toContain('result_read');
    expect(payload.fullContentPath).toBeUndefined();
  });

  it('registers existing task result files without copying their full content', async () => {
    const { context, files } = execution();
    files.set('.costhub-results/source.txt', '保留的原始结果');
    const store = createResultStore(context);
    const compacted = await externalizeAgentToolResult(store, 'analyze_spreadsheet', {
      content: [{ type: 'text', text: JSON.stringify({ fullResultPath: '.costhub-results/source.txt', summary: '表格摘要' }) }],
      details: { fullResultPath: '.costhub-results/source.txt' },
    });
    const payload = JSON.parse(compacted!.content[0].text);
    const restored = await store.read(payload.resultId);
    expect(restored.lines).toEqual(['保留的原始结果']);
    expect(files.has('.costhub-results/source.txt')).toBe(true);
  });
});
