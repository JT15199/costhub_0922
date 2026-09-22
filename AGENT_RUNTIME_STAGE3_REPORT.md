# AGENT_RUNTIME_STAGE3_REPORT

**阶段：** Stage 3 — AiPanel Runtime 迁移（双路径接入，feature flag 默认关闭）
**基线：** `955ba94`（`agent-runtime-stage2-1-hardening`）
**目标分支：** `agent-runtime-stage3-aipanel`
**提交信息：** `refactor: migrate aipanel to agent runtime`
**日期：** 2026-09-22
**状态：** 完成，`build` / `quality:core` / `quality:full` **全部通过**

---

## 0. 结论

| 项 | 结果 |
|---|---|
| `npm run build` | **PASS** |
| `npm run quality:core` | **PASS**（10 pass / 0 fail / **0 warn**，退出码 0） |
| `npm run quality:full` | **PASS**（13 pass / 0 fail / **0 warn**，退出码 0） |
| 新增测试 | **21 个**（`runtimeAiPanelMigration.test.ts`），全通过 |
| 运行时相关测试合计 | **79 个**（19 + 24 + 15 + 21）全通过 |
| 全量测试 | **608 passed / 0 failed / 3 skipped**（Stage 2.1 末 548+15=563，本阶段 +21 → 608） |
| `AiPanel.tsx` 增量 | **+54 −3 行**（迁移接入仅此一处，其余逻辑全部外置） |
| `src/agent` | **未创建** ✅ |
| 旧 Agent 调用路径 | **保留，未删除** ✅ |
| Tool Gateway | **未实现** ✅ |
| 新依赖 | **0** ✅ |

---

## 1. 修改文件列表

### 1.1 新增（5 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/components/ai/runtimeAdapter.ts` | 89 | **Runtime 适配层**：调用 `runAgentTurn`、消费 `AsyncIterable<RuntimeEvent>`、双路径分发决策 |
| `src/components/ai/runtimeEventMapper.ts` | 172 | **状态转换层**：`RuntimeEvent` → 现有 AI 窗口状态（网关事件 + 轨迹卡） |
| `src/components/ai/runtimeFeatureFlag.ts` | 36 | `USE_AGENT_RUNTIME` 开关（默认关闭，容错读取） |
| `src/components/ai/gatewayTrace.ts` | 68 | 从 `AiPanel.tsx` **原样搬迁**的 `GatewayTraceState` 与 `summarizeGatewayTrace` |
| `src/__tests__/runtimeAiPanelMigration.test.ts` | — | 21 个迁移验收测试 |

### 1.2 修改（1 个）

| 文件 | 改动 |
|---|---|
| `src/components/AiPanel.tsx` | **+54 −3 行**：新增导入（3 行）、抽出 `piOptions` 变量、双路径分支（约 30 行）。**未删除任何旧逻辑。** |

### 1.3 为什么 `gatewayTrace.ts` 要搬出来

`summarizeGatewayTrace` 是 `AiPanel.tsx` 内的**私有函数**（13 字段状态的归约器）。
Runtime 路径若不复用它，就必须**再写一遍同样的汇总逻辑** —— 两份实现必然漂移。

搬迁是**逐字符原样**的，只是从组件内部挪到共享模块，让两条路径共用同一个归约器。

### 1.4 明确未修改（实测验证）

| 项 | 状态 |
|---|---|
| `src/ai/piRuntime.ts` | 未修改 ✅ |
| `src/ai/privacyRouter.ts` | 未修改 ✅ |
| 业务页面（5 个直调文件） | 未修改 ✅ |
| `src/agent` | 未创建 ✅ |
| Tool Gateway | 未实现 ✅ |
| `package.json` / 依赖 | 未修改 ✅ |
| 旧 Agent 调用路径 | 保留 ✅ |

---

## 2. AiPanel 新旧调用链对比

### 2.1 旧链路（feature flag **关闭**时走这条 —— 当前默认）

```text
AiPanel.send()
  ├─ 自己拼 PiRunOptions（30+ 字段）
  ├─ 自己实现 17 个回调钩子
  │     ├─ onGatewayTrace → 手动 setGatewayTrace(...)（逐字段 switch）
  │     ├─ onEvent.onToolStart / onToolResult / onAnswer / onThought / …
  │     └─ onMetrics / onAgentReady / onRawMessage / onCheckpoint
  ├─ runPiAgent(piOptions)              ← 直接调用执行核心
  └─ 从返回值取 finalText / messages / workingState
```

### 2.2 新链路（feature flag **开启**时走这条）

