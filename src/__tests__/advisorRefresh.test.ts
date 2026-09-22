import { expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ select: vi.fn(async () => [{ id: 7, status: 'dismissed', evidence_fingerprint: 'same' }]), execute: vi.fn(async (_sql: string, _values: unknown[]) => ({})) }));
vi.mock('../db/core', () => ({ getDb: async () => db }));
import { upsertAdvisorInsight } from '../db/advisor';
import { buildQuoteReviewPrompt, parseQuoteReview } from '../quoteReview';

it('unchanged scans preserve analysis, feedback and dismissal instead of rewriting fixed advice', async () => {
  const result = await upsertAdvisorInsight({ insight_type: 'risk', title: 'old rule', fingerprint: 'same' });
  expect(result).toMatchObject({ created: false, reopened: false });
  const sql = String(db.execute.mock.calls[0]?.[0]);
  expect(sql).toContain('last_seen_at');
  expect(sql).not.toMatch(/detail=|status=|prompt=|title=/);
});

it('unknown pricing evidence cannot become a reasonable-price verdict', () => {
  expect(parseQuoteReview('{"items":[{"item":"面板","verdict":"unknown"}]}')[0].verdict).toBe('unknown');
  expect(parseQuoteReview('{"items":[{"item":"面板"}]}')[0].verdict).toBe('unknown');
  expect(buildQuoteReviewPrompt('面板 100', '').user).toContain('暂无参考证据');
});

