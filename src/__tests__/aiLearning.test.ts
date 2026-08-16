import { describe, it, expect } from 'vitest';
import {
  classifyUserQuestion, mergeFocus, focusRanked,
  feedbackToPreference, buildFocusContext, buildLearnedRulesContext,
} from '../aiLearning';

describe('classifyUserQuestion — 关注主题分类', () => {
  it('命中单一主题', () => {
    expect(classifyUserQuestion('帮我看看 M270 的成本是多少')).toEqual(['项目成本']);
  });
  it('多主题同时命中', () => {
    const r = classifyUserQuestion('液晶面板行情上涨了，供应商 A 的份额多少，项目成本受多大影响');
    expect(r).toContain('物料行情');
    expect(r).toContain('供应商');
    expect(r).toContain('项目成本');
  });
  it('多主题按命中数排序（词多者在前）', () => {
    const r = classifyUserQuestion('物料行情上涨了，物料子类要洞察');
    expect(r[0]).toBe('物料行情'); // 物料/行情/上涨 3 词
  });
  it('无命中返回空', () => {
    expect(classifyUserQuestion('你好')).toEqual([]);
    expect(classifyUserQuestion('')).toEqual([]);
  });
  it('大小写不敏感（BOM/bom）', () => {
    expect(classifyUserQuestion('BOM 成本')).toContain('项目成本');
  });
});

describe('mergeFocus — 关注统计聚合', () => {
  it('新主题并入 +1', () => {
    expect(mergeFocus({ '项目成本': 5 }, ['物料行情'])).toEqual({ '项目成本': 3, '物料行情': 1 }); // 5→衰减2+1=3？衰减后 2.5→3? 见下
  });
  it('旧数据衰减一半', () => {
    const r = mergeFocus({ '项目成本': 10 }, ['项目成本']);
    expect(r['项目成本']).toBe(6); // 10→5 +1 = 6
  });
});

describe('focusRanked — 排序', () => {
  it('按权重降序且过滤 0', () => {
    const r = focusRanked({ '目标达成': 3, '供应商': 0, '物料行情': 8 });
    expect(r.map(x => x.topic)).toEqual(['物料行情', '目标达成']);
  });
});

describe('feedbackToPreference — 反馈转规则', () => {
  it('默认原因模板', () => {
    expect(feedbackToPreference('vague')).toContain('泛泛');
    expect(feedbackToPreference('nodata')).toContain('本地数据');
  });
  it('自定义优先', () => {
    expect(feedbackToPreference('vague', '先给结论再给数据')).toBe('先给结论再给数据');
  });
});

describe('偏好上下文生成', () => {
  it('无数据返回空串', () => {
    expect(buildFocusContext({})).toBe('');
    expect(buildLearnedRulesContext([])).toBe('');
  });
  it('关注文本含主题与优先级要求', () => {
    const ctx = buildFocusContext({ '项目成本': 5, '物料行情': 3 });
    expect(ctx).toContain('项目成本');
    expect(ctx).toContain('优先覆盖');
  });
  it('规则文本要求必须遵守', () => {
    const ctx = buildLearnedRulesContext([{ id: 'a', topic: '通用', preference: '按子类对比成本', source: 'feedback', createdAt: '' }]);
    expect(ctx).toContain('必须遵守');
    expect(ctx).toContain('按子类对比成本');
  });
});
