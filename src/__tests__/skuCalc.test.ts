import { describe, it, expect } from 'vitest';
import { calcSkuCost, buildSkuBom } from '../skuCalc';

// 基座 BOM（模拟）
const boms = [
  { id: 1, module_name: '显示模块', part_name: '面板', part_model: 'M270', part_cost: 500, quantity: 1 },
  { id: 2, module_name: '显示模块', part_name: '驱动板', part_model: 'DRV-100', part_cost: 30, quantity: 1 },
  { id: 3, module_name: '结构模块', part_name: '外壳', part_model: 'SH-1', part_cost: 40, quantity: 2 },
];
const bomTotal = 500 * 1 + 30 * 1 + 40 * 2; // 610

describe('calcSkuCost — SKU 成本 = 基座 BOM + Σ差异（原始值）', () => {
  it('无差异：成本 = 基座成本', () => {
    const r = calcSkuCost(boms, [], bomTotal);
    expect(r.cost).toBe(610);
    expect(r.delta).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('add：新增器件 + 单价×数量', () => {
    const r = calcSkuCost(boms, [
      { id: 101, diff_type: 'add', module_name: '电源模块', part_name: '适配器', part_model: 'AD-65', unit_cost: 20, quantity: 1 },
    ], bomTotal);
    expect(r.cost).toBe(630);
    expect(r.delta).toBe(20);
  });

  it('remove：移除基座器件 - 基座行小计', () => {
    const r = calcSkuCost(boms, [
      { id: 102, diff_type: 'remove', module_name: '结构模块', part_name: '外壳', part_model: 'SH-1' },
    ], bomTotal);
    expect(r.cost).toBe(610 - 80); // 外壳数量 2 × 40
    expect(r.delta).toBe(-80);
  });

  it('replace：新单价×新数量 - 基座行小计', () => {
    const r = calcSkuCost(boms, [
      { id: 103, diff_type: 'replace', module_name: '显示模块', part_name: '驱动板', part_model: 'DRV-100', unit_cost: 25, quantity: 1 },
    ], bomTotal);
    expect(r.cost).toBe(610 - 30 + 25);
  });

  it('组合：add + remove + replace 同时生效', () => {
    const r = calcSkuCost(boms, [
      { id: 101, diff_type: 'add', module_name: '电源模块', part_name: '适配器', part_model: 'AD-65', unit_cost: 20, quantity: 1 },
      { id: 102, diff_type: 'remove', module_name: '结构模块', part_name: '外壳', part_model: 'SH-1' },
      { id: 103, diff_type: 'replace', module_name: '显示模块', part_name: '驱动板', part_model: 'DRV-100', unit_cost: 25, quantity: 1 },
    ], bomTotal);
    expect(r.cost).toBe(610 + 20 - 80 + (25 - 30));
    expect(r.delta).toBe(20 - 80 - 5);
  });

  it('replace 未指定数量：默认用基座数量', () => {
    const r = calcSkuCost(boms, [
      { id: 104, diff_type: 'replace', module_name: '结构模块', part_name: '外壳', part_model: 'SH-1', unit_cost: 45 },
    ], bomTotal);
    expect(r.cost).toBe(610 - 80 + 45 * 2); // 基座数量 2
  });

  it('匹配不到基座器件：记入 issues 不计算', () => {
    const r = calcSkuCost(boms, [
      { id: 105, diff_type: 'remove', module_name: '显示模块', part_name: '不存在的器件', part_model: 'XXX' },
    ], bomTotal);
    expect(r.delta).toBe(0);
    expect(r.issues.length).toBe(1);
    expect(r.issues[0]).toContain('不存在的器件');
  });

  it('基座涨价联动：基座 cost 变化 → SKU 成本自动跟随', () => {
    const boms2 = boms.map(b => b.id === 1 ? { ...b, part_cost: 740 } : b); // 面板 500 → 740
    const total2 = boms2.reduce((s, b) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
    const r = calcSkuCost(boms2, [], total2);
    expect(total2).toBe(610 + 240);
    expect(r.cost).toBe(total2);
  });
});

describe('SKU 变体减/换器件（2026-08-18：outbox/inbox 简包装、8GB→16GB 内存场景）', () => {
  it('remove：outbox → inbox 简包装（移除包装盒）', () => {
    const boms2 = [
      { id: 1, module_name: '包装模块', part_name: '外包装盒', part_model: 'BOX-OUT', part_cost: 12, quantity: 1 },
      { id: 2, module_name: '结构模块', part_name: '内衬', part_model: 'IN-1', part_cost: 3, quantity: 1 },
    ];
    const r = calcSkuCost(boms2, [{ id: 201, diff_type: 'remove', module_name: '包装模块', part_name: '外包装盒', part_model: 'BOX-OUT' }], 15);
    expect(r.cost).toBe(15 - 12);
    expect(r.delta).toBe(-12);
    const { rows } = buildSkuBom(boms2, [{ id: 201, diff_type: 'remove', module_name: '包装模块', part_name: '外包装盒', part_model: 'BOX-OUT' }]);
    expect(rows.find((x: any) => x.part_name === '外包装盒')?._skuStatus).toBe('removed');
  });

  it('replace 带 new_model：8GB 内存 → 16GB（换型号 + 换单价）', () => {
    const boms2 = [
      { id: 1, module_name: '核心模块', part_name: '内存', part_model: '8GB DDR4', part_cost: 45, quantity: 1 },
    ];
    const diff = { id: 202, diff_type: 'replace' as const, module_name: '核心模块', part_name: '内存', part_model: '8GB DDR4', new_model: '16GB DDR4', unit_cost: 85, quantity: 1 };
    const r = calcSkuCost(boms2, [diff], 45);
    expect(r.cost).toBe(85); // -45 + 85
    const { rows } = buildSkuBom(boms2, [diff]);
    const row = rows.find((x: any) => x.part_name === '内存');
    expect(row?._skuStatus).toBe('replaced');
    expect(row?._newModel).toBe('16GB DDR4');
    expect(row?._newCost).toBe(85);
  });

  it('replace 不带 new_model：只换单价/数量，型号沿用基座', () => {
    const boms2 = [
      { id: 1, module_name: '核心模块', part_name: '内存', part_model: '8GB DDR4', part_cost: 45, quantity: 1 },
    ];
    const diff = { id: 203, diff_type: 'replace' as const, module_name: '核心模块', part_name: '内存', part_model: '8GB DDR4', unit_cost: 40, quantity: 2 };
    const { rows } = buildSkuBom(boms2, [diff]);
    const row = rows.find((x: any) => x.part_name === '内存');
    expect(row?._newModel).toBe('');
    expect(row?._newQty).toBe(2);
  });
});

describe('buildSkuBom — 合并 BOM 展示', () => {
  it('差异合成：added/removed/replaced 标注正确', () => {
    const { rows } = buildSkuBom(boms, [
      { id: 101, diff_type: 'add', module_name: '电源模块', part_name: '适配器', part_model: 'AD-65', unit_cost: 20, quantity: 1 },
      { id: 102, diff_type: 'remove', module_name: '结构模块', part_name: '外壳', part_model: 'SH-1' },
      { id: 103, diff_type: 'replace', module_name: '显示模块', part_name: '驱动板', part_model: 'DRV-100', unit_cost: 25, quantity: 1 },
    ]);
    const added = rows.find(r => r._skuStatus === 'added');
    const removed = rows.find(r => r._skuStatus === 'removed');
    const replaced = rows.find(r => r._skuStatus === 'replaced');
    expect(added.part_name).toBe('适配器');
    expect(removed.part_name).toBe('外壳');
    expect(replaced.part_name).toBe('驱动板');
    expect(replaced._newCost).toBe(25);
    // 模块小计：removed 不计入
    const structMod = rows.filter(r => r.module_name === '结构模块');
    expect(structMod.every(r => r._skuStatus === 'removed')).toBe(true);
  });

  it('模块小计与总成本（removed 不计入）', () => {
    const { byMod, total } = buildSkuBom(boms, [
      { id: 101, diff_type: 'add', module_name: '电源模块', part_name: '适配器', part_model: 'AD-65', unit_cost: 20, quantity: 1 },
    ]);
    expect(byMod['显示模块'].subtotal).toBe(500 + 30);
    expect(byMod['电源模块'].subtotal).toBe(20);
    expect(total).toBe(610 + 20);
  });
});
