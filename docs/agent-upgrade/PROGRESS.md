# Luna 执行状态：唯一恢复入口

最后更新：2026-09-12（修复 Ollama 思考输出占满上下文导致无答案；真实 E01-E10、云端和干净环境验收仍未完成）。

## 当前定位

- 当前阶段：P08/P09 真实验收收口。
- 已完成：真实 Ollama tool call、三次真实摘要、9B 桌面真实工具调用、同一桌面会话三次模型压缩、进程重启恢复、Windows AppContainer 隔离、便携 EXE 启动和旧库复制启动。
- 下一步：先完成本轮代码修复的真实取消/压缩/通用文件任务验证，再补有授权的云端 E07、E01-E10 三轮完整业务任务和真正无开发环境验收；没有这些条件时保持“未验收”。
- 本轮返修：thinking 不再回灌为 assistant 正文或计入输入预算；记录 `done_reason`/usage，只有 thinking 且 `length` 截断时最多一次关闭思考的结论收尾，不重放工具。
- llama.cpp：已安装官方 `b10919` Windows x64 Vulkan 运行包到本机 `tools/llama.cpp/b10919-vulkan`；CostHub 已支持选择后端、`/v1/models`、`/v1/chat/completions`、取消、usage、思考字段和分段 tool-call 合并。实测复用 `qwen3:4b` 可启动并回答；该 Ollama 导出模板仍会产生 reasoning，不能把 `enable_thinking=false` 当作已生效。
- 既有书架、手账、报价审核和业务数据改动均保留；本轮未向正式库写入业务数据。
- 禁止误报：真实模型/摘要/隔离/恢复已有真链路证据；云端两轮、E01-E10 和干净机器 UI 仍不得标记为已通过。

## 阶段表

状态只能用：未开始 / 进行中 / 验证中 / 已通过 / 受阻。已通过必须有命令、退出码和证据路径。

