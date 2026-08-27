import { describe, it, expect } from 'vitest';
import { parseCanonicalResult, buildCanonicalPrompt } from './canonicalize';

describe('parseCanonicalResult', () => {
  it('解析标准 JSON 数组', () => {
    const r = parseCanonicalResult('[{"original":"10KΩ 0603 1%","category":"被动元件","standard":"被动元件 电阻 10KΩ 0603 1%","specs":["10KΩ","0603","1%"],"model":""}]');
    expect(r.length).toBe(1);
    expect(r[0].category).toBe('被动元件');
    expect(r[0].specs).toContain('0603');
  });
  it('带前缀包裹也能解析', () => {
    const r = parseCanonicalResult('好的，结果如下：\n[{"original":"支架","category":"结构件","standard":"结构件 支架","specs":[],"model":""}]');
    expect(r.length).toBe(1);
    expect(r[0].specs).toEqual([]); // 笼统物料规格空
  });
  it('截断时逐个抠出已生成对象', () => {
    const r = parseCanonicalResult('[{"original":"A","category":"结构件","standard":"结构件 A","specs":[],"model":""},{"original":"B","categor');
    expect(r.some(x => x.original === 'A')).toBe(true);
  });
  it('无法解析返回空', () => {
    expect(parseCanonicalResult('模型没输出')).toEqual([]);
  });
  it('提示词包含品类词表和规则', () => {
    const p = buildCanonicalPrompt(['支架']);
    expect(p).toContain('被动元件');
    expect(p).toContain('笼统');
    expect(p).toContain('绝不编造');
  });
});
