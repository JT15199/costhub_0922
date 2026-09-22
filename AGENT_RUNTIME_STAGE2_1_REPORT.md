# AGENT_RUNTIME_STAGE2_1_REPORT

**阶段：** Stage 2.1 — Agent Runtime 边界加固（**不加新能力，只加固代码边界与可维护性**）
**基线：** `794e2b4`（Stage 2，已在 PR #1 中）
**目标分支：** `agent-runtime-stage2-1-hardening`（从 `quality-harness-v1` 切出）
**提交信息：** `refactor: harden agent runtime stage2 boundary`
**日期：** 2026-09-22
**状态：** 完成，`build` / `quality:core` / `quality:full` **全部通过**

---

## 0. 结论

| 项 | 结果 |
|---|---|
| `npm run build` | **PASS** |
| `npm run quality:core` | **PASS**（10 pass / 0 fail / **0 warn**，退出码 0） |
| `npm run quality:full` | **PASS**（13 pass / 0 fail / **0 warn**，退出码 0） |
| 新增测试 | **15 个**（`runtimePrivacyPolicy.test.ts`），全通过 |
| 既有测试是否受影响 | **无** —— 43 个运行时测试全部仍通过（行为未变） |
| `session.ts` 行数 | **238 → 187**（−51 行） |
| `src/agent` | **未创建** ✅ |
| 禁止修改项 | `AiPanel.tsx` / `piRuntime.ts` / `privacyRouter.ts` / 业务页面 **全部未改** ✅ |
| Tool Gateway | **未实现**（按要求只写说明） ✅ |
| 新依赖 | **0** ✅ |

---

## 1. 修改文件列表

### 1.1 新增（3 个）

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/ai/runtime/queue.ts` | 62 | 从 `session.ts` 迁出的异步队列（`push` / `close` / `drain` / `waitForWork`） |
| `src/ai/runtime/README.md` | 142 | Runtime 边界说明；**隐私边界一节为本阶段重点产出** |
| `src/__tests__/runtimePrivacyPolicy.test.ts` | 245 | 三条隐私策略边界的测试 |

### 1.2 修改（1 个）

| 文件 | 改动 |
|---|---|
| `src/ai/runtime/session.ts` | 删除内联的 `createAsyncQueue`（约 51 行），改为 `import { createAsyncQueue } from './queue'` |

**改动净效果：** `session.ts` 只减不增，逻辑逐字符未变。

### 1.3 明确未修改（实测验证）

```bash
git status --short | grep '^ M'
# 仅： M src/ai/runtime/session.ts
```

| 项 | 状态 |
|---|---|
| `src/components/AiPanel.tsx` | 未修改 ✅ |
| `src/ai/piRuntime.ts` | 未修改 ✅ |
| `src/ai/privacyRouter.ts` | 未修改 ✅ |
| 业务页面（5 个直调文件） | 未修改 ✅ |
| `src/agent` | 未创建 ✅ |
| Tool Gateway | 未实现 ✅ |
| `package.json` / 依赖 | 未修改 ✅ |

---

## 2. `session.ts` 拆分结果

### 2.1 拆分前

`session.ts`（238 行）同时承担 5 件事：

```text
session.ts
  ├── Agent 生命周期编排        ← 应该保留
  ├── AsyncQueue（搬运机制）     ← 应迁出（与 Agent 无关，可独立测试）
  ├── callback → RuntimeEvent   ← 已在 Stage 2 拆到 sessionCallbacks.ts
  ├── preflight 调用            ← 已在 Stage 2 拆到 preflight.ts
  └── result 处理               ← 应保留
```

### 2.2 拆分后

```text
session.ts（187 行）—— 只负责：
  ├── runAgentTurn 生命周期编排（预算 → preflight → runPiAgent → 事件 → 收尾）
  ├── 驱动循环（drain / waitForWork / runSettled 三者协作）
  └── 结果组装（AgentResult）

queue.ts（62 行）—— 只负责：
  ├── push(value)
  ├── close()
  ├── drain()          ← 只吐已缓冲元素，缓冲为空立刻返回（不阻塞）
  └── waitForWork()    ← 等待"有新元素或已关闭"
