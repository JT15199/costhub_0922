// 尺寸类物料按同样尺寸评估（2026-08-17）
import { describe, it, expect } from 'vitest';
import { parseDimension, dimensionAnalysis } from '../autoCompare';

describe('parseDimension', () => {
  it('解析 mm 尺寸（×/x/* 分隔均支持）', () => {
    expect(parseDimension('PCB 200×150mm')).toEqual({ w: 200, h: 150, areaCm2: 300, unit: 'mm', label: '200×150mm' });
    expect(parseDimension('200x150MM')).toEqual({ w: 200, h: 150, areaCm2: 300, unit: 'MM', label: '200×150MM' });
    expect(parseDimension('100*80mm')).toEqual({ w: 100, h: 80, areaCm2: 80, unit: 'mm', label: '100×80mm' });
  });
  it('解析 cm 尺寸', () => {
    expect(parseDimension('面板 12.5x8.5cm')?.areaCm2).toBeCloseTo(106.25, 2);
    expect(parseDimension('结构件 30×20厘米')?.areaCm2).toBe(600);
  });
  it('解析英寸并换算 cm', () => {
    expect(parseDimension('屏幕 10×8inch')?.areaCm2).toBeCloseTo(25.4 * 20.32, 0);
    expect(parseDimension('7×5英寸')?.areaCm2).toBeCloseTo(17.78 * 12.7, 0);
  });
  it('无尺寸返回 null', () => {
    expect(parseDimension('')).toBeNull();
    expect(parseDimension('普通电阻 0805')).toBeNull();
    expect(parseDimension(null as any)).toBeNull();
  });
});

describe('dimensionAnalysis', () => {
  const rows = [
    { project: 'A项目', name: 'PCB板', specs: '尺寸 200×150mm', cost: 8.4 },   // 300 cm² → 0.028/cm²
    { project: 'B项目', name: 'PCB板', specs: '尺寸 250×180mm', cost: 15.12 }, // 450 cm² → 0.0336/cm²
  ];
  it('组内 ≥2 行有尺寸 → 生成按同样尺寸评估 note', () => {
    const r = dimensionAnalysis(rows as any);
    expect(r).not.toBeNull();
    expect(r!.note).toContain('按同样尺寸评估');
    expect(r!.note).toContain('200×150mm');
    expect(r!.note).toContain('0.0280/cm²'); // 中位 0.0336？不对，见下
  });
  it('单位面积成本 = 成本 / 面积(cm²)', () => {
    const r = dimensionAnalysis(rows as any);
    // 8.4/300 = 0.028；15.12/450 = 0.0336 → 中位 0.0336
    expect(r!.note).toContain('¥0.0336/cm²');
  });
  it('只有 1 行有尺寸 → null', () => {
    expect(dimensionAnalysis([rows[0]] as any)).toBeNull();
  });
  it('没有尺寸 → null', () => {
    expect(dimensionAnalysis([{ name: '电容', specs: '', cost: 0.1 }, { name: '电阻', specs: '', cost: 0.2 }] as any)).toBeNull();
  });
});