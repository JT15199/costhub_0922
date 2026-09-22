# CostHub AI Gateway + Privacy Router + Context Manager 实施规格书 V2

**用途**：交由 Luna 或其他编码模型，在现有 CostHub + Pi Agent 架构上实施 AI Gateway、隐私路由与上下文管理改造。  
**核心目标**：在不替换 Pi Agent 的前提下，同时解决两个问题：

1. 本地 / 云端 AI 的安全协同与隐私路由；
2. 本地模型上下文短、容易膨胀、默认压缩质量不稳定、长任务后“忘事”的问题。

**最终架构原则**：

> Pi 负责 Agent Runtime；CostHub AI Gateway 负责隐私、模型路由和上下文编排；Session 保存完整历史，模型只看到经过 Context Manager 选择后的“工作上下文”。

---

# 1. 最终结论

## 1.1 不切换 DSH

CostHub 继续使用 Pi Agent 作为 Agent Runtime，不因为 DSH 的 Privacy Router 插件而迁移内核。

DSH Privacy Router 仅作为设计参考，借鉴：

- deterministic rule；
- local classifier；
- `PUBLIC / SENSITIVE / UNKNOWN`；
- `UNKNOWN -> LOCAL`；
- cloud-safe context；
- cloud request reconstruction；
- cloud tools isolation；
- session privacy trace。

## 1.2 新增 CostHub AI Gateway

在 Pi Agent 与真正模型 Provider 之间增加：

```text
CostHub AI Gateway
├── Context Manager
├── Privacy Router
├── Model / Provider Router
├── Cloud Context Builder
├── Local Context Builder
├── Audit / Trace
└── Model Adapters
```

## 1.3 Context Manager 是第一等能力

不要再把“上下文”理解成：

> 把整个聊天记录不断塞给模型，快满了再总结一下。

CostHub 应该把模型上下文改造成：

> **结构化工作状态 + 最近对话 + 按需检索内容 + 压缩后的历史摘要 + 必要工具结果**

完整历史仍然保存在 Session / 本地存储中，但不等于每次都发送给模型。

---

# 2. 当前上下文问题的本质

Pi 自带 Compaction 的总体机制是：

```text
上下文接近上限
    ↓
寻找 cut point
    ↓
保留最近一段消息
    ↓
较早内容生成 summary
    ↓
summary + recent messages 继续运行
```

Pi 当前扩展体系还支持：

```text
session_before_compact
session_compact
context
ctx.getContextUsage()
ctx.compact()
```

因此 CostHub 不需要修改 Pi 内核，可以在 Extension / Gateway 层接管压缩策略。

但 CostHub 不能只依赖通用“聊天总结”，因为成本 Agent 中真正不能丢的是：

- 当前项目是什么；
- 当前任务目标；
- 用户已确认的结论；
- 关键业务事实；
- 关键数字及其来源；
- 当前使用哪些文件 / 表；
- 已完成哪些分析；
- 哪些结论还待验证；
- 当前工具执行状态；
- 用户给出的约束；
- 隐私标签；
- 哪些内容允许上云；
- 下一步是什么。

普通自然语言摘要很容易把这些状态压没。

---

# 3. 最终总体架构

```text
                             CostHub UI
                                │
                                ▼
                           Pi Agent
                  Agent Loop / Tools / Session
                                │
                                ▼
                    ┌──────────────────────┐
                    │   CostHub AI Gateway │
                    └──────────┬───────────┘
                               │
               ┌───────────────┼────────────────┐
               │               │                │
               ▼               ▼                ▼
        Context Manager   Privacy Router   Provider Router
               │               │                │
               │        PUBLIC/SENSITIVE        │
               │          /UNKNOWN              │
               │               │                │
               └───────────────┼────────────────┘
                               │
                     ┌─────────┴─────────┐
                     │                   │
                     ▼                   ▼
                 Local Route         Cloud Route
                     │                   │
              Local Context       CloudSafe Context
                     │                   │
                 Qwen Local          Cloud AI
                     │
                CostHub Tools
```

