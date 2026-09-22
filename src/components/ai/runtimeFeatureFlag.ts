// Agent Runtime V1（Stage 3）— Feature flag
//
// 用途：在**不删除旧链路**的前提下，让 AI 协作窗可以选择消费 `runAgentTurn` 事件流。
//
// 设计约束：
//   * **默认关闭**（Stage 3 要求）。默认走既有 `runPiAgent` 直连路径，行为与 Stage 2 完全一致。
//   * 开关只影响「用哪条链路驱动 UI」，不影响任何安全策略 ——
//     两条链路都经过同一个 `executeTool` 闸门与同一套审批流程。
//   * 可运行时切换（localStorage），失败回退到默认值，不抛错。

/** 控制是否让 AiPanel 经由 `runAgentTurn` 驱动。 */
export const USE_AGENT_RUNTIME = 'costhub-use-agent-runtime';

/** 默认值：关闭。改这里等同于改默认行为，需评审。 */
export const AGENT_RUNTIME_DEFAULT = false;

/** 读取开关（容错：localStorage 不可用或值异常时回退默认）。 */
export function isAgentRuntimeEnabled(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return AGENT_RUNTIME_DEFAULT;
    const raw = store.getItem(USE_AGENT_RUNTIME);
    if (raw === null || raw === undefined || raw === '') return AGENT_RUNTIME_DEFAULT;
    return raw === '1' || raw === 'true';
  } catch {
    return AGENT_RUNTIME_DEFAULT;
  }
}

/** 写入开关（幂等；失败静默，不影响功能）。 */
export function setAgentRuntimeEnabled(enabled: boolean, storage?: Pick<Storage, 'setItem'> | null): boolean {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return false;
    store.setItem(USE_AGENT_RUNTIME, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
