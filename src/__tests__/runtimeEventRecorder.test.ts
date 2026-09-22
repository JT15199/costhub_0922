import { describe, it, expect } from 'vitest';
import {
  createRuntimeEventRecorder,
  installRuntimeEventRecorder,
  recordRuntimeEventInto,
} from '../components/ai/runtimeEventRecorder';

/** 模拟 window：记录器挂在它上面，测试不依赖 jsdom。 */
const runtimeWith = () => {
  const target: Record<string, unknown> = {};
  const recorder = installRuntimeEventRecorder(target);
  return { target, recorder: recorder! };
};

describe('Stage 3.5 — RuntimeEvent 记录器（真实链路验证用）', () => {
  it('按到达顺序记录事件类型', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'budget' }, true);
    recordRuntimeEventInto(target, { type: 'privacy' }, true);
    recordRuntimeEventInto(target, { type: 'route' }, true);
    recordRuntimeEventInto(target, { type: 'final' }, true);

    expect(recorder.types()).toEqual(['budget', 'privacy', 'route', 'final']);
  });

  it('开发工具开关关闭（isDevEnv=false）时不记录任何事件', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'budget' }, false);
    recordRuntimeEventInto(target, { type: 'final' }, false);
    expect(recorder.events).toHaveLength(0);
  });

  it('缺省（不传 isDevEnv）时读开发工具开关；测试环境无 localStorage → 回落关闭', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'budget' });
    expect(recorder.events).toHaveLength(0);
  });

  it('未安装记录器时是空操作（不抛错）', () => {
    expect(() => recordRuntimeEventInto({}, { type: 'budget' }, true)).not.toThrow();
    expect(() => recordRuntimeEventInto(undefined, { type: 'budget' }, true)).not.toThrow();
  });

  it('白名单外的事件类型不记录（避免将来新增字段被无意收集）', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'some_future_secret_event', payload: 'x' }, true);
    expect(recorder.events).toHaveLength(0);
  });

  it('长文本折叠为字符数，不把整篇回答堆进记录', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'token', text: 'x'.repeat(5000) }, true);

    const detail = recorder.events[0].detail;
    expect(detail.textChars).toBe(5000);
    expect(detail.text).toBeUndefined();
  });

  it('隐私事件只留结论性字段，regexMatches 折叠为数量', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, {
      type: 'privacy',
      decision: {
        classification: 'internal', cloudSafe: false, candidateRoute: 'local_only',
        reasonCode: 'source_policy:private_workspace',
        regexMatches: ['金额', '型号'], sourceTypes: ['private_workspace'],
      },
    }, true);

    const detail = recorder.events[0].detail as { decision: Record<string, unknown> };
    expect(detail.decision.classification).toBe('internal');
    expect(detail.decision.cloudSafe).toBe(false);
    expect(detail.decision.matchCount).toBe(2);
    // 命中词本身不落记录
    expect(JSON.stringify(detail)).not.toContain('型号');
  });

  it('gateway 事件只记内部类型与路由，便于核对重复投递', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'gateway', event: { type: 'route_selected', route: 'local', model: 'm', provider: 'ollama' } }, true);

    expect(recorder.gatewayTypes()).toEqual(['route_selected']);
  });

  it('reset 清空记录（跨轮运行不串数据）', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'budget' }, true);
    recorder.reset();
    expect(recorder.events).toHaveLength(0);
    // 重置后重新从 0 计序号
    recordRuntimeEventInto(target, { type: 'final' }, true);
    expect(recorder.events[0].seq).toBe(0);
  });

  it('pick 按类型过滤，用于精确核对某一类事件', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'tool_start', toolId: 'query_project_bom' }, true);
    recordRuntimeEventInto(target, { type: 'tool_result', toolId: 'query_project_bom', ok: true }, true);
    recordRuntimeEventInto(target, { type: 'token', text: 'hi' }, true);

    expect(recorder.pick('tool_start')).toHaveLength(1);
    expect(recorder.pick('tool_start')[0].detail.toolId).toBe('query_project_bom');
    expect(recorder.pick('token')).toHaveLength(1);
  });

  it('重复安装返回同一个记录器（幂等，不丢已有事件）', () => {
    const { target, recorder } = runtimeWith();
    recordRuntimeEventInto(target, { type: 'budget' }, true);
    const again = installRuntimeEventRecorder(target);
    expect(again).toBe(recorder);
    expect(again?.types()).toEqual(['budget']);
  });

  it('createRuntimeEventRecorder 可独立使用（不接触 window）', () => {
    const recorder = createRuntimeEventRecorder();
    expect(recorder.types()).toEqual([]);
    expect(recorder.gatewayTypes()).toEqual([]);
  });
});
