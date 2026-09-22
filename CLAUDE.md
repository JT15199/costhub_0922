# CostHub 开发约束（精简版）

桌面成本管理应用：Tauri 2 + React 19 + TypeScript + SQLite（tauri-plugin-sql）。
> 完整产品文档/功能模块/历史轮次记录 → `项目完整档案.md`（150KB 全量档案）
> 当前进度/未完成事项/近期改动 → `会话接续说明.md`（新开对话先读它）

## 一、安全红线（违反=数据外泄，最高优先级）

1. **提示词脱敏铁律**（用户红线 2026-08-15）：可外传的提示词（云端 prompt/AI 润色输出）严禁含 器件型号/厂家/成本金额/供应商名/项目代号/任何数字。本地模型能读库，提示词只描述任务不携带数据；生成后 `auditPromptStrict` 校验（auditSensitive + 型号/规格模式），命中丢弃；UI 标注"🔒 已脱敏"。
2. **云端安全边界**：外部 LLM/搜索服务只有 Rust HTTP 转发通道（http_stream/http_post/http_get），**没有任何读取本地数据库的通道**——硬边界。云端可外发内容仅 物料名/品类/问题 三字段（固定模板，其他字段结构上无位置可传）。
3. **reqwest 本地直连铁律**（2026-08-14 公司电脑 504 教训）：任何本地/内网地址（localhost/127.0.0.1/私有网段）的 reqwest client 必须显式 `.no_proxy()`——reqwest 默认读系统代理（WinHTTP，公司组策略，设置界面看不到），会把 127.0.0.1 转发到公司代理 → 504。

## 二、反复犯过的错（踩坑记录，勿重蹈）

1. **本地时间规范**：写库时间一律本地时间字符串（db.ts `localNow()`，与 SQLite `datetime('now','localtime')` 一致），**禁止 toISOString()**（UTC 差 8 小时，已修多次）。
2. **快照/列表排序**：一律按 `id DESC`（自增 id 单调），**不要用时间字符串列排序**（旧数据 ISO 带 T vs 新数据本地带空格，字符串排序错乱）。
3. **startOllamaStream 参数铁律**：必须显式 `json: false`（默认 format:'json' 会吞掉自由文本输出——曾致自主分析整轮无内容）。**num_predict 不要设小值截断**（用户 2026-08-18 红线：所有本地 AI 不要截断、让他思考、只要在线有输出就等）——默认已提到 16384，思考/分析类 16384，短 JSON 分类类 ≥4096；本地 AI 不设硬超时（只靠预检确认在线+模型就绪，失败靠 onError 自然报错，不用 setTimeout 掐断慢模型）。
4. **稳定性去重**（用户多次反馈"重复/反复弹"）：
   - 已读条目反复弹出：稳定键失配（AI 发现 objects 是模型自由输出会漂移）+ AI 发现被 dismiss 后重生——`auditStore` 稳定键：规则发现=type+objects；AI 发现=type+归一化标题（去数字/金额/标点）；AI 发现保留到用户处理为止。
   - `upsertInsight`（db/compare.ts）：内容变化必须 UPDATE 保留行，**严禁 DELETE+INSERT**（handled_json 已处理记录被清空、status 重置 unread）；仅出现新组才重置 unread；空情报不建行。
   - AI 层发现容易换说法重复规则层/历史（"驱动板价格偏离"≈"驱动板成本高99%"）→ 入库前 isDuplicateFinding 语义去重（归一化/4-gram/「实体」引用三重判定）。
5. **导入器件匹配**：名称**完全相等** + 型号**完全相等**才复用已有器件，否则新建（曾用 LIKE %name% 模糊搜索致器件错位）。
6. **进度/完成广播降噪**（用户多次反馈"反复弹/闪现"）：后台引擎的 onProgress/done 广播、message 提示**只在真实产出时发**——缓存命中/闸门等待/无新发现/超时失败一律静默（下一轮自动续试），只有发现情报时才提示。
7. **数据源统一**：模块库与项目页必须同一份数据——project_boms 固化快照列（part_name/part_model/part_cost/main_category/sub_category），读取**快照优先、parts 兜底**（CASE WHEN pb.part_cost > 0），两页曾因数据源不一致偏差。

## 三、项目特有架构与约定（代码里看不出"为什么"）

1. **文本协议 v2**（thinkEngine，本地模型不用 function calling）：模型输出 `[TOOL] 工具名 {...}` / `[CLOUD] {...}` 标记行，前端 `parseProtocolCalls`（括号平衡扫描，支持跨行/嵌套 JSON）解析执行并回填 `[RESULT]`；渲染/存库用 `cleanProtocolText` 去标记。本地 9B 模型 function calling 不稳 + tools 与 format:'json' 冲突。
2. **三层去重**（防重复思考/重复烧钱）：①轮内 callCache（相同工具+参数只执行一次）②轮间 overview 指纹 hashString 存 settings（数据无变化跳过本轮）③云端 7 天内同物料复用 ai_bridge_logs.cloud_result（♻ 前缀）。
3. **云端审批队列**（非打断式）：autoInsight/autoThink 云端调用 preview 模式 → requestCloudConfirm 入队（内存+costhub-cloud-pending 事件）→ App 级底部横幅 CloudConfirmBar → 确认后 costhub-insight-request 继续。会话级去重：同物料只问一次；**不故意出现、出现要有用、不碍事**。
4. **品类联动规格**（项目/竞品统一模板）：品类=显示器 → 显示 屏幕尺寸/分辨率/刷新率/面板 4 字段；其他品类 → 隐藏显示器字段，显示通用「关键规格」specs 自由文本；保存时按品类清理无关字段（非显示器清 4 规格、显示器清 specs）——杜绝手写笔填"刷新率"的脏数据。
5. **SKU 成本口径**（skuCalc）：SKU 成本 = 基座 BOM 成本 + Σ差异（**原始值计算**，展示层才舍入）；sku_diffs 支持 add/remove/replace（replace 带 new_model 换型号）；基座变 → 所有 SKU 自动联动。
6. **后台引擎调度**（App.tsx）：compare/advisor/insight/think 四个引擎 App 级轮询调度，独立防重入（模块级 ref + running 日志兜底）；失败静默降级不打扰；真实产出才广播 costhub-ai-task。
7. **动效约定**：.view-enter（视图切换 220ms fade+up）/ .tappable（160ms 过渡+:active scale 0.96）/ .pop-in（弹性缩放）；data-lowfx 全局禁 animation；弹层动画走 antd motion。

## 四、与默认行为不同的规则

1. **.ts 文件不能写 JSX**（TS 编译失败）——用 .tsx；存 React.ComponentType 引用由 UI 层实例化（aiTools 图标）。
2. **antd Modal.confirm 挂 document.body**——弹窗与页面隔离，样式/主题需全局兜底。
3. **renderSkillDimensions 位置约束**：函数必须定义在**所有**使用它的 return 之前（const 不提升，定义在后 → 白屏）。
4. **供应商启用开关生效**：getActiveProviders 必须 is_active=1 才算活跃（曾漏过滤致停用仍可用）。
5. **AI 润色/速览调用**：走 http_post /api/chat **非流式**（非 startOllamaStream 事件流）；失败必须静默（规则文案已可用，不打扰）。
6. **验证铁律**：`npx tsc -b` 重定向到文件拿真实退出码（`Write-Output ('TSC_EXIT='+$LASTEXITCODE)`）；vitest 用默认 reporter（Start-Process cmd + vitest-run.log）。

## 五·补、全局问询已移除（2026-08-18 用户：AI问询重复了）

- GlobalAI.tsx 整文件删除、侧边栏「AI 问询」入口移除、costhub-ctx 写入清理；本地 AI 助手（对话/Agent/自主分析）已覆盖全局问询能力，避免重复入口。旧日志的 global_ask 类型映射保留（历史日志可读）。

## 五、用户偏好（产品行为红线）

1. **安静后台**：后台引擎失败/无产出一律静默降级，不弹提示；提示只在真实产出或手动操作时。
2. **不故意弹窗**：云端审批走非打断式横幅队列，出现的一定有用，不阻碍视线不频繁打扰。
3. **emoji 规则**（ui-ux-pro-max）：SVG 图标不用 emoji（用 antd 图标）；正文文本 emoji 保留。
4. **目标成本铁律**：目标成本数据依赖用户设定（生产库仅 2 条）——驾驶舱预警/分析以目标设定为前提，未设定不得编造目标。
5. **结论必须模型产出**（用户 2026-08-18）：所有 AI 功能的「结论/建议/总结/洞察」必须是模型思考输出的结果，**禁止硬编码结论冒充 AI**；规则层/确定性逻辑只是透明兜底（明确标注 rule，如 dailyBrief buildRuleBrief、autoAdvisor buildRuleCandidates、autoAudit/autoCompare 规则层），模型可用时必须用模型输出覆盖，失败要诚实标注"模型未返回/解析失败"，不得用"分析完成"之类假结论。

## 三·补、阶段 ① 目标管理（2026-08-18 harness 化）

- **ai_goals 表**（db/goals.ts）：text/status(active|paused|done)/progress/linked_project；运行时兜底建表。
- **autoThink 集成**：buildThinkOverview 顶部注入【用户目标】（active 前 3 条+最近推进）；sysPrompt 优先围绕目标；每轮结论前 200 字 appendGoalProgress 回写进度（保留最近 5 段）。
- **GoalsCard**（驾驶舱「自主分析」区顶部，2026-08-18 由本地 AI 助手页收敛）：下达/完成/暂停/恢复/删除 + 进度展示。

## 三·补2、阶段 ②③④（2026-08-18 harness 化，安全约束内）

- **②上下文与记忆**：thinkEngine.compressMessages（历史超 9000 字符折叠最旧轮次为摘要行，保 system+初始问题+最近一轮完整——9B 模型上下文不爆）；ai_memory 表（db/memory.ts，跨会话长期记忆：setMemory/getMemoryContext），autoThink 概览顶部注入【长期记忆】+ 每轮结论写记忆（防重复分析同一话题）。
- **③输出验证环**：verifyConclusion.ts verifyConclusionNumbers——结论文本中的金额/百分比必须在数据证据（概览+工具结果）中出现，否则结论尾部附注「[校验] 含 N 个未能溯源的数字：…请人工核对」；反幻觉从提示词要求升级为代码强制。
- **④模型路由**：aiRouter.ts decideCloudRoute——明确"外部行情/最新信息"才走云端（本地可回答的不申请，不占用审批）；每次云端申请记录 routeReason（审计留痕）；云端仍只发脱敏三字段（边界不变）。
- 新增 harnessPhases.test.ts 5 用例（验证环 3 + 压缩 2）。

## 三·补3、AI 外发安全中心（2026-08-18，用户：如何让我在用的时候知道信息安全可控）

- **outbound_request_logs 强化**（db/settings.ts）：运行时兜底建表 + payload_summary（脱敏外发内容摘要）+ reviewed 列；trendService.safePayloadSummary 从请求体提取白名单字段（material_name/material/category/question/query/name），其余一律不记录（防 API key/本地数据入日志）。
- **设置 → 审计日志 → 「AI 外发安全中心」**：今日外发计数 + 边界说明（每次外发仅 物料名/品类/问题，金额/型号/供应商/项目代号结构上无位置可传）+ 逐条记录（时间/外发内容摘要/目标域名/方法/状态码/耗时）——每次云端调用可核对实际发出内容。
- **云端并行安全配合原则**（讨论结论）：并行不改变外发边界——批量查仍用子类通用名（非具体型号），三字段模板不变，批量前一次审批 + 逐条审计，云端结果单向流入本地。

## 三·补4、本地单路高质量（2026-08-18，用户确认：本地也聚焦单路高质量）

- **思考引导强化**（thinkEngine.buildThinkSystemPrompt【思考原则】）：单线程深挖——一次聚焦一个核心线索到底，不要并排列多个浅问题；每个判断必须有数据支撑（引用项目/模块/数字）；关键结论交叉验证（≥2 个独立数据点）；输出前自检逐条核对；不确定明确说"数据不足"。
- **autoThink 任务段**：规划 2-4 个任务 → 聚焦 1-2 个最关键方向深挖到底。
- **工具结果放宽**（aiTools.executeTool）：截断 2000 → 4000 字（thinkEngine.compressMessages 已兜底上下文），关键数据尽量完整给模型。

## 三·补4补、单路高质量·执行层硬约束（2026-08-18 进一步）

