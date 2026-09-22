import { describe, expect, it } from 'vitest';
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { PiTaskHost } from '../ai/piHarness';
import { commitWorkingContext } from '../ai/piWorkingContext';

const messageText = (message: AgentMessage) => ((message as any).content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
const userMessage = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage);

function response(text: string, tool = false): any {
  return {
    role: 'assistant',
    content: tool ? [{ type: 'toolCall', id: 'probe-1', name: 'probe', arguments: {} }] : [{ type: 'text', text }],
    api: 'costhub-ollama', provider: 'test', model: 'test', stopReason: tool ? 'toolUse' : 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function streamFor(message: any) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
}

describe('Pi task host and committed working context', () => {
  it('keeps raw events, commits three compactions through a tool turn, and restores from saved work state', async () => {
    const requests: string[][] = [];
    const rawEvents: AgentMessage[] = [];
    let toolCalls = 0;
    let streamCount = 0;
    let compactions = 0;
    let agent!: Agent;
    const streamFn = async (_model: any, context: any) => {
      requests.push(context.messages.map(messageText));
      const next = streamCount++ === 0 ? response('', true) : response('完成');
      return streamFor(next);
    };
    const tool = {
      name: 'probe', label: 'probe', description: 'test', parameters: Type.Object({}),
      execute: async () => { toolCalls++; return { content: [{ type: 'text', text: '工具证据' }], details: {} }; },
    } as any;
    const host = PiTaskHost.create(`integration-${crypto.randomUUID()}`, {
      streamFn,
      convertToLlm: messages => messages as any,
      toolExecution: 'sequential',
      initialState: { systemPrompt: 'test', model: {} as any, thinkingLevel: 'off', tools: [tool], messages: [userMessage('ORIGINAL')] },
      transformContext: async messages => {
        compactions++;
        commitWorkingContext(agent, messages, [userMessage(`COMPACTED-${compactions}`)]);
        return messages;
      },
    });
    agent = host.agent;
    agent.subscribe(event => {
      if (event.type === 'message_end') rawEvents.push(event.message);
    });

    await host.prompt('FIRST');
    const unsubscribe = host.subscribe(() => {});
    unsubscribe();
    await host.prompt('SECOND');
    await host.prompt('THIRD');

    expect(compactions).toBeGreaterThanOrEqual(3);
    expect(toolCalls).toBe(1);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.every(request => request.some(text => text.startsWith('COMPACTED-')))).toBe(true);
    expect(rawEvents.map(messageText)).toContain('FIRST');
    expect(rawEvents.some(message => (message as any).role === 'toolResult')).toBe(true);
    const savedMessages = [...host.agent.state.messages];
    const savedSnapshot = host.snapshot();
    expect(savedSnapshot.messages).toEqual(savedMessages);

    const restoredRequests: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const restored = PiTaskHost.create(`restore-${crypto.randomUUID()}`, {
      streamFn: async (_model: any, context: any) => {
        restoredRequests.push(context.messages.map(messageText));
        await gate;
        return streamFor(response('恢复完成'));
      },
      convertToLlm: messages => messages as any,
      initialState: { systemPrompt: 'test', model: {} as any, thinkingLevel: 'off', messages: savedMessages },
      transformContext: async messages => messages,
    }, undefined, 88);
    const oldUpdates: string[] = [];
    const oldStop = restored.subscribe(snapshot => oldUpdates.push(snapshot.status));
    const running = restored.prompt('RESTORED');
    await new Promise(resolve => setTimeout(resolve, 0));
    oldStop();
    const rebuiltUpdates: string[] = [];
    const rebuiltStop = restored.subscribe(snapshot => rebuiltUpdates.push(snapshot.status));
    release();
    await running;
    expect(oldUpdates).toContain('running');
    expect(PiTaskHost.forSession(88)).toBe(restored);
    expect(restoredRequests.at(-1)).toContain('RESTORED');
    expect(restored.agent.state.messages.map(messageText)).toContain('恢复完成');
    expect(rebuiltUpdates).toContain('running');
    expect(rebuiltUpdates).toContain('completed');
    rebuiltStop();
    expect(PiTaskHost.forSession(88)).toBeUndefined();
  });
});
