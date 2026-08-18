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
3. **startOllamaStream 参数铁律**：必须显式 `json: false`（默认 format:'json' 会吞掉自由文本输出——曾致自主分析整轮无内容）；思考型模型必须 `num_predict: 4096`（1200 截断长思考→无结论，已修两次）。
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

## 五、用户偏好（产品行为红线）

1. **安静后台**：后台引擎失败/无产出一律静默降级，不弹提示；提示只在真实产出或手动操作时。
2. **不故意弹窗**：云端审批走非打断式横幅队列，出现的一定有用，不阻碍视线不频繁打扰。
3. **emoji 规则**（ui-ux-pro-max）：SVG 图标不用 emoji（用 antd 图标）；正文文本 emoji 保留。
4. **目标成本铁律**：目标成本数据依赖用户设定（生产库仅 2 条）——驾驶舱预警/分析以目标设定为前提，未设定不得编造目标。

## 三·补、阶段 ① 目标管理（2026-08-18 harness 化）

- **ai_goals 表**（db/goals.ts）：text/status(active|paused|done)/progress/linked_project；运行时兜底建表。
- **autoThink 集成**：buildThinkOverview 顶部注入【用户目标】（active 前 3 条+最近推进）；sysPrompt 优先围绕目标；每轮结论前 200 字 appendGoalProgress 回写进度（保留最近 5 段）。
- **GoalsCard**（本地 AI 助手「自主分析」视图顶部）：下达/完成/暂停/恢复/删除 + 进度展示；驾驶舱不显示（inline 紧凑）。

## 六、工作流约定

1. **构建由 AI 负责**：代码改动完成后 AI 执行 `npm run build` + `npm run tauri:build`（构建前确认 costhub.exe 未运行；build.bat 末尾有 pause 不适合脚本环境）；验证产物 exe 时间戳后向用户确认。
2. **文档铁律**：改代码 → 更新本文件（如涉及新约束）→ 更新 `会话接续说明.md` → 任务才算完成。新开对话先读 会话接续说明.md + 本文件即可接续。
3. **git**：推送 `git push costhub main`（origin 的 fork 拒绝属正常，忽略）。