- **每轮最多 2 个工具调用**（thinkEngine MAX_TOOLS_PER_ROUND=2，activeCalls=calls.slice(0,2)，多余下轮继续）——prompt 之外代码级强制"一次追一个线索"，杜绝一轮并排 5 个工具浅尝。
- **深挖进度可视化**（AutoThinkPanel 实时区）：显示「🔧 已调用 N 次工具 · 单线程深挖中（每轮最多 2 个调用）」。
- harnessPhases.test 补 1 用例（上限=2）。

## 三·补5、远程桌面兼容 + 表格溢出（2026-08-18 用户反馈：公司 jumper 远程使用总出 bug / 项目列表内容溢出）

- **远程桌面（RDP/jumper）WebView2 渲染**（src-tauri/src/main.rs）：检测 SESSIONNAME 非 Console（远程会话）→ 设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu——远程会话硬件加速渲染常致白屏/闪烁/弹窗异常（06-23 已修 data-motion transition 问题，本修复针对 GPU）；本地控制台保持 GPU 加速。
- **DataTable 溢出修复**：Table 外包 overflowX:'auto' 容器——列总宽超容器时表格内横向滚动，不再撑破页面（通用组件，所有表格受益）。
- **项目列表 SKU 变体列**：chips 容器 maxHeight 42 + overflowY auto（行高不过度膨胀）。

## 三·补5补、AI 日志与外发中心分工（2026-08-18 用户确认：AI请求日志只本地，外发安全中心只云端）

- **saveAIRequestLog**（ai_request_logs）：provider_name 非空 且 非'Ollama 本地' 且 request_type≠'usage' → 跳过（云端调用不再写，外发中心已记录）；本地（Ollama 本地/空）与 token 用量（'usage'）保留。
- **logOutboundRequest**（outbound_request_logs）：isLocalUrl 过滤（localhost/127.0.0.1/::1/内网）→ 本地调用不记外发中心。
- 设置页文案更新：AI 请求日志="只记录本地模型访问"；外发安全中心="仅云端外发可逐条验证"。

## 三·补6、价值工程（2026-08-18 用户方向：价值工程/竞品对比/新项目驱动，价值由数据算不人为定义）

- **数据层**（db/value.ts）：cat_feature_templates（品类特性模板：feature_key/label/weight，默认显示器/手写笔/鼠标模板）+ value_scores（ref_type/ref_id/feature_key/score 0-10，UNIQUE 冲突 upsert）——独立于雷达评分。
- **纯函数**（valueEng.ts）：computeValueEngineering——价值分=Σ(评分×权重)/Σ权重；VE=价值分/(每千元成本)；模块价值比=特性贡献占比/成本占比（无特性贡献时 valueRatio=-1 不误判，只标成本占比最高的「重点成本模块」）；worstModules=<1 的价值工程对象。
- **VePanel**（对比分析页）：选品类 → 该品类项目/竞品 VE 对比表（价值分/成本/VE/每分成本/价值工程重点标签/评分入口）；评分按品类模板 0-10。
- **价值工程口径**（用户确认）：价值由市场/数据算，特性权重按品类（可改），对比对象按同品类分组（避免高低档混比）。

## 三·补6补、价值工程全链路（2026-08-18 "直接全做了"）

- **市场售价锚定**：VEObject 补 marketPrice，VEResult 补 marketRatio（售价/成本溢价倍率）；VePanel/AI 工具展示。
- **AI 工具** query_project_value_engineering（第 14 个工具）：项目代号 → 该项目 vs 同品类竞品的 VE 对比文本（价值分/成本/VE/市场溢价/重点模块）+ 取舍结论参考——AI 可据此给成本+特性综合建议。
- **新项目驱动分析**：Projects handleSaveProject 新项目 → dispatch costhub-project-saved → App 监听 → scheduleAppThink(true) 强制一轮（成本不常变，新项目才是分析动力）；autoThink 概览含所有项目 AI 自动聚焦新项目。
- 工具图标 FundOutlined。

## 三·补6·删、价值工程已整体移除（2026-08-18 用户：现在VE基本没用，想清楚后作为单功能重做——用用户原声给本地模型分析最有价值特性）

- VePanel.tsx / db/value.ts / valueEng.ts / valueEng.test.ts、Compare 页 VePanel 挂载、aiTools 第14工具 query_project_value_engineering、db.ts export 全部移除（VE 依赖用户主观打分为价值 = 不客观，踩了用户红线；后续以「用户原声 + 本地模型分析最有价值特性」方向重新设计）。

## 三·补7补5、用户原声分析·不卡死 + 实时输出（2026-08-18 用户：一直卡住没变化，不知跑起来没）

- 根因：startOllamaStream 无超时，本地模型无响应时 await 永远挂起。修复：每块模型调用包 90s 超时（Promise.race 风格），超时/失败 log「⚠️ 第 N 块模型未响应/超时，跳过继续」不阻塞；onToken 实时 setLiveChars 显示「模型输出中（已 X 字）」；日志补「模型输出 N 字」——页面实时反映确实在跑，不卡死。

## 三·补7补6、用户原声分析·中断残局自动收尾（2026-08-18 用户：开始分析按钮灰色无法点击）

- 根因：上次分析被中断（应用关闭/页面重载）遗留 voice_run status='running' 记录，页面加载 load() 里 getRunningVoiceRun(product) 读到 → running 非空 → 按钮 disabled={running!=null} 永久置灰。
- 修复：load() 检测到 running 记录时 finishVoiceRun(rr.id,'error','上次分析被中断，已自动结束') 收尾并 setRunning(null) + log 提示「检测到上次分析被中断（未完成），已自动结束，可重新开始」——不永久禁用按钮，可重新分析。

## 三·补7补7、用户原声分析·整体完善（2026-08-18 用户：分析完成但 0 个维度 + 功能是否片面，切 pro 模型整体看代码）

- **根因（0 个维度）**：①本地模型未启动/未下载 → 每块 90s 超时跳过，但结束仍提示「分析完成」误导；②模型有输出但 parseDimensions 只认单一 `{dimensions:[...]}` 形状（顶层数组/\{features:[...]\}/中文「正面」等都返回空）。
- **修复（7 项）**：
  1. **预检**：runAnalyze 前 detectOllama()（aiStatus.ts 增强为区分 model-missing「模型未下载」/offline「Ollama 未运行」）——失败快速给原因，不空跑 N 块超时。
  2. **健壮解析**：parseDimensions 移到 voiceAnalyer.ts（纯函数+5 测试），兼容 顶层数组/features/items 等任意数组字段/前后夹散文/代码围栏/中文引号/尾逗号/行级「名称：正面」兜底；normSentiment 归一中文「正面/负面」。
  3. **诚实收尾**：区分 超时全跳过（报错）/有输出但未识别（warning+输出样例）/部分跳过（成功提示附「跳过 X 块」）；空结果 finishVoiceRun status='error'。
  4. **依据原声**：每个维度 findEvidence 在原始原声中匹配该特性词（最多 3 条真实原声）存 evidence，结果表 expandable 展开查看——结果可溯源、不主观。
  5. **导入预览**：load()/handleFile 取前 5 条原声显示「已导入原声示例」——用户可核对 Excel 列识别是否正确。
  6. **kind 落库**：voice_dimension 加 kind 列，replaceVoiceDimensions 存 kind，表格用 r.kind 渲染（修掉表格重算公式与 mergeDimensions 不一致的隐患）。
  7. 每块超时 90s→120s（冷启动加载模型更从容），num_predict 1500→2000。
- **教训沉淀**：本地模型输出格式不稳，解析不能只认单一 JSON 形状（要数组/字段/行级三层兜底）；模型未就绪要预检快速报错，不要空跑超时；「分析完成」不得在无结果时出现。
- **实测补充（同轮）**：86 条原声挤进 1 块（3000 字预算），模型输出 7183 字被 num_predict=2000 截断 → JSON 不完整解析失败 → 仍 0 维。修复：①num_predict 2000→4096 ②提示词压紧（最多 12 维/名称≤8 字/禁解释前后缀）③parseDimensions 加截断兜底（已生成完的对象逐个抠出，截断也能提取）——模型再啰嗦也能拿到数组前端已生成的维度；另教训：大样本别指望模型守"最多 N"，解析要防截断。
- **用户明确（同轮）：不要截断，模型思考多了也没问题，慢慢收敛有结论就行**——①num_predict 4096→16384（基本不截断，模型想写多少写多少）②超时从"固定 120s"改为**惰性超时**：setInterval 每 5s 检查，180s 完全无新 token 才判卡死放弃，令牌持续到达就无限等（慢但收敛不掐断；用 lastAt 记录最后出字时间）。

## 三·补7补4、用户原声分析·分析过程可见（2026-08-18 用户：分析时能看到过程、到哪一步）

- runAnalyze 循环里 setCurBlock（正在分析的块 idx/total/items）+ setLiveDims（每块提炼维度名实时累积）；UI 分析区换成**过程面板**：进度条+X/Y块 +「正在分析第 N 块（本块 X 条原声）+样例预览」+「已提炼维度（实时累积 Tag）」+ 保留 log；切页不中断（结果照常落库）。

## 三·补7补3、用户原声分析·产品维度 + 声量优先（2026-08-18 用户：每次导入某产品源声需选择产品；声量=在乎的人多是第一信号）

- **产品维度**：voice_item/voice_dimension/voice_run 加 product 列（ALTER 兼容），导入/分析/结果/清空/运行状态全部按 product；页面顶部 AutoComplete 选/输产品，标题带产品名；getVoiceProducts 记忆已用产品。
- **声量优先**：mergeDimensions 以 count（声量=提及用户数）为 weight 主排序；quality=positive/count（好评率）；kind（strong=声量高口碑好 / fix=声量高负面多 / minor=声量低）；结果表显示 🔥声量/💬好评率/👍👎/类型，说明「声量=在乎的人多，主导排序」。

## 三·补7补2、用户原声分析导入去重（2026-08-18 用户：文件重复上传内容会累加）

- addVoiceItem 内容级去重（同 content 不重复入库，返回 0=已存在）；handleFile 统计 新增/跳过重复，提示「新增 X 条，跳过 Y 条重复」。

## 三·补7补、用户原声分析已留痕（2026-08-18 用户：分析也要有本地AI日志）

- UserVoice 每次本地模型提炼调用后 logLocalAICall({request_type:'voice_analyze'}) 留痕 ai_request_logs（本地，不涉外发）；Settings typeMap 加 voice_analyze→'用户原声分析' 映射。

## 三·补7、用户原声分析（2026-08-18 用户：上一代产品原声 Excel 丢进去自主分析，自动分块汇总找最有价值特性）

- **数据层**（db/voice.ts）：voice_item（原声条目）/ voice_dimension（特性维度权重榜）/ voice_run（分析批次进度）——运行时兜底建表。
- **分块合并引擎**（voiceAnalyer.ts 纯函数）：chunkVoiceItems（按 ~3000 字预算切，不切断单条，超长单条单独一块）；mergeDimensions（跨块名称归一化去重，weight=提及+0.5×正面，按 weight 降序）。
- **UserVoice 页面**（AI 趋势组）：导入 Excel（XLSX 自动识别 评价/评论/反馈/内容/text 等列，找不到则非空单元格拼接）→「开始分析」逐块唤醒本地模型提炼 {dimensions:[{name,sentiment}]}（startOllamaStream json:false num_predict 1500，健壮 JSON 解析）→ 全部完成 mergeDimensions 存 voice_dimension → 权重榜（维度/权重/提及/正负/分布条）呈现；进度逐块显示。
- **价值工程标尺**：此榜 = 用户原声提炼的「最有价值特性维度+权重」，作为价值工程/新品特性的客观依据（替代主观打分）。

## 三·补8、卖点价值分析（2026-08-18 用户：原声结果对应"提前可编辑的卖点"，卖点对应成本，串起来让 AI 分析哪个卖点多少声量/成本/市场反响）

