import { describe, expect, it } from 'vitest';
import { buildLocalChatBody } from '../localBackend';
import { runLocalProductionSampleAcceptance, runLocalSampleAcceptance } from '../ai/piCapability';

describe('local backend contracts', () => {
  it('forwards the saved output cap while only Ollama receives a per-request context size', () => {
    const options = { context: 32768, maxTokens: 4096 };
    const llama = buildLocalChatBody('llama.cpp', 'test-model', [], options) as any;
    expect(llama.max_tokens).toBe(4096);
    expect(llama).not.toHaveProperty('num_ctx');
    expect(llama).not.toHaveProperty('options');
    const ollama = buildLocalChatBody('ollama', 'test-model', [], options) as any;
    expect(ollama.options).toMatchObject({ num_ctx: 32768, num_predict: 4096 });
    expect(buildLocalChatBody('llama.cpp', 'test-model', [], { maxTokens: 0 })).not.toHaveProperty('max_tokens');
  });
  it('uses the OpenAI body for llama.cpp and omits an unset output cap', () => {
    const body: any = buildLocalChatBody('llama.cpp', 'qwen3.8-27b', [{ role: 'user', content: '你好' }], { stream: true, think: true });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).toHaveProperty('chat_template_kwargs.enable_thinking', true);
    expect(buildLocalChatBody('llama.cpp', 'qwen3.8-27b', [], { temperature: 0.4 })).toHaveProperty('temperature', 0.4);
  });

  it('keeps the synthetic acceptance independent of the database', () => {
    expect(runLocalSampleAcceptance()).toMatchObject({ ok: true, rows: 450, pages: 3, total: 450, compare: true, exportRows: 450 });
  });

  it('runs the production sample through task files, native read and XLSX round-trip', async () => {
    const files = new Map<string, string | Uint8Array>();
    const env = {
      absolutePath: async (path: string) => ({ ok: true, value: path }),
      writeFile: async (path: string, content: string | Uint8Array) => { files.set(path, content); return { ok: true, value: undefined }; },
      readTextFile: async (path: string) => ({ ok: true, value: String(files.get(path) || '') }),
      readBinaryFile: async (path: string) => ({ ok: true, value: files.get(path) as Uint8Array }),
    };
    const result = await runLocalProductionSampleAcceptance({ workspace: 'C:\\acceptance', env, dependencies: {}, diagnostics: [], skills: [], shellEnabled: false } as any);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ rows: 450, total: 450, compare: true, exportRows: 450 });
    expect(result.pages).toBeGreaterThan(1);
    expect(files.has('acceptance-export.xlsx')).toBe(true);
  });
});
