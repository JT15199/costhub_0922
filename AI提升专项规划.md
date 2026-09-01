# CostHub AI 提升专项规划

> 供后续 Luna 模型分阶段实施  
> 制定日期：2026-09-01  
> 原则：本地主脑、代码算数、证据可追溯、云端受控、逐步替换、不影响现有使用

## 1. 目标与边界

CostHub 已经具备本地模型、数据库白名单工具、Skill、自动巡检、会话记忆和受控云端桥接。下一阶段不应继续堆零散入口，而应把这些能力收敛成一条可靠分析链：

1. 本地模型理解用户问题和当前页面上下文。
2. 通过受控工具查询本地 SQLite，模型不得直接执行 SQL。
3. 金额、差异、排序、图表数据全部由代码计算。
4. 每条关键结论都能定位到项目、BOM、报价批次或修改历史。
5. 本地资料不足时，可申请云端补充公开知识或做抽象推理。
6. 云端请求必须先脱敏、展示、按条件审批，并由 Rust 网关最终拦截。
7. 建议可被采纳、忽略、转任务和复盘，让数据越多、使用越久越有价值。

本专项不把 CostHub 做成通用聊天机器人，也不让模型取代成本经理做最终决策。AI 的职责是缩短查数、比价、找异常、形成证据和整理报告的时间。

## 2. 当前能力判断

### 2.1 已有优势，应直接复用

- `src/aiTools.ts` 已有项目、BOM、供应商、目标、招标、报告等白名单工具。
- `src/thinkEngine.ts` 已实现本地模型多轮工具调用，并限制轮次和重复调用。
- `src/aiSkills.ts` 与 `public/skills/` 已有报价审核、趋势、BOM、招标等方法雏形。
- `src/aiBridge.ts`、`src/aiRouter.ts`、`src/cloudConfirm.tsx` 已形成“本地提出需求—脱敏—审批—云端—本地综合”的基本路径。
- Rust `cloud_http_request` 已负责 HTTPS 白名单、禁止重定向、请求体检查和 Ollama 出站隔离。
- `ToolResultView` 会从数据库重新计算图表，而不是直接相信模型给出的数字。
- 已有 `ai_think_logs`、`ai_bridge_logs`、`ai_request_logs`、`ai_advisor_insights`、会话、记忆和数据完整度扫描。

### 2.2 当前主要问题

1. **工具结果以文本为主**：模型看到了文字，但 UI、证据和后续计算没有统一数据契约。
2. **读写工具混在一起**：工具文件说明“只读”，实际包含导入、写报告、建待办等写操作，风险等级不清楚。
3. **编排入口重复**：`aiAgent.ts` 与 `thinkEngine.ts` 都在做规划与执行，后续容易出现行为不一致。
4. **指标口径分散**：项目成本、目标差、报价低价等逻辑散落在工具和组件中，可能同问不同数。
5. **实体识别不足**：器件名称、规格、供应商写法和项目代号稍有差异时，模型难以可靠定位。
6. **Skill 只是提示片段**：缺少版本、必需数据、允许工具、输出格式、置信度和停止条件。
7. **上下文压缩会丢证据**：旧轮次被压成普通摘要，后续回答可能失去数据出处。
8. **建议没有闭环**：缺少“采纳/忽略—执行结果—最终降价”的反馈，AI 无法判断哪些建议真正有用。
9. **云端审批仍偏会话态**：缺少持久化授权范围、过期时间、请求哈希和可撤销记录；宽泛自动发送不适合机密成本数据。
10. **没有标准评测集**：无法量化查数正确率、证据覆盖率、泄密拦截率和建议有效率。

结论：当前不是“AI 不够多”，而是“已有能力缺少统一契约和闭环”。先补底座，比先换更大模型更有效。

## 3. 目标架构

```text
用户问题 / 当前页面上下文
          ↓
意图识别 + 实体解析
          ↓
选择 Skill（分析方法）
          ↓
生成受限查询计划
          ↓
本地语义查询工具 → SQLite
          ↓
代码计算指标 + 生成证据引用
          ↓
结果校验器（口径、完整度、置信度）
          ↓
本地模型组织结论和行动建议
          ↓
结构化卡片 / 表格 / 图表 / 深链接
          ↓
采纳、忽略、转待办、复盘结果

本地资料不足时：
本地模型 → 外发清单 → 脱敏审查 → 条件审批 → Rust 网关 → 云端公开知识
                                                   ↓
                                      仅返回本地模型综合
```