- **核心（统一流程 v4）**：上一代已上市不可改，其原声(声量/好评) × BOM(成本) = 下一代产品定义指导。选项目 → AI 自动分析主要卖点+对应模块（用户可改）→ 归纳原声 → **模块级价值分析（主视角）**+卖点级 → AI 给下一代表保留/降本/减配建议。卖点直接带 positive/negative 声量（不走 voice_dimension 映射）。
- **数据层** db/selling.ts：selling_points（挂项目 + positive/negative 声量列）/ selling_point_modules（卖点↔模块）。纯函数 sellingPointAnalyzer.ts：allocateModuleCosts 成本分摊 / computeSellingPointRows 价值计算（卖点直接带声量）/ classifyKind 客观分类 / buildAiAggregatePrompt+parseAiAggregate AI 归纳原声到卖点（模型只做归类+正负，计数由代码精确累加，不靠模型报数）/ buildSellingPointAnalysisPrompt AI 分析。
- **成本分摊（你问的问题的答案）**：**模块级不摊**（模块成本精确，声量=该模块支撑卖点的声量合计，直接回答"哪个模块好又便宜/差又贵/花得不值"）；**卖点级用声量加权分摊**（同模块多卖点时模块成本按各卖点声量占比分摊，客观数据驱动——成本应投向用户在乎的地方；无声量时均分兜底）。
- **分类（客观）**：卖点级 star/fix/overinvest/minor；**模块级** cheap_good 好又便宜 / good_expensive 好但贵·降本 / bad 做得差 / waste 花得不值（下代减配砍）/ minor 次要（前 ~30% 分位）。
- **UX**（SellingPointPanel 并入用户原声分析页）：选项目→**AI 自动分析**卖点+对应模块（无卖点时自动跑一次，可「重新智能分析」/手动改）→「归纳原声」→**模块价值表**（成本精确/声量/好评/好又便宜·好但贵·做得差·花得不值/支撑卖点）+卖点表（声量/好评/声量加权成本/声量成本比条）→「AI 下一代定义建议」。顶部「开始分析」自由提炼维度降级为"发现漏掉卖点"的辅助，提示词也要求归纳合并。
- **交互打磨**（用户 2026-08-18：UI 高级巧妙不寡淡）：建议卡 hover 上浮+阴影+一键采纳(采纳后变绿对勾)、价值表声量成本比用渐变色条、归纳分析实时进度、卖点行操作按钮 hover 淡入、按钮统一 .tappable(:active 缩放)；CSS 见 index.css 末尾 .sp-suggest-card/.sp-ratio-bar/.sp-row-ops，data-lowfx 时禁用动画。
- **AI 留痕**：request_type 复用 voice_analyze（本地不涉外发）；num_predict 16384 不截断。

## 三·补9、CostHub = harness：功能做成可调用工具，本地大模型当大脑（2026-08-18 用户：不要每个功能单独页面，要能直接在 AI 对话里调用，本地大模型作为大脑，有任务回馈机制像 agent）

- **方向**：新能力一律注册为 aiTools.ts 里的「工具」（id/中文名/给模型的描述/参数/execute 返回文本），本地模型（大脑）在 对话/Agent/自主分析 里用文本协议自主调用并推理——不再为每个功能单独做页面。
- **新工具（第 14-17 个）**：quote_review AI 审价（贴报价逐项判合理/偏高/虚高+合理价+议价要点，嵌套本地模型调用）/ query_project_module_value 模块级价值分析（成本/声量/好评/好又便宜·好但贵·做得差·花得不值，需先做卖点分析+归纳）/ query_project_health 项目深度体检数据（BOM 成本结构/目标/快照，供大脑写"为什么贵/怎么降"）/ query_competitor_bom 竞品 BOM+售价对标数据。
- **校验**：aiTools.test.ts 强制 每工具唯一 id/中文名/描述>10字/参数 key 唯一/TOOL_ICONS 全覆盖——加工具必须同步补图标。
- **已有 harness 骨架**：aiTools 注册表（13 查询/分析工具）+ thinkEngine 文本协议（[TOOL] 标记）+ runThinkLoop 多轮循环 + Agent 轨迹回馈（AutoThinkPanel/AiPanel 实时显示 思考/工具/云端/结论）+ MAX_TOOLS_PER_ROUND=2 单路深挖。
- **QuoteReview 页面保留**为快捷入口（非主要方式）；大方向是工具优先。
- **工具地图（参考 DSH 工具分类，2026-08-18 用户：要思考全面不能用到时没有）**：
  - 数据查询（已有）：query_projects / query_project_bom / query_project_cost / query_part_suppliers / query_supplier_trend / query_target_status / query_cost_snapshots / query_price_insights / query_advisor_insights / query_worklog / query_todos / compare_subcategory_cost / query_voice_dims（原声维度）/ query_project_module_value（模块价值）/ query_project_health（体检数据）/ query_competitor_bom（竞品对标）。
  - 分析：insight_material_trend（云端行情，审批）/ quote_review（AI 审价，嵌套模型）。
  - 文件/导入：read_excel（读 Excel，弹文件选择框→表格文本）。
  - 计算/工具：calc（可靠算术核验）/ now（本地时间）。
  - 做事（AI 能把发现变成行动）：create_todo（工作手账建待办）/ add_goal（下达目标给自主分析）。
  - 安全：除 create_todo/add_goal 外均只读；写操作只进用户自己的库；脱敏铁律不变量。
- **加工具三步**：①aiTools.ts 数组加 {id/name/desc/params/execute} ②TOOL_ICONS 补图标（测试强制）③纯函数放独立 .ts 并加测试。
- **Agent 对话界面（2026-08-18 用户：像正常 agent 界面，可以选模型、选功能）**：本地 AI 助手头部加**模型下拉**（Ollama 模型列表，切换即存 local_ai_model）；输入区加**功能下拉**（审价/降本/对标/原声/行情/体检/目标/待办）——选功能后占位符变示例提问，发送时自动注入「【本次聚焦：X】请优先用 Y 工具」的任务提示，让大脑按选的功能干。
- **AI 使用指南（AIUsageGuide.tsx）**：能力状态 + 可复制示例提问 + 23 工具分组清单 + 功能入口说明；入口 = 本地AI助手头部「使用指南」按钮 + 设置→关于→「打开 AI 使用指南」+ 首次进入自动弹；任何页面 window.dispatchEvent('costhub-open-ai-guide') 可打开。
- **DSH 式轨迹时间线（TraceTimeline.tsx，2026-08-18 用户：发什么prompt→调什么工具→生成什么结果→又发什么prompt，卡片串起来更清晰）**：thinkEngine 加 onPrompt 事件（初始问题 + 每轮回填结果后的继续 prompt 都发事件）；Agent 执行区用 TraceTimeline 把 📤发送给模型/🔧工具调用(参数+结果)/🔐云端/📌结论 串成带连接线的卡片链，点卡片可展开全文——每次调什么工具、喂了什么数据、得出什么一目了然。
- **规格分类模板（2026-08-18 用户：原声分析要关联项目源声与模块成本；具体特性有针对性项目的规格分类，AI 分析往上面靠）**：project_spec_templates 表（每项目可编辑 规格分类名+参考规格值）；卖点面板顶部「⚙ 规格分类」chips 可点编辑/加；AI 智能分析（buildAiUnifiedPrompt）有规格分类时**严格按这些分类生成卖点**（不新增/改名），原声归纳也归到这些类——规格分类×声量×模块成本 直接串起来。源声↔模块成本关系 = 规格分类(=卖点)↔模块 映射 + 归纳声量（既有卖点价值分析）。
- **模块库选中合计**：勾选模块后工具栏显示「已选 N 个模块 · 合计 ¥X」（累加所选实例成本）。
- **交付标准（2026-08-18 用户：希望 AI 产出像 mockup 那样，不要半吊子）**：功能交付标准 = 演示级 mockup 水准——设计先行（v2 视觉语言：骨色底+墨色+信号色/风险红·机会绿·提示金/等宽数字/无 AI 味），每个功能打开就是这个审美，半吊子不交付。已落地第一个：ModuleValueMatrix.tsx（真实数据 声量×成本 四象限散点，气泡大小=好评率，四象限=好又便宜/好但贵/花得不值/次要），卖点价值分析 表格/图表 切换。后续核心界面按此标准逐个重建（设计 token 先行）。


## 三·补10、数据就绪度引导（2026-08-18 用户：引导客户如何使用——发现用户给的数据哪些缺失、没有这些数据能做到什么样、建议是什么）

- **能力**：扫一遍用户全部数据（本地模型/项目BOM/器件库+供应商报价/用户原声/目标成本/竞品/规格分类），逐项给出 **有✅/半⚠️/缺❌ + 现状 + 能做什么/缺了会怎样 + 建议补什么**——回答"我现在能做什么、缺什么、下一步干嘛"。
- **纯函数**（src/dataReadiness.ts）：getDataReadiness()（扫库）→ ReadinessItem[]；readinessToText(items)（→文本，ok 用「现在能」、partial/missing 用「缺了会」前缀）；+5 测试（dataReadiness.test.ts）。
- **AI 工具**：query_data_readiness（第 24 个，无参数，图标 SafetyCertificateOutlined）——大脑在 对话/Agent 里答"我缺什么数据/现在能做哪些分析"时调用，返回逐项就绪度文本。
- **UI**（DataReadiness.tsx，v2 视觉：骨色底+墨色+信号色）：就绪度卡片（N 项能力 · X 就绪 · Y 半就绪 · Z 缺数据 + 每项 状态色条/现状/影响/建议）+「让 AI 引导我」按钮 → 预填提问自动发给本地 AI 助手（让模型用 query_data_readiness 当面引导）。
- **预填链路**：DataReadiness 写 localStorage(costhub-ai-prompt-pending, {prompt,auto:true}) + dispatch costhub-open-ai-prompt → AiPanel 常驻直接消费（setInput + sendRef 自动发送），无导航。


## 三·补11、右侧 AI 协作窗（2026-08-18 用户：功能页右侧放 AI 互动窗口，不单独去页面；不预设功能，给模型配好全部 tools 自主调用）

- **布局**：AiPanel 作为 #root 第三个 flex 子项（与 sidebar/main 平级，统一最右，height:100vh 撑满独立滚动）：默认 384px、**可拖拽调宽 300-560**（左边缘 6px handle，localStorage ai-panel-width）、**可折叠成 42px 竖条**（ai-panel-collapsed）——不跳页，功能页里直接跟大脑对话。
- **引擎 = thinkEngine.runThinkLoop（不是 LAI 的 sendMessage）**：模型持有**全部 24 个工具清单**（buildThinkSystemPrompt 注入），[TOOL] 文本协议自主调用、多轮循环、自动回填 [RESULT]、单轮 ≤2 工具、json:false+num_predict 16384 不截断——"我让它干什么，模型自己调工具"。
- **轨迹=执行记录卡**：onToolResult → 🔧 工具名+参数+结果摘要；onCloudResult → 🔐 云端卡；思考过程 details 折叠（N 字）；结论白卡。onAnswer/onThought 流式累积。
- **不预设功能**：输入框只有占位符"直接说需求，模型自动调用工具…"，无聚焦下拉/快捷提问/功能列表（用户 2026-08-18 明确）。
- **会话**：aiPanelChat.ts（从 LAI 提取：loadSessions/newSession/loadMessages/saveMsg/deleteSession，local_ai_sessions/messages 表不变）；头部 新对话/历史会话/折叠/使用指南 按钮。
- **上下文联动**：App 传 activePage → PAGE_LABELS 页面名；页面内选中对象 dispatch costhub-ai-ctx {label} 覆盖显示（如"P271-M27"）。
- **就绪度引导**：AiPanel 底部动态计数（getDataReadiness，不硬编码）+「让 AI 引导我」→ localStorage(costhub-ai-prompt-pending)+costhub-open-ai-prompt → AiPanel 常驻直接消费自动发送（App 不再导航监听）。
- **移除**：导航「本地AI助手」、render case、App 的 costhub-open-ai-prompt 导航监听。LocalAIAssistant.tsx 已 git rm 彻底删除；GoalsCard 挂驾驶舱 AutoThinkPanel 上方；DemoGenerator 待归位（文件保留无入口）。云端审批仍走 cloudConfirm 横幅（approveCloud=requestCloudConfirm）；runCloud=agentSearchLoop。
- **增强（2026-08-18 用户反馈轮）**：
  · **停止生成**：runThinkLoop 加 abortRef（外部置 aborted=true → 150ms 轮询清理当前轮流式监听并结束，已输出内容当结论）；AiPanel 流式时输入区按钮变红色停止钮。
  · **模型选择**：底部控制条下拉（/api/tags 拉列表，切换即存 local_ai_model）；detectOllama 同步当前模型。顶部只保留 AI 身份和操作按钮，窄宽度下收缩按钮始终可见。
  · **深度思考开关**：底部控制条 Switch（localStorage ai-panel-deepthink 默认开）；runThinkLoop 加 think 选项（false 时 startOllamaStream think:false 更快）。
  · **附件**：输入区 📎 支持 Excel（XLSX 读表文本拼进提问）与图片（base64 走 Ollama images 字段，需 VL 模型如 qwen3-vl）；runThinkLoop 加 images 选项（初始 user message 带 images）。
  · **头部压缩**：去掉「离线分析」框，顶部只保留 AI 身份、上下文与操作按钮；模型选择和深度思考移到底部控制条，窄宽度下收缩按钮始终可见。
  · **审批三态**：runThinkLoop 的 approveCloud 返回 boolean|'pending'——''pending''=已入队等待确认（不误报"用户拒绝"，明确告知去底部横幅确认后重新提问）；AiPanel 用 getPendingConfirms 区分"入队"vs"本会话已跳过"。
  · **物料洞察历史工具**：query_material_insight（第 25 个，图标 HistoryOutlined）——按物料名查 trend_items+trend_snapshots（方向/置信度/摘要/时间/来源 免分解quick/分解/自动auto）。模型先查历史再决定查最新（用户：Scaler IC 已洞察过但 AI 不知道，且 query_price_insights 是报价情报不是物料行情）。
  · **防幻觉三件套（用户：更新Scaler IC行情却调了项目工具+编造$100-$150）**：①systemPrompt 任务-工具强映射——行情任务唯一路径 query_material_insight→insight_material_trend，严禁调用项目/器件类工具 ②executeTool 软拦截——行情任务（isTrendTask）调无关工具时 [RESULT] 附提示引导改用行情工具 ③verifyConclusionNumbers 校验——结论文本数字必须在工具结果+提问证据中，否则尾部附注「[校验] 含 N 个未能溯源的数字…请人工核对」。
  · **审批确认自动续跑**：AiPanel 记 pendingRetryRef（approveCloud 返回 'pending' 或工具结果含"等待云端发送确认"时）→ CloudConfirmBar 确认触发 costhub-insight-request → AiPanel 自动重发上一条提问 → 二次审批放行（confirmedKeys）→ 云端真正调用（用户：同意两次却失败，确认触发的是后台 autoInsight 重跑不是对话）。
  · **工具优先**：AiPanel systemPrompt 追加【任务执行】——查已有洞察用 query_price_insights、查行情用 insight_material_trend（走审批）、禁凭空"搜索/综合"，工具结果回填后基于真实数据回答（用户：让AI洞察却没用工具）。


