import { describe, it, expect } from 'vitest';
import { computeValueEngineering } from '../valueEng';

describe('computeValueEngineering — 价值工程（2026-08-18）', () => {
  const templates = [
    { featureKey: 'color_gamut', featureLabel: '色域', weight: 1.0 },
    { featureKey: 'brightness', featureLabel: '亮度', weight: 1.0 },
  ];
  const objA = { refType: 'project' as const, refId: 1, name: 'A', category: '显示器', bomCost: 1000,
    moduleCosts: { '屏': 800, '电源': 200 }, moduleFeatures: { '屏': ['color_gamut'], '电源': ['brightness'] },
    scores: { color_gamut: 8, brightness: 6 } };
  const objB = { refType: 'competitor' as const, refId: 2, name: 'B', category: '显示器', bomCost: 800,
    moduleCosts: { '屏': 600, '电源': 200 }, moduleFeatures: { '屏': ['color_gamut'], '电源': ['brightness'] },
    scores: { color_gamut: 6, brightness: 5 } };

  it('价值分 = Σ(评分×权重)/Σ权重', () => {
    const [r] = computeValueEngineering([objA], templates);
    expect(r.valueScore).toBeCloseTo(7, 2); // (8+6)/2
  });

  it('VE = 价值分/(百元成本)：价值分高或成本低 → VE 高', () => {
    const [ra, rb] = computeValueEngineering([objA, objB], templates);
    // A: valueScore 7, cost 1000 → ve = 7/(1000/1000)=7
    expect(ra.ve).toBeCloseTo(7, 2);
    // B: valueScore (6+5)/2=5.5, cost 800 → ve = 5.5/(800/1000)=6.875
    expect(rb.ve).toBeCloseTo(6.875, 2);
    // B 成本低但价值分也低，VE 略低——A 虽贵但价值分高，性价比更高
  });

  it('模块价值比：高成本低价值的模块会进 worstModules', () => {
    const objC = { ...objA, category: '显示器', moduleCosts: { '屏': 950, '电源': 50 },
      moduleFeatures: { '屏': ['color_gamut'], '电源': ['brightness'] }, scores: { color_gamut: 6, brightness: 6 } };
    const [r] = computeValueEngineering([objC], templates);
    // 屏成本占比 90%+，但只贡献 1/2 价值 → 价值比 <1，应进入最需优化模块
    expect(r.worstModules.some((m: any) => m.module === '屏' && m.valueRatio < 1)).toBe(true);
  });
});