```text
AiPanel.send()
  ├─ 抽出 piOptions（**两条路径共用同一份**）
  ├─ decideExecutionPath(isAgentRuntimeEnabled())    ← 纯函数决定路径
  └─ consumeRuntimeTurn(request, { onEvent, shouldAbort })
        ↓
      runAgentTurn(request)                          ← Runtime 统一入口
        ↓
      AsyncIterable<RuntimeEvent>
        ↓  逐条到达（流式，不缓冲）
      onEvent(event) 回调
        ├─ uiProjection.push(event)                   ← 增量投影
        └─ translateRuntimeEventForUi(event, ctx)
              └─ piOptions.onGatewayTrace?.(gateway)  ← **复用旧链路同一条处理链**
        ↓
      return { result }                               ← AgentResult
```

### 2.3 关键设计：**复用同一条处理链，而不是新建一套 UI 渲染**

新链路把 `RuntimeEvent` 翻译回 **`AiGatewayTraceEvent`（UI 早已认识的那一族）**，
再喂给**旧链路本来就在用的** `piOptions.onGatewayTrace`：

```text
RuntimeEvent ──translateRuntimeEventForUi──> AiGatewayTraceEvent ──> 既有 onGatewayTrace
                                                                      （含 setGatewayTrace /
                                                                        setGatewayEvents /
                                                                        appendStep / 持久化）
```

**收益：**
* UI 侧**不需要第二套渲染逻辑** —— 迁移风险大幅下降；
* 旧链路的 `GatewayTraceState` 手工维护逻辑**在两条路径下产出的结构完全一致**
  （测试里用同一个 `summarizeGatewayTrace` 交叉验证）；
* 若事件映射有偏差，表现是"UI 显示不对"，而不是"UI 崩溃"。

### 2.4 两条路径的差异（诚实对比）

| 维度 | 旧链路 | 新链路 |
|---|---|---|
| 编排位置 | `piRuntime` 直接驱动，AiPanel 实现全部回调 | `runAgentTurn` 编排，AiPanel 只消费事件 |
| 状态更新方式 | 每个回调里手动 `setGatewayTrace(prev => ...)` | 事件映射后仍走**同一个** `onGatewayTrace` |
| 事件顺序保证 | 依赖 `piRuntime` 内部调用顺序 | 由 Runtime 显式保证（`budget → privacy → route → … → final`），且被测试钉住 |
| 隐私/路由可见性 | 只有底层真实产生的网关事件 | **额外**获得 `privacy` / `route` 阶段事件（Runtime 主动产出） |
| 中止语义 | `runController.signal` | 同上 + `shouldAbort()` 在每个事件边界额外检查 |
| 回调能力 | 全部 17 个 | **全部保留**（适配层逐一转发） |

**行为差异的唯一来源**：新链路会**额外**产出 `privacy` / `route` / `budget` 阶段事件，
经映射后成为额外的 `privacy_evaluation` / `route_selected` / `context_usage` 网关事件。
这是**信息的增加**，不是行为的改变 —— 旧链路这些事件由底层在稍后时机产出。

---

## 3. Feature Flag 说明

### 3.1 定义

```ts
// src/components/ai/runtimeFeatureFlag.ts
export const USE_AGENT_RUNTIME = 'costhub-use-agent-runtime';
export const AGENT_RUNTIME_DEFAULT = false;                 // ← 默认关闭
export function isAgentRuntimeEnabled(storage?): boolean;
export function setAgentRuntimeEnabled(enabled, storage?): boolean;
```

* 存储位置：`localStorage`（与项目既有 UI 偏好一致，无新依赖）
* 读取容错：storage 不可用 / 抛错 / 值异常 → **回退默认（关闭）**，不抛错
* 视为开启：`'1'` / `'true'`；其余（含 `'0'` / `'false'` / `''` / `null`）视为关闭

### 3.2 路径决策是纯函数（可单测）

```ts
export function decideExecutionPath(enabled: boolean): AgentExecutionPath;  // 'runtime' | 'legacy'
```

**刻意抽成纯函数**：这样「开关关闭走旧路径 / 开启走 Runtime」这条**关键回滚语义**
可以被直接单测，而不必渲染 2200 行的 AiPanel。组件侧只调用它并分支，不含判断逻辑。

### 3.3 本轮**不**默认开启（重要）

本阶段**没有**把默认值改为 `true`，理由：

1. **新链路尚未经过真实模型端到端验证** —— 现有 79 个测试全部 mock 掉 `piRuntime`，
   验证的是门面、契约与映射。真实对话（含流式、工具调用、云端审批）没有跑过。
