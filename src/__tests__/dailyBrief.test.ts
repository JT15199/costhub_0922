import { describe, it, expect } from 'vitest';
import { buildRuleBrief, buildBriefPrompt, hashString, localDate, type BriefFacts } from '../dailyBrief';

const base: BriefFacts = {
  date: '2026-08-16',
  totalProjects: 5, activeProjects: 3, doneProjects: 2,
  totalParts: 120, bigParts: 8,
  advisorOpen: 0, insightsUnread: 0, todosOpen: 0,
};

describe('hashString — 指纹稳定性', () => {
  it('同输入同输出', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
  });
  it('不同输入不同输出', () => {
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
  it('输出为短字符串', () => {
    expect(hashString('a'.repeat(1000))).toMatch(/^[0-9a-z]+$/);
  });
});

describe('localDate — 本地日期口径', () => {
  it('格式 YYYY-MM-DD', () => {
    expect(localDate(new Date(2026, 7, 16))).toBe('2026-08-16');
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('buildRuleBrief — 规则版速览', () => {
  it('无提醒时平稳表述', () => {
    const t = buildRuleBrief(base);
    expect(t).toContain('5 个项目');
    expect(t).toContain('在研 3');
    expect(t).toContain('120 种');
    expect(t).toContain('平稳');
  });
  it('有提醒时列出各类待处理事项', () => {
    const t = buildRuleBrief({ ...base, advisorOpen: 2, insightsUnread: 1, todosOpen: 4 });
    expect(t).toContain('3 类事项值得关注');
    expect(t).toContain('AI 自主建议 2 条待处理');
    expect(t).toContain('报价情报 1 条未读');
    expect(t).toContain('工作待办 4 条未完成');
  });
  it('大额物料数量正确', () => {
    const t = buildRuleBrief({ ...base, bigParts: 8 });
    expect(t).toContain('大额物料 ≥¥10 共 8 种');
  });
});

describe('buildBriefPrompt — 本地模型提示词', () => {
  it('system 约束只依据数据、禁止编造', () => {
    const { system } = buildBriefPrompt(base);
    expect(system).toContain('只依据摘要数据');
    expect(system).toContain('严禁编造');
  });
  it('user 携带完整事实 JSON', () => {
    const { user } = buildBriefPrompt(base);
    expect(user).toContain('2026-08-16');
    expect(user).toContain('totalProjects');
    expect(user).toContain('120');
  });
});
