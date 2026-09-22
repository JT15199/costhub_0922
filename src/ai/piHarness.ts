import { Agent, type AgentEvent, type AgentMessage, type AgentOptions } from '@earendil-works/pi-agent-core';
import type { ImageContent } from '@earendil-works/pi-ai';

export type PiTaskStatus = 'idle' | 'running' | 'completed' | 'aborted' | 'failed';
export type PiTaskSnapshot = { taskId: string; status: PiTaskStatus; messages: AgentMessage[]; error?: string };
type PiTaskListener = (snapshot: PiTaskSnapshot) => void;

const tasks = new Map<string, PiTaskHost>();
const sessionTasks = new Map<number, string>();

/** Renderer-lifetime task host. React may unsubscribe; the task and Agent remain alive. */
export class PiTaskHost {
  readonly agent: Agent;
  readonly taskId: string;
  status: PiTaskStatus = 'idle';
  private error?: string;
  private run?: Promise<void>;
  private leases = 0;
  private abortRequested = false;
  private readonly signal?: AbortSignal;
  private readonly listeners = new Set<PiTaskListener>();

  static create(taskId: string, options: AgentOptions, signal?: AbortSignal, sessionId?: number): PiTaskHost {
    const existing = tasks.get(taskId);
    if (existing) { if (sessionId !== undefined) sessionTasks.set(sessionId, taskId); return existing; }
    const host = new PiTaskHost(taskId, options, signal);
    tasks.set(taskId, host);
    if (sessionId !== undefined) sessionTasks.set(sessionId, taskId);
    return host;
  }

  static get(taskId: string): PiTaskHost | undefined { return tasks.get(taskId); }
  static forSession(sessionId: number): PiTaskHost | undefined { const taskId = sessionTasks.get(sessionId); return taskId ? tasks.get(taskId) : undefined; }

  private constructor(taskId: string, options: AgentOptions, signal?: AbortSignal) {
    this.taskId = taskId;
    this.signal = signal;
    this.agent = new Agent(options);
    signal?.addEventListener('abort', () => this.abort(), { once: true });
    this.agent.subscribe((event: AgentEvent) => {
      if (event.type === 'agent_end') this.emit();
    });
  }

  subscribe(listener: PiTaskListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); this.releaseIfIdle(); };
  }

  snapshot(): PiTaskSnapshot {
    return { taskId: this.taskId, status: this.status, messages: [...this.agent.state.messages], ...(this.error ? { error: this.error } : {}) };
  }

  prompt(input: string | AgentMessage, images?: ImageContent[]): Promise<void> {
    if (this.run) return this.run;
    this.status = 'running';
    this.error = undefined;
    this.abortRequested = this.signal?.aborted || false;
    this.emit();
    this.run = (typeof input === 'string' ? this.agent.prompt(input, images) : this.agent.prompt(input))
      .then(() => {
        const last = [...this.agent.state.messages].reverse().find((message: any) => message.role === 'assistant') as any;
        if (last?.stopReason === 'error' || last?.errorMessage) {
          this.status = 'failed';
          this.error = String(last.errorMessage || '模型调用失败');
          throw new Error(this.error);
        }
        if (this.abortRequested || last?.stopReason === 'aborted') {
          this.status = 'aborted';
          throw new Error(String(last?.errorMessage || '任务已取消'));
        }
        this.status = 'completed';
      })
      .catch(error => { this.status = this.abortRequested ? 'aborted' : 'failed'; this.error = String(error); throw error; })
      .finally(() => { this.run = undefined; this.emit(); this.releaseIfIdle(); });
    return this.run;
  }

  steer(message: AgentMessage): void { this.agent.steer(message); }
  followUp(message: AgentMessage): void { this.agent.followUp(message); }
  abort(): void { this.abortRequested = true; this.agent.abort(); }
  waitForIdle(): Promise<void> { return this.agent.waitForIdle(); }
  retain(): void { this.leases++; }
  release(): void { this.leases = Math.max(0, this.leases - 1); this.releaseIfIdle(); }

  private emit(): void { const snapshot = this.snapshot(); this.listeners.forEach(listener => listener(snapshot)); }
  private releaseIfIdle(): void {
    if (this.run || this.leases || this.listeners.size) return;
    if (tasks.get(this.taskId) === this) tasks.delete(this.taskId);
    for (const [sessionId, taskId] of sessionTasks) if (taskId === this.taskId) sessionTasks.delete(sessionId);
  }
}
