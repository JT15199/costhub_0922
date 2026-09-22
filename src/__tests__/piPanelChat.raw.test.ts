import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ events: [] as any[] }));
vi.mock('../db', () => ({
  getDb: async () => ({
    execute: async (sql: string, args: any[]) => {
      if (sql.includes('INSERT OR IGNORE INTO local_ai_session_events')) {
        if (!store.events.some(event => event.event_id === args[1])) store.events.push({ id: store.events.length + 1, session_id: args[0], event_id: args[1], run_id: args[2], seq: args[3], event_type: args[4], payload_json: args[5], created_at: 'now' });
      }
      return { lastInsertId: store.events.at(-1)?.id };
    },
    select: async (sql: string, args: any[]) => {
      if (sql.startsWith('SELECT id FROM local_ai_session_events')) return store.events.filter(event => event.event_id === args[0]).map(event => ({ id: event.id }));
      if (sql.includes("SELECT * FROM local_ai_session_events WHERE session_id=? AND (event_type LIKE 'gateway_%' OR event_type='checkpoint')")) {
        const hasRun = sql.includes('AND run_id=?');
        const hasBefore = sql.includes('AND id<?');
        const limit = Number(args[args.length - 1]);
        let rows = store.events.filter(event => event.session_id === args[0] && (event.event_type.startsWith('gateway_') || event.event_type === 'checkpoint'));
        let cursor = 1;
        if (hasRun) { const runId = args[cursor++]; rows = rows.filter(event => event.run_id === runId); }
        if (hasBefore) { const before = Number(args[cursor++]); rows = rows.filter(event => event.id < before); }
        return rows.sort((a, b) => b.id - a.id).slice(0, limit);
      }
      if (sql.includes('SELECT payload_json FROM local_ai_session_events WHERE session_id=? AND event_type=? ORDER BY id')) {
        return store.events.filter(event => event.session_id === args[0] && event.event_type === args[1]).sort((a, b) => a.id - b.id);
      }
      if (sql.includes('SELECT id, event_type, payload_json')) return store.events.filter(event => event.session_id === args[0]);
      if (sql.includes('SELECT id, role, content, created_at')) return [];
      if (sql.includes('SELECT pi_state_json')) return [{ pi_state_json: '' }];
      return [];
    },
  }),
}));

import { appendPiMessage, loadGatewayTraceEvents, loadPiSourceMessages, readSessionEvidence, searchSessionHistory } from '../aiPanelChat';

describe('生产 Pi 原始消息持久化路径', () => {
  it('追加完整工具消息后可通过生产 history search/read 找回唯一证据', async () => {
    const message = { role: 'toolResult', toolCallId: 'call-1', toolName: 'query_project_bom', content: [{ type: 'text', text: 'RAW-UNIQUE-EVIDENCE-20260912' }], details: { rows: [1, 2] } };
    const saved = await appendPiMessage(7, 'run-1', 1, message);
    expect(saved?.id).toBe(1);

    const found = await searchSessionHistory(7, 'RAW-UNIQUE-EVIDENCE-20260912');
    expect(found.matches[0]).toMatchObject({ reference: 'event:1', eventType: 'message_raw' });
    const evidence = await readSessionEvidence(7, found.matches[0].reference);
    expect(evidence.ok).toBe(true);
    expect(JSON.parse(evidence.row.payload_json).message).toEqual(message);
  });

  it('Gateway 回放按游标分页，不受固定 500 条会话窗口影响', async () => {
    store.events = Array.from({ length: 405 }, (_, index) => ({
      id: index + 1, session_id: 9, event_id: `run-page:${index}`, run_id: 'run-page', seq: index,
      event_type: 'gateway_network_request', payload_json: '{}', created_at: 'now',
    }));
    const first = await loadGatewayTraceEvents(9, 'run-page', undefined, 200);
    const second = await loadGatewayTraceEvents(9, 'run-page', first.at(-1)?.id, 200);
    const third = await loadGatewayTraceEvents(9, 'run-page', second.at(-1)?.id, 200);
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(200);
    expect(third).toHaveLength(5);
    expect(new Set([...first, ...second, ...third].map(row => row.id)).size).toBe(405);
  });

  it('来源查找覆盖当前会话的所有运行，而不是只查所选运行', async () => {
    store.events = [{
      id: 1, session_id: 10, event_id: 'raw-1', run_id: 'run-1', seq: 1, event_type: 'message_raw',
      payload_json: JSON.stringify({ message: { id: 'run-1:prompt:1', role: 'user', content: [{ type: 'text', text: '已确认事实' }] } }), created_at: 'now',
    }];

    const found = await loadPiSourceMessages(10, 'run-1:prompt:1');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'run-1:prompt:1', role: 'user' });
  });
});