---

# 4. 一个请求的完整生命周期

推荐执行顺序：

```text
用户输入
   ↓
Pi Agent 收到 User Turn
   ↓
Context Manager 更新 Active Task State
   ↓
构建 Privacy Evaluation Context
   ↓
Privacy Router
   │
   ├─ SENSITIVE / UNKNOWN -> Local
   └─ PUBLIC -> Cloud candidate
   ↓
Provider Router
   ↓
根据目标模型构建不同 Context
   │
   ├─ Local Context Builder
   └─ Cloud Context Builder
   ↓
真正 Provider 调用
   ↓
模型输出 / Tool Call
   ↓
Context Manager 更新状态
   ↓
Trace / UI
```

重点：

**Privacy Router 与 Context Manager 必须协同，但不能混成一个模块。**

---

# 5. Context Manager 的核心设计

Context Manager 维护五类上下文。

```text
┌──────────────────────────────┐
│ 1. Core Instructions         │
├──────────────────────────────┤
│ 2. Structured Working State │
├──────────────────────────────┤
│ 3. Recent Conversation       │
├──────────────────────────────┤
│ 4. Retrieved Context         │
├──────────────────────────────┤
│ 5. Tool / Artifact Context   │
└──────────────────────────────┘
```

---

# 6. Core Instructions

这里只保存真正长期稳定的内容：

```text
CostHub Agent 身份
工具使用原则
安全规则
业务总原则
输出格式约束
Privacy Router 规则
```

不要把当前项目、当前报价、当前任务状态写进长期 System Prompt。

否则：

- System Prompt 越来越长；
- 不容易失效；
- 项目切换容易污染；
- 云端过滤困难。

---

# 7. Structured Working State

这是本次上下文改造最重要的部分。

不要只维护一段自然语言 Summary。

新增结构化状态：

```ts
interface WorkingState {
  sessionId: string;
  activeProject?: ProjectRef;

  currentGoal: string;
  currentTask: string;

  userConstraints: StateItem[];
  confirmedFacts: StateItem[];
  decisions: StateItem[];
  openQuestions: StateItem[];

  activeFiles: FileRef[];
  activeArtifacts: ArtifactRef[];
  activeTools: ToolState[];

  completedSteps: TaskStep[];
  nextSteps: TaskStep[];

  businessContext: BusinessStateItem[];

  lastUpdatedAt: number;
}
```

每个重要条目建议：

```ts
interface StateItem {
  id: string;
  text: string;

  sourceMessageIds: string[];

  sensitivity:
    | "public"
    | "internal"
    | "sensitive"
    | "restricted";

  confidence:
    | "confirmed"
    | "inferred"
    | "temporary";

  status:
    | "active"
    | "superseded"
    | "closed";
}
```

这样模型不会因为“总结了一次”就把关键事实丢掉。

---

# 8. Working State 中应重点保存什么

针对 CostHub：

## Project

```text
项目名称 / 项目代号
当前阶段
当前供应商范围
当前目标
```

## Task

```text
用户当前究竟要解决什么问题
本轮任务和长期任务区别
```

## Constraints

例如：

```text
不可外发
保持现有 UI 风格
只修改某模块
不改 Pi 内核
目标成本已确认
```

## Facts

只保存真正重要事实：

```text
某关键器件当前价格
目标价格
历史基线
业务规则
供应格局
```

每条必须带来源与隐私标签。

## Decisions

例如：

```text
已经确定使用 Pi
已经确定 Privacy Router fail-closed
Cloud tools 禁用
```

## Open Questions

防止模型忘记：

```text
待验证某成本差异原因
待用户确认某方案
```

## Current Plan

明确：

```text
已完成
正在做
下一步
```

---

# 9. Recent Conversation Window

Recent Messages 仍然保留，但不应该无限增长。

建议按 Token 动态维护：

```text
最近若干用户 / assistant turn
+
当前工具调用链
```

原则：