### 3.1 不采用的方案

- 不让模型直接连接 SQLite 或自由生成 SQL。
- 不先建设通用向量数据库。结构化成本分析优先使用 SQLite 查询、规则匹配和 FTS5；只有本地文本检索效果不足时再评估本地向量索引。
- 不重写全部现有 AI 文件。用适配器逐步迁移，旧功能在新链路验收前保持可用。
- 不让云端直接分析原始 BOM，即使用户已经批准某个公开查询也不扩大权限。

## 4. 本地数据访问底座

### 4.1 语义查询层

模型只能提交受限查询描述，由代码翻译成固定 SQL。建议接口：

```ts
export interface CostQuerySpec {
  scope: {
    projectIds?: number[];
    category?: string;
    dateFrom?: string;
    dateTo?: string;
  };
  dimensions: Array<
    'project' | 'domain' | 'module' | 'part' |
    'supplier' | 'quote_round' | 'spec_version'
  >;
  metrics: Array<
    'unit_cost' | 'extended_cost' | 'target_gap' |
    'price_delta' | 'quote_low' | 'quote_median' | 'confidence'
  >;
  filters?: Array<{ field: string; op: 'eq' | 'in' | 'gte' | 'lte' | 'contains'; value: unknown }>;
  limit?: number; // 代码强制不超过 200
}
```

约束：

- 维度、指标、过滤字段全部在注册表中声明。
- 参数化 SQL，禁止拼接字段和值。
- 每次查询强制项目范围、最大行数、超时和审计。
- 不允许 `SELECT *`，只返回分析所需字段。
- 官方金额统一使用现有未税人民币口径，数量参与小计；费率只在明确要求整机总价时参与。

### 4.2 统一工具结果

```ts
export interface AiToolResult<T> {
  ok: boolean;
  summary: string;
  data: T;
  evidence: EvidenceRef[];
  warnings: string[];
  freshness: string;
  display?: DisplaySpec;
}

export interface EvidenceRef {
  refType: 'project' | 'bom' | 'part' | 'quote_batch' |
    'quote_line' | 'snapshot' | 'history' | 'target';
  refId: number;
  label: string;
  field?: string;
  value?: string | number;
  observedAt?: string;
  deepLink?: { page: string; params: Record<string, string | number> };
}
```

同一份 `AiToolResult` 同时提供给模型和 UI。`ToolResultView` 不再另查一次数据库，避免文字结论与图表使用两套查询。

### 4.3 工具清单必须声明风险

```ts
export interface AiToolManifest {
  id: string;
  kind: 'read' | 'calculate' | 'write' | 'cloud';
  risk: 'low' | 'medium' | 'high';
  requiresConfirmation: boolean;
  requiredData: string[];
  outputSchema: string;
  evidencePolicy: 'required' | 'optional' | 'none';
  maxRows?: number;
}
```

- 查询类：可自动执行，必须返回证据。
- 计算类：只接收结构化数字，使用确定性算法。
- 写入类：必须展示变更预览并由用户确认；成功后写修改历史。
- 云端类：必须经过脱敏、审批和 Rust 网关。
- 现有 `calc` 的 `new Function` 应替换为受限四则运算解析器，禁止执行任意 JavaScript。

## 5. 让数据越多越有价值

AI 不应仅靠聊天记忆成长，应从可验证的业务数据中成长。

### 5.1 优先沉淀的学习资产

1. 项目规格基线与每次规格变化。
2. 同一项目各轮供应商报价及最终定点结果。
3. 器件“同物料 / 等价 / 可参考 / 不可比”的人工确认。
4. 项目 BOM、目标成本和最终器件级价格。
5. AI 建议是否采纳、实际谈价结果、最终节省金额。
6. 复盘中的成功经验、失败原因和适用条件。

### 5.2 本地特征与匹配

- 先做确定性特征：尺寸、分辨率、刷新率、面板类型、接口、功率、数量、领域和模块。
- 器件匹配采用“规则候选—本地模型判断—人工确认”三层结构。
- 人工确认写入 `part_aliases` / 匹配缓存，下次优先复用。
- 类似项目评分必须展示匹配原因、差异项、样本量和数据时间，不能只给一个相似度数字。
- 历史样本少时明确标记低置信度，不伪装成精确预测。

