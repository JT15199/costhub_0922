import { describe, it, expect } from 'vitest';
import { computeModuleCosts, buildTargetAllocation } from './targetAllocation';

describe('computeModuleCosts', () => {
  it('BOM 按模块聚合成本（成本×数量），跳过已删除', () => {
    const m = computeModuleCosts([
      { module_name: '大结构', part_cost: 10, quantity: 2 },
      { module_name: '大结构', part_cost: 5, quantity: 1 },
      { module_name: '多媒体', part_cost: 100, quantity: 1 },
      { module_name: '包装', part_cost: 999, quantity: 1, is_deleted: 1 },
      { part_cost: 3, quantity: 1 },
    ]);
    expect(m['大结构']).toBe(25);
    expect(m['多媒体']).toBe(100);
    expect(m['包装']).toBeUndefined();
    expect(m['未归类']).toBe(3);
  });
});

describe('buildTargetAllocation', () => {
  const moduleCosts = { 大结构: 100, 多媒体: 300 };
  const sps = [
    { id: 1, name: '轻量化', positive: 700, negative: 100 },
    { id: 2, name: '高刷', positive: 900, negative: 100 },
  ];
  const spModules = { 1: ['大结构'], 2: ['多媒体'] };

  it('老特性按声量分配，Σ = 目标总成本（对账归零）', () => {
    const r = buildTargetAllocation({ targetTotal: 400, moduleCosts, sps, spModules });
    expect(r.allocatedSum).toBe(400);
    expect(r.diff).toBe(0);
    // 价值密度 = 声量 ÷ 成本占比：大结构(800/0.25=3200) > 多媒体(1000/0.75=1333) → 大结构分得多（声量少但成本占比低=密度高，加投）
    const struc = r.domains.find(d => d.name === '大结构')!;
    const multi = r.domains.find(d => d.name === '多媒体')!;
    expect(struc.targetCost).toBeGreaterThan(multi.targetCost);
    expect(struc.density).toBeGreaterThan(multi.density);
    // 特性级：声量占比
    const f = multi.features.find(f => f.name === '高刷')!;
    expect(f.voice).toBe(1000);
    expect(f.prevCost).toBe(300);
  });

  it('新特性预算从目标扣除并并入所属模块', () => {
    const sps2 = [...sps, { id: 3, name: 'AI 调光', positive: 0, negative: 0, isNew: true }];
    const spModules2 = { ...spModules, 3: ['多媒体'] };
    const r = buildTargetAllocation({ targetTotal: 400, moduleCosts, sps: sps2, spModules: spModules2, newFeatureBudgets: { 'AI 调光': 30 } });
    const nf = r.newFeatures.find(f => f.name === 'AI 调光')!;
    expect(nf.targetCost).toBe(30);
    // 老特性自动分配总额 = 400 − 30 = 370
    const oldSum = r.domains.reduce((s, d) => s + d.features.filter(f => !f.isNew).reduce((a, f) => a + f.targetCost, 0), 0);
    expect(Math.round(oldSum)).toBe(370);
    // 新特性并入多媒体领域
    const multi = r.domains.find(d => d.name === '多媒体')!;
    expect(multi.features.some(f => f.isNew && f.name === 'AI 调光')).toBe(true);
    // 对账仍归零
    expect(r.allocatedSum).toBe(400);
    expect(r.diff).toBe(0);
  });

  it('全无声量（无卖点数据）→ 按模块均分兜底，Σ 仍对账', () => {
    const r = buildTargetAllocation({ targetTotal: 200, moduleCosts: { A: 10, B: 20 }, sps: [], spModules: {} });
    expect(r.allocatedSum).toBe(200);
    expect(r.diff).toBe(0);
    expect(r.domains.length).toBe(2);
  });

  it('空模块成本 → 空结果不报错', () => {
    const r = buildTargetAllocation({ targetTotal: 0, moduleCosts: {}, sps: [], spModules: {} });
    expect(r.domains).toEqual([]);
    expect(r.allocatedSum).toBe(0);
  });
});