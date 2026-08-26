import { describe, it, expect } from 'vitest';
import { detectSkills, AI_SKILLS } from './aiSkills';

describe('detectSkills', () => {
  it('行情提问命中行情技能', () => {
    const s = detectSkills('更新一下 Scaler IC 的行情洞察');
    expect(s.some(x => x.id === 'trend')).toBe(true);
  });
  it('审价提问命中审价技能', () => {
    const s = detectSkills('帮我审这份报价');
    expect(s.some(x => x.id === 'quote')).toBe(true);
  });
  it('BOM 提问命中拆解技能', () => {
    const s = detectSkills('把这份 BOM 录入 M270');
    expect(s.some(x => x.id === 'bom')).toBe(true);
  });
  it('报告提问命中报告技能', () => {
    const s = detectSkills('生成一份降本分析报告');
    expect(s.some(x => x.id === 'report')).toBe(true);
  });
  it('无关提问不命中', () => {
    expect(detectSkills('你好')).toEqual([]);
  });
  it('技能库非空且 guide 有效', () => {
    expect(AI_SKILLS.length).toBeGreaterThan(4);
    for (const s of AI_SKILLS) { expect(s.guide.length).toBeGreaterThan(20); expect(s.triggers.length).toBeGreaterThan(0); }
  });
});