```

**`session.ts` 顶部注释同步更新**，指向 `queue.ts`；队列语义与踩坑记录随代码一起迁移到 `queue.ts`，
不留在两个文件里各说一半。

### 2.3 行为一致性验证

| 验证方式 | 结果 |
|---|---|
| `npx tsc -b` | 退出码 0 |
| `runtimeAgentTurn.test.ts`（19 个） | **全部通过**（拆分前也全通过） |
| `runtimePrivacy.test.ts`（24 个） | **全部通过** |
| 队列语义 | 逐字符搬迁，未改任何一行逻辑 |

**本阶段唯一的行为相关风险点：** `drain()` 的「不阻塞」语义与 `waitForWork()` 的拆分
是 Stage 1/2 两次死锁修复的产物（见 `queue.ts` 注释）。搬迁时保持了这一语义，
且 `runtimeAgentTurn.test.ts` 里那条**流式语义**用例（断言"结果返回前事件就已产出"）
仍然通过 —— 如果队列被误改成阻塞式，该用例会立即失败。

### 2.4 当前 `src/ai/runtime/` 全貌

| 文件 | 行数 | 职责 |
|---|---|---|
| `contract.ts` | 251 | 统一契约（纯类型） |
| `session.ts` | **187** | 运行生命周期编排 |
| `toolPrivacy.ts` | 132 | 工具隐私聚合 / 来源标签 / `decideRoute` |
| `budget.ts` | 122 | 上下文预算口径 |
| `preflight.ts` | 101 | 隐私 → 路由两阶段 |
| `sessionCallbacks.ts` | 86 | 回调 → 事件映射 |
| `queue.ts` | **62** | 异步队列桥接 |
| `README.md` | 142 | 边界说明 |

**最大文件 251 行**，全部在 300 行门禁以内。

---

## 3. 新增测试结果

### 3.1 `runtimePrivacyPolicy.test.ts`（15 个，全通过）

```text
 ✓ src/__tests__/runtimePrivacyPolicy.test.ts (15 tests) 10ms
```

**Case 1 — sensitive 工具存在但未被调用 ⇒ route = local（5 个用例）**

| 用例 | 断言 |
|---|---|
| 前置事实 | `read_excel` 的声明确实是 `sensitive` 且不可上云 |
| 仅"可用"即足以降级 | 工具集含 `read_excel`（本轮不调用）→ `strictest=sensitive`、`cloudEligible=false`、`route=local` |
| 事件流层验证 | 断言传给 `piRuntime` 的工具集**确实包含** `read_excel`，且事件流中**没有** `tool_start: read_excel` → 证明"可用但未调用"这个前提成立；`route` 事件为 `local` |
| 来源标签 | 推导出 `private_workspace`，判定 `cloudSafe=false` |
| 策略取舍的显式记录 | 同一请求、同一路由请求，仅因工具集多一个**未使用的** sensitive 工具就被降级为 local |

> **已用真实 manifest 构造工具**（`AI_TOOL_MANIFESTS.read_excel`），不是自造的假声明 ——
> 避免把测试写成"自证"。

**Case 2 — 全部 public + 显式请求云端 + 判定安全 ⇒ route = cloud（4 个用例）**

| 用例 | 断言 |
|---|---|
| 前置事实 | `calc` 与 `now` 都是 `public` 且可上云 |
| 判定链路 | `cloudEligible=true` → `decision.cloudSafe=true` → `route=cloud` |
| 事件流层验证 | `route` 事件为 `cloud`，且运行成功返回结果 |
| 合取性 | 三个条件（显式请求 / cloudSafe / 工具可上云）**缺一即 local**，三者齐备才 cloud |

> **这一条证明「不是所有请求都禁止云端」。** 没有它，前两条的"拦截"就无法排除
> 「`decideRoute` 恒返回 local」这种假实现。

**实现过程中发现的一处必要说明（值得记录）：**

Case 2 最初失败，因为 `evaluatePrivacy` 在**缺少分类器接缝**时会 fail-closed 归为 `unknown`
（而非 `public`）。这是**正确**行为，不是缺陷 —— `privacyRouter` 的既有设计就是
"没有已验证的公开来源证据 → 不允许上云"。

因此测试改为与**真实云端调用方完全一致的接缝**（对照 `AiPanel.tsx:894` 与
`cloudContext.ts:96` 的实际用法）：

```ts
sourceTypes: ['public_approved_content'],
metadata: [{ sourceType: 'public_approved_content', sensitivity: 'public',
             cloudSafe: true, verified: true, ... }],