- 当前 User Turn 全保留；
- 当前 Agent Loop 工具链全保留；
- 最近 2～5 个重要 Turn 尽量保留；
- 更早内容进入 Structured State / Summary；
- 重复的 assistant 解释可以优先压缩；
- UI chatter、重复确认、无信息量文本优先淘汰。

不要固定“保留 N 条消息”，应以 Token Budget 为准。

---

# 10. Historical Summary

仍然需要自然语言历史摘要，但它的角色变成：

> “背景补充”

而不是唯一记忆。

建议结构化格式：

```text
## Session Background
...

## Important Decisions
...

## Work Completed
...

## Outstanding Issues
...

## File / Artifact Changes
...

## Relevant Historical Context
...
```

摘要本身也必须带：

```text
summaryVersion
coveredMessageRange
createdAt
sensitivity
```

---

# 11. Tool Result 管理

这通常是 Agent Context 爆炸的主要来源之一。

例如：

```text
读取 3000 行文件
grep 大量结果
数据库返回几百条 BOM
shell 大量日志
```

绝对不要长期把原始 Tool Result 都留在模型工作上下文。

建议：

```text
Tool Result
    ↓
Artifact Store / Local Session 保存完整结果
    ↓
Context Manager 生成：
    - short summary
    - key facts
    - result reference
```

模型 Context 中只保留：

```text
tool: bom_query
result_id: result_xxx

summary:
- 共有 326 个器件
- 主要差异集中在 OC / Power / Structure
- 发现 12 个异常价格

重要项：
...

如需原文，重新调用 result_read(result_id)
```

这样可以极大降低上下文占用。

---

# 12. Artifact / Result Store

建议新增本地结果引用机制：

```ts
interface StoredResult {
  id: string;
  toolName: string;
  createdAt: number;

  fullContentPath?: string;

  summary: string;
  keyFacts: StateItem[];

  sensitivity: DataSensitivity;
}
```

完整结果保留本机。

模型需要时：

```text
result_read(resultId, range/query)
```

按需重新取。

这比不断携带几万 Token 的 Tool Result 更合理。

---

# 13. Context Budget

不要硬编码“一律 128K”。

必须读取当前实际 Provider / Model 的 Context Window。

建议：

```ts
interface ContextBudget {
  contextWindow: number;

  reservedOutputTokens: number;
  safetyMarginTokens: number;

  usableInputTokens: number;
}
```

公式：

```text
usableInputTokens
=
contextWindow
- reservedOutputTokens
- safetyMarginTokens
```

然后在 usableInput 中动态分配：

```text
Core Instructions
Structured State
Recent Messages
Retrieved Context
Tool Context
Historical Summary
```

建议初始策略（不是绝对硬编码）：

```text
Recent Conversation   30~40%
Structured State      15~20%
Retrieved Context     15~20%
Tool Context          10~20%
Historical Summary    剩余
Core Instructions     固定上限
```

如果任务是工具密集型，可提高 Tool Context。

如果任务是长期分析，可提高 Structured / Retrieved Context。

---

# 14. Compaction 不应等到“快爆了”才开始

建立三档水位：

```text
GREEN
< 60%

YELLOW
60% ~ 75%

ORANGE
75% ~ 85%

RED
> 85%
```

具体百分比做配置，不要写死。

### GREEN

正常运行。

### YELLOW

轻量清理：

- 删除重复 Tool Trace；
- 压缩旧 Tool Result；
- 清理低价值 assistant 文本。

### ORANGE

结构化 Compaction：

- 更新 Working State；
- 生成历史摘要；
- 冻结旧 Turn；
- 保留 Recent Window。

### RED

强制 Compaction 后再继续。

如果 Compaction 失败：

```text
不允许静默丢历史
不允许直接截断关键上下文
```

应：

```text
fallback 到更保守的 pruning
+
显示 context warning
```

---

# 15. Pi 自带 Compaction 的处理方式

不要删除 Pi 原有 Compaction。

建议：

