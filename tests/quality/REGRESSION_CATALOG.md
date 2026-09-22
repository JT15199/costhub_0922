# CostHub 回归目录（Regression Catalog）

把已有关键测试登记为**真实事故保护项**。每条回答三件事：

1. 它保护哪个真实故障场景（`incident`）；
2. 哪个测试在跑（`tests`）；
3. 破坏之后会发生什么（`mustNotRegress` / `covers`）。

机器可读版本见 `regression-catalog.json`；本文件是它的人类可读镜像。
两者由 `tests/quality/check-catalog.mjs`（`quality:core` 的 Q11）校验：id 唯一且格式合法、
引用的测试与源文件真实存在、`qualitySteps` 指向真实存在的步骤。**引用悬空会让 core 直接失败**——
这是为了杜绝「报告里写着有保护、实际什么都没跑」的纸面保护。

ID 格式：`REG-<DOMAIN>-<NNN>`

| 域 | 含义 |
|---|---|
| `PRIV` | 隐私路由与正则守卫 |
| `CLOUD` | 云端网关与投影边界 |
| `APPROVAL` | 云端审批队列与放行 |
| `SEARCH` | 搜索查询绑定与轮次策略 |
| `SOURCE` | 来源质量与降级 |
| `STORE` | 大结果引用与上下文策略 |
| `AGENT` | Agent 工具调用与写操作确认 |
| `DB` | 数据库隔离（Harness 自身保护规则） |
| `UI` | 桌面 UI 用户旅程 |

---

## REG-PRIV-001 · 来源敏感时不得上云

* **事故**：早期版本允许本地 classifier 把带来源类型的敏感内容判为 public，报价/BOM 类内容因此存在上云路径。
* **保护**：来源策略必须**早于** classifier 生效。`sourceTypes` 命中 `supplier_quote` / `private_workspace`
  等敏感来源时直接判定 `sensitive` + `cloudSafe=false`，且**不得调用 classifier**。
* **不得回归**：不能被 classifier 强行降级为 public；`classifierUsed` 必须为 `false`。
* **覆盖**：`supplier_quote`、`private_workspace`、BOM、目标成本
* **测试**：`src/__tests__/privacyRouter.test.ts`
* **源文件**：`src/ai/privacyRouter.ts`、`src/ai/security.ts`
* **质量步骤**：Q04 · **严重度**：critical

## REG-PRIV-002 · Regex Guard 不得被绕过

* **事故**：任何被判为 public 的文本都可能上云；一旦正则守卫漏检，API Key / 电话 / 邮箱 / 本地路径会随提示词外发。
* **保护**：命中敏感模式时必须强制 `cloudSafe=false` 且 `reasonCode=regex_guard`；即使 classifier 返回
  public 也不采纳（**fail closed**）。
* **不得回归**：新增模式不得降低既有命中集；public 标签不得覆盖 regex 命中。
* **覆盖**：API Key、Bearer、Password、Phone、Email、Local path、BOM
* **测试**：`src/__tests__/privacyRouter.test.ts`、`src/__tests__/securityPolicy.test.ts`
* **源文件**：`src/ai/security.ts`、`src/ai/safeQuery.ts`
* **质量步骤**：Q04 · **严重度**：critical

## REG-CLOUD-001 · CloudSafe Projection 不得携带本地上下文

* **事故**：网关曾把本地会话上下文与工具列表一并转发给云端 provider，等于绕过隐私路由开了一条旁路。
* **保护**：cloud provider 只能收到 CloudSafe projection；`tools` 必须为空；不得出现 local_file / private workspace 内容。
* **不得回归**：projection 字段集只允许收窄不允许放宽；tools 数组长度必须为 0。
* **覆盖**：cloud projection、tools 为空、local context 隔离
* **测试**：`src/__tests__/cloudGateway.test.ts`、`src/__tests__/aiGateway.test.ts`
* **源文件**：`src/ai/gateway.ts`、`src/ai/cloudProvider.ts`
* **质量步骤**：Q05 · **严重度**：critical

## REG-APPROVAL-001 · 审批后继续当前调用，不应反复确认