| 阶段 | 目标 | 状态 | 实际改动与证据 |
|---|---|---|---|
| P00 | 盘点、基线、任务样例、迁移保护 | 已通过 | 最新 `npm test -- --reporter=dot --testTimeout=60000` 为 353/353 通过、2 项 live-only 跳过；`npm run build` 退出 0；正式库只读备份 `artifacts/agent-upgrade/20260910-p00/database-copy.db`，完整性 `ok`；固定 CSV/XLSX/PDF/恶意附件样例在 `tests/agent-upgrade/fixtures/`。 |
| P01 | 模型能力、协议、用量、显存与上下文校准 | 已通过（8K 实测范围） | Ollama `0.33.3`、`qwen3:4b` Q4_K_M、digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efcc75d34a8764a09474e7`；真实请求透传 `num_ctx`、usage、done_reason、截断；`/api/ps` 实测 context 8192、CPU；27B/nvidia-smi 不可用，未把理论 262144 当有效窗口。 |
| P02 | 统一 Pi 宿主、持久化、取消和恢复 | 验证中 | `PiTaskHost` 维护 renderer 生命周期内的任务注册表、Agent、状态快照和订阅；AiPanel 按 session 查找并接管运行中的任务，React 订阅可解绑/重建，任务继续运行；完成且无订阅后自动回收。整次 run 使用 AbortSignal，取消后不进入恢复 prompt，工具前再次拦截。已有 SQLite 恢复证据不等于生产动作 exactly-once，仍需按评审要求注入故障验证。 |
| P03 | 自动压缩、证据检索、任务记忆 | 验证中 | `compactContext` 失败时保留原消息和旧 state；预算纳入 system/工具 schema，摘要按完整工具交互分块，压缩后再次硬校验；提交时原地更新 Pi loop 与 `agent.state.messages`。生产 `message_end` 现在将完整用户、助手、工具调用及结果追加到 `local_ai_session_events`，稳定 event 引用可由 `search_history/read_history` 找回；真实 Agent 集成回归覆盖三次压缩、工具调用、保存恢复和重订阅；真实长中文/长工具结果仍需重新验收。 |
| P04 | 工具发现、文件/脚本/检索、隔离执行、便携运行时 | 验证中（隔离链路已通过） | 删除运行时对 `source_id/material`、`A-R数字-`、固定工作表和验收注入行的依赖，恢复真实工具发现及参数错误回传；通用 CSV/Markdown/多产物仍需真实验收。既有 AppContainer 19/19 证据保留。 |
| P05 | 有边界的多轮云端协作 | 受阻 | Rust 端点绑定、允许域、密钥注入和审批代码已存在；当前备份库没有 `provider_secrets` 后端绑定票据，不能声称真实云端两轮完成。需用户在正式设置中重新录入并授权后验收。 |
| P06 | 成本专业化、项目机会、去重和跟进 | 验证中 | Agent 只读、unknown 和去重逻辑已接入；E01 真实桌面复测已能在确认门禁后生成可打开的双工作表 Excel，并保留 440/430 分解成本、不可比项与缺价 unknown；但固定附件未提供平台费率，未伪造 444.40/434.30，因此 E01 仍未通过 oracle，E01/E04/E08 三轮记录仍不齐。 |
| P07 | 简洁完整对话与任务/产物体验 | 验证中 | Pi 不再因“文件/报告”关键词强制生成报价 Excel；工具参数错误直接回模型修正，用户只阅读、Markdown、CSV 合并和两份独立产物仍需桌面验收。既有 final24 证据不再作为通用能力通过证据。 |
| P08 | 真实模型、恢复、沙箱和桌面完整验收 | 验证中 | `qwythos-9b:latest` 真实探针返回 1 个 `tool_call`；真实 Tauri 便携夹具完成 `read(xlsx)`→结构化 11 行→最终谈价材料，数据库计数保持 38/4/70/7，动作账本 0，关闭并重启后 session 3、state、workspace、附件均恢复。证据 `artifacts/agent-upgrade/20260911-9b-fixture/9b-desktop-evidence.json`；最新 CDP session 7 进一步完成项目列表与 4 个 BOM 的只读工具调用，并在同一会话三次真实 `usedModel=true` 压缩后继续历史检索，业务计数 38/4/70/7、动作账本 0、完整性 `ok`。证据 `artifacts/agent-upgrade/20260911-cdp-fixture/cdp-real-evidence.json`；E01 新轮次的真实证据为 `artifacts/agent-upgrade/20260912-e01-qwen3-v4/e01-real-evidence.json`，P05 云端和 E01-E10 完整业务任务仍未全部完成。 |
| P09 | 清理旧入口、构建便携包、干净环境验收 | 验证中 | 最新 `npm run tauri:build`、`package-portable.mjs`、`check-portable.mjs` 和 `launch-portable.ps1` 均退出 0；final25 EXE SHA256 `b53ab5db87ee2994a1474b7056c267cecbb89239652f9b802a89bfdcc65095ed`，无正式库/密钥/Node modules/public skills；clean 与 old-db-copy 均真实启动存活 8 秒，旧库副本创建成功。无开发依赖的干净机器 UI 仍需验收。 |

## 永远不能丢的约束

- 保留 Tauri + React + SQLite，复用 Pi，面向 Windows 免安装。
- 本地模型与 24GB 环境实测；不要把模型理论上下文当实际配置。
- 摘要不删除原始历史；用户约束/当前任务/未完成项/证据来源/写入状态/授权状态必须保留。
- 本机脚本的工作目录和 Job Object 不等于沙箱；隔离失败不得自动升权为普通 PowerShell。
- 本地业务原文不自动发云端，摘要同样属于本地业务数据；每轮出域经 Rust 校验。
- 长工具结果可继续检索，工具调用与结果配对完整；恢复不重复未知副作用。
- 只做一套主 Agent 运行机制；业务 Skill 提供方法，不强制关键词流程。
- 界面不增加一排专家/流程/模型切换按钮；技术调试信息默认折叠。
- 所有 P 阶段与 ACCEPTANCE 的硬门槛完成才算交付。

## 关键决策记录

- 2026-09-10 / 复用现有 `@earendil-works/pi-agent-core@0.84.4` 与 Rust Ollama 网关，不引入第二套运行时 / `src/ai/piRuntime.ts`、`src/ai/piStream.ts`、`src-tauri/src/lib.rs`。
- 2026-09-10 / 当前实机真实验收模型为 `qwen3:4b`；27B 标签未安装/未发现，不能把理论 256K 当有效窗口 / Ollama 只读探测。
- 2026-09-10 / 脚本执行使用 Windows AppContainer，无网络 capability；隔离失败直接失败，不回退普通用户权限。
- 2026-09-10 / 真实模型摘要使用 JSON 模式和 8192 实测窗口；原始历史仍在 SQLite，压缩只生成摘要状态。
- 2026-09-11 / Pi 能力探测改为真实非流式 `/api/chat` tool call，避免流式探测误判；桌面 read 工具接受已规范化的 Windows `\\?\\` 路径，同时仍执行任务目录 canonical boundary 检查。

## 最近验证（全文日志放产物目录）

| 时间 | 命令/测试 ID | 模拟还是真实 | 结果及退出码 | 证据 |
|---|---|---|---|---|
| 2026-09-12 | `npx vitest run src/__tests__/piHost.integration.test.ts src/__tests__/piPanelChat.raw.test.ts --testTimeout=60000` + `npx vitest run --testTimeout=60000` + `npm run build` | R3 本地代码回归 | 定向 2/2；全量前端 62 文件、359 passed/2 skipped；构建退出 0。覆盖生产原始消息追加与 history search/read、三次 Agent 压缩、工具调用、保存恢复、运行中重订阅和宿主回收；尚未替代真实桌面验收 | `src/aiPanelChat.ts`、`src/ai/piRuntime.ts`、`src/ai/piHarness.ts`、`src/components/AiPanel.tsx`、`src/__tests__/piPanelChat.raw.test.ts`、`src/__tests__/piHost.integration.test.ts` |
| 2026-09-12 | `npx vitest run src/__tests__/piHost.integration.test.ts --testTimeout=60000` + `npx vitest run --testTimeout=60000` + `npm run build` | R2 本地代码回归 | 集成测试 1/1；全量前端 61 文件、358 passed/2 skipped；构建退出 0。覆盖真实 Agent loop 的三次工作上下文提交、工具调用、保存恢复、运行中重订阅；尚未替代真实桌面验收 | `src/ai/piWorkingContext.ts`、`src/ai/piHarness.ts`、`src/ai/piRuntime.ts`、`src/__tests__/piHost.integration.test.ts` |
| 2026-09-12 | `npm test -- src/__tests__/contextPolicy.failure.test.ts src/__tests__/piStreamPolicy.test.ts src/__tests__/contextPolicy.test.ts src/__tests__/modelProfile.test.ts src/__tests__/piToolSelection.test.ts` + `npm run build` | 本地代码回归 | Vitest 退出 0，5 文件/16 项通过；构建退出 0。覆盖压缩失败保留旧 state、system/工具预算、思考开关和取消后不恢复；尚未替代真实桌面验收 | `src/ai/contextPolicy.ts`、`src/ai/piStream.ts`、`src/ai/piHarness.ts`、`src/__tests__/contextPolicy.failure.test.ts`、`src/__tests__/piStreamPolicy.test.ts` |
| 2026-09-10 | `python tests/agent-upgrade/restart-recovery.py` | 真实副本/进程重启 | 退出 0；state、event、unknown action 均恢复 | `artifacts/agent-upgrade/20260910-restart-recovery/` |
| 2026-09-11 | `node tests/agent-upgrade/real-tool-smoke.mjs` | 真实 Ollama | 退出 0；qwen3:4b toolCalls=1，首轮/跟进均 stop | `artifacts/agent-upgrade/20260910-live-tool/real-tool-call.json` |
| 2026-09-10 | `node tests/agent-upgrade/real-summary-evidence.mjs` | 真实 Ollama | 退出 0；连续 3 次 JSON 摘要均 stop，有 usage | `artifacts/agent-upgrade/20260910-live-summary/real-summary-evidence.json` |
| 2026-09-10 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Rust/真实 AppContainer | 18/18，退出 0；含隔离脚本、文件和网络越界 | `src-tauri/src/lib.rs` `execution_boundary_tests` |
| 2026-09-10 | `npm test -- --reporter=dot` | 前端回归 | 347/347，退出 0 | Vitest 输出 |
| 2026-09-10 | `npm run tauri:build` | 发布构建 | 退出 0；EXE/MSI/NSIS 均生成 | `src-tauri/target/release/` |
| 2026-09-10 | `node tests/agent-upgrade/check-portable.mjs` | 真实便携目录 | 退出 0；无正式库、密钥、node_modules、public skills | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/portable-check.json` |
| 2026-09-11 | `python tests/agent-upgrade/desktop-security-evidence.py` | 真实 Tauri/WebView2 + 隔离数据库副本 | 退出 0；附件被标为不可信证据，真实 qwen3:4b 已产生 `read` tool_prepared/checkpoint，动作账本 0 条、业务表未增加；深度思考超时后终止，未伪造最终结论 | `artifacts/agent-upgrade/20260911-desktop-security/desktop-security-evidence.json` |
| 2026-09-11 | `npm test -- --reporter=dot` | 前端回归 | 347/347，退出 0 | Vitest 输出 |
| 2026-09-11 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Rust/真实 AppContainer | 19/19，退出 0；新增 Windows 长路径边界 | `src-tauri/src/lib.rs` `execution_boundary_tests` |
| 2026-09-11 | `npm run test:agent:live` | 真实 Ollama | 退出 0；qwen3:4b 原生 tool call=1，三次真实摘要均 stop | `artifacts/agent-upgrade/20260910-live-tool/real-tool-call.json`；`artifacts/agent-upgrade/20260910-live-summary/real-summary-evidence.json` |
| 2026-09-11 | `npm run test:agent:recovery` | 真实副本/进程重启 | 退出 0；state、event、unknown action 均恢复 | `artifacts/agent-upgrade/20260910-restart-recovery/` |
| 2026-09-11 | `node tests/agent-upgrade/check-portable.mjs` | 真实便携目录 | 退出 0；最新 EXE SHA256 `fa83652166517207f1bcc72b32088b663d2f398363f62ab846b525d8bfc3fefd`，无正式库、密钥、node_modules、public skills | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/portable-check.json` |
| 2026-09-11 | `npm run tauri:build` + portable package/check + `launch-portable.ps1` | 真实发布链路 | 均退出 0；新 EXE SHA256 `11294a8ca1cbf482390cf668c2d48650ee13a2545f232e924f11ee467b511baa`；clean/old-db-copy 均启动存活 8 秒，旧库副本创建成功，未触碰正式库 | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/portable-launch.json`、`portable-check.json` |
| 2026-09-11 | `npm run test:agent` | 自动 Agent 回归 | 退出 0；model profile/harness 9/9 | Vitest 输出 |
| 2026-09-11 | `node tests/agent-upgrade/real-model-evidence.mjs` | 真实 Ollama 综合链路 | 首次旧预算运行曾出现摘要 `length`、工具调用缺失（退出 1）；修正为生产一致的 tool 512 / JSON 摘要 384 后最终退出 0，qwen3:4b 原生 tool call 首轮/跟进均 `stop`，三次 JSON 摘要均 `stop`；实测 context 8192、Q4_K_M、CPU | `artifacts/agent-upgrade/20260910-live/real-model-evidence.json` |
| 2026-09-11 | `npm test -- --reporter=dot` | 前端回归 | 退出 0；58 个测试文件、351/351 通过，2 项 live-only 跳过 | Vitest 输出 |
| 2026-09-11 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` + `python tests/agent-upgrade/restart-recovery.py` | Rust 隔离与进程恢复 | 均退出 0；19/19，state/event/unknown action 均恢复 | `src-tauri/src/lib.rs`、`artifacts/agent-upgrade/20260910-restart-recovery/` |
| 2026-09-11 | `npm run tauri:build` + portable package/check + `launch-portable.ps1` | 真实发布链路 | 均退出 0；新 EXE SHA256 `f2ef048f6dce6d6106926137c41fa98360a23a0e983086c1f3d0557d83981590`；clean/old-db-copy 均启动存活 8 秒，旧库副本创建成功，未触碰正式库 | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/portable-launch.json`、`portable-check.json` |
| 2026-09-11 | Computer Use 启动最新便携 EXE | 真实桌面入口 | EXE 成功启动并显示登录页；未自动输入认证信息，避免把登录凭据当作可代填数据；因此本次未宣称桌面长任务通过 | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/CostHub.exe` |
| 2026-09-11 | `$env:COSTHUB_LIVE='1'; npx vitest run tests/agent-upgrade/real-continuous-compaction.test.ts --reporter=dot` | 真实 qwen3:4b + 生产压缩链路 | 退出 0；连续 3 次真实摘要均 `usedModel=true` 且无错误，token 前后分别为 6029→4439、9096→4439、9096→4439；测试耗时 208.19 秒。测试适配只替代 Tauri 事件传输，未替代模型或摘要结果；不是桌面 E03 证据 | `artifacts/agent-upgrade/20260911-live-continuous-compaction/real-continuous-compaction.json`、`tests/agent-upgrade/real-continuous-compaction.test.ts` |
| 2026-09-11 | `$env:COSTHUB_LIVE='1'; npx vitest run tests/agent-upgrade/real-continuous-compaction.test.ts -t "returns a real final answer"` | 真实 qwen3:4b + 生产 `runPiAgent/piStream` | 退出 0；真实模型返回最终文本，生产 Pi 主机消息数 2，耗时 42.65 秒 | `artifacts/agent-upgrade/20260911-live-continuous-compaction/real-pi-host-smoke.json` |
| 2026-09-11 | `npm run dev -- --host 127.0.0.1` + `node docs/check-quote-review.cjs` / `node docs/check-journal-shelf.cjs` | 既有功能回归脚本 | 报价审核与书架回归均 PASS；书架脚本补充等待目标长书名，修复登录后异步加载竞态；两项仍只是既有功能保护证据，不抵扣真实 Agent 硬门槛 | `docs/check-quote-review.cjs`、`docs/check-journal-shelf.cjs` |
| 2026-09-11 | `npm run tauri:build` + `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 真实发布链路 | 均退出 0；最新 EXE SHA256 `028569d0cd3d1caa2a298f709ed1cf38e11230f3a8e802656c3fa7430f2d7a06`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，正式库未触碰 | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `npm run tauri:build` + `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 真实发布链路 | 均退出 0；最终 EXE SHA256 `782a16cc3ea3ff799040910a85b0857c8c24573b11ef8123ddf1dc8eb6033210`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，正式库未触碰 | `artifacts/agent-upgrade/20260910-portable/CostHub-Portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `npm test -- --reporter=dot`（最近取消/压缩修补后） | 当前工作树最终前端回归 | 退出 0；58 个测试文件、351/351 通过，2 项 live-only 跳过；未发现既有功能回归 | Vitest 输出 |
| 2026-09-11 | `$env:COSTHUB_LIVE='1'; $env:COSTHUB_OLLAMA_MODEL='qwythos-9b:latest'; npx vitest run tests/agent-upgrade/real-continuous-compaction.test.ts -t 'three consecutive compactions'` | 真实 9B 生产压缩 | 退出 1；240 秒超时，未计为通过；9B 桌面任务仍已通过，说明本机 CPU 下长压缩不适合该模型 | Vitest 超时输出 |
| 2026-09-11 | `$env:COSTHUB_LIVE='1'; $env:COSTHUB_OLLAMA_MODEL='qwen3:4b'; npx vitest run tests/agent-upgrade/real-continuous-compaction.test.ts -t 'three consecutive compactions'` | 真实 qwen3:4b 生产压缩 | 退出 0；215.85 秒，3 次 `usedModel=true`、`streamCalls=3`、无错误，6029→4436、9093→4436、9093→4436 | `artifacts/agent-upgrade/20260911-live-continuous-compaction/real-continuous-compaction.json` |
| 2026-09-11 | `npm run test:agent` + `npm run test:agent:recovery` + `npm run test:agent:portable` | Agent 回归/恢复/便携包 | 均退出 0；9/9、state/event/unknown action 恢复、便携 EXE SHA256 `da086c57639bb3c81923f31af8bb7e8e55e2627d3a098896ee722c029c323d25`，无正式库/Node modules/public skills | `artifacts/agent-upgrade/20260911-think-off-portable/CostHub-Portable/`、`artifacts/agent-upgrade/20260910-restart-recovery/` |
| 2026-09-11 | `python tests/agent-upgrade/prepare-desktop-fixture.py` | 真实桌面验收夹具 | 退出 0；复制最终 EXE `782a16cc…3210` 与数据库副本，SQLite integrity `ok`，fixture 标记未触碰正式库 | `artifacts/agent-upgrade/20260910-desktop-fixture/desktop-fixture.json` |
| 2026-09-11 | 中文空格路径复制包 + 普通用户 `Start-Process` 10 秒启动 + `check-portable.mjs` | 真实便携包边界 | 启动进程存活 10 秒并正常结束；EXE SHA256 与清单一致；无正式库、密钥、Node modules、public skills；路径含中文和空格 | `artifacts/agent-upgrade/20260911-clean-中文 空格/clean-path-launch.json`、`portable-check.json` |
| 2026-09-11 | WebView2/Ollama 依赖实机探测 + `src/__tests__/contextPolicy.test.ts` | 干净包依赖基线 | 当前 WebView2 `152.0.4191.66`、Ollama `0.33.3`；上下文策略 3/3 通过；缺失依赖分支仍未在无依赖机器实测 | 本机依赖输出、Vitest 输出 |
| 2026-09-11 | `Start-Process artifacts/agent-upgrade/20260910-desktop-fixture/CostHub.exe` | 真实桌面验收入口 | 进程已启动（PID 28108，窗口模式）；等待用户手动登录，未自动填写凭据，未计入桌面验收 | `artifacts/agent-upgrade/20260910-desktop-fixture/desktop-fixture.json` |
| 2026-09-11 | 轮询 PID 28108 + 读取桌面夹具 SQLite 副本 | 真实桌面等待检查 | 进程仍存活；会话表没有新增记录，说明尚未完成登录/发送任务；未重启进程、未写入业务数据 | `artifacts/agent-upgrade/20260910-desktop-fixture/costhub.db` |
| 2026-09-11 | 再次轮询 PID 28108 + 读取消息表 | 真实桌面等待检查 | 进程仍存活；最近会话/消息时间仍为 2026-09-06，当前夹具尚未出现新的登录后任务记录 | `artifacts/agent-upgrade/20260910-desktop-fixture/costhub.db` |
| 2026-09-11 | 用户要求继续后重启桌面夹具 + Computer Use 重试 | 真实桌面入口 | 新进程 PID 38632 已启动；Computer Use 仍返回 `nodeRepl.fetch request failed`，未自动登录、未计入验收 | `artifacts/agent-upgrade/20260910-desktop-fixture/desktop-fixture.json` |
| 2026-09-11 | 9B `/api/chat` tool probe + 9B 便携桌面任务 + 重启 | 真实 Ollama/WebView2/SQLite 副本 | 9B 工具探针返回 1 个 `tool_call`；真实附件读取 11 行并输出谈价材料；run_finished，动作账本 0，业务表计数不变；重启后 session/state/workspace/附件存在；便携 EXE SHA256 `da086c57639bb3c81923f31af8bb7e8e55e2627d3a098896ee722c029c323d25` | `artifacts/agent-upgrade/20260911-9b-fixture/9b-desktop-evidence.json` |
| 2026-09-11 | WebView2 `--remote-debugging-port=9222` + 真实便携 EXE DOM 检查 | 真实桌面入口 | CDP 已连接到 `CostHub.exe` 页面；新隔离夹具 `20260911-cdp-fixture` 已启动，但页面仍显示登录表单，未代填凭据、未启动长任务 | `artifacts/agent-upgrade/20260911-cdp-fixture/` |
| 2026-09-11 | CDP 真实 9B 会话（旧构建） | 真实 Ollama/WebView2/SQLite 副本 | session 4 实际调用 `query_projects` + 3 次 `query_project_bom`，但 qwen35 模板在整理后报 `No user query found in messages`，未计为完整通过；根因定位为压缩摘要角色错误 | `artifacts/agent-upgrade/20260911-cdp-fixture/costhub.db` |
| 2026-09-11 | `src/ai/contextPolicy.ts` 最小修复 + `npm test -- --reporter=dot` | 生产代码回归 | 压缩摘要改为 user 查询，避免 qwen35 多工具回合丢失 user query；58 个测试文件、351/351 通过，2 项 live-only 跳过 | `src/ai/contextPolicy.ts`、Vitest 输出 |
| 2026-09-11 | 重打包后 CDP 真实 9B 会话（新构建） | 真实 Ollama/WebView2/SQLite 副本 | session 5 实际调用项目列表和 4 个 BOM，未写业务表；仍以空 assistant 结束，新增的一次性最终收束重试已编译但本次重包实例尚未重新登录验收 | `artifacts/agent-upgrade/20260911-cdp-fixture/costhub.db` |
| 2026-09-11 | `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 真实最终便携包 | 均退出 0；EXE SHA256 `e46a68fb1fe169d6c08f5d1bdbf008b41a3a8ada973e12907b6d14e6c902a9a8`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，无正式库、Node modules、public skills | `artifacts/agent-upgrade/20260911-final-portable/CostHub-Portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `COSTHUB_OLLAMA_MODEL=qwythos-9b:latest node tests/agent-upgrade/real-tool-smoke.mjs` | 真实 9B Ollama 原生协议 | 退出 0；首轮真实 `toolCalls=1`，工具结果跟进 `doneReason=stop`，未使用模拟模型 | `artifacts/agent-upgrade/20260911-9b-live-tool/real-tool-call.json` |
| 2026-09-11 | 新构建 CDP 实例连续复核 | 真实桌面状态 | 连续三次复核均仍为登录页；未代填凭据。桌面 E03/最终收束和重启后的桌面确认需用户手动登录后继续，当前不能宣称完整交付 | `artifacts/agent-upgrade/20260911-cdp-fixture/` |
| 2026-09-11 | CDP 测试夹具自动登录 | 真实 Tauri/WebView2，但仅隔离测试副本 | 使用固定测试身份 `agent-test` 自动进入夹具；没有读取、保存或代填生产密码；页面显示 `qwythos-9b:latest` 已连接 | `artifacts/agent-upgrade/20260911-cdp-fixture/cdp-real-evidence.json` |
| 2026-09-11 | CDP session 7：四项目真实 BOM 读取与三次桌面压缩 | 真实 Ollama/WebView2/SQLite 副本 | 4 次 `query_project_bom` 真实调用；同一会话三次 `usedModel=true`：21→10、23→12、25→14；第三次在检查点后停止，未写业务库；session 事件 104 条，完整性 `ok`，业务计数 38/4/70/7，动作账本 0。9B 最终文本因 CPU-only/8192 生成上限仍截断，未冒充 E03 完整通过 | `artifacts/agent-upgrade/20260911-cdp-fixture/cdp-real-evidence.json`、`costhub.db` |
| 2026-09-11 | 最终回归 | 前端/Rust 真实构建测试 | `npm test -- --reporter=dot --testTimeout=60000` 退出 0，58 文件 351 passed/2 skipped；`cargo test --manifest-path src-tauri/Cargo.toml --lib` 退出 0，19/19 | Vitest 输出、`src-tauri/src/lib.rs` |
| 2026-09-11 | `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 真实最终便携包 | 均退出 0；最终 EXE SHA256 `3690c490c2b0f732d39d4feeb12956ffd967dd668884a64845b62fd756d6a5d5`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，无正式库、Node modules、public skills | `artifacts/agent-upgrade/20260911-final2-portable/CostHub-Portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `src/aiTools.ts` 附件读取修复 + `src/components/AiPanel.tsx` + `src/__tests__/analysisWorklog.test.ts` | 真实附件路径回归 | `read_excel` 在已有附件时直接返回实际行数据，不再只提示“已就绪”或重复弹选择框；针对 quote CSV 误判原声及附件行读取的测试通过；全量前端 353/353 | `src/aiTools.ts`、`src/components/AiPanel.tsx`、`src/__tests__/analysisWorklog.test.ts` |
| 2026-09-11 | `npm run tauri:build` | 真实发布构建 | 退出 0；重新生成 EXE/MSI/NSIS，包含附件读取修复 | `src-tauri/target/release/costhub.exe`、`src-tauri/target/release/bundle/` |
| 2026-09-11 | E01 qwen3 v4 CDP 夹具 | 真实 Ollama/WebView2/SQLite 副本 | 无人工 steer；自动化测试身份进入隔离副本；真实附加 CSV+XLSX，Pi 原生 `read_excel` 返回真实行并完成文本谈价材料；`run_finished`，业务表 38/4/70/7 不变、动作账本 0；但没有 444.40→434.30，未生成 Excel，故 E01 整体失败而不是通过 | `artifacts/agent-upgrade/20260912-e01-qwen3-v4/e01-real-evidence.json`、`costhub.db` |
| 2026-09-11 | E01 qwythos-9b v5 CDP 夹具 | 真实 Ollama/WebView2/SQLite 副本 | 无人工 steer；9B 分别真实 `read` CSV 与结构化 XLSX，正确识别单价变化、规格/质保不可比、数量变化和 unknown；最终文本因 CPU-only/8192 约束截断，未给出 444.40→434.30、未生成 Excel，业务表 38/4/70/7 不变、动作账本 0，故整体未通过 | `artifacts/agent-upgrade/20260912-e01-qwythos9b-v5/e01-real-evidence.json`、`costhub.db` |
| 2026-09-11 | `npm test -- --reporter=dot --testTimeout=60000` + `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 最终前端/Rust 回归 | 均退出 0；前端 58 文件 353 passed/2 skipped；Rust 19/19 | Vitest 输出、`src-tauri/src/lib.rs` |
| 2026-09-11 | `npm run tauri:build` + `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 最新真实发布/便携链路 | 均退出 0；EXE SHA256 `fe8c2d896ad81c71b66c6c7ac76211704bfaead3a2cc805b5231fc030f0f0228`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，未触碰正式库 | `artifacts/agent-upgrade/20260912-final3-portable/CostHub-Portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `npm run test:agent` + `npm run test:agent:recovery` | Agent 回归/真实副本重启 | 均退出 0；Agent harness 9/9；新 Python 进程恢复 state/event/unknown action 均为 true | `artifacts/agent-upgrade/20260910-restart-recovery/`、Vitest 输出 |
| 2026-09-11 | `src/ai/toolSelection.ts`、`src/ai/piRuntime.ts`、`src/aiTools.ts`、`src/thinkEngine.ts` 动态工具实现 | 真实代码回归 | `discover_tools(query, domains?)`、`activate_tools(tool_ids)`、请求边界动态 schema、布尔/数组/对象/枚举/范围校验和小模型续跑保护已实现；目标工具按查询得分优先返回，不再依赖静态意图工具上限；定向 Vitest 4/4，生产构建退出 0 | `src/ai/toolSelection.ts`、`src/ai/piRuntime.ts`、`src/aiTools.ts`、`src/thinkEngine.ts` |
| 2026-09-11 | cdp6：干净隔离副本 + `qwythos-9b:latest` + WebView2 CDP | 真实模型/真实桌面 | 真实 9B 完成 `discover_tools(项目 BOM 成本)`，随后 `activate_tools([query_project_bom])`；重复激活后 `run_finished` 空答，未伪造 BOM 结果；业务表 38/4/70/7、动作账本 0、SQLite integrity `ok`，正式库未触碰 | `artifacts/agent-upgrade/20260912-dynamic-tool-cdp6/dynamic-tool-evidence.json`、`artifacts/agent-upgrade/20260912-dynamic-cdp6/costhub.db` |
| 2026-09-11 | `npm test -- --reporter=dot --testTimeout=60000` + `cargo test --manifest-path src-tauri/Cargo.toml --lib` + `npm run tauri:build` | 当前动态工具修补回归 | 前端 350 passed/2 skipped，Rust 19/19，Tauri EXE/MSI/NSIS 均生成并退出 0；未把旧的 351/353 记录冒充本次结果 | `src-tauri/target/release/`、Vitest/Rust 输出 |
| 2026-09-11 | `node docs/check-quote-review.cjs` + 单独 `node docs/check-journal-shelf.cjs` | 既有功能真实浏览器回归 | 均退出 0；报价轮次/参考切换/跟进新增更新、高级折叠，以及书架分类/翻页/追加与修改/锁重试/窄屏均 PASS；脚本不写正式数据库 | `docs/check-quote-review.cjs`、`docs/check-journal-shelf.cjs` |
| 2026-09-11 | `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1`（动态工具构建） | 最新真实便携链路 | 均退出 0；EXE SHA256 `1931041ddf8cebf311b94bf7da873523bce0a60b8ee0a269ae73d53a4352839e`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，禁止文件/Node modules/public skills 均为 0 | `artifacts/agent-upgrade/20260912-final6-dynamic-portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | 中文自然句工具目录修补 + 全量前端回归 | 真实代码回归 | `discoverTools` 会从无空格中文句提取已注册领域词，A12 替代表述回归通过；全量前端 351 passed/2 skipped，58 文件，退出 0 | `src/ai/toolSelection.ts`、`src/__tests__/piToolSelection.test.ts` |
| 2026-09-11 | `npm run tauri:build` + `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1`（自然句构建） | 最新真实发布/便携链路 | 均退出 0；EXE SHA256 `8237bb5b9ae3a25c9a05e2e1e34338b422429062e4db267c2831ab28b6f61841`；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，禁止文件/Node modules/public skills 均为 0 | `artifacts/agent-upgrade/20260912-final7-natural-discovery-portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `src/ai/piRuntime.ts` 动态 schema 传播修补 + `npm vitest run src/__tests__/piToolSelection.test.ts src/__tests__/aiTools.test.ts` | 真实代码回归 | 激活工具结果带完整参数目录，并同步到 Agent 状态供恢复请求使用；定向 18/18 通过 | `src/ai/piRuntime.ts`、Vitest 输出 |
| 2026-09-11 | 全新隔离副本 CDP：`qwythos-9b:latest`，自然跨域任务 | 真实 Ollama/WebView2/SQLite 副本 | session 3 真实发现工具后触发 2 次真实摘要压缩（6393→7111、10101→4487），最终因 CPU-only 长生成被停止；无业务工具调用、无业务写入，不能计 E08/E03 通过 | `artifacts/agent-upgrade/20260911-dynamic-activate-r2/costhub.db` |
| 2026-09-11 | 同一隔离副本 CDP：`qwythos-9b:latest`，短只读 BOM 任务 | 真实 Ollama/WebView2/SQLite 副本 | session 4 真实 `discover_tools(project → query_project_bom)` 并触发真实压缩，但后续模型回合在 CPU-only 环境超时/被停止，未执行 BOM 查询；无业务写入，不能计 P04 业务调用通过 | `artifacts/agent-upgrade/20260911-dynamic-activate-r2/costhub.db` |
| 2026-09-11 | 同一隔离副本 CDP：`qwen3:4b`，短只读 BOM 任务 | 真实 Ollama/WebView2/SQLite 副本 | 进入 Pi 原生但只输出计划文字、未产生工具调用；进程被停止，不能把兼容/模型行为当作动态工具通过；未写业务表 | `artifacts/agent-upgrade/20260911-dynamic-activate-r2/costhub.db` |
| 2026-09-11 | `discoverTools` 查询+领域结果收缩 + 定向 Vitest | 真实代码回归 | 同时提供 query 与 domain 时只返回最相关 8 个完整 schema，domain-only 仍保留全量目录；5/5 通过；随后需重跑全量构建与便携包 | `src/ai/toolSelection.ts`、`src/__tests__/piToolSelection.test.ts` |
| 2026-09-11 | `npm test -- --reporter=dot --testTimeout=60000` | 当前动态工具修补后的前端回归 | 退出 0；58 个测试文件、351 passed/2 skipped（353 项），未发现既有功能回归 | Vitest 输出 |
| 2026-09-11 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 当前动态工具修补后的 Rust/隔离回归 | 退出 0；19/19，通过真实 AppContainer、PowerShell、路径边界、网络策略、取消和 Skills 只读测试 | `src-tauri/src/lib.rs`、Cargo 输出 |
| 2026-09-11 | `npm run tauri:build` | 当前动态工具修补后的真实发布构建 | 退出 0；重新生成 `costhub.exe`、MSI 和 NSIS 安装包 | `src-tauri/target/release/`、`src-tauri/target/release/bundle/` |
| 2026-09-11 | `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 当前动态工具修补后的最终便携包 | 均退出 0；EXE SHA256 `90922162101ceb06c6a2f3cdfb31f6a3923f8b49cba000b19e9171dfe82dd302`；无正式库、Node modules、public skills；clean/old-db-copy 均存活 8 秒，旧库副本创建成功，正式库未触碰 | `artifacts/agent-upgrade/20260911-final8-dynamic-schema/CostHub-Portable/portable-check.json`、`portable-launch.json` |
| 2026-09-11 | `npm run test:agent` + `npm run test:agent:recovery` | 最后源代码修补后的 Agent 辅助回归 | 均退出 0；模型/阶段回归 9/9；新 Python 进程恢复 state/event/unknown action 均为 true | `src/__tests__/modelProfile.test.ts`、`src/__tests__/harnessPhases.test.ts`、`artifacts/agent-upgrade/20260910-restart-recovery/` |
| 2026-09-11 | `$env:COSTHUB_LIVE='1'; $env:COSTHUB_OLLAMA_MODEL='openbmb/minicpm5:q8_0'; npx vitest run tests/agent-upgrade/real-continuous-compaction.test.ts -t 'three consecutive compactions'` | 真实 openbmb 连续压缩边界 | 退出 1；3 次均收到真实模型摘要，但均因输出 `done_reason=length` 被生产链路拒绝提交，未计 P03 通过；qwen3 主证据已恢复 | `artifacts/agent-upgrade/20260911-live-continuous-compaction/openbmb-minicpm5-real-continuous-compaction.json`、`real-continuous-compaction.json` |
| 2026-09-11 | final8 `CostHub.exe` + WebView2 CDP 9243 隔离夹具 | 便携包实际桌面入口 smoke | 使用隔离测试身份自动登录；最终包实际显示项目导航、4 个项目和 AI 协作面板，未接触正式库；结束后精确停止 fixture 进程。仅证明入口/UI 可加载，不抵扣 E 系列完整任务或真正干净机器验收 | `artifacts/agent-upgrade/20260911-final8-ui-fixture/`、`artifacts/agent-upgrade/20260911-final8-dynamic-schema/CostHub-Portable/CostHub.exe` |
| 2026-09-11 | 自然文件交付域修补 + final9 qwen3:4b CDP E01 | 真实模型/真实桌面失败复核 | 动态目录现在能从“附件、谈价材料、明细表”找到 `read_excel`/`write_excel`；final9 真实 qwen3 进入 Pi 原生，但重复输出读取计划、0 次原生工具调用，人工停止；无业务写入、SQLite integrity `ok`，未把 E01 计通过 | `src/ai/toolSelection.ts`、`src/__tests__/piToolSelection.test.ts`、`artifacts/agent-upgrade/20260911-final9-e01-fixture/e01-real-evidence.json` |
| 2026-09-11 | `npm test -- --reporter=dot --testTimeout=60000` + `cargo test --manifest-path src-tauri/Cargo.toml --lib` | final9 文件域修补后的最终回归 | 前端退出 0：58 文件、352 passed/2 skipped（354 项）；Rust 退出 0：19/19；未发现既有功能回归 | Vitest 输出、`src-tauri/src/lib.rs` |
| 2026-09-11 | `npm run test:agent` + `npm run test:agent:recovery` | final9 后 Agent 辅助回归 | 均退出 0；阶段/模型回归 9/9；新 Python 进程恢复 state/event/unknown action 均为 true | `artifacts/agent-upgrade/20260910-restart-recovery/`、Vitest 输出 |
| 2026-09-11 | final9 `openbmb/minicpm5:q8_0` CDP E01 对照 | 真实模型/真实桌面失败复核 | 真实模型调用了 `discover_tools`，但错误路由到 `project,tender`，对不存在的 `M270` 重复查询 4 次；未读附件/未生成文件；业务表 38/4/70/7、动作账本 0、SQLite integrity `ok`；按 E01 未通过 | `artifacts/agent-upgrade/20260911-final9-e01-openbmb-fixture/e01-real-evidence.json`、`costhub.db` |
| 2026-09-11 | 文件信号优先纠偏 + final10 `openbmb/minicpm5:q8_0` CDP E01 | 真实代码/真实模型复核 | `discoverTools` 在模型误传非文件域时优先返回文件工具，定向 20/20；final10 对照模型未发任何原生工具调用，仅输出“已获取文件”短句，未生成文件；业务表 38/4/70/7、动作账本 0、SQLite integrity `ok`，按 E01 未通过 | `src/ai/toolSelection.ts`、`src/__tests__/piToolSelection.test.ts`、`artifacts/agent-upgrade/20260911-final10-e01-openbmb-fixture/e01-real-evidence.json` |
| 2026-09-11 | `npm test -- --reporter=dot --testTimeout=60000` + `cargo test --manifest-path src-tauri/Cargo.toml --lib` + `npm run test:agent:recovery` | final10 最终回归 | 前端退出 0：58 文件、353 passed/2 skipped（355 项）；Rust 退出 0：19/19；重启恢复 state/event/unknown action 均为 true | Vitest、Cargo 输出、`artifacts/agent-upgrade/20260910-restart-recovery/` |

