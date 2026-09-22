# CostHub 原生 Pi 接入验收

结论：**不通过，需返修。** 已接入通用文件/命令工具和部分会话控制，但 Skills、跨轮文件连续性、执行边界、恢复可靠性尚未达到 2026-09-07 方案要求。

本次只做代码检查、运行检查及复现文件；没有修改生产代码。工作区原有大量改动，未将全部未提交差异归因于本次实施。

## 验证结果

| 检查 | 结果与范围 |
|---|---|
| `npm test -- --reporter=dot` | 原有 50 个测试文件、333 项测试通过 |
| `npm run build` | TypeScript 与 Vite 构建通过，仍有大包提示 |
| `cargo test --lib` | 14 项通过，包含真实 PowerShell 输出与产物存在检查 |
| `npx vitest run docs/review-pi-20260908.test.ts` | 4 项缺陷复现成立，详见下文；通过表示缺陷存在，不表示验收通过 |
| 真实模型、桌面交互、干净 Windows 安装环境 | 未执行端到端验收；不能据此宣称原生 Pi 能力已完成 |

复现测试使用真实前端模块和 Pi 加载器，模拟 Tauri IPC/数据库/Ollama 边界；其中 Skills 测试模拟 Rust 的任务目录路径限制。没有执行模型生成的命令，没有操作正式业务数据。

## 阻断项

### P1-01：内置 Skills 被自身文件边界拒绝

位置：`src/ai/piExecution.ts:99`、`src-tauri/src/lib.rs:441`、`src-tauri/src/lib.rs:396`。

`execution_skill_dirs` 返回 exe/resource/cwd 下的 skills 或 public/skills，而 `loadSkills` 使用只允许当前 ai-workspaces 子目录的 env。加载器首先读取这些目录的 fileInfo，Rust 在绝对路径检查阶段即拒绝，因此现有部署布局加载不到 quote-analysis。复现测试得到空 skills 和越界诊断。

此外 `tauri.conf.json` 没有配置独立的 skills bundle resources；Vite public 资源被嵌入前端，不等于在安装目录产生可供 Rust fs 读取的资源树。

返修：将已授权的技能资源复制到任务的只读资源位置，或为明确允许的技能根提供只读访问；技能相对引用也需可读，不能全盘关闭文件边界。配置真实分发资源，在安装产物中证明 quote-analysis 加载成功，并读到一个相对引用脚本/文件。

### P1-02：每轮创建新目录，上一轮文件无法续用

位置：`src/components/AiPanel.tsx:649`、`src/ai/piExecution.ts:95`、`src/components/AiPanel.tsx:270`。

每次 send 都无条件 createPiExecutionContext → execution_create_workspace。虽然传入上一轮 AgentMessage，但文件工具已绑定另一目录。例如第一轮生成 A/report.csv，第二轮“继续修改这个报告”使用 B 目录；相对路径找不到，绝对 A 路径被普通文件工具拒绝。Shell 虽可能绕到旧目录，不能代替正常会话连续性。

返修：工作目录与会话绑定并持久化；继续和恢复复用目录，新会话才创建。切换会话同时更新“打开任务目录”，不能保留另一会话的目录状态。验收两轮修改同一文件及重启后继续修改。

### P1-03：本机 Shell 默认开放，原隔离提示仍宣称覆盖云端出口

位置：`src/components/AiPanel.tsx:646`、`src/ai/piRuntime.ts:117`、`src-tauri/src/lib.rs:539`、`src/components/LocalAISecurityStatus.tsx:45`。

模型原生工具探测一旦成功就无条件挂载文件、PowerShell 和可用 Bash。原生工具在 beforeToolCall 直接放行，不进入业务写操作确认。没有方案要求的用户明确启用本机执行模式，也没有对破坏性命令的单独处理。提示“不是沙箱”只在模型系统提示中；用户看到的安全组件仍称“双重隔离已通过”“云端只能走专用网关”。

实际命令以 CostHub 用户权限执行并继承环境，Ollama 防火墙不能限制 PowerShell 的网络和文件访问。收到不可信附件内容时也没有执行层授权边界可依赖。

返修：落实任务/会话级本机执行授权，普通已授权操作无需反复询问，破坏性操作与正式数据写入仍需明确处理；本机执行状态下界面准确描述 Shell 权限。若要继续提供强制隔离承诺，须有真实系统隔离，不能靠 cwd 或关键词黑名单。

### P1-04：恢复只保存最终快照，大会话还会保存成坏 JSON

位置：`src/aiPanelChat.ts:31`、`src/components/AiPanel.tsx:665`、`src/ai/piRuntime.ts:105`。

