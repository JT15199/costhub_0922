import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ handlers: new Map<string, any>(), calls: [] as any[], abortOnListen: undefined as (() => void) | undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (name: string, args: any) => { state.calls.push({ name, args }); } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, handler: any) => { state.handlers.set(name, handler); state.abortOnListen?.(); return () => state.handlers.delete(name); } }));
import { startOllamaStream } from '../src/ollama';
beforeEach(() => { state.handlers.clear(); state.calls.length = 0; state.abortOnListen = undefined; });
const emit = (kind: string, payload?: any) => { const entry = [...state.handlers].find(([name]) => name.startsWith(`llm-${kind}-`)); entry?.[1]({ payload }); };
describe('production stream event merger and cancellation', () => {
  it('keeps two interleaved tool calls distinct and reports separate usage once', async () => {
    const tools = vi.fn(), done = vi.fn(), error = vi.fn(), usage = vi.fn();
    await startOllamaStream('http://127.0.0.1:8080', 'test', [], () => {}, () => {}, done, error, { backend: 'llama.cpp', onToolCalls: tools, onUsage: usage });
    emit('toolcall-delta', JSON.stringify([{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":"报' } }, { index: 1, id: 'b', function: { name: 'calc', arguments: '{"expression":"2' } }]));
    emit('toolcall-delta', JSON.stringify([{ id: 'b', function: { arguments: '+3"}' } }, { index: 0, function: { arguments: '价.xlsx"}' } }]));
    emit('meta', JSON.stringify({ promptEvalCount: 100, evalCount: 30, doneReason: 'tool_calls' }));
    emit('done'); emit('done');
    expect(tools).toHaveBeenCalledTimes(1);
    expect(tools.mock.calls[0][0].map((call: any) => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }))).toEqual([{ id: 'a', name: 'read', args: { path: '报价.xlsx' } }, { id: 'b', name: 'calc', args: { expression: '2+3' } }]);
    expect(usage).toHaveBeenCalledWith({ promptEvalCount: 100, evalCount: 30, doneReason: 'tool_calls' });
    expect(done).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled(); expect(state.handlers.size).toBe(0);
  });
  it('does not start a request when cancelled while registering listeners', async () => {
    const controller = new AbortController(), error = vi.fn(), done = vi.fn();
    state.abortOnListen = () => controller.abort();
    await startOllamaStream('http://127.0.0.1:8080', 'test', [], () => {}, () => {}, done, error, { backend: 'llama.cpp', signal: controller.signal });
    expect(state.calls.some(call => call.name === 'http_stream')).toBe(false);
    expect(error).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled(); expect(state.handlers.size).toBe(0);
  });
  it('discards incomplete tool calls after a stream error', async () => {
    const tools = vi.fn(), done = vi.fn(), error = vi.fn();
    await startOllamaStream('http://127.0.0.1:8080', 'test', [], () => {}, () => {}, done, error, { backend: 'llama.cpp', onToolCalls: tools });
    emit('toolcall-delta', JSON.stringify([{ index: 0, function: { name: 'read', arguments: '{"path":' } }]));
    emit('error', '连接中断'); emit('done');
    expect(tools).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(1); expect(state.handlers.size).toBe(0);
  });
});