* **事故**：批准审批卡后原调用没有继续，用户只能重新发起，于是再次弹出审批——表现为「反复确认、点了没反应」。
* **保护**：审批通过必须**原地续跑原调用**；同一会话同一主题不得重复询问。
* **不得回归**：批准一次即完成该次外发；不得出现第二次相同主题审批。
* **覆盖**：审批续跑、会话级去重
* **测试**：`src/__tests__/materialInsightApproval.test.ts`、`src/__tests__/aiApproval.test.ts`、`src/__tests__/cloudConfirm.test.ts`
* **源文件**：`src/ai/orchestrator.ts`、`src/cloudConfirm.tsx`
* **质量步骤**：Q06 · **严重度**：critical

## REG-SEARCH-001 · Query 与 Rust Gateway 绑定一致

* **事故**：批准的是 `material + question`，实际请求却**追加了额外关键词** →
  Rust 的 `validate_public_query_binding()` 拦截 → 0 source → UI 只显示「公开信息不足」。
  表现为「审批点了也没结果」。
* **保护**：前端构造的查询串必须与审批时展示的 `material + question` **完全一致**；不得在发送阶段追加关键词。
* **不得回归**：`actual query == approved material + approved question`，逐字符相等。
* **覆盖**：query binding、Rust gateway 校验
* **测试**：`src/__tests__/materialInsightApproval.test.ts`、`src/__tests__/nativeSearchSources.test.ts`
* **源文件**：`src/ai/searchQuery.ts`、`src/ai/searchRequest.ts`、`src-tauri/src/lib.rs`
* **质量步骤**：Q05、Q06 · **严重度**：critical

## REG-SEARCH-002 · 搜到来源后不得因后续轮次为空把已有来源丢掉

* **事故**：多轮搜索中后续轮次返回空，覆盖了前面已经拿到的来源，最终结果变成「无来源」。
  **当前代码注释明确记录过该事故。**
* **保护**：来源一旦拿到必须保留；后续轮次为空不得清空既有来源集合。
* **不得回归**：已有来源集合只能增长/合并，不能被空轮次覆盖。
* **测试**：`src/__tests__/materialInsight.test.ts`、`src/__tests__/insightPipeline.test.ts`
* **源文件**：`src/trendService.ts`、`src/ai/nativeSearchSources.ts`
* **质量步骤**：Q02 · **严重度**：high
* **备注**：本轮按实施指导 §17 **不修改** `trendService.ts`；此处仅登记事故，
  保证以后重构时该行为已被测试钉住。

## REG-SOURCE-001 · 垃圾来源必须被过滤

* **事故**：真实出现过垃圾/赌博类站点进入来源列表，被当作物料行情证据。
* **保护**：来源质量过滤必须先于展示与引用；垃圾站点不得进入 sources。
* **不得回归**：已知垃圾域/关键词必须被过滤；过滤后不得因数量不足而回填垃圾来源。
* **测试**：`src/__tests__/nativeSearchSources.test.ts`、`src/__tests__/materialInsight.test.ts`
* **源文件**：`src/ai/sourceQuality.ts`、`src/ai/nativeSearchSources.ts`
* **质量步骤**：Q05 · **严重度**：high

## REG-SOURCE-002 · 全部弱相关来源必须显式降级

* **事故**：把泛行业新闻当成指定物料的直接证据，用户看到的结论没有真实支撑。
* **保护**：当所有来源都弱相关时必须**显式降级结论**（说明证据不足），不得默认当作直接证据。
* **不得回归**：弱相关不得被静默提升为直接证据。
* **测试**：`src/__tests__/nativeSearchSources.test.ts`、`src/__tests__/materialInsight.test.ts`
* **源文件**：`src/ai/sourceQuality.ts`、`src/ai/verifier.ts`
* **质量步骤**：Q05 · **严重度**：high

## REG-STORE-001 · 大结果只能引用，不得把完整结果塞回上下文