> **通过 `session_before_compact` 接管摘要生成结果。**

目标：

```text
Pi 负责：
- Session tree
- Compaction lifecycle
- Compaction entry

CostHub 负责：
- 如何总结
- 什么必须保留
- Working State 更新
```

伪逻辑：

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const state = await contextManager.buildCompactionState({
    preparation: event.preparation,
    branchEntries: event.branchEntries
  });

  return {
    compaction: {
      summary: state.summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details: {
        costhubContextVersion: 1,
        workingStateId: state.workingStateId
      }
    }
  };
});
```

实施时必须根据 CostHub 当前 Pi 版本的真实类型修改。

---

# 16. Context Hook

利用 Pi `context` 事件，可以在每次 LLM 调用前重新组装：

```text
最终模型工作上下文
```

目标不是修改 Session 原始历史，而是：

> 非破坏性地生成当前模型需要的 Context Projection。

例如：

```ts
pi.on("context", async (event, ctx) => {
  const projection =
    await contextManager.buildLocalProjection(event.messages);

  return {
    messages: projection.messages
  };
});
```

注意：

如果采用自定义 `costhub-auto` Provider，也可以由 Gateway 内部统一做 Context Builder。

需要避免“双重裁剪”。

最终只保留一个权威 Context Builder。

---

# 17. Local Context Projection

本地模型可看到：

```text
Core Instructions
+
Working State
+
Recent Messages
+
Relevant Retrieved Context
+
Current Tool Results
+
Historical Summary
```

但即使是 Local，也不要无脑发送完整 Session。

Local Context 应优先保证：

```text
任务连续性
业务事实
当前状态
```

而不是“历史完整性”。

完整历史在本地 Session 中随时可回取。

---

# 18. Cloud Context Projection

Cloud 比 Local 更严格。

只能：

```text
Cloud Safe System Prompt
+
cloudSafe Structured State
+
cloudSafe Recent Messages
+
cloudSafe Retrieved Context
```

且：

```text
tools = []
```

禁止云端看到：

```text
本地完整 Summary
Working State 中的 sensitive item
内部文件信息
Tool Result
BOM / Quote / Cost
Local Tool Definition
```

Context Manager 每个 StateItem 的 sensitivity 标签因此必须与 Privacy Router 共用。

---

# 19. Context Retrieval

为了避免“压缩以后找不回来”，加入按需检索。

Session / State 中的信息即使不在当前模型上下文，也可以重新取回。

建议第一版先使用简单方式：

```text
关键词 / metadata / recency
```

后续再考虑 Embedding。

支持查询：

```text
search_session_context(query)
search_project_state(query)
read_stored_result(resultId)
```

但这些是本地 Tool。

Cloud 不允许访问。

---

# 20. Pin / Critical Context

CostHub 应支持“不可自动压缩丢失”的关键上下文。

例如：

```text
用户明确确认的目标成本
当前项目
安全约束
核心决策
```

可以：

```ts
priority: "critical" | "high" | "normal" | "low"
```

Compaction 时：

```text
critical -> 永远进入 Working State
high -> 优先保留
normal -> 可摘要
low -> 优先淘汰
```

---

# 21. State 更新机制

不要每条消息都重新总结整个 Session。

建议：

```text
每个 Turn 结束
    ↓
State Extractor
    ↓
