# CostHub 分析成果与工作手账重构实施方案

> 状态：待实施  
> 编写日期：2026-09-02  
> 目标版本：基于当前 CostHub 2.3.19 工作区继续演进  
> 最终交付：功能代码、迁移兼容、自动化测试、前端构建及免安装 `src-tauri/target/release/costhub.exe`

## 1. 背景与问题

当前 `分析成果` 将 AI 对话保存结果、项目分析、报价审价、卖点分析、物料趋势和 AI 建议合并为同一种卡片。不同成果的数据结构、阅读方式和业务对象完全不同，统一卡片导致信息混杂、难以查找，也无法呈现物料分解树等专用分析结构。

当前 `工作手账` 已具备便签、待办、项目标签、时间范围筛选和本地模型总结能力，但页面仍以“便签 + 待办 + 弹窗总结”为主，不能完整表达心得、关键决策、项目经历、成果证据和绩效贡献。

本次重构坚持以下边界：

1. AI 对话仍是主要分析入口，业务页面负责结构化呈现和沉淀。
2. `分析成果` 是业务分析成果库，不是所有历史信息的混合流。
3. `工作手账` 是独立一级页面，绝不嵌入 `分析成果`，也不作为分析成果分类。
4. 复用现有 SQLite、ECharts、React Flow、Ant Design 和已有 AI 流式调用，不引入新依赖。
5. 保留旧数据并自动兼容，不要求用户手工迁移。

## 2. 最终信息架构

### 2.1 主导航

`工作空间`保留并调整为：

- 项目管理
- 分析成果
- 工作手账

`工作手账`必须加入 `src/App.tsx` 的主导航白名单和工作空间分组，使用独立路由键 `workLog`。隐藏的旧页面可继续由内部跳转或 AI 工具调用，但不得重新制造多个重复入口。

### 2.2 分析成果页面

页面顶部使用以下业务页签：

- 概览
- 物料洞察
- 项目成本
- 报价与供应商
- 产品与用户
- 收藏

默认页为“概览”，不再默认展示无限混合卡片流。概览仅展示各领域数量、最近查看、待归类和待处理事项。

`AI 对话`、`AI 建议`、`趋势快照`是成果来源或状态，不作为与业务领域并列的页签。无法自动识别归属的 AI 保存结果进入“待归类”，不污染主要列表。

### 2.3 工作手账页面

工作手账保持独立页面，页面内设三个页签：

- 工作记录
- 项目脉络
- AI 总结

AI 生成的周报、月报、项目复盘和绩效总结只保存在“工作手账 > AI 总结”，不进入分析成果。

## 3. 视觉参考与设计约束

以下图片是本次实施参考：

1. 分析成果整体洞察：  
   `C:\Users\96529\.codex\generated_images\01a05b92-56ba-7412-acf7-48a30ccc41d2\exec-aa3a7b76-2286-4836-b87e-fea988f1a4a1.png`
2. 物料分解洞察：  
   `C:\Users\96529\.codex\generated_images\01a05b92-56ba-7412-acf7-48a30ccc41d2\exec-8639eb71-5fc3-462a-b658-a5d8289febc6.png`
3. 独立工作手账页面：  
   `C:\Users\96529\.codex\generated_images\01a05b92-56ba-7412-acf7-48a30ccc41d2\exec-abcfa8c1-3868-4546-8e91-fcadb68dcb69.png`

曾生成过一张把工作手账卡片放进分析成果概览的图片，该结构已经作废，不得实施。

视觉要求：

- 继承 CostHub 现有浅色蓝灰风格和主题变量。
- 主画布、详情面板使用高不透明度实体背景，禁止大面积透出桌面壁纸。
- 不使用渐变作为主背景，不堆叠玻璃层，不使用彩色卡片墙。
- 主色保持 `#2F6FED` 附近的 CostHub 蓝；正向使用青绿色，风险使用克制的琥珀色。
- 金额、比例和日期使用等宽/表格数字特性。
- 1100×700 最小窗口仍可用；窄宽度允许右栏下移，不允许横向溢出遮挡主要操作。
- 所有按钮具有文字或 `aria-label`，不能依赖颜色单独表达状态。

## 4. 分析成果详细设计

### 4.1 当前代码基础

- 页面：`src/pages/AnalysisResults.tsx`
- 数据聚合：`src/db/artifacts.ts#getAnalysisLibraryItems`
- AI 对话保存：`src/components/AiPanel.tsx#saveCurrentResult`
- 物料趋势和分解：`src/pages/Decomposition.tsx`、`src/db/trend.ts`
- 图表渲染：现有 ECharts/`ToolResultView`
- 分解树：项目已经安装并使用 `@xyflow/react`，禁止新增树图库。

