import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { emptyWorkingState, updateWorkingState, withStableMessageId } from '../ai/workingState';
import { renderWorkingState } from '../ai/contextBuilder';

const user = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage);

describe('structured working state', () => {
  it('keeps important decisions when later turns add noisy context', () => {
    const initial = updateWorkingState(emptyWorkingState('session-1'), { sessionId: 'session-1', messages: [user('已经确定使用 Pi 原生模式')], now: 1 });
    const next = updateWorkingState(initial, { sessionId: 'session-1', messages: [user('请继续整理当前页面的普通信息')], now: 2 });

    expect(next.decisions.some(item => item.status === 'active' && item.text.includes('Pi 原生模式'))).toBe(true);
  });

  it('keeps the first-turn source id when the decision is reused in a later run', () => {
    const first = updateWorkingState(emptyWorkingState('session-source'), {
      sessionId: 'session-source',
      messages: [withStableMessageId(user('已经确定使用 Pi 原生模式'), 'run-1:prompt:1')],
      now: 1,
    });
    const next = updateWorkingState(first, {
      sessionId: 'session-source',
      messages: [withStableMessageId(user('继续沿用已确定方案'), 'run-2:prompt:1')],
      now: 2,
    });

    expect(next.decisions.find(item => item.status === 'active' && item.text.includes('Pi 原生模式'))?.sourceMessageIds).toContain('run-1:prompt:1');
  });

  it('supersedes an old confirmed fact when the user explicitly replaces it', () => {
    const initial = updateWorkingState(emptyWorkingState('session-2'), { sessionId: 'session-2', messages: [user('目标成本为 420')], now: 1 });
    const next = updateWorkingState(initial, { sessionId: 'session-2', messages: [user('目标成本调整为 410')], now: 2 });

    expect(next.confirmedFacts.find(item => item.text.includes('420'))?.status).toBe('superseded');
    expect(next.confirmedFacts.find(item => item.text.includes('410'))).toMatchObject({ status: 'active', confidence: 'confirmed' });
  });

  it('does not overwrite a confirmed fact with an uncertain statement', () => {
    const initial = updateWorkingState(emptyWorkingState('session-3'), { sessionId: 'session-3', messages: [user('目标成本确认是 410')], now: 1 });
    const next = updateWorkingState(initial, { sessionId: 'session-3', messages: [user('目标成本可能是 420')], now: 2 });

    expect(next.confirmedFacts.filter(item => item.status === 'active')).toHaveLength(1);
    expect(next.confirmedFacts.find(item => item.status === 'active')?.text).toContain('410');
  });

  it('isolates project facts and restores the saved project context when switching back', () => {
    const first = updateWorkingState(emptyWorkingState('project-switch'), {
      sessionId: 'project-switch',
      messages: [user('项目名称：项目 A，目标成本 400，供应商范围：供应商 X。')],
      now: 1,
    });
    const second = updateWorkingState(first, {
      sessionId: 'project-switch',
      messages: [user('项目名称：项目 B，目标成本 300，供应商范围：供应商 Y。')],
      now: 2,
    });

    expect(second.activeProject?.name).toBe('项目 B');
    expect(second.activeProject?.supplierScope).toBe('供应商 Y');
    expect(renderWorkingState(second)).toContain('目标成本 300');
    expect(renderWorkingState(second)).not.toContain('目标成本 400');

    const restored = updateWorkingState(second, {
      sessionId: 'project-switch',
      messages: [user('项目名称：项目 A。')],
      now: 3,
    });
    expect(restored.activeProject?.supplierScope).toBe('供应商 X');
    expect(renderWorkingState(restored)).toContain('目标成本 400');
    expect(renderWorkingState(restored)).not.toContain('目标成本 300');
  });

  it('assigns a supplier-only turn to the current project before switching away', () => {
    const first = updateWorkingState(emptyWorkingState('partial-project'), {
      sessionId: 'partial-project', messages: [user('项目名称：项目 A，目标成本 400。')], now: 1,
    });
    const updated = updateWorkingState(first, {
      sessionId: 'partial-project', messages: [user('供应商范围：供应商 X，目标成本改成 390。')], now: 2,
    });
    expect(updated.confirmedFacts.find(item => item.text.includes('390'))?.projectKey).toBe('项目 a');

    const switched = updateWorkingState(updated, {
      sessionId: 'partial-project', messages: [user('项目名称：项目 B。')], now: 3,
    });
    expect(renderWorkingState(switched)).not.toContain('目标成本 390');
  });

  it('scopes decisions, questions, files and steps to the active project', () => {
    const first = updateWorkingState(emptyWorkingState('supporting-scope'), {
      sessionId: 'supporting-scope',
      messages: [
        user('项目名称：项目 A。已经确定使用 A-only 方案；待确认：A-only 风险；下一步：完成 A-only 校验。'),
        { role: 'toolResult', content: [{ type: 'text', text: '已生成 A-only 文件' }], details: { fullResultPath: 'C:\\work\\A-only.txt' } } as any,
      ],
      now: 1,
    });
    const second = updateWorkingState(first, {
      sessionId: 'supporting-scope', messages: [user('项目名称：项目 B。')], now: 2,
    });

    const rendered = renderWorkingState(second);
    expect(rendered).not.toContain('A-only');
    expect(first.decisions.find(item => item.text.includes('A-only'))?.projectKey).toBe('项目 a');
    expect(first.openQuestions.find(item => item.text.includes('A-only'))?.projectKey).toBe('项目 a');
    expect(first.activeFiles[0]).toMatchObject({ projectKey: '项目 a', scope: 'project' });
    expect(first.nextSteps.find(item => item.text.includes('A-only'))).toMatchObject({ projectKey: '项目 a', scope: 'project' });
  });
});
