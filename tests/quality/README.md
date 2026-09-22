# CostHub Quality Harness V1

统一质量闸门。目的不是「让灯变绿」，而是**准确告诉我们系统哪里真的安全、哪里真的坏了**。

> 本轮范围：仅质量基础设施、回归索引、最小桌面 E2E。
> 不修改云端洞察策略、Research Loop、Privacy Gateway 业务策略、Insight Snapshot、Material Timeline。

---

## 快速开始

```bash
npm run quality:core    # 确定性闸门：每次改代码都必须跑（无网络 / 无 Ollama / 无 API Key / 不碰正式库）
npm run quality:full    # core + 隔离桌面程序（真实 WebView2/CDP + 隔离 SQLite fixture）
npm run quality:live    # full + 本地 Ollama 真实工具调用（仅人工验收）
npm run quality:report  # 只从 latest-summary.json 重渲染 Markdown，不重跑测试
```

退出码：

| 码 | 含义 |
|---|---|
| `0` | `QUALITY GATE: PASS` |
| `1` | `QUALITY GATE: FAIL`（有 required 步骤失败） |
| `2` | 用法错误（未知 profile） |
| `3` | `QUALITY GATE: BLOCKED_ENVIRONMENT`（环境不具备，既不是 PASS 也不是 FAIL） |

**任何 required 步骤失败 → 退出码一定非 0。** 可选步骤（`required: false`，如 lint）失败只降为 warning，不会被伪装成通过。

---

## 三档 profile

```text
QUALITY CORE   完全确定性；无网络、无 Ollama、无 API Key、无正式数据库
      ↓
QUALITY FULL   CORE + 隔离桌面程序 + 真实 WebView2/CDP + 隔离 SQLite fixture（仍不访问真实云端）
      ↓
QUALITY LIVE   FULL + 本地 Ollama + 真实 Agent Tool Calling + 可选真实搜索（只用于人工验收）
```

`live` 档在模型未安装时输出 `BLOCKED_ENVIRONMENT` 并写明原因，**不会伪装成 PASS**，也不影响 core/full。

---

## 步骤清单

### core

| ID | 步骤 | required | 保护的回归项 |
|---|---|---|---|
| Q01 | TypeScript/Vite Build | ✅ | — |
| Q02 | Vitest All（全部单测/集成测试） | ✅ | — |
| Q03 | Rust Unit Tests（`cargo test --lib`） | ✅ | — |
| Q04 | Privacy Regression | ✅ | REG-PRIV-001 / REG-PRIV-002 |
| Q05 | Cloud Gateway Regression | ✅ | REG-CLOUD-001 / REG-SOURCE-001/002 / REG-SEARCH-001 |
| Q06 | Approval Regression | ✅ | REG-APPROVAL-001 / REG-SEARCH-001 |
| Q07 | ResultStore Regression | ✅ | REG-STORE-001 |
| Q08 | Agent Deterministic Eval/Test | ✅ | REG-AGENT-001 |
| Q09 | Lint | ⬜ 否（V1 记为 warning） | — |
| Q10 | Harness self-check（脱敏 + DB guard） | ✅ | REG-DB-001 |
| Q11 | Regression catalog integrity | ✅ | — |
| Q12 | Report leak check（对真实落盘报告验证脱敏） | ✅ | REG-PRIV-002 |

> **Q09 为什么是 warning**：基线 `npm run lint` 本来就是失败状态
> （113 errors / 149 warnings，其中 107 个 error 来自 eslint 扫描被 gitignore 的
> `.build-portable/` 打包产物，属于配置噪声）。按实施指导 §12，
> V1 不一次性大改几百个文件「修 lint」，先记为 debt 并在报告中列出。

### full（叠加在 core 之上）

| ID | 步骤 | required | 说明 |
|---|---|---|---|
| F01 | Desktop fixture prepare | ✅ | 用被测程序自身 bootstrap 出 schema，再写入测试账号 + `quality_fixture=1` + 合成项目 |
| F02 | Fixture executable check | ✅ | exe 存在/体积合理/夹具目录无凭据残留 |
| F03 | Desktop E2E-001..008 | ✅ | 真实 WebView2 + CDP |
| F04 | Portable package check | ⬜ 否 | 沿用 `tests/agent-upgrade/check-portable.mjs` |

### live（叠加在 full 之上）

| ID | 步骤 | required |
|---|---|---|
| L01 | Ollama status probe | ✅（探测不到 → blocked，退出码 3） |
| L02 | Real tool smoke | ✅（同上） |
| L03 | Real summary evidence | ✅（同上） |