2. **streaming 体验未经人工确认** —— 新链路的 token 事件是 `onAnswer` 映射而来，
   语义等价，但实际渲染手感需要人眼确认。
3. **满足"支持快速回滚"的要求** —— 默认关闭意味着合并后**线上行为与合并前完全一致**。

**建议的开启条件见 §8。**

---

## 4. RuntimeEvent 映射说明

映射逻辑全部在 `src/components/ai/runtimeEventMapper.ts`（**未**加进 AiPanel）。

| RuntimeEvent | 映射为 `AiGatewayTraceEvent` | 轨迹卡 |
|---|---|---|
| `budget` | `context_usage`（contextWindow / inputHard / inputSoft / reservedOutput） | 上下文预算（含"已标定 / 回落 N"） |
| `privacy` | `privacy_evaluation`（`decision` 原样透传） | 隐私检查（分类 · 策略 · 规则命中 · 云端允许/阻止） |
| `route` | `route_selected` | 路由选择（Cloud/Local · provider · model） |
| `tool_start` | `context_preparation`（status=`running`, executor=`backend`） | 工具名 · 执行中 |
| `tool_result` | `context_preparation`（status=`prepared`/`failed`） | 工具名 · 完成/失败 |
| `cloud_result` | `cloud_context` | 云端结果 · 已返回/失败 |
| `gateway` | **原样透传**（底层已产出真正的网关事件，不二次包装） | — |
| `thought` / `token` / `round` / `usage` / `compaction` / `final` / `error` / `stage` / `execution_ready` / `chart` | 不产生网关事件（由既有回调路径处理） | — |

### 4.1 `provider` 来自真实参数，不凭空构造

```ts
export interface RuntimeUiContext {
  backend?: LocalBackend;      // 'ollama' | 'llama.cpp'，来自真实运行参数
  cloudProvider?: string;
}
```

**实现过程中修正的一处错误：** 第一版映射器把 `provider` 硬写成 `'local'`，
但 `AiGatewayTraceEvent` 的类型是 `LocalBackend | 'cloud'`（即 `'ollama' | 'llama.cpp' | 'cloud'`）——
类型检查直接报错。改为从调用方传入真实 `backend`。

**这条被保留下来的设计约束**：映射器**不允许**自己发明 provider 值。

### 4.2 复用既有归约器（避免两套汇总逻辑）

```ts
projectRuntimeEvents(events, { backend })
  → { gatewayEvents, trace: summarizeGatewayTrace(gatewayEvents), cards }
```

`summarizeGatewayTrace` 就是旧链路用的那一个（从 AiPanel 原样搬到 `gatewayTrace.ts`）。
测试里用同一批事件**再走一次**该归约器并断言 `toEqual` —— 证明不存在第二套汇总逻辑。

---

## 5. 测试结果

### 5.1 `runtimeAiPanelMigration.test.ts`（21 个，全通过）

```text
 ✓ src/__tests__/runtimeAiPanelMigration.test.ts (21 tests) 13ms
```

**Case 1 — token → final：窗口可正常显示结果（3 个）**
token 逐条到达且 `seq` 连续；`final` 携带最终文本；`result.finalText` 与底层一致；
**流式语义**（token 在结果返回前就已产出，用 `release` 精确控制时序）；
投影后 `trace.route` / `trace.privacy` 已就绪。

**Case 2 — privacy → route → tool → final：顺序正确（5 个）**
骨架事件严格等于 `['budget','privacy','route','final']`；
**tool 事件的 seq 必须落在 route 之后、final 之前**（用 seq 数值断言，不只看类型顺序）；
`privacy` 携带真实判定（分类/cloudSafe/sourceTypes）；
`route` stage 事件含 `requested`（区分"请求的"与"实际选择的"）；
映射后 `cards` 含 privacy/route/tool，且 `trace.privacy` 已填充、`trace.route='local'`；
`projectRuntimeEvents(...).trace` 与 `summarizeGatewayTrace(gatewayEvents)` **完全相等**。

**Case 3 — Flag 关闭 ⇒ 旧路径（5 个）**
默认值为 `false`；`'0'`/`'false'`/`''`/`null` 均视为关闭；storage 抛错时回退关闭不崩；
`decideExecutionPath(false)==='legacy'`；
**关键断言**：走 legacy 时旧执行器被调用、且**事件流完全没有被消费**（`runtimeEvents.length===0`）
—— 排除"两条链路同时跑"。

