import { describe, expect, it } from 'vitest';
import { inferSupplierName, parseTenderRows } from '../tenderImport';

describe('招标报价 Excel 解析', () => {
  it('识别中文表头并计算缺省小计', () => {
    const parsed = parseTenderRows([
      ['供应商报价单'],
      ['模块', '器件名称', '型号', '规格参数', '数量', '单价', '备注'],
      ['灯条', 'LED灯条', 'LB-01', '27寸 6500K', 2, '¥12.50', '样例'],
      ['电源', '电源板', 'PS-01', '90W', 1, 30, ''],
    ], 'A供应商_摸底报价.xlsx');
    expect(parsed.headerRow).toBe(1);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].line_total).toBe(25);
    expect(parsed.totalAmount).toBe(55);
    expect(parsed.supplierName).toContain('A供应商');
  });

  it('保留空价格但不吞掉有名称的行', () => {
    const parsed = parseTenderRows([['名称', '规格', '数量'], ['支架', '铝合金', 1]], '报价.xlsx');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].unit_price).toBe(0);
    expect(parsed.warnings.some(item => item.includes('单价'))).toBe(true);
  });
});

describe('供应商文件名推断', () => {
  it('去除报价和轮次后保留供应商名', () => {
    expect(inferSupplierName('B供应商_第2轮_报价单.xlsx')).toContain('B供应商');
    expect(inferSupplierName('报价单.xlsx')).toBe('');
  });
});