增量更新 Working State
```

只提取：

```text
new facts
new decisions
new constraints
closed questions
new next steps
```

State Extractor 可以使用本地模型。

必须：

- structured output；
- temperature 0；
- 小 token；
- 失败不影响 Agent 正常回复；
- 不允许修改未被本轮证据支持的已有 confirmed facts。

---

# 22. 冲突与过期信息

Working State 不能只 append。

需要支持：

```text
旧事实 -> superseded
旧决策 -> replaced
任务 -> closed
```

例如：

```text
目标成本原来 420
后来用户明确改成 410
```

不能同时保留为两个 active facts。

应：

```text
420 -> superseded
410 -> active / confirmed
```

并保留 provenance。

---

# 23. Context 与 Privacy 的统一 Metadata

Context Manager 与 Privacy Router 共享：

```ts
interface ContextMetadata {
  sourceType: string;
  sensitivity: DataSensitivity;
  cloudSafe: boolean;
  priority: ContextPriority;
  sourceIds: string[];
}
```

不要各自维护两套 privacy tag。

这非常重要。

---

# 24. Privacy Router

仍采用三级判定：

```text
① Source Policy
② Regex Guard
③ Local Classifier
```

最终：

```text
PUBLIC -> Cloud candidate
SENSITIVE -> Local
UNKNOWN -> Local
```

Privacy Router 详细规则延续上一版规格。

---

# 25. Source Policy

默认敏感：

```text
supplier_quote
supplier_negotiation
bom_database
target_cost
cost_baseline
historical_price
project_database
procurement_data
commercial_strategy
internal_financial_data
local_file
private_workspace
```

命中：

```text
SENSITIVE
```

分类模型不能降级。

---

# 26. Regex Guard

至少：

```text
Private Key
API Key
Bearer Token
Password
Email
Phone
Local Path

供应商
报价
成本
目标成本
底价
BOM
料号
项目编号
成本基线
议价
历史最低价
内部敏感词
```

命中：

```text
LOCAL
```

Regex 不能直接判 Public。

---

# 27. Local Privacy Classifier

仅在：

```text
Source Policy Pass
+
Regex Pass
```

后运行。

输出：

```json
{
  "classification": "public | sensitive | unknown",
  "reasonCode": "..."
}
```

任何错误：

```text
UNKNOWN -> LOCAL
```

---

# 28. Provider Router

Pi 只看到：

```text
provider = costhub
model = costhub-auto
```

Gateway 决定：

```text
LOCAL
或
CLOUD
```

Pi 不负责隐私决策。

---

# 29. Cloud Request 必须重新构造

不能把 Pi 完整 Context 直接转发。

必须：

```text
Context Manager
    ↓
CloudSafe Projection
    ↓
Privacy Router 最终确认
    ↓
Cloud Provider
```

Cloud：

```text
tools = []
```

Cloud Tool Call：

```text
立即拦截
不得执行
```

---

# 30. Context 可视化

这次 UI 不只显示 Privacy，也建议显示 Context 健康状态。

AI 协作窗顶部：

```text
本地模型在线
隐私路由已开启
上下文 18.2K / 32K
```

展开：

```text
Context
├─ 核心指令        2.1K
├─ 工作状态        3.4K
├─ 最近对话        6.8K
├─ 检索内容        2.7K
├─ 工具上下文      2.0K
└─ 输出预留        8K
```

压缩发生时：

```text
✓ 上下文整理
  ├─ 压缩旧对话 14.3K → 3.1K
  ├─ 保留关键事实 12 条
  ├─ 保留决策 4 条
  └─ 原始历史仍保存在本地
```

不要显示：

```text
“系统偷偷删掉了你的聊天”
```

而应明确：

> 工作上下文已整理，完整历史仍保存在本地。

---

# 31. Privacy + Context 综合 Trace

例如一次公开请求：

```text
✓ 上下文准备
  ├─ 工作状态 3.2K
  ├─ 最近对话 5.8K
  └─ 检索 1.4K

✓ 隐私检查
  ├─ Source Policy：PASS
  ├─ Regex：PASS
  └─ Classifier：PUBLIC

✓ 云端上下文重建
  ├─ 发送 2 条 Public 消息
  ├─ 本地保留 11 条
  └─ Tools 0 个

● Cloud AI
```

敏感请求：

```text
✓ 上下文准备
✓ 隐私检查
  └─ Source Policy：SUPPLIER_QUOTE

● Local Qwen
  └─ 完整本地业务上下文

