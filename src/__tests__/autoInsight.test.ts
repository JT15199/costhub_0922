import { describe, it, expect } from 'vitest';
import { identifyKeyMaterials, aggregateMaterials, buildInsightPlan, parseInsightTime, type KeyMaterial } from '../autoInsight';

// 构造 BOM：sub_category/name/cost/quantity 快照列
const mkBom = (partId: number, name: string, cost: number, qty: number, sub = '', model = '', cat = '硬件类') => ({
  id: partId, part_id: partId, part_name: name, part_model: model, part_cost: cost,
  main_category: cat, sub_category: sub, quantity: qty, is_deleted: 0,
});

describe('identifyKeyMaterials — 按子类帕累托识别', () => {
  it('同一子类多型号合并后按占比截断（≥80%，至少 2 组）', () => {
    const projects = [{ id: 1, code: 'M270' }];
    const boms = [
      mkBom(1, '面板A', 450, 1, '液晶面板', 'M27A'),  // 45%
      mkBom(2, '面板B', 260, 1, '液晶面板', 'M27B'),  // 26% → 面板组 71%
      mkBom(3, '驱动板', 120, 1, '驱动板'),           // 12% → 前2组 83%
      mkBom(4, '电源', 60, 1, '电源适配器'),
      mkBom(5, '结构件', 80, 1, '结构件'),
      mkBom(6, '包装', 30, 1, '包装'),
    ]; // 总 1000
    const out = identifyKeyMaterials(projects, { 1: boms });
    expect(out.length).toBe(2);
    expect(out[0].name).toBe('液晶面板');
    expect(out[0].subtotal).toBe(710);
    expect(out[0].models).toEqual(['M27A', 'M27B']);
    expect(out[0].ratio).toBeCloseTo(0.71, 5);
    expect(out[1].name).toBe('驱动板');
  });

  it('占比分散时最多取 top5 组', () => {
    const projects = [{ id: 1, code: 'P1' }];
    const boms = ['A','B','C','D','E','F','G'].map((s, i) => mkBom(i + 1, '料' + s, 100, 1, '子类' + s));
    const out = identifyKeyMaterials(projects, { 1: boms });
    expect(out.length).toBe(5);
  });

  it('sub_category 为空的行回退用物料名', () => {
    const projects = [{ id: 1, code: 'P1' }];
    const boms = [mkBom(1, '面板', 450, 1), mkBom(2, '面板', 300, 1, '液晶面板', 'M27X')];
    const out = identifyKeyMaterials(projects, { 1: boms });
    // 面板(回退名) 与 液晶面板 是两个不同组
    expect(out.some(x => x.name === '面板')).toBe(true);
    expect(out.some(x => x.name === '液晶面板')).toBe(true);
  });

  it('数量为 0 的占位物料跳过', () => {
    const projects = [{ id: 1, code: 'P1' }];
    const boms = [mkBom(1, '面板', 450, 1, '液晶面板'), mkBom(2, '占位料', 999, 0, '占位')];
    const out = identifyKeyMaterials(projects, { 1: boms });
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('液晶面板');
  });

  it('软删行跳过；总成本为 0 的项目跳过', () => {
    const projects = [{ id: 1, code: 'P1' }, { id: 2, code: 'P2' }];
    const boms1 = [mkBom(1, 'A', 10, 1, '子类A'), { ...mkBom(2, 'B', 5, 1, '子类B'), is_deleted: 1 }];
    const out = identifyKeyMaterials(projects, { 1: boms1, 2: [] });
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('子类A');
  });
});

describe('aggregateMaterials — 跨项目聚合（按子类）', () => {
  const mats: KeyMaterial[] = [
    { projectId: 1, projectCode: 'M270', name: '液晶面板', models: ['M27A'], category: '硬件类', subtotal: 710, ratio: 0.71 },
    { projectId: 2, projectCode: 'M320', name: '液晶面板', models: ['M32A', 'M27A'], category: '硬件类', subtotal: 640, ratio: 0.55 },
    { projectId: 1, projectCode: 'M270', name: '电源适配器', models: [], category: '电源类', subtotal: 60, ratio: 0.06 },
  ];
  it('同名子类跨项目合并，型号去重合并', () => {
    const agg = aggregateMaterials(mats);
    expect(agg.length).toBe(2);
    const panel = agg.find(a => a.name === '液晶面板')!;
    expect(panel.projects.length).toBe(2);
    expect(panel.totalSubtotal).toBe(1350);
    expect(panel.models).toContain('M27A');
    expect(panel.models).toContain('M32A');
    expect(agg[0].name).toBe('液晶面板');
  });
  it('不同大类下同名子类不合并（materialKey 含品类）', () => {
    const a = aggregateMaterials([
      { projectId: 1, projectCode: 'M270', name: '面板', models: [], category: '硬件类', subtotal: 100, ratio: 0.5 },
      { projectId: 2, projectCode: 'M320', name: '面板', models: [], category: '结构类', subtotal: 80, ratio: 0.4 },
    ]);
    expect(a.length).toBe(2);
  });
});

describe('buildInsightPlan — 四道闸门', () => {
  const agg = {
    key: '液晶面板|硬件类', name: '液晶面板', models: ['M27A'], category: '硬件类',
    projects: [{ projectId: 1, projectCode: 'M270', ratio: 0.71, subtotal: 710 }], totalSubtotal: 710,
  };
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
    const plan = buildInsightPlan([agg], { '液晶面板|硬件类': { time: daysAgo(3), direction: '上涨' } }, { now });
    expect(plan[0].action).toBe('reuse');
    expect(plan[0].lastDirection).toBe('上涨');
  });

  it('20 天前 → 等待（30 天周期内），带下次时间', () => {
    const plan = buildInsightPlan([agg], { '液晶面板|硬件类': { time: daysAgo(20) } }, { now });
    expect(plan[0].action).toBe('wait');
    expect(plan[0].nextAt).toBeDefined();
    expect(plan[0].reason).toContain('天后');
  });

  it('40 天前 → 触发洞察', () => {
    const plan = buildInsightPlan([agg], { '液晶面板|硬件类': { time: daysAgo(40) } }, { now });
    expect(plan[0].action).toBe('insight');
  });

  it('预算为 0 → 等待（即使已到周期）', () => {
    const plan = buildInsightPlan([agg], {}, { now, budgetLeft: 0 });
    expect(plan[0].action).toBe('wait');
    expect(plan[0].reason).toContain('预算');
  });

  it('自定义周期参数生效', () => {
    const plan = buildInsightPlan([agg], { '液晶面板|硬件类': { time: daysAgo(10) } }, { now, intervalDays: 14, reuseDays: 7 });
    expect(plan[0].action).toBe('wait');
    const plan2 = buildInsightPlan([agg], { '液晶面板|硬件类': { time: daysAgo(10) } }, { now, intervalDays: 7, reuseDays: 3 });
    expect(plan2[0].action).toBe('insight');
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