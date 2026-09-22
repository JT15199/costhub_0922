import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/settings', () => ({ getSetting: vi.fn(async (_key: string, fallback = '') => fallback), setSetting: vi.fn(async () => {}) }));
vi.mock('../db/projects', () => ({
  getProjects: vi.fn(async () => [{ id: 8, code: 'MP-01', name: '量产维护项目', project_type: '已完成', stage: '量产后降本', created_at: '2026-01-01 10:00:00' }]),
  getProjectBOMs: vi.fn(async () => [{ part_id: 1, part_name: '电源模块', part_model: 'X', part_cost: 20, quantity: 1, main_category: '电源类' }]),
  getProjectCostSnapshots: vi.fn(async () => [{ created_at: '2026-01-01 10:00:00' }]),
  getTargets: vi.fn(async () => []),
  getMeasures: vi.fn(async () => []),
}));
vi.mock('../db/parts', () => ({ getParts: vi.fn(async () => []), getAllPartSuppliers: vi.fn(async () => []) }));
vi.mock('../db/advisor', () => ({
  findAdvisorByFingerprint: vi.fn(async () => null),
  upsertAdvisorInsight: vi.fn(async () => ({ created: true, reopened: false })),
  updateAdvisorStatus: vi.fn(async () => {}),
  getAdvisorInsights: vi.fn(async () => []),
}));
vi.mock('../db/core', () => ({ getDb: vi.fn(async () => ({ select: vi.fn(async () => []) })) }));
vi.mock('../ollama', () => ({ logLocalAICall: vi.fn(async () => {}) }));
vi.mock('../ai/security', () => ({ auditPromptStrict: vi.fn(() => ({ safe: true, matches: [] })) }));
vi.mock('../db/ai', () => ({ saveRecommendation: vi.fn(async () => 1) }));

describe('runAutoAdvisor lifecycle scope', () => {
  it('includes a completed project that is still in production cost-down maintenance', async () => {
    (globalThis as any).window = { dispatchEvent: vi.fn() };
    const { runAutoAdvisor } = await import('../autoAdvisor');
    const result = await runAutoAdvisor();
    expect(result).not.toBeNull();
    expect(result?.found).toBeGreaterThan(0);
  });
});
