import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { handleRuntimeCommand, parseRuntimeCommand, runRuntimeCommand } from '../components/ai/runtimeDevSwitch';
import { AGENT_RUNTIME_DEFAULT, isAgentRuntimeEnabled } from '../components/ai/runtimeFeatureFlag';

/** 内存 storage（避免依赖 jsdom/happy-dom 的 localStorage）。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries({ 'costhub-dev-tools': '1', ...initial }));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
    raw: () => Object.fromEntries(map),
  };
}

beforeEach(() => vi.stubEnv('DEV', true));
afterEach(() => vi.unstubAllEnvs());

describe('Stage 3.5 — /runtime 开发开关：命令识别', () => {
  it('识别 on / off / status / help', () => {
    expect(parseRuntimeCommand('/runtime on')).toBe('on');
    expect(parseRuntimeCommand('/runtime off')).toBe('off');
    expect(parseRuntimeCommand('/runtime status')).toBe('status');
    expect(parseRuntimeCommand('/runtime help')).toBe('help');
  });

  it('大小写、别名与多余空格都接受', () => {
    expect(parseRuntimeCommand('  /RUNTIME ON  ')).toBe('on');
    expect(parseRuntimeCommand('/agent-runtime off')).toBe('off');
    expect(parseRuntimeCommand('/runtime')).toBe('status');
  });

  it('非命令输入一律不拦截（避免误伤普通提问）', () => {
    expect(parseRuntimeCommand('')).toBeNull();
    expect(parseRuntimeCommand('runtime on')).toBeNull();
    expect(parseRuntimeCommand('/runtimex on')).toBeNull();
    expect(parseRuntimeCommand('/runtime maybe')).toBeNull();
    expect(parseRuntimeCommand('帮我分析 M270 的成本')).toBeNull();
    expect(parseRuntimeCommand('/runtime on 然后继续')).toBeNull();
  });
});

describe('Stage 3.5 — /runtime 开发开关：开关读写', () => {
  it('on 打开开关，off 关回关闭状态', () => {
    const storage = memoryStorage();
    expect(isAgentRuntimeEnabled(storage)).toBe(AGENT_RUNTIME_DEFAULT);
    expect(AGENT_RUNTIME_DEFAULT).toBe(false);

    const on = runRuntimeCommand('/runtime on', storage);
    expect(on?.action).toBe('on');
    expect(on?.changed).toBe(true);
    expect(isAgentRuntimeEnabled(storage)).toBe(true);

    const off = runRuntimeCommand('/runtime off', storage);
    expect(off?.action).toBe('off');
    expect(off?.changed).toBe(true);
    expect(isAgentRuntimeEnabled(storage)).toBe(false);
  });

  it('重复执行同一命令时明确告知"已是目标状态"，不谎报切换', () => {
    const storage = memoryStorage();
    const first = runRuntimeCommand('/runtime on', storage);
    const second = runRuntimeCommand('/runtime on', storage);
    expect(first?.changed).toBe(true);
    expect(second?.changed).toBe(false);
    expect(second?.reply).toContain('已是目标状态');
  });

  it('status 报告当前链路但不改动开关', () => {
    const storage = memoryStorage({ 'costhub-use-agent-runtime': '1' });
    const status = runRuntimeCommand('/runtime status', storage);
    expect(status?.action).toBe('status');
    expect(status?.target).toBe(true);
    expect(status?.changed).toBe(false);
    expect(status?.reply).toContain('runAgentTurn');
    expect(storage.raw()).toEqual({ 'costhub-dev-tools': '1', 'costhub-use-agent-runtime': '1' });
  });

  it('status 在未设置时报告旧链路与"未设置，用默认"', () => {
    const status = runRuntimeCommand('/runtime status', memoryStorage());
    expect(status?.target).toBe(false);
    expect(status?.reply).toContain('runPiAgent');
    expect(status?.reply).toContain('未设置');
  });

  it('storage 写入失败时如实报告未改变，不静默假装成功', () => {
    const broken = {
      getItem: (key: string) => key === 'costhub-dev-tools' ? '1' : null,
      setItem: () => { throw new Error('quota'); },
    };
    const result = runRuntimeCommand('/runtime on', broken);
    expect(result?.changed).toBe(false);
    expect(result?.reply).toContain('无法写入');
  });

  it('help 输出用法且四种动作都列出', () => {
    const help = runRuntimeCommand('/runtime help', memoryStorage());
    expect(help?.reply).toContain('/runtime on');
    expect(help?.reply).toContain('/runtime off');
    expect(help?.reply).toContain('/runtime status');
  });

  it('非命令返回 null（调用方据此放行普通消息）', () => {
    expect(runRuntimeCommand('普通提问', memoryStorage())).toBeNull();
  });
});

describe('Stage 3.5 — /runtime 开发开关：双重门禁', () => {
  it('开发环境但 localStorage 开关关闭时命令被完全忽略', () => {
    const storage = memoryStorage({ 'costhub-dev-tools': '0' });
    for (const command of ['/runtime on', '/runtime off', '/runtime status']) {
      expect(handleRuntimeCommand(command, { storage })).toBeNull();
    }
    expect(isAgentRuntimeEnabled(storage)).toBe(false);
  });

  it('生产构建中即使 localStorage 开关为 1 也拒绝命令', () => {
    const storage = memoryStorage();
    vi.stubEnv('DEV', false);
    for (const command of ['/runtime on', '/runtime off', '/runtime status']) {
      expect(handleRuntimeCommand(command, { storage })).toBeNull();
      expect(runRuntimeCommand(command, storage)).toBeNull();
    }
    expect(isAgentRuntimeEnabled(storage)).toBe(false);
  });

  it('开发构建且 localStorage 开关打开时命令生效', () => {
    const storage = memoryStorage();
    const result = handleRuntimeCommand('/runtime on', { storage });
    expect(result?.action).toBe('on');
    expect(isAgentRuntimeEnabled(storage)).toBe(true);
  });
});