### 4.2 统一成果视图模型

在 `src/db/artifacts.ts` 中增加一个纯 TypeScript 的统一视图模型，不修改现有业务表的原始记录：

```ts
type AnalysisDomain = 'material' | 'project' | 'quote' | 'product' | 'unclassified';
type AnalysisResultForm =
  | 'material_overview'
  | 'material_decomposition'
  | 'project_cost'
  | 'quote_review'
  | 'product_voice'
  | 'generic_ai';

interface AnalysisLibraryItem extends AnalysisArtifact {
  item_key: string;
  domain: AnalysisDomain;
  result_form: AnalysisResultForm;
  object_type: string;
  object_id: string;
  object_name: string;
  favorite: boolean;
  archived: boolean;
}
```

要求：

- 现有来源通过 `artifact_type`/`artifact_source` 在查询层归类。
- `trend_snapshot` → `material`。
- `project_analysis` → `project`。
- `quote_review` → `quote`。
- `selling_analysis` → `product`。
- AI 对话保存结果优先根据执行过的工具、当前页面上下文和保存数据中的对象信息归类；证据不足则归入 `unclassified`。
- 不允许用标题关键词作为唯一归类依据。

为支持所有来源的收藏、归档和人工归类，新增轻量元数据表：

```sql
CREATE TABLE IF NOT EXISTS analysis_item_meta (
  item_key TEXT PRIMARY KEY,
  domain TEXT DEFAULT '',
  object_type TEXT DEFAULT '',
  object_id TEXT DEFAULT '',
  object_name TEXT DEFAULT '',
  favorite INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
```

`item_key`使用稳定格式，如 `ai_panel:12`、`trend_snapshot:31`、`project_analysis:8`。不得复制旧业务数据到 `analysis_artifacts` 造成重复记录。

### 4.3 概览

概览包含：

- 四个领域计数：物料洞察、项目成本、报价分析、产品洞察。
- 最近查看/最近更新的成果列表。
- 待归类 AI 成果。
- 待处理的报价异常或建议行动，仅显示入口和数量。

概览不展示完整工作手账，不展示工作手账摘要或手账入口卡片。

### 4.4 物料洞察

物料洞察列表按“物料对象”聚合，而不是按每次快照平铺。同一物料进入详情后，通过分段控件切换：

- 整体洞察
- 分解洞察

#### 整体洞察

至少呈现：

- 当前报价/最新价格信号。
- 历史区间。
- 近 30/90/180 天变化。
- 可信度和更新时间。
- 有足够数据时显示趋势折线与区间；数据不足时显示前后对比，禁止伪造连续趋势。
- 关键发现、风险提示、建议动作。
- 证据链：原始报价 → 历史对比 → 分析结论 → 建议动作。

#### 分解洞察

使用三栏结构：

1. 左栏“分解结构”：真实节点连线树、展开/折叠、成本和占比，选择路径突出。
2. 中栏“成本贡献与风险”：成本贡献排序、潜在降本、风险矩阵。
3. 右栏“节点洞察”：所选节点价格、变化原因、证据来源、建议动作。

实现要求：

- 直接读取现有 `decomposition_tree`、`trend_items`、`trend_snapshots` 和相关查询函数。
- 复用现有 `@xyflow/react`，不创建新的分解数据表，不重新运行 AI 分解。
- 新页面以阅读和复盘为主；编辑、确认、重新分解等操作可继续复用原 `Decomposition` 流程或通过明确入口进入。
- 选中树节点后，中栏和右栏必须同步更新。
- 成本占比为空时显示“未估算”，不得按 0% 误导用户。

### 4.5 其他领域

- 项目成本：按项目聚合，展示成本构成、目标差距、主要成本项、关键结论和建议动作。
- 报价与供应商：采用报价批次/供应商表格，展示总价、异常项、谈价空间和审价结论，不使用通用卡片墙。
- 产品与用户：按产品或项目聚合用户声音和卖点分析，展示维度排行、情绪/关注点和卖点映射。
- 收藏：展示用户主动收藏的所有领域成果，保留领域标签和对象名称。

第一轮允许复用现有结构化结果组件，不要求一次性重写所有图表；但页面分区、对象聚合和专用详情必须落地。

## 5. 工作手账详细设计

### 5.1 当前代码基础

- 页面：`src/pages/WorkLog.tsx`
- 数据：`src/db/worklog.ts`
- 表：`work_logs`、`work_summaries`
- 已有能力：记录、项目标签、待办、完成状态、日期/项目筛选、本地模型流式总结、总结保存。

保留已有数据和模型设置，重构页面和总结模板，不另建第二套手账。