🔒 外发 0 次
```

---

# 32. Context 安全不可变量

除了 Privacy Invariants，再新增：

## context-01

```text
完整 Session != 当前模型 Context
```

## context-02

```text
Compaction 不删除本地原始 Session
```

## context-03

```text
critical Working State 不允许因普通压缩被丢弃
```

## context-04

```text
Tool 大结果必须允许脱离活跃 Context 存储
```

## context-05

```text
Cloud Projection 不能继承 Local Projection
```

必须重新构建。

## context-06

```text
sensitive StateItem
=> cloudSafe = false
```

## context-07

```text
State 更新不能无证据覆盖 confirmed fact
```

## context-08

```text
Context compaction error
=> 不得改为发送完整 Session 到 Cloud
```

---

# 33. 推荐目录结构 V2

```text
src/
├── agent/
│   └── pi/
│       ├── runtime.ts
│       ├── provider-registration.ts
│       ├── compaction-extension.ts
│       └── session-adapter.ts
│
├── ai-gateway/
│   ├── index.ts
│   ├── types.ts
│   ├── config.ts
│   │
│   ├── context/
│   │   ├── context-manager.ts
│   │   ├── budget.ts
│   │   ├── working-state.ts
│   │   ├── state-extractor.ts
│   │   ├── recent-window.ts
│   │   ├── summary.ts
│   │   ├── tool-result-store.ts
│   │   ├── retriever.ts
│   │   ├── local-context-builder.ts
│   │   └── cloud-context-builder.ts
│   │
│   ├── privacy-router/
│   │   ├── index.ts
│   │   ├── source-policy.ts
│   │   ├── regex-engine.ts
│   │   ├── classifier.ts
│   │   ├── classifier-prompt.ts
│   │   ├── policy-engine.ts
│   │   ├── decision-cache.ts
│   │   └── audit.ts
│   │
│   ├── providers/
│   │   ├── local-provider.ts
│   │   ├── cloud-provider.ts
│   │   └── provider-router.ts
│   │
│   └── trace/
│       ├── events.ts
│       └── event-bus.ts
│
└── ui/
    └── ai-trace/
        ├── PrivacyStatus.*
        ├── PrivacyTrace.*
        ├── ContextStatus.*
        ├── ContextTrace.*
        └── ContextDetail.*
```

---

# 34. 配置建议

```ts
interface CostHubAIConfig {
  privacy: {
    enabled: boolean;
    failClosed: true;

    sensitiveTerms: string[];
    sensitiveSources: string[];

    classifierProvider: string;
    classifierModel: string;

    debugLogSensitiveContent: false;
  };

  context: {
    enabled: boolean;

    reserveOutputTokens: number;
    safetyMarginTokens: number;

    warningRatio: number;
    compactRatio: number;
    criticalRatio: number;

    recentTargetRatio: number;

    preserveCriticalState: true;
    storeFullToolResultsLocally: true;
  };