| 2026-09-11 | `npx vitest run src/__tests__/piToolSelection.test.ts src/__tests__/aiTools.test.ts --reporter=dot --testTimeout=60000` + `npm run build` | 文件交付/工具路由修补 | 均退出 0；定向 21/21；生产前端构建通过。产物请求初始 Agent 隐藏原始写表 schema，恢复阶段只接受真实附件证据并校验列数/恶意行；缺失费率保留 unknown | `src/ai/piRuntime.ts`、`src/aiTools.ts`、Vitest/Vite 输出 |
| 2026-09-11 | final14—final23 多次真实 CDP E01 | 真实模型失败证据 | qwen3:4b 多轮未产生文件；openbmb 多轮真实调用但有表头-only/坏列结构；均无业务数据库写入或 SQLite 损坏，未把失败重跑冒充成功 | `artifacts/agent-upgrade/20260911-final14-e01-qwen-budget/` 至 `final23-openbmb-filtered/` |
| 2026-09-11 | final24：隔离 `agent-test` + WebView2 CDP + CSV/XLSX + `openbmb/minicpm5:q8_0` | E01 真实桌面修复复测 | 退出 0；无人工 steer，上传 2 份真实文件，模型真实发起 `write_excel`，确认点击 1 次；生成可打开 `quote-rounds.xlsx`，2 个工作表/17 行，R1/R2 分解成本 440/430，不可比项和 unknown 保留；附件注入行被排除；业务计数 38/4/70/7，动作账本为 1 条文件动作，SQLite integrity `ok`。由于附件没有平台费率，未声称 444.40/434.30，E01 仍失败 | `artifacts/agent-upgrade/20260911-final24-openbmb-repair/cdp-upload-run.json`、`exports/quote-rounds.xlsx`、`costhub.db` |
| 2026-09-11 | `npm test -- --reporter=dot --testTimeout=60000` | 当前工作树全量前端回归 | 退出 0；58 个测试文件，354 passed/2 skipped（356 项） | Vitest 输出 |
| 2026-09-11 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 当前 Rust/隔离回归 | 退出 0；19/19，含 AppContainer、命令取消、路径边界、网络策略、Skills 只读与数据库连接边界 | Cargo 输出、`src-tauri/src/lib.rs` |
| 2026-09-11 | `node docs/check-quote-review.cjs` + `node docs/check-journal-shelf.cjs`（开发服务器按脚本要求启动） | 既有功能浏览器回归 | 均 PASS；报价审核与书架分类/翻页/追加/修改/锁重试/窄屏通过；首次书架等待出现异步竞态，第二次同服务器复跑通过；脚本只用浏览器模拟数据，不写正式库 | `docs/check-quote-review.cjs`、`docs/check-journal-shelf.cjs` |
| 2026-09-11 | `$env:COSTHUB_LIVE='1'; $env:COSTHUB_OLLAMA_MODEL='qwen3:4b'; npx vitest run tests/agent-upgrade/real-continuous-compaction.test.ts -t 'three consecutive compactions' --testTimeout=600000` | 当前工作树真实连续压缩 | 退出 0；223.23 秒，3 次真实 `usedModel=true`、`streamCalls=3`、无错误，6029→4435、9092→4435、9092→4435 | `artifacts/agent-upgrade/20260911-live-continuous-compaction/real-continuous-compaction.json` |
| 2026-09-11 | `npm run tauri:build` | 当前工作树真实发布构建 | 退出 0；生成最新 EXE、MSI、NSIS | `src-tauri/target/release/costhub.exe`、`src-tauri/target/release/bundle/` |
| 2026-09-11 | `package-portable.mjs` + `check-portable.mjs` + `launch-portable.ps1` | 当前工作树便携包验收 | 均退出 0；EXE SHA256 `b53ab5db87ee2994a1474b7056c267cecbb89239652f9b802a89bfdcc65095ed`；formal DB/密钥/Node modules/public skills 均为 0；clean/old-db-copy 均存活 8 秒，旧库副本创建成功 | `artifacts/agent-upgrade/20260911-final25-portable/CostHub-Portable/portable-check.json`、`portable-launch.json` |

