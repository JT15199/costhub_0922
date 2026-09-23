// Agent Runtime Stage 3.5 — 开发工具开关（单一来源）
//
// 为什么需要它：
//   Stage 3.5 要能手动打开 Runtime 链路并观察 `RuntimeEvent` 顺序。
//   第一版把这件事挂在 `import.meta.env.DEV` 上，**实测不可靠**：
//   Vite 8 的 dev server 只在"模块自身引用了 import.meta.env"时才注入
//   `import.meta.env = {...}`，被间接引用的模块拿到的 `import.meta.env` 是
//   `undefined`，于是 `DEV` 判定恒为 false —— 记录器装了却永远不记录，
//   `/runtime` 命令也被静默忽略。这类"环境标记探测"不该成为验证链路的前提。
//
// 修正后由本模块直接读取 Vite 的 DEV 常量，并与显式开关同时校验：
//   * 开发构建 AND localStorage 显式开启才生效；生产构建的 DEV 常量固定为 false；
//   * 手动验证时置 `1` 即开启，随时置 `0` 或删除键即回到默认；
//   * `localStorage` 只是第二道门禁，不会覆盖生产构建的环境常量。
//
// 适用范围（都只是"开发期可观测性与手动控制"，不含任何业务或安全策略）：
//   * `/runtime on|off|status|help` 手动切换执行链路
//   * RuntimeEvent 旁路记录器（只写内存）

/** localStorage 键：`1` / `true` 视为开启，其余（含缺省）一律关闭。 */
export const DEV_TOOLS_KEY = 'costhub-dev-tools';

/** 缺省值：关闭。改这里等于改变默认行为，需要评审。 */
export const DEV_TOOLS_DEFAULT = false;

function readStore(storage?: Pick<Storage, 'getItem'> | null): Pick<Storage, 'getItem'> | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 开发工具是否开启。
 *
 * 容错：localStorage 不可用（隐私模式等）或读取抛错时**回落到关闭**，
 * 绝不让"探测开关"本身变成故障点。
 */
export function isDevToolsEnabled(storage?: Pick<Storage, 'getItem'> | null): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const store = readStore(storage);
    if (!store) return DEV_TOOLS_DEFAULT;
    const raw = store.getItem(DEV_TOOLS_KEY);
    if (raw === null || raw === undefined || raw === '') return DEV_TOOLS_DEFAULT;
    return raw === '1' || raw === 'true';
  } catch {
    return DEV_TOOLS_DEFAULT;
  }
}

/** 显式设置开关（供测试与手动验证使用）。 */
export function setDevToolsEnabled(enabled: boolean, storage?: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return false;
    store.setItem(DEV_TOOLS_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
