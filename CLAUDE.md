### v2.3.19 autoThink 避免重复思考（2026-08-17，用户问：思考循环如何避免重复思考）——三层去重
- **① 轮内去重**（thinkEngine runThinkLoop）：同一轮循环中相同 工具+参数 只执行一次（callCache）——重复调用直接回填上次结果并提示模型结果未变化不要重复调用；重复的云端申请也不重复弹审批
- **② 轮间去重**（autoThink）：数据概览（buildThinkOverview 输出）指纹 hashString 存 settings ai_think_overview_hash——**数据无变化 → 本轮跳过**（事件 kind=skipped，面板显示「数据无变化，复用上轮结论」），数据一变立即重新分析；手动「现在分析一轮」带 force 强制
- **③ 云端去重**（autoThink runCloud）：同一物料 7 天内已洞察 → 复用 ai_bridge_logs.cloud_result（返回 reused 标记，结果前加 ♻ 前缀），不重复烧云端 token；新查询结果回写 ai_bridge_logs 供后续复用
- **验证**：tsc -b 0 错；177 vitest 全过
### v2.3.19 后台自主思考引擎 autoThink（2026-08-17，用户澄清：不是用户指挥的分析，而是 AI 自发的分析，并把过程呈现出来；现有比价/巡检/洞察都算它思考的一部分）
- **调度**（App.tsx scheduleAppThink）：启动立即一轮 + 每 15 分钟一轮 + 数据变更事件（costhub-compare-request）后 5 分钟节流触发；防重入（模块级 + running 日志兜底）
- **引擎**（src/autoThink.ts）：buildThinkOverview 收集本地概览（项目/BOM 成本/报价情报/自主建议数）→ 复用 runThinkLoop（Ollama 原生 function calling，≤6 轮）→ 模型自主决定深挖方向（工具核实）→ 需要行情时 cloud_market_query → **requestCloudConfirm 审批**（preview 挂底部横幅队列，auto 放行；确认过的物料会话内放行）→ 输出 200-400 字结论（发现/判断/建议）→ 落库 ai_think_logs（thoughts/tools_json/clouds_json/conclusion）→ 广播 costhub-think-event 实时呈现
- **呈现**（src/components/AutoThinkPanel.tsx，驾驶舱 AIWorkspace 下方）：顶部汇总现有后台引擎状态（报价情报 N 待处理/自主建议 N/物料洞察 N 类——即它思考的一部分）+ 实时区（进行中的一轮：💭 思考流 / 🔧 工具卡 / 🔐 云端申请（等待审批提示） / 📌 结论，事件驱动流式）+ 历史时间线（ai_think_logs 可展开看完整思考/工具/云端/结论）+「现在分析一轮」手动触发
- **复用**：thinkEngine.ts 抽通用 runThinkLoop（ThinkEventHandlers/ThinkLoopOptions）——前端「🧠 自主分析」sendThinkTask 与后台 autoThink 共用同一循环协议（buildLocalToolDefs/buildCloudToolDef/审批/云端执行器注入）
- **验证**：tsc -b 0 错；177 vitest 全过
### v2.3.19 自主分析引擎（🧠 像 DSH 一样自主思考 + 按需申请云端，2026-08-17 用户核心需求）
- **背景**：用户要求"按面积算成本只是给本地模型思考的其中一个思路，不能机械执行；要看到调动本地模型思考的过程；自主思考、自主调用云端、遇权限问题就申请（像 DSH harness）；权限=是否可以发送什么样的提示词给 LLM；思考过程渲染流畅，UI 参考 DSH"
- **设计原则**：本地模型 token 免费不涉安全 → **思考不设限**（多轮自由循环 + 流式渲染思考过程）；云端调用 = **权限申请**（申请"发送什么提示词给云端 LLM"，preview 就地审批弹窗，auto 直接放行）
- **入口**：本地 AI 助手输入框 Segmented 三态（💬 普通对话 / 🤖 Agent 任务 / 🧠 自主分析）
- **引擎**（src/thinkEngine.ts 纯逻辑，vitest 9 用例）：Ollama 原生 function calling 循环（≤8 轮）——流式思考（onReasoning）→ 模型输出 tool_calls → 本地 13 工具直接执行 / cloud_market_query 虚拟工具走审批后 agentSearchLoop → 结果回填继续 → 无工具调用输出结论；buildThinkSystemPrompt 注入**灵活思路引导**（带尺寸物料可考虑单位面积成本/按同样尺寸折算，也可数量阶梯/工艺/供应商/规格差异，不要机械套用）；buildCloudReviewPrompt 审批展示脱敏三字段（物料名/品类/问题）；buildLocalToolDefs 从工具元数据自动生成 Ollama schema
- **过程渲染（DSH 式）**：think 过程卡——💭 思考过程（灰色流式实时，分轮展示）+ 🔧 工具调用卡（✓/✗ + 语义图标 + 参数 + 结果摘要）+ 🔐 云端申请卡（琥珀色：等待审批/已批准+结果/已拒绝）+ 最终结论区（流式）；云端审批复用 aiBridge 的 bridgeReviewPrompt/bridgeReviewResolve Modal（预览脱敏提示词全文，确认/取消）
- **云端边界**：审批通过才走 agentSearchLoop（外发仅物料名/品类/问题，与 aiBridge 同安全边界）；拒绝时模型收到"用户拒绝"可继续基于本地数据分析
- **验证**：tsc -b 0 错；177 vitest 全过（17 文件）
### v2.3.19 报价情报识别升级 + 本地→云端审批（2026-08-17，用户反馈）
- **① 情报显示**：成本改四位小数（toFixed(4)）；每行带子类 Tag（geekblue）+ 名称/型号/规格悬停完整显示（title，\n 分隔）；比对弹窗 rows 同步补 sub_category + specs
- **② 逐行「不是同一器件」**（markRowDifferent，情报组内每行 ✗ 按钮）：#ROWDIFF#<partKey> 别名沉淀（source=marked_different），该行从情报/识别输入消失；buildInsights 的 ai/rule 组均过滤 rowDiff 行；已处理视图三态（确认同一/标记不同/标记不是同一器件）+ 撤销（undoHandledInsight 增 row_different 分支）
- **③ AI 识别规则升级（autoCompare v3，指纹加 v3| 前缀强制旧缓存失效重识别）**：输入排除完全同名同型号行（exactCount<2，规则组已覆盖）；提示词强化——必须同一种器件（同子类：都是接口/电容/电阻，不同子类名称接近也不算）、完全一致不列、规格多指标顺序不一致按内容集合判断（"24V 3A 适配器" vs "3A 24V 适配器"）、写法相近才列；输入行带 子类+规格
- **④ 尺寸类物料按同样尺寸评估成本**（parseDimension/dimensionAnalysis 纯函数，vitest 8 用例）：识别规格 W×H mm/cm/英寸（×/x/* 分隔），面积 cm²，单位面积成本 ¥/cm²，组内 ≥2 行有尺寸 → 情报卡片显示蓝色 dimension 条「📐 按同样尺寸评估：参考单位面积 ¥0.0336/cm²（中位）—— A 200×150mm ¥8.40（¥0.0280/cm²）/ B 250×180mm ¥15.12（¥0.0336/cm²）」；specs 批量查询 getPartsSpecsMap（db/parts.ts）
- **⑤ 本地模型→云端审批全覆盖（用户新增需求）**：agentSearchLoop 各入口统一安全边界——autoInsight（后台，非打断式队列 ✓ 已有）、aiBridge runBridgedInsight（preview 弹窗 ✓ 已有）、**Agent 工具 insight_material_trend 补审批**（aiTools.ts execute 先 requestCloudConfirm，preview → 入队返回未批准文案提示底部横幅，确认后重发任务即放行（会话级记忆））；手动快捷洞察（用户主动触发）不拦
- **验证**：tsc -b 0 错；168 vitest 全过（16 文件）
### v2.3.19 报价情报数据混乱 + 侧边栏入口白屏修复（2026-08-17，用户反馈）
- **① 侧边栏「报价情报」其他页面点击白屏/没反应**：原来 onClick 直接 `setActive('projects')` 不走 navigate → mountedPages 没有 projects 时页面区空白（白屏）；且事件在懒加载组件挂载前发出 → 丢失没反应。修复：App 新增 openInsightsEntry = localStorage 写 `costhub-open-insights-pending` 标志 + `navigate('projects')`（挂载页面）+ 300ms 延迟补发事件双保险；Projects 挂载 useEffect 消费标志（有则打开弹窗）
- **② 报价情报数据混乱（处理过的还在待处理/已处理为空/未读含已处理）根因**：`upsertInsight` 原实现内容变化时 **DELETE+INSERT 整行** → `handled_json`（已处理记录）被清空（已处理视图全空）+ `status` 被重置 unread（处理完的模块回到待处理）+ 空情报也建 unread 行（"已核对"占住待处理）。修复（src/db/compare.ts）：**UPDATE 保留行**（handled_json 不丢）；仅当出现**新组**（hasNewGroups 比对组名集合）才重置 unread——用户处理导致的组消失/变化不打扰，BOM/报价变化带来的新疑似组正常提醒；空情报（[]）不创建记录；新增 `cleanupInsightStatus()` 一次性清理历史脏数据（无待处理组的 unread 模块归档为已读），Projects loadInsights 每次先执行
- **验证**：tsc -b 0 错；160 vitest 全过
### v2.3.19 三处体验修复（2026-08-17，用户反馈：反复搜查噪音 / 处理后无反应 / 云端确认弹窗不易用）
- **① 报价识别"反复搜查"视觉噪音**：runAutoCompare 原来对每个模块无条件调 onProgress（缓存命中也算）→ 60 秒轮询即使全缓存命中也会闪现顶部进度条 + AI 状态条"刚刚完成 报价识别"。修复：onProgress 只在 needsAI（真实 AI 识别）分支调用；App 侧三个引擎的 costhub-ai-task done 广播也改为真实产出才发（compare 用 didWork 标志、advisor 用 found/aiEnhanced、insight 用 insights>0）——日常轮询完全静默
- **② 处理后无反应/反应不对**：LocalAIAssistant setAdvisorStatus 处理后未广播 costhub-advisor-done → 驾驶舱「AI 建议」待处理计数不刷新（已补 dispatch，含撤销恢复路径）；Projects confirm/reject 已带 costhub-insights-changed（核对确认存在）
- **③ 云端确认 UI 重构（非打断式待确认队列）**：原来 autoInsight preview 模式直接弹 antd Modal.confirm（用户："弹窗自己弹、不知从哪看，UI 不好用"）→ 重构 src/cloudConfirm.tsx：**待确认队列**（内存 + costhub-cloud-pending 事件）+ src/components/CloudConfirmBar.tsx：**App 级底部固定横幅**（「🔐 N 个关键物料洞察等待云端发送确认 · 查看确认」，任何页面可见）→ 点击 Modal 列表（物料/品类/问题 + 确认发送/跳过 + 全部确认/全部跳过）；确认 → dispatch costhub-insight-request（App 监听 → scheduleAppInsight 立即继续自动洞察）；**会话级去重**：同物料只入队一次，确认/跳过后的物料本会话不再询问（防 60s 轮询重复打扰）；requestCloudConfirm 语义：auto→true / preview 未处理→入队返回 false（autoInsight failed++ 跳过）/ 本会话已确认→true / 已跳过→false
- **验证**：tsc -b 0 错；160 vitest 全过
### ⚠️ reqwest 本地直连铁律（2026-08-14 公司电脑 504 教训）
- **任何本地/内网地址（localhost/127.0.0.1/私有网段）的 reqwest client 必须显式 `.no_proxy()`**——reqwest 默认 features 含 system-proxy，Windows 走 WinHTTP 读系统代理（公司组策略设置，设置界面看不到），会把 127.0.0.1 转发到公司代理 → 504
- 排查：`netsh winhttp show proxy`（WinHTTP）≠ 设置界面（WinINET）；GUI 启动 eprintln 不可见，诊断写 exe 同目录日志或塞回响应 body

### 审查交付汇总（2026-08-15，15 轮）
- 见「会话接续说明.md」；核心：撤销反馈/批量/emoji图标/洞察树升级/极简白/用量阈值/追溯链/深色适配/软删过滤/快照去重

### v2.3.19 本地-云端桥 aiBridge（2026-08-15，工具亮点）
- **三步链路**（建议卡「生成行业洞察」）：①本地 Ollama 读建议卡上下文（本地数据）→ 判断查询意图，只输出 {material_name, category, question} ②脱敏模板组装 → 发送前敏感审计 → 云端 agentSearchLoop('price-trend') ③本地 Ollama 结合本地数据 + 云端行情 → 最终建议（判定机会/风险/目标/行动）
- **安全设计**：云端 prompt = 固定模板，只有 物料名/品类/问题 三个字段位（成本/供应商/项目代号结构上无位置可传）；正则审计兜底（金额¥/元/价格区间/成本数字/供应商项目信息，时间区间"1-3月"负向断言排除）；拦截即抛错；全程 logLocalAICall（bridge_intent/bridge_summary）留痕
- **开关**：settings ai_bridge_review（auto 自动脱敏 / preview 每次发送前 Modal 预览确认）；设置弹窗「双向 AI 洞察」区 + 与「一键封禁 Ollama 联网」并存
- **降级**：本地模型未配置 → 规则默认意图 + 云端 + 云端结论；本地总结解析失败 → 云端 suggested_action
- **测试**：src/__tests__/aiBridge.test.ts 9 用例（脱敏通过/型号长数字不误伤/¥元区间供应商拦截/模板白名单/截断）
- **防重复洞察（记忆）**：ai_bridge_logs 表存档每次洞察（物料key归一化）；同一物料 7 天内再次洞察 → 复用确认弹窗（复用/强制最新）；本地意图提取注入历史洞察（模型自己判断同题 → reuse 标记跳过云端）；materialKey 纯函数测试
- **⚠️ 提示词脱敏铁律（2026-08-15 用户红线）**：可外传的提示词（建议卡 prompt / AI 润色输出）严禁含 器件型号/厂家/成本金额/供应商名/项目代号/任何数字——本地模型能读库，提示词只描述任务不携带数据；生成后 `auditPromptStrict`（auditSensitive + 型号/规格模式）校验，命中丢弃；存量建议每次轮询自动清理；UI 标注"🔒 已脱敏"
- ✅ 已入演示文稿（2026-08-16）：P14「AI 双向洞察·本地-云端桥」+ 讲稿同步 19 页版
### v2.3.19 自主分析引擎 autoAdvisor（2026-08-14）
- **机制**：App 级 60 秒轮询（scheduleAppAdvisor）→ 规则发现机会/风险点 → 本地 Ollama 润色（30 分钟节流，失败降级规则文案，logLocalAICall 留痕）→ ai_advisor_insights 表 → LocalAIAssistant「自主建议」区展示
- **规则**（纯函数 buildRuleCandidates，vitest 覆盖）：①项目成本 ≥60 天未变动（快照）②大额物料 ≥¥10 且 ≥90 天未调价 ③领域超目标 ≥5%（computeTargetStatuses）④大额物料单一供应商
- **指纹去重**：spc|pid / spp|partId / tg|pid|domain / ss|partId；dismissed 后可重新提醒；「生成行业洞察」= agentSearchLoop(物料, '', 'price-trend') 回填结论
- ⚠️ AI 润色走 http_post /api/chat 非流式（非 startOllamaStream 事件流）；失败必须静默（规则文案已可用）

### v2.3.19 AI 能力嵌入工作流（2026-08-14）
- **仪表盘 → 驾驶舱**：目标成本达成预警置顶（project_targets 按领域=main_category 对比 BOM 实际成本，达成率=(2-实际/目标)×100，未达标红色卡片+跨页直达 costhub-open-project 事件）+ AI 今日洞察区（part_insights 报价情报 + 最近两条快照 bom_cost 异动≥1%）；纯计算在 src/targetInsight.ts（vitest 覆盖）
- **项目页 AI 体检条**：规则驱动 4 类检查（BOM 缺单价/数量0、目标超支→analysis tab、快照异动→snapshots tab、同品类模块报价价差≥¥10且≥10%），点击直达 tab；「AI 小结」本地模型一句话概括（未配置静默）；纯逻辑 src/projectHealth.ts（vitest 覆盖）
- **快照对比 AI 解释**：BOM 详细对比弹窗「生成解释」——差异清单 top8 交 Ollama 流式生成 2-3 句原因说明（Modal.update 流式刷新）
- **全局 AI 问询**（src/components/GlobalAI.tsx）：侧边栏入口，上下文=localStorage costhub-ctx（Projects 选中项目写 BOM 摘要/目标），回答一键 saveWorkLog 记入工作手账（work_project=项目代号）；⚠️ 数据安全：只有本地模型可读项目数据（云端不接）
- **首次 AI 引导**（src/components/AIGuide.tsx）：解锁后 localStorage costhub-ai-guide-seen 控制一次，展示 5 项能力+配置就绪度
- **器件供应商价格趋势小结**（同日追加）：器件库供应商抽屉自动加载各供应商价格历史，规则生成一句话趋势（持续上涨/下降/波动/基本平稳/仅一次变动 + 复合累计幅度 + 最近原因），表格「价格趋势」列 Tag + footer 小结条；纯函数 src/supplierTrend.ts（vitest 覆盖，复合口径 100-110-121 = +21%）
- **界面轻量化第一步**（同日追加）：导航收敛为四区（驾驶舱置顶 + 项目中心/数据资产/AI 趋势三组，页面零改动仅 App.tsx）；项目列表「状态点」列（● 目标超支红 / 报价情报与快照异动橙，Tooltip 显示原因）——纯逻辑 src/projectStatus.ts（vitest 覆盖，复用 computeTargetStatuses/detectSnapshotChanges）
- ⚠️ 铁律：项目目标成本数据依赖用户设定（生产库仅 2 条），驾驶舱预警以目标设定为前提

### v2.3.19 AI 工作台：打开就有"本地 AI 在工作"的感觉（2026-08-16）
- **背景**：用户反馈"打开工具没有本地 AI 在工作 的感觉"——原来自主引擎（advisor/compare）都在后台静默跑，无状态呈现、无主动输出
- **AI 状态条**（src/components/AIStatusBar.tsx，驾驶舱顶部）：三态（连接中呼吸 / 已连接绿点+模型名 / 未连接灰点）——探测逻辑 src/aiStatus.ts detectOllama（127.0.0.1 优先，复用本地直连 no_proxy 铁律）；监听全局事件 `costhub-ai-task`（{task, done}）实时显示当前任务 + "刚刚完成 X · HH:mm"；30 秒自检
- **AI 今日速览**（src/dailyBrief.ts + src/components/DailyBrief.tsx）：打开驾驶舱即触发——本地规则收集当天事实（collectBriefFacts：项目/器件/大额物料/AI建议/报价情报/待办，任一失败不阻断）→ 本地 Ollama 润色 3-5 句自然语言（http_post /api/chat 非流式，temperature 0.3）→ 失败静默降级规则文案（buildRuleBrief 纯函数）；节流：settings ai_daily_brief 存 {date, hash(指纹), text, model}，同日同指纹复用（缓存），数据变化自动重生成，「重新生成」按钮强制；logLocalAICall('daily_brief') 留痕；纯函数 hashString/buildRuleBrief/buildBriefPrompt/localDate vitest 覆盖（9 用例）
- **AI 活动记录**（LocalAIAssistant 对话区顶部折叠条）：getAllAIRequestLogs 最近 15 条 → 类型中文映射（AI_TYPE_NAMES）+ 时间 + 摘要 + 成功/失败——"AI 今天都做了什么"可回溯、可审查
- **启动可见性**（App.tsx）：scheduleAppAdvisor/scheduleAppCompare 接入 onProgress → 广播 costhub-ai-task（报价识别：模块名 / 自主分析步骤），完成广播 done
- ⚠️ 节流原则：速览同一天不重复烧调用；advisor 30 分钟 AI 润色节流不变；所有失败静默降级，不打扰用户
- **验证**：tsc -b 0 错；105 vitest 全过

### v2.3.19 关键物料自动洞察 autoInsight（2026-08-16，用户确认节流设计）
- **需求**：根据项目类型自动识别关键物料做行情洞察，但不能天天洞察浪费 token——设计原则：**识别免费（纯本地规则）、触发吝啬（四道闸门）、呈现主动（驾驶舱卡片）**
- **识别**（src/autoInsight.ts 纯函数，vitest 14 用例）：**按子类聚合**（2026-08-16 用户要求：子类一般是物料的通用名称，行情洞察对通用名更有意义，且避免具体型号外发）——每项目 BOM 先按 sub_category（为空回退 part_name）分组，组小计降序做帕累托（累计占比 ≥80% 或 top5，至少 2 组才截断）；数量 0/软删/总成本 0 跳过；跨项目按 materialKey（子类名+大类归一化）聚合去重——同一子类多项目关键只洞察一次；聚合保留 models（涉及的具体型号，UI 显示"含 N 种型号"）
- **四道闸门**（buildInsightPlan 纯函数）：①首次识别→立即洞察 ②7 天内→reuse 复用历史结论（显示上次方向/置信度/摘要）③30 天周期内（settings ai_insight_interval_days 可调，默认 30）→wait（显示"N 天后到洞察周期"+下次日期）④超期→insight；预算闸门：与云端每日上限（ai_usage_cloud_daily_limit 默认 50）共用，超限→wait"明日自动继续"
- **执行**（runAutoInsight，App 级 60 秒轮询+启动立即一轮，独立防重入，limit=3 分批渐进）：走 agentSearchLoop('price-trend')（云端搜索+分析，外发内容=物料名/品类，与快捷洞察同链路同安全边界）→ 落 trend_items(source_type='auto') + trend_snapshots(source_type='auto')，Decomposition 快捷洞察区可见；完成广播 costhub-insight-done + message（有洞察才提示）
- **UI**（src/components/KeyMaterialInsights.tsx，驾驶舱 DailyBrief 下方）：子类名（通用名称）+「含 N 种型号」/品类 Tag/占某项目 X%/共 N 项目；已洞察→方向 Tag（↑红↓绿～蓝）+置信度+摘要+行动建议 Tooltip+洞察日期；wait→原因+下次日期；首识→"待自动洞察（下一轮轮询触发）"；顶部"全部洞察 →"直达物料趋势洞察页；无项目/无关键物料不渲染
- **验证**：tsc -b 0 错；119 vitest 全过（子类用例：同子类多型号合并帕累托/回退物料名/型号去重合并/大类隔离）

### v2.3.19 关键物料机会点建议 + 驾驶舱清爽化（2026-08-16，用户反馈"只给泛泛结论/还不够清爽"）
- **机会点/风险点引擎**（autoInsight.ts buildMaterialSuggestion 纯函数，vitest 6 用例）：洞察不只给结论，落到"机会/风险 + 怎么行动"——规则：行情下行+置信度高/中 → 🎯机会点（该子类占 X 项目 BOM Y%，建议降价谈判/重新询价，占比≥30% 追加"优先处理"）；行情上行 → ⚠️风险点（建议锁定价格/备货，占比高追加评估替代料）；幅度≥10% 强化；低置信度追加"先观察/先跟踪"；无方向 → info（维持节奏，下次周期复查）；LastInsightInfo/InsightPlanItem 补 magnitude 字段透传
- **驾驶舱清爽化**：关键物料洞察移入「目标成本达成 | 关键物料洞察」双列 grid（compact prop 去 marginBottom），AI 洞察建议区 gridColumn 全宽——顶部纵向从 5 大卡缩到 4 行；机会点行绿色边框+Tag 高亮、风险点红色，行动文本直接展示（不再藏 Tooltip）
- **全模块缩略 + 机会点置顶**（同日追加，用户要求"展示模块都能缩略只显示几条，机会点放上面"）：目标成本达成默认 3 条（targetOpen）、AI 自主建议默认 3 条（advisorMore）、关键物料洞察默认 4 条（expanded），均带"展开全部（N）▼/收起 ▲"；关键物料洞察加载时按 机会点(0) > 风险点(1) > info(2) > 其他(3) 排序置顶（buildMaterialSuggestion 判级）；最近成本变动（costOpen）/巡检发现（auditOpen）原有展开保留
- **验证**：tsc -b 0 错；147 vitest 全过

### v2.3.19 AI 学习引擎 aiLearning（2026-08-16，用户要求"AI 应在日常对话中学习我关注什么、什么逻辑是对的"）
- **设计边界**：本地模型不做微调，用"规则注入"实现行为修正（务实、可审查、全本地）——三层：①关注主题统计 ②反馈沉淀规则 ③偏好注入 prompt
- **① 关注主题分类**（src/aiLearning.ts 纯函数，vitest 13 用例）：6 大主题（项目成本/物料行情/供应商/目标达成/成本结构/工作安排）×关键词表，classifyUserQuestion 命中排序；trackUserFocus 每次对话自动累计到 settings ai_user_focus（mergeFocus 旧数据衰减一半≈30 天窗口）
- **② 逻辑偏好规则**：对话回答气泡底部新增 👍/👎 反馈——👍 轻提示；👎 弹窗选原因（太泛泛/没结合本地数据/结论逻辑不对/没优先关注点 + 自定义输入）→ addLearnedRule 沉淀为"必须遵守的逻辑偏好"（settings ai_learned_rules，最多 20 条，可删）
- **③ 偏好注入**：buildPreferenceContext 汇总「用户近期关注重点（优先覆盖）+ 已学逻辑偏好（必须遵守）」——注入普通对话 system prompt、Agent 任务计划/总结 prompt（sendMessage/sendAgentTask）
- **UI**：反馈行（👍/👎 + "教 AI 理解你的偏好"提示）；左侧「🧠 AI 学习档案」按钮 → Modal：关注主题 TOP 条形图（权重）+ 已学规则列表（删除）
- **测试**：aiLearning.test.ts 13 用例（分类命中/多主题排序/聚合衰减/排序/反馈转换/上下文生成）——**160 vitest 全过**

### v2.3.19 自动洞察云端确认 + 原生搜索审计修复（2026-08-16，用户反馈"没收到弹窗就洞察了/审计没记录"）
- **问题 1**：autoInsight 后台轮询直接调 agentSearchLoop，绕过 ai_bridge_review 预览确认——开了 preview 也没弹窗
- **修复**：新建 src/cloudConfirm.tsx（⚠️ .ts 不能写 JSX，用 .tsx）——requestCloudConfirm(payload)：settings ai_bridge_review==='preview' 时弹 antd Modal.confirm（展示将发送的 物料名/品类/问题 三项 + 安全说明），确认才放行；'auto' 直接放行；读取失败放行。autoInsight runAutoInsight 每个云端洞察前调用，拒绝 → failed++ 跳过该物料（60 秒轮询后继续尝试）
- **问题 2**：审计日志无记录——agentSearchLoop 走 DeepSeek 原生搜索路径时在写日志前提前 return（tryDeepSeekNativeInsight 命中 → return native）
- **修复**：native 路径 return 前补 saveAIRequestLog（request_type='trend_insight'，response_summary=结论摘要，provider='DeepSeek 原生搜索'）；非 native 路径原有 logRequestStart 保留（"分析中..."占位）
- **验证**：tsc -b 0 错；160 vitest 全过

### v2.3.19 本地 AI 助手布局重构（2026-08-16，用户选 Demo B 顶部导航方案）
- **背景**：功能多且藏在左下角（4 个按钮+工具折叠区），界面"老土不清爽"——先产出 3 套 HTML demo（LocalAI-重构Demo-A/B/C.html）供选择，用户选定 **B：顶部导航工作台**（Apple/Claude 风格）
- **左侧**：220px → 180px 简洁会话列（绿点状态+模型 pill、圆角新对话按钮、会话列表圆角高亮、底部"数据只在本机处理"提示）；删除原左下角工具区
- **顶部导航栏**（52px，对话区顶部）：品牌（渐变 logo）+ 4 导航项——💬 对话 / 🤖 自主建议（红点 badge）/ 📚 知识库（开 Modal）/ 🧠 学习档案（开 Modal）；右侧连接状态 pill（绿/红/灰三态）+ **⚡功能 Dropdown**（数据分析工具→Drawer / 智能 BOM 导入 / 演示生成 / 分类规则管理 / 连接设置）
- **消息流居中**：max-width 780 居中窄栏（Claude 式留白）；**输入区居中** + 白底；**建议视图**居中 860（卡片流）
- **数据分析工具**：原左侧折叠列表 → ⚡功能菜单 → 右侧 Drawer（320px，工具卡片式列表，展开注入逻辑不变）
- 全部功能入口保留（对话/Agent/自主建议/活动记录/知识库/学习档案/演示生成/规则/导入/工具/设置），仅重组布局
- **验证**：tsc -b 0 错；160 vitest 全过
- **紧凑化（同日追加，用户反馈"单卡内容多导致板块很长"）**：摘要限 1 行省略（title 悬停全文）、机会点/风险点建议限 2 行省略（悬停全文）、默认显示 3 条（原 4）、行内边距收紧

### v2.3.19 洞察列表联动 + 已处理建议可见性修复（2026-08-16）
- **洞察列表包含自动洞察物料**：getQuickTrendItems 查询条件 source_type='quick' → IN ('quick','auto')——autoInsight 自动洞察的物料出现在「物料趋势洞察 → 快捷洞察区」，点击卡片可查看详情（历史时间轴/分 Skill/追问全复用）；卡片标题旁 source_type='auto' 显示橙色「自动」Tag 与手动洞察区分
- **已处理建议在"已处理"视图消失（用户反馈）**：排查三层——①库里 16 条建议全 open 无 done：UPDATE SQL 层验证正常（rowcount=1）②根因一（真实 bug）：autoAdvisor enhanceWithAI 的 AI 润色用 updateAdvisorStatus(existing.id, 'open', ...) 覆盖用户已处理状态——findAdvisorByFingerprint 把 done 也视为"已存在"，30 分钟后润色把 done 改回 open → 已处理记录消失。修复：润色前查 status，非 open 跳过（不覆盖用户选择）③根因二（交互）：setAdvisorStatus 乐观移除（点击立即消失）依赖 loadAdvisor 恢复，任一步失败则列表空 → 改乐观标记（条目保留并立即显示新状态）+ 失败回滚 + 报错；「仅看待处理」按钮加"（已处理 N）"计数，处理成功提示"切「显示全部」可查看"
- **验证**：tsc -b 0 错；118 vitest 全过

### v2.3.19 P1 Agent 工作台：工具注册表 + 复合任务对话（2026-08-16，用户确认先做 P1）
- **目标**：把本地 AI 对话升级成"指挥 AI 干活"的工作台——一句话完成多步成本分析（DSH 式体验的第一步）
- **工具注册表**（src/aiTools.ts，12 个只读工具）：query_projects / query_project_bom / query_project_cost（模块成本结构）/ query_part_suppliers / query_supplier_trend（复用 supplierTrend）/ query_target_status（复用 computeTargetStatuses）/ query_cost_snapshots / query_price_insights / query_advisor_insights / query_worklog / query_todos / insight_material_trend（走 agentSearchLoop，外发=物料通用名+品类）；统一 AiTool 结构（id/name/desc/params/execute），validateArgs 参数校验 + executeTool 结果截断 2000 字；⚠️ **第一版无任何写操作工具**（安全边界）
- **Agent 循环**（src/aiAgent.ts）：计划-执行-总结——①本地模型读工具清单（buildToolsPrompt）输出 JSON 计划（buildPlanSystemPrompt 约束：steps 数组/依赖顺序/最多 6 步/无需工具输出空 steps）②parseAgentPlan 容错解析（代码块围栏/中文引号/单引号/尾逗号/杂文本/别名映射 query_bom→query_project_bom 等）③runAgentPlan 顺序执行（onStep 轨迹回调）④基于执行报告流式生成最终回答（buildAnswerSystemPrompt：禁止编造/只依据结果）
- **UI**（LocalAIAssistant）：输入框上方 Segmented「💬 普通对话 / 🤖 Agent 任务」；Agent 模式下输入区上方显示**执行轨迹卡**（✅/❌/⏳ 工具中文名 + 参数 + 结果摘要，可折叠）；发送走 sendAgentTask：计划→执行→流式总结，失败/无需工具自动降级普通对话；Agent 过程广播 costhub-ai-task
- **审计**：logLocalAICall('agent_plan'/'agent_answer') 留痕（计划与回答全文可查）
- **测试**：aiTools.test.ts 7 用例（元数据/参数校验/未知工具）+ aiAgent.test.ts 12 用例（容错解析 7/未知工具/提示词）——**139 vitest 全过**
- **下一步（P2 讨论中）**：MCP 桥 / 写操作工具（按用户确认后逐步放开）/ 更多工具（SKU/ODM/报告生成）

### v2.3.19 Agent 子类对比 + 工具图标 + 驾驶舱图表优化（2026-08-16，用户试用反馈）
- **用户反馈**："Agent 读不到成本数据/没法按子类对比"——模型只看到项目代号，缺对比工具。新增 **compare_subcategory_cost**（第 13 个工具）：跨全部项目按 sub_category 精确匹配聚合成本（子类小计 + 占项目 BOM 比例 + 最高/最低项目与差额）——直接回答"同一子类在不同项目成本高低"
- **工具图标语义化**（TOOL_ICONS/toolIcon）：13 个工具按数据特征配 AntD 语义图标（查询=清单/文件夹、成本=钱币、趋势=折线、洞察=闪电、目标=靶心…），Agent 执行轨迹显示图标；⚠️ .ts 文件不能写 JSX → 存 React.ComponentType 引用，UI 层实例化
- **驾驶舱布局去杂乱**（src/components/AIWorkspace.tsx）：AI 状态条 + 今日速览合并为一张卡（虚线分隔，compact prop 去卡片样式），顶部三卡变两卡；关键物料洞察保留独立卡
- **驾驶舱图表根本性优化**（按 ui-ux-pro-max 图表选型：Compare Categories 规则）：两个 BOM 成本柱状图（项目/竞品）**按值降序排列**（比较的核心洞察是排序）+ 颜色从"每柱彩虹色"改**统一主色系**（最高值 #1D4ED8 深蓝高亮、其余 #60A5FA 浅蓝，skill：same hue family）；移除未用 CHART_COLORS import
- **测试**：aiTools.test.ts 10 用例（新增子类对比工具必填校验 + 全部工具图标覆盖检查）——**141 vitest 全过**

# CostHub - 成本管理平台 v2.3.19

## 项目概述

这是一个用于管理电子产品成本的桌面应用程序（原名"显示器成本管理系统"），基于 Tauri + React + TypeScript + SQLite 构建，提供器件库、项目管理、竞品分析、成本对比、工作手账等功能。未来计划扩展到PC、平板等其他电子整机产品线。

**版本**: 2.3.19
**产品名称**: CostHub v2.3.19
**标识符**: com.costhub.app

## 技术架构

### 前端技术栈
- **框架**: React 19.2.7 + TypeScript
- **UI组件库**: Ant Design 6.2.5
- **图表库**: ECharts (echarts-for-react)
- **路由**: React Router DOM 7.17.0
- **构建工具**: Vite 8.0.16
- **样式**: CSS (index.css 约 50KB，包含完整的主题系统)

### 后端技术栈
- **框架**: Tauri 2.x
- **数据库**: SQLite (tauri-plugin-sql)
- **语言**: Rust (edition 2021)
- **数据库文件**: costhub.db (位于 exe 同目录)

### 主要依赖
```json
{
  "@tauri-apps/api": "2.11.0",
  "@tauri-apps/plugin-sql": "2.4.0",
  "react": "19.2.7",
  "antd": "最新版本",
  "echarts-for-react": "3.0.6",
  "xlsx": "0.18.5" // 用于 Excel 导入导出
}
```

## 功能模块

### 1. 仪表盘 (Dashboard)
- **文件**: `src/pages/Dashboard.tsx`
- **功能**:
  - 统计概览：总器件数、总项目数、活跃项目、竞品数、平均BOM成本
  - 器件分类分布图表
  - 项目成本趋势分析
  - 竞品成本对比
  - 最近更新的器件列表

### 2. 器件库 (PartsLibrary)
- **文件**: `src/pages/PartsLibrary.tsx`
- **功能**:
  - 器件信息管理（增删改查）
  - 分类体系：大类（硬件类、结构类、电源类等）+ 子类
  - **筛选联动** (v2.3.18)：大类选择后子类下拉只显示该大类下的子类（SUB_CATEGORIES 常量 + 数据库实际值合并），切换大类自动清空子类
  - **项目筛选** (2026-08-06)：工具栏加"项目"下拉（BOM 反查 project_boms 关联器件 + projects 字段匹配双保险），配合行选择批量删除
  - 价格历史追踪
  - 批量导入导出（支持 Excel）
  - 搜索和筛选
  - **供应商管理** (v2.3.1+)：
    - 多供应商报价管理（简化字段：供应商名称、价格、份额、状态、备注）
    - 份额比例分配（0-100%，自动归一化）
    - 加权成本自动计算：`加权成本 = Σ(启用供应商价格 × 份额比例)`
    - 供应商价格变动记录（修改价格时强制输入变动原因）
    - 价格历史追踪（查看历史价格变动）
    - 成本变动追溯（器件成本变化 → 影响的项目列表）

### 3. 模块库 (ModuleLibrary)
- **文件**: `src/pages/ModuleLibrary.tsx`
- **功能**:
  - 模块定义和管理
  - 模块内器件组合
  - 模块成本计算
  - 模块复用和引用
  - **模块分类管理** (v2.3.4 新增)：
    - 支持自定义模块分类（如"电源类"、"显示类"、"音频类"等）
    - 分类筛选器（可与项目筛选同时使用）
    - 模块卡片显示分类标签
    - 编辑表单支持选择现有分类或输入新分类
  - **模块批量分类** (v2.3.5 新增)：
    - 分组卡片右上角"设置分类"按钮
    - 批量为所有同名模块设置分类
    - 新建同名模块自动继承分类
    - 保持同名模块分类一致性
  - **虚拟模块过滤** (v2.3.4 新增)：
    - 自动过滤在研项目中的虚拟模块
    - 模块库仅显示正式模块，避免混乱
    - (2026-08-06 实现) 空模块（成本预估占位、无器件）不进模块库，BOM 导入器件后自然成为正式模块
  - **项目筛选 + 批量删除** (2026-08-06)：工具栏加"项目"下拉（选某项目只显示该项目专属的模块实例，同名模块跨项目分开显示、带项目代号标签），模块卡片加勾选框支持批量删除（含半选状态）
  - **模块分类排序** (2026-08-08)：工具栏加「分类排序」按钮 + 弹窗（上下移调整分类顺序，getModuleCategoryOrder/saveModuleCategoryOrder 存 settings 表 JSON 数组），loadAll 按分类顺序排序（未配置的分类排末尾按字母序），恢复默认一键还原

### 4. 项目管理 (Projects)
- **文件**: `src/pages/Projects.tsx` (约 85KB，功能最丰富)
- **功能**:
  - 项目基本信息（代号、名称、类型、档位、状态）
  - 产品规格（屏幕尺寸、分辨率、刷新率、面板类型）
  - BOM管理（器件清单、数量、成本计算）
  - 成本评审记录（阶段评审）
  - 目标成本设定
  - 降本措施跟踪
  - 项目分组管理
  - 项目排序（拖拽排序）
  - **整机供应商管理** (v2.3.2 新增，2026-08-06 修复并完善)：
    - ODM项目整机供应商报价管理（项目管理页"🏭 整机供应商（ODM）"tab）
    - 多供应商整机报价对比、份额比例分配、加权报价自动计算（Σ(报价×份额)）
    - 报价变动记录（修改报价时强制输入原因，存 project_supplier_price_history）
    - 报价历史追踪（弹窗查看）
    - ⚠️ 修复记录：getProjectSuppliers 原错误查询 part_suppliers 表 → 重写为查 project_suppliers 表
  - **SKU 变体** (v2.3.19, 2026-08-12)：基座项目 + 差异规则（不做完整 SKU 项目）——SKU 不落 BOM 只存差异（add 加器件/模块、remove 减基座器件、replace 换型号单价数量），成本 = 基座 BOM 成本 + Σ差异（原始值计算），**基座变 → 所有 SKU 自动联动**；项目详情「SKU 变体」tab——**Excel 式对比表**（行=器件按模块分组、列=基座+各 SKU，**点格子直接行内编辑**：数量改 0=移除/删新增行、改回基座值自动还原、新增行填名称型号后点某 SKU 列 ＋ 即加，回车/✓ 保存）+ **差异 Excel 导入**（与 BOM 导入同逻辑：列=模块/名称/型号/数量/单价，预览自动判定动作——基座有同名同型号→替换/值与基座一致→跳过/已存差异写回基座值→还原/否则→新增，确认后先清旧差异再写入，幂等）+ 成本对比条形图 + SKU 列表（代号/规格/成本/较基座±）；SKU 详情弹窗 = 合并 BOM（基座+差异合成按模块分组，绿=新增 红=移除删除线 黄=替换显示新旧价，仅展示不落库）+ 差异规则管理（高级用法）；品类→项目→SKU 树状导航（项目列表上方折叠面板，点品类过滤/点项目选中/点 SKU 直达详情）
  - **BOM 导入预览增强** (2026-08-06)：导入预览显示 BOM 总价 + 各模块小计（便于与原 Excel 核对）+ 小计列 + 异常数据检测（缺名称/单价数量非数字/单价为0/数量为0/异常偏高），异常行红色高亮提示
  - **在研项目参照测算** (2026-08-08)：BOM 工具栏加「参照项目（已完成）」下拉——选中后按模块名自动关联各模块参考；模块头加「导入参考」按钮（从参照项目复制该模块器件，按名称+型号跳过已存在的，做加减法）；对比列（参考单价/参考小计/差异）+ 行内编辑保留（就地改成本）
  - **器件报价比对** (v2.3.19, 2026-08-12)：同物料跨项目报价差异情报——BOM 每个模块头「跨项目比对」按钮 → 弹窗（同品类全部项目该模块报价行）：**规则分组实时免费**（归一化 normalizePartName：全角转半角/小写/去空格横线 + 已确认别名映射）+ **AI 疑似识别**（本地模型后台自动，指纹不变不重跑——part_compare_cache 按 品类+模块 存指纹+结果，变化才识别；机器人呼吸闪烁 ai-breathe 提示，低特效降级；robustJsonParse 健壮解析：中文引号/单引号/尾逗号/BOM 逐级降级，失败自动重试一次）+ **人工确认**（确认→part_aliases 沉淀别名永久归组；标记不同→#NEG# 否定组合 AI 不再建议；缓存显示时过滤已确认行）；三层流程 AI 只建议不认定
  - **后台自动识别 + 报价情报** (v2.3.19, 2026-08-12)：**全局识别引擎 `src/autoCompare.ts`（runAutoCompare）由 App 级驱动**——①**空闲自动**：App 监听全局操作（mousemove/keydown 等），10 秒无操作 + Ollama 运行中（fetch /api/tags 探测，不可用静默跳过）→ 自动扫描 ②**变更触发**：导入/改价/BOM 增删改 → dispatchEvent('costhub-compare-request') 立即扫描（5 分钟节流仅限空闲触发）③打开项目页即触发一次 ④扫描范围=全部品类（单项目品类跳过），串行识别（顶部全局进度条"正在后台识别物料报价差异 X/Y"+机器人呼吸动画），指纹命中秒过 ⑤完成总结 message（发现 N 条情报 / 未发现异常 / 失败可重试）+ dispatchEvent('costhub-compare-done') 刷新红点；识别结果存 part_insights（内容相同保持已读状态，变化才重置 unread）；项目页工具栏「报价情报」按钮 + Badge 未读数 + 弹窗列表（确认同一/标记不同/已读）；模块头比对按钮带未读角标
  - **导入数量为0允许但提示** (2026-08-08)：数量为 0 的占位/待定项允许导入——解析拆分为 _issues（错误，红色高亮）/ _warns（警告，黄色提示）两级，数量为 0 与异常偏小(<0.000001) 归警告；预览顶部提示条单独显示"N 条数量为0（可正常导入）"；saveModuleItem 数量存库用 `?? 1`（修复 `|| 1` 把 0 变 1 的 bug）
  - **导入器件错位修复** (2026-08-08)：真实数据导入后"同模块一个物料取代另一个物料、总物料数一致但金额/器件不对"——根因是 doImport 器件匹配用 `getParts(name)`（`LIKE %name%` 模糊搜索，会命中"说明书"→"说明书 中文"等）+ `find(p => p.model === row.model)`（只按型号取第一个），错误复用其他模块的已有器件（沿用其旧 cost、写进新模块）。修复：**名称必须完全相等 + 型号完全相等才复用**，否则新建；顺带修复 projects 字段拼接误用 selectedPid（自动建新项目时拼错）改为 targetProjCode
  - **模块库 vs 项目页数据源统一** (2026-08-08)：模块库读 modules+module_items（导入时 Excel 快照），项目管理页读 project_boms JOIN parts（实时价）→ 两页偏差、项目总价错。修复：project_boms **固化快照列**（part_name/part_model/part_cost/main_category/sub_category，ensureSchema 补列 + 一次性回填：优先 module_items 快照、无则 parts 兜底）；getProjectBOMs/recordProjectCostSnapshot/getSnapshotBOMDetail/getProjectModuleSummary/Dashboard 全部改**快照优先、parts 兜底**（`CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END`）；addBOMItem 写入即固化快照；saveModuleItem/deleteModuleItem ↔ updateBOMItem/deleteBOMItem **双向同步**（模块库改 ↔ 项目页改）
  - BOM引用和差异分析
  - 软删除机制

### 5. 竞品管理 (Competitors)
- **文件**: `src/pages/Competitors.tsx`
- **功能**:
  - 竞品信息管理（品牌、型号、档位、市场价格）
  - 竞品BOM估算
  - 与己方器件映射对比
  - 成本差异分析
  - 排序功能

### 6. 对比分析 (Compare)
- **文件**: `src/pages/Compare.tsx` + `src/components/CompetitivenessRadar.tsx`
- **功能**:
  - 项目间成本对比
  - 竞品间成本对比
  - 自定义对比维度
  - 可视化对比图表
  - **竞争力雷达** (v2.3.19+)：六维雷达（性能/规格/显示/外观/可靠性 + 成本竞争力），我方项目 + 多竞品叠加；特性评分 0-10 可录入可编辑（product_scores），成本力动态计算（10×组内最低BOM成本/本产品BOM成本，封顶10）；**模块-特性关联**配置（module_feature_links 表，同名模块全局一致），评分时列出关联模块及成本占比作打分依据

### 7. 成本报告 (Reports)
- **文件**: `src/pages/Reports.tsx`
- **功能**:
  - 成本报告生成
  - 导出功能
  - 报告模板管理

### 8. 物料趋势洞察 (Decomposition)
- **文件**: `src/pages/Decomposition.tsx` (约 2279 行，集成物料拆解和趋势分析)
- **状态**: v2.3.17+ 整合了原 TrendInsight 功能，成为统一的物料趋势洞察平台
- **核心功能**:
  - **物料分解树管理**：
    - AI 起草顶层物料（基于 LLM 智能拆解）
    - 手动添加物料（创建独立的根节点）
    - 树形可视化（ReactFlow）展示物料层级结构
    - 支持结构节点（可继续拆解）和终端节点（最终物料）
    - 批量拆解和批量洞察
  - **趋势洞察**：
    - 终端物料市场行情 AI 洞察
    - 多 Skill 分析框架（价格趋势、供需分析、竞争分析）
    - **Skill 方法论体系** (2026-08-05 强化)：
      - 9 个内置 Skill 各配专属方法论（分析步骤 / 证据要求 / 判断规则 / **时效性规则**），注入洞察 prompt 约束分析方式（trendService.ts BUILTIN_SKILLS）
      - 价格趋势（四因子）、供应链（上游传导+时滞）、竞争格局（波特五力）、综合深度研究（五看三定）、SWOT、PEST、风险评估（风险矩阵）、TCO、供应链韧性（三要素）
      - **时效性硬约束** (2026-08-05)：全局时效分级（3个月内有效/3-6月参考/超6月过期）、旧数据不得外推、禁模糊时间词、时效超3月置信度封顶"中"、超6月封顶"低"；每个 Skill 有专属时效规则（如价格趋势只认近3月价格、PEST 区分政策生效时间、风险只评估当前及未来3-6月）
      - **反幻觉硬约束** (2026-08-05)：只许用提供的来源数据、严禁用训练知识补具体数字、严禁编造来源 URL、区分事实与推测、不确定就输出"信号不明确"、输出前逐数字自检
      - 综合深度研究（deep-research）方法论最完整：五看每维度配问题清单（行业周期/需求结构/竞争格局/自身影响/机会窗口）+ 三定（定向/定量/定策）+ 证据分级（强/中/弱）+ 置信度评分规则 + 输出约束
      - 设置页 Skill 卡片显示方法论摘要，编辑弹窗含"分析方法论"标签页可查看/编辑
      - **洞察弹窗内选择 Skill** (2026-08-05)：点击"洞察行情"后的确认弹窗可直接多选本次使用的分析框架（默认带出设置中激活的），`handleNodeInsight(node, skillIds?)` 支持按次指定；卡片自绘勾选控件（手动控制，避开 Checkbox.Group 无 value 全选 bug）
      - **Skill 差异化呈现** (2026-08-05)：不同 Skill 的洞察结果按各自框架可视化（renderSkillDimensions，注意：函数定义必须在组件主 return 之前，const 不提升，否则白屏）：SWOT 2×2 四象限矩阵、PEST 四宫格、竞争格局五力强度条、风险评估等级化风险卡（高/中/低自动分级）、供应链韧性三要素评分条+最终评分卡，其余 Skill 标准列表
    - 趋势方向判断（上涨/下降/震荡/信号不明确）
    - 置信度评估（高/中/低）
    - 幅度区间估算
    - **数字口径约束** (2026-08-05)：幅度仅表示近1-3月采购价格变化，严禁市场规模/CAGR/累计涨幅口径；方向-幅度一致性校验 + 超±30%异常幅度自动拦截置空（normalizeStructuredResult）
    - 关键事件追踪
    - **方向冲突提示** (2026-08-05)：新洞察与上次方向明显不同时，界面黄色警告条提示核实口径
  - **层级汇总 (Rollup)**：
    - 从子节点洞察结果汇总父节点趋势
    - 基于成本占比加权计算
    - 支持人工修正和反馈
  - **历史记录**：
    - 洞察快照历史追踪
    - 按时间查看不同批次的洞察结果
    - 支持对比不同 Skill 的分析结果
  - **追问对话**：
    - 基于洞察结果的多轮追问
    - 携带完整上下文的对话历史
    - 支持补充搜索获取最新信息
  - **DeepSeek 原生联网搜索** (2026-08-05)：官方 API 原生支持 web_search（Responses API tools=web_search）；trendService `tryDeepSeekNativeInsight` 一轮调用完成搜索+分析（返回真实来源，含口径归一化），`agentSearchLoop` 优先走原生搜索、失败自动回退 Serper；设置页 AI 服务区"模型原生搜索"开关（settings 表 ai_native_search，默认开启）
  - **快捷洞察区** (2026-08-05)：清单页顶部新增"快捷洞察"卡片区——无需分解树，直接添加并洞察单个物料行情（如"锂电池"）；卡片显示物料名、最近洞察时间、成本趋势方向/置信度/幅度；数据存 trend_items（source_type='quick'），复用完整洞察流程
  - **快捷洞察详情弹窗** (2026-08-05)：点击卡片打开详情——顶部**历史洞察时间轴**（横向批次节点从左到右时间递增、可点击切换，节点按批次融合方向着色，选中节点可删除该批次洞察 deleteTrendSnapshot）+ 选中批次的融合总结（多 Skill 时）+ 分 Skill 差异化卡片呈现（renderSkillDimensions + 建议动作）+ **基于洞察结论追问**（复用 agentSearchLoop + askLLM，携带快照上下文与历史对话）；卡片操作按钮精简（点击卡片即详情，避免重叠）
  - **⚠️ renderSkillDimensions 位置约束**：函数必须定义在**所有**使用它的 return 之前（清单页和树详情页都会调用，const 不提升，定义在后 → 白屏）
  - **时间时区规范** (2026-08-05)：写库时间统一用本地时间字符串（db.ts `localNow()`，与 SQLite `datetime('now','localtime')` 一致），**禁止 `toISOString()`（UTC，差 8 小时）**——saveTrendSnapshot/saveQuickTrendItem/关注物料创建已修复
  - **快照排序规范** (2026-08-05)：`getTrendSnapshots`/`getLatestTrendSnapshot` 按 **id DESC** 排序（自增 id 单调，不受 query_time 字符串格式混排影响——旧数据 ISO 带 T vs 新数据本地带空格，字符串排序会错乱）；显示层用 `formatTime()` 统一格式化（兼容两种格式）
  - **关注物料列表**：
    - 从器件库标记的关注物料
    - 快速洞察关注的物料行情
    - 独立于分解树的物料管理
  - **数据安全**（2026-08-05 明确边界）：
    - **核心原则**：外部 LLM/搜索服务只有 HTTP 代理通道（Rust http_stream/http_post/http_get 纯转发），**没有任何读取本地数据库的通道**——这是硬边界
    - 本地模型（Ollama）可读取/分析本地数据（本地对话、洞察均可携带成本上下文）
    - 外部 API 场景：可发送物料名称、成本占比（cost_ratio_estimate）、分类等业务字段（用户确认可接受），但数据只能"由前端主动拼进 prompt"，外部永远无法反向访问数据库
    - Rollup 汇总 prompt 含子件成本占比与趋势（本地规则计算 + LLM 综合）
    - AI 起草/批量拆解 prompt 要求模型输出成本占比（总和95-105%校验）
    - 关注物料洞察传物料名称与分类（main_category）
    - 洞察请求预览确认机制
    - 完整的审计日志记录
    - **供应商启用开关生效** (2026-08-06)：getActiveProviders 必须 is_active=1 才算活跃（曾漏过滤导致停用仍可用）；testSearchConnection 全部停用时明确报错

### 9. 供应商管理 (SupplierManagement)
- **文件**: `src/pages/SupplierManagement.tsx`
- **功能**:
  - 供应商信息管理
  - 供应商评级和评价
  - 合作历史记录
  - **筛选联动** (v2.3.18)：器件供应商的"大类"选择后，"子类"只显示该大类下的（子类→大类映射表），切换大类自动清空子类
  - **器件/整机供应商区分** (v2.3.18)：类型切换改为"器件供应商 / 整机供应商（ODM）"；整机供应商（ODM，提供部分或全部物料）在「项目管理 → 项目详情 → 🏭 整机供应商」中维护，此处自动汇总展示，含 ODM 说明条、ODM 统计 tab（项目 ODM 覆盖 + 加权报价 + 供应商承接项目数）

### 10. 系统设置 (Settings)
- **文件**: `src/pages/Settings.tsx`
- **功能**:
  - API 配置（LLM、搜索服务）
  - 主题设置
  - 数据导入导出
  - 系统参数配置
  - **左侧导航布局** (v2.3.18)：Claude 风格设置页——左侧分类导航（AI 服务/分析框架/安全设置/个性化/数据管理/审计日志/关于）+ 右侧内容区，点击切换不滚动
  - **数据备份/恢复** (v2.3.18)：设置页"数据管理"分区——Rust 命令 backup_database/list_backups/restore_database/delete_backup（备份存 exe 同目录 backups/，防路径穿越，恢复前自动备份当前库，移除 WAL/SHM）
  - **Excel 按内容类型导出** (v2.3.18)：6 类内容可选导出（器件库/项目/竞品/供应商/工作手账/洞察记录），每类独立 sheet 格式；前端 xlsx 生成 → Rust save_export_file 存 exports/（含 list_exports/open_exports_dir）
  - **用户名设置** (v2.3.18)：登录用户名可自定义（默认 admin，settings 表 auth_username），登录页用户名+密码双验证
  - 修改密码（验证当前密码）
  - **Token 用量统计** (v2.3.18)：外部 LLM 调用自动记录 token 消耗（ai_request_logs 表新增 provider_name/model_name/prompt_tokens/completion_tokens/total_tokens 列），审计日志分区展示总用量/按供应商聚合/近30天趋势

### 11. 工作手账 (WorkLog)
- **文件**: `src/pages/WorkLog.tsx` (约 800 行)
- **功能**:
  - **便签墙**：按分类章节分组展示（可折叠），便签卡片带分类色、图钉装饰、旋转效果
  - **待办清单**：进行中/已完成分组，勾选完成切换
  - **项目标签** (v2.3.18+)：
    - 每条便签/待办可打项目标签（如"手写笔"、"鼠标"、"M270"）
    - 支持从项目库下拉选择，或 AutoComplete 自由输入新项目名（自动记忆，下次可选）——⚠️ 项目名只在保存时记忆（rememberProject），输入过程不记忆（修复"鼠/鼠标/鼠标项"被全存的问题）
    - 空标签自动归入"公共/其他"
    - 便签卡片、待办项显示 📌 项目标签
    - 工具栏支持按项目筛选
  - **分类可选** (v2.3.18+)：新建便签分类可留空（保存落"其他"），避免每张便签都要选分类
  - **AI 总结（流式）**：
    - 时间轴：按有记录的月份横向展示（最早在左、最近在右），支持多选月份，范围自动覆盖首尾月
    - 两步流程：第一步压缩提炼（流式实时显示压缩内容+字符数），第二步正式总结（流式逐字呈现）
    - **四维度组织** (v2.3.18+)：按"一、项目维度 → 二、公共事务 → 三、能力建设 → 四、协作互助"组织正文
    - **项目标签归组** (v2.3.18+)：记录按【项目名】分组（空标签归"公共/其他"），每个项目是一个完整故事线
    - **串联成文** (v2.3.18+)：每个项目/事项按"起因 → 做了什么（时间先后）→ 结果贡献"串成连贯叙述，禁止罗列要点
    - **提示词强化** (2026-08-06)：压缩阶段按时间排序+性质标注【公共事务/能力建设/协作互助】；正式总结加✅/❌示范对比、硬性禁止编号列表/"贡献："模板句式（修复输出为机械罗列的问题）；语言风格约束（禁止口语化：搞/弄/整/搞定等，用正式书面动词）
    - 总结模型独立配置（local_ai_summary_model，默认同对话模型）
    - 总结保存/查看/复制，已保存总结列表 + 全文查看弹窗（可滚动）
- **数据库**: `work_logs` 表（含 work_project 项目标签列）

### 12. 登录门禁 (LoginScreen) - v2.3.18
- **文件**: `src/pages/LoginScreen.tsx` + `src/db.ts` 数据锁 + `src/App.tsx` 门禁
- **功能**:
  - 应用启动时显示登录界面，输入用户名+密码解锁数据（成本数据机密保护）
  - **初始密码 666666**（SHA-256 哈希存 settings 表 auth_password_hash，首次启动自动初始化）；默认用户名 admin（auth_username）
  - **首次使用提示**：登录页显示初始用户名/密码（auth_password_changed 标记，改过密码后不再提示）
  - **密码找回**：登录页双击 Logo 可显示真实密码（明文副本存 auth_password_plain，仅本机；改密码时同步更新）——**界面不提示此功能**，仅作为隐藏的后备手段
  - **密码错误也可进入**（受限模式）：所有数据库查询返回空、写入静默跳过（db.ts Proxy 拦截 getDb），页面不显示任何数据
  - **受限模式提示条** (v2.3.19, 2026-08-15)：进入受限模式后 App 顶部固定琥珀色提示条「受限模式：当前未解锁，所有数据不可见、写入已跳过」+「返回登录页解锁 →」链接（setAuthed(null) 回登录页）；登录页勾选说明 + 进入后常驻提示双保险，防止误以为数据丢失
  - 受限模式下设置页仍可打开（改密码走 getRawDb 绕过锁）
  - 设置页"安全设置"标签页可修改用户名/密码（验证当前密码，新密码至少 4 位）
  - 认证相关函数：ensureAuthPassword / verifyPassword / changePassword / isFirstUse / getPlainPassword / getUsername / changeUsername / isDataLocked / setDataLocked

### ⚠️ 已废弃页面
- **TrendInsight.tsx**: 原独立的趋势洞察页面，功能已完全整合到 Decomposition.tsx 中（v2.3.17+）

## 数据模型

### 核心实体（详见 src/types.ts）

#### Part (器件)
```typescript
interface Part {
  id?: number;
  main_category: string; // 大类（硬件类、结构类等）
  sub_category: string;  // 子类
  category: string;      // 详细分类
  name: string;          // 器件名称
  model: string;         // 型号
  cost: number;          // 成本
  specs: string;         // 规格
  projects: string;      // 关联项目
  remark: string;        // 备注
  created_at?: string;
  updated_at?: string;
}
```

#### Project (项目)
```typescript
interface Project {
  id?: number;
  code: string;          // 项目代号
  name: string;          // 项目名称
  project_type: string;  // 项目类型（在研/已完成）
  tier: string;          // 档位（入门级/主流级/中高端/高端/旗舰级）
  status: string;        // 状态（进行中/已完成/暂停）
  screen_size: string;   // 屏幕尺寸
  resolution: string;    // 分辨率
  refresh_rate: string;  // 刷新率
  panel_type: string;    // 面板类型
  platform_fee_rate: number; // 平台费率
  profit_rate: number;   // 利润率
  image?: string;        // 产品图片
  sort_order?: number;   // 排序权重
  created_at?: string;
}
```

#### ProjectBOM (项目BOM)
```typescript
interface ProjectBOM {
  id?: number;
  project_id: number;
  part_id: number;
  module_name: string;   // 所属模块
  quantity: number;      // 数量
  cost?: number;         // 成本（可选）
  remark: string;
  is_reference?: number; // 引用标记
  reference_remark?: string; // 差异备注
  is_deleted?: number;   // 软删除标记
}
```

#### Competitor (竞品)
```typescript
interface Competitor {
  id?: number;
  brand: string;         // 品牌
  model: string;         // 型号
  tier: string;          // 档位
  market_price: number;  // 市场价格
  bom_cost: number;      // BOM成本
  platform_fee_rate: number;
  remark: string;
  sort_order?: number;
  created_at?: string;
}
```

#### PartSupplier (器件供应商) - v2.3.1 新增，v2.3.16 简化
```typescript
interface PartSupplier {
  id?: number;
  part_id: number;
  supplier_name: string;    // 供应商名称
  price: number;            // 供应商报价
  share_ratio: number;      // 份额比例 (0-100)
  is_active: number;        // 是否启用
  remark: string;
  created_at?: string;
  updated_at?: string;
}
```

#### PartSupplierPriceHistory (供应商价格历史) - v2.3.1 新增
```typescript
interface PartSupplierPriceHistory {
  id?: number;
  supplier_id: number;
  old_price: number;
  new_price: number;
  changed_at?: string;
  change_reason: string;    // 变价原因
}
```

#### ProjectSupplier (整机供应商) - v2.3.2 新增
```typescript
interface ProjectSupplier {
  id?: number;
  project_id: number;
  supplier_name: string;    // 供应商名称
  quoted_price: number;     // 整机报价
  share_ratio: number;      // 份额比例 (0-100)
  is_active: number;        // 是否启用
  remark: string;
  created_at?: string;
  updated_at?: string;
}
```

#### ProjectSupplierPriceHistory (整机供应商价格历史) - v2.3.2 新增
```typescript
interface ProjectSupplierPriceHistory {
  id?: number;
  supplier_id: number;
  old_price: number;
  new_price: number;
  changed_at?: string;
  change_reason: string;
}
```

#### CostChangeLog (成本变动日志) - v2.3.2 新增
```typescript
interface CostChangeLog {
  id?: number;
  change_type: string;      // 变动类型
  ref_type: string;         // 关联类型
  ref_id: number;
  ref_name: string;         // 器件名称或项目名称
  supplier_name?: string;
  old_value: number;
  new_value: number;
  change_reason: string;
  impact_scope: string;     // JSON格式：影响范围
  changed_at?: string;
}
```

#### WorkLog (工作手账) - v2.3.18 完善
```typescript
interface WorkLog {
  id?: number;
  log_date: string;        // 记录时间 YYYY-MM-DD HH:mm
  title: string;           // 标题（待办为空）
  content: string;         // 内容
  category: string;        // 分类（成本分析/供应商谈判/BOM审核等，可空，保存落"其他"）
  tags: string;            // 标签（未使用，预留）
  work_project: string;    // 项目标签（手写笔/鼠标/M270 等，空=公共/其他）
  is_todo: number;         // 是否待办
  done: number;            // 待办是否完成
  created_at?: string;
  updated_at?: string;
}
```

#### WorkSummary (工作总结) - v2.3.18
```typescript
interface WorkSummary {
  id?: number;
  title: string;           // "开始 ~ 结束 工作总结"
  content: string;         // 总结正文
  start_date: string;      // 起
  end_date: string;        // 止
  created_at?: string;
}
```

### 数据库表结构（详见 src-tauri/src/lib.rs）

完整表结构包括：
- `parts` - 器件表
- `projects` - 项目表
- `modules` - 模块表 (v2.3.4+ 新增 category 字段用于分类)
- `module_items` - 模器件项表
- `project_boms` - 项目BOM表
- `part_price_history` - 器件价格历史表
- `part_suppliers` - 器件供应商表 (v2.3.1+)
- `part_supplier_price_history` - 供应商价格历史表 (v2.3.1+)
- `project_suppliers` - 项目整机供应商表 (v2.3.2+)
- `project_supplier_price_history` - 整机供应商价格历史表 (v2.3.2+)
- `cost_change_log` - 成本变动日志表 (v2.3.2+)
- `competitors` - 竞品表
- `competitor_boms` - 竞品BOM表
- `competitor_parts` - 竞品器件表
- `project_cost_reviews` - 项目成本评审表
- `project_targets` - 项目目标成本表
- `work_logs` - 工作手账表 (v2.3.18+ 新增 work_project 项目标签列)
- `work_summaries` - 工作总结表
- `module_feature_links` - 模块-特性关联表 (v2.3.19+，竞争力雷达用：module_name+feature_id 唯一，同名模块全局一致)
- `project_skus` - SKU 变体表 (v2.3.19+：project_id 基座项目 + sku_code/名称/规格差异说明)
- `sku_diffs` - SKU 差异规则表 (v2.3.19+：diff_type add/remove/replace + 模块/器件/数量/单价，SKU 成本=基座+Σ差异)
- `part_aliases` - 器件别名沉淀表 (v2.3.19+，报价比对用：alias→canonical 归组，source=user_confirmed/marked_different)
- `part_compare_cache` - 报价比对识别缓存表 (v2.3.19+，品类+模块唯一，指纹失效)
- `project_measures` - 项目降本措施表
- `project_groups` - 项目分组表
- `project_group_members` - 项目分组成员表
- `product_features` - 产品特性表
- `product_scores` - 产品评分表

## UI/UX 特性

### 主题系统
**配置文件**: `src/constants.ts`, `src/main.tsx`, `src/index.css`

#### 调色板 (7种)
- **Apple 紫粉** (apple): 紫粉渐变
- **Tiffany 蓝玻璃** (tiffany): 青蓝渐变
- **Paper 白底** (paper): 纯白简洁
- **Rose Gold 玫瑰** (rose): 玫瑰金渐变
- **Aurora 极光** (aurora): 绿紫极光
- **Mint 薄荷** (mint): 绿黄清新
- **Sky 天空** (sky): 蓝紫天空

#### 深浅模式
- Light mode (浅色)
- Dark mode (深色)

#### 色温调节
- Default (默认)
- Warm (暖光)
- Cool (冷调)
- Sepia (护眼)

#### 动效控制
- **低特效模式** (v2.3.19, 2026-08-12)：设置 → 个性化 → 低特效模式开关（localStorage app-lowfx，ThemeContext 挂 `data-lowfx` 属性）——关闭全部毛玻璃（backdrop-filter）与动画，解决远程桌面/虚拟机/低配机器/老 WebView2 上"界面发灰卡住、弹窗打不开"；⚠️ 铁律（2026-06-23 教训）：**禁止用 transition-duration 缩短**（antd Modal 依赖 transition 显示，缩短会动画状态异常），只禁 animation/backdrop-filter（元素以最终态显示，安全）；系统级"减少动态效果"（prefers-reduced-motion）同步关闭毛玻璃
- ⚠️ 旧版 data-motion 动效开关体系（💤 按钮）已在主题重构中移除，代码中不存在

#### 缩放级别
- 80%, 100%, 125%, 150%

### 分类颜色系统
```typescript
CATEGORY_COLORS = {
  '硬件类': '#3B82F6',
  '结构类': '#5AC8FA',
  '电源类': '#8B5CF6',
  '线材类': '#AF52DE',
  '包材类': '#34C759',
  '加工费类': '#FF9500',
  '软件类': '#5856D6',
  '其他': '#6E6E73'
}
```

扩展调色板支持任意新分类的稳定颜色分配（基于 djb2 哈希算法）

### 全局搜索
- **快捷键**: Ctrl+K / Cmd+K
- **搜索范围**: 器件、项目、竞品
- **搜索结果**: 点击可导航到对应页面并高亮

### 最近更新器件
- 侧边栏底部显示最近更新的5个器件
- 可折叠/展开
- 点击快速跳转到器件库

## 构建和发布

### 开发环境
```bash
# 安装依赖
npm install

# 开发模式
npm run dev  # 启动前端开发服务器 (localhost:5173)

# Tauri 开发模式
npm run tauri:dev  # 启动完整应用
```

### 构建发布
> **构建职责约定（2026-08-16 起）**：构建由 AI 负责——代码改动完成后 AI 执行 `npm run build` + `npm run tauri:build` 产出最新 exe（构建前确认 costhub.exe 未运行；build.bat 末尾带 pause 不适合脚本环境，分步执行；产物 src-tauri/target/release/costhub.exe 验证时间戳）
```bash
# 方法1: 使用构建脚本（推荐，Windows）
build.bat

# 方法2: 手动构建
# 1. 构建前端
npm run build

# 2. 构建 Tauri 应用
npm run tauri:build
```

### 快速构建说明
项目根目录提供 `build.bat` 一键构建脚本：
1. 自动检查 npm 环境
2. 构建前端资源（TypeScript + Vite）
3. 构建 Tauri 应用（Rust + 前端打包）
4. 输出到 `src-tauri/target/release/costhub.exe`

### 发布产物
- **位置**: `src-tauri/target/release/`
- **主执行文件**: `costhub.exe` (免安装版本)
- **数据库文件**: `costhub.db` (自动创建，与 exe 同目录)
- **安装包**: 未配置 NSIS/MSI，采用免安装 exe 方式

### 配置文件
- **Tauri 配置**: `src-tauri/tauri.conf.json`
  - 窗口尺寸: 1400×860 (最小 1100×700)
  - 窗口居中启动
  - 可缩放、有装饰
- **Cargo 配置**: `src-tauri/Cargo.toml`

## 数据库管理

### Schema 自动补齐
项目启动时自动检测并补齐缺失的数据库列/表（`src/db.ts` ensureSchema 函数）：
- project_boms.cost
- projects.sort_order
- competitors.sort_order
- project_groups 表
- project_group_members 表
- project_boms.is_reference
- project_boms.reference_remark
- project_boms.is_deleted
- work_logs.work_project (v2.3.18+)
- product_features.type (v2.3.19+，'custom'/'radar'，radar 五维种子幂等插入)
- module_feature_links 表 (v2.3.19+)
- project_skus / sku_diffs 表 (v2.3.19+，SKU 变体：基座项目+差异规则)
- part_aliases / part_compare_cache 表 (v2.3.19+，器件报价比对：别名沉淀 + 识别缓存指纹失效)
- local_ai_context.category (v2.3.19+，演示生成习惯库分类：演示结构/风格描述/素材模板)

### 迁移机制
- 不依赖线性迁移历史
- 启动时自动执行缺失补齐
- 错误容忍设计（表/列已存在时静默失败）

### 数据库路径
- 由 Rust 后端提供：`src-tauri/src/lib.rs` get_db_url()
- 路径规则：exe 同目录下的 costhub.db
- 连接字符串格式：`sqlite:<path>/costhub.db`

## 特殊功能说明

### 项目排序
- 拖拽排序支持
- 排序权重存储在 sort_order 字段
- 默认按创建时间倒序

### BOM引用机制
- 项目间BOM可引用复制
- 引用项标记 is_reference
- 支持差异备注 reference_remark
- 便于快速创建相似项目的BOM

### 软删除
- project_boms.is_deleted 标记
- 删除不物理移除，保留历史记录
- 可恢复误删项

### Excel导入导出
- 使用 xlsx 库 (0.18.5)
- 支持器件批量导入
- 支持报告导出

### 成本计算公式
```typescript
// 项目总成本 = BOM成本 × (1 + 平台费率 + 利润率)
totalCost = bomCost * (1 + (platform_fee_rate + profit_rate) / 100)

// 器件加权成本 = Σ(启用供应商价格 × 份额比例) / Σ(启用供应商份额比例)
// 示例：供应商A报价10元(份额60%)，供应商B报价12元(份额40%)
// 加权成本 = (10 × 0.6 + 12 × 0.4) = 10.8元
```

### 供应商管理使用流程 (v2.3.1+)

#### 器件供应商管理

##### 1. 添加供应商
1. 在器件库页面，点击器件行的"管理"按钮
2. 右侧抽屉打开，点击"添加供应商"
3. 填写：
   - 供应商名称（必填）：如"京东方"
   - 价格（必填）：供应商报价
   - 份额比例（必填）：0-100%，表示该供应商占总采购量的比例
   - 状态：启用/停用
   - 备注（可选）
4. 点击"添加"

##### 2. 份额比例说明
- **单供应商**：份额100%，加权成本 = 该供应商价格
- **多供应商**：份额总和可以不为100%，系统自动归一化
  - 示例：A供应商60%，B供应商40% → 归一化后仍为60%和40%
  - 示例：A供应商30%，B供应商20% → 归一化后为60%和40%
- **停用供应商**：不参与加权成本计算

##### 3. 价格变动记录
- 修改供应商价格时，系统强制弹窗要求输入变动原因
- 自动记录到 `part_supplier_price_history` 表
- 同时记录到 `cost_change_log` 表，追踪影响范围

##### 4. 自动更新器件成本
- 添加/修改/删除供应商后，系统自动：
  1. 计算器件的加权成本
  2. 更新 `parts.cost` 字段
  3. 记录成本变动日志
  4. 标记影响的项目列表

##### 5. 价格历史追踪
- 点击供应商卡片右上角的"时钟"图标
- 查看该供应商的历史报价变动
- 显示旧价格、新价格、变动金额、时间、原因

#### 整机供应商管理（ODM项目）(v2.3.2+)

##### 1. 添加整机供应商
1. 在项目管理页面，选择项目后点击"🏭 整机供应商"标签页
2. 点击"添加供应商"
3. 填写：
   - 供应商名称（必填）：如"富士康"
   - 整机报价（必填）：供应商整机报价
   - 份额比例（必填）：0-100%
   - 状态：启用/停用
   - 备注（可选）
4. 点击"添加"

##### 2. 整机报价变动
- 修改整机供应商报价时，系统强制弹窗要求输入变动原因
- 自动记录到 `project_supplier_price_history` 表
- 同时记录到 `cost_change_log` 表

##### 3. 加权报价计算
- 系统自动计算：`加权报价 = Σ(启用供应商报价 × 份额比例)`
- 在统计卡片顶部实时显示
- 供应商数量统计

##### 4. ODM场景应用
- 记录同一项目的多家ODM工厂报价
- 对比不同工厂的报价和份额
- 根据实际订单分配份额计算加权报价
- 追踪工厂报价变动历史

#### 成本变动追溯（v2.3.2+，v2.3.3 增强）

##### 自动快照触发机制
系统在以下场景**自动记录**项目总成本变化（无需手动创建快照）：

1. **器件供应商价格变动**
   - 触发：修改器件供应商价格
   - 记录：`cost_change_log` (change_type: 'part_supplier_price')
   - 影响：器件加权成本变化

2. **器件成本变动**
   - 触发：器件加权成本重新计算
   - 记录：`cost_change_log` (change_type: 'part_cost')
   - 影响：使用该器件的所有项目BOM成本

3. **项目总成本变动** (v2.3.3 新增)
   - 触发场景：
     - 器件成本变化影响项目
     - 添加/删除/修改项目BOM条目
     - 修改项目费率（平台费率/利润率）
     - 批量删除模块BOM
     - 批量删除指定器件BOM
   - 记录：`cost_change_log` (change_type: 'project_total_cost')
   - 包含信息：旧总成本、新总成本、变动原因、影响详情

4. **整机供应商报价变动**
   - 触发：修改项目整机供应商报价
   - 记录：`cost_change_log` (change_type: 'project_supplier_price')
   - 影响：项目整机加权报价

##### 变动链路示例
```
供应商价格变动 → 器件加权成本变化 → 项目总成本变化
     ↓                    ↓                    ↓
part_supplier_price   part_cost        project_total_cost
```

每一步都自动记录到 `cost_change_log` 表，形成完整的成本变动追溯链。

## 开发注意事项

### 文件结构
```
monitor-cost-main/
├── src/                   # React 前端源代码
│   ├── App.tsx           # 主应用（导航、主题、搜索）
│   ├── db.ts             # 数据库操作（约32KB）
│   ├── constants.ts      # 常量配置
│   ├── types.ts          # 类型定义
│   ├── main.tsx          # 入口文件
│   ├── index.css         # 样式（约50KB）
│   ├── ollama.ts         # Ollama 流式封装（startOllamaStream，v2.3.19 自 LocalAIAssistant 抽出共用）
│   ├── pptxExtract.ts    # .pptx 大纲提取（jszip 解包，v2.3.19 演示生成习惯库用）
│   ├── components/       # 通用组件
│   │   ├── DataTable.tsx  # 可调列宽/列显隐表格（v2.3.19）
│   │   ├── CompetitivenessRadar.tsx  # 竞争力雷达六维图（v2.3.19+）
│   │   └── DemoGenerator.tsx  # 演示生成器：本地 AI 生成 HTML/PPTX + 习惯库（v2.3.19+）
│   └── pages/            # 功能页面
│       ├── Dashboard.tsx
│       ├── PartsLibrary.tsx
│       ├── ModuleLibrary.tsx
│       ├── Projects.tsx
│       ├── Competitors.tsx
│       ├── Compare.tsx
│       ├── Reports.tsx
│       ├── WorkLog.tsx     # 工作手账（便签/待办/项目标签/AI总结，v2.3.18+）
│       ├── LocalAIAssistant.tsx  # 本地AI对话 + 演示生成入口（流式封装在 src/ollama.ts）
│       ├── Decomposition.tsx     # 物料趋势洞察（含 AI 洞察、历史记录）
│       └── SupplierManagement.tsx
├── src-tauri/            # Rust 后端源代码
│   ├── src/
│   │   ├── lib.rs        # 主库文件（迁移、命令）
│   │   └── main.rs       # 入口
│   ├── tauri.conf.json   # Tauri 配置
│   ├── Cargo.toml        # Rust 配置
│   ├── target/           # 编译产物
│   │   └── release/
│   │       ├── costhub.exe
│   │       ├── costhub.db
│   │       └── ...
│   └── icons/            # 应用图标
├── public/               # 静态资源
└── node_modules/         # npm 依赖
```

### 关键技术点

1. **数据库连接**: 通过 Tauri invoke 获取数据库路径，前端使用 @tauri-apps/plugin-sql 操作

2. **主题切换**: 通过 HTML 属性 (data-theme, data-palette, data-motion, data-color-temp) 控制 CSS 变量

3. **状态管理**: React hooks (useState, useEffect)，无 Redux/Context

4. **路由导航**: 单页应用，通过 active state 切换页面组件

5. **图表渲染**: ECharts for React，响应式数据更新

6. **表格组件**: Ant Design Table，支持排序、筛选、编辑

7. **国际化**: 中文界面，Ant Design zhCN locale

### 性能优化

- 动效开关（性能模式）
- 缩放控制
- 分页和懒加载（大型列表）
- 数据库查询优化（索引、排序权重）

### 安全考虑

- 本地数据库，无网络传输
- 数据文件随 exe 部署
- CSP 配置开放（开发便利性优先）

## 更新历史

### v2.3.19 演示文稿重构：AI 应用实践叙事 (2026-08-12)
- **文件**：`CostHub演示文稿.html`（HTML 幻灯片演示，19 页，方向键/空格翻页、F 全屏、触摸滑动、进度条+圆点导航）
- **重构背景**：作为"成本领域 AI 应用实践"向成本/采购同行分享——原稿是产品介绍视角、AI 内容散落、缺边界与规划
- **新叙事主线**：数据问题靠收拢、认知问题靠 AI——封面（COSTHUB × AI 应用实践）→ 痛点点题 → 数据收拢是 AI 前提 → 全链路概览 → 器件库/模块库/项目管理/对比分析/工作手账/工作交接（数据基建）→ **双模型通道架构图**（原样保留，核心页）→ AI 在成本工作里做了什么（原来→现在三卡）→ **AI 物料洞察**（批量洞察/历史留档/内置 9 Skill 可定制 + 物料拆解树状图抓关键物料 + 洞察链路数据安全：云端 LLM 无数据库权限、外传提示词全程记录可供审查）→ **AI 演示生成**（本地模型直接产出 HTML/PPTX 文件 + 习惯库拆解以往 PPT 沉淀结构/风格/素材模板并应用，全程本地无云端通道）→ **AI 的边界·它帮不了什么**（实事求是：模型能力上限/置信度封顶/AI 看不到内部数据/助手非专家）→ 配置教程两页保留（各加"为什么"定位）→ 后续规划（近期计划中/中期想法/远期方向分级，不画饼）+ 谢谢观看
- **⚠️ 删除**：原「细节打磨」页删除；原「数据管理与安全」页并入 AI 架构页（登录门禁/审计日志/Key 加密三条）；「AI 怎么做到可信」页（反幻觉/时效/口径/冲突预警四道检查 + 9 框架）**按用户要求整页删除**（9 框架仅保留 P4 概览统计条数字提及）；P2 痛点页/P3 收拢页两个 AI 点题 banner 删除（AI 不抬位）
- **示意增强（同日）**：P5 器件库新增「供应商价格历史」示意表（时间/供应商/价格变动/原因，改价必填原因、历史随时调出）；P6 模块库新增「模块成本基线·持续刷新」时间线（A001→A002→A003 当前基线），核心能力新增"基线随报价/定型持续刷新"；P7 项目管理页六卡按用户四点重排（BOM 清单一键导入 / 目标成本设定+降本措施跟踪 / 成本快照自动留痕随时对比 / 关键节点成本测算 Charter→ADCP→量产→持续降本含 ¥120→105→98→92 微型时间线 / 整机供应商 ODM / 项目定型），原「成本核算」「BOM 横向对比」卡移除（对比在 P8 覆盖）；**P8「对比分析」重构为「竞品分析·设计差异成本评估」**——三卡（竞品 BOM 估算与差异评估、独立竞品器件库不与我司混淆、特性×成本契合分析）+ 手写 SVG 五维雷达图示意（⚠️ 首版顶点坐标非正五边形已用公式重算修正）+ 成本对比契合判断卡；「核心场景：竞品对标」banner 按用户要求删除；⚠️ **雷达图再升级六维「竞争力雷达·特性+成本」**：新增成本竞争力维度（整机成本折算分，越低价越高分），正六边形公式重算，卡片分数与雷达值自洽（特性 8.6/7.2、成本力按公式 10.0/9.5、¥1,180/¥1,240）；**特性成本分明细表**（同日追加）：每特性一行，成本分 = 10×组内该特性最低成本÷本产品该特性成本（特性成本=关联模块成本合计，同特性成本越低得分越高），最低者标绿；表与雷达图、契合判断合并进同一 diagram 框（上排左雷达右判断、下排全宽表格）；**成本长城示意**（同日）：手写 SVG 成本长城图（柱=规格差、曲线=成本差，双轴 0 居中），按用户要求单独一行全宽展示（左图右"怎么读这张图"判读）；雷达图与契合判断卡合并进同一 diagram 框（左图右判断配套看）
- **素材**：logo 三处共用同一 base64（47KB），重构时用 __LOGO__ 占位符 + python 替换组装；原版备份为 `CostHub演示文稿-原版备份.html`（审阅后确认无需可删）
- **口径**：全部沿用工具实际能力表述（无夸大）；示例数据为模拟，未用真实业务数据
- **配套**：演讲逻辑梳理文档 `CostHub演示文稿-演讲逻辑.md`（17 页逐页讲解要点 + 章节时间分配 + 四个重点页 + 开场结尾话术 + Q&A 预判，受众=成本/采购同行）
- **v2.3.19 增补（2026-08-16）**：新增 **P14「AI 双向洞察·本地-云端桥」**（三步链路卡 ①本地读建议卡→只输出 物料名/品类/问题 三字段 ②固定脱敏模板发云端查行情+发送前正则审计 ③本地结合本地数据+云端行情给结论；🔐 安全卡=云端 prompt 固定模板三个字段位、成本/供应商/代号结构上无处可传+拦截留痕+每日用量阈值；♻️ 防重复卡=7 天内复用确认），后页顺延 P15-P19 共 19 页；演讲逻辑同步 19 页版（AI 主戏章节 P11-P16、P14 讲法三步、重点页五个、Q&A 新增"外发提示词会被看到吗"）

### v2.3.19 供应商历史按钮修复（2026-08-16）
- **问题**：供应商管理页两个详细列表的操作列历史按钮失效——`sup_odm_list`（ODM）行引用不存在的 `record.part_id`（ProjectSupplier 结构无该字段）；`sup_detail`（器件供应商）行对象映射漏 `partId` → 点击传 undefined，历史弹窗永远空
- **修复**（src/pages/SupplierManagement.tsx）：detailListData 补 `partId: part.id`；新增 `showProjectPriceHistory(supplierId)`（查 `project_supplier_price_history`，与弹窗列结构一致）；ODM 按钮改 `showProjectPriceHistory(record.supplierId)`；器件表按钮改 `showPriceHistory(record.partId, record.supplierName)`（供应商地图弹窗 sup_detail_parts 原已正确不动）
- **验证**：tsc -b 0 错；96 vitest 全过

### v2.3.19 表格优化：DataTable 组件 (2026-08-08)- **需求**：长文本（名称/型号/子类）撑高行、信息密度低——希望像 Excel 一样可调列宽、可隐藏列
- **新增 `src/components/DataTable.tsx`**（antd Table 封装，props 兼容）：
  - **列宽拖拽调节**：表头右侧拖拽把手（最小 60px），宽度记忆 localStorage（按 tableId）
  - **列显隐设置**：表格右上角「列设置」按钮 + 弹层勾选（固定列/操作列不可隐藏），记忆 localStorage，可恢复默认
  - **长文本自动省略**：内容列自动加 ellipsis（原生 title 悬停显示全文），行高固定单行
- **用法**：`<DataTable tableId="唯一id" ... />`，其余 props 与 antd Table 完全一致（rowSelection/summary/scroll 等透传）
- **已接入 25 张表**：项目列表/BOM 模块明细/成本评审/降本措施/ODM 供应商/导入预览、器件库/价格历史/供应商弹窗、模块对比/明细、供应商管理 9 表、竞品 2 表、报告、仪表盘、对比特性、降本控制
- **不接入**：操作列/动态列名表格（Compare 动态对比表、目标成本表等）
- **列设置按钮优化**（同日）：按钮改流式布局（表格上方右对齐，不与其他按钮重叠）；BOM 模块明细循环内表格加 `hideToolbar` 去重复按钮，工具栏放统一 `ColumnSettingsButton`（与 DataTable 共用 localStorage + window 事件联动，同 tableId 共享一份设置）
- **跨项目可视化对比**（同日）：模块库模块对比视图新增横向条形图（各项目成本对比，绿色=最低）；项目管理 BOM 清单工具栏新增「对比项目」下拉 + 模块成本分组柱状图（当前 vs 对比项目逐模块对比）
- **对比功能按实际用途增强**（同日）：①模块库单模块对比视图加「对比项目」多选筛选（图表+表格同步过滤，可只比指定项目）②模块库工具栏加「选择模块对比」多选 → 跨模块×跨项目分组柱状图+明细表 ③项目管理 BOM 器件级横向对比：按模块分组，同名+同型号器件并排显示单价/数量/小计+差异（含仅一侧有的器件）④模块库对比视图加「📋 器件级对比」表：行=器件并集，每项目 3 列（单价/数量/小计），绿色标注最低小计
- **新增 elegant/glass 主题**（同日）：themes.ts 新增「精致现代」（暖白画布+Indigo 主色+柔和阴影+毛玻璃侧边栏）和「玻璃拟态」（深色渐变底+全组件毛玻璃+发光按钮）两套主题，共 9 个主题可在侧边栏用户菜单切换；index.css 新增主题专属 CSS（侧边栏/导航/卡片/表格/按钮/输入框/弹窗/下拉/Tabs/标签/滚动条/内联浅色块覆盖）；纯 UI 改动不动业务逻辑
- **Apple 设计原则打磨**（同日）：反馈落在按压瞬间（:active 缩放 100ms）；过渡曲线统一 cubic-bezier(0.32,0.72,0,1)；卡片悬浮抬升+按压回压；弹窗/下拉"材质浮现"（缩放+淡入同帧）；排印微调（标题负字距/数值 tabular-nums/表头微正字距/标签胶囊圆角）；细巧滚动条；prefers-reduced-motion 全量降级
- **弹窗闪烁修复**（同日）：自定义 animation 覆盖了 antd 内置动画名导致弹出层闪一下——已移除，回归 antd 原生动画系统
- **模块对比频闪修复 + emil 打磨**（同日）：①频闪根因：对比项目多选 Select 渲染在 IIFE 内，筛选变更致子树重挂载、下拉被强制关闭重开——cmpProjects/cmpProjOptions 提到顶层 useMemo（引用稳定）②器件级对比表每项目 3 列合并为 1 列（单元格内"单价×数量"小字 + 小计大字 + 最低角标）③emil-design-eng：全部 transition:all → 精确属性；主按钮渐变+内高光；卡片柔和投影；导航激活态左侧品牌色条；金额 tabular-nums；危险按钮红系区分
- **主按钮文字看不清修复**（同日）：全局 .ant-btn-primary 的 background-image 高光渐变（!important）覆盖了 antd 6 的 CSS 变量背景 → 紫色主题下按钮背景变浅、白字看不见（hover 才恢复）——改为 ::before 伪元素实现内高光，antd 原生背景完整保留；登录按钮 .login-btn 类继续显式渐变+白字。影响范围：AI 起草/洞察行情/查看分解树/写便签等所有 primary 按钮
- **frontend-design 整体设计升级**（同日）：①排印体系：标题 26px/-0.03em 负字距、统计卡标签退后（11px/0.08em 大写）、数值 34px/-0.035em 等宽 ②表格节奏：表头更轻（10.5px/0.07em）、行高紧凑、分隔线更细 ③签名元素：统计卡数值品牌色渐变文字（background-clip:text），9 主题全适配（glass 青蓝渐变+发光）④按钮/标签/表单/弹窗/空状态统一克制
- **分类标签自动配色**（同日）：`getCategoryColor` 升级为 FNV-1a+雪崩混合哈希（稳定：同名分类永远同色，与渲染顺序无关，分布均匀）；模块库分类标签改用自动配色
- **模块库数据源补齐**（同日）：模块库模块数远少于项目 BOM——根因：历史种子数据直接写 project_boms 没建 modules/module_items；定型只同步 parts 不同步模块库。修复：新增 `syncProjectModulesToLibrary()`（从 project_boms 幂等补齐缺失模块/器件到 modules/module_items），App 解锁后自动调用 + 项目定型时调用
- **模块库单一数据源改造**（同日）：模块库不再读 modules/module_items 而是**直接读 project_boms**（getLibraryModules/getLibraryModuleItems）——模块存在/器件/成本全部以 project_boms 为准（与项目页同一份数据）；写操作也直接改 project_boms（updateLibraryModuleItem 改 BOM 行+同步 parts、deleteLibraryModule 软删 BOM 行、renameLibraryModule 同步改名、复制模块=复制 BOM 行）→ **任何一边改动另一边自动反映，无需同步**。modules 表仅存分类/描述（同名模块分类一致是有意设计 v2.3.5）；syncProjectModulesToLibrary 降级为兼容层

### v2.3.19 成本计算舍入口径统一 (2026-08-08)
- **问题**：整机成本与供应商 Excel 总是差几毛钱——根因是各页面合计时**每行小计先舍入到 2 位再累加**（`Math.round(x*100)/100` 写在了 reduce 累加循环内部），舍入误差逐行累积
- **修复口径**：**中间计算一律用原始浮点值（该是多少就是多少），只有最终展示才 `toFixed(2)`**
- **修改位置**：
  - `src/db.ts` `recordProjectCostSnapshot`：bomCost 改为原始值累加（原注释"与供应商 Excel 计价口径一致"删除，改为"中间计算用原始值"说明）
  - `src/pages/Projects.tsx`：bomTotal（238）、模块小计 modTotal（351）、参考模块小计 refTotal（354）改为原始值累加
  - `src/pages/ModuleLibrary.tsx`：模块成本 total（84）、展开模块成本 expTotal（160）改为原始值累加
  - `src/pages/Reports.tsx`：total/total2/按分类小计 byCat 改为原始值累加（删除不再使用的 round2 工具函数）
- **保持不变**：快照落库仍 4 位小数（×10000/10000，仅防浮点尾差）；项目成本快照变更对比阈值 0.01；Dashboard/Compare/Competitors 原本就是"累加完成后才舍入"的正确写法
- **⚠️ 铁律**：任何成本合计都**禁止在累加循环内部舍入**，只能累加完在最终结果/显示层舍入
- **模块级成本显示 4 位小数**（同日追加）：模块成本是供应商 Excel 里需要精确核对的口径，显示改为 4 位小数——Projects.tsx 模块小计/参考小计/差异 Tag + 表格汇总行、BOM 导入预览（总价/单价/小计列/模块小计标签）、ModuleLibrary.tsx 模块成本列、明细表单价/小计、展开模块成本 Tag + 汇总行、分类条形图标签；整机总成本仍 2 位（toFixed(2)），分组卡片成本区间概览仍取整（toFixed(0)）

### v2.3.19 antd 6.6.0 升级与类型修复 (2026-08-12)
- **问题**：build 报全项目 269 错——"Could not find a declaration file for module 'antd'"（TS7016）+ 连锁 TS7006/TS2339
- **根因**：antd 6.4.3 的 npm 包**缺少全部 .d.ts**（package.json typings 指向 es/index.d.ts 但文件不存在）→ tsc fallback 到 lib/index.js 隐式 any
- **修复**：antd 升级 6.4.3 → **6.6.0**（官方包类型齐全，1988 个 d.ts，tsc -b 验证 0 错）；package.json 固定 "6.6.0"（不戴 ^ 防漂移）；另修 DemoGenerator 的 `pptx.write({ outputType: 'base64' })`（pptxgenjs 4.0 API，字符串参数不合法）与未用 import（Spin/Divider/FilePptOutlined/FileTextOutlined、ollama.ts listen）
- **⚠️ 铁律（验证方式）**：**tsconfig.json 是 references-only（files:[] + references），类型检查必须用 `npx tsc -b`（与 build 一致）**——`tsc --noEmit` 不带 -b 检查空集合，永远假通过；验证时输出重定向文件取真实退出码，禁止管道

### v2.3.19 SKU 变体：基座项目 + 差异规则 (2026-08-12)
- **背景**：一个产品多个 SKU（存储/规格微调），每个 SKU 单独建项目太复杂——SKU = 基座 BOM + 加减法
- **模型（用户确认）**：SKU 不落完整 BOM 只存差异规则；**成本 = 基座 BOM 成本 + Σ差异**（原始值计算，add 加单价×数量 / remove 减基座器件小计 / replace 新旧差额，按 名称+型号+模块 匹配基座，匹配不到提示不计算）；基座变化 → SKU 自动联动；费率共用基座
- **数据**：`project_skus`（project_id 基座 + sku_code/name/spec_desc）+ `sku_diffs`（diff_type add/remove/replace + module_name/part_name/part_model/quantity/unit_cost/remark）；CRUD：getSkus/saveSku/deleteSku/getSkuDiffs/saveSkuDiff/deleteSkuDiff/getAllSkuDiffs/getAllSkus
- **UI**：
  - 项目详情「SKU 变体」tab：SKU 列表（代号/规格说明/整机成本/较基座±/差异数）+ SKU 成本对比条形图（基座蓝 SKU 紫）
  - **SKU 详情弹窗**（用户补充需求：差异里可能有新模块/新器件，点击 SKU 要看到全量 BOM）——合并 BOM 按模块分组（基座行+差异行合成，绿=新增 红=移除删除线 黄=替换显示 旧价→新价，模块小计，仅展示不落库）+ 顶部成本汇总（基座/差异/整机）+ 差异规则管理（添加/编辑/删除，remove/replace 从基座 BOM 下拉选器件自动带出模块/名称/型号）
  - 品类→项目→SKU 树状导航：项目列表上方折叠面板（antd Tree，品类蓝/项目加粗/SKU 带标签），点品类=筛选列表、点项目=选中、点 SKU=选中项目+切 SKU tab+打开详情
- **验证**：tsc -b 0 错；成本逻辑 7 用例全过（加/减/换/组合/找不到器件提示/默认数量/基座涨价联动 740→1020）；⚠️ 教训：TS 里 `??` 与 `||` 混用必须加括号（TS5076）

### v2.3.19 器件报价比对：AI 疑似识别 + 人工确认 (2026-08-12)
- **背景（用户讨论定稿，详见 `AI Agent 架构设计.md`）**：成本经理对物料趋势有敏感性（谈价提醒鸡肋），真正需要 AI 的是"同物料跨项目报价差异情报"；难点是各项目 BOM 中同一物料名称/型号写法不一致（不同料号/口语化/规格后缀），需 AI 疑似识别 + 人工确认沉淀
- **范围**：同品类全部项目（项目少不设多选）、按模块切片（一次一个模块，本地模型上下文够，不做全局扫描）、SKU 间不比（SKU 对比表已覆盖）
- **三层流程**：①规则分组（归一化同名同型号 + 已确认别名 → 直接归组，实时免费）②本地 AI 疑似识别（只处理未归组行，输出疑似组 JSON：行索引+理由；**AI 只建议不认定**）③人工确认（确认→part_aliases 沉淀；标记不同→#NEG# 组合否定，AI 不再建议）
- **指纹缓存**：part_compare_cache（品类+模块唯一）存识别时该模块报价行指纹（项目|名|型号|单价|数量 排序拼接）——打开弹窗指纹相同直接用缓存不跑 AI，变化（改价/新项目/模块更新）才后台自动重识别；确认后缓存显示过滤已确认行
- **交互**：BOM 模块头「跨项目比对」按钮；弹窗三区（已归组/疑似组/状态条）；AI 识别中机器人呼吸闪烁（.ai-breathe CSS 动画，低特效 data-lowfx 自动降级静态）；上次识别时间 + 重新识别按钮；未配置本地模型明确提示
- **验证**：tsc -b 0 错；归一化/分组/指纹/否定过滤逻辑脚本全过；self-review 修复 2 处（缓存残留已确认组、快速切换模块的识别竞态——cmpModuleRef 防竞态）

### v2.3.19 子类分布图框架无条形修复 (2026-08-12)
- **问题**：模块库「子类成本分布」图（单模块展开）+「子类成本分布对比」图（器件级对比）只显示坐标轴/网格/标题，条形不渲染
- **根因**：`chartTheme.ts` `barGradient(color)` 用 `color + '22'` 拼接渐变底部色——只对 hex 有效（`#4F46E5`+`'22'` = 合法 8 位 hex）；模块库两处图表传的是 `rgba(79, 70, 229, 0.45)` 函数式颜色，拼出 `rgba(79,70,229,0.45)22` **非法 CSS 颜色** → ECharts 静默跳过条形（不报错，只剩框架）
- **修复**：`barGradient` 兼容 rgba()/rgb() 输入（正则解析出 alpha 减半作为底部色，hex 路径不变）；ModuleLibrary.tsx 单模块图补 `(barData[0].value || 1)` 防全 0 时 NaN
- **⚠️ 铁律**：ECharts 渐变 colorStops 颜色必须合法（8 位 hex / rgba 函数式），非法颜色只画框架不报错——图表"有框无条"优先检查颜色字符串
- **图例颜色一致性修复**（同日）：器件级对比图条形是自定义 Indigo 深浅（颜色写在数据点级 itemStyle），图例却是 ECharts 默认调色板自动色 → 不一致。修复：颜色移到**系列级** itemStyle（图例默认取系列色）+ 显式 `cmpSeriesColors`（ECharts 默认 9 色）+ legend.data 每项显式同色双保险；条形保留同色渐变。⚠️ 铁律：**图例颜色取自系列级颜色，颜色写在数据点级 itemStyle 图例不跟随**——多系列图表颜色统一放系列级

### v2.3.19 竞争力雷达：特性评分 + 成本力 (2026-08-12)
- **位置**：`src/components/CompetitivenessRadar.tsx`（新组件，自包含数据加载），Compare.tsx 页面标题下插入 `<CompetitivenessRadar />`；原 A vs B 对比功能完全不动
- **六维雷达**：性能/规格/显示/外观/可靠性 + 成本竞争力——ECharts radar，6 个 indicator 天然从正上方起每 60° 一个（正六边形）；我方固定第一色 #0A84FF，竞品依次取 RADAR_COLORS（数据项级 itemStyle，radar 图例跟随 data 项颜色，已验证）
- **特性体系**：`product_features` 新增 `type` 列（'custom'=用户自定义旧特性 / 'radar'=竞争力五维），ensureSchema 幂等种入五维种子（性能/规格/显示/外观/可靠性，按名查重不重复插入）；`getFeatures(type?)` 支持按类型过滤——**旧对比雷达改读 custom**（Compare.tsx 三处调用全部 `getFeatures('custom')`，避免种子维度混入旧雷达 indicator）；评分仍存 product_scores（ref_type='project'/'competitor'，0-10 分制，与旧 0-100 分制按 feature_id 天然隔离）
- **成本力公式**（不落库，动态计算）：`成本力 = 10 × (对比组内最低整机BOM成本 ÷ 本产品BOM成本)`，保留 1 位小数，封顶 10；单产品对比按 10 分；成本缺失（null/0/非有限数）→ 该产品该维度 value=null 不画（雷达多边形对应边断开）。**口径**：我方 = getProjectBOMs 快照累加（原始值累加，与 recordProjectCostSnapshot 一致），竞品 = competitors.bom_cost，禁止混入平台费率/利润率
- **⚠️ 成本竞争力改为特性级**（2026-08-12 用户要求）：原"整体 BOM 成本力"废弃——`featureCostScore` 每个特性独立算：`特性成本分 = 10 × (组内该特性最低成本 ÷ 本产品该特性成本)`，1 位小数封顶 10，单产品=10，成本缺失=null；雷达第六维 = 五个特性成本分的**均值**（featureCostAvg）；评分概览卡改为**按特性明细**展示（每行：特性名 + 特性评分 + 成本分，成本分按分值绿/橙/红着色）+ 底部两个均值；特性×成本表格与长城图不受影响（继续用特性成本/每分成本）
- **评分交互**：卡片每产品显示特性均值分 + 成本力分（与雷达数值一致，未评分显示"—"）；评分弹窗滑杆 0-10 step 0.5 滑动即存（saveScore 复用）；每个维度下列出该产品关联模块及小计/占比 Tag（📦 模块 · ¥金额 · 占比%）作为打分依据
- **特性 × 成本对比**（同日追加，用户核心诉求"同成本的特性比别人强还是弱"）：每个特性的成本 = 该产品中与此特性关联的模块成本合计（**模块计入其所有关联维度**）；**每分成本 = 特性成本 ÷ 特性评分**，同特性下谁低谁强；对比区块 = 每分成本分组条形图（系列级 RADAR_COLORS 颜色，图例自动一致，未评分/无成本 → null 不画）+ 明细表格（每产品列：评分 · 成本 / 每分成本，💪 = 该特性组内每分成本最低者绿色高亮 + 独立"每分成本最低"列）；未配置模块-特性关联时显示橙色提示引导，未评分/成本为 0 显示"—"
- **成本长城图视图**（同日追加，与雷达视图可选切换 viewMode）：**柱 = 规格差（我方特性评分 − 竞品，正=规格更强）；曲线 = 成本差（我方特性成本 − 竞品，负=成本更低）**——双 Y 轴各自 0 居中（规格差分/成本差¥ 量纲分离），多竞品分组（每竞品同色：柱+线一色，RADAR_COLORS 竞品从第二色起）；柱带 ±数值标签；tooltip 组合判读（💪柱正+线负=规格强成本低优势 / ⚠️柱负+线正=劣势 / 柱正线正=强但贵 / 柱负线负=弱但便宜）；图下方四组合判读说明条；未评分或任一方成本缺失 → 该点 null。**⚠️ 轴自适应（示意优先，用户要求）**：不跟随实际极值——adaptiveAxis 去极端（n≥8 去最大 2 个、n≥4 去 1 个、小样本全保留）→ 主体最大值 ×1.25 余量 → niceCeil 取整（1/2/5×10ⁿ）→ 对称 0 居中；极端点超出轴即被裁剪（tooltip 仍可读），保证主体柱子/曲线占轴 40-60% 视觉舒适
- **模块-特性关联**（用户核心诉求：工具不知道哪些模块影响哪些特性，需手动配置）：
  - 新表 `module_feature_links (module_name, feature_id, UNIQUE)`，同名模块全局一致（与模块库分类一致性设计一致）；getModuleNames 从 project_boms 聚合模块名按 BOM 成本降序（先配置成本高的）
  - 主从式配置弹窗：**按模块配置**视图（左=模块列表：搜索框 + 每行显示已关联特性 Tag + 成本，点击选中高亮；右=五维 Checkbox **勾选即保存**，静默无打扰、失败才报错）+ **按特性检查**视图（每个特性下列出已关联模块 Tag，点击可跳回模块视图定位，防遗漏）
  - 空状态引导：无模块时提示"先在项目管理中导入 BOM"
  - 交互细节（frontend-ui-engineering/frontend-design）：原生控件键盘可达、动作动词一致、同一模块评分按钮 + 顶部评分按钮双入口、成本数字 tabular-nums
- **验收自测**：成本力公式边界脚本全过（最低者=10/单产品=10/缺失=null/封顶 10/B≈A=9.9）；特性均值 0 分算已评分、未评分返回 null；雷达顶点 (0,100) 起每 60° 正六边形；tsc --noEmit 通过

### v2.3.19 演示生成：本地 AI 产出 HTML/PPTX 文件 (2026-08-12)
- **背景**：Ollama 只能生成代码文本、无法直接产出文件；且"写优秀案例"这类场景必须引用私有数据——外部模型无数据库通道，本地模型是唯一能边读库边写作的通道。方案：**模型写内容（结构化 JSON），本地模板/渲染器管样式，产出可直接打开的文件**
- **位置**：`src/components/DemoGenerator.tsx`（新组件），入口 = 本地 AI 助手左侧「📄 演示生成（HTML/PPT）」按钮 → 1040px Modal 内嵌；**不触碰现有聊天/知识库/规则任何逻辑**（仅新增 state + 按钮 + Modal）
- **工作流**：选类型（HTML/PPTX）→ 粘贴素材（手动）→ 勾选习惯（可多选）→ Ollama 流式生成 JSON（`{title, subtitle, slides:[{heading, points[], note?}]}`，endpoint native + format:json + think:false + num_predict 4000）→ parseDemoJson 容错解析（容忍 ```json 围栏/前后杂文本，失败自动重试一次）→ 渲染落盘
  - HTML：内置墨蓝+金幻灯片模板（封面/编号要点页/讲稿备注/方向键空格翻页/F 全屏/触摸滑动/进度条/圆点导航，全内联单文件）
  - PPTX：pptxgenjs 4.0.1 渲染（16:9 墨蓝封面+金色标题下划线+编号要点），`write('base64')`
  - 落盘：`save_export_file` → exports/（`演示-标题-时间戳.html|pptx`），「打开导出目录」直达
- **习惯库**（= 工作习惯的沉淀）：
  - 复用 `local_ai_context` 表，新增 `category` 列（ensureSchema 幂等，默认 'general'）；saveContextEntry 加 category 参数
  - 三类用法：**演示结构**（页面怎么组织）、**风格描述**（配色/语气/版式）、**素材模板**（输入字段清单）
  - **从成品提炼**：导入已有 .pptx → jszip 解包（presentation.xml 页序 + rels rId 映射 + 逐页 `<a:t>` 文本提取，`src/pptxExtract.ts`）→ 大纲预览（第N页【标题】+ 要点）→ 命名存入习惯库 → 生成时勾选作为结构范本注入 prompt
  - 习惯管理：列表（分类 Tag + 内容摘要）/新建/编辑/删除；生成区勾选多选
- **代码整理（纯搬移，行为不变）**：`startOllamaStream` 从 LocalAIAssistant.tsx 移到 `src/ollama.ts`（含 OllamaStreamOpts 类型）；getSetting/setSetting/loadContextEntries/saveContextEntry/deleteContextEntry 移到 db.ts 导出——LocalAIAssistant 改 import，避免生成器与页面循环依赖
- **依赖**：`pptxgenjs@^4.0.1`（含 browser 映射，fs/https 置 false，Vite 打包安全；jszip 为 xlsx 已有依赖 3.10.1）；⚠️ 沙箱 npm i 会触发 @tauri-apps/cli-win32 ENOTEMPTY（平台包冲突）——沙箱安装改用「手动下载 tarball 解压 + 手改 package.json」，用户 Windows 上正常 npm install 即可
- **安全**：全程本地（Ollama 流式经 Rust 代理 + 本地解析/渲染），素材与习惯不出本机，符合"云端模型无数据库通道"第一大原则
- **验证**：round-trip 全过（pptxgenjs 生成 → jszip 解包 → 页序/rId 映射/中文文本/表格文本提取正确）；parseDemoJson 四态（干净/围栏/杂文本/非法）；HTML 模板标签配对完整；tsc 真实退出码 0

### v2.3.18 工作手账增强 (2026-08-05)
- **项目标签系统**：
  - `work_logs` 表新增 `work_project` 列（Schema 自动补齐，老数据默认空=公共/其他）
  - 写便签/编辑便签/待办快速添加均支持项目标签：从项目库下拉选择，或 AutoComplete 自由输入新项目名（自动记忆）
  - 便签卡片、待办项显示 📌 项目标签；工具栏支持按项目筛选
- **分类可选**：新建便签分类可留空（保存落"其他"），避免每张便签都要选分类
- **AI 总结重构**：
  - 记录按项目标签分组（【项目名】为组标题，空标签归"公共/其他"），AI 不再猜测归属
  - 正文按四维度组织：项目维度（重点）→ 公共事务 → 能力建设 → 协作互助
  - 串联成文：每个项目按"起因 → 做了什么（时间先后）→ 结果贡献"串成完整故事线，禁止罗列要点
- **AI 总结流式界面修复**：
  - 第一步压缩阶段实时显示压缩内容与字符数（原来只在 console.log，界面无输出）
  - 点击"生成总结"立即打开弹窗，压缩阶段全程可见
  - 模型未配置时给出明确提示（原来会在压缩阶段空转）
- **时间轴修复**：
  - 月份标签从"26月"（slice(2,4) 取错位）修正为"7月"（slice(5,7)）
  - 排序从降序（最近在左）改为升序（最早在左、最近在右），符合时间线直觉
- **已保存总结查看修复**：内容不再被 slice(0,300) 截断，改为列表摘要 + "查看全文"弹窗（可滚动、可复制全文）

### v2.3.18 补充：登录门禁 + 设置页重构 (2026-08-05)
- **登录门禁**：应用启动显示登录界面（用户名+密码），初始 admin/666666；密码错误进入受限模式（db.ts Proxy 拦截所有查询返回空）；双击 Logo 可找回密码（界面不提示）
- **设置页左导航重构**：Claude 风格——左侧分类导航（AI 服务/分析框架/安全设置/个性化/审计日志/关于）+ 右侧内容区，点击切换不滚动
- **用户名可自定义**：设置页安全设置可改用户名（默认 admin），登录页双验证
- **Token 用量统计**：外部 LLM 调用自动记录 token 消耗，设置页审计日志分区展示（总量/按供应商/近30天趋势）

### v2.3.18 补充：物料趋势洞察平台强化 (2026-08-05)
- **Skill 方法论体系**：
  - 9 个内置 Skill 各配专属方法论（分析步骤/证据要求/判断规则），注入洞察 prompt（`BUILTIN_SKILLS.systemPrompt` + `buildStructuredAnalysisPrompt` 方法论详情章节）
  - 设置页 Skill 卡片显示方法论摘要；编辑弹窗新增"分析方法论"标签页（可查看/编辑，随 skillOverrides 持久化）
- **数字口径约束**：
  - prompt 新增数字口径硬约束：幅度仅表示近 1-3 月采购价格变化，严禁市场规模/CAGR/累计涨幅/单点新闻口径
  - `normalizeStructuredResult` 代码兜底：方向-幅度一致性校验、超 ±30% 异常幅度拦截置空、震荡/信号不明确幅度置空
- **洞察性能优化**：
  - 多 Skill 洞察分析串行 → 并行（`Promise.all`）；搜索查询串行 → 并行（`executeSearchRounds`）
  - 快照/来源落库并行化；批量洞察改为有界并发（同时 2 个），移除节点间 1.5s 空等
- **洞察可靠性修复**：
  - `max_tokens` 4000 → 8000（修复多维度 JSON 输出被截断）
  - `createStructuredInsight` 检测 extractJSON 兜底对象（`_parse_error`），解析失败明确抛错，不再静默存"格式异常"假结果
  - **快照取序修复**：`getTrendSnapshots` 按 query_time DESC 返回，界面多处误用 `[length-1]` 取最旧快照 → 改为 `[0]` 取最新（详情页最新洞察、Rollup 展示、追问上下文、摘要更新 4 处）
  - 界面新增"与上次洞察方向冲突"黄色警告条
  - **Skill 选择全选 bug 修复**：洞察确认弹窗 Skill 多选改用自绘勾选控件（纯手动控制），避开 Checkbox.Group 无 value 导致的误全选
  - **白屏崩溃修复**：`renderSkillDimensions` 曾定义在组件主 return 之后（const 不提升 → ReferenceError → 白屏），已移到 return 之前
  - **综合深度研究方法论扩充**：五看每维度配问题清单 + 三定（定向/定量/定策）+ 证据分级（强/中/弱）+ 置信度评分规则 + 输出约束
- **筛选联动** (2026-08-05)：器件库、供应商管理页的"大类→子类"筛选联动（选大类后子类只显示该大类下的，切换大类自动清空子类）
- **Token 用量统计** (2026-08-05)：外部 LLM 调用自动记录 token 消耗（ai_request_logs 表新增 provider_name/model_name/prompt_tokens/completion_tokens/total_tokens 列），设置页审计日志分区展示总量/按供应商聚合/近30天趋势
- **应用图标**：设计新 logo（墨蓝渐变圆角底 + 金色成本阶梯下降线），替换 src-tauri/icons 全部图标（8-bit PNG/ICO，修复 Tauri 构建报错）
- **HTTP 代理支持** (2026-08-06)：build_http_client 读取 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 环境变量（reqwest Proxy::all），send_http 与 http_stream 共用——解决公司网络/代理环境下"浏览器能上、应用 Network request failed"的问题
- **用户自定义 logo** (2026-08-05)：用户提供 1024×1024 透明底 logo（蓝紫渐变风格），已替换：程序图标（src-tauri/icons 全部尺寸 8-bit）+ 侧边栏左上角（src/assets/costhub-logo.png，Vite import 引用）+ 登录页 logo
- **侧边栏增强** (2026-08-05)：底部改为"用户头像+用户名"组合（点击弹出菜单：系统设置/功能介绍/主题/缩放/版本，替代原独立设置齿轮按钮）；左上角 logo 用默认图标
- **使用说明页** (2026-08-05)：新增 public/guide.html（HTML 使用说明，深墨蓝+金色风格），App 侧边栏用户菜单"功能介绍 / 使用说明"以 Modal+iframe 打开

### v2.3.17 统一物料趋势洞察平台 (2026-07-31)
- **功能整合**：
  - 将 TrendInsight.tsx 的所有功能整合到 Decomposition.tsx
  - 形成统一的"物料趋势洞察"平台
  - TrendInsight.tsx 标记为已废弃
- **增强功能**：
  - 物料分解树 + 趋势洞察 + 历史记录 + 追问对话完整整合
  - 支持从器件库标记的"关注物料"快速洞察
  - 改进的卡片式展示布局
  - 历史洞察记录时间线
  - 多轮追问对话功能（携带完整上下文）
- **用户体验优化**：
  - 统一的入口：顶部"AI 起草顶层物料"和"手动添加"按钮
  - 卡片式物料清单展示（显示趋势方向、节点数量、洞察状态）
  - 点击卡片展开详情区（包含分解树、洞察结果、历史记录、追问对话）
  - 关注物料区域（从器件库同步）
- **架构改进**：
  - 单一页面管理所有物料趋势相关功能
  - 减少代码重复，提高维护性
  - 统一的数据流和状态管理

### v2.3.16 供应商管理简化 (2026-07-30)
- **字段简化**：
  - 移除不必要的字段：MOQ（最小起订量）、交期（lead_time）、优先级（priority）
  - 保留核心字段：供应商名称、报价、份额比例、状态、备注
  - 更符合ODM模式的业务场景
- **界面优化**：
  - 添加"设为主供应商"快捷操作（一键设置100%份额）
  - 最低价供应商自动标记绿色"最低价"标签
  - 报价价格颜色区分：最低价绿色，最高价红色
  - 统计面板增强：显示供应商数量、启用数量、价格区间、加权成本
  - 表格底部统计更直观：双行布局，信息更清晰
- **成本计算优化**：
  - 添加/修改/删除供应商时自动更新器件加权成本
  - 加权成本计算逻辑：`加权成本 = Σ(启用供应商价格 × 份额比例) / Σ(启用供应商份额比例)`
  - 器件成本变化自动反映到器件列表
- **数据库迁移**：
  - Migration version 6：简化 part_suppliers 表结构
  - 自动迁移旧数据，保持兼容性

### v2.3.15 配置修复 (2026-07-29)
- **数据库文件名修复**：
  - 将 `src-tauri/src/lib.rs` 中的数据库文件名从 `monitor_cost.db` 更正为 `costhub.db`
  - 确保与项目命名规范一致
- **应用标识符修复**：
  - 将 `tauri.conf.json` 中的 identifier 从 `com.monitor.cost.manager` 更正为 `com.costhub.app`
  - 符合官方命名规范
- **构建脚本优化**：
  - 新增 `build.bat` 一键构建脚本
  - 在 `package.json` 中添加 `tauri`、`tauri:dev`、`tauri:build` 脚本命令
  - 简化构建流程
- **数据迁移说明**：
  - 如需保留旧数据，需手动将 `monitor_cost.db` 复制为 `costhub.db`
  - 新安装将自动创建 `costhub.db`

### v2.3.6 Bug 修复 (2026-07-27)
- **成本快照计算修复**：
  - 修复手动创建快照时总成本计算错误（未乘以数量）
  - 修复 `createProjectCostSnapshot` 函数的成本计算公式
- **成本变化日志增强**：
  - 修复 `updateBOMItem` 日志只显示数量变化的问题
  - 现在会同时显示数量和成本的变化详情
  - 日志示例：`修改BOM条目: LCD屏幕 (成本: ¥100.00 → ¥120.00)`

### v2.3.5 特性 (2026-07-27)
- **模块批量分类增强**：
  - 模块分组卡片右上角添加"设置分类"按钮
  - 支持批量为所有同名模块设置分类
  - 分类继承机制：新建同名模块自动继承已有分类
  - 一次设置，全局生效，保持同名模块分类一致性
- **数据库函数**：
  - 新增 `updateModuleCategoryByName(name, category)` 批量更新函数

### v2.3.4 特性 (2026-07-27)
- **虚拟模块过滤**：
  - 模块库页面不再显示在研项目中创建的虚拟模块
  - 虚拟模块仅在项目页面显示，避免模块库混乱
  - `getModules` 函数新增 `includeVirtual` 参数控制
- **模块分类管理**：
  - 新增 `modules.category` 字段，支持模块分类
  - 模块库页面新增分类筛选器（绿色标签）
  - 模块卡片显示分类标签
  - 模块编辑表单支持选择现有分类或输入新分类
  - 支持项目筛选 + 分类筛选同时使用
  - 自动收集所有已使用的分类供选择
- **数据库扩展**：
  - `modules` 表新增 `category` 字段
  - 新增 `getModuleCategories()` 函数

### v2.3.3 特性 (2026-07-27)
- **自动成本快照增强**：
  - 项目总成本变化自动记录（无需手动创建快照）
  - 自动触发场景：
    - 添加/删除/修改项目BOM条目
    - 修改项目费率（平台费率/利润率）
    - 批量删除模块BOM
    - 器件成本变化影响项目
  - 每次变动记录完整信息：旧总成本、新总成本、变动原因、影响详情
  - `cost_change_log` 新增 change_type: 'project_total_cost'
- **成本变动追溯链完善**：
  - 形成完整链路：供应商价格 → 器件成本 → 项目总成本
  - 每个环节自动记录，可追溯完整变动历史

### v2.3.2 特性 (2026-07-23)
- **供应商管理系统优化**：
  - 简化字段：移除供应商代码、交期、MOQ字段，保留核心字段（名称、价格、份额、状态、备注）
  - 价格变动强制记录原因：修改供应商价格时弹窗要求输入变动原因
  - 价格变动历史追踪：自动记录每次价格变动及原因
- **整机供应商管理（ODM项目）**：
  - 项目管理页面新增"整机供应商"标签页
  - 支持多个整机供应商报价管理
  - 份额比例分配，自动计算加权报价
  - 整机报价变动记录及历史追踪
- **成本变动追溯系统**：
  - 新增 `cost_change_log` 统一成本变动日志表
  - 记录完整变动链路：器件供应商价格 → 器件成本 → 项目BOM成本
  - 记录变动类型、关联信息、变动原因、影响范围
  - 支持按类型和ID查询成本变动历史
- **数据库扩展**：
  - Migration version 24：新增 `project_suppliers`、`project_supplier_price_history`、`cost_change_log` 表
  - 简化 `part_suppliers` 表结构

### v2.3.1 特性 (2026-07-23)
- **供应商管理系统**：
  - 每个器件可添加多个供应商报价
  - 支持设置供应商份额比例（0-100%）
  - 自动计算加权成本：加权成本 = Σ(供应商价格 × 份额比例)
  - 供应商价格历史追踪（自动记录价格变动）
  - 供应商启用/停用状态管理
  - 右侧抽屉式UI，不遮挡主界面
  - 紧凑的卡片式供应商列表展示
- **数据库扩展**：
  - 新增 `part_suppliers` 表
  - 新增 `part_supplier_price_history` 表
  - Migration version 23

### v2.2 特性
- 项目分组管理
- BOM引用和差异分析
- 软删除机制
- 全局搜索（Ctrl+K）
- 最近更新器件侧边栏
- 多主题调色板
- 色温调节
- 动效控制
- 缩放控制
- 竞品排序
- 项目拖拽排序

## 后续开发建议

1. **数据库备份**: 增加数据库导出/导入功能
2. **数据同步**: 支持云端同步（可选）
3. **权限管理**: 多用户角色（管理员/编辑者）
4. **审计日志**: 记录关键操作历史
5. **报告模板**: 自定义报告格式
6. **数据导入**: 更多格式支持（CSV、JSON）
7. **图表增强**: 更多可视化维度
8. **移动端**: Web 版本或移动应用
9. **API接口**: 供第三方系统集成
10. **性能监控**: 前端性能指标采集

## 维护指南

### 修改主题
- 编辑 `src/constants.ts` PALETTES
- 编辑 `src/index.css` 对应 [data-palette="<id>"] 块
- 编辑 `src/main.tsx` PALETTE_PRIMARY 映射

### 添加新分类
- 在 `constants.ts` MAIN_CATEGORIES 或 SUB_CATEGORIES 添加
- CATEGORY_COLORS 已包含主要分类
- 新分类自动获得稳定哈希颜色

### 修改数据库表
- 在 `src-tauri/src/lib.rs` migrations 数组添加迁移
- 在 `src/db.ts` ensureSchema 添加自动补齐逻辑
- 更新 `src/types.ts` 对应接口

### 添加新页面
- 在 `src/pages/` 创建新组件
- 在 `src/App.tsx` NAV 数组添加导航项
- 在 `src/App.tsx` render 函数添加渲染逻辑

---

**文档维护**: 所有重要的项目变更应同步更新此文件。**每次完成功能开发、Bug修复或数据库变更后，必须立即更新本文件**（功能模块、数据模型、数据库管理、文件结构、更新历史各节同步），确保新开对话时上下文完整、无需从代码反推。更新历史新增条目时，同步更新文档头部的产品版本号（产品版本号与 package.json 的构建版本号可能不同步，以文档内部一致为准）。

**会话接续**: 项目根目录的 `会话接续说明.md` 记录当前进度/未完成事项/近期改动/关键约定。**铁律：每个任务完成后，必须同时更新 `会话接续说明.md` 和本文件（CLAUDE.md）**——先改代码，再改文档，最后才算任务完成。新开对话时先读这两个文件即可完整接续。

**最后更新**: 2026-08-12

## 2026-06-23 调试记录

### 问题背景
在另一台电脑上运行时，Ant Design 的 Modal 弹窗和 Select 下拉菜单**渲染出来但不可见**（用户能编辑内容、能关闭，但看不到弹窗）。当前电脑运行正常。

### 排查过程

#### 1. 初始怀疑：数据库问题
- 用户最初报告"数据库初始化失败：数据库连接失败: undefined"
- 尝试添加错误处理、超时机制
- 结论：数据库连接正常，不是根本原因

#### 2. CSS 层叠上下文问题（错误方向）
- 检查 `index.css` 发现大量 `backdrop-filter` 使用
- 尝试移除 `backdrop-filter`、添加高 `z-index`、移除 `isolation: isolate`
- 尝试添加 `getPopupContainer={() => document.body}`
- 结论：这些修改无效，问题不在 backdrop-filter

#### 3. Git 版本回退
- 用户确认上周版本正常
- 尝试回退到原始版本（只保留用户要求的修改：移除成本快照栏）
- Git 操作遇到合并冲突，最终回退成功

#### 4. 环境因素排查
- 另一台电脑 WebView2 版本：149.4022.80（较新版本）
- 另一台电脑上另一个 Tauri 工具运行正常（同样技术栈）
- 结论：问题在代码而非环境

#### 5. 用户发现关键线索
- 用户发现：**关闭动效开关（点击"💤"按钮）后，Modal/Select 正常显示**
- 这直接指向了 `[data-motion="off"]` 相关的 CSS 问题

#### 6. 真正原因找到
检查 `index.css` 第1379-1384行：
```css
[data-motion="off"] *,
[data-motion="off"] *::before,
[data-motion="off"] *::after {
  animation: none !important;
  transition-duration: 0.001s !important;
}
```

**问题分析：**
- 这个规则把**所有元素**的 `transition-duration` 设为 0.001s
- Ant Design Modal/Select 依赖 CSS transition 实现淡入效果
- transition 被强制缩短到 0.001s，在某些 WebView2 渲染引擎中动画状态异常
- Modal 可能"闪过"后消失，或根本不显示

**为什么这台电脑正常，另一台不行？**
- 两台电脑的 WebView2 渲染引擎对极短 transition 的处理方式不同
- 某些渲染引擎能在 0.001s 内正确完成动画，某些不能
- 这取决于底层 Chromium 版本和 GPU 渲染配置

### 最终修复方案

在 `index.css` 中添加例外规则（第1385-1393行）：
```css
/* Modal 和 Select 下拉菜单保持正常 transition，不受动效开关影响 */
[data-motion="off"] .ant-modal-content,
[data-motion="off"] .ant-modal-mask,
[data-motion="off"] .ant-select-dropdown,
[data-motion="off"] .ant-popover-inner {
  transition-duration: 0.3s !important;
}
```

**原理：**
- 动效开关只影响普通元素的动画
- Modal/Select/Popover 等弹出组件保持正常 transition
- 这样既能实现"关闭动效"的效果，又不影响弹窗显示

### 当前代码状态

#### 最终修改内容
1. **移除成本快照栏** - Dashboard.tsx 移除了成本快照相关代码
2. **移除自动生成测试数据** - main.tsx 移除了 seedTestData 自动调用
3. **修复动效开关问题** - index.css 添加 Modal/Select 的 transition 例外规则

#### 未保留的尝试
- `src/compat.css` - 已删除（不需要）
- `getPopupContainer` 配置 - 已移除（不需要）

### GitHub 仓库
- 仓库地址：https://github.com/JT15199/monitor-cost.git (GitHub仓库名未变更)
- 已推送当前版本

### 经验教训

**排查 CSS 问题时的关键点：**
1. 不要只关注复杂属性（如 backdrop-filter），简单属性也可能有问题
2. 全局 CSS 规则（如 `[data-motion="off"] *`）可能影响所有组件
3. transition-duration 过短在某些环境下会导致动画状态异常
4. 用户反馈是最重要的线索——用户发现"关闭动效开关就正常"直接指向了问题根源

**类似问题的排查思路：**
1. 让用户尝试不同设置（主题、动效、色温等）
2. 检查全局 CSS 规则，特别是带 `*` 通配符的
3. 检查 `transition` 和 `animation` 相关属性
4. 在不同环境测试同一行为

---

## 业务背景：ODM模式下的成本管理

### 项目性质

**显示器产品采用ODM（Original Design Manufacturer）模式**：
- 品牌方（用户）负责产品规格定义
- ODM供应商负责物料采购、生产制造、质量控制
- 品牌方按整机采购，不直接采购器件

### 用户工作流程

```
品牌方（用户）                    ODM供应商
     │                              │
     │  1. 提出产品规格要求          │
     │ ──────────────────────────▶  │
     │                              │
     │  2. 供应商报价（整机+BOM明细） │
     │ ◀────────────────────────── │
     │                              │
     │  3. 用户细分模块、导入系统    │
     │                              │
     │  4. 审核报价合理性            │
     │    对比多家供应商报价         │
     │                              │
     │  5. 谈价、确认价格            │
     │ ──────────────────────────▶  │