## 三·补12、AI 数据工程：写回 + 导入闭环（2026-08-18 用户：AI 自动调用工具达成目的，结论记录到已有功能；丢 BOM 表 AI 自动拆解录入；工具里所有能力都要用上）

- **写回工具**（AI 分析后结论落库，不覆盖用户手工数据）：save_selling_analysis（卖点价值结论 → selling_point_analysis，卖点面板显示「最近 AI 分析结论」）/ save_project_analysis（项目分析结论 → project_analysis_logs，驾驶舱「最近 AI 分析结论」）/ quote_review 审价自动落库（quote_review_logs，审价页历史）/ insight_material_trend 写 trend_snapshots（洞察卡片）+ 自动续跑（pendingRetryRef + costhub-insight-request）。
- **导入工具**（AI 读文件→拆解→入库）：import_bom_to_project（器件去重 name+model 完全相等复用→parts+project_boms，规则自动归模块）/ import_supplier_quote（匹配器件→part_suppliers+更新加权成本）/ import_competitor_bom（竞品 BOM）/ import_voice_items（原声去重导入）。共用 db/dataImport.ts 导入层（校验/去重/统计）+ moduleRules.ts 规则引擎（纯函数+6 测试，从原 LAI 提取 MODULE_RULES）。
- **联动**：AiPanel 系统提示【写回结论】+【数据工程】（read_excel/附件读文件→解析 JSON 数组→调导入工具→如实汇报统计）；写库后广播事件（costhub-project-bom-updated / supplier-updated / competitor-updated / voice-updated / project-analysis-updated / selling-updated / quote-review-updated / trend-updated）。
- **页面呈现（克制，不复杂）**：5 页面补 app-page-active 刷新监听（Projects/PartsLibrary/UserVoice/Competitors/SupplierManagement——写库后切回即见）；展示卡=驾驶舱分析结论/卖点面板结论/审价历史，无弹窗无复杂表单。


## 三·补13、AI 报告与 Excel 生成（2026-08-18 用户：AI 能生成 PPT 报告/HTML 报告/处理 Excel；页面不要复杂；工具完善+正确引导）

- **aiReport.ts**（纯函数+3 测试）：buildHtmlReportBase64（v2 视觉 HTML 报告：骨色底+卡片+转义防注入）/ buildPptxBase64（pptxgenjs 16:9 墨蓝+金）/ buildWorkbookBase64（XLSX 多工作表）。
- **工具**（共 33 个）：generate_report（title+slides JSON[{heading,points}]→HTML/PPTX→invoke save_export_file 存 exe 同目录 exports/）/ write_excel（file_name+sheets JSON[{name,rows}]→xlsx→exports/）。
- **引导**：AiPanel 提示【报告与文件】——生成报告/演示用 generate_report（3-6 节每节要点）、整理表格用 write_excel（首行表头）、读 Excel 用 read_excel、附件用 📎；生成后如实汇报文件名/格式/位置。
- **双路径**：手动（页面功能）+ AI（右侧窗驱动全部工具）；页面不新增不复杂，展示=洞察卡片/卖点结论卡/驾驶舱分析卡/审价历史/导出目录。


## 三·补14、借鉴 DSH 三件套：任务清单 / 结构化澄清 / 批量编排（2026-08-19 用户：把 DSH 可借鉴的放进来，为 27B 模型准备——代码级确定性，不依赖模型智能）

- **任务清单（[PLAN] 协议，借鉴 todo_write/workflow）**：thinkEngine.parsePlanCall 解析模型输出的 [PLAN] {"steps":[...]}；AiPanel 对话区顶部显示「📋 执行计划」（✅完成/⟳进行中/□待办），每完成一个工具（onToolResult）自动勾选；复杂任务提示先输出 [PLAN]。
- **结构化澄清（ask_user，借鉴 ask_user_question）**：第 34 个工具 ask_user（question+options JSON）；AiPanel 拦截渲染选项卡片（输入区上方），用户点击/继续/跳过 → 结果回填 [RESULT] 给模型继续；提示明确"没给目标先 ask_user 不要瞎猜"。
- **批量编排（pendingQueue，借鉴 workflow）**：pendingRetryRef 改数组（去重 push）；确认事件后逐个 runCloudDirect 云端查询更新 + 显示「🔄 批量更新行情：第 X/N 个」；支持"把这 N 个物料都更新行情"。


## 三·补15、技能库 + 文件格式扩展 + OCR（2026-08-19 用户：加上都加上——借鉴开源 agent 生态）

- **技能库（aiSkills.ts，借鉴 DSH Skills/开源 agent 技能模板）**：6 个技能（行情洞察/审价/BOM 拆解/卖点价值/项目体检/报告生成），AiPanel send 时 detectSkills 按提问命中 → systemPrompt 追加「当前任务技能」精炼步骤；+6 测试。
- **文件格式扩展（attachmentTools.ts + pickAttachment）**：📎 支持 .xlsx/.xls/.csv/.txt/.pdf——CSV 用 XLSX 读、TXT 按 tab/多空格/逗号拆表格（textToRows）、PDF 用 pdfjs-dist 提取文本（worker ?url 本地打包）按 y 坐标聚合行；统一 handleSheetRows → detectSheetType → 存全局附件（import_* 工具直接读）。
- **OCR（tesseract.js）**：图片附件立即 OCR（eng+chi_sim，语言包本地 public/tessdata/ 已下载，引擎 CDN 需联网）；OCR 文本走表格识别流程，拍照报价单 → 提取 → 审价/录入；send 时图片摘要提示已 OCR 行数或需联网。


## 三·补16、写操作安全：确认 + 审计（2026-08-19 用户：防止工具把数据库乱改）

- **三层防护**：①写前确认——导入类写工具（import_bom_to_project/import_supplier_quote/import_competitor_bom/import_voice_items）执行前 AiPanel 渲染「⚠️ 确认写入数据库」卡片（工具名+参数摘要），用户点执行/取消才继续；取消则返回"用户取消写入，未修改任何数据" ②写后审计——所有写工具（AUDIT_TOOLS：4 导入 + save_selling_analysis/save_project_analysis/create_todo/add_goal/insight_material_trend/quote_review）执行后 logWriteAudit 写 write_audit_logs（工具/参数摘要/结果摘要/时间），设置页「AI 写入记录」卡展示最近 15 条（谁·何时·用什么·改了什么） ③提示约束——【写操作安全】只有用户明确要求录入/导入/写入才调写工具，查询类绝不写库，不要擅自写入。


## 三·补17、结果可视化（2026-08-19 用户：体验的结果可视化很重要，重点规划）

- **ToolResultView.tsx**：8 个高频查询工具结果在对话里直接渲染（不依赖模型，代码级确定，从工具参数+库数据重查渲染）：query_project_cost→环形图+模块占比表、query_project_bom→BOM 明细表、query_target_status→目标达成表(红绿)、compare_subcategory_cost→柱状图(最低绿/最高红)、query_project_module_value→ModuleValueMatrix 四象限复用+表、query_competitor_bom→竞品对比表、insight_material_trend/query_material_insight→行情结果卡(趋势/置信度/摘要)。
- **集成**：AiPanel 步骤卡(Step.args 记录工具参数)内、detail 下方渲染 ToolResultView；v2 视觉(骨色底+等宽数字+信号色)；与文本结论并存。


## 三·补18、供应商画像 + 结果跳转 + 会话搜索 + 写入可回滚（2026-08-19 用户：这几个可以）

- **供应商画像**：getSupplierPriceProfiles（db/dataImport 报价聚合：覆盖器件数/平均价/价格水平比库内均价高或低%/最大份额；注意与 db/suppliers 的 getSupplierProfiles(档案表) 区分）；工具 query_supplier_profile（第 36 个）+ ToolResultView 表渲染（偏高橙/偏低绿）。
- **结果可跳转**：ToolResultView 项目类工具加「去项目页 →」按钮 → costhub-open-project 事件 → App 监听 navigate projects + 300ms 重发选中（Projects 懒加载）。
- **会话可搜索**：aiPanelChat.searchSessions（按消息内容/标题 LIKE）；AiPanel 历史会话下拉加「🔍 搜索历史会话」→ Modal 输入关键词回车 → 结果列表点击切换。
- **AI 写入可回滚**：write_audit_logs 加 undo_json 列；写工具内部收集插入 id（window.__costhub_undo：4 导入 + save_selling_analysis/save_project_analysis）→ AiPanel 审计时写入；undoWriteAudit(id) 按 undo_json DELETE；设置页「AI 写入记录」每条加「撤销」按钮（已撤销绿标）。


## 三·补19、物料规范化（canonicalize，2026-08-19 用户：一套通用规则套所有物料，导入+存量按项目规范）

