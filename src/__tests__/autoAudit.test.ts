import { describe, it, expect } from 'vitest';
import { ruleFindings } from '../autoAudit';

const ctx = {
  projects: [
    { id: 1, code: 'P1', project_type: '在研' },
    { id: 2, code: 'P2', project_type: '已完成' },
    { id: 3, code: 'P3', project_type: '在研' },
  ],
  targetsByProject: { 1: [{ domain: '加工费类', target_cost: 30 }] },
  bomsByProject: {
    1: [{ module_name: '显示模块', main_category: '硬件类', part_name: '面板', part_cost: 500, quantity: 1 }, { module_name: '电源模块', main_category: '电源类', part_name: '电源', part_cost: 60, quantity: 1 }],
    2: [{ module_name: '显示模块', main_category: '硬件类', part_name: '面板', part_cost: 400, quantity: 1 }],
    3: [{ module_name: '显示模块', main_category: '硬件类', part_name: '面板', part_cost: 900, quantity: 1 }],
  },
  suppliersByPart: {
    10: [{ supplier_name: 'A', price: 5, share_ratio: 60, is_active: 1 }, { supplier_name: 'B', price: 6, share_ratio: 20, is_active: 1 }],
  },
  skus: [{ id: 1, project_id: 1, sku_code: 'P1-HIGH' }],
  skuCostBySku: { 1: { cost: 900, baseCost: 560 } },
  insightsCount: 3,
};

describe('ruleFindings — 自主巡检规则层', () => {
  it('在研项目未设目标 → info', () => {
    const f = ruleFindings(ctx);
    const t = f.find(x => x.type === 'rule_no_target');
    expect(t).toBeTruthy();
    expect(t!.title).toContain('P3');
    expect(t!.level).toBe('info');
  });

  it('已完成项目无目标不报', () => {
    const f = ruleFindings(ctx);
    expect(f.some(x => x.type === 'rule_no_target' && x.title.includes('P2'))).toBe(false);
  });

  it('供应商份额合计偏离 → warn', () => {
    const f = ruleFindings(ctx);
    const t = f.find(x => x.type === 'rule_share_anomaly');
    expect(t).toBeTruthy();
    expect(t!.detail).toContain('80%');
  });

  it('单模块占比 ≥60% → warn', () => {
    const f = ruleFindings(ctx);
    // P3：900/900 = 100%
    const t = f.find(x => x.type === 'rule_module_dominance');
    expect(t).toBeTruthy();
    expect(f.some(x => x.type === 'rule_module_dominance' && x.title.includes('P3'))).toBe(true);
  });

  it('占比正常不报', () => {
    const f = ruleFindings({ ...ctx, bomsByProject: { 1: ctx.bomsByProject[1], 2: ctx.bomsByProject[2], 3: [{ module_name: '显示模块', main_category: '硬件类', part_name: '面板', part_cost: 500, quantity: 1 }, { module_name: '结构模块', main_category: '结构类', part_name: '外壳', part_cost: 400, quantity: 1 }] } });
    expect(f.some(x => x.type === 'rule_module_dominance' && x.title.includes('P3'))).toBe(false);
  });

  it('SKU 偏离基座 ≥40% → warn', () => {
    const f = ruleFindings(ctx);
    const t = f.find(x => x.type === 'rule_sku_deviation');
    expect(t).toBeTruthy();
    expect(t!.title).toContain('P1-HIGH');
  });

  it('SKU 偏离小不报', () => {
    const f = ruleFindings({ ...ctx, skuCostBySku: { 1: { cost: 600, baseCost: 560 } } });
    expect(f.some(x => x.type === 'rule_sku_deviation')).toBe(false);
  });
});