```

### 数据录入方式

用户收到供应商报价BOM后：
1. **自己细分模块** - 将供应商BOM按功能拆分（电源模块、驱动板模块等）
2. **导入系统** - 通过Excel导入功能批量入库
3. **分类整理** - 按大类/子类规范器件分类

### 工具的实际用途

在ODM模式下，工具的核心价值：

| 功能 | 用途 | 备注 |
|------|------|------|
| **器件库** | 存储供应商报价的器件信息 | 数据来源是供应商报价，不是用户采购 |
| **项目管理** | 管理各项目报价BOM | 一个项目对应一次报价 |
| **模块库** | 按功能模块组织器件 | 用户手动拆分，便于分析 |
| **竞品管理** | 管理竞品报价对比 | 对比不同供应商报价 |
| **对比分析** | 多供应商报价对比 | 核心功能：A供应商vs B供应商 |

### 核心痛点

1. **报价审核**：供应商给的BOM明细，怎么判断是不是虚高？
2. **供应商对比**：多家供应商报价，哪家更合理？
3. **谈价筹码**：谈判时需要知道"这个器件市场价是多少"
4. **报价追踪**：同一产品不同阶段报价变化（试产→量产）

### 与传统成本管理的差异

| 维度 | 传统模式（自采自产） | ODM模式 |
|------|----------------------|---------|
| 器件库来源 | 自己采购积累 | 供应商报价累积 |
| BOM创建 | 自己从零构建 | 供应商报价导入 |
| 成本计算 | 自己核算成本 | 供应商已报价，审核合理性 |
| 关注重点 | 成本构成分析 | 报价合理性判断 |

### 器件库数据价值

器件库的价格数据来源于：
- **历史报价累积**：每次供应商报价都入库，形成价格历史
- **多供应商对比**：同一器件不同供应商报价，形成价格区间
- **合理性判断**：新报价与历史对比，判断是否虚高

### 后续功能建议（基于ODM模式）

#### 高优先级

| 功能 | 说明 |
|------|------|
| **报价快速导入** | 供应商报价Excel直接入库，识别模块/器件 |
| **同一器件多报价对比** | "器件X: A供应商35元，B供应商28元" |
| **报价历史追溯** | 同项目不同阶段报价对比 |
| **供应商评级** | 报价水平、配合度、质量记录 |

#### 中优先级

| 功能 | 说明 |
|------|------|
| **报价偏差提示** | 器件报价明显高于历史同类项目 |
| **模块级报价对比** | 不只看器件，也看模块整体报价差异 |
| **报价版本管理** | 同一供应商多次报价，记录版本 |

#### 低优先级（ODM模式下不需要）

| 功能 | 原因 |
|------|------|
| **良率成本** | 供应商负责生产，品牌方不管理良率 |
| **库存成本** | 供应商负责物料，品牌方不持有库存 |
| **采购管理** | 品牌方不直接采购器件 |

---

**文档维护**: 所有重要的项目变更应同步更新此文件。**每次完成功能开发、Bug修复或数据库变更后，必须立即更新本文件**（功能模块、数据模型、数据库管理、文件结构、更新历史各节同步），确保新开对话时上下文完整、无需从代码反推。更新历史新增条目时，同步更新文档头部的产品版本号（产品版本号与 package.json 的构建版本号可能不同步，以文档内部一致为准）。

**会话接续**: 项目根目录的 `会话接续说明.md` 记录当前进度/未完成事项/近期改动/关键约定。**铁律：每个任务完成后，必须同时更新 `会话接续说明.md` 和本文件（CLAUDE.md）**——先改代码，再改文档，最后才算任务完成。新开对话时先读这两个文件即可完整接续。

**最后更新**: 2026-08-12