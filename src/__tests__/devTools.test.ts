import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DEV_TOOLS_DEFAULT,
  DEV_TOOLS_KEY,
  isDevToolsEnabled,
  setDevToolsEnabled,
} from '../components/ai/devTools';

/** 内存 storage（测试环境是 node，没有 localStorage）。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
    raw: () => Object.fromEntries(map),
  };
}

beforeEach(() => vi.stubEnv('DEV', true));
afterEach(() => vi.unstubAllEnvs());

describe('Stage 3.5 — 开发工具开关（默认关闭）', () => {
  it('缺省是关闭的', () => {
    expect(DEV_TOOLS_DEFAULT).toBe(false);
    expect(isDevToolsEnabled(memoryStorage())).toBe(false);
  });

  it('缺键、空串、非 1/true 的值都视为关闭（只有显式开启才算开）', () => {
    expect(isDevToolsEnabled(memoryStorage({ [DEV_TOOLS_KEY]: '' }))).toBe(false);
    expect(isDevToolsEnabled(memoryStorage({ [DEV_TOOLS_KEY]: '0' }))).toBe(false);
    expect(isDevToolsEnabled(memoryStorage({ [DEV_TOOLS_KEY]: 'yes' }))).toBe(false);
    // 不做 trim：值与运行时开关保持同一套严格比较口径，避免两处判定漂移
    expect(isDevToolsEnabled(memoryStorage({ [DEV_TOOLS_KEY]: ' on ' }))).toBe(false);
  });

  it('只有 "1" / "true" 视为开启', () => {
    expect(isDevToolsEnabled(memoryStorage({ [DEV_TOOLS_KEY]: '1' }))).toBe(true);
    expect(isDevToolsEnabled(memoryStorage({ [DEV_TOOLS_KEY]: 'true' }))).toBe(true);
  });

  it('setDevToolsEnabled 能开也能关（保留快速回滚）', () => {
    const storage = memoryStorage();
    expect(setDevToolsEnabled(true, storage)).toBe(true);
    expect(isDevToolsEnabled(storage)).toBe(true);
    expect(setDevToolsEnabled(false, storage)).toBe(true);
    expect(isDevToolsEnabled(storage)).toBe(false);
  });

  it('storage 缺失或抛错时回落到关闭，绝不把探测本身变成故障点', () => {
    expect(isDevToolsEnabled(null)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); } };
    expect(isDevToolsEnabled(broken)).toBe(false);
    expect(setDevToolsEnabled(true, { getItem: () => null, setItem: () => { throw new Error('quota'); } })).toBe(false);
  });

  it('仅开发构建且显式开启时生效；生产构建即使开关为 1 也拒绝', () => {
    const enabled = memoryStorage({ [DEV_TOOLS_KEY]: '1' });
    expect(isDevToolsEnabled(enabled)).toBe(true);

    vi.stubEnv('DEV', false);
    expect(isDevToolsEnabled(enabled)).toBe(false);
    expect(setDevToolsEnabled(true, enabled)).toBe(false);
    expect(enabled.raw()[DEV_TOOLS_KEY]).toBe('1');
  });
});
