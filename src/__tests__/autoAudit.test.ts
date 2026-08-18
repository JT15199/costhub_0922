import { describe, it, expect } from 'vitest';
import { ruleFindings, computeAuditFingerprint, AUDIT_PERSPECTIVES, isDuplicateFinding, normalizeFindingTitle } from '../autoAudit';

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


describe('computeAuditFingerprint — 防重复思考指纹', () => {
  const projects = [{ id: 1, code: 'P1' }];
  const boms = { 1: [{ part_cost: 100, quantity: 2 }] };
  const sup = { 10: [{}] };
  const skus: any[] = [];
  const insights: any[] = [];

  it('相同数据 → 指纹相同（AI 跳过依据）', () => {
    const a = computeAuditFingerprint(projects, boms, sup, skus, insights, []);
    const b = computeAuditFingerprint(projects, boms, sup, skus, insights, []);
    expect(a).toBe(b);
  });

  it('改价后 → 指纹变化（触发重新思考）', () => {
    const a = computeAuditFingerprint(projects, boms, sup, skus, insights, []);
    const b = computeAuditFingerprint(projects, boms, sup, skus, insights, [{ id: 9, old_cost: 100, new_cost: 105 }]);
    expect(a).not.toBe(b);
  });

  it('新增项目 → 指纹变化', () => {
    const a = computeAuditFingerprint(projects, boms, sup, skus, insights, []);
    const b = computeAuditFingerprint([...projects, { id: 2, code: 'P2' }], { ...boms, 2: [] }, sup, skus, insights, []);
    expect(a).not.toBe(b);
  });
});

describe('isDuplicateFinding — AI 发现语义去重（2026-08-18：重复就不要报了）', () => {
  it('完全一致 → 重复', () => {
    expect(isDuplicateFinding('MNT-3201「驱动板」成本高于同类项目均值 99%', [{ title: 'MNT-3201「驱动板」成本高于同类项目均值 99%' }])).toBe(true);
  });

  it('数字不同但归一化一致 → 重复', () => {
    expect(isDuplicateFinding('MNT-3201「驱动板」成本高于均值 98%', [{ title: 'MNT-3201「驱动板」成本高于均值 99%' }])).toBe(true);
  });

  it('AI 换说法提到同一「实体」模块 → 重复', () => {
    expect(isDuplicateFinding('驱动板模块价格严重偏离市场均值', [{ title: 'MNT-3201「驱动板」成本高于同类项目均值 99%', detail: '该模块 ¥500 vs 其他项目均值 ¥300' }])).toBe(true);
  });

  it('4-gram 交叉包含（缺失目标 vs 未设定目标）→ 重复', () => {
    expect(isDuplicateFinding('多个在研项目缺失目标成本设定', [{ title: 'MNT-2401 未设定目标成本' }])).toBe(true);
  });

  it('完全不同 → 不重复', () => {
    expect(isDuplicateFinding('面板模块集中度过高，需引入二供或重新议价', [{ title: 'SKU P1-HIGH 较基座 +61%' }])).toBe(false);
  });

  it('归一化去掉金额/百分号/标点', () => {
    expect(normalizeFindingTitle('该模块 ¥1,200.50 成本 +79%（结构件）')).toBe('该模块成本结构件');
  });
});

describe('normalizeStableTitle 稳定键 — 已读条目不再反复弹出', () => {
  // 直接验证 auditStore 稳定键逻辑（通过 replaceAuditFindings 的 observable 行为测试太重，
  // 这里验证 autoAudit 侧的归一化一致性 + 实体去重已覆盖主要场景）
  it('AI 发现标题数字微变 → 归一化一致（稳定键命中，保持已读）', () => {
    const a = normalizeFindingTitle('MNT-3201「驱动板」成本高于同类项目均值 99%');
    const b = normalizeFindingTitle('MNT-3201「驱动板」成本高于同类项目均值 98%');
    expect(a).toBe(b);
  });
  it('AI 发现与已读条目语义重复 → 去重拦截（不产生新 unread）', () => {
    expect(isDuplicateFinding('驱动板模块价格严重偏离市场均值', [{ title: 'MNT-3201「驱动板」成本高于同类项目均值 99%' }])).toBe(true);
  });
});

describe('AUDIT_PERSPECTIVES — 思考角度池', () => {
  it('5 个角度且不重复', () => {
    expect(AUDIT_PERSPECTIVES.length).toBe(5);
    const names = new Set(AUDIT_PERSPECTIVES.map(p => p.name));
    expect(names.size).toBe(5);
  });
  it('每个角度有 focus 指引', () => {
    AUDIT_PERSPECTIVES.forEach(p => {
      expect(p.focus.length).toBeGreaterThan(10);
    });
  });
});
