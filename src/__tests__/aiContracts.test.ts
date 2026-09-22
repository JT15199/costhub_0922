import { describe, expect, it } from 'vitest';
import { bomExtendedCost, groupBomCost, limitRows, sumBomCost } from '../ai/contracts';

describe('成本契约计算', () => {
  const rows = [
    { module_name: '电源', main_category: '电源类', part_cost: 10.125, quantity: 2 },
    { module_name: '电源', main_category: '电源类', part_cost: 4, quantity: 1 },
    { module_name: '结构', main_category: '结构类', cost: 3, quantity: 2 },
  ];

  it('使用未舍入的单价×数量累加', () => {
    expect(bomExtendedCost(rows[0])).toBe(20.25);
    expect(sumBomCost(rows)).toBe(30.25);
  });

  it('按维度稳定聚合成本', () => {
    expect([...groupBomCost(rows, 'module').entries()]).toEqual([['电源', 24.25], ['结构', 6]]);
  });

  it('统一限制返回行数不超过 200', () => {
    const result = limitRows(Array.from({ length: 201 }, (_, i) => i), 999);
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
});
