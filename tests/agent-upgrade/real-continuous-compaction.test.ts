import { afterEach, describe, expect, it, vi } from 'vitest';

const liveState = vi.hoisted(() => ({ streamedContent: '', streamCalls: 0, errors: [] as string[] }));

// This bypasses the Tauri event broker and uses a direct non-streaming read of
// the same Ollama endpoint. The model request and all summary content remain real.
vi.mock('../../src/ollama', () => ({
  startOllamaStream: async (baseUrl: string, model: string, messages: any[], onToken: (value: string) => void, onReasoning: (value: string) => void, onDone: () => void, onError: (value: string) => void, opts: any = {}) => {
    liveState.streamCalls++;
    const controller = new AbortController();
    const cleanup = () => controller.abort();
    opts.signal?.addEventListener('abort', cleanup, { once: true });
    void (async () => {
      try {
        const body: any = { model, messages, stream: false, options: { num_predict: opts.num_predict ?? 3072, num_ctx: opts.num_ctx ?? 8192, temperature: opts.temperature ?? 0.3 } };
        if (opts.json !== false) body.format = 'json';
        if (opts.think === false) { body.think = false; body.options.enable_thinking = false; }
        if (opts.tools?.length) body.tools = opts.tools;
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const row = await response.json();
        const message = row.message || {};
        if (message.content) { liveState.streamedContent += message.content; onToken(message.content); }
        if (message.thinking) onReasoning(message.thinking);
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) opts.onToolCalls?.(message.tool_calls);
        opts.onUsage?.({ promptEvalCount: row.prompt_eval_count, evalCount: row.eval_count, doneReason: row.done_reason });
        if (row.done_reason === 'length') opts.onTruncated?.();
        onDone();
      } catch (error) {
        if (!controller.signal.aborted) { liveState.errors.push(String((error as Error)?.message || error)); onError(String((error as Error)?.message || error)); }
      } finally {
        opts.signal?.removeEventListener('abort', cleanup);
      }
    })();
    return cleanup;
  },
}));

describe('real continuous compaction', () => {
  afterEach(() => {
    liveState.streamedContent = ''; liveState.streamCalls = 0; liveState.errors = [];
  });

  it.runIf(process.env.COSTHUB_LIVE === '1')('uses the real Ollama model through the production compaction host for three consecutive compactions', async () => {
    const { compactContext } = await import('../../src/ai/contextPolicy');
    const { createModelProfile } = await import('../../src/ai/modelProfile');
    const compactions: any[] = [];
    let messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `历史证据 H-${index}: 供应商报价备注、质保差异、未知动作与来源引用。${'retain-evidence '.repeat(32)}`,
      timestamp: Date.now(),
    })) as any;
    const baseUrl = process.env.COSTHUB_OLLAMA_URL || 'http://127.0.0.1:11434';
    const model = process.env.COSTHUB_OLLAMA_MODEL || 'qwen3:4b';
    let state: any;
    const profile = { ...createModelProfile(baseUrl, model), effectiveContext: 8192, maxTokens: 512 };
    for (let index = 1; index <= 3; index++) {
      messages = [...messages, ...Array.from({ length: 12 }, (_, offset) => ({
        role: offset % 2 ? 'assistant' : 'user',
        content: `连续任务第 ${index} 轮新增证据 ${offset}：${'retain-goal-constraint-source-unknown-pending '.repeat(32)}`,
        timestamp: Date.now(),
      }))] as any;
      const result = await compactContext(messages, profile, state, new AbortController().signal, stats => compactions.push(stats));
      messages = result.messages;
      state = result.state;
    }
    const outDir = 'artifacts/agent-upgrade/20260911-live-continuous-compaction';
    const fs = await import('node:fs/promises');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(`${outDir}/real-continuous-compaction.json`, JSON.stringify({ mode: 'live-model-production-compaction', baseUrl, model, compactions, messageCount: messages.length, streamedContent: liveState.streamedContent, streamCalls: liveState.streamCalls, errors: liveState.errors }, null, 2));
    expect(compactions.length).toBeGreaterThanOrEqual(3);
    expect(compactions.slice(0, 3).every(item => item.usedModel && !item.error)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  }, 240000);

  it.runIf(process.env.COSTHUB_LIVE === '1')('returns a real final answer through runPiAgent', async () => {
    const { runPiAgent } = await import('../../src/ai/piRuntime');
    const { createModelProfile } = await import('../../src/ai/modelProfile');
    const baseUrl = process.env.COSTHUB_OLLAMA_URL || 'http://127.0.0.1:11434';
    const model = process.env.COSTHUB_OLLAMA_MODEL || 'qwen3:4b';
    const result = await runPiAgent({
      baseUrl, model,
      systemPrompt: '只用一句中文回答，不调用工具。',
      userContent: '请回答：本地模型链路已连接吗？',
      tools: [],
      profile: { ...createModelProfile(baseUrl, model), effectiveContext: 8192, maxTokens: 128 },
      think: false,
      executeTool: async () => ({ ok: false, text: '不应调用工具' }),
    });
    const fs = await import('node:fs/promises');
    const outDir = 'artifacts/agent-upgrade/20260911-live-continuous-compaction';
    await fs.writeFile(`${outDir}/real-pi-host-smoke.json`, JSON.stringify({ mode: 'live-model-production-pi-host', baseUrl, model, finalText: result.finalText, messageCount: result.messages.length }, null, 2));
    expect(result.finalText.trim().length).toBeGreaterThan(0);
  }, 120000);

  it.skipIf(process.env.COSTHUB_LIVE === '1')('is skipped unless COSTHUB_LIVE=1', () => {});
});