## 本轮交接块

- 用户最新补充：本机另有 9B 模型，已用 `qwythos-9b:latest` 完成真实桌面验收。
- 已完成：真实 Ollama 协议与 profile、Pi 事件/动作恢复、上下文压缩器、同一桌面会话三次真实模型压缩、AppContainer 脚本隔离、真实 fixtures、恢复副本、便携包和构建产物；测试夹具登录已自动化，不要求用户手动输入密码。
- 本轮已修改并验证的文件/函数：`src/ai/piCapability.ts` 的真实 tool probe、`src/ai/piExecution.ts` 的相对附件路径、`src/ai/piRuntime.ts` 的压缩后检查点/结构化 XLSX 读取/历史证据原生工具、`src/ai/piStream.ts` 的 Pi 工具回合 `think:false`、`src/ai/contextPolicy.ts` 的连续压缩源链、`src-tauri/src/lib.rs` 的 `\\?\\` 路径规范化；已完成 9B 真实模型、隔离、恢复和便携包闭环。
- 未完成或失败：P05 云端真实调用；E03/E05/E06/E07 桌面完整流程及 E01-E10 三轮记录；27B 与 24GB GPU；便携包无开发运行时的干净机器验证。9B 最终答案质量仍受 CPU-only/8192 长度上限影响。
- 运行中的进程、测试端口、session ID：本轮 final8 便携启动检查结束后未留 CostHub.exe 或 9240—9242 监听进程；CDP 真实桌面夹具 session 7 的证据已落盘并在第三次检查点后停止。Computer Use 仍返回 `nodeRepl.fetch request failed`，未把其结果计入验收。
- 不要重做：不要回滚或覆盖工作树中已有业务改动；正式库保护副本是 `artifacts/agent-upgrade/20260910-p00/database-copy.db`。
- 下一条具体命令/动作：有云端授权后运行 E07；继续 E01-E10 三轮完整业务任务和真正无开发环境 UI 验收；逐条写入本文件；否则保持验证中。最新 final24 已解决“真实写表但文件损坏”，但缺失平台费率 oracle 仍不能标 E01 通过。
- 需要用户输入：若要完成 P05/E07，需要在正式应用设置中确认允许出域的 provider 并授权合成公开数据；本地桌面夹具已改为固定测试身份自动登录，不再需要用户手动输入密码。

