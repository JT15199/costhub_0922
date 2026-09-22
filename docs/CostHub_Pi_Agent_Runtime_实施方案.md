# CostHub Pi Agent Runtime 实施方案

## 1. 结论

CostHub 不应接入完整的 `pi-coding-agent`，也不应现阶段接入 DeepSeek Harness（DSH）。本次采用：

- 在 React/WebView 内嵌 `@earendil-works/pi-agent-core`，只替换右侧 AI 协作的 Agent 循环。
- 继续通过现有 `startOllamaStream -> Tauri http_stream -> 本机 Ollama` 调用模型。
- 继续使用现有 `aiTools.ts`、`toolRegistry.ts`、结构化证据、写操作确认、云端审批和审计。
- 不启用 Pi 的文件、Shell、PowerShell、编辑器、网络、扩展发现或凭据管理。
- 不增加 Node、Bun 或 sidecar，不改变免安装 `CostHub.exe` 的交付方式。
- DSH 暂不接入。它仍处于 developer preview，官方明确说明未经过安全审计且不应视为生产就绪。

这次改造的目标不是“换一个名字”，而是把当前脆弱的文本标记循环替换为成熟的状态机、事件流和原生工具调用，同时保留 CostHub 已经正确实现的数据边界。

## 2. 当前代码的真实情况

当前右侧 AI 主链路为：

```text
AiPanel.tsx
  -> 拼装数据地图、用户偏好、技能和 42 个工具说明
  -> thinkEngine.runThinkLoop
  -> startOllamaStream
  -> Rust http_stream
  -> 本机 Ollama
  -> 解析 [TOOL]/[CLOUD] 文本标记
  -> AiPanel 内处理 ask_user、写入确认、附件和云端审批
  -> aiTools.executeTool
  -> SQLite / 结构化工具 / 云端安全网关
```

已有且必须保留的能力：

- 42 个成本业务工具及参数校验。
- 工具 Manifest：read/calculate/write/cloud、风险等级、确认要求。
- 写工具未确认时拒绝执行。
- 结构化 `AiToolResult`、证据引用、数字校验和分析运行记录。
- 本地模型仅允许回环地址，Rust 每次请求检查 Ollama 防火墙隔离。
- 云端 C1/C2 脱敏、授权哈希、域名白名单和外发审计。
- SQLite 会话、分析成果和工作手账持久化。
- 现有本地脱敏评测集与 Harness 单测。

当前主要问题：

1. `thinkEngine.ts` 依赖模型输出 `[TOOL] {...}` 文本，解析容错有限，工具调用不是协议级事件。
2. `AiPanel.tsx` 同时承担上下文、附件导入、权限、Agent 调度和 UI，已经过重。
3. 每轮把全部 42 个工具说明塞给本地模型，增加小模型选错工具和上下文拥挤概率。
4. 当前对话虽然写入 SQLite，但每次 Agent 运行主要只拿本轮问题，连续对话能力不足。
5. 自定义循环、停止、重试、工具轨迹和上下文压缩散落在多处，维护成本高。

## 3. 为什么选 Pi Core，而不是完整 Pi 或 DSH

### Pi Core

`@earendil-works/pi-agent-core` 已提供：

- Agent 状态和多轮工具循环。
- 原生工具调用、参数校验、顺序/并行执行。
- `beforeToolCall` / `afterToolCall` 门禁。
- token、思考、工具开始/结束、轮次和 Agent 生命周期事件。
- abort、steer、follow-up、上下文转换。
- 浏览器应用通过后端代理调用模型的正式用法。

它不默认带文件系统、Shell 和项目扫描，适合 CostHub。

### 不用完整 `pi-coding-agent`

完整包默认面向编码 Agent，包含资源发现、会话文件、文件/Shell 工具等能力。CostHub 不需要这些能力，引入后会扩大依赖和安全面，也不适合当前 Tauri WebView 的单 exe 交付。

### 暂不用 DSH

DSH 的 SDK、插件树、审批、沙箱和会话能力很完整，但目前仍是实验性 developer preview，兼容性和安全边界都未稳定。CostHub 没有必要为了“未来可替换”同时维护两套运行时。

## 4. 目标架构

```text
AiPanel
  -> buildAgentContext（页面、历史、附件摘要、用户偏好）
  -> selectAgentTools（按任务选择 6~10 个工具）
  -> runPiAgent
       -> Pi Agent Core（状态、轮次、事件、原生 tool call）
       -> costHubStreamFn
            -> startOllamaStream
            -> Rust http_stream
            -> 本机 Ollama
       -> CostHub Tool Adapter
            -> 现有 ask_user / 写入确认 UI
            -> aiTools.executeTool
            -> SQLite / 结构化证据 / 云端网关
  -> 现有消息、步骤卡、分析成果 UI
```