- **规范化任务代码级接管（2026-08-27 用户二次实测：软拦截生效但模型被拦两次仍不走正道）**：1B 模型无法自主找对工具 → 规范化任务改为前端确定性驱动（runCanonicalDirect，仿 runCloudDirect）：send 检测 isCanonicalTask 且无附件 → 用户提问含项目代号则直接执行 canonicalizeProject；无代号则**代码级弹项目选择**（pendingAsk 自动填项目列表，不依赖模型 ask_user）→ 用户选 → 直接执行 → 审计（logWriteAudit undo_json 走 __restore_parts）→ 消息回填 + 广播刷新。模型完全绕开（规范化是确定性批量操作，模型只是内部分类器）。
- **规范化任务跑偏教训（2026-08-27 用户实测：主动说"把物料批量规范化一下"却收到"物料通用名没有洞察记录"）**：1B 模型把"规范化"误解成查物料行情 → 调 query_material_insight 还编造 material_name:"物料通用名"。修复：AiPanel 加 isCanonicalTask（/规范化|规范一下|标准名|统一命名|整理物料|物料规范/）+ IRRELEVANT_FOR_CANONICAL（行情/洞察/项目查询类 11 个）软拦截——规范化任务调无关工具时 [提示] 引导：指定项目→canonicalize_project，没指定→ask_user 问项目（选项给项目列表），严禁查行情/洞察、严禁编造物料名；系统提示【物料规范化】同步补引导。
- **隐线≠黑盒：人眼核对入口（2026-08-27 用户追问：如何知道规范对错/是否有幻觉）**：器件库表格加「规范化」列（getParts 幂等 ALTER 保证 canonical 列存在）——显示 规范名（Tooltip 品类·规格）+ 状态标签（未规范灰 / 笼统金 / 存疑橙=category 其他 提示重点核对）；操作列加「还原」按钮（Popconfirm → resetPartCanonical 清空影子字段，原名不受影响，logWriteAudit 审计，可重新规范）。防幻觉三线：①笼统物料 specs 空不编造 ②category='其他' 标"存疑"提示人眼重点核对 ③结果随时可见可还原（人眼核对是最终防线）。
- **隐线化（2026-08-27 用户：这个功能应该被动触发，因为是隐线）**：规范化改为导入时自动发生——canonicalizePartBatch（canonicalize.ts，单批 ≤20 隐线规范化：detectOllama 预检快速失败+60s 完全无输出放弃（有输出无限等不截断）+全程静默）；importProjectBom 新建器件后自动规范化（undoParts → canonicalizePartBatch，stats.autoCanonical 汇报）；模型不可用/失败静默不阻塞导入。canonicalize_project 降级为"存量项目一次性补录"（系统提示与工具 desc 同步：仅用户明确要补存量时才用，写操作仍要求用户指定项目）；导入汇报克制加"已自动规范 X 条新器件"。
- **canonicalize.ts**：AI 批量物料规范化——统一模板（品类|主规格|次规格|型号）+ 标准品类词表（14 类）+ 通用单位规则（K/M/u/n 等，不按品类）；**内容判定交给 AI**（不写品类解析器）；**笼统物料**（支架/底座）只归类不编造规格；健壮解析（JSON 数组/前缀包裹/截断逐对象抠出）；+5 测试。
- **存量按项目规范化**：canonicalize_project（第 37 个工具）——取项目 BOM 物料分批（20/批）调本地模型 → 写回 parts canonical_name/canonical_category/canonical_specs/canonical_updated_at（**影子字段：原名/模块库/关联不动**，ALTER 幂等兜底）；统计 已规范/笼统保留/失败。
- **安全**：规范化不改 parts.name 与 modules/project_boms.module_name（模块库分类原封不动）；笼统物料不编造规格；canonicalize_project 记审计。
- **收益**：规范后匹配/去重/统计/检索走 canonical 更准（后续接入 import 去重与供应商匹配）。
- **防卡根因（2026-08-27 用户实测"模型 90 秒无任何输出"）**：非代码 bug——实证 Ollama /api/ps 显示当前加载模型 size_vram=0（纯 CPU 推理）时，9B 模型首 token 可超 90s 被 runThinkLoop 无输出保护掐断。三层改进：①runThinkLoop 无输出保护 90s→180s 惰性（有 token 无限等不变，冷启动留时间）②AiPanel send 前实时 detectOllama 预检（不用页面加载缓存，区分 offline"Ollama 未运行" / model-missing"模型未下载"，快速报原因不空跑）③canonicalize_project 工具预检 + canonicalizeProject 收集失败原因 errors 返回（不再静默 failed++）。使用侧：规范化是短 JSON 分类任务，选轻模型（minicpm5 1.1B / qwen3:4b）即可，勿用 CPU 上的 9B。
- **ask_user 空选项教训（2026-08-27 用户实测：问规范哪个项目只有"继续/跳过"两个无意义按钮）**：1B 模型常漏 options → 三层修复：①AiPanel ask_user 拦截处 options 为空且问题含"项目/project"时**代码级自动填充项目列表**（getProjects 取代号前 12 个，不依赖模型）②pendingAsk UI 空选项时渲染**输入框+发送+跳过**（用户可自由回答，不再是无意义"继续"按钮）③ask_user 工具 desc/params 把 options 改为必填并强调"必须给具体可选项（问项目先 query_projects 拿列表），禁止空 options"，系统提示同步。
- **擅自选项目教训（2026-08-27 用户实测：没指定项目被规范了 M270）**：1B 模型不遵守提示词"没给目标先 ask_user"→ 代码级拦截：AiPanel executeTool 里 canonicalize_project 执行前检查 userContent 是否含项目代号（/[A-Za-z]{1,4}[-_]?\d{2,}/），无代号直接返回 [提示] 让模型先 ask_user（可先 query_projects 列项目），不执行不写库；工具 desc 与系统提示同步强调"写操作必须用户明确指定项目"。另修 verifyConclusion.extractNums 把列表序号（"1. 项目""3）继续"）误报为未溯源数字 → 数字后紧跟 [.、)）:：,，。] 标点即跳过（金额/百分比小数点在 m[0] 内不受影响），+1 测试。人工核对口径：结论数字应在对话工具 [RESULT] 中可见，找不到才附 [校验] 提醒，以工具结果为准。
- **修正闭环（2026-08-27 用户追问"规范错了如何处理/如何发现"）**：①核对——ToolResultView 渲染 canonicalize_project 规范化明细表（原名/型号/规范名/品类/规格/状态：已规范·笼统保留·未处理，代码级从库重查）②单条修正——明细表行内「还原」按钮（Popconfirm 确认 → resetPartCanonical 清空该物料 canonical 影子字段，原名本就没动；记 logWriteAudit('reset_canonical') 审计，可重新规范化）③整批回滚——canonicalize_project 执行时收集 UPDATE 前的影子字段原值 → window.__costhub_undo → 审计 undo_json（__restore_parts 结构）；undoWriteAudit 增加 __restore_parts 分支=UPDATE 恢复原值（非 DELETE 行），设置页「AI 写入记录」撤销按钮对规范化记录生效。

## 三·补20、任务状态可见 + 对话优先（2026-08-27 用户：指定任务时如何看到当前状态/能否同时跑多个模型）

- **现状回答**：①指定任务的状态 = AI 协作窗内轨迹卡链（📤发送→🔧工具(参数+结果)→🔐云端→📌结论）+ 流式输出（思考中/已 X 字）+ [PLAN] 计划清单 + 停止按钮；后台自主分析状态 = 驾驶舱 AutoThinkPanel 实时区 + costhub-ai-task 顶部任务气泡 + AI 情报 badge ②**不能真正并行跑多个模型**：Ollama 单实例，同模型请求排队串行、异模型切换加载（慢）——后台引擎与对话同时调模型会互相排队。
- **对话优先让路（本交付）**：Ollama 串行导致后台引擎抢模型会拖慢用户对话 → App.tsx 加模块级 dialogActive()（读 window.__costhub_ai_dialog）；四个后台引擎（compare 报价识别/advisor 自主巡检/insight 关键物料洞察/think 自主分析）调度开头若用户正在 AI 窗对话 → **本轮静默跳过**（下轮 60s 自动续，不丢任务不打扰）；AiPanel 在 streaming 开始/结束（send + runCloudDirect 共 4 处）维护 __costhub_ai_dialog 标记。
## 三·补22、原声附件代码级导入 + read_excel 拦截（2026-08-28 用户：分析源声却收到 read_excel 弹文件框）——voice 附件前端直接导入（提取评论列→importVoiceItems，产品名从提问/附件名提取）→ userContent 前置已导入说明让模型直接分析；executeTool 前置拦截 read_excel（有附件数据时提示勿弹文件框）；voice guide 文案改「已自动导入」。

## 三·补23、安全与备份基线（2026-08-30 代码体检）

- **认证/防遗忘（用户明确保留）**：CostHub 为单机使用；修改密码时同时保存 SHA-256 校验值与本机明文副本，登录页双击 Logo 可显示当前密码。该机制是用户为防遗忘主动选择的产品行为，后续优化不得擅自移除；界面须明确“仅本机可见”。
- **一致性备份**：运行中禁止直接分别复制 `costhub.db` 与 WAL；设置页必须用当前 SQLite 连接执行 `VACUUM INTO` 生成单文件一致性快照。恢复前关闭前端数据库连接；旧版 `.db + .db-wal` 备份仍兼容恢复。
- **依赖安全**：Excel 读写使用 SheetJS 官方分发 `xlsx@0.20.3`（npm registry 的 0.18.5 已停止更新）；未使用的依赖应及时移除。`pptxgenjs` 的浏览器构建不加载其 Node-only `image-size` 依赖，npm audit 仍会报告该传递依赖，升级前需验证 PPTX 兼容性，禁止盲目 `audit fix --force` 降级主库。
- **Tauri CSP**：生产配置不得为 `null`；只允许本地资源、Tauri IPC、data/blob 图片与本地/blob worker。新增外部资源必须先评估并最小化放行。
- **Lint 基线**：忽略 Rust 构建产物；动态数据库/AI 行结构暂允许 `any`，React Hook 规则、渲染纯度等结构性问题保持 error，其余遗留债务以 warning 逐步收敛。

## 三·补24、本地主脑、受控云端与 Skill 图表（2026-08-30 用户明确：成本数据绝不能流出，但本地模型可调云端补公开知识）

- **不可变安全边界**：数据库、本地工具结果和完整提示词只给 `127.0.0.1` / `::1` 上的 Ollama，`localhost` 强制改写为 `127.0.0.1`；普通 HTTP 禁止公网/局域网、代理与重定向。Ollama 读取成本数据前必须验证 Windows 出站阻止规则。
- **受控云端网关**：本地 27B 可申请云端补充公开行情，但只能走 Rust `cloud_http_request`：目标必须 HTTPS 且命中供应商域名白名单，请求必须关联已审查主题，并拦截项目/供应商/BOM/型号/金额字段、超大请求体和重定向。普通工具、Skill 和模型不能直接访问公网。
- **条件审批**：默认“新主题先审批”，外发前 `validateCloudQueryArgs` 严格审查，只展示通用物料名/品类/公开问题；批准后同主题本会话可连续完成搜索+分析。用户可选“审查通过后自动发送”，但代码审查与 Rust 网关不可关闭。
- **外链能力**：移除 Tauri shell 外链权限与依赖；来源链接只允许复制，由用户在 CostHub 外部自行处理，避免应用内导航形成旁路。
- **本地模型访问方式**：27B Ollama 不直接执行 SQL，只通过代码维护的白名单工具读取业务数据；写工具继续要求用户确认、写入审计并支持撤销。模型读取记录保留完整提示词、模型、任务类型和响应摘要供审核。
- **Skill 与图表**：`aiSkills.ts` 可固化本地分析方法；数据可视化 Skill 必须先查库，再调用 `visualize_cost_analysis`。图表数据由前端代码从 BOM 重新聚合，模型只能选择项目/维度/图形（饼图、分组柱状图、帕累托图），不得把模型自带数字直接画图。
- **审核顺序（保持简单）**：安全审计页按“本地模型读取了什么 → AI 写入了什么（可撤销） → 云端实际发送了什么”核对；底部审批横幅只展示三项白名单字段。
## 三·补21、新项目目标成本制定（2026-08-27 用户：整体目标外部输入，按上一代特性价值+价值工程分配到领域/特性）

- **口径**：整体目标成本用户外部算好手输（不做售价反推计算器）；领域 = BOM main_category 分组（用户领域词：大结构/大硬件/多媒体/包装/互连等，即 BOM 导入时的区分）；特性 = 卖点（声量）；新特性 = 无声量卖点（预算手输并入领域，不参与声量排序）。
- **纯函数 targetAllocation.ts（+5 测试）**：computeModuleCosts（BOM 按模块聚合，支持 field 参数）/ buildTargetAllocation —— 老特性模块按**价值密度（声量÷成本占比）**分配目标（客观不主观打分），模块内老特性按声量占比分摊，新特性预算扣除后并入所属模块，取整差额并入最大模块保证 Σ=目标（对账归零）。
- **UI TargetAllocationPanel**（项目页目标区，mockup design-mockup/costhub-target-allocation.html 落地第一版）：选参考上一代项目 + 目标总成本 → 生成分配建议表（领域行可编辑目标 + 特性行：声量/上一代成本/依据）→ 对账实时（Σ vs 目标差额）→ 保存为领域目标（project_targets，覆盖同名领域，驾驶舱目标达成按新分配跟踪）。
- **数据链路**：参考项目 BOM（main_category 聚合）+ selling_points（positive+negative=0 → isNew）+ selling_point_modules（特性↔模块映射）→ allocateModuleCosts（声量加权分摊）→ 价值密度分配。
- **分配口径修正（2026-08-28 用户：为什么声量大的成本目标反而低？——纯密度(声量÷成本占比)重新分配惩罚大头、无视成本刚性）**：改为**基线+有界调整**——基线=上一代成本占比（等比缩放，守住品类基本规律），因子=声量占比÷成本占比（>1 加投 / <1 降本），目标占比=基线×(1+(因子-1)×ALPHA=0.4)，钳制 [基线×0.8, 基线×1.3]（不砍穿物料刚需/不过度加码），归一化 Σ=目标。无声量领域因子 0 → 钳制保底 80%。测试更新（加投/降本/全无声量按成本占比）。
- **做到位（2026-08-28 用户：直接做到位）**：①特性级可编辑（InputNumber，新特性金边「你定」）②视图切换（按领域归集=领域列 rowSpan 合并+小计行 / 按关注度=声量降序平铺+新特性置底）③分配明细持久化（project_target_features 表 + get/saveTargetFeatures，重开可恢复新特性预算与手动调整）④领域目标=Σ特性实时对账 ⑤保存=saveTargetFeatures(特性级)+saveTarget(领域级=Σ特性) ⑥行样式 ta-sub-row/ta-feat-row。AI 工具 generate_target_allocation 仍留后续。
## 六、工作流约定