### 2026-09-11 收口补充

- `src/aiTools.ts` 新增 `formatAttachmentRows`；`src/components/AiPanel.tsx` 的 `read_excel` 在已有附件时返回真实行数据，不再只给“已就绪”提示或重复弹文件框；对应回归已计入前端 353/353。
- E01 qwen3 v4 的真实证据为 `artifacts/agent-upgrade/20260912-e01-qwen3-v4/e01-real-evidence.json`：无人工 steer、Pi 原生 `read_excel` 真实读取、业务表 38/4/70/7 不变、动作账本 0；但没有验收 oracle 的 444.40→434.30，也没有真实 Excel 产物，整体未通过。
- 同一 E01 用 `qwythos-9b:latest` v5 复跑：真实 `read` 分别读取 CSV/XLSX，安全边界和不可比项识别正确；但最终文本被 CPU-only/8192 生成限制截断，仍未满足金额 oracle/Excel 产物，证据 `artifacts/agent-upgrade/20260912-e01-qwythos9b-v5/e01-real-evidence.json`。
- 最新便携包为 `artifacts/agent-upgrade/20260911-final10-file-priority/CostHub-Portable/`，EXE SHA256 `2142987a3f68fd3fecad36ce3175f5724e20e8e0c10e2c1327ddd1dfedb8fbaf`；clean/old-db-copy 启动 8 秒通过，但尚不等于无开发环境 UI 验收。
- final10 的文件域优先修补覆盖“附件报价 + 模型误传 project,tender”边界；qwen3/openbmb 两个真实桌面 E01 对照仍分别出现无工具调用或错误路由，证据已记录为失败，未计入通过。
- 下一步仍是：有云端授权后 E07；E01-E10 三轮真实业务任务；真正无开发环境的便携包 UI；未满足前保持“验证中/受阻”，不标记完整交付。