classifier: reviewedPublicClassifier,
```

**教训：** 隐私测试不能"只给个中立文本就期望放行"。要证明云端路径可用，
必须同时提供分类器与已验证来源 —— 这也顺带证明了 `privacyRouter` 的 fail-closed 是有效的。

**Case 3 — 工具未声明 privacyLevel（6 个用例）**

| 用例 | 断言 |
|---|---|
| 解析缺省 | 未声明 → `internal`（`{}` 与 `undefined` 都测） |
| 云资格缺省 | 未声明 → `cloudEligible=false` |
| 路由结果 | 未声明 + 显式请求云端 → `route=local`；`undeclaredCount=1` |
| 空工具集 | 不构成"可上云"证据 → `cloudEligible=false`、`route=local` |
| 等价性 | 未声明与显式 `internal` **完全等价**（不能靠"忘记声明"绕过） |
| 反向验证 | 显式 `public` 才放行 → 证明上面的 `false` 不是恒假 |

### 3.2 `npm run build`

```text
✓ built in 1.50s
BUILD_EXIT = 0
```

### 3.3 `npm run quality:core`

```text
QUALITY GATE: PASS
Counts: 10 pass · 0 fail · 0 blocked · 0 warn · 0 skip
Total:  1m27s
CORE_EXIT = 0
```

Q01 Build · Q02 Vitest All · Q03 分类 · Q04 Rust · Q05 Agent · Q06 Lint capture ·
**Q07 lint 基线门禁 PASS（未新增 lint 问题）** · Q08 self-check · Q09 catalog · **Q10 行数门禁 PASS** · finalize 泄漏检查 PASS

### 3.4 `npm run quality:full`

```text
QUALITY GATE: PASS
Counts: 13 pass · 0 fail · 0 blocked · 0 warn · 0 skip
Total:  1m48s
FULL_EXIT = 0
```

core 全部 10 步 + 桌面档 3 步全绿：

| ID | 步骤 | 结果 |
|---|---|---|
| F01 | Desktop fixture prepare（隔离 DB） | PASS |
| F02 | Fixture executable check | PASS |
| F03 | Desktop E2E-001..008（真实 WebView2 / CDP） | PASS |
| — | `[finalize]` 报告泄漏检查 | PASS |

**三项必过检查全部 PASS，且 core 与 full 均为 0 warning。**

### 3.5 全量测试

Stage 2.1 新增 15 个用例；运行时相关测试合计 **58 个**（19 + 24 + 15）。

---

## 4. 当前 Runtime 边界说明

（完整版见 `src/ai/runtime/README.md`，此处摘要。）

### 4.1 当前策略：`available tools based privacy check`

**执行前的保守检查。** 判定依据是「本轮**可用**的工具集」，**不是**「本轮**实际调用**的工具」：

```text
request.options.tools（可用工具）
      ↓ aggregateToolPrivacy → 取最严 privacyLevel + 全部 cloudEligible
      ↓ 含 sensitive → 推导 'private_workspace' 来源标签
evaluatePrivacy({ text, sourceTypes })
      ↓ decideRoute（三重合取，fail-closed）
  local | cloud
