import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  getProjects: async () => [{ id: 1, code: 'M270', name: '测试项目', project_type: '在研', tier: '主流级', status: '进行中', is_deleted: 0, created_at: '2026-09-01 10:00:00' }],
  getProjectBOMs: async () => [
    { id: 7, project_id: 1, module_name: '电源', part_name: '电源板', part_model: 'P-1', part_cost: 10, quantity: 2, main_category: '电源类', is_deleted: 0 },
    { id: 8, project_id: 1, module_name: '结构', part_name: '底座', part_model: 'S-1', part_cost: 5, quantity: 1, main_category: '结构类', is_deleted: 0 },
  ],
  getTargets: async () => [],
  getProjectCostSnapshots: async () => [],
  getTenderOverview: async () => ({}),
  getTenderMatrix: async () => [],
  localNow: () => '2026-09-01 12:00:00',
}));

import { executeStructuredTool } from '../ai/toolRegistry';

describe('首批结构化工具适配器', () => {
  it('金额与证据引用来自同一份 BOM 结果', async () => {
    const result = await executeStructuredTool({ name: 'query_project_bom', args: { project_code: 'M270' } });
    const data = result.data as { total: number; rows: Array<{ bomId: number; extendedCost: number }> };
    expect(result.ok).toBe(true);
    expect(data.total).toBe(25);
    expect(data.rows[0].extendedCost).toBe(20);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ refType: 'project', field: 'bom_cost', value: 25 }),
      expect.objectContaining({ refType: 'bom', refId: 7, field: 'extended_cost', value: 20 }),
    ]));
  });
});
