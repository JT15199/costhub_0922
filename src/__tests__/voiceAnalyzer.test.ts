import { describe, it, expect } from 'vitest';
import { chunkVoiceItems, mergeDimensions, parseDimensions } from '../voiceAnalyer';

describe('chunkVoiceItems — 自动分块（不切断单条）', () => {
  it('空输入 → 无块', () => { expect(chunkVoiceItems([])).toEqual([]); });
  it('按字数预算切块，单条完整归一块', () => {
    const items = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
    const blocks = chunkVoiceItems(items, 250);
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
    expect(res[0].name).toBe('续航');
  });
  it('不同写法归一化去重', () => {
    const res = mergeDimensions([[{ name: '电池续航', sentiment: 'positive' }], [{ name: ' 电池续航 ', sentiment: 'negative' }]]);
    const battery = res.filter(r => String(r.name).replace(/\s+/g, '').includes('电池续航'));
    expect(battery.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseDimensions — 健壮解析模型输出', () => {
  it('标准 {dimensions:[...]}', () => {
    const d = parseDimensions('{"dimensions":[{"name":"续航","sentiment":"positive"},{"name":"外观","sentiment":"negative"}]}');
    expect(d.length).toBe(2);
    expect(d[0].name).toBe('续航');
    expect(d[0].sentiment).toBe('positive');
    expect(d[1].sentiment).toBe('negative');
  });
  it('顶层数组 [{name,sentiment}]', () => {
    const d = parseDimensions('[{"name":"压感","sentiment":"positive"}]');
    expect(d.length).toBe(1);
    expect(d[0].name).toBe('压感');
  });
  it('{features:[...]} 字段 + 中文负面', () => {
    const d = parseDimensions('{"features":[{"name":"色准","sentiment":"负面"}]}');
    expect(d.length).toBe(1);
    expect(d[0].name).toBe('色准');
    expect(d[0].sentiment).toBe('negative');
  });
  it('前后夹散文 + 代码围栏', () => {
    const fence = String.fromCharCode(96);
    const d = parseDimensions('好的，以下是结果：\n' + fence + 'json\n{"dimensions":[{"name":"连接","sentiment":"positive"}]}\n' + fence + '\n希望有帮助');
    expect(d.length).toBe(1);
    expect(d[0].name).toBe('连接');
  });
  it('行级兜底：名称：正面', () => {
    const d = parseDimensions('- 续航：正面\n- 外观：负面');
    expect(d.length).toBe(2);
    expect(d.find(x => x.name === '续航')?.sentiment).toBe('positive');
    expect(d.find(x => x.name === '外观')?.sentiment).toBe('negative');
  });
  it('截断的 JSON（num_predict 不够）也能抠出完整对象', () => {
    const d = parseDimensions('{"dimensions":[{"name":"色彩还原","sentiment":"positive"},{"name":"分辨率","sentiment":"negative"},{"name":"刷新');
    expect(d.length).toBe(2);
    expect(d[0].name).toBe('色彩还原');
    expect(d[0].sentiment).toBe('positive');
    expect(d[1].name).toBe('分辨率');
    expect(d[1].sentiment).toBe('negative');
  });
});
