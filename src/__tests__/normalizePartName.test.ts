import { describe, it, expect } from 'vitest';
import { buildInsights, filterStoredInsightGroups } from '../autoCompare';
import { normalizePartName } from '../db/compare';

describe('buildInsights 已确认组过滤', () => {
  it('规则组全部行已确认 → 不再输出（确认后后台轮询不重现）', () => {
    const rows = [
      { project: 'A', name: '屏', model: 'M270', cost: 300, quantity: 1 },
      { project: 'B', name: '屏', model: 'M270', cost: 260, quantity: 1 },
      { project: 'C', name: '屏', model: 'M270', cost: 280, quantity: 1 },
    ];
    // 无确认：规则组应输出（价差 40 ≥10 且 ≥10%）
    const before = buildInsights([], rows, []);
    expect(before.some(g => g.type === 'rule')).toBe(true);
    // 全部行已确认：规则组被过滤
    const aliases = rows.map(r => ({ module_name: '', alias_name: r.name, alias_model: r.model, canonical_name: '屏', canonical_model: '', source: 'user_confirmed' }));
    const after = buildInsights([], rows, aliases);
    expect(after.some(g => g.type === 'rule')).toBe(false);
    // 部分确认（别名是另一种写法）：原组仍输出
    const partialAlias = { module_name: '', alias_name: '屏27寸', alias_model: 'M270X', canonical_name: '屏', canonical_model: '', source: 'user_confirmed' };
    const partial = buildInsights([], rows, [partialAlias]);
    expect(partial.some(g => g.type === 'rule')).toBe(true);
  });

  it('规则组标记不同 → AI 与规则均不再输出', () => {
    const rows = [
      { project: 'A', name: '屏', model: 'M270', cost: 300, quantity: 1 },
      { project: 'B', name: '屏', model: 'M270', cost: 260, quantity: 1 },
    ];
    const key = rows.map(r => `${normalizePartName(r.name)}|${normalizePartName(r.model)}`).sort().join(';');
    const aliases = [{ alias_name: `#NEG#${key}`, alias_model: '', source: 'marked_different' }];
    expect(buildInsights([], rows, aliases)).toEqual([]);
  });
});

describe('历史情报按已处理记录过滤', () => {
  it('已确认/逐行排除后，存量情报不再把已处理行显示为待处理', () => {
    const groups = [{ name: '屏', rows: [
      { name: '屏A', model: 'M1', cost: 300 },
      { name: '屏B', model: 'M2', cost: 260 },
      { name: '屏C', model: 'M3', cost: 280 },
    ], diff: 40 }];
    const aliases = [
      { alias_name: '屏A', alias_model: 'M1', source: 'user_confirmed' },
      { alias_name: '#ROWDIFF#屏b|m2', alias_model: '', source: 'marked_different' },
    ];
    expect(filterStoredInsightGroups(groups, aliases)).toEqual([]);
    expect(filterStoredInsightGroups(groups, [{ alias_name: '屏A', alias_model: 'M1', source: 'user_confirmed' }])[0].rows).toHaveLength(2);
  });
});

describe('normalizePartName — 报价比对名称归一化', () => {
  it('全角转半角 + 小写', () => {
    expect(normalizePartName('ＤＲＶ－１００')).toBe('drv100');
  });

  it('去空格/横线/下划线/斜杠', () => {
    expect(normalizePartName('DRV-100')).toBe('drv100');
    expect(normalizePartName('DRV 100')).toBe('drv100');
    expect(normalizePartName('DRV_100')).toBe('drv100');
    expect(normalizePartName('DRV/100')).toBe('drv100');
  });

  it('不同写法归一后相等（疑似同一物料）', () => {
    expect(normalizePartName('M270 面板')).toBe(normalizePartName('M270面板'));
    expect(normalizePartName('ＬＣＤ ２７寸')).toBe(normalizePartName('lcd27寸'));
  });

  it('空值容错', () => {
    expect(normalizePartName('')).toBe('');
    expect(normalizePartName(undefined as any)).toBe('');
  });
});