---

## 安全边界（Harness 自身）

1. **core / full 不联网**：没有真实搜索 API、没有云端 LLM、不读取任何 API Key。
   `live` 档的本地模型探测被硬限制为回环地址（`ollamaUrls.mjs` 拒绝非 loopback）。
2. **不写正式数据库**：桌面 E2E 只能跑在 fixture 上，且必须先被**机器证明**（见下）。
3. **报告自动脱敏**：所有进入 JSON/Markdown 的文本先过 `helpers/redact.mjs`。
   该模块是测试侧独立实现，**不 import 生产隐私模块**，避免把应用运行环境依赖拖进纯 Node runner。
4. **不允许「为了绿灯放宽」**：`runtime-error-allowlist.json` 的 `errors` 默认为空。

### 数据库证明（REG-DB-001）

`helpers/dbGuard.mjs` 在写任何东西之前必须证明目标是 fixture，四条同时成立：

```text
basename           == costhub.db
路径不含           正式库特征（src-tauri/target、AppData、Program Files、Documents …）
路径落在           fixture 目录特征内
settings.quality_fixture == 1  且 PRAGMA integrity_check == ok
```

**证明不出即 ABORT。** 明确禁止「大概率不是正式库，所以继续」。

### 运行时错误（§10）

CDP 侧监听 `Runtime.exceptionThrown` / `Log.entryAdded` / `console.error` /
`unhandledrejection` / `window.onerror`。任意**未登记**的未捕获异常、unhandled rejection
或 React fatal，都会让对应 E2E FAIL。

允许登记的只有「明确的、已知无害的告警」，且每条必须写明 pattern、理由、首次观测日期与适用范围。
当前 `errors` 为空；`warnings` 只登记 Chromium 的 DOM 开发建议（登录页无 `<form>`、`[DOM]` 前缀提示）。

---

## 目录结构

```text
tests/quality/
  README.md                     本文件
  run-quality.mjs               统一入口（profile 调度 / flake 重跑 / 报告落盘 / 退出码）
  profiles.mjs                  core / full / live 的静态步骤表
  self-check.mjs                Q10：脱敏与 DB guard 的自我验证（26 项断言）
  check-catalog.mjs             Q11：回归目录引用完整性（防止「纸面保护」）
  check-report-leaks.mjs        Q12：对真实落盘报告做泄漏检查（canary 环境变量 + 凭据模式 + 本机身份）
  baseline-summary.mjs          Phase 0 基线归档（生成 environment.json / baseline-summary.json）
  regression-catalog.json       事故 → 测试 → 保护边界 的机器可读索引
  REGRESSION_CATALOG.md         同一索引的人类可读版
  helpers/
    exec.mjs                    子进程执行（记录/超时/进程树清理/不存在即 blocked）
    redact.mjs                  报告脱敏（凭据模式 + 路径折叠 + 环境变量值逐字抹除）
    report.mjs                  summary.json / summary.md 生成与写盘
    dbGuard.mjs                 fixture 证明、计数快照、integrity_check、夹具播种
  desktop/
    cdpClient.mjs               CDP 客户端（连接/求值/等待/事件/错误采集）
    launchApp.mjs               夹具程序启动、空闲端口、进程树收尾
    actions.mjs                 通用交互动作（登录/导航/BOM/AI 窗/设置）
    fixtureData.mjs             合成夹具数据（项目 + BOM 行）
    prepare-fixture.mjs         F01：生成隔离夹具
    check-portable.mjs          F02：夹具可执行文件检查
    run-e2e.mjs                 F03：E2E-001..008 编排
    runtime-error-allowlist.json
  live/
    ollama-status.mjs           L01：本地模型可用性（不存在 → blocked）
    ollamaUrls.mjs              回环地址白名单解析
```

---

## 桌面 E2E 场景

| ID | 场景 | 关键断言 |
|---|---|---|
| E2E-008 | 正式数据库隔离（**前置守卫**） | 证明不出 fixture 就整体 ABORT |
| E2E-001 | 应用启动 | 进程存活、`#root` 有内容、无 error boundary、无 fatal JS、fixture integrity = ok |
| E2E-002 | 测试账号登录 | 登录成功、主壳出现、主导航存在、登录页消失 |
| E2E-003 | 主导航 smoke | 5 个一级入口逐个点击后页面非空白、无未捕获异常 |
| E2E-004 | 项目/BOM 只读旅程 | BOM 页签出现、表格渲染夹具行、**夹具型号真的出现在页面上** |
| E2E-005 | AI 协作窗基础状态 | composer 存在、输入框可输入、模型控件存在、无模型时不崩 |
| E2E-006 | 设置页读取 | 设置面可打开；DOM 中**无凭据形状**的 input value（只报告形状统计，不抓原文） |
| E2E-007 | 重启持久化 | 改一个安全的 UI 偏好（主题）→ 关进程 → 重启 → 偏好仍在且已重新应用 |
| E2E-008b | 夹具未被改变 | 业务表（projects/project_boms/parts）行数不变、integrity 仍为 ok |