## 6. 首批高价值 Skills

### 6.1 类似项目预估

输入：新项目规格、目标领域或 BOM 草案。  
输出：3 个最可参考历史项目、相似/不同规格、历史成本区间、调整桥、预估区间、缺失数据。  
价值：CDCP 前期快速形成有依据的预估，不再手工翻历史 Excel。

### 6.2 供应商报价审核与议价排序

输入：当前招标轮次。  
输出：按可争取金额排序的器件、A/B 供应商差异、历史低价、可比性、证据和建议话术。  
规则：只有 exact/equivalent 可直接形成价格锚点；reference 只能提示，unmatched 不计入理论底价。

### 6.3 报价轮次与规格变更归因

输入：两个报价批次或规格版本。  
输出：总价变化拆分为规格变化、数量变化、单价变化、新增/删除物料和不可解释差额。  
价值：避免把规格升级造成的涨价误判为供应商涨价。

### 6.4 目标成本差距诊断

输入：项目与领域目标。  
输出：领域目标达成、主要缺口、可争取项、影响范围和建议处理顺序。  
数字必须由领域成本加和与 `project_targets` 对账。

### 6.5 项目复盘与经验沉淀

输入：项目全过程数据。  
输出：最有效的三项策略、未兑现机会、规格决策影响、供应商表现和可复用检查表。  
用户确认后才能保存为组织经验，不能自动把模型总结当事实。

### 6.6 每日异常简报

输出控制在一屏：今天必须处理、目标异常、报价新变化、数据缺口、可一键进入的项目。  
无异常时明确显示“暂无需要处理”，不为了显得聪明制造建议。

### 6.7 数据质量助手

识别同物异名、规格缺失、异常单价、孤立器件、未关联报价和目标口径问题。修复只生成预览，不自动批量改库。

## 7. 建议与证据闭环

每条建议使用统一结构：

```ts
export interface AiRecommendation {
  title: string;
  conclusion: string;
  evidence: EvidenceRef[];
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  expectedImpact?: { min: number; max: number; currency: 'CNY' };
  action: { label: string; type: 'open' | 'todo' | 'draft' };
  dataGaps: string[];
  risks: string[];
}
```

UI 要求：

- 数字结论旁提供“查看依据”，打开证据抽屉并可跳到对应项目/BOM/报价行。
- 明确区分事实、推断和建议。
- 显示数据截至时间、样本量和置信度来源。
- 支持“有用 / 无用 / 已采纳 / 转待办”。
- 采纳后记录实际结果；后续排序优先参考真实效果，而不是只统计关键词。

## 8. 云端辅助与条件审批

### 8.1 权限等级

| 等级 | 内容 | 默认行为 |
|---|---|---|
| L0 | 本地数据库查询、本地计算、本地模型推理 | 自动执行并审计 |
| C1 | 通用物料/品类的公开行情、技术趋势 | 审查后按主题审批 |
| C2 | 不含标识和原值的区间化、归一化抽象特征 | 每次预览并明确审批 |
| 禁止 | 原始 BOM、项目代号、供应商、型号、金额、报价文件、数据库片段 | 永不外发 |

C2 不是首期必做。第一阶段只完善 C1；确有抽象推理价值时再实施 C2。

### 8.2 简单且可靠的审批交互

审批卡只显示用户需要判断的内容：

- 为什么需要云端。
- 将发送的完整 JSON。
- 已删除或泛化的字段摘要。
- 目标服务、模型、用途和授权有效期。
- 按钮：仅本次允许 / 本主题 30 分钟内允许 / 拒绝。

禁止宽泛的永久自动批准。允许自动发送的唯一情况是用户已批准且未过期的 C1 精确主题范围。

### 8.3 双重强制

前端审查不构成最终安全边界。Rust 网关必须校验：

- 授权记录存在且未过期。
- 请求 payload 哈希与批准时完全一致。
- 域名和模型在白名单。
- HTTPS、禁止重定向、请求大小受限。
- 字段清单与脱敏规则均通过。

本地审计至少记录时间、用途、目标、模型、授权范围、payload 哈希、字段清单和结果状态；审计中不重复保存原始敏感值。

