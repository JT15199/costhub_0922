import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getProjects: vi.fn(async () => []),
  getProjectBOMVersions: vi.fn(async () => []),
  getProjectTargetVersions: vi.fn(async () => []),
  getProjectBOMs: vi.fn(async () => []),
  getTargets: vi.fn(async () => []),
  getMeasures: vi.fn(async () => [{ measure: '新措施', status: '进行中', owner: '采购', forecast_saving: 12 }]),
  getCostReviews: vi.fn(async () => [{ stage: 'PDCP', reviewed_cost: 88, remark: '新评审' }]),
  getProjectCostSnapshots: vi.fn(async () => []),
  getTenderOverview: vi.fn(async () => null),
  getTenderDecision: vi.fn(async () => null),
  getProjectSpecProfile: vi.fn(async () => []),
  getLatestProjectSpecBaseline: vi.fn(async () => null),
  getSkus: vi.fn(async () => []),
  getAllSkuDiffs: vi.fn(async () => ({})),
  getChangePackages: vi.fn(async () => []),
}));

vi.mock('../db', () => db);

describe('stage cost package source chain', () => {
  it('does not export stale props when the live BOM is empty and uses freshly read measures/reviews', async () => {
    const { loadSnapshot } = await import('../components/CostPackageButton');
    const snapshot = await loadSnapshot(
      { id: 3, code: 'P-03', name: '当前项目', category: '显示器', platform_fee_rate: 2 },
      [{ part_name: '旧缓存器件', part_cost: 30, quantity: 1 }],
      [],
      [{ measure: '旧缓存措施' }],
      [{ stage: '旧缓存阶段', reviewed_cost: 30 }],
      [],
    );

    expect(snapshot.bomCost).toBeNull();
    const points = snapshot.slides.flatMap(slide => slide.points);
    expect(points.some(point => point.includes('新措施'))).toBe(true);
    expect(points.some(point => point.includes('新评审'))).toBe(true);
    expect(points.some(point => point.includes('旧缓存'))).toBe(false);
    expect(snapshot.warnings.some(warning => warning.includes('读取失败'))).toBe(false);
  });
});