只增加一个 Pi 运行入口和一个流适配层，不创建通用 Runtime 工厂、插件系统或第二套工具注册表。

## 5. 实施范围

### 5.1 依赖

引入并锁定明确版本：

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- Pi 工具 schema 实际要求的 TypeBox 包（仅在包未直接导出所需构造器时添加）

不得引入：

- `@earendil-works/pi-coding-agent`
- DeepSeek Harness
- Node/Bun runtime
- Tauri shell 插件
- 新的数据库或状态管理框架

### 5.2 Pi 流适配

新增 `src/ai/piStream.ts`：

- 实现 Pi `streamFn` 所需的流事件。
- 底层只调用现有 `startOllamaStream`。
- 使用 Ollama 原生 `/api/chat` 和原生 `tools`。
- 映射正文、思考、工具调用、完成、错误和取消事件。
- 不允许传入非回环 URL；该校验仍由 `securityPolicy.ts` 和 Rust 双层执行。
- 不直接使用浏览器 `fetch`，避免绕过 Rust 安全网关。

### 5.3 CostHub 工具适配

新增 `src/ai/piRuntime.ts`：

- 把 `listTools()` 返回的工具转换为 Pi `AgentTool`。
- 参数 schema 从现有 `AiTool.params` 生成，不复制手写第二套 schema。
- 工具执行继续调用由 `AiPanel` 注入的现有执行回调，保留：
  - `ask_user` 选项 UI。
  - 附件已就绪时阻止重复 `read_excel`。
  - `canonicalize_project` 项目范围保护。
  - 写入工具确认和审计。
  - 云端审批及 C1/C2 网关。
- `toolExecution` 默认 `sequential`，避免导入、写回和依赖步骤并发。
- `beforeToolCall` 再次检查工具是否存在 Manifest；未声明风险的工具直接拦截。
- 工具结果继续使用现有 4000 字上限和结构化证据，不把整库数据放进上下文。

### 5.4 动态工具选择

新增或复用一个纯函数 `selectAgentTools(question, pageContext, attachmentTypes)`：

- 每轮通常只暴露 6~10 个相关工具，而不是全部 42 个。
- 使用现有 `detectSkill`/页面上下文/附件类型做确定性路由，不再增加一次 LLM 调用。
- 公共工具：`ask_user`、`calc`、`now`、`query_data_readiness` 按需加入。
- 项目/招标/物料洞察/原声/工作手账/导入分别使用白名单工具组。
- 无法判断时使用只读通用组；写工具只有在问题明确包含导入、记录、保存或生成动作时才暴露。
- 保留工具 ID，不修改数据库层 API。

为路由函数增加表驱动单测，至少覆盖：项目成本、招标议价、物料洞察、原声分析、工作手账、四类附件导入、纯咨询、模糊任务。

### 5.5 模型能力探测与兼容模式

Pi 的原生 Agent 循环要求本地模型能够稳定返回原生 `tool_calls`。当前 CostHub 曾因本地小模型工具调用不稳定而改用文本协议，因此不能盲目切换。

实施一次轻量探测并按 `baseUrl + model` 缓存结果：

- 给模型一个只读 `now` 测试工具。
- 要求调用该工具，不写数据库、不访问云端。
- 成功返回合法 tool call：使用 Pi。
- 模型不支持、返回格式错误或超时：使用现有 `runThinkLoop` 兼容模式，并在设置/AI 面板显示“当前模型不支持原生工具调用，正在使用兼容模式”。

不得伪装成 Pi 已生效。用户必须能看到当前运行模式。

### 5.6 会话和上下文

- `local_ai_sessions` / `local_ai_messages` 仍是唯一持久化来源。
- 不启用 Pi 自己的文件会话、`~/.pi`、资源扫描、全局 skills 或凭据文件。
- 启动一轮时只加载当前会话最近 8 轮，按字符预算裁剪。
- 复用当前 `compressMessages` 的安全裁剪思路；先不新建第二套长期记忆系统。
- 附件完整表格继续由工具读取，只把文件名、类型、表头和行数放入 prompt。
- Pi 的运行时状态只存在内存，最终用户/助手消息仍按当前方式写 SQLite。

### 5.7 UI 事件映射

Pi 事件映射到当前步骤卡：