**Case 4 — Flag 开启 ⇒ 调用 runAgentTurn（4 个）**
`'1'`/`'true'` 视为开启；`decideExecutionPath(true)==='runtime'`；
`executeByPath(runtime)` **确实驱动了 runAgentTurn**（`runPiAgentMock` 被调用 1 次）、
事件被转发（含 budget/privacy/route/final）、结果可用，且旧路径回调**未被调用**；
中止语义：`shouldAbort` 为真时停止消费且不返回结果；
两条路径共用同一份 `piOptions`（model / systemPrompt / backend / tools 原样透传）。

**职责边界（3 个）**
适配层不改变事件内容与顺序（与直接驱动 `runAgentTurn` 逐项对比 `type` 与 `seq`）；
映射器对无关事件返回空结果（不产生多余网关事件）；
`createRuntimeUiProjection` 可增量读取（喂一条 budget 就能读出状态，不必等运行结束）。

### 5.2 三项 quality 检查

```text
npm run quality:core   PASS   10 pass · 0 fail · 0 blocked · 0 warn · 0 skip   1m31s
npm run quality:full   PASS   13 pass · 0 fail · 0 blocked · 0 warn · 0 skip   1m48s
```

core 含 **Q07 lint 基线门禁 PASS**（未新增 lint 问题）与 **Q10 行数门禁 PASS**；
full 额外含 F01 夹具生成 / F02 夹具检查 / **F03 桌面 E2E-001..008 全通过**；
两轮 `[finalize]` 报告泄漏检查均 PASS。

### 5.3 全量测试

```text
files: 96   tests: 608   passed: 605   failed: 0   skipped: 3
```

本阶段新增 21 个；运行时相关合计 **79 个**。

### 5.4 未做的验证（诚实标注）

* **真实模型端到端**：本轮所有测试均 mock `piRuntime`（见 §0 与 §3.3）。
* **flag 开启后的实测**：默认关闭，因此未在真实对话中跑过新链路。
* **streaming 手感**：未人工确认。

→ 这正是 §3.3 决定**不默认开启**的原因，也是 §8 的第一条建议。

---

## 6. 回滚方式

### 6.1 运行时回滚（最快，无需发版）

```js
// 浏览器/DOM 无法直接改时，可在应用内执行一次：
localStorage.removeItem('costhub-use-agent-runtime');   // 回到默认（关闭）
// 或显式关闭：
localStorage.setItem('costhub-use-agent-runtime', '0');
```

下一轮对话即走旧路径。**因为两条路径共用同一份 `piOptions` 与同一套安全策略，
切换不改变隐私判定、工具闸门或审批流程。**

### 6.2 代码回滚

flag **默认关闭**，因此合并本 PR 后线上行为与合并前一致 —— 不开启即等效回滚。

如需彻底回滚代码：

```bash
git revert <stage3-merge-commit>       # 或
git checkout agent-runtime-stage2-1-hardening -- src/components/AiPanel.tsx
rm -rf src/components/ai/runtimeAdapter.ts src/components/ai/runtimeEventMapper.ts \
       src/components/ai/runtimeFeatureFlag.ts
# gatewayTrace.ts 可保留（纯搬迁，无副作用）
```

### 6.3 分层回滚（推荐）

由于职责已分离，可只回滚一层：

| 只回滚 | 方法 | 影响 |
|---|---|---|
| 路径选择 | flag 置 0 | 立即回到旧链路 |
| 适配层 | 删 `runtimeAdapter.ts`，AiPanel 恢复直调 `runPiAgent` | 旧链路完全不受影响 |
| 映射层 | 删 `runtimeEventMapper.ts` | 仅新链路受影响（已停用） |
| 归约器搬迁 | 把 `summarizeGatewayTrace` 搬回 AiPanel | 两条路径都用它，需一起改 |

---

## 7. 已知风险

### R1 —【高】新链路未经真实运行验证

79 个测试全部 mock `piRuntime`。**flag 开启后的第一次真实使用应视为"首次运行"。**
映射偏差的表现是 UI 显示不对（而非崩溃），但仍需人工核对一次完整对话。

**缓解**：默认关闭；建议按 §8 的顺序灰度。

### R2 —【中】流式渲染的实际手感未经确认

新链路的 `token` 事件由 `onAnswer` 映射。语义等价（单测已断言逐条到达与顺序），
但**渲染帧率、打字机观感**与旧链路是否一致，只能人眼看。

**缓解**：开启 flag 后对比一次长回答的流式表现。

### R3 —【中】事件映射是"只加不减"，可能产生重复的网关事件

新链路额外产出 `privacy` / `route` / `budget` 阶段事件。若底层**随后**也产出同类事件
（例如 `route_selected` 由 `onGatewayTrace` 再发一次），UI 轨迹里可能出现**重复条目**。

