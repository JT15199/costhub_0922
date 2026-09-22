# CostHub Quality Harness V1 — 实施报告

**仓库：** `JT15199/costhub_0922`
**基线提交：** `1c9ada49dc41e0d919623267c135e743b71c7b6e`（与实施指导一致 ✅）
**执行分支：** `quality-harness-v1`
**日期：** 2026-09-22
**本轮目标：** 只建设质量验收与回归基础设施，不重构业务功能，不修改云端洞察策略。

---

## 0. 结论速览

| 项目 | 结果 |
|---|---|
| `npm run quality:core` | **QUALITY GATE: PASS** — 11 pass / 0 fail / 1 warn（lint debt） / 退出码 0 |
| `npm run quality:full` | **QUALITY GATE: PASS** — 15 pass / 0 fail / 1 warn / 退出码 0 |
| `npm run quality:live` | **QUALITY GATE: PASS** — 17 pass / 0 fail / 1 warn / 退出码 0（本机 Ollama 可用，真实工具调用通过） |
| required 步骤失败 → 退出码 | **非 0（实测 1）** ✅ |
| 是否修改生产业务文件 | **是，但仅新增测试标记与测试脚本**（详见 §6） |
| 是否修改 `trendService.ts` / 隐私规则 / Rust Gateway / 审批 scope | **否** ✅ |
| 是否删除或弱化任何既有测试 | **否** ✅ |

---

## 1. 修改文件

```text
Added:
  tests/quality/README.md
  tests/quality/run-quality.mjs
  tests/quality/profiles.mjs
  tests/quality/self-check.mjs
  tests/quality/check-catalog.mjs
  tests/quality/check-report-leaks.mjs
  tests/quality/baseline-summary.mjs
  tests/quality/regression-catalog.json
  tests/quality/REGRESSION_CATALOG.md
  tests/quality/helpers/exec.mjs
  tests/quality/helpers/redact.mjs
  tests/quality/helpers/report.mjs
  tests/quality/helpers/dbGuard.mjs
  tests/quality/desktop/cdpClient.mjs
  tests/quality/desktop/launchApp.mjs
  tests/quality/desktop/actions.mjs
  tests/quality/desktop/fixtureData.mjs
  tests/quality/desktop/prepare-fixture.mjs
  tests/quality/desktop/check-portable.mjs
  tests/quality/desktop/run-e2e.mjs
  tests/quality/desktop/runtime-error-allowlist.json
  tests/quality/live/ollama-status.mjs
  tests/quality/live/ollamaUrls.mjs
  QUALITY_HARNESS_V1_REPORT.md          (本文件)

Modified:
  package.json          +4 个 quality:* 脚本；devDependencies 增加 ws
  package-lock.json     npm install -D ws 自动更新
  src/App.tsx           +2 处 data-testid（导航项、设置入口）
  src/pages/LoginScreen.tsx  +3 处 data-testid（用户名/密码/登录按钮）
  src/components/AiPanel.tsx +2 处 data-testid（composer 容器、输入框）

Deleted:
  (无)
```

`artifacts/` 整体被 `.gitignore` 忽略，因此运行产物（报告、夹具 exe/db 副本）**不进入版本库**。
需要长期留存的结论都在本文件与 `tests/quality/README.md` 中。

---

## 2. 每个改动为什么做（逐文件）

### 2.1 Runner 核心