### 5.2 工作记录页签

顶部提供快速记录区，默认只要求填写正文。记录类型为：

- `work_progress`：工作进展
- `decision`：决策记录
- `risk`：问题风险
- `reflection`：心得思考
- `outcome`：成果痕迹
- `follow_up`：待跟进

可选字段：关联项目、结果或影响、下一步、重要程度、到期时间、证据附件/链接。普通记录不强制填写这些字段。

主区域按日期分组显示纵向时间线。每条记录显示时间、类型、正文摘要、关联项目、证据数量和状态，支持编辑、删除、完成待办。

右栏展示：

- 今日跟进。
- 当前项目阶段。
- 本周记录统计。
- AI 总结快捷入口。

### 5.3 数据兼容扩展

在 `work_logs` 上幂等补充以下字段：

```sql
ALTER TABLE work_logs ADD COLUMN record_type TEXT DEFAULT 'work_progress';
ALTER TABLE work_logs ADD COLUMN impact TEXT DEFAULT '';
ALTER TABLE work_logs ADD COLUMN next_action TEXT DEFAULT '';
ALTER TABLE work_logs ADD COLUMN evidence_json TEXT DEFAULT '[]';
ALTER TABLE work_logs ADD COLUMN importance TEXT DEFAULT 'normal';
ALTER TABLE work_logs ADD COLUMN due_at TEXT DEFAULT '';
```

兼容规则：

- 旧 `is_todo=1` 记录映射为 `follow_up`。
- 旧普通便签默认映射为 `work_progress`。
- 原 `category`、`tags`、`work_project`、`is_todo`、`done` 字段继续保留。
- 保存和更新必须覆盖新增字段，但不能清空未参与编辑的旧字段。
- `evidence_json`解析失败时回退为空数组，页面不能崩溃。

### 5.4 项目脉络页签

选择项目后，按时间顺序形成项目经历：

- 需求/背景。
- 首轮报价。
- 审价。
- 谈价。
- 确认/结项。

时间线标识关键决策、问题解决、个人贡献、成果和心得。第一轮不新增复杂“项目阶段”数据库，可先根据工作记录类型、日期和项目现有状态组织；无法判断阶段时归入“过程记录”，不允许 AI 擅自补阶段。

提供“生成项目复盘”，结果保存在工作手账的 AI 总结中，并保留引用的原始记录 ID。

### 5.5 AI 总结页签

总结类型：

- 周报/月报。
- 项目复盘。
- 绩效总结。
- 成长复盘。

生成前可选择：

- 时间范围：今日、本周、本月、自定义。
- 项目范围：全部或指定项目。
- 总结类型。

生成规则：

1. 只使用选择范围内的手账记录，不引用分析成果库中的内容，除非手账证据明确关联到它。
2. 所有数字、降本金额、项目结论都必须来自原始记录；资料不足时写“记录中未明确”，禁止推测。
3. 总结中的关键成果、关键判断、待跟进和风险必须可以展开定位到原始记录。
4. 保留现有流式输出、模型选择、超时和错误反馈。
5. 不再只提供单一“绩效年中/年终总结”提示词，应按总结类型选择对应模板。

绩效总结默认结构：

- 核心职责。
- 关键成果。
- 代表性贡献。
- 问题解决。
- 方法沉淀。
- 个人成长。
- 下一阶段计划。
- 证据索引。

在 `work_summaries` 上幂等补充：

```sql
ALTER TABLE work_summaries ADD COLUMN summary_type TEXT DEFAULT 'period';
ALTER TABLE work_summaries ADD COLUMN project_filter TEXT DEFAULT '';
ALTER TABLE work_summaries ADD COLUMN source_log_ids_json TEXT DEFAULT '[]';
ALTER TABLE work_summaries ADD COLUMN updated_at TEXT DEFAULT (datetime('now','localtime'));
```

保存总结时必须写入引用的 `work_logs.id`。查看总结时提供“查看原始记录”。原记录删除后，总结仍可查看，但证据索引标记为“原记录已删除”。

本次只实施手动触发的时间段总结，不实现后台定时任务。自动周报/月报等真实使用稳定后再增加。

## 6. 实施顺序

### 阶段 A：数据和导航

1. 幂等补齐 `analysis_item_meta`、`work_logs`、`work_summaries` 字段。
2. 扩展 `src/db/artifacts.ts` 和 `src/db/worklog.ts`。
3. 在 `src/App.tsx` 恢复工作手账独立主导航。
4. 为归类、记录保存和总结证据增加最小单元测试。

### 阶段 B：分析成果