- `agent_start/agent_end`：分析开始/结束。
- `turn_start/turn_end`：轮次状态。
- `message_update`：思考和正文流式输出。
- `tool_execution_start/end`：工具执行卡及成功/失败状态。
- abort：复用当前停止按钮。

不重做 AI 面板视觉，只修正运行状态和模式标识；分析成果、图表和工作手账不在本次改造范围。

## 6. 安全红线

1. Pi 只拿到 CostHub 白名单业务工具，禁止文件、Shell、进程、编辑器和通用 HTTP 工具。
2. 模型请求必须继续经过 Rust `http_stream`；不能从 WebView 直接 fetch Ollama。
3. Pi 不保存 API key，不读取环境变量和 `~/.pi`。
4. 云端查询仍只能调用现有业务工具，再经 C1/C2 审批和 Rust `cloud_http_request`；Pi 不能直接联网。
5. 写操作仍由现有 `executeTool` 与 UI 双重确认，不能因接入 Pi 降级。
6. 工具参数、结果、异常都要截断并审计；不得记录完整密钥或不必要的完整 BOM prompt。
7. 依赖版本必须锁定，更新 Pi 时单独跑安全与回归测试。

## 7. 实施顺序

### P0：基线和最小验证

- 运行现有单测、TypeScript 构建并记录结果。
- 建一个仅包含 `now`、`query_projects`、`query_project_bom` 的 Pi 验证入口。
- 验证当前主用模型是否支持 Ollama 原生 tool call。
- 验证 Vite/Tauri 正常打包，无 Node polyfill 和 sidecar。

P0 未通过时停止接入，不得为了“完成”而引入 sidecar 或放宽安全限制。

### P1：只读 Agent

- 接入 Pi 事件流、动态工具选择、历史上下文和停止功能。
- 先开放 read/calculate 工具。
- 保留 Legacy/Pi 模式标识和自动回退。

### P2：交互与写工具

- 接入 `ask_user`。
- 接入现有写操作确认、附件导入和报告生成。
- 验证取消确认后数据库零变化。

### P3：云端工具与回归

- 接入现有 `insight_material_trend` / `cloud_abstract_analysis`，只允许走原有网关。
- 不改授权模型；单独修复已有授权哈希/过期问题，不把安全规则删掉。
- 运行完整单测、前端构建和 Tauri release 构建。

### P4：切换默认值

只有达到验收标准后，Pi 才成为支持原生工具调用模型的默认运行时；Legacy 继续作为不支持模型的兼容模式，不立即删除 `thinkEngine.ts`。

## 8. 验收标准

### 功能

- 当前主用模型若支持 tool call，Pi 模式能完成：项目 BOM 查询、成本结构、目标差距、招标议价、物料洞察、原声分析、工作手账查询、附件导入和报告生成。
- 多轮追问能引用最近会话，不再每次从零开始。
- 工具轨迹、思考、停止、错误和回退状态可见。
- 模型不支持 tool call 时自动进入兼容模式，功能不比现状退化。

### 安全

- 尝试调用未知工具、Shell、文件或任意 URL 均被拒绝。
- 未确认写工具不产生数据库变化。
- 本地模型地址非回环时被前端和 Rust 拒绝。
- 云端请求无授权、过期、哈希不符、字段越界或域名不在白名单时仍被拒绝。
- Pi 运行过程中不创建 `~/.pi`、auth、session 或 skill 文件。

### 质量

- 扩充本地评测集到至少 12 个真实脱敏任务。
- 相同模型下，Pi 模式工具选择正确率不得低于兼容模式。
- 数字证据覆盖率、未确认写入拦截率、外发泄漏拦截率必须保持 100%。
- `npm test`、`npm run build`、`cargo test`、`npm run tauri:build` 全部通过。
- 最终产出可直接运行的免安装 `CostHub.exe`，数据库仍位于既有位置，不要求安装 Node/Bun。

## 9. 明确不做

- 不删除现有 42 个业务工具或重写数据库层。
- 不把 `trendService.ts` 的专用搜索 Agent 一次性迁入 Pi。
- 不同时接入 Pi 和 DSH 两套运行时。
- 不实现通用 MCP、插件市场、多 Agent 编排、自动 Shell 或任意文件访问。
- 不为未来假设创建 Runtime 工厂、Adapter 注册中心或复杂配置 DSL。
- 不以关闭安全网关的方式解决当前云端调用失败。

## 10. 参考

- Pi Agent Core：<https://github.com/earendil-works/pi/tree/main/packages/agent>
- Pi SDK：<https://pi.dev/docs/latest/sdk>
- Pi 与 Ollama：<https://docs.ollama.com/integrations/pi>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- DSH Safety：<https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md>