| 文件 | 为什么需要 |
|---|---|
| `run-quality.mjs` | 统一入口。关键行为：① 步骤失败不中断后续步骤（先跑完再汇总）；② flake 重跑策略；③ 报告落盘；④ 退出码契约（PASS=0 / FAIL=1 / 用法=2 / BLOCKED=3）。 |
| `profiles.mjs` | core/full/live 三档的**静态步骤表**。命令全是字面量数组，不接受外部输入拼接——这是 `exec.mjs` 能安全使用 shell 的前提。 |
| `helpers/exec.mjs` | 子进程执行：记录 command/startAt/endAt/durationMs/exitCode/stdout/stderr；支持超时；Windows 下用 `taskkill /T /F` 清理整棵进程树；把「命令不存在/python 缺失/连接失败」这类情况分类为 `blocked` 而不是 `fail`。 |
| `helpers/redact.mjs` | 报告脱敏。**测试侧独立实现，不 import 生产隐私模块**——避免把应用运行环境依赖拖进纯 Node runner。三道防线：环境变量真实秘密值逐字抹除 → 凭据模式匹配 → 绝对路径折叠。 |
| `helpers/report.mjs` | 生成 `summary.json` + `summary.md`，并写入 `latest-summary.*`。gate 语义集中在这里：required 失败→FAIL；有 blocked 且无 required 失败→BLOCKED_ENVIRONMENT；可选步骤失败只计 warning。 |
| `helpers/dbGuard.mjs` | fixture 的**机器证明**。使用 Node 内置 `node:sqlite`（避免为测试基础设施引入依赖）。证明四条：basename、目录特征（拒绝 AppData/Program Files/src-tauri/target/Documents）、fixture marker、`PRAGMA integrity_check`。证明不出即 ABORT。 |

### 2.2 自检与验证

| 文件 | 为什么需要 |
|---|---|
| `self-check.mjs`（Q10） | **Harness 本身也会坏。** 26 项断言钉住：脱敏规则真的生效、DB guard 真的会拒绝（缺 marker 的库、正式库特征路径、非 fixture 目录）、报告 gate 语义正确。 |
| `check-catalog.mjs`（Q11） | 防止**纸面保护**：回归目录里引用的测试/源文件必须真实存在，`qualitySteps` 必须指向真实步骤。引用悬空直接让 core 失败。 |
| `check-report-leaks.mjs`（Q12） | Q10 验证「脱敏函数」，Q12 验证**真实落盘的报告文件**——包括子进程 stdout/stderr 带进来的、我们没预料到的内容。实测注入两个 canary API Key 环境变量后扫描 33 个报告文件，零命中。 |
| `baseline-summary.mjs` | Phase 0 归档：生成 `environment.json` 与 `baseline-summary.json`（含每步 `BASELINE_PASS` / `BASELINE_FAIL_EXISTING` / `ENVIRONMENT_BLOCKED` 分类）。 |

### 2.3 桌面 E2E