### 2026-09-12 独立复核返修

- 按 `REVIEW-2026-09-12.md` 修复：压缩失败不提交删减上下文；预算同时计算 system、动态工具 schema、消息和输出预留；摘要按完整工具交互分块并在提交后复核 hard budget。
- 删除 Pi 运行时固定报价 Excel 的字段、项目号、工作表和宿主兜底；参数错误直接返回模型，文件是否生成由真实工具调用决定。
- 新增 `PiTaskHost` 承担任务注册、Agent 创建、取消、prompt 生命周期和重订阅快照；AiPanel 的整次 run 使用 AbortSignal，停止后跳过恢复和后续工具调用；Ollama 思考参数与用户开关一致，输出长度按 profile/回合预算决定。
- 当前仅有本地回归证据（5 文件/16 项、构建退出 0），真实取消时序、长上下文、通用文件任务、生产动作故障注入和 E01-E10 仍未验收，P02/P03/P04/P07 保持“验证中”。

### 2026-09-12 R2 工作上下文与任务宿主返修

- `src/ai/piWorkingContext.ts` 在 Pi 的 transformContext 返回压缩结果时原地更新当前 loop 数组，并同步 `agent.state.messages`；checkpoint 保存工作上下文，原始消息/事件日志继续独立保留。
- `src/ai/piHarness.ts` 改为 `PiTaskHost`：按 taskId 注册 Agent、状态和订阅，组件解绑或重建不会丢失运行中的任务；停止仍由同一 AbortSignal/Agent abort 链处理。
- `src/__tests__/piHost.integration.test.ts` 用真实 `@earendil-works/pi-agent-core` 验证三次压缩、一次工具调用、完成保存、恢复继续，以及运行中旧订阅解绑/新订阅接管；仅为本地 Agent 回归，不替代桌面/进程级验收。