1. 把混合卡片页改成业务页签和对象聚合。
2. 实施概览和统一搜索。
3. 实施物料整体洞察。
4. 实施物料分解树、贡献图、风险矩阵和节点证据链。
5. 实施项目、报价、产品的专用列表/详情骨架。
6. 收藏、归档、待归类和继续问 AI 可用。

### 阶段 C：工作手账

1. 重构为“工作记录 / 项目脉络 / AI 总结”三页签。
2. 实施六种记录类型和轻量快速录入。
3. 实施日期时间线、筛选、今日跟进和项目阶段概览。
4. 实施四类 AI 总结、证据引用、保存和回看。
5. 保证旧便签、旧待办和旧总结仍可访问。

### 阶段 D：清理、测试和构建

1. 删除被新页面替代的重复 UI 代码，但不要删除仍被 AI 工具调用的数据函数。
2. 补充错误边界和空数据状态。
3. 执行测试和构建。
4. 生成并验证免安装 `costhub.exe`。

## 7. 代码约束

- 优先改动现有文件，只有明确复用价值时才拆小组件。
- 不增加 Redux、状态机、图表库、树图库或新的日期库。
- 不复制 Decomposition 的数据或 AI 逻辑。
- 不通过 `any.map` 假设数据库返回数组；所有外部/数据库结果进入 UI 前必须标准化。
- 金额调用统一数值格式化函数，`null`/`undefined` 不得直接 `toFixed`。
- 新增 SQLite 列和表必须加入 `src/db/core.ts` 的启动幂等补齐流程。
- 保持现有数据库文件可直接升级，不删除、不重建用户表。
- 尊重当前工作区已有未提交修改，不回滚、不覆盖无关改动。

## 8. 测试要求

### 8.1 自动化测试

至少覆盖：

1. 各 `artifact_source` 到业务领域的归类。
2. 未知来源进入 `unclassified`。
3. 收藏/归档元数据对新旧来源均有效。
4. 旧工作便签和待办的兼容映射。
5. 六种记录类型的保存和读取。
6. `evidence_json`损坏时安全回退。
7. AI 总结按日期和项目过滤。
8. 保存总结时写入原始记录 ID。
9. 总结提示词不得要求模型补造数字或缺失事实。
10. 空数据、空价格和缺失占比不会导致渲染异常。

执行：

```powershell
npm test
npm run build
```

### 8.2 人工冒烟测试

1. 分析成果默认进入概览，不出现工作手账内容。
2. 物料整体洞察可切换 30/90/180 天。
3. 分解树展开、选择节点后贡献图和节点洞察同步更新。
4. 项目/报价/产品成果不再显示成完全相同的卡片。
5. 工作手账从左侧独立进入。
6. 新增心得、决策、成果和待跟进后时间线立即刷新。
7. 旧便签与旧待办正常显示。
8. 按本周生成周报、按项目生成复盘、按季度生成绩效总结。
9. 总结中的证据链接能定位到原记录。
10. 80%、100%、125%、150% 缩放和 1100×700 窗口下无关键遮挡。
11. 浅色/深色、动效开/关下 Modal、下拉菜单和树画布正常显示。

### 8.3 构建与产物

构建前确认正在运行的旧 `costhub.exe` 不会锁定目标文件，然后执行：

```powershell
npm run build
npm run tauri:build
```

最终检查：

- 文件：`src-tauri/target/release/costhub.exe`
- 时间戳为本次构建时间。
- 记录文件大小和 SHA-256。
- 直接启动免安装 exe，确认数据库可升级且主页面可进入。

## 9. 验收标准

满足以下条件才算完成：

1. 分析成果按业务领域和对象组织，不再是混合卡片墙。
2. 物料整体洞察和分解洞察均可用，分解树真实展示已有层级并联动详情。
3. 工作手账是独立导航和独立页面，没有出现在分析成果中。
4. 工作手账可记录进展、决策、风险、心得、成果和待跟进。
5. 可按时间范围和项目生成周报/月报、项目复盘、绩效总结和成长复盘。
6. AI 总结有原始记录证据，缺失事实不会被自动补造。
7. 旧数据完整兼容，现有 AI 工具查询工作手账和创建待办仍正常。
8. 自动化测试和前端构建通过。
9. 免安装 `costhub.exe` 构建完成并通过启动冒烟测试。

## 10. 明确不做

- 不在分析成果中放置工作手账卡片或摘要。
- 不新增独立“心得库”“绩效库”等重复系统。
- 不实现后台自动定时生成总结。
- 不更换技术栈或引入新状态管理/图表/树依赖。
- 不为演示伪造趋势点、成本占比或绩效数字。
- 不删除用户现有数据，不要求用户重建数据库。