```

* **不会漏放**：可用集 ⊇ 实际调用集，因此判定比实际更严。
* **代价（已知、刻意接受）**：可能偏保守。例如工具集含 `read_excel`（sensitive）
  但本轮根本没用它 —— `route` 仍为 `local`。
* **取舍理由：安全优先，宁可误判，不允许风险外发。**

### 4.2 未来策略：`actual tool invocation based privacy check`

**由 Tool Gateway 实现 —— 当前未实现，不在本阶段范围内。**

目标：运行中按**实际发生的工具调用**动态收紧；允许运行中升级/降级路由；
每次调用写审计（谁调用 / 为什么 / 用了什么数据）。

> `README.md` 中已明确写入「本目录的代码不得假设 Tool Gateway 已存在」，
> 以及「不要在它缺席时自行实现运行中动态重算路由」—— 那会绕开当前 fail-closed 的合取判定。

### 4.3 三条不可放宽的不变量（已被测试钉住）

1. **sensitive 工具存在 ⇒ route = local**，即使该工具本轮未被调用。
2. **全部 public + 显式请求云端 + 文本判定安全 ⇒ route = cloud。**
3. **未声明 `privacyLevel` ⇒ `internal` / `cloudEligible=false` / `route=local`。**

### 4.4 已知限制（README 中同步记录）

| # | 限制 |
|---|---|
| 1 | 判定基于可用工具集而非实际调用（偏保守，不漏放） |
| 2 | `route` 只决策一次，运行中不重算（云端工具另有审批与隐私路由兜底） |
| 3 | 尚未经真实链路验证（现有测试均 mock `piRuntime`） |

---

## 5. Stage 3 是否可以开始

**可以。** 前置条件已全部满足：

| 前置条件 | 状态 |
|---|---|
| Runtime 目录职责边界清晰 | ✅ 7 个源文件各司其职，最大 251 行 |
| 事件顺序契约被测试钉住 | ✅ `runtimeAgentTurn`（19）+ `runtimePrivacy`（24）+ `runtimePrivacyPolicy`（15） |
| 隐私边界有文字说明 | ✅ `src/ai/runtime/README.md` |
| 三条策略不变量可回归 | ✅ 本阶段新增 |
| 既有回调转发保持（迁移期依赖） | ✅ Stage 1 确立，Stage 2 / 2.1 未破坏 |
| `quality:core` / `quality:full` 双绿 | ✅ |

### 5.1 Stage 3 的既有工作状态（重要）

**Stage 3 已有未完成的在制品，本阶段开始时被我 stash 保存**，
否则本阶段的 `build` 无法通过、且违反"不修改 AiPanel"的约束：

```text
stash@{0}  stage3-wip-aipanel-runtime-migration
  包含： M src/components/AiPanel.tsx
        ?? src/ai/panel/  （featureFlags.ts / gatewayTrace.ts / runtimeUiBridge.ts）
```

**恢复方式：**

```bash
git stash list                    # 确认 stash@{0} 是 stage3-wip-...
git stash pop                     # 恢复 Stage 3 在制品
```

**已完成的 Stage 3 部分**（stash 中的内容）：feature flag `USE_AGENT_RUNTIME`（默认关闭）、
`RuntimeEvent → GatewayTraceState` 的 UI 桥接、`AiPanel` 的双路径分支。
**未完成**：`runtimeAiPanelMigration.test.ts`、三项 quality 检查、Stage 3 报告。

### 5.2 Stage 3 开始时建议的顺序

1. `git stash pop` 恢复在制品；
2. 补 `runtimeAiPanelMigration.test.ts`（验收点：事件驱动 AI 窗口 / privacy 显示 / route 显示 / tool 显示 / final 一致）；
3. 跑 `build` + `quality:core` + `quality:full`；
4. 出 Stage 3 报告（重点：新旧链路差异、flag 能否默认开启、回滚方式、E2E 结果）。

### 5.3 本阶段对 Stage 3 的一处直接受益

`queue.ts` 拆出后，`session.ts` 只剩编排逻辑 187 行 —— Stage 3 若需要在事件流上
增加"回放 / 快照"之类的能力，有 100+ 行余量，不必再拆文件。

---

## 6. 复现与验证

```bash
# 确认只改了 session.ts（应只有一行 M）
git status --short | grep '^ M'

# 禁用项未触碰（应为空）
git diff --name-only -- src/components/AiPanel.tsx src/ai/piRuntime.ts src/ai/privacyRouter.ts
test -d src/agent && echo FAIL || echo "OK: src/agent absent"

# 构建与门禁
npm run build
npm run quality:core
npm run quality:full

# 本阶段新增测试
npx vitest run src/__tests__/runtimePrivacyPolicy.test.ts   # 期望 15 passed
```

---

## 7. 分支与提交

| 项 | 值 |
|---|---|
| 目标仓库 | `https://github.com/JT15199/costhub_0922` |
| 基线分支 | `quality-harness-v1` @ `794e2b4` |
| 新分支 | `agent-runtime-stage2-1-hardening` |
| 提交信息 | `refactor: harden agent runtime stage2 boundary` |

**说明：** 你指定了新建分支，因此本阶段**不推送到 `quality-harness-v1`**，
以免把 Stage 2.1 的提交混进 PR #1（PR #1 现在停在 Stage 2 的 `794e2b4`）。

---
_本报告由 Stage 2.1 实施产出。所有数字来自实际命令输出；Stage 3 在制品状态已如实标注（见 §5.1）。_