### 2026-09-12 R3 生产持久化与界面接管返修

- `src/ai/piRuntime.ts` 在生产 Agent 的 `message_end` 事件上调用 `onRawMessage`；`src/aiPanelChat.ts` 以稳定 `runId:message:<seq>` 追加完整 `message_raw` payload，并返回可检索的事件 ID。压缩前先完成原文追加，追加失败会阻止该 Agent 事件继续进入压缩流程。
- `AiPanel` 将 session 与 runId 关联，挂载/恢复会按 session 找到 `PiTaskHost`，重新绑定 Agent 的停止、steer 和 follow-up；运行中组件解绑不触发 abort。
- `PiTaskHost` 以整次 `runPiAgent` lease 保持注册，包含内部恢复 prompt；任务结束且无订阅时移除 task/session 注册，历史由 SQLite 恢复；新增生产路径回归验证完整工具消息经 `searchSessionHistory/readSessionEvidence` 可找回，集成回归还覆盖宿主回收。

### 2026-09-12 思考输出占满上下文返修

- `src/ai/piStream.ts` 只发送 assistant 的 text；原始 thinking 仍在本地 Pi 消息/事件中保留用于展示与审计，不重复注入下一轮。
- `src/ai/modelProfile.ts` 的输入估算排除 thinking；`src/ai/piRuntime.ts` 读取真实 usage/done_reason，针对“只有 thinking 且 length 截断”执行至多一次 `think: false` 收尾，保留约束、证据和工具结果并禁止重做副作用工具。
- 回归：`npx vitest run --testTimeout=60000` 为 360 passed、2 skipped；`npm run build` 退出 0。尚未在目标 27B/24GB GPU 上做真实复测，不能据此宣称该模型已解决。