savePiState 对整个 JSON 使用 slice(0, 2_000_000)，超过限制就截断成无法解析的数据；随后恢复 catch 静默丢弃。已用真实保存函数复现。文件工具返回图片时还可能较快触及这一限制。

状态只在整个 runPiAgent 返回后保存。若已完成数据库写入但进程退出/崩溃，工具结果没有随执行落盘，也没有此次调用的持久化去重/结果未知记录。重启只能恢复旧快照或纯聊天文字。当前仍每次新建 Agent、上下文大小硬编码，没有接入长会话压缩。

返修：逐事件保存工具调用与结果，按稳定执行 ID 记录业务写入；恢复时核对不确定结果，不自动重放。保持 JSON 完整，附件/大输出使用文件引用，模型上下文用可恢复摘要管理。不能以吞掉持久化错误表示保存成功。

### P1-05：取消和输出限制未覆盖完整进程生命周期

位置：`src/ai/piExecution.ts:67`、`src-tauri/src/lib.rs:548`、`src-tauri/src/lib.rs:553`。

前端只添加 abort 监听，不检查 signal.aborted；已取消的 signal 仍会 invoke 执行，复现测试成立。取消早于 Rust 注册执行 ID 时也可能丢失。

Rust stdout/stderr 用 read_to_end 完整积累到内存，退出后才做 12KB 截断，故现有 large_output 测试只验证显示字符串，不验证执行内存有界。输出也要等命令结束才回到前端。主进程退出后再等待管道读取任务，没有继续包在超时/取消 select 内；子进程持有管道时存在继续等待风险。未发现应用退出统一清理执行进程的生命周期接线。

返修：调度前检查取消，注册/启动握手期间保证取消不丢；输出边读边写文件、内存保留有界预览并发送进度；超时覆盖管道任务及子进程清理，应用退出终止任务进程树。提供慢脚本途中停止、连续输出、大输出、子进程持有管道和应用退出的真实 Windows 检查。上述生命周期风险来自代码检查，未声称本次已实际复现全部进程场景。

## 其余必须收口的问题

### P2-06：文件读取结果经过传输层再次静默损坏

位置：`src/ai/piStream.ts:10`。

toolResult 一律 textOf(...).slice(0, 4000)，忽略图片内容。原生 read 已有分页和截断说明，却在这里被第二次静默截短：例如超过 4000 字符的一行，其尾部再按行读取也无法获取。read 图片只会给模型文字提示，实际图片未发送。真实传输函数复现已确认两种情况。

返修：保留原生多模态结果，按已声明预算截断并明确可继续读取方式；不得静默截断可执行技能说明或丢掉图像。测试长行、长 SKILL.md 和模型支持的图片结果。

### P2-07：PowerShell 执行轨迹不会结束，原生文件工具重复显示开始

位置：`src/ai/piRuntime.ts:46`、`src/ai/piRuntime.ts:64`、`src/ai/piRuntime.ts:124`。

read/write/edit/Bash 的包装器发 onToolStart，Agent 的 tool_execution_start 又发一次，界面 appendStep 会创建两个同 callId 项，updateStep 只更新第一个。PowerShell 没经过包装器，也没有统一 tool_execution_end 处理，所以只有开始，没有 onToolResult；实际结果虽传给模型，却未进入 UI 成功/失败和 evidenceParts。

返修：统一从 Agent 的开始/结束事件生成一次轨迹和证据，或统一包装且不重复订阅；覆盖成功、非零退出码、异常和取消。非零退出不应显示为成功。

## 已完成且可以保留

- 使用实际 Pi Agent，没有误用未实现的 AgentHarness。
- 原生 read/write/edit 工厂已绑定 Tauri 环境，PowerShell 通过 Rust 真执行。
- 真实任务目录、附件原文件复制、命令超时/取消的基础链路已建立。
- 输入已接入 steer/followUp，消息更新按助手消息 ID 定位。
- 会话已增加完整 AgentMessage 快照字段，但可靠性需按上述要求补齐。

## 下一轮验收要求

先修 P1-01 至 P1-05，再修传输及轨迹；避免继续增加技能数量掩盖贯通问题。提交以下可复验材料：

1. 同会话连续两轮处理真实附件并修改同一产物，重启后仍能继续。
2. 内置 Skill 与相对脚本实际被读取，脚本报错后修复，产物能够打开。
3. 运行中补充与排队不丢失，取消后子进程退出，输出预览有界且持续更新。
4. 大会话保存/恢复不损坏，业务写入恢复不重复；拒绝与本机执行模式状态正确。
5. 记录模型、上下文配置、耗时和失败情形；构建与既有测试继续通过。

本次到此结束验收，不批准以“已具备原生 Pi Agent 能力”作为当前交付结论。
