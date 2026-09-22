import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';

/** Commit a compaction to both the live loop array and persisted Agent state. */
export function commitWorkingContext(agent: Pick<Agent, 'state'>, current: AgentMessage[], next: AgentMessage[]): AgentMessage[] {
  if (current === next) return current;
  current.splice(0, current.length, ...next);
  agent.state.messages = current;
  return current;
}
