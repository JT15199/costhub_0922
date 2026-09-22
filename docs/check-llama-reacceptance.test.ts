// Use the production file adapter; mock only the Rust IPC/file storage boundary.
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
const storage = vi.hoisted(() => ({ files: new Map<string, string>(), writes: [] as number[] }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: async (cmd: string, { request: r }: any) => {
  if (cmd !== 'execution_fs') throw new Error('Unexpected IPC: ' + cmd);
  if (r.op === 'absolute') return r.path;
  if (r.op === 'exists') return storage.files.has(r.path);
  if (r.op === 'write_binary') { storage.files.set(r.path, r.content); storage.writes.push(Buffer.from(r.content, 'base64').length); return; }
  if (r.op === 'read_binary') return { base64: storage.files.get(r.path) };
  if (r.op === 'write_text') { storage.files.set(r.path, Buffer.from(r.content).toString('base64')); return; }
  if (r.op === 'read_text') return Buffer.from(storage.files.get(r.path) || '', 'base64').toString();
  throw new Error('Unexpected file operation: ' + r.op);
} }));
import { createExecutionEnv } from '../src/ai/piExecution';
import { runLocalProductionSampleAcceptance } from '../src/ai/piCapability';
import { createPiNativeTool } from '../src/ai/piRuntime';
import { getPiRequestPolicy } from '../src/ai/piStream';
import { executeTool } from '../src/aiTools';
const execution = () => ({ workspace: 'C:\\isolated-test', env: createExecutionEnv('C:\\isolated-test'), dependencies: {}, diagnostics: [], skills: [], shellEnabled: false }) as any;
describe('second acceptance: actual adapter and oversized rows', () => {
  it('reconstructs all saved evidence via the returned cursors within each request budget', async () => {
    const context = execution();
    const source = [JSON.stringify({ text: '证据😀\\"'.repeat(6000) + 'TAIL-ALL-READ' }), JSON.stringify({ total: 37.5 }), JSON.stringify({ source: 'synthetic' })].join('\n');
    await context.env.writeFile('.costhub-results/reconstruct.json', source);
    const read = createPiNativeTool(context, 'read')!;
    const recovered: string[] = [];
    let offset: number | null = 1, charOffset = 0, pages = 0;
    while (offset !== null && pages < 100) {
      const result: any = await read.execute('reconstruct-' + pages, { path: '.costhub-results/reconstruct.json', offset, charOffset });
      const policy = getPiRequestPolicy({ contextWindow: 32768, maxTokens: 0 } as any, { systemPrompt: '', tools: [], messages: [{ role: 'toolResult', toolName: 'read', toolCallId: 'read', content: result.content }] } as any);
      expect(policy.contextTokens).toBeLessThanOrEqual(policy.inputHard);
      const page = JSON.parse(result.content[0].text);
      page.lines.forEach((piece: string, index: number) => { const row = page.offset - 1 + index; recovered[row] = (recovered[row] || '') + piece; });
      offset = page.nextOffset; charOffset = page.nextCharOffset || 0; pages++;
    }
    expect(offset).toBeNull();
    expect(pages).toBeGreaterThan(1);
    expect(recovered.join('\n')).toBe(source);
  });
  it('reports an invalid calculator expression as a failed tool', async () => {
    const result = await executeTool('calc', { expression: '1+(' });
    console.log('invalid calculation:', result);
    expect(result.ok).toBe(false);
  });
  it('writes a nonempty XLSX through the production adapter and completes the sample', async () => {
    storage.writes.length = 0;
    let result: any, error: any;
    try { result = await runLocalProductionSampleAcceptance(execution()); } catch (e) { error = String(e); }
    console.log('sample actual adapter:', { binaryWriteBytes: storage.writes, result, error });
    expect(storage.writes[0]).toBeGreaterThan(0);
    expect(error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
  it('bounds the visible preview when one spreadsheet row is very long', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['说明'.repeat(15000), '明细'.repeat(15000)]]), '长行');
    const context = execution();
    await context.env.writeFile('long.xlsx', new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })));
    const result: any = await createPiNativeTool(context, 'read')!.execute('long-row', { path: 'long.xlsx' });
    const policy = getPiRequestPolicy({ contextWindow: 32768, maxTokens: 0 } as any, { systemPrompt: '', tools: [], messages: [{ role: 'toolResult', toolName: 'read', toolCallId: 'long-row', content: result.content }] } as any);
    console.log('single-row preview:', { characters: result.content[0].text.length, tokens: policy.contextTokens, inputHard: policy.inputHard });
    expect(policy.contextTokens).toBeLessThanOrEqual(policy.inputHard);
  });
  it('can recover a long cell tail from the advertised file without shell access', async () => {
    const marker = 'CELL-END-EVIDENCE-927';
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['证据'.repeat(15000) + marker]]), '长文本');
    const context = execution();
    await context.env.writeFile('tail.xlsx', new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })));
    const read = createPiNativeTool(context, 'read')!;
    const preview = JSON.parse((await read.execute('preview', { path: 'tail.xlsx' }) as any).content[0].text);
    expect(preview.fullResultPath).toBeTruthy();
    const saved = Buffer.from(storage.files.get(preview.fullResultPath)!, 'base64').toString();
    const line = saved.split('\n').findIndex(text => text.includes(marker)) + 1;
    const reread: any = await read.execute('tail', { path: preview.fullResultPath, offset: line, limit: 1 });
    console.log('long cell reread:', reread.content[0].text);
    expect(reread.content[0].text).toContain(marker);
  });
  it('bounds a default follow-up read of the saved long-cell result', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['证据'.repeat(15000)]]), '长文本');
    const context = execution();
    await context.env.writeFile('followup.xlsx', new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })));
    const read = createPiNativeTool(context, 'read')!;
    const preview = JSON.parse((await read.execute('preview', { path: 'followup.xlsx' }) as any).content[0].text);
    const result: any = await read.execute('followup', { path: preview.fullResultPath });
    const policy = getPiRequestPolicy({ contextWindow: 32768, maxTokens: 0 } as any, { systemPrompt: '', tools: [], messages: [{ role: 'toolResult', toolName: 'read', toolCallId: 'followup', content: result.content }] } as any);
    console.log('saved-result default read:', { characters: result.content[0].text.length, tokens: policy.contextTokens, inputHard: policy.inputHard });
    expect(policy.contextTokens).toBeLessThanOrEqual(policy.inputHard);
  });
  it('bounds previews across many columns as well as within each cell', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([Array.from({ length: 300 }, () => '明细'.repeat(80))]), '宽行');
    const context = execution();
    await context.env.writeFile('wide.xlsx', new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })));
    const result: any = await createPiNativeTool(context, 'read')!.execute('wide', { path: 'wide.xlsx' });
    const policy = getPiRequestPolicy({ contextWindow: 32768, maxTokens: 0 } as any, { systemPrompt: '', tools: [], messages: [{ role: 'toolResult', toolName: 'read', toolCallId: 'wide', content: result.content }] } as any);
    console.log('many-column preview:', { characters: result.content[0].text.length, tokens: policy.contextTokens, inputHard: policy.inputHard });
    expect(policy.contextTokens).toBeLessThanOrEqual(policy.inputHard);
  });
});