**读取范围说明**：E2E-001..006 在**同一个进程会话**里连续执行，把
「启动 → 登录 → 导航 → 项目/BOM → AI 窗 → 设置」当作一条完整用户旅程验证——
这正是「函数各自 PASS、组合后失败」的检测点。E2E-007 单独重启，因为持久化必须跨进程验证。

### 已知实现细节（走查记录，避免以后重复踩）

* 项目工作区使用**嵌套 Tabs**：`document.querySelector('.ant-tabs-tab-active')` 命中的是文档顺序里
  第一个（外层工作区 tab），不是目标子页签 → 不要用它判断「BOM 页签是否激活」。
* DOM 中存在**多个**「BOM清单」tab 节点（隐藏的历史/预渲染节点）。点错那个不切换视图 →
  优先点可见节点，不可见时退回 DOM 末尾节点，并允许抖动重试。
* BOM 数据异步加载：加载完成前页签显示「BOM清单 (0件)」，此时点击即便命中也会拿到空数据 →
  先等「非 0 件」再点。
* AI 协作窗默认折叠成 42px 竖条（`localStorage['ai-panel-collapsed']` 缺省即折叠）→
  E2E-005 先展开，且断言同时接受「已展开」与「需要展开」两种情况。
* antd 会把两字中文按钮渲染成「登 录」（中间插空格）→ 用 `/登\s*录/` 匹配。

---

## 新增 Bug 的进入流程（强制）

发现真实 Bug 时必须：

```text
Bug
 ↓ 先写失败测试
 ↓ 确认测试在旧代码 FAIL
 ↓ 修代码
 ↓ 测试 PASS
 ↓ 加入 regression-catalog.json（REG-<DOMAIN>-<NNN>）
 ↓ 以后每次 quality:core 自动跑
```

禁止「发现 Bug → 直接改代码 → 手工点一下 → 说修好了」。

ID 格式 `REG-<DOMAIN>-<NNN>`，例如 `REG-APPROVAL-002`、`REG-SEARCH-004`。
新增条目后 `check-catalog.mjs` 会校验：id 唯一且格式合法、`tests[]`/`sourceFiles[]` 真实存在、
`qualitySteps[]` 指向真实存在的步骤——**引用悬空会让 `quality:core` 直接失败**。

---

## flake 处理策略

`Q02 Vitest All` 在冷启动/CPU 争用下已知存在超时抖动
（`src/__tests__/costPackage.test.ts` 冷导入 `pptxgenjs` 链路偶尔超过 5s 默认超时；
基线实测 5 次中 1 次失败，且该次与 lint 并发）。

处理方式：允许**一次**重跑，并且：

* 重跑通过 → 该步骤降级为 **warning**，在报告里明确标注 `flaky`，**不静默变绿**；
* 重跑仍失败 → 判为 **fail**，理由写明「failed twice — not a flake」。

这条规则同时适用于任何声明了 `flakeRetry` 的步骤。禁止用它掩盖真实回归。

---

## 报告产物

```text
artifacts/quality/<run-id>/summary.json     机器可读
artifacts/quality/<run-id>/summary.md       人类可读
artifacts/quality/latest-summary.json
artifacts/quality/latest-summary.md
artifacts/quality/desktop-fixture/          隔离夹具（exe + costhub.db + manifest）
artifacts/quality/desktop-e2e.json          桌面 E2E 逐场景明细
```

`artifacts/` 整体被 `.gitignore` 忽略（含夹具 exe 与 db 副本），因此**报告不进入版本库**；
需要长期留存的结论写进仓库根部的 `QUALITY_HARNESS_V1_REPORT.md`。

---

## 兼容性

* 原有 `npm test` / `npm run test:agent*` / `npm run build` / `npm run lint` 全部保留，可单独运行。
* 原有 CDP 脚本（`tests/agent-upgrade/cdp-inspect.mjs`、`cdp-e01-upload.mjs`）保留未删，
  功能不变；新的 Harness 复用其连接思路但抽出为独立 helper。
