import { describe, it, expect } from 'vitest';
import { summarizeSupplierTrend, supplierTrendText, supplierTrendTag } from '../supplierTrend';

describe('summarizeSupplierTrend — 供应商价格趋势', () => {
  it('无历史 → none', () => {
    const t = summarizeSupplierTrend([]);
    expect(t.direction).toBe('none');
    expect(supplierTrendText([])).toContain('暂无');
  });

  it('单次变动 → once，方向正确', () => {
    const t = summarizeSupplierTrend([{ old_price: 100, new_price: 110, change_reason: '原材料涨价' }]);
    expect(t.direction).toBe('once');
    expect(t.totalPct).toBe(10);
    expect(supplierTrendText([{ old_price: 100, new_price: 110, change_reason: '原材料涨价' }])).toContain('原材料涨价');
  });

  it('连续上涨 → up，累计幅度', () => {
    const t = summarizeSupplierTrend([
      { old_price: 100, new_price: 110, changed_at: '2026-07-01' },
      { old_price: 110, new_price: 121, changed_at: '2026-08-01' },
    ]);
    expect(t.direction).toBe('up');
    expect(t.totalPct).toBe(21);
    expect(t.count).toBe(2);
    expect(supplierTrendText([{ old_price: 100, new_price: 110 }, { old_price: 110, new_price: 121 }])).toContain('持续上涨');
  });

  it('连续下降 → down', () => {
    const t = summarizeSupplierTrend([
      { old_price: 100, new_price: 90 },
      { old_price: 90, new_price: 80 },
    ]);
    expect(t.direction).toBe('down');
    expect(supplierTrendText([{ old_price: 100, new_price: 90 }, { old_price: 90, new_price: 80 }])).toContain('持续下降');
  });

  it('有涨有跌 → mixed（波动）', () => {
    const t = summarizeSupplierTrend([
      { old_price: 100, new_price: 110 },
      { old_price: 110, new_price: 105 },
    ]);
    expect(t.direction).toBe('mixed');
    expect(supplierTrendText([{ old_price: 100, new_price: 110 }, { old_price: 110, new_price: 105 }])).toContain('波动');
  });

  it('微调 <0.5% → flat', () => {
    const t = summarizeSupplierTrend([
      { old_price: 100, new_price: 100.3 },
      { old_price: 100.3, new_price: 100.2 },
    ]);
    expect(t.direction).toBe('flat');
  });

  it('trendTag 映射正确', () => {
    expect(supplierTrendTag({ direction: 'up', totalPct: 5, count: 1, minPct: 0, maxPct: 0, lastReason: '' }).color).toBe('red');
    expect(supplierTrendTag({ direction: 'down', totalPct: -5, count: 1, minPct: 0, maxPct: 0, lastReason: '' }).color).toBe('green');
    expect(supplierTrendTag({ direction: 'mixed', totalPct: 0, count: 2, minPct: -5, maxPct: 5, lastReason: '' }).color).toBe('orange');
  });
});
