import { describe, it, expect } from 'vitest';
import { classifyByModule, MODULE_RULES } from './moduleRules';

describe('classifyByModule', () => {
  it('电源类器件归电源模块', () => {
    const r = classifyByModule('电源适配器 24V');
    expect(r?.module).toBe('电源模块');
    expect(r?.mainCat).toBe('电源类');
  });
  it('面板器件归显示模块', () => {
    expect(classifyByModule('27寸液晶面板 M270')?.module).toBe('显示模块');
  });
  it('结构件归结构类', () => {
    expect(classifyByModule('后壳注塑件')?.mainCat).toBe('结构类');
  });
  it('英文关键词大小写不敏感', () => {
    expect(classifyByModule('scaler 主控')?.module).toBe('驱动板模块');
    expect(classifyByModule('主控芯片')?.module).toBe('驱动板模块');
  });
  it('未命中返回 null', () => {
    expect(classifyByModule('特殊定制件XYZ')).toBeNull();
  });
  it('规则库非空且关键词有效', () => {
    expect(MODULE_RULES.length).toBeGreaterThan(10);
    for (const r of MODULE_RULES) {
      expect(r.keywords.length).toBeGreaterThan(0);
      expect(r.module.length).toBeGreaterThan(0);
    }
  });
});
