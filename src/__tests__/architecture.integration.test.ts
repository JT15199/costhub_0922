import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  bom: [{ id: 1, part_id: 7, part_name: '屏', part_model: 'M1', part_specs: '', module_name: '屏', main_category: '硬件类', quantity: 1, part_cost: 100, line_total: 100 }],
  executed: [] as string[],
}));

vi.mock('../db/projects', () => ({ getProjectBOMs: vi.fn(async () => state.bom) }));
vi.mock('../db/core', () => ({
  localNow: () => '2026-09-04 12:00:00',
  getDb: vi.fn(async () => ({
    select: vi.fn(async (sql: string) => {
      if (sql.includes('category_name, field_key')) return [];
      if (sql.includes('platform_fee_rate')) return [{ platform_fee_rate: 0 }];
      if (sql.includes('cost_baseline_decisions')) return [{ project_id: 0, baseline_type: 'material', category: '硬件类', scope_key: 'part:7', value: 80 }];
      if (sql.includes('project_target_versions')) return [];
      if (sql.includes('project_change_packages')) return [
        { package_id: 4, package_status: 'confirmed', module_name: '屏', cost_before: 20, cost_after: 10, source_version_id: 1, source_line_id: 11, evidence_json: '{"sourceVersionId":1,"sourceLineId":11}', dependency_role: 'required' },
        { package_id: 4, package_status: 'confirmed', module_name: '屏', cost_before: 5, cost_after: 10, source_version_id: 1, source_line_id: 12, evidence_json: '{"sourceVersionId":1,"sourceLineId":12}', dependency_role: 'required' },
      ];
      return [];
    }),
    execute: vi.fn(async (sql: string) => { state.executed.push(sql); return { lastInsertId: sql.includes('project_target_versions') ? 9 : 0 }; }),
  })),
}));

describe('createProjectTargetVersion integration', () => {
  beforeEach(() => { state.executed.length = 0; });

  it('uses only confirmed uncounted package opportunity and keeps the remaining gap', async () => {
    const { createProjectTargetVersion } = await import('../db/architecture');
    const result = await createProjectTargetVersion(3, 70, 0, { bom: 1 });
    expect(result.rows[0]).toMatchObject({ baseline: 80, opportunity: 5, allocated: 5, target: 75 });
    expect(result.confirmedOpportunity).toBe(5);
    expect(result.uncoveredGap).toBe(5);
    expect(state.executed).toContain('BEGIN');
    expect(state.executed).toContain('COMMIT');
  });
});
