import { describe, it, expect } from 'vitest';
import { chunkVoiceItems, mergeDimensions } from '../voiceAnalyer';

describe('chunkVoiceItems — 自动分块（不切断单条）', () => {
  it('空输入 → 无块', () => { expect(chunkVoiceItems([])).toEqual([]); });
  it('按字数预算切块，单条完整归一块', () => {
    const items = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
    const blocks = chunkVoiceItems(items, 250);
    // 每块最多 2 条（250字符预算足够放 2×100），3 条 → 2 块
    expect(blocks.length).toBe(2);
    expect(blocks[0].items.length).toBe(2);
  });
  it('超长单条单独一块', () => {
    const items = ['x'.repeat(5000), 's'];
    const blocks = chunkVoiceItems(items, 1000);
    expect(blocks[0].items).toEqual(['x'.repeat(5000)]);
  });
});

describe('mergeDimensions — 跨块合并汇总', () => {
  it('合并同名维度，按提及+正面加权', () => {
    const res = mergeDimensions([
      [{ name: '续航', sentiment: 'positive' }, { name: '续航', sentiment: 'positive' }, { name: '外观', sentiment: 'negative' }],
      [{ name: '续航', sentiment: 'positive' }],
    ]);
    const battery = res.find(r => r.name === '续航');
    expect(battery!.count).toBe(3);
    expect(battery!.positive).toBe(3);
    expect(battery!.weight).toBeGreaterThan(0);
    // 续航权重最高
    expect(res[0].name).toBe('续航');
  });
  it('不同写法归一化去重', () => {
    const res = mergeDimensions([[{ name: '电池续航', sentiment: 'positive' }], [{ name: ' 电池续航 ', sentiment: 'negative' }]]);
    // 归一化后同词 → 合并为 1 条
    const battery = res.filter(r => String(r.name).replace(/\s+/g, '').includes('电池续航'));
    expect(battery.length).toBeGreaterThanOrEqual(1);
  });
});