| 文件 | 为什么需要 |
|---|---|
| `desktop/cdpClient.mjs` | 从旧脚本抽出连接样板，但**不含任何业务逻辑**。额外提供：明确的三类连接失败原因（端口/目标/WebView2）、runtime error 采集（`Runtime.exceptionThrown` / `Log.entryAdded` / `console.*` / `unhandledrejection` / `window.onerror`）。 |
| `desktop/launchApp.mjs` | 在隔离目录启动夹具 exe，用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N` 打开 CDP；自动找空闲端口（避免与残留进程抢 9244）；结束时清理进程树。 |
| `desktop/actions.mjs` | 通用交互动作（登录/导航/BOM/AI 窗/设置）。所有动作返回结构化结果而不是抛异常，便于报告定位到具体哪一步断了。 |
| `desktop/fixtureData.mjs` | 合成夹具数据（1 个项目 + 6 行 BOM）。**从库自身 schema 探测可用列**，缺列不写——让夹具生成与 schema 演进解耦。 |
| `desktop/prepare-fixture.mjs`（F01） | 生成隔离夹具。**关键设计：用被测程序自己 bootstrap 出 schema**（跑一次 exe 让它建库），再写入测试账号 + `quality_fixture=1` + 合成项目。这样夹具内容 = 程序自身 schema，不会漂移，且不含任何真实业务数据。 |
| `desktop/check-portable.mjs`（F02/F04） | 检查夹具 exe 存在、体积合理、夹具目录无凭据类文件残留。 |
| `desktop/run-e2e.mjs`（F03） | E2E-001..008 编排 + runtime error 判定 + 报告落盘。 |
| `desktop/runtime-error-allowlist.json` | 允许登记「明确已知无害」的告警。**`errors` 数组刻意留空**：宁可让 E2E 因未知异常 FAIL，也不为了绿灯放宽。 |

### 2.4 live 档

| 文件 | 为什么需要 |
|---|---|
| `live/ollama-status.mjs`（L01） | 落实「Ollama 不存在必须判为 BLOCKED_ENVIRONMENT，不能伪装成 PASS」。退出码 3 即 blocked，被 `profiles.mjs` 的 `blockedExitCodes` 消费。 |
| `live/ollamaUrls.mjs` | 硬边界：live 探测只允许回环地址（拒绝局域网/公网），`localhost` 统一改写为 `127.0.0.1`。 |

### 2.5 生产文件（条件允许范围内的最小改动）

| 文件 | 改动 | 为什么不能只在测试侧解决 |
|---|---|---|
| `src/App.tsx` | 导航项加 `data-testid={`nav-${item.key}`}`；侧边栏设置入口加 `data-testid="nav-settings-trigger"` | E2E-003/E2E-006 需要稳定选择器。现有 `.nav-item` 只能按中文文案匹配（改文案即断），设置入口是一个无类名的 `Dropdown` 触发器，**测试侧无法稳定定位**。 |
| `src/pages/LoginScreen.tsx` | 用户名/密码/登录按钮加 `data-testid` | E2E-002。现有选择器依赖 `placeholder` 中文文案；且 antd 会把两字按钮渲染成「登 录」，按文案匹配脆弱。 |
| `src/components/AiPanel.tsx` | composer 容器与输入框加 `data-testid` | E2E-005。`.local-ai-composer` 是样式类，测试与样式耦合；输入区在折叠/展开/审批三种状态下结构不同。 |

**行为不变性证明：**

1. `data-testid` 是纯透传属性，不参与任何条件判断、不改变 props 流向、不影响 className/children。
2. 生产代码里**没有任何地方读取 `data-testid`**（全仓库 grep 确认：改动前 `data-testid` 出现 0 次）。
3. `npm run quality:core` 的 Q02（526 个既有测试）与 Q03（Rust 27 个测试）全绿；Q01 构建通过。
4. 改动后桌面 E2E 仍走通**同样的用户旅程**（登录、导航、BOM、AI 窗、设置、重启持久化）——即改动没有改变可达行为。

---

## 3. 基线状态（Phase 0，改动前）

采集于基线提交 `1c9ada4`，原始输出保存在 `artifacts/quality/baseline/raw/`。

```text
build:   BASELINE_PASS          exit 0   （50.0s）
lint:    BASELINE_FAIL_EXISTING exit 1   （59.6s）262 problems = 113 errors + 149 warnings
vitest:  BASELINE_FAIL_EXISTING exit 1   （30.6s）526 passed / 1 failed（冷启动 5s 超时抖动）
rust:    BASELINE_PASS          exit 0   （47.3s）
agent:   BASELINE_PASS          exit 0   （1.8s）
portable:BASELINE_PASS          exit 0   （109ms）
recovery:BASELINE_PASS          exit 0   （243ms）
```

### 3.1 lint 债务的真实构成（重要）

`npm run lint` 的 113 个 error 中，**107 个是 eslint 扫描被 gitignore 的 `.build-portable/` 打包产物**
产生的 `Parsing error: Unexpected character`——那是 Tauri 打包出来的压缩 JS，不是源码问题。

单独跑 `npx eslint src tests`：**155 problems = 6 errors + 149 warnings**，6 个 error 全部是
`react-hooks` 的「Cannot access refs during render」。

按实施指导 §12：V1 把 lint 记为 **non-blocking warning**，并在此列出债务，
**不在本轮大改业务代码「修 lint」**。

### 3.2 vitest 抖动的判定过程

首次全量运行失败于 `src/__tests__/costPackage.test.ts`（`Test timed out in 5000ms`）。
为区分「真失败」与「抖动」，做了如下取证：

| 实验 | 结果 |
|---|---|
| 单独运行 `costPackage.test.ts` × 3 | 3/3 通过 |
| 全量 `npx vitest run` × 4 | 4/4 通过（每次 526 passed） |
| 失败那一次 | 与 `npm run lint` 串行紧邻，属 CPU 争用 |

结论：**冷导入（`CostPackageButton` → pptxgenjs 链路）在争用下偶尔超过 5s 默认超时**，
是抖动而非正确性缺陷。因此 core 的 Q02 声明 `flakeRetry`：

* 重跑通过 → 降级为 **warning** 并在报告里标注 `flaky`（**不静默变绿**）；
* 重跑仍失败 → 判为 **fail**，理由写明「failed twice — not a flake」。

---

## 4. 最终状态

### 4.1 `quality:core`（12 步）

```text
QUALITY GATE: PASS     15 pass / 0 fail / 1 warn     Total 1m34s
```

| ID | 步骤 | 结果 | 耗时 |
|---|---|---|---|
| Q01 | TypeScript/Vite Build | PASS | 27.7s |
| Q02 | Vitest All | PASS | 12.3s |
| Q03 | Rust Unit Tests | PASS | 7.3s |
| Q04 | Privacy Regression | PASS | 1.4s |
| Q05 | Cloud Gateway Regression | PASS | 2.0s |
| Q06 | Approval Regression | PASS | 2.2s |
| Q07 | ResultStore Regression | PASS | 1.8s |
| Q08 | Agent Deterministic Eval/Test | PASS | 1.3s |
| Q09 | Lint | **WARNING**（optional） | 37.3s |
| Q10 | Harness self-check | PASS | 158ms |
| Q11 | Regression catalog integrity | PASS | 62ms |
| Q12 | Report leak check | PASS | 81ms |

> Q09 的 149 个 warning / 6 个源码 error 是**基线既有债务**，逐条列在 §5.1。

### 4.2 `quality:full`（16 步）

```text
QUALITY GATE: PASS     15 pass / 0 fail / 1 warn     Total 1m58s
```

core 全部步骤 + F01..F04 全绿。桌面 E2E 逐场景结果：

| ID | 场景 | 结果 |
|---|---|---|
| E2E-008 | 正式数据库隔离（前置守卫） | PASS |
| E2E-001 | 应用启动 | PASS |
| E2E-002 | 测试账号登录 | PASS |
| E2E-003 | 主导航 smoke（5 个一级入口） | PASS |
| E2E-004 | 项目/BOM 只读旅程 | PASS（表格 7 行，夹具型号可见 3/3） |
| E2E-005 | AI 协作窗基础状态 | PASS |
| E2E-006 | 设置页读取 + 凭据不泄漏 | PASS |
| E2E-007 | 重启持久化 | PASS |
| E2E-008b | 夹具未被改变 | PASS |

```text
runtimeErrors:        0
runtimeWarnings:      6
allowlistedWarnings:  6
```

### 4.3 `quality:live`（18 步）

```text
QUALITY GATE: PASS     17 pass / 0 fail / 1 warn     Total 4m45s
```

本机 Ollama 0.34.0 在线（3 个模型，含 `qwen3:4b`），因此 live 档真实跑通了 L02 真实工具调用
（2m15s）与 L03 真实总结证据（35s）。**若模型不可用，L01 会以退出码 3 结束 → runner 记为
BLOCKED_ENVIRONMENT，不伪装成 PASS**（该路径已在实现中打通，未在本机触发）。

### 4.4 退出码契约实测

为验证「任一 required 步骤失败 → 总退出码非 0」，**临时**向 core 注入一个 `exit 7` 的 required 步骤：

```text
▶ [1/13] ZX-INJECTED INJECTED FAILURE  ✖ FAIL  exit 7
▶ [2/13] Q01 …                          ✔ PASS          ← 失败后仍继续执行后续步骤
…
exit code = 1                                            ← 非 0 ✅
```

验证完成后已还原 `profiles.mjs`（`git status` 确认无残留）。

---

## 5. 未解决问题（不隐藏）

### 5.1 lint 债务（已知，V1 有意不修）

| 项目 | 数量 |
|---|---|
| `.build-portable/` 打包产物造成的 Parsing error | 107（配置噪声） |
| 源码 `react-hooks`「Cannot access refs during render」error | 6 |
| 源码 warning | 149（`no-useless-assignment` 38、`exhaustive-deps` 29、`no-useless-escape` 15、`prefer-const` 13 …） |

**未做**：修改 `eslint.config.js` 的 `globalIgnores` 加入 `.build-portable/`。
虽然这能立刻把 107 个 error 变成 0，且项目 CLAUDE.md 已有「忽略 Rust 构建产物」的既有意图，
但那属于**生产配置变更**，与本轮「只做质量基础设施」的范围不符，故按 §25 记录为 blocker/建议
而非自行扩大范围。**建议下一轮单独做 lint clean-up 时一并处理。**

### 5.2 未覆盖 / 未验证的部分

1. **`quality:live` 的 BLOCKED 路径未在本机实测**（因为本机 Ollama 可用）。
   代码路径已实现（`blockedExitCodes: [3]` + 探测脚本退出码 3），但缺少一次真实触发记录。
2. **E2E 只覆盖 1 个夹具项目 + 6 行 BOM**。有意为之（§9「首批只做稳定的高价值流程」），
   但意味着 BOM 编辑、SKU、招标工作台、竞品对比等页面**没有**旅程级保护。
3. **CDP 端口**：默认 9244，已被占用时自动向上扫描（+1..+39）。若 40 个端口全被占用会 BLOCKED。
4. **RDP 远程会话下 CDP 不可用**：`src-tauri/src/main.rs` 在 `SESSIONNAME != Console` 时会把
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 覆盖为 `--disable-gpu`，从而丢掉调试端口参数。
   因此**远程桌面环境无法运行 full 档**（会 BLOCKED）。这是生产行为，本轮未改。
5. **lint 步骤耗时 36s**，因为它扫描了被 gitignore 的打包产物——修 §5.1 后应显著下降。
6. **Agent Trace（§16）只做了基础**：本轮没有实现「Tool Trace / Network Trace / Approval Trace」
   的结构化断言，仅在 `regression-catalog.json` 中为 REG-AGENT-001 预留了位置。

### 5.3 报告留存方式的取舍

实施指导 §23 要求保留 `artifacts/quality/latest-summary.json` / `.md`。
但 `.gitignore` 已忽略整个 `artifacts/`（其中含 25MB exe 与数据库副本）。
因此**这两个文件不会出现在 git 仓库中**，需要评审者本地运行 `npm run quality:core` 生成。
本文件（已提交）包含了这两份报告的完整结论，供无法运行环境的评审者对照。
**未**为此修改 `.gitignore` 白名单——避免把大体积产物或夹具数据引入仓库。

---

## 6. 是否修改生产业务文件

**是。** 逐项说明理由（对应实施指导中的 `WHY_PRODUCTION_FILE_CHANGED`）：

### 6.1 `src/App.tsx`

* **为什么不能通过测试侧解决**：设置入口是 antd `Dropdown` 的直接子 `<div>`，无类名、无 aria-label、无 id，
  测试侧只能靠「遍历所有元素找 innerText 含『设置』」这种脆弱启发式（第一版实测确实失败）。
  导航项虽有 `.nav-item` 类，但只能按中文文案匹配，文案一改测试即断。
* **修改前行为**：`<div key={item.key} className="nav-item …">` / `<div style={{…}}>`。
* **修改后行为**：同上，额外带 `data-testid` 属性。
* **如何证明业务行为没有变化**：见 §2.5 的四条证明（属性透传、无人读取、测试全绿、旅程仍走通）。

### 6.2 `src/pages/LoginScreen.tsx`

* **为什么不能通过测试侧解决**：登录是本轮所有 E2E 的前置；原选择器依赖中文 `placeholder`，
  且 antd 把「登录」渲染成「登 录」，按文案匹配已在本轮实测中造成一次误判
  （就绪判断过早 → 点击被 loading 态吞掉 → 超时）。
* **修改前后行为**：完全一致，仅新增 `data-testid`。
* **证明**：同上。

### 6.3 `src/components/AiPanel.tsx`

* **为什么不能通过测试侧解决**：输入区在折叠/展开/内联审批三种状态下结构不同，
  原选择器 `.local-ai-composer` 是**样式类**，与视觉改动耦合。
* **修改前后行为**：完全一致，仅新增 `data-testid`。

### 6.4 `package.json` / `package-lock.json`

* 新增 4 个 `quality:*` 脚本（不改动任何既有脚本）。
* 新增 `ws` 到 **devDependencies**：既有 CDP 脚本 `import { WebSocket } from 'ws'`，
  但 `package.json` 未直接声明（仅作为 `@earendil-works/pi-ai` 的传递依赖存在）。
  按实施指导 §4.3，这是测试基础设施依赖，**不算业务变化**。
* `npm install` 顺带把 `@tauri-apps/plugin-opener` 与 `@tauri-apps/plugin-sql` 的行序调整了
  （字母序），无语义变化。

### 6.5 未修改的关键文件（确认）

```text
src/trendService.ts         未修改 ✅
src/cloudConfirm.tsx        未修改 ✅
src/ai/privacyRouter.ts     未修改 ✅
src/ai/gateway.ts           未修改 ✅
src/ai/safeQuery.ts         未修改 ✅
src/ai/searchQuery.ts       未修改 ✅
src/ai/searchRequest.ts     未修改 ✅
src-tauri/src/lib.rs        未修改 ✅
数据库 migration            未新增 ✅
eslint.config.js            未修改 ✅
.gitignore                  未修改 ✅
```

---

## 7. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **Windows-only** | full/live 档依赖 WebView2 与 Windows 进程语义（`taskkill`） | 非 win32 时 `prepare-fixture` / `run-e2e` 直接退出码 3（BLOCKED），不伪装 PASS |
| **RDP 会话不可用** | `main.rs` 在远程会话覆盖 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，CDP 端口参数被丢弃 | 会报 LAUNCH_FAILED / BLOCKED；需在 Console 会话运行 full 档 |
| **需要 release 构建** | 夹具用 `src-tauri/target/release/costhub.exe`；**Tauri 在编译期内嵌前端**，只跑 `npm run build` 不会更新 exe | `prepare-fixture` 找不到 exe 时报 BLOCKED 并提示 `npm run tauri:build`；本轮已重建（1m18s） |
| **CDP 端口冲突** | 默认 9244 | 自动向上扫描 40 个端口 |
| **live 模型不可用** | Ollama 未启动/无模型 | 判为 BLOCKED_ENVIRONMENT（退出码 3），不影响 core/full |
| **flake 掩盖真实回归** | Q02 允许一次重跑 | 重跑通过必须降级为 warning 并标注 `flaky`；重跑仍失败即 fail。**不静默变绿** |
| **夹具 schema 漂移** | 应用 schema 演进可能让夹具生成失败 | `fixtureData.mjs` 从库自身 schema 探测列，缺列自动降级并在日志打印 `schema:` 诊断 |
| **artifacts 不入库** | 评审者拿不到 latest-summary | 本报告已固化结论；评审者可本地跑 `npm run quality:core` 复现 |
| **E2E 覆盖面窄** | 只覆盖 1 个项目 + 6 行 BOM | 有意为之，见 §5.2；后续按同一框架增量补场景 |

---

## 8. 实施过程中发现并修复的真实缺陷（Harness 自身）

以下是本轮**在自建 Harness 上踩到并修掉的坑**，全部属于测试侧缺陷（非业务缺陷），记录在此以便复用：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | self-check 报「脱敏失败：`{token: "…"}` 未被抹除」 | `redactDeep` 对**叶子值**调用 `redact()`，而凭据模式需要字段名在上下文中才可见 | 改为「敏感字段名 → 整值替换」+ 整体序列化后跑一遍 `redact()` 再解析回来 |
| 2 | self-check 报「fixture 被拒」但库其实是合法的 | 自检把临时夹具建在 `os.tmpdir()`（Windows = `AppData\Local\Temp`），而 dbGuard 把 `AppData\Local` 判为正式库特征路径 | 这是 **guard 的正确严格性**，改的是自检位置；并在代码里写明原因 |
| 3 | E2E-004 反复超时，但错误信息里的数字看起来是成功的 | `document.querySelector('.ant-tabs-tab-active')` 命中的是**外层工作区 tab**（项目工作区用了嵌套 Tabs） | 不再依赖 active class，改用「BOM 表格出现夹具型号」作为渲染证据 |
| 4 | E2E-004 点击 BOM 页签不生效 | DOM 里有**多个**「BOM清单」tab 节点（隐藏的历史/预渲染节点），点到隐藏的不会切换 | 优先点可见节点，不可见时退回 DOM 末尾节点，并允许抖动重试 |
| 5 | E2E-004 在数据未加载时点击拿到空表 | 数据异步加载，加载完成前页签显示「BOM清单 (0件)」 | 先等「非 0 件」再点 |
| 6 | E2E-007 一开始用私有 localStorage 键做探针，重启后消失，误判为「持久化坏了」 | localStorage 本身是持久的（同进程 reload 保留、应用自己的 `app-theme` 跨重启保留），消失的是那个私有键 | 改为断言**真实用户偏好**（主题）跨重启保留且重新应用——测产品行为，不测内部实现 |
| 7 | E2E-002 登录点击被吞、后续超时 | **antd 的 `loading` 按钮不带 `disabled` 属性**，只渲染加载态并吞掉点击；第一版就绪判断只看 `!disabled` | 就绪判断同时要求按钮文案不是「正在准备…」且不带 `ant-btn-loading` |
| 8 | 新增 `data-testid` 后 `npm run build` 失败（TS2657 等 20+ 错误） | 我在 `{NAV.map(item => (` 的**隐式返回**里插了 `{/* JSX 注释 */}`，注释变成块语句导致没有 return | 把注释移到 `map` 之前；`tsc -b` 立刻抓到 |
| 9 | `quality:full` 里 F01 失败「no such column: part_name」 | 夹具播种脚本硬编码了 `project_boms` 的快照列，而这些列由应用运行时 ALTER 添加 | 从库自身 schema 探测可用列，缺列自动降级到 `part_id` 去重并打印诊断 |
| 10 | F04 用旧的一次性打包目录做检查，fresh clone 后必失败 | 指向 `artifacts/agent-upgrade/20260910-portable/...`（gitignore 且陈旧） | 改为复用 `check-portable.mjs` 校验当前夹具 exe，语义等价且始终可用 |

---

## 9. 对照最终验收标准（实施指导 §21）

### A. 基础

- [x] `npm run quality:core` 存在
- [x] `npm run quality:full` 存在
- [x] `npm run quality:live` 存在
- [x] 任意 required step 失败 → 总退出码非 0（**实测 exit 1**）
- [x] 报告 JSON 生成（`artifacts/quality/<run-id>/summary.json`）
- [x] 报告 Markdown 生成（`summary.md` + `latest-summary.md`）

### B. 安全

- [x] core 不联网
- [x] full 不联网
- [x] 不需要 API Key
- [x] 不读取正式业务凭据
- [x] 不写正式数据库（fixture 需机器证明，证明不出即 ABORT）
- [x] 报告内容自动脱敏（Q12 用 canary key 对 33 个真实报告文件实测零命中）

### C. 测试

- [x] 现有 Vitest 被完整纳入（Q02，526 个测试）
- [x] Rust lib tests 被纳入（Q03）
- [x] Privacy 核心回归被单独标识（Q04 + REG-PRIV-001/002）
- [x] Approval 核心回归被单独标识（Q06 + REG-APPROVAL-001）
- [x] Search binding 真实事故进入 catalog（REG-SEARCH-001）
- [x] Desktop startup smoke 存在（E2E-001）
- [x] Desktop login smoke 存在（E2E-002）
- [x] Desktop navigation smoke 存在（E2E-003）
- [x] DB integrity 检查存在（E2E-001 / E2E-008 / E2E-008b）
- [x] Runtime JS exception 检查存在（CDP 采集 + allowlist，未登记异常必 FAIL）

### D. 兼容

- [x] 原 `npm test` 仍可单独运行（Q02 就是它）
- [x] 原 `test:agent:*` 脚本未被破坏（Q08 复用 `test:agent`；`test:agent:tools/recovery/portable/live` 原样保留）
- [x] 原 CDP 脚本未被删除（`cdp-inspect.mjs` / `cdp-e01-upload.mjs` 保留且未改）
- [x] 不改变当前洞察策略
- [x] 不改变隐私策略
- [x] 不改变云端审批策略

---

## 10. 自检问题（实施指导 §27）

| # | 问题 | 回答 |
|---|---|---|
| 1 | 我有没有改 `trendService.ts`？ | **没有** |
| 2 | 我有没有放松隐私规则？ | **没有**。`privacyRouter.ts` / `security.ts` / `safeQuery.ts` 未修改；脱敏是测试侧独立实现 |
| 3 | 我有没有放松 Rust Gateway？ | **没有**。`src-tauri/src/lib.rs` 未修改 |
| 4 | 我有没有为了测试通过删除旧测试？ | **没有**。`src/__tests__/` 与 `tests/agent-upgrade/` 未删任何文件 |
| 5 | core 是否在断网状态仍可运行？ | **是**。core 无网络调用；live 档的本地模型探测被硬限制为回环地址 |
| 6 | full 是否会碰正式数据库？ | **不会**。启动前必须通过四条证明，否则 ABORT |
| 7 | 测试报告是否可能泄漏 API Key？ | **不会**（Q12 实证：注入 canary key 后扫描 33 个报告文件零命中；且运行后即删除 canary） |
| 8 | E2E 是否真的启动了 CostHub，而不是只测 helper？ | **是**。`run-e2e.mjs` 启动真实 `CostHub.exe`（pid 记录在报告里），经 CDP 连到真实 WebView2，走真实登录→导航→BOM→AI 窗→设置→重启 |
| 9 | 至少有一个桌面测试是否会在真实 UI 崩溃时 FAIL？ | **是**。E2E-001（`#root` 空白 / error boundary / 未捕获异常）、E2E-003（导航后页面空白）、E2E-008b（夹具被改）都会 FAIL |
| 10 | 任何 required step 失败时，quality 命令是否返回非 0？ | **是**，实测 exit 1 |
| 11 | 是否生成了最终报告？ | **是**（本文件） |
| 12 | 是否保留了所有未解决问题？ | **是**（§5，未做美化） |

---

## 11. 下一步建议（**只写建议，不实施**）

1. **lint clean-up 专项**（独立一轮）：
   把 `.build-portable/` 加入 `eslint.config.js` 的 `globalIgnores`（消除 107 个配置噪声 error），
   再逐一收敛 6 个 `react-hooks` error 与 149 个 warning。**不要**用 `--fix` 一次性扫射。
2. **新增 Bug 一律走回归流程**（§15）：先写失败测试 → 确认旧代码 FAIL → 修 → 加 catalog。
   `check-catalog.mjs` 会强制引用真实存在。
3. **扩展桌面 E2E 场景**（按同一框架增量）：
   BOM 编辑保存、SKU 变体、招标工作台导入预览、竞品对比、器件库搜索。
   每个场景都应包含「不改动业务数据」的前后计数断言。
4. **补 Agent Trace 断言（§16）**：把 Tool Trace / Network Trace / Approval Trace 结构化，
   逐步做到「答案看起来对」不再是唯一通过条件；`regression-catalog.json` 已为 REG-AGENT-001 预留。
5. **让 live 的 BLOCKED 路径留下一次真实记录**：在有 Ollama 的机器上先停掉 Ollama，
   跑一次 `quality:live`，确认输出 `LIVE GATE: BLOCKED_ENVIRONMENT` 且退出码 3。
6. **解决 RDP 下 CDP 不可用**（若需要在远程环境跑 full 档）：
   让 `main.rs` 在远程会话下**追加**而非覆盖 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`。
   这属于生产改动，需要单独评估——本轮按 §17 未触碰。
7. **考虑为评审提供报告快照**：若希望 `artifacts/quality/latest-summary.{json,md}` 进入版本库，
   可在 `.gitignore` 中为这两个具体文件名加白名单（不放开整个 `artifacts/`）。
   本轮未做，以免把夹具 exe/db 带入仓库。
8. **Research Agent V2 与 Insight Snapshot**：属下一阶段，**本轮未实现、未提前设计**（§18）。

---

## 12. 复现方式

```bash
git checkout quality-harness-v1

# 确定性闸门（约 1.5 分钟）
npm run quality:core

# 完整闸门（约 2 分钟；需要 Windows + 已构建的 release exe）
npm run tauri:build          # 若 src-tauri/target/release/costhub.exe 不存在或过期
npm run quality:full

# 真实本地模型（约 5 分钟；需要 Ollama）
npm run quality:live

# 查看最近一次报告
npm run quality:report
type artifacts\quality\latest-summary.md
```

需要向外提供的验收材料：

```text
QUALITY_HARNESS_V1_REPORT.md              本文件（已提交）
artifacts/quality/latest-summary.json     本地生成（artifacts/ 被 gitignore）
artifacts/quality/latest-summary.md       本地生成
git log --oneline <base>..HEAD
git diff --stat <base>..HEAD
```

---

_本报告由 Quality Harness V1 实施轮生成。所有数字来自实际运行输出，未做美化。_