### 2026-09-12 移除机器性能相关的默认输出限制

- 不再默认发送 `num_predict` / `max_tokens`；只有模型配置或用户明确设置输出上限时才发送。
- 低性能机器的响应速度不再改变产品默认回答长度；上下文窗口和模型/服务端自身限制仍然有效。
- 新增 Pi 请求策略回归，前端构建与 Rust 19 项测试通过；最终 EXE 需以本次打包结果为准。

## 完成清单

- [ ] ACCEPTANCE.md 的所有硬门槛都有实际证据；当前 P05/E07 与桌面 E 任务仍未验收。
- [ ] E03 完整业务任务通过；三次“桌面宿主实际触发”的连续压缩本身已通过（`usedModel=true`，证据 `cdp-real-evidence.json`），但最终材料/文件/steer 等 E03 条件仍未齐。
- [ ] 云端真链路已测或明确阻塞；当前已明确阻塞，未用 mock 抵扣。
- [x] 真实隔离执行、取消路径、进程重启恢复通过（AppContainer/Rust 测试与 restart-recovery 证据）。
- [ ] 前台输入优先、后台不抢占/重复提示需桌面验收；已完成一次真实附件安全边界验收，未完成长任务。
- [ ] 干净环境便携包和旧数据升级：包内内容检查、中文空格路径、本机 clean/old-db-copy 启动均通过；真正无开发环境机器的 UI 仍未验收。
- [x] 用户原有书架、手账、报价管理的浏览器回归脚本通过；脚本使用隔离模拟数据，不替代正式库人工验收。
- [x] 交付版本/哈希/构建产物和未通过项已写入本进度文件。