  routing: {
    localProvider: string;
    localModel: string;

    cloudProvider: string;
    cloudModel: string;

    cloudToolsEnabled: false;
  };
}
```

安全默认值：

```text
failClosed = true
debugLogSensitiveContent = false
cloudToolsEnabled = false
preserveCriticalState = true
```

---

# 35. 改造阶段（新版）

---

## Phase 0：只读摸底

Luna 不改代码。

输出：

### Pi

- Pi 版本；
- Agent 初始化位置；
- Provider 注册位置；
- Local Model 调用路径；
- Session 数据结构；
- Context Window 获取方式；
- 当前 compaction 配置；
- 当前是否使用 Pi 自动 compaction；
- 是否已使用 `context` hook；
- 是否已使用 `session_before_compact`；
- Tool Result 如何进入 Session。

### CostHub

- 当前 AI 协作窗；
- 当前 Agent Trace；
- 项目上下文来源；
- BOM / Quote / Cost 工具；
- 数据是否已有 sensitivity metadata。

### 输出

- 推荐接入点；
- 修改文件清单；
- 当前最大的 Context 浪费来源；
- Phase 1 最小实施方案。

禁止写代码。

---

## Phase 1：统一 AI Gateway 骨架

只做：

```text
Pi
↓
CostHub AI Gateway
↓
原 Local AI
```

所有行为保持现状。

建立：

```text
types
config
provider abstraction
trace abstraction
```

不做隐私、不做压缩。

---

## Phase 2：Context 可观测性

在改变行为前，先能测量。

实现：

```text
contextWindow
currentTokens
systemTokens
messageTokens
toolResultTokens
reservedOutput
```

UI / Log 能显示：

```text
Context Usage
```

并找出 Token 最大来源。

这一阶段不压缩。

---

## Phase 3：Tool Result Store + Context Builder

先解决最容易爆 Context 的内容。

实现：

```text
大 Tool Result
↓
本地完整存储
↓
摘要 + resultId 进入模型 Context
```

建立 Local Context Builder。

现有 Session 不删除。

---

## Phase 4：Structured Working State

实现：

```text
Working State
State Extractor
priority
sensitivity
provenance
superseded
```

每 Turn 增量更新。

要求测试：

```text
重要决策不会压没
旧事实可被新事实替代
confirmed fact 不被无证据覆盖
```

---

## Phase 5：接管 Compaction

接入 Pi：

```text
session_before_compact
session_compact
ctx.getContextUsage
ctx.compact
```

实现分级：

```text
prune
structured summary
recent window
working state preservation
```

这一阶段完成后，验证长会话稳定性。

---

## Phase 6：Privacy Router

加入：

```text
Source Policy
Regex
Local Classifier
PUBLIC/SENSITIVE/UNKNOWN
```

所有请求仍可先默认 Local，验证安全判定。

---

## Phase 7：Cloud Route

实现：

```text
CloudSafe Context Builder
approved messages
Cloud system
tools=[]
```

只允许 Public。

---

## Phase 8：完整 UI Trace

合并显示：

```text
Context Preparation
Privacy Check
Route
Provider
Outbound Count
Compaction
```

---

## Phase 9：综合安全 / 长会话测试

至少模拟：

```text
50 turn
100 turn
大量 Tool Call
大 BOM Result
多次 Compaction
项目切换
事实更新
Privacy Public/Sensitive 切换
Classifier Failure
Cloud Failure
Local Failure
```

检查：

- 任务连续性；
- 关键事实保持；
- Context Token；
- Cloud Payload；
- 敏感数据；
- Tool Result；
- Trace。

---

# 36. 长会话验收测试

建立一个自动测试 / scripted scenario。

例如：

### Turn 1

```text
项目 A，目标成本 400，供应商 X。
```

### Turn 10

修改：

```text
目标成本改成 390。
```

### Turn 20

大量 BOM Tool Result。

### Turn 30

完成第一轮方案。

### Turn 40

切换一个子任务。

### Turn 50

询问：

```text
“当前项目目标是什么？之前确认了哪些策略？还有哪些没完成？”
```

模型应该正确回答：

```text
390
不是 400
已确认策略...
待办...
```

即使已经发生多次 Compaction。

这是比“上下文没有爆”更重要的验收标准。

---

# 37. Token 压缩验收

同一测试场景：

记录：

```text
raw session tokens
active context tokens
working state tokens
recent tokens
tool tokens
summary tokens
```

目标不是追求最低 Token，而是：

```text
Active Context 长时间稳定在安全区
+
关键状态召回正确
```

避免：

```text
为了节省 Token 把业务事实压没
```

---

# 38. Luna 必须遵守的修改规则

## Rule 1

不要替换 Pi。

## Rule 2

不要修改 Pi 上游源码。

优先：

```text
Custom Provider
Extension Hook
session_before_compact
context
before_provider_request
```

## Rule 3

先测量 Context，再修改 Context。

## Rule 4

完整 Session 永远本地保留。

Compaction 只改变“模型工作上下文”，不等于删除历史。

## Rule 5

不要只做一个普通 conversation summary。

必须实现 Structured Working State。

## Rule 6

不要把大 Tool Result 永久塞在 Active Context。

## Rule 7

Context Manager 与 Privacy Router 必须共享 sensitivity / cloudSafe metadata。

## Rule 8

Cloud Context 重新构建，不能复用 Local Context。

## Rule 9

任何安全失败 fallback Local。

## Rule 10

任何压缩失败不得静默删除 critical state。

## Rule 11

每 Phase 完成：

```text
停止
运行测试
报告修改
报告风险
等待审核
```

不得自动继续下一阶段。

---

# 39. 给 Luna 的新版第一条 Prompt

将此文件保存为：

```text
docs/COSTHUB_AI_GATEWAY_CONTEXT_PRIVACY_SPEC.md
```

然后发送：

```text
请完整阅读 docs/COSTHUB_AI_GATEWAY_CONTEXT_PRIVACY_SPEC.md。

