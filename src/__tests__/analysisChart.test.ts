import { describe, expect, it } from 'vitest';
import { analysisChartOption, parseAnalysisChart, renderAnalysisSvg } from '../ai/analysisChart';

const example = { title: '模块成本比较', takeaway: '示例数据，仅用于渲染验证', type: 'bar', unit: '元/台', source: '测试样本', basis: '同币种同税率', labels: ['显示模块', '主控模块', '结构件'], series: [{ name: '报价', values: [840, 216, null] }] };
describe('analysis chart contract and artifact', () => {
  it('keeps missing values missing, supports negative differences and rejects invalid numeric input', () => {
    const chart = parseAnalysisChart(example);
    expect(analysisChartOption(chart).series[0].data[2]).toBeNull();
    expect(parseAnalysisChart({ ...example, series: [{ name: '差额', values: [-10, 20, null] }] }).series[0].values[0]).toBe(-10);
    for (const value of [Infinity, NaN, '120']) expect(() => parseAnalysisChart({ ...example, series: [{ name: '报价', values: [value, 2, 3] }] })).toThrow();
    expect(() => parseAnalysisChart({ ...example, type: 'donut' })).toThrow();
    expect(() => parseAnalysisChart({ ...example, source: '' })).toThrow();
  });
  it('exports standalone SVG with escaped labels, sources and basis', () => {
    const svg = renderAnalysisSvg(parseAnalysisChart({ ...example, title: '<script>alert(1)</script>' }));
    expect(svg).toContain('<svg');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('测试样本');
    expect(svg).toContain('同币种同税率');
    expect(svg).not.toMatch(/https?:\/\/[^\s]*\.js/);
  });
});
