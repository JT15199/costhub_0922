import { describe, it, expect } from 'vitest';
import { identifyKeyMaterials, aggregateMaterials, buildInsightPlan, parseInsightTime, type KeyMaterial } from '../autoInsight';

// 构造 BOM：name/cost/quantity 快照列
const mkBom = (partId: number, name: string, cost: number, qty: number, cat = '硬件类', model = '') => ({
  id: partId, part_id: partId, part_name: name, part_model: model, part_cost: cost, main_category: cat, quantity: qty, is_deleted: 0,
});

describe('identifyKeyMaterials — 帕累托识别', () => {
  it('累计占比达 80% 即截断（至少 2 个）', () => {
    const projects = [{ id: 1, code: 'M270' }];
    const boms = [
      mkBom(1, '面板', 450, 1),   // 45%
      mkBom(2, '驱动板', 120, 1), // 12%
      mkBom(3, '电源', 60, 1),    // 6%
      mkBom(4, '结构件', 80, 1),  // 8%
      mkBom(5, '包装', 30, 1),    // 3%
      mkBom(6, '线材', 260, 1),   // 26%  → 前3累计 83%
    ]; // 总 1000：450+260+120=830 → 83%
    const out = identifyKeyMaterials(projects, { 1: boms });
    expect(out.length).toBe(3);
    expect(out[0].name).toBe('面板');
    expect(out[2].name).toBe('驱动板');
    expect(out[0].ratio).toBeCloseTo(0.45, 5);
  });

  it('占比分散时最多取 top5', () => {
    const projects = [{ id: 1, code: 'P1' }];
    const boms = [1,2,3,4,5,6,7].map(i => mkBom(i, '料' + i, 100, 1)); // 各 14.3%
    const out = identifyKeyMaterials(projects, { 1: boms });
    expect(out.length).toBe(5);
  });

  it('数量为 0 的占位物料跳过', () => {
    const projects = [{ id: 1, code: 'P1' }];
    const boms = [mkBom(1, '面板', 450, 1), mkBom(2, '占位料', 999, 0)];
    const out = identifyKeyMaterials(projects, { 1: boms });
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('面板');
  });

  it('软删行跳过；总成本为 0 的项目跳过', () => {
    const projects = [{ id: 1, code: 'P1' }, { id: 2, code: 'P2' }];
    const boms1 = [mkBom(1, 'A', 10, 1), { ...mkBom(2, 'B', 5, 1), is_deleted: 1 }];
    const out = identifyKeyMaterials(projects, { 1: boms1, 2: [] });
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('A');
  });
});

describe('aggregateMaterials — 跨项目聚合', () => {
  const mats: KeyMaterial[] = [
    { projectId: 1, projectCode: 'M270', partId: 1, name: '面板', model: 'M27', category: '硬件类', unitCost: 450, quantity: 1, subtotal: 450, ratio: 0.5 },
    { projectId: 2, projectCode: 'M320', partId: 1, name: '面板', model: 'M27', category: '硬件类', unitCost: 450, quantity: 1, subtotal: 450, ratio: 0.4 },
    { projectId: 1, projectCode: 'M270', partId: 2, name: '电源', model: '', category: '电源类', unitCost: 60, quantity: 1, subtotal: 60, ratio: 0.1 },
  ];
  it('同名同品类跨项目合并为一条', () => {
    const agg = aggregateMaterials(mats);
    expect(agg.length).toBe(2);
    const panel = agg.find(a => a.name === '面板')!;
    expect(panel.projects.length).toBe(2);
    expect(panel.totalSubtotal).toBe(900);
    expect(agg[0].name).toBe('面板'); // 按总额排序
  });
  it('不同品类不合并（materialKey 含品类）', () => {
    const a = aggregateMaterials([mats[0], mats[2]]);
    expect(a.length).toBe(2);
  });
});

describe('buildInsightPlan — 四道闸门', () => {
  const agg = { key: '面板|硬件类', name: '面板', model: '', category: '硬件类', projects: [{ projectId: 1, projectCode: 'M270', ratio: 0.5, subtotal: 450 }], totalSubtotal: 450 };
  const now = new Date('2026-08-16T08:00:00');
  const daysAgo = (d: number) => {
    const t = new Date(now.getTime() - d * 86400000);
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') + ' 08:00';
  };

  it('无记录 → 首次立即洞察', () => {
    const plan = buildInsightPlan([agg], {}, { now });
    expect(plan[0].action).toBe('insight');
    expect(plan[0].reason).toContain('首次');
  });

  it('3 天前洞察 → 复用（7 天内）', () => {
    const plan = buildInsightPlan([agg], { '面板|硬件类': { time: daysAgo(3), direction: '上涨' } }, { now });
    expect(plan[0].action).toBe('reuse');
    expect(plan[0].lastDirection).toBe('上涨');
  });

  it('20 天前 → 等待（30 天周期内），带下次时间', () => {
    const plan = buildInsightPlan([agg], { '面板|硬件类': { time: daysAgo(20) } }, { now });
    expect(plan[0].action).toBe('wait');
    expect(plan[0].nextAt).toBeDefined();
    expect(plan[0].reason).toContain('天后');
  });

  it('40 天前 → 触发洞察', () => {
    const plan = buildInsightPlan([agg], { '面板|硬件类': { time: daysAgo(40) } }, { now });
    expect(plan[0].action).toBe('insight');
  });

  it('预算为 0 → 等待（即使已到周期）', () => {
    const plan = buildInsightPlan([agg], {}, { now, budgetLeft: 0 });
    expect(plan[0].action).toBe('wait');
    expect(plan[0].reason).toContain('预算');
  });

  it('自定义周期参数生效', () => {
    const plan = buildInsightPlan([agg], { '面板|硬件类': { time: daysAgo(10) } }, { now, intervalDays: 14, reuseDays: 7 });
    expect(plan[0].action).toBe('wait'); // 10 < 14
    const plan2 = buildInsightPlan([agg], { '面板|硬件类': { time: daysAgo(10) } }, { now, intervalDays: 7, reuseDays: 3 });
    expect(plan2[0].action).toBe('insight'); // 10 > 7
  });
});

describe('parseInsightTime — 时间解析兼容', () => {
  it('本地格式（带空格）与 ISO 均可解析', () => {
    expect(parseInsightTime('2026-08-14 10:00')).not.toBeNull();
    expect(parseInsightTime('2026-08-14T10:00:00')).not.toBeNull();
    expect(parseInsightTime('')).toBeNull();
    expect(parseInsightTime(undefined)).toBeNull();
  });
});