1. **构建由 AI 负责**：代码改动完成后 AI 执行 `npm run build` + `npm run tauri:build`（构建前确认 costhub.exe 未运行；build.bat 末尾有 pause 不适合脚本环境）；验证产物 exe 时间戳后向用户确认。
2. **文档铁律**：改代码 → 更新本文件（如涉及新约束）→ 更新 `会话接续说明.md` → 任务才算完成。新开对话先读 会话接续说明.md + 本文件即可接续。
3. **git**：推送 `git push costhub main`（origin 的 fork 拒绝属正常，忽略）。

## 三·补25、招标工作台第一阶段（2026-08-31 用户：按既有策划继续实施）

- **业务边界**：面向整机 ODM 招标的规格预估→摸底报价→比价→谈价→定点→复盘流程。理论组合底价是跨供应商可比最低价的谈判锚点，不是实际采购篮子；报价导入不覆盖现有项目 BOM、器件库或最终供应商选择。
- **数据层**：新增 `project_spec_baselines`、`tender_rounds`、`supplier_quote_batches`、`supplier_quote_lines`、`quote_line_matches`、`project_process_events` 六表；报价原文、批次和匹配历史独立保留，文件哈希幂等，规格变化自动冻结版本。
- **导入与页面**：`src/tenderImport.ts` 负责本地 xlsx/xls 表头探测、金额标准化、文件哈希和供应商名推断；`src/components/TenderWorkspace.tsx` 以新增页签接入项目详情，默认仍打开 BOM 页签，主流程为“导入→预览→确认”。
- **AI**：新增 `query_tender_analysis` 只读工具与 `tender` Skill；模型只能读取当前轮次矩阵，必须区分可比/等价/参考/待确认，不能把待确认价格计入底价或擅自写回。
- **安全与验收**：解析器无网络代码；工作台和 AI 工具不发送原始报价到云端。详细目录、接口、组件职责、验收标准和禁止事项见 `docs/招标工作台实施方案.md`。
- **过程确认补充**：报价行详情支持直接标记 `exact/equivalent/reference/incomparable/unmatched`，只有跨供应商可比关系计入底价；历史批次抽屉与过程时间线展示版本，不覆盖原文。
- **议价与复盘闭环**：机会项生成时同步写入 `negotiation_items`（草稿/已发起/已达成/已关闭）并导出 Excel；`tender_decisions` 保存最终定点供应商、整机报价、依据和复盘摘要。两者都不自动修改 BOM、器件价格或采购指令。

## 三·补27、全局浅色流光玻璃主题（2026-08-31 用户：按概念稿实施全工具 UI）

- 新增 `liquidLight` 主题并作为首次升级默认主题：浅色冷白底、半透明导航/容器、轻量背景景深、低饱和蓝/薄荷色强调；保留其它主题可在设置切换。
- 视觉边界：玻璃用于应用外壳、导航、卡片、弹层、AI 侧栏和所有数据列表；Ant Design 表格采用单层玻璃，外层卡片承担底色，表格容器、普通行及固定列透明，仅表头、悬停和选中状态使用轻微半透明色，避免横向区域出现一边白一边透明。
- 个性化设置新增“背景氛围”：支持本地 PNG/JPG/WebP（≤2MB）即时预览、更换和恢复默认；图片优先写入本机 IndexedDB（旧环境回退 `localStorage`），禁止网络加载/上传。
- 背景图导入会在本地将最长边限制为 1920px 并转为 JPEG（质量 0.84）后再应用，避免高分辨率图片导致 CSS 变量或本地存储体积过大。
- 个性化设置新增“玻璃质感”透明度滑杆（46%–86%）：通过 `costhub_glass_opacity` 本地保存，统一控制应用外壳、卡片与 AI 协作窗的透光层；成本表格跟随外层卡片透明度，文字维持高对比度保证数字可读性。
- 兼容性：低特效模式会关闭毛玻璃与背景景深但不改变业务操作；首次升级通过 `costhub-liquid-theme-v1` 标记只迁移一次，之后尊重用户选择。

### 驾驶舱布局（2026-08-31）
- `Dashboard.tsx` 默认使用招标工作流优先的紧凑布局：顶部关键状态带、项目进展、今日优先处理、项目成本分布、报价决策抓手和最近动态；跨项目成本使用排序式成本分布，不使用会暗示时间连续性的曲线；决策抓手优先呈现未读报价差异，回退展示已确认降本记录，并保留项目/情报/器件库直达入口。
- 驾驶舱项目行按下一行动展示，不将所有统计卡重复铺开；无数据时给出创建项目或积累报价的明确提示。
- 液态玻璃主题下左侧导航调整为 204px 悬浮圆角玻璃面板，品牌区、分组导航、AI 情报入口和用户设置区保持同一视觉层级；折叠模式仍保留。
- 右侧 `AiPanel` 在液态玻璃主题下采用独立头部/对话区/输入区层级，整体为 24px 圆角悬浮面板；输入、助手消息和上下文条使用 11–15px 圆角，保留原有模型、会话、附件、确认和发送行为。
- 左右侧边栏收放使用 280ms 可中断宽度过渡，内容以轻微位移淡入；窄宽度下 AI 收缩按钮保持可见。系统“减少动效”和应用“低特效”模式会关闭该过渡。
- AI 侧栏使用持久化 `.local-ai-shell` 包裹展开/折叠态，保证宽度过渡跨状态持续，不因 React 内容切换而闪变。
- 登录页统一采用双栏液态玻璃入口：左侧保留原始 CostHub logo 与本地数据/报价追溯/云端审批信号，右侧为登录表单；字段标题使用专用类名避免 Ant Design 输入外壳错位，双击 logo 显示本机密码机制不变，成功验证后播放约 680ms 的分层进入过渡再解锁主界面。
- 驾驶舱直达项目事件带 `__costhubForwarded` 一次性标记，App 的懒加载转发不会再次自触发；用户离开项目页时会取消未执行的延迟转发，避免被旧项目选择拉回。
- 项目管理按方案三改为项目上下文工作台：项目列表必须进入应用原有左侧导航，进入项目管理时侧栏收敛为驾驶舱/项目管理入口、项目搜索和项目列表；禁止在项目页面内部再增加项目列。主区顶部展示模块目标达成轨道（无模块图标，点击可筛选 BOM），SKU/报价/目标/快照/措施/复盘仍通过页签切换。
- BOM 工作区提供“全量表格 / 模块分组”视图：默认全量表格，使用连续可滚动网格、行号、多选、搜索，并允许双击单价或数量原位编辑、Enter 保存；模块分组继续保留参照价和跨项目比对路径。议价机会使用覆盖式抽屉，不得作为常驻栏挤压 BOM 宽度。
- 全量表格支持项目级自定义列（文本/数字）、复制行/批量删除、剪贴板多行粘贴；可用 Enter/F2、Tab、Shift+Tab 和方向键在可编辑单元格间移动，所有改动均写入 BOM 快照。
- 全量 BOM 提供沉浸式全屏查看：工具栏点击“全屏”后隐藏项目摘要、页签、应用侧栏和 AI 窗，表格自动扩大；Esc 或“退出全屏”恢复，切换项目页签时自动退出。
- 模块分组模式的合计行必须使用贯穿表格的单个全宽汇总单元格并沿用玻璃底色，不能以未覆盖完整列数的多个白色单元格造成段差；参照项目默认在工具栏统一选择，模块头展示当前/参照小计与差异，单模块覆盖通过“参照设置”下拉保留。
- 顶部目标卡必须按 BOM `main_category` 聚合为“领域目标达成”，实际成本按领域加总并与 `project_targets.domain` 对账；点击领域卡只筛选对应领域，不得误按模块名匹配。全量表格使用独立列设置记忆、连续横向滚动网格、复制选中行到制表符剪贴板和行数/合计状态条，原位编辑仅允许单价/数量并沿用既有快照审计。
- 全量表格支持 BOM 行复制、批量删除和项目级自定义列；自定义列定义存于 `project_bom_custom_columns`，行值存于 `project_boms.custom_data` JSON，文字/数字两种类型均可双击原位编辑。新增列、列值与复制项目必须走本地 SQLite，禁止只存浏览器临时状态或把自定义字段写入备注字段。

## 三·补26、PowerShell 无窗口运行（2026-08-31 用户：无窗口运行）

- 防火墙状态查询与本地加固脚本仍复用既有 Rust 安全边界，但 Windows 下通过 `CREATE_NO_WINDOW` 启动 PowerShell，提权子进程追加 `-WindowStyle Hidden`。
- 普通打开设置页、刷新 Ollama 状态不再闪出 PowerShell 控制台；用户主动点击“一键锁定 Ollama 外网”时仍会出现系统 UAC 授权，这是 Windows 的权限确认，不是应用控制台窗口。

## 三·补28、表格行内编辑与字段级历史（2026-09-01）

- 全量 BOM 才显示“全屏/退出全屏”按钮；从全量表格切换到模块分组时自动退出全屏，避免进入模块模式后没有可见退出入口。
- 器件库采用 Excel 式行内编辑：名称、型号、分类、成本、规格、使用项目和备注支持双击或 Enter/F2 编辑，失焦自动保存；操作列移除普通编辑按钮，保留供应商、修改历史、规范化还原和删除。
- 项目 BOM 的模块分组与全量表格共用双击编辑能力，支持模块、分类、名称、型号、单价、数量和备注字段；保存后自动刷新成本并写入快照。
- 新增 `data_change_history` 字段级历史表及 `logDataChange/getDataChangeHistory/getProjectChangeHistory` 接口；项目 BOM 与器件库均提供“修改历史”按钮，按时间、字段、原值、新值和来源展示。
- 项目 BOM 行内编辑会同步更新绑定器件、所有引用 BOM 快照和模块兼容数据；器件库行内/表单编辑也可同步引用快照。导入流程默认不改写既有项目快照，避免破坏历史报价。

## 三·补29、修改历史去重（2026-09-01）

- 成本变更继续写入既有 `part_price_history` 供价格统计使用，但不再同时写入字段历史表；器件库修改历史弹窗会兼容展示旧价格历史，并隐藏改版期间已产生的同时间/同旧值/新值重复记录。
- 修复跨页面刷新遗漏：切换到器件库时会主动重新读取数据库，项目 BOM 的行内修改无需重新登录即可在器件库看到；同时修正项目页切回时项目列表的刷新调用。

## 三·补30、AI 提升专项规划（2026-09-01）

- 详细方案见 `AI提升专项规划.md`。实施顺序固定为：工具契约与风险收口 → 结构化结果和证据链 → 核心业务 Skill → 建议闭环 → 云端审批加强 → 效果评测。
- 本地模型继续只通过白名单工具访问 SQLite，禁止自由 SQL；金额、差异和图表由代码计算，模型只负责理解、归纳和建议。
- 云端默认只允许经审查的公开知识查询；原始 BOM、供应商、项目、型号、金额和报价文件永不外发。后续 Luna 首次只实施阶段 0 和五个只读工具适配，不得一次性重写 AI 子系统。

## 三·补31、洞察本地兜底 + 审批重构 + 供应商地图品类（2026-09-21 用户实测：洞察还是失败要彻底解决 / 审批布局混乱且重复审批 / 供应商地图点开要看供应项目）

- **洞察永不因云端不可用而失败**：`agentSearchLoop`（trendService）拆成 `agentSearchLoopCloud` + 外层兜底——云端任何非用户拒绝的失败（未配置供应商、额度不足 402、Key 失效 401、网关拒绝、搜索 API 缺失、解析失败）都转入 `localKnowledgeInsight`（本地模型基于公开知识分析，`src/localAnalysis.ts` 的 `collectLocalText`：流式 + `json:false` + `num_predict:16384` + 180s 无输出惰性超时 + 支持取消）。本地结论必须诚实标注：`summary` 附「[来源] 云端不可用（原因）…未联网、时效性有限」，幅度数字一律置空（不许编造价位），`source='local-knowledge'`。**唯一不兜底的例外**：用户自己拒绝/取消云端发送（`isUserStop`）——那是明确的用户决定，不能偷偷换通道。`createStructuredInsight` 同样有本地兜底。
- **供应商冷却（少打扰）**：`src/ai/providerHealth.ts` 按错误分级冷却——额度(402)/鉴权(401) 30 分钟、网络 2 分钟、其他 1 分钟；`callLLMChat`/`callLLMWithFallback` 跳过冷却中的供应商，原生搜索在冷却期直接返回 null 不再申请审批；调用成功即清除记录。避免"反复弹审批 → 还是失败"。
- **审批：拦截不再静默**：`prepareCloudConfirmPayload` 命中敏感规则时**不再 throw**（旧逻辑 throw→`requestCloudConfirm` return false→根本不生成卡，用户看不到命中什么），而是带着 `riskItems/riskLevel/riskVerdict/suggestedQuery/gatewayAcceptable` 入队生成可读卡片。硬命中（金额/成本、供应商公司名、项目代号与内部字段、BOM/料号/客户/订单）网关层没有出口，只能改名；软命中（型号/规格数字、数字区间）用户可强制批准。
- **审批：用户最高权限怎么落地**：`approvePending(id,{force})` 对软命中放行；物料名含数字时普通检索通道被网关拒绝，卡片提供「改用公开型号通道」（`switchPendingToPublicModel` → C1_PUBLIC_MODEL + category='公开型号'，这是型号数字唯一被允许的通道）与「采用建议通用名」（`applySuggestedQuery`）。`isGatewayAcceptable()` 提前算出网关是否会接受，**不给出"点了批准也发不出去"的按钮**。
- **审批：不重复审批**：Rust `ai_approval_grants` 幂等补列 `grant_class`；`create_cloud_approval_grant` 按分级 clamp——`theme`（公开检索主题 C1/C1_PUBLIC_MODEL）最长 7 天，`payload`（含 C1_PUBLIC_CONTEXT/C2 整份正文哈希票）维持 30 分钟。前端「记住此主题（7 天不再问）」走 theme 票；**C1_PUBLIC_CONTEXT/C2 永远不能长效复用**（正文每次不同，忽略逐字节哈希＝空白票漏洞）。
- **审批：卡片四分区 + 内置模板折叠**：`CloudApprovalCards.tsx` 按 ①这条请求要做什么 ②将要发出去的内容 ③本地判定 ④你可以怎么做 分区；`src/ai/promptTemplates.ts` 用内置模板（BUILTIN_SKILLS/CLOUD_SYSTEM_PROMPT/c2SafeSystemPrompt，含 cloudSafePublicText 公开化版本）逐字定位，命中的内置提示词折叠成 `<details>`，只展开"需要核对的新增内容"（`splitPreviewPayload` 支持 messages 与原生搜索 input 两种形状）。inline 卡补齐 material/category/question/onReviseSearch/onSkipLongTerm（与列表卡能力对齐）。
- **供应商地图**：点击地图圆点或卡片 → 供应商弹窗默认「供应项目情况」（`SupplierProjectPanel` + `getSupplierProjectCoverage`：器件供货按项目聚合器件数/供货金额/项目 BOM/占比，另含整机承接与招标报价批次；金额沿用快照优先 `part_cost>0 ? part_cost : parts.cost`，份额按 `share_ratio` 百分比、未填视为 100%）。
- **供应商品类**：字典存 settings `supplier_categories_v1`（默认显示器/鼠标/手写笔/键盘/平板/PC/耳机/充电器/包装，合并项目品类与已用值），供应商↔品类多值存新表 `supplier_category_links`（运行时幂等建表，同时把首项回填 `supplier_profiles.category` 保持旧展示兼容）；资料表单用 `Select mode="tags"`（可直接新增），地图上方 chips 按品类筛选（与器件大类筛选相互独立）。

## 三·补32、构建流程铁律补充（2026-09-21）

- 构建前确认 `costhub.exe` 未运行（被占用会导致替换失败）；标准流程 `npm run build`（tsc -b + vite build）→ `npm run tauri:build`，两者都要拿真实退出码。
- 全量 vitest 与 Rust release 构建**不要同时跑**：并发会拖慢导入导致 `costPackage.test.ts` 之类用例偶发失败（单跑即过）。排除偶发前先单跑该文件确认。
- **第三方/模型响应解析铁律（2026-09-21 实测"洞察成功但什么都没收集到"）**：解析外部响应（搜索/LLM 引用）必须用「通用深度遍历 + 显式识别嵌套结构」（`src/ai/nativeSearchSources.ts` 的 `collectNativeSources`），**禁止按固定键名白名单走查**——DeepSeek/OpenAI 的引用是 `{type:'url_citation', url_citation:{url,title}}` 嵌套，白名单取不到 → 来源数 0。同理：**"没有可点击来源"只能是证据强度降级，不允许把已经拿到的分析整份丢弃**（`createStructuredInsight` 无链接但有联网归纳时继续出结论，标 `evidence_strength='仅模型归纳'`、不伪造 URL、追加证据风险）。

## 三·补33、源文件编码事故与铁律（2026-09-21）

- **事故**：用 `Get-Content -Raw` 读 + `Set-Content -Encoding UTF8` 写回 `src/trendService.ts`（做一次跨文件字符串替换）时，**harness 的 shell 是 Windows PowerShell 5.1**，它按 ANSI(GBK) 读取无 BOM 的 UTF-8 源文件 → 全文件中文被双重编码破坏（962 处中文字符丢失、部分引号被吞）。后续用"损坏函数模拟 + bundle/会话快照反查"逐步还原，代价极大。
- **铁律**：**永远不要用 shell 文本命令（Get-Content/Set-Content/Out-File/-replace 赋值）改写源码文件**。要用 `edit`/`write` 工具；确需脚本处理时，必须 `[IO.File]::ReadAllText/WriteAllText($path, [Text.UTF8Encoding]::new($false))` 显式指定 UTF-8，且 .ps1 脚本本身保持纯 ASCII（PS 5.1 按 ANSI 读脚本，脚本里的中文字面量会解析失败）。
- **恢复手段（记录备查）**：①`dist/assets/<chunk>.js` 构建产物保存了所有字符串字面量（模板字面量内容含缩进与 `${}` 插值，可反查）；②`~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd` 是会话快照（多帧 zstd，Node 25 `zlib.zstdDecompressSync` 逐帧解压），含历史 `read` 原文，可按"损坏函数 Sim() 反演"精确回填；③损坏函数 = `UTF8.GetString(GBK.GetBytes(GBK.GetString(UTF8.GetBytes(text))))`（可复现、可校验：修复后整文件 Sim 应等于损坏版本）；④**`git show HEAD:<file>` 是静态模板（提示词/常量）的权威比对源**——恢复后必须逐字比对这类模板，别凭记忆重写。

## 三·补34、洞察链路：云端只检索、本地做研判（2026-09-21 用户明确）

- **分工**：`agentSearchLoop` 负责"取回公开事实"（DeepSeek 原生联网搜索，或第三方搜索 + 云端多轮检索），产出的来源与归纳只是**证据**；`createStructuredInsight` 负责**研判 + 按 Skill 格式产出**（Skill 方法论 + 该 Skill 的 outputDimensions + 严格 JSON），**默认交给本地模型**（`collectLocalText`，温度 0.2），本地不可用（未启动/未选模型/推理失败）才落回云端模型并在 console 说明原因——不中断功能、不假装是本机结论。
- **透明标注**：结论 summary 尾部追加 `[研判] 本机模型（xxx）研判` / `[研判] 云端模型（xxx）研判`；无链接来源时另标"证据强度已降级"。用户要能一眼看出是谁做的研判。
- **安全边界（测试会拦）**：外发（云端）正文**只能含已脱敏的公开来源**；"云端检索归纳"这类聚合文本只允许进**本地**提示词（localSourceContext），**绝不能**塞进云端 sourceContext——`materialInsightApproval` 的"不外发本地项目成本"用例就是拦这个的（本轮真实拦下过一次）。
- **维度映射铁律**：`normalizeStructuredResult` 必须保留模型返回的 `dimension_type` 去匹配 Skill 的维度名；**任何把它写成固定值（如 `'系统提示'`）的改动都会让页面全部退化成"公开信息不足"兜底文案**（2026-09-21 实际事故）。

## 三·补35、洞察链路质量闸门与检索关键词（2026-09-21 用户实测：洞察还是没有获得有效的信息）

- **检索关键词必须由已批准字段重建，且是关键词不是句子**：`src/ai/searchQuery.ts::buildPublicSearchQuery(material, question)` 是**唯一**来源，`cloudConfirm`（审批卡 + 载荷哈希）与 `trendService.executeSearchRounds`（实际请求）必须调它，否则网关载荷绑定会拦；它必须是**纯函数**（不含当前时间），否则审批与执行之间哈希会漂移。旧实现发的是 `${material} ${question}`——question 是常量疑问句，等于把一整句话当搜索关键词，召回质量崩坏（实测召回过赌博站与招股书 PDF）。
- **来源必须过质量闸门**：`src/ai/sourceQuality.ts::gateSources(sources, materialName)`——①硬剔赌博/色情/站群域名与标题；②按"物料特征词"（去掉通用品类词后的部分，如 `27寸/LCD/OC` 而不是"面板"）命中数排序；③**一条都没命中时保留少量来源并标记 `weak`，绝不返回空**（返回空会让上层走"未获取可点击公开来源"的硬降级，用户明确反感"什么都没收集到"）；④弱相关时必须把"这些来源没有直接提及该物料"写进给模型的提示词，否则模型会把泛新闻当成本物料行情。结论里用 `describeSourceQuality` 如实说明剔除了几条、是否全部弱相关。
- **一次审批 = 一个固定查询**：网关对搜索请求做载荷哈希绑定，多轮"让模型换关键词再搜"在物理上不可能生效——不要按 `skill.maxSearchRounds` 反复搜同一句（旧实现还因此在最后一轮把"没有新增来源"误判成"没有来源"而**丢弃已拿到的来源**）。正确流程：**一轮关键词搜索 → 质量闸门 → 一次整合分析**。
- **原生搜索零引用不算成功**：`tryDeepSeekNativeInsight` 返回 200 但没有任何可点击引用时，如果配置了第三方搜索就继续走真检索；只有没得选才保留"仅模型归纳"的降级结论。
- **本地研判必须拿到本机内部事实**：`src/ai/insightLocalContext.ts::buildInsightLocalContext(projectRows)` 产出项目/模块/用量/单价/金额（聚合按全量、明细截断），通过 `createStructuredInsight(..., { localContext })` **只喂本地分支**。没有它，"看自己/看竞争/成本敞口"这类维度只能写"本次未提供自身 BOM、用量、库存或采购价"——这是用户说"没有有效信息"的另一半原因。
- **提示词里的 JSON 示例必须用半角引号**：曾出现 `“trend_direction”:”上涨”` 这种中文引号示例，模型照抄 → JSON 解析失败 → 整条结论报废。改提示词时顺手检查 `**加粗` 是否闭合。

## 三·补36、敏感性筛查必须是真实判断（2026-09-21 用户质疑：写死走本地、没有真实判断——**质疑成立**）

- **禁止用字面量来源标签短路判定**：`piRuntime` 曾固定传 `sourceTypes: ['private_workspace']`，`evaluatePrivacy` 在"来源策略"第一步就返回，**正则与分类器从未执行**，而 UI 却渲染成"未发现规则命中"（不实陈述）。现在用 `deriveContextSourceTypes(messages)` 按**真实消息**推导：只有确实带工具结果/工作状态注入时才 `private_workspace`；纯系统提示 + 用户提问会真正走内容级正则 + 分类器。
- **正则闸门总是执行**，命中项如实记入 `regexMatches`（即使分类已由来源策略决定）——UI 三态展示：命中（列出命中项）/ 已执行未命中 / 未运行（并说明为什么没运行）。
- **分类器要有内容级依据**：`contentPrivacyClassifier` + `detectLocalBusinessSignals`（金额、成本数字、项目短码、内部字段、公司名后缀、本地路径、私钥、API Key、Bearer、手机号、邮箱）返回可解释的 reasonCode；命中即 `sensitive`，干净则 `unknown`（**仍然 fail-closed：只有 `public` 才可能上云**）。禁止再写 `() => ({ classification: 'unknown' })` 这类恒值 classifier。
- **乐观默认即误导**：审批卡不得用 `riskLevel || 'clear'` / `gatewayAcceptable !== false` 把"审查从未运行"渲染成"未命中"；缺结果时显示 `unreviewed · 没有可用的本地审查结果`。`GatewayTracePanel` 不得把同一个 `privacy_evaluation` 事件渲染成两个独立节点，也不得硬编码"本轮实际选择的路由"这类假依据。

## 三·补37、上下文压缩：机制移植 DSH（2026-09-21 用户：压缩好像没有作用，原理要跟 DSH 一致）

- **机制**（`src/ai/compactionCheckpoint.ts`，移植自 `dsh-compaction-basic`）：压缩指令作为**最后一条 user 消息**追加在原文之后（不另起 system，保持前缀一致）；强制输出**固定 8 章节 Markdown 检查点**（主要请求与意图/关键技术概念/文件与代码/错误与修复/待办工作/当前工作/下一步/关键上下文），空章节写 (none)、一节都不许删；摘要用 `<compacted-summary>` 包裹并加"这是已确立的背景"前言；原文已有旧检查点时必须**合并**（保留仍成立的事实、丢弃过期的）；**fail-closed**——摘要为空/只有标题/被截断就拒绝提交。
- **压缩调用参数**：`json:false`（要 Markdown 不要 JSON）、`num_predict:16384` 不截断、**惰性看门狗**（180s 完全无输出才放弃，不要 240s 硬掐断慢模型）。旧的"7 字段严格 JSON + json:true + num_predict≤768"在 CPU 机器上频繁超时，失败即退化成剪枝。
- **压缩目标必须真的变小**：目标定在 **yellow 水位以下并留 20% 余量**，并有**最小收益判据**（省不到 10% 就放弃并如实报错）。旧目标 `0.6×inputHard` 压完仍停在触发带内，实测 `tokensBefore 5805 → tokensAfter 5882`（越压越大）。仅校验 `tokensAfter > inputHard` 是不够的。
- **不要用 `result.state &&` 当提交条件**：首次压缩前 state 为 undefined，会把黄灯剪枝与失败兜底剪枝**整份丢掉**，而 UI 已经报了"已压缩 X→Y"。提交条件只看"消息是否真的变了"。
- **窗口要够得着水位**：`effectiveContext` 不再直接取模型**宣称**上下文（qwen3 40960 / gemma3 131072 会让水位落在 1.7 万/6.7 万 token，自动压缩永不触发，一旦真超出 Ollama 会从最前面静默截断），统一 `LOCAL_CONTEXT_CAP = 32768` 封顶。
- **手动压缩要有反馈**：streaming 时点"压缩上下文"必须提示（不能静默 return），压缩后**同时刷新界面可见的历史与上下文预算数字**，失败文案写"未压缩，已保留原始历史"而不是"已转为保守剪枝"。
- **兼容模式同一套机制**：`thinkEngine.compactThinkMessages` 用同一份检查点提示词，摘要失败保留原历史；禁止回到按字符数折叠、把工具证据替换成一句固定话术的旧做法。

## 三·补38、执行中补充指令与轨迹可收缩（2026-09-21 用户：执行中发不出补充指令 / 工具调用过程要能收缩）

- **三条注入通道，不允许静默丢弃**：pi 原生模式 `agent.steer` / `agent.followUp`；兼容模式 `runThinkLoop` 的 `steerQueue`（每轮开始前 drain 成一条 user 消息，带"用户补充指令最高优先级"提示）；云端直连/规范化直连（`runCloudDirect`/`runCanonicalDirect`）**没有注入通道**，必须明确告知"请先停止生成再发送"。`send` 的 `if (streaming)` 分支在无 `piAgentRef` 时的静默 `return` 是用户报"发不出去"的直接原因。
- **运行类型要用 state 参与渲染**：`runKind`（idle/pi/think/direct）决定排队按钮是否可用与提示文案，必须用 `useState`——在 render 里读 ref 会拿到过期值并触发 `react-hooks/refs` error；`Date.now()/Math.random()` 这类非纯调用放到**模块作用域**（写在组件体内即使只在事件处理器里执行也会被 `react-hooks/purity` 判为渲染期调用）。
- **轨迹折叠**：一条消息一个折叠组（默认"流式中且是最后一条"或"步数<3"才展开），**用户手动切换后手动选择永远优先**；每张工具卡再单独折叠（参数 JSON / 完整输出 / 可视化收进内层，懒挂载）。不要用 `open={streaming && …}` 这种计算值——run 开始/结束会强制改写用户的展开状态。
- **弹层定位铁律**：**不要在 `.ant-tooltip` 等弹层根节点上写 `transform` 关键帧**。rc-trigger 定位时会测量自身视觉缩放并把偏移量**除以** scale（`offsetX: nextOffsetX / scaleX`），动画结束后缩放回到 1，那份补偿就变成**永久位移**（右侧面板偏移上千像素 → 错位数十像素）。要更快出现就对 `.ant-tooltip-inner` 动 opacity。
- **antd Dropdown 默认 `trigger=['hover']`**：想让按钮"点击打开"必须显式 `trigger={['click']}`；按钮没有 onClick 时点击不会有任何反应（历史会话按钮的实际 bug）。
- **静默 no-op 是 bug**：`if (streaming) return;` 这类守卫必须给用户可见反馈（tooltip 说明 / toast / `Modal.confirm`），否则用户只会认为"点了没反应"（新对话、切会话、压缩上下文三处都踩过）。

## 三·补39、检索查询词铁律：网关严格相等，不许拼接（2026-09-21 真实事故，用户："还是显示公开信息不足"）

- **Rust 网关 `validate_public_query_binding`（src-tauri/src/lib.rs:2678，C1 作用域）做的是严格相等**：
  `normalize_public_query(body 里的 query/q) == normalize_public_query("{material} {question}")`（折叠空白 + 转小写）。
  **在查询词后面追加任何内容都会被拦**，报 `云端请求已拦截：查询词超出已批准的公开主题范围`（日志落在 `outbound_request_logs`，`status_code=0`）。
- **要提升召回质量，改"问题"而不是改查询词**：问题（question）同样是已批准字段、会显示在审批卡上，所以关键词必须放进 question
  （`src/ai/searchQuery.ts` 的 `PUBLIC_PRICE_QUERY_QUESTION`），查询词用 `buildPublicSearchQuery()`（= `material + ' ' + question`，只做空白归一）。
- **三道防线（缺一不可）**：①`executeSearchRounds` 发请求前用 `gatewayExpectedQuery()` 自检，不一致就当场报错、不浪费审批；
  ②测试里**逐字镜像 Rust 的 normalize + 严格相等**（`insightPipeline.test.ts`），并对 `materialInsightApproval` 里**真实外发请求体**跑这套镜像；
  ③`isDeterministicCloudBlock()` 识别拦截类失败——**不重试**（确定性失败重试只是再失败一次），且**必须把原因报给用户**，
  绝不允许像旧实现那样用 `Promise.allSettled` 把错误吞成空数组（"被拦了"和"真没结果"在上层看起来一模一样，用户只能反复重试）。
- 审查不通过（如物料名里带金额/型号）也必须抛 `CloudApprovalValidationError` 明确报原因，**不许静默降级成本地知识分析**。

## 三·补40、"批准后继续"必须有派发方（2026-09-21 用户："让我反复确认云端行情查询提交，这个是个大bug"）

- **事件只有监听方 = 死代码**：`costhub-insight-request` 以前只有 AiPanel/App 监听、**没有任何地方派发** → 点批准后什么都不发生，
  用户只能重新提问 → 又看一次审批 = "反复确认"。现在 `cloudConfirm.issueGrant()` 签发授权后派发它，并带
  `{material, category, requirementKind, pendingId}`；AiPanel 优先用事件里的物料直接 `runCloudDirect`（不经过模型重跑）。
- **不要用自然语言文案做机器判断**：AiPanel 判断"只是入队未发送"曾匹配固定串"等待云端发送确认"，而 aiTools 的文案早已改成
  "已生成真实待审批请求…" → 永久失配（`pendingRetryRef` 永远为空）。改用共享标记 `APPROVAL_PENDING_MARKER` +
  `textMeansApprovalPending()` / `stripApprovalMarker()`：判断只看标记，标记不展示给用户和模型。
- 新增/修改任何"需要用户批准才能继续"的工具时，返回文本里必须带上该标记，否则批准后不会自动续跑。

## 三·补41、维度名容错匹配（2026-09-21，同一"公开信息不足"症状的第二条独立成因）

- **维度名是模型自由输出，禁止只用完全相等匹配**：`dims.find(x => x.dimension_type === key)` 这种写法会让本地 9B 的
  「供给面」「1. 成本因子」「成本因子（Cost）」「金融与政策因子：」全部对不上 → 模型写好的内容被兜底文案吞掉。
  统一用 `src/ai/skillDimensions.ts`：`normalizeDimensionKey`（全角→半角/去空白/去序号/去括号/去标点）+ `findDimension`
  四级降级（全等 → 互相包含[≥2字] → 公共前缀≥2字且唯一 → 按位置兜底）。
- `normalizeStructuredResult` **不得因为匹配不上就丢内容**：匹配不到时写"模型未返回该维度的内容（如实标注，未编造）"，
  模型多给的维度也保留入库；`Decomposition` 的三处渲染（swot/pest/五力与维度列表）同用容错匹配，历史快照也能正常显示。
- **提示词禁止教模型交白卷**：不允许写"搜不到就写'公开信息不足'"。必须三级优先：①用来源事实回答（标序号+时间）
  ②给"间接推断，依据是…" ③确实没有时写"公开信息不足：【缺什么】；建议：【下一步查什么】"。

## 三·补42、云端审查自动放行（2026-09-21 用户明确："像铜这种有什么敏感的么？可以直接自己通过"）

- `cloud_auto_approve_clean` **默认开启**：`isCleanAutoApproveEnabled()` 返回 `!== '0'`（设置里显式关掉即恢复"每次确认"）。
- **放行不等于放松审查**（不可关闭的三层仍然照跑）：①本地 `reviewQuery`/`validateCloudQueryArgs` 硬软规则
  ②Rust 网关的字段/域名/载荷绑定 ③审批历史记 `auto_approved` + 依据。
- **仍然强制出卡**：命中硬规则、C2 抽象分析、非公开投影的整份正文、审查结果缺失（`riskLevel === 'unreviewed'`，乐观默认已移除）。
- 改这条默认值时必须同步更新 `cloudConfirm.test.ts` / `materialInsightApproval.test.ts` 的设置 mock——这两个文件的
  `getSetting` mock 要**按 key 返回真实策略值**，否则 mock 常量会把策略行为掩盖掉（本轮就把 4 个用例的语义暴露出来了）。

## 三·补43、证据引用要宽容解析（2026-09-21 子代理实测：本地模型卡在"格式无效"上打转到没有结论）

- `readSessionEvidence`（aiPanelChat.ts）原来只认 `message:<id>` / `event:<id>` / `state:<index>` 三种严格写法，
  9B 模型写 `证据1` / `msg:12` / `消息 12` / 裸数字 `12` 就判无效 → 它换一种写法再试、再被判无效，整轮预算烧光也没结论。
- 现在：`parseEvidenceReference()` 宽容解析（`msg:`/`消息`/`事件`/`状态`/`#12`/裸数字→按 message），
  真解析不出来时返回**该会话里真实可照抄的引用示例**（不是一句"格式无效"），并在错误里明确"不要再试新写法，直接用已有信息作答"；
  `read_evidence` 工具描述同步写明"两次被拒就停止重试"。加工具判断"模型是否在格式上反复试错"时，参照这条。
- 同一类问题的通用原则：**凡是给模型回错误信息的地方，都要顺带给"正确示例 + 停止重试的指令"**，否则弱模型会无限重试。
