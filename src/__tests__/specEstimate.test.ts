import { describe, it, expect } from 'vitest';
import { parseScreenSize, parseResolution, parseRefreshRate, specSimilarity, estimateProjectCost } from '../specEstimate';

describe('规格解析', () => {
  it('尺寸解析：英寸数字', () => {
    expect(parseScreenSize('27英寸')).toBe(27);
    expect(parseScreenSize('23.8"')).toBe(23.8);
    expect(parseScreenSize('27"')).toBe(27);
    expect(parseScreenSize('')).toBe(0);
  });
  it('分辨率解析：像素总量', () => {
    expect(parseResolution('2560×1440 (QHD)')).toBe(2560 * 1440);
    expect(parseResolution('1920×1080')).toBe(1920 * 1080);
    expect(parseResolution('')).toBe(0);
  });
  it('刷新率解析', () => {
    expect(parseRefreshRate('144Hz')).toBe(144);
    expect(parseRefreshRate('165Hz')).toBe(165);
  });
});

describe('specSimilarity — 四维规格相似度', () => {
  it('完全相同的规格 → 100', () => {
    const s = specSimilarity({ screen_size: '27英寸', resolution: '2560×1440', refresh_rate: '144Hz', panel_type: 'IPS' },
      { screen_size: '27"', resolution: '2560×1440 (QHD)', refresh_rate: '144Hz', panel_type: 'IPS' });
    expect(s).toBe(100);
  });
  it('同尺寸不同分辨率 → 明显降分', () => {
    const same = specSimilarity({ screen_size: '27英寸', resolution: '2560×1440', refresh_rate: '144Hz', panel_type: 'IPS' },
      { screen_size: '27"', resolution: '2560×1440', refresh_rate: '144Hz', panel_type: 'IPS' });
    const diff = specSimilarity({ screen_size: '27英寸', resolution: '3840×2160', refresh_rate: '144Hz', panel_type: 'IPS' },
      { screen_size: '27"', resolution: '1920×1080', refresh_rate: '144Hz', panel_type: 'IPS' });
    expect(same).toBeGreaterThan(diff);
  });
  it('尺寸差 2 英寸 → 显著降分', () => {
    const s = specSimilarity({ screen_size: '27英寸' }, { screen_size: '29"' });
    expect(s).toBeLessThan(90);
  });
});

describe('estimateProjectCost — 规格估算', () => {
  const history = [
    { id: 1, code: 'A', screen_size: '27"', resolution: '2560×1440', refresh_rate: '144Hz', panel_type: 'IPS', bomCost: 700 },
    { id: 2, code: 'B', screen_size: '27"', resolution: '3840×2160', refresh_rate: '144Hz', panel_type: 'IPS', bomCost: 900 },
    { id: 3, code: 'C', screen_size: '23.8"', resolution: '1920×1080', refresh_rate: '60Hz', panel_type: 'IPS', bomCost: 400 },
  ];
  it('命中最像项目并加权估算', () => {
    const r = estimateProjectCost({ screen_size: '27英寸', resolution: '2560×1440', refresh_rate: '165Hz', panel_type: 'IPS' }, history);
    expect(r.candidates[0].project.code).toBe('A');
    expect(r.candidates[0].similarity).toBeGreaterThan(r.candidates[1].similarity);
    expect(r.matchedCount).toBeGreaterThan(0);
    expect(r.estimate).toBeGreaterThan(0);
  });
  it('估算在候选成本区间内（加权平均性质）', () => {
    const r = estimateProjectCost({ screen_size: '27英寸', resolution: '3840×2160', refresh_rate: '144Hz', panel_type: 'IPS' }, history);
    expect(r.candidates[0].project.code).toBe('B');
    const minC = Math.min(...r.candidates.filter(c => c.similarity > 0).map(c => c.project.bomCost));
    const maxC = Math.max(...r.candidates.filter(c => c.similarity > 0).map(c => c.project.bomCost));
    expect(r.estimate).toBeGreaterThanOrEqual(minC - 0.01);
    expect(r.estimate).toBeLessThanOrEqual(maxC + 0.01);
  });
  it('无历史项目 → 估算 0', () => {
    const r = estimateProjectCost({ screen_size: '27英寸' }, []);
    expect(r.estimate).toBe(0);
    expect(r.candidates).toHaveLength(0);
  });
});