* **事故**：大工具结果整段回填上下文，导致上下文爆炸与后续轮次失忆；也放大了外发风险面。
* **保护**：超过阈值的结果进 resultStore，只把引用/摘要回填上下文；完整内容按需取回。
* **不得回归**：回填上下文的长度必须有界；必须带可追溯引用 id。
* **测试**：`src/__tests__/resultStore.test.ts`、`src/__tests__/contextPolicy.test.ts`、`src/__tests__/contextPolicy.failure.test.ts`
* **源文件**：`src/ai/resultStore.ts`、`src/ai/contextPolicy.ts`、`src/ai/contextBuilder.ts`
* **质量步骤**：Q07 · **严重度**：high

## REG-AGENT-001 · 写操作必须确认

* **事故**：Agent 工具直接写库，用户没有确认机会；数据被 AI 擅自改动。
* **保护**：写类工具执行前必须经用户确认；写后必须留审计且可撤销。
* **不得回归**：未确认的写操作不得落库；每次写入必须有审计记录。
* **覆盖**：unsafe-write-confirmation、写审计
* **测试**：`src/__tests__/modelProfile.test.ts`、`src/__tests__/harnessPhases.test.ts`、`src/__tests__/aiTools.test.ts`
* **源文件**：`src/aiTools.ts`、`src/thinkEngine.ts`、`src/components/AiPanel.tsx`
* **质量步骤**：Q08 · **严重度**：critical

## REG-DB-001 · 测试绝不能写正式数据库

* **事故**：**Harness 自身的风险**。桌面 E2E 若连到开发机/用户的正式 `costhub.db`，
  测试会污染真实成本数据。
* **保护**：桌面 E2E 只能使用 fixture 副本；启动前必须**证明**
  （basename + 目录特征 + fixture marker + `integrity_check`），
  证明不出即 **ABORT**——不允许「大概率不是正式库所以继续」。
* **不得回归**：`dbGuard` 的拒绝路径不得被放宽；fixture marker 缺失必须导致 ABORT。
* **覆盖**：fixture marker、integrity_check、正式库隔离
* **测试**：`tests/quality/self-check.mjs`、`tests/quality/desktop/prepare-fixture.mjs`
* **源文件**：`tests/quality/helpers/dbGuard.mjs`
* **质量步骤**：Q10、F01、F03 · **严重度**：critical

## REG-UI-001 · 桌面关键用户旅程不因单个函数正确而整体失败

* **事故**：函数级测试全绿但真实 UI 组合链路失败
  （启动 → 登录 → 导航 → BOM → AI 窗），无人发现。
* **保护**：真实 WebView2 + CDP 走通 E2E-001..008；未 allowlist 的未捕获异常 /
  unhandled rejection / React fatal 必须让 E2E **FAIL**。
* **不得回归**：runtime error 断言不得被粗暴 allowlist（禁止 `ignore all console.error`）。
* **覆盖**：启动、登录、导航、BOM 只读、AI 窗、设置、重启持久化、DB 隔离
* **测试**：`tests/quality/desktop/run-e2e.mjs`
* **源文件**：`tests/quality/desktop/cdpClient.mjs`
* **质量步骤**：F03 · **严重度**：high

---

## 覆盖统计

| 域 | 条目 |
|---|---|
| PRIV | 2 |
| CLOUD | 1 |
| APPROVAL | 1 |
| SEARCH | 2 |
| SOURCE | 2 |
| STORE | 1 |
| AGENT | 1 |
| DB | 1 |
| UI | 1 |
| **合计** | **12** |

---

## 新增事故的流程（强制）

```text
Bug
 ↓ 先写失败测试
 ↓ 确认测试在旧代码 FAIL
 ↓ 修代码
 ↓ 测试 PASS
 ↓ 加入 regression-catalog.json（REG-<DOMAIN>-<NNN>）
 ↓ 以后每次 quality:core 自动跑
```

**禁止**：发现 Bug → 直接改代码 → 手工点一下 → 说修好了。

**也禁止**（实施指导 §24，为了让测试变绿而作弊）：

```text
把 failing test 注释掉 / 删除
把 expect 改成永远为真
catch 后吞异常
把失败状态改成 warning
把 required step 移出 core
用 mock 替代本来要测的真实函数
为了通过测试直接跳过业务逻辑
```

如果现有测试**真的写错了**，必须：① 解释测试为什么错；② 给出代码证据；③ 单独修改；④ 在报告中列出。
