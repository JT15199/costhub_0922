import { describe, it, expect } from 'vitest';
import { allocateModuleCosts, computeSellingPointRows, classifyKind, parseAiDimMatch, parseAiAggregate } from '../sellingPointAnalyzer';

describe('allocateModuleCosts — 模块成本分摊', () => {
  it('单卖点独占模块 → 全额', () => {
    const { bySp, shared } = allocateModuleCosts([{ spId: 1, module: '面板' }], { 面板: 520 });
    expect(bySp[1]).toBe(520);
    expect(shared).toEqual({});
  });
  it('同模块多卖点 → 均分（不重复计算）', () => {
    const { bySp, shared } = allocateModuleCosts([
      { spId: 1, module: '面板' }, { spId: 2, module: '面板' }, { spId: 3, module: '面板' },
    ], { 面板: 600 });
    expect(bySp[1]).toBe(200);
    expect(bySp[2]).toBe(200);
    expect(bySp[3]).toBe(200);
    expect(shared['面板']).toBe(3);
  });
});

describe('computeSellingPointRows — 卖点价值计算（卖点直接带声量）', () => {
  it('声量聚合 + 成本分摊', () => {
    const rows = computeSellingPointRows({
      sps: [{ id: 1, name: '高刷屏', positive: 60, negative: 15 }, { id: 2, name: '鸡肋功能', positive: 1, negative: 2 }],
      modules: { 1: ['面板'], 2: ['结构件'] },
      moduleCosts: { 面板: 500, 结构件: 100 },
    });
    const a = rows.find(r => r.id === 1)!;
    expect(a.count).toBe(75);
    expect(a.positive).toBe(60);
    expect(a.negative).toBe(15);
    expect(a.cost).toBe(500);
    const b = rows.find(r => r.id === 2)!;
    expect(b.count).toBe(3);
    expect(b.cost).toBe(100);
  });
});

describe('classifyKind — 类型判定（客观数据算，不主观）', () => {
  it('声量高+好评高=star；声量高+好评低=fix；声量低+成本高=overinvest；其余=minor', () => {
    expect(classifyKind(80, 0.8, 100, 50, 300)).toBe('star');
    expect(classifyKind(80, 0.3, 100, 50, 300)).toBe('fix');
    expect(classifyKind(10, 0.9, 500, 50, 300)).toBe('overinvest');
    expect(classifyKind(10, 0.5, 100, 50, 300)).toBe('minor');
  });
});

describe('parseAiDimMatch — AI 匹配解析', () => {
  it('标准 JSON', () => {
    const r = parseAiDimMatch('{"mappings":[{"selling_point":"高刷屏","dimensions":["刷新率","分辨率"]}]}');
    expect(r.length).toBe(1);
    expect(r[0].selling_point).toBe('高刷屏');
    expect(r[0].dimensions).toEqual(['刷新率', '分辨率']);
  });
});

describe('parseAiAggregate — AI 归纳解析', () => {
  it('标准 JSON（每条评价归到卖点+正负）', () => {
    const r = parseAiAggregate('{"items":[{"index":0,"selling_points":["高刷屏"],"sentiment":"positive"},{"index":1,"selling_points":["高刷屏","广色域"],"sentiment":"negative"}]}');
    expect(r.length).toBe(2);
    expect(r[0].selling_points).toEqual(['高刷屏']);
    expect(r[0].sentiment).toBe('positive');
    expect(r[1].selling_points).toEqual(['高刷屏', '广色域']);
    expect(r[1].sentiment).toBe('negative');
  });
});