## 9. 推荐目录结构

不要一次性搬空现有文件。先新增最少目录，用适配器逐个迁移：

```text
src/ai/
  contracts.ts              # 工具、证据、建议和分析请求类型
  orchestrator.ts           # 唯一编排入口
  toolRegistry.ts           # 现有工具注册与风险声明
  semantic/
    querySpec.ts            # 受限查询描述与校验
    metricRegistry.ts       # 成本口径与确定性计算
    entityResolver.ts       # 项目/器件/供应商解析
  skills/
    registry.ts             # Skill 版本与装载
    definitions/            # 本地 Skill 定义
  verifier.ts               # 数字、证据、完整度校验
  cloud/
    releasePolicy.ts        # 外发等级与字段规则
    approvalClient.ts       # 审批调用
  eval/
    fixtures/               # 脱敏固定测试数据
    scorer.ts

src/components/ai/
  RecommendationCard.tsx
  EvidenceDrawer.tsx
  DataGapCard.tsx
  ApprovalPreview.tsx

src-tauri/src/ai_gateway.rs # 后期从 lib.rs 拆出，首期非必要
```

## 10. 接口定义

```ts
export interface AnalysisRequest {
  question: string;
  pageContext?: { page: string; projectId?: number; selectedIds?: number[] };
  preferredSkill?: string;
}

export interface AnalysisRunResult {
  runId: string;
  answer: string;
  recommendations: AiRecommendation[];
  evidence: EvidenceRef[];
  warnings: string[];
  skillId: string;
  skillVersion: string;
}

export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisRunResult>;
export async function executeStructuredTool(call: ToolCall, context: RunContext): Promise<AiToolResult<unknown>>;
export function verifyRecommendation(input: AiRecommendation, toolResults: AiToolResult<unknown>[]): VerifyResult;
export async function requestCloudRelease(request: CloudReleaseRequest): Promise<CloudReleaseDecision>;
export async function recordRecommendationOutcome(input: RecommendationOutcome): Promise<void>;
```

Skill 定义至少包含：`id`、`version`、适用问题、必需数据、允许工具、分析步骤、输出 Schema、置信度规则、停止条件和推荐 UI。

## 11. 数据库调整

优先复用现有 AI 日志表，不为相同含义重复建表。建议新增或补齐：

- `ai_analysis_runs`：一次完整分析的 Skill、模型、状态、数据指纹、耗时。
- `ai_evidence_refs`：分析结论对应的本地实体引用。
- `ai_recommendations`：结构化建议及状态。
- `ai_recommendation_feedback`：有用性、采纳状态、实际结果。
- `ai_approval_grants`：云端授权范围、哈希、过期时间、撤销时间。
- `ai_egress_audit`：外发字段清单、目标、结果和授权关联。

如现有 `ai_request_logs`、`ai_bridge_logs`、`ai_advisor_insights` 能承载字段，应优先迁移或扩列，不得仅为了命名整齐重复存储。

## 12. Luna 分阶段实施计划

### 阶段 0：契约与风险收口

目标：不改变用户界面和现有回答能力，先让工具有统一边界。

工作项：

1. 建立 `src/ai/contracts.ts` 与工具 Manifest。
2. 给现有工具标记 read/calculate/write/cloud 和确认要求。
3. 保留 `thinkEngine.ts` 作为唯一主编排方向；`aiAgent.ts` 暂做兼容包装，不新增第二套能力。
4. 替换 `calc` 的 `new Function`。
5. 为写工具统一增加确认前置检查，不能只依赖提示词。

验收：现有 AI 功能不退化；所有工具风险可查询；任意写工具均无法绕过确认；四则计算测试通过。

### 阶段 1：结构化结果与证据链

目标：先迁移 5 个最高频只读工具。

首批工具：项目概览、项目 BOM、目标达成、招标分析、修改/成本历史。

工作项：

1. 返回 `AiToolResult`，每个金额带 EvidenceRef。
2. 建立统一成本指标函数。
3. `ToolResultView` 使用同一结果渲染，不再重复查库。
4. AI 回答中的数字没有证据时，由 verifier 阻止作为正式结论展示。

验收：固定测试库中核心金额与直接 SQL 对账 100%；每个数字结论都能打开依据；旧入口仍可用。

