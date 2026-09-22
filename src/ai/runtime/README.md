# Agent Runtime（`src/ai/runtime/`）

Agent Runtime 是 CostHub AI 的**统一执行入口**：调用方发起一次运行，得到一条事件流与一个结果，
而不必自己拼装 `PiRunOptions` 与 17 个回调钩子。

```ts
const turn = runAgentTurn(request);          // AsyncGenerator<RuntimeEvent, AgentResult>
for await (const event of turn) render(event);
// 结束后可拿到 AgentResult（finalText / rounds / messages / workingState / budget）
```

> 目录边界：**不新建 `src/agent`**。Runtime 与既有 Pi 接入层（`piRuntime` / `piHarness` /
> `piStream`）同域复用，本目录只做「收口」，不搬迁、不重写既有模块。

---

## 文件职责

| 文件 | 职责 |
|---|---|
| `contract.ts` | 统一契约：`AgentRequest` / `AgentResult` / `RuntimeEvent`（18 种）/ `AgentBudgetReport`。**纯类型 + 常量，无逻辑** |
| `session.ts` | **运行生命周期编排**：算预算 → 调 preflight → 调 `runPiAgent` → 生成事件 → 收尾/返回结果 |
| `preflight.ts` | 运行前两阶段：**隐私判定 → 路由决策**。只调用现有 `privacyRouter.evaluatePrivacy` |
| `toolPrivacy.ts` | 工具隐私聚合、来源标签推导、`decideRoute`（纯函数） |
| `queue.ts` | 回调→生成器的异步队列桥接（`push` / `close` / `drain` / `waitForWork`） |
| `sessionCallbacks.ts` | 把 `runPiAgent` 的 17 个回调映射成 `RuntimeEvent`，**并转发**既有回调 |
| `budget.ts` | 上下文预算口径；显式区分「调用方指定 / 模型标定 / 回落默认值」 |

**依赖方向（单向，无环）：**
`session` → { `preflight`, `queue`, `sessionCallbacks`, `budget` } → { `toolPrivacy`, `contract` } → `privacyRouter` / `piRuntime`（既有模块）

---

## 事件顺序

```text
budget → privacy → route → (运行中事件…) → final
                                          ↘ error   （失败时）
```

`privacy` / `route` 各带一对 `stage` 事件（`start` + `ok`/`skip`），因此阶段进度可观测。

**路由 ≠ 外发。** `route` 只表示「选择了候选路径」，与 `GatewayTracePanel` 既有语义一致
（该面板已注明"仅表示选择了候选路径，不能代表已发送"）。实际外发仍受审批与
`buildCloudSafeContext` 约束。

---

## 隐私边界（**重要：请完整阅读本节**）

### 当前策略：available tools based privacy check

即**执行前的保守检查（pre-execution conservative check）**：

```text
request.options.tools（本轮**可用**的全部工具）
        ↓ aggregateToolPrivacy
   取最严 privacyLevel + 全部 cloudEligible
        ↓ 若含 sensitive → 推导出 'private_workspace' 来源标签
evaluatePrivacy({ text, sourceTypes })
        ↓ decideRoute（三重合取，fail-closed）
   local | cloud
```

**关键性质：判定依据是「本轮可用的工具集」，而不是「本轮实际被调用的工具」。**

因为可用集 ⊇ 实际调用集，这个判断**比实际更严**，因此**不会漏放**。

**代价（已知且刻意接受）：可能误判为更保守。**
例如：工具集里包含 `read_excel`（`sensitive`），但本轮对话根本没用它 ——
`route` 仍会落在 `local`。

> **这是安全优先的取舍：宁可误判，不允许风险外发。**
> 反向的取舍（先放行、出问题再说）在成本数据场景下不可接受。

### 未来阶段：actual tool invocation based privacy check

计划由 **Tool Gateway** 实现（**当前未实现，不在本阶段范围内**）：

* 在**运行中**按实际发生的工具调用动态收紧，而不是只看可用集；
* 允许一开始判定为 `local`、运行中发现需要云端时再升级（或反之收紧）；
* 每次工具调用写入审计（谁调用 / 为什么 / 用了什么数据）。

在此之前，`route` 只决策一次（运行前），运行中不会重算。

> **本目录的代码不得假设 Tool Gateway 已存在。** 也不要在没有它的情况下
> 自行实现"运行中动态重算路由"——那会绕开当前 fail-closed 的合取判定。

### 三条不可放宽的不变量（由 `src/__tests__/runtimePrivacyPolicy.test.ts` 钉住）

1. **sensitive 工具存在 ⇒ route = local**，即使该工具本轮没被调用。
2. **全部工具 public + 显式请求 cloud + 文本判定 cloudSafe ⇒ route = cloud**
   （证明不是"一律禁止云端"）。
3. **工具未声明 `privacyLevel` ⇒ 按 `internal` 处理，`cloudEligible = false`，route = local。**

---

## 工具隐私声明规则

`AiToolManifest` 的两个可选字段（`src/ai/contracts.ts`）：

```ts
privacyLevel?: 'public' | 'internal' | 'sensitive';
cloudEligible?: boolean;
```

`resolveToolCloudEligible` 的 fail-closed 推导：

```text
privacyLevel === 'sensitive'                          → false（恒 false，显式 true 也不放行）
cloudEligible === false（显式）                        → false
cloudEligible === true 但 privacyLevel !== 'public'    → false
privacyLevel === 'public'                             → true
未声明 privacyLevel（按 internal）                      → false
```

**「漏标」的默认结果是「不可上云」，不是「默认放行」。**

当前 42 个工具全部已显式声明，其中仅 4 个可上云：
`insight_material_trend` · `cloud_abstract_analysis` · `calc` · `now`。

---

## 已知限制

| # | 限制 | 说明 |
|---|---|---|
| 1 | 判定基于可用工具集，非实际调用 | 见上「当前策略」。偏保守，不会漏放 |
| 2 | `route` 只决策一次 | 运行中不重算；云端工具另有审批与隐私路由兜底 |
| 3 | 尚未经真实链路验证 | 现有测试均 mock `piRuntime`，验证的是门面与推导规则 |

---

## 修改本目录时请遵守

1. **单文件 ≤ 300 行**（Quality Harness 的 Q10 门禁；超限请按职责拆分，不要上调上限）。
2. **不要复制 `privacyRouter` 的逻辑** —— 只调用它。判定口径必须唯一。
3. **不要放宽 `decideRoute` 的合取条件**。宁可偏严。
4. **不要删除既有回调转发** —— `AiPanel` 迁移期依赖"只加不减"。
5. **改事件顺序前先看 `runtimePrivacyPolicy.test.ts` 与 `runtimeAgentTurn.test.ts`** ——
   事件顺序是被测试钉住的契约。