当前只执行 Phase 0：只读摸底，不允许修改任何代码。

除了 Privacy Router，请特别调查 CostHub 当前 Pi Agent 的上下文管理和压缩机制。

必须回答：

1. 当前使用的 Pi 具体版本是什么？
2. Pi Agent 初始化入口在哪里？
3. 当前 Local Model Provider 调用链是什么？
4. 当前模型实际配置的 contextWindow 是多少？从哪里读取？
5. 当前是否开启 Pi auto compaction？
6. reserveTokens / keepRecentTokens 当前值是什么？
7. 当前是否使用 session_before_compact / context / before_provider_request 等 Hook？
8. 当前 Session 中 Tool Result 是如何保存并重新送入模型的？
9. 当前一次典型请求里，System Prompt、历史对话、Tool Result 各自大约占多少 Token？
10. 哪些内容是当前 Context 膨胀最大的来源？
11. 当前 Compaction 生成的 summary 是什么格式？是否可能丢失任务状态、关键数字、文件状态或业务约束？
12. 当前项目上下文、BOM、成本、报价分别通过什么方式进入 Context？
13. 实现 CostHub AI Gateway、Context Manager、Privacy Router 的最小接入点分别在哪里？
14. 列出预计新增和修改的文件。
15. 给出 Phase 1 的最小改造计划。

要求：
- 不写代码；
- 不修改文件；
- 不修改 Pi；
- 不假设 API，必须检查当前项目依赖、类型定义和 Pi 版本；
- 如果发现现有 CostHub 已经实现了类似机制，要指出并尽量复用；
- 重点指出任何会导致 Context 无限制增长、重复注入或 Compaction 丢失关键信息的问题。

完成 Phase 0 后停止，等待审核。
```

---

# 40. 我们真正要解决的问题

最终目标不是：

```text
“让模型拥有更大的上下文”
```

而是：

```text
“让模型在有限上下文里始终拿到最重要的信息”
```

因此 CostHub 的上下文能力应该从：

```text
Long Chat History
+
Overflow Summary
```

升级为：

```text
Persistent Full Session
       +
Structured Working State
       +
Recent Working Memory
       +
On-demand Retrieval
       +
Compressed Tool Results
       +
Structured Historical Summary
       +
Model-specific Context Projection
```

这才是一套适合长期运行 Cost Agent 的 Context Architecture。

---

# 41. 最终产品架构定位

```text
                    CostHub Agent
                         │
                      Pi Runtime
                         │
                  CostHub AI Gateway
                         │
       ┌─────────────────┼──────────────────┐
       │                 │                  │
       ▼                 ▼                  ▼
Context Manager     Privacy Router     Model Router
       │                 │                  │
       └─────────────────┼──────────────────┘
                         │
               ┌─────────┴─────────┐
               │                   │
               ▼                   ▼
            Local AI            Cloud AI
               │                   │
        Full Local Context      Public Context
        CostHub Tools           No Local Tools
```

一句话：

> **Context Manager 决定模型应该知道什么；Privacy Router 决定什么可以离开本地；Model Router 决定由谁来处理。**

三者共同构成 CostHub AI Gateway。