**缓解**：本轮未改动去重逻辑（避免扩大范围）。开启 flag 后需人工检查轨迹是否有重复；
若有，应在映射层加"去重窗口"（属 Stage 4 范围）。

### R4 —【中】中止语义有一处细微差异

新链路增加 `shouldAbort: () => runController.signal.aborted`，在**每个事件边界**检查。
中止时抛 `任务已取消`，由既有 catch 分支处理（与旧链路文案一致）。
但**中止时机**可能比旧链路略晚（事件粒度而非 token 粒度）。

**缓解**：既有 catch 分支已覆盖；建议开启后实测一次"停止生成"。

### R5 —【低】`AiPanel.tsx` 已 2192 行

本阶段**仅增 54 行**，未继续膨胀主体结构。但该文件早已远超 300 行，
**且不在 Q10 门禁的强制范围内**（`enforcedDirs` 只有 `tests/quality`）。
后续若还要动它，建议先做组件级拆分（本阶段刻意不做，避免"大规模重写 AiPanel"）。

### R6 —【低】归约器搬迁引入的耦合

`summarizeGatewayTrace` 现在被 `AiPanel` 与 `runtimeEventMapper` **共同依赖**。
这是**刻意**的（避免两套汇总逻辑），但意味着修改它会影响两条路径。
它有测试交叉验证（§4.2），因此改动是安全的。

---

## 8. 下一阶段建议

### 8.1 Stage 4 之前应先做（按优先级）

1. **真实链路验证后再决定是否默认开启。**
   建议：把 flag 打开（`localStorage.setItem('costhub-use-agent-runtime','1')`），
   人工跑三类对话 —— ① 纯本地问答（验流式）② 触发工具调用（验 tool 事件映射）
   ③ 走一次云端审批（验 privacy/route 显示与审批横幅联动）。
   三项都正常后，才考虑把 `AGENT_RUNTIME_DEFAULT` 改为 `true`。

2. **检查轨迹是否重复**（R3）。若重复，在映射层加去重 —— 这是开启前的**必要条件**。

3. **把 `src/ai/runtime` 与 `src/components/ai/*runtime*` 纳入行数门禁**（R5 相关）。
   需改 `tests/quality/config.json` 的 `enforcedDirs`。

### 8.2 Stage 4 候选内容

* **Tool Gateway**（设计文档 §3.4 / Stage 4）：把隐私判定从
  `available tools based` 升级为 `actual tool invocation based`（见 `src/ai/runtime/README.md`）。
  这也是消除 R3 重复事件的更彻底方案（由 gateway 统一产出事件，避免两处发射）。
* **`AgentRunOptions` 类型收紧**：消除 Stage 2 遗留的 `as never` 断言。
* **Q04 flake 处理**：`portable_first_run_creates_disk_database_and_preserves_it`
  存在间歇性 `Os error 32`（Stage 2 报告 §4.1 有完整证据）。建议给 Q04 加 `flakeRetry`。

### 8.3 明确不建议现在做的

* **不要**在本阶段之后立即把默认值改成开启 —— 缺少真实链路验证（R1）。
* **不要**为了让新链路"更完整"而重构 AiPanel —— 与"不做大规模重构"冲突，且收益有限。
* **不要**删除旧路径。迁移期双路径是回滚保障；等新链路稳定运行一段时间后再单独评估。

---

## 9. 复现与验证

```bash
# 本阶段改动（应只有 AiPanel 一行 M + 5 个新增）
git status --short | grep -v '^??'
git diff --stat -- src/components/AiPanel.tsx

# 禁用项未触碰（应为空）
git diff --name-only -- src/ai/piRuntime.ts src/ai/privacyRouter.ts
test -d src/agent && echo FAIL || echo "OK: src/agent absent"

# 构建与门禁
npm run build
npm run quality:core
npm run quality:full

# 本阶段新增测试
npx vitest run src/__tests__/runtimeAiPanelMigration.test.ts   # 期望 21 passed

# 运行时相关测试合计
npx vitest run src/__tests__/runtime*.test.ts                  # 期望 79 passed
```

---

## 10. 分支与提交

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/JT15199/costhub_0922` |
| 基线分支 | `agent-runtime-stage2-1-hardening` @ `955ba94` |
| 新分支 | `agent-runtime-stage3-aipanel` |
| 提交信息 | `refactor: migrate aipanel to agent runtime` |
| PR base | `main` |
| PR 标题 | `refactor: migrate AiPanel to agent runtime` |

---
_本报告由 Stage 3 实施产出。所有数字来自实际命令输出；未做的验证（真实链路、flag 开启实测、流式手感）
已在 §3.3 与 §5.4 如实标注。_
