import { expect, it } from 'vitest';
import { buildQuoteReviewRows } from '../quoteComparison';

it('compares sourced module costs without turning missing prices or modules into savings', () => {
  const line = (module_name: string, line_total: number | null, price_state = 'confirmed') => ({ module_name, line_total, quantity: 1, unit_cost: line_total, price_state });
  const rows = buildQuoteReviewRows([line('面板', 100.1), line('面板', 20.2), line('免费项', 0), line('待报价', null), line('新增', 8)], [line('面板', 110.1), line('免费项', 0), line('待报价', 7), line('移除', 9)]);
  expect(rows.find(r => r.module === '面板')).toMatchObject({ difference: 10.2, status: '高于参考' });
  expect(rows.find(r => r.module === '免费项')).toMatchObject({ current: 0, difference: 0, status: '与参考一致' });
  expect(rows.find(r => r.module === '待报价')).toMatchObject({ current: null, difference: null });
  expect(rows.find(r => r.module === '新增')).toMatchObject({ reference: null, difference: null });
  expect(rows.find(r => r.module === '移除')).toMatchObject({ current: null, difference: null });
  expect(buildQuoteReviewRows([line('面板', 100)], null)[0].status).toBe('待询价');
  expect(buildQuoteReviewRows([line('面板', 100)], [line('面板', 90, 'unknown')])[0]).toMatchObject({ reference: null, difference: null });
});

