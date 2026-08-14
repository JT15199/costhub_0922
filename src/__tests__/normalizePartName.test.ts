import { describe, it, expect } from 'vitest';
import { normalizePartName } from '../db/compare';

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