### 阶段 2：实体解析与三个核心 Skill

实现：类似项目预估、报价审核/议价排序、报价轮次/规格归因。

验收：模糊项目名可正确解析；低置信匹配要求人工确认；reference/unmatched 不进入理论底价；规格变化与价格变化分开计算。

### 阶段 3：AI 呈现与行动闭环

实现建议卡、证据抽屉、数据缺口卡、页面深链接、采纳/忽略/转待办及结果记录。

验收：用户从建议到原始 BOM/报价不超过 2 次点击；常见五类任务不超过 3 个操作；建议状态重启后保留。

### 阶段 4：云端审批加强

先只完成 C1。把审批范围、payload 哈希、过期和撤销落库，并由 Rust 强制校验。C2 单独评审后再做。

验收：安全测试语料的敏感字段外发为 0；界面预览 JSON 与实际请求逐字节一致；过期、篡改或跨主题请求全部被网关拒绝。

### 阶段 5：效果评测与持续学习

建立本地脱敏评测集，统计查数正确率、证据覆盖率、工具成功率、平均耗时、建议采纳率、实际降本和泄密拦截率。

验收：标准任务工具成功率 ≥95%；核心数值正确率 100%；证据覆盖率 100%；安全外发测试通过率 100%。建议采纳率只作为观察指标，不以诱导用户点击为优化目标。

## 13. 第一张 Luna 实施单

后续模型第一次只执行以下内容，不得直接实现整个规划：

1. 阅读 `CLAUDE.md`、`会话接续说明.md`、本文件、`SECURITY.md`。
2. 盘点 `aiTools.ts` 全部工具，提交风险清单。
3. 新建最少的 `contracts.ts` 和工具 Manifest。
4. 为“项目概览、BOM、目标、招标、历史”增加结构化适配器；底层查询暂复用现有函数。
5. 增加最小测试，验证金额、证据引用、行数限制和写工具确认。
6. 暂不修改 AI 面板 UI，暂不增加数据库表，暂不改云端协议。
7. 完成后停下，给用户展示工具迁移前后示例，再决定是否进入阶段 1 的 UI 改造。

这样可以用最小改动验证方向，避免一次重构导致现有 AI 完全不可用。

## 14. 总体验收标准

- 本地模型永远不能获得自由 SQL 或数据库文件路径。
- 所有正式数字来自代码计算，并可追溯到本地证据。
- 同一个指标在驾驶舱、项目页、AI 回答和报告中口径一致。
- AI 不确定时明确说缺什么数据，不编造。
- 写入、导入、批量修改和生成正式记录前必须确认。
- 云端调用可见、可拒绝、可撤销、可审计；默认无原始本地数据外发。
- 关闭云端后，本地查数、分析、建议和图表仍完整可用。
- 数据增长后，相似项目、报价区间、供应商表现和建议效果会显示更大的样本量与更可靠的置信度。
- 不改变用户现有密码机制、Excel 式 BOM 操作和本地单机使用方式。

## 15. 禁止事项

1. 禁止模型生成并执行任意 SQL。
2. 禁止把数据库、原始 Excel、BOM 行、项目/供应商/型号/金额发送到云端。
3. 禁止模型给出的数字直接写入正式表格或图表。
4. 禁止未确认的 AI 写入、批量修复、导入和删除。
5. 禁止隐藏云端调用或用“已脱敏”替代实际外发预览。
6. 禁止永久、全局、无范围的云端自动批准。
7. 禁止重复建设第二套成本口径、第二套工具注册或第二套编排器。
8. 禁止先引入向量数据库、Agent 框架或新服务，再寻找使用场景。
9. 禁止用建议数量、对话长度代替真实提效。
10. 禁止一次性重写 AI 子系统；每阶段必须可回退并由用户验收。

## 16. 优先级结论

最先做的不是换模型，也不是增加更多 Skill，而是：

1. 统一工具风险和结构化结果。
2. 统一成本口径并补齐证据链。
3. 做类似项目预估、报价审核、变化归因三个高频 Skill。
4. 建议进入采纳与结果闭环。
5. 最后再加强云端抽象推理和长期学习。

做到前三步，本地 27B 即使模型本身不变，也会因为拿到更准确、结构化、有证据的数据而明显更聪明。
