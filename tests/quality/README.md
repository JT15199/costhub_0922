# CostHub Quality Harness V2

统一质量闸门。目的不是「让灯变绿」，而是**准确告诉我们系统哪里真的安全、哪里真的坏了**。

> **V2 定位变化：** V1 的重点是「增加测试能力」，V2 的重点是**建立可信质量门禁** ——
> 门禁本身要能挡住新增债务，且不能反过来变成维护负担。

> 本轮范围：仅质量基础设施。不修改云端洞察策略、Research Loop、Privacy Gateway 业务策略、
> Insight Snapshot、Material Timeline。

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

**任何 required 步骤失败 → 退出码一定非 0。** 可选步骤失败只降为 warning，不会被伪装成通过。

---

## V2 相对 V1 的六项加固

| # | 加固点 | V1 的问题 | V2 的做法 |
|---|---|---|---|
| 1 | **数据库白名单** | 用正则匹配路径关键词，`D:/project/quality-old/test.db` 这类路径可能被误判为合法 fixture | 改为 `path.relative()` **严格目录白名单**，唯一合法位置由 `config.database.fixtureDir` 指定；删除所有关键词/正则匹配；fail closed |
| 2 | **生产代码不含测试解释** | `src/App.tsx` 里有 `{/* data-testid=... E2E-003 ... */}` 之类注释，测试原因污染生产代码 | 只保留 `data-testid` 属性，删除全部解释性注释；说明统一放本文件 |
| 3 | **泄漏检查校验当前报告** | Q12 在步骤序列中间执行，而正式报告要跑完才写盘 —— 它校验的是**上一次运行的残留** | 改为「草稿报告 → Q12 检查 → finalize」三阶段，Q12 校验的必然是本次运行产出的报告 |
| 4 | **fixture 无明文密码** | 密码硬编码在 fixtureData / actions / README | 优先读 `QUALITY_TEST_PASSWORD`；未提供时由 runner 生成**一次性随机密码**，经进程环境＋运行目录下 0600 权限的一次性文件传递，不落 git、不进报告 |
| 5 | **Vitest 只跑一次** | Q02 跑全量后，Q04–Q07 又把其中一部分文件**再跑一遍**只为分类展示 | 只跑一次，由自定义 reporter 采集逐测试结果，再按文件归类成边界报告 |
| 6 | **lint 基线门禁** | lint 失败只是 warning，债务可以无限增长 | `tests/quality/lint-baseline.json` 记录上限，**超过即硬失败**；只允许减少不允许新增 |

另有第七项：**单文件行数门禁**（`maxFileLines: 300`），防止 Harness 自身膨胀成第二套复杂系统。

---

## 配置（`tests/quality/config.json`）

runner 与各检查脚本**不再硬编码策略**，一律从此文件读取：

```json
{
  "security":  { "failClosed": true },
  "database":  { "fixtureOnly": true, "fixtureDir": "artifacts/quality/desktop-fixture",
                 "databaseFilename": "costhub.db",
                 "fixtureMarkerKey": "quality_fixture", "fixtureMarkerValue": "1" },
  "tests":     { "allowFailure": false, "flakeRetryMax": 1 },
  "lint":      { "baseline": true, "baselineFile": "tests/quality/lint-baseline.json", "required": false },
  "report":    { "leakCheckBeforeFinalize": true, "draftBasename": "summary.draft" },
  "limits":    { "maxFileLines": 300, "enforcedDirs": ["tests/quality"] },
  "fixture":   { "passwordEnvVar": "QUALITY_TEST_PASSWORD", "username": "agent-test", "seedProjectCode": "QAFIX-0001" }
}
```

**配置缺失或非法时 fail closed**（`helpers/config.mjs` 会抛错终止）。其中三项是硬约束，
即使写进配置也不允许关闭 —— 尝试关闭会直接报 `QUALITY_CONFIG_UNSAFE`：

```text
security.failClosed       必须为 true    （禁止 fail-open）
database.fixtureOnly      必须为 true    （禁止指向非 fixture 数据库）
tests.allowFailure        必须为 false   （容忍 required 失败的门禁不是门禁）
```

---

## 步骤清单

### core（10 步）

| ID | 步骤 | required | 保护的回归项 |
|---|---|---|---|
| Q01 | TypeScript/Vite Build | ✅ | — |
| Q02 | Vitest All（**单次执行**，reporter 采集结果） | ✅ | — |
| Q03 | Vitest boundary classification（**不重跑**，按结果分类） | ✅ | REG-PRIV-001/002、REG-CLOUD-001、REG-APPROVAL-001、REG-STORE-001、REG-AGENT-001 |
| Q04 | Rust Unit Tests（`cargo test --lib`） | ✅ | — |
| Q05 | Agent Deterministic Eval/Test | ✅ | REG-AGENT-001 |
| Q06 | Lint capture（留档，不参与判定） | ⬜ 否 | — |
| Q07 | **Lint baseline gate**（不得新增问题） | ✅ | — |
| Q08 | Harness self-check（脱敏 + DB guard，48 项断言） | ✅ | REG-DB-001 |
| Q09 | Regression catalog integrity | ✅ | — |
| Q10 | File size gate（单文件 ≤ 300 行） | ✅ | — |

> **Q03 取代了 V1 的 Q04–Q07。** V1 为了让「隐私/网关/审批/resultStore」各占一行结论，
> 把这批文件重复跑了一遍。V2 改为对**同一次执行**的结果按文件归类：
> 报告里仍有各边界的独立结论，但不再有重复执行。
>
> **Q06/Q07 的分工**：lint 基线本来就是失败状态，退出码恒为 1，无法区分「还是那 113 个」
> 与「新增了 5 个」。因此 Q06 只负责把 eslint 输出留档（总是 pass），Q07 解析输出并比较**数量**。

### full（叠加在 core 之上，共 13 步）

| ID | 步骤 | required | 说明 |
|---|---|---|---|
| F01 | Desktop fixture prepare | ✅ | 用被测程序自身 bootstrap 出 schema，再写入测试账号 + `quality_fixture=1` + 合成项目；**密码来自环境，不落明文** |
| F02 | Fixture executable check | ✅ | exe 存在/体积合理/夹具目录无凭据残留 |
| F03 | Desktop E2E-001..008 | ✅ | 真实 WebView2 + CDP |

### live（叠加在 full 之上，共 16 步）

| ID | 步骤 | required |
|---|---|---|
| L01 | Ollama status probe | ✅（探测不到 → blocked，退出码 3） |
| L02 | Real tool smoke | ✅（同上） |
| L03 | Real summary evidence | ✅（同上） |

---

## 安全边界（Harness 自身）

1. **core / full 不联网**：没有真实搜索 API、没有云端 LLM、不读取任何 API Key。
   `live` 档的本地模型探测被硬限制为回环地址（`ollamaUrls.mjs` 拒绝非 loopback）。
2. **不写正式数据库**：桌面 E2E 只能跑在 fixture 上，且路径必须先通过**严格目录白名单**（见下）。
3. **报告自动脱敏**：所有进入 JSON/Markdown 的文本先过 `helpers/redact.mjs`。
   该模块是测试侧独立实现，**不 import 生产隐私模块**，避免把应用运行环境依赖拖进纯 Node runner。
4. **不允许「为了绿灯放宽」**：`runtime-error-allowlist.json` 的 `errors` 默认为空。
5. **仓库无明文 fixture 密码**：见下「fixture 凭据」。

### 数据库白名单（REG-DB-001）—— V2 从「特征匹配」改为「严格目录白名单」

V1 用**正则匹配路径特征**判断 fixture，存在误判风险：
`D:/project/quality-old/test.db` 这类路径含 "quality" 关键词，可能被放过。

V2 改为 `path.relative()` 严格判断。判定顺序（任一不满足即拒绝，不回退）：

```text
1. path.relative(fixtureRoot, dbPath) 不以 .. 开头、不是绝对路径、不为空
       └─ fixtureRoot 来自 config.database.fixtureDir
          （默认  <repo>/artifacts/quality/desktop-fixture）
2. basename == config.database.databaseFilename            （默认 costhub.db）
3. 路径中不含任何禁止段：
       src / src-tauri / data / database / production / prod / target / release / exports / backups
4. 文件存在且可只读打开
5. PRAGMA integrity_check == 'ok'
6. settings 表存在
7. settings[config.database.fixtureMarkerKey] == config.database.fixtureMarkerValue
```

**没有正则，没有关键词匹配。** `seedFixture()` 写库前也走同一套白名单判断（写操作同样 fail closed）。

`self-check.mjs` 用 17 项断言钉住这套行为，其中包含两条**验收用例**：

```text
✖  src/costhub.db                                          → 必须 FAIL（被拒）
✔  artifacts/quality/desktop-fixture/costhub.db             → 必须 PASS（被接受）
✖  artifacts/quality-old/costhub.db                         → 必须 FAIL（V1 会误判的回归用例）
✖  <fixtureRoot>/../escaped/costhub.db                      → 必须 FAIL（.. 逃逸）
```

### fixture 凭据（V2：禁止明文密码）

仓库中**不得**出现明文 fixture 密码（V1 曾在 fixtureData / actions / README 中硬编码一个固定口令）。
V2 的解析优先级：

```text
1. 环境变量  QUALITY_TEST_PASSWORD                       ← CI 或人工提供，便于复现与排查
2. 运行目录下的一次性文件  <runDir>/.fixture-credential   ← runner 生成后写入，权限 0600
3. 新生成一次性随机密码                                   ← 24 字节 base64url
```

* 密码**不写进 git、不写进报告、不写进夹具 manifest**（manifest 只记录 `passwordSource`）。
* 该变量已加入报告脱敏白名单，即使意外出现在日志里也会被逐字抹除。
* `self-check.mjs` 会扫描整个 `tests/quality/` 目录，确认没有 V1 的明文口令残留。
* 为什么不是「没有环境变量就直接失败」：那会让 `quality:full` 在未预设变量时必定失败，
  与 V2 目标「避免质量框架增加维护成本」冲突。随机生成同样满足「禁止明文」，且开箱可用。

**为什么要一次性文件**：`quality:full` 会顺序启动 **多个独立进程**
（`prepare-fixture.mjs` 建库、`run-e2e.mjs` 登录），它们不共享内存。
若两边各自随机生成，密码必然不一致，登录就会失败。因此 runner 生成一次并落盘到运行目录。

> `artifacts/` 整体被 `.gitignore` 忽略，因此该文件不会进入版本库。

### 报告泄漏检查的范围（V2 收窄）

V1 扫描 `artifacts/quality/` 下所有 `.json/.md/.txt/.log`，会把碰巧放在同目录的中间产物
（vitest JSON reporter 输出、eslint 输出缓存）也当成「质量报告」扫，导致误报。

V2 只扫描**本次运行明确产出的报告**（由 runner 通过 `--reports` 传入）。
扫不到目标文件时 **fail closed** —— 不能因为「没找到文件」就算通过。

同时 `private_key_block` 规则改为要求 `BEGIN` 与 `END` **同时出现**，
避免把「测试用例名里提到私钥头」当成真泄漏
（`privacyRouter.test.ts` 的用例名就是 `guards -----BEGIN PRIVATE KEY-----`）。

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
  config.json                   策略配置（runner 与各检查从此读取，不再硬编码）
  lint-baseline.json            lint 问题数上限（只允许减少，不允许新增）
  self-check.mjs                Q08：脱敏 / DB guard / 配置 / 凭据 的自我验证（48 项断言）
  check-catalog.mjs             Q09：回归目录引用完整性（防止「纸面保护」）
  check-report-leaks.mjs        泄漏检查（只扫**本次运行**的报告，范围收窄避免误报）
  classify-vitest.mjs           Q03：把单次 vitest 执行结果按边界类别归类
  categories.mjs                归类规则（隐私/网关/审批/store/agent/桌面契约）
  capture-lint.mjs              Q06：跑 lint 并留档输出（总是 pass，判定交给 Q07）
  lint-gate.mjs                 Q07：lint 基线比较，新增问题即失败
  file-size-check.mjs           Q10：单文件行数门禁
  baseline-summary.mjs          Phase 0 基线归档（生成 environment.json / baseline-summary.json）
  regression-catalog.json       事故 → 测试 → 保护边界 的机器可读索引
  REGRESSION_CATALOG.md         同一索引的人类可读版
  helpers/
    config.mjs                  配置加载与 fail-closed 校验
    exec.mjs                    子进程执行（记录/超时/进程树清理/不存在即 blocked）
    redact.mjs                  报告脱敏（凭据模式 + 路径折叠 + 环境变量值逐字抹除）
    report.mjs                  summary.json / summary.md 生成与写盘
    phase-runner.mjs            步骤循环 + 抖动重跑 + 草稿报告
    console.mjs                 runner 的终端输出（banner / 汇总表 / 用法）
    environment.mjs             git 状态与工具链版本采集
    fixtureCredentials.mjs      fixture 凭据解析（env > 一次性文件 > 随机生成）
    dbGuard.mjs                 **严格目录白名单**证明、计数快照、integrity_check、夹具播种
  reporters/
    vitest-collect.mjs          Vitest 自定义 reporter（写逐测试结果 JSON）
  desktop/
    cdpClient.mjs               兼容入口（再导出 cdp/ 下的实现）
    cdp/client.mjs              CDP 连接 / RPC / 求值 / 等待
    cdp/events.mjs              runtime error 与告警采集、归一化、allowlist 分类
    cdp/browser.mjs             端口发现、受控输入、点击
    launchApp.mjs               夹具程序启动、空闲端口、进程树收尾
    actions.mjs                 兼容入口（再导出 actions/ 下的实现）
    actions/login.mjs           登录流程与就绪判断
    actions/aiPanel.mjs         AI 协作窗展开 / 状态采集 / composer 输入
    actions/navigation.mjs      一级导航点击与内容就绪等待
    actions/bom.mjs             项目选中与 BOM 页签渲染验证
    actions/settings.mjs        设置页打开与凭据泄漏形状检查
    actions/storage.mjs         测试侧 localStorage 读写
    manifest.mjs                夹具 manifest 与 settings key 快照
    scenarios/mainSession.mjs   E2E-001..006（同一进程会话）
    scenarios/restartPersistence.mjs  E2E-007（跨进程重启）
    fixtureData.mjs             合成夹具数据（项目 + BOM 行，schema 自适应）
    prepare-fixture.mjs         F01：生成隔离夹具
    check-portable.mjs          F02：夹具可执行文件检查
    run-e2e.mjs                 F03：编排、守卫、runtime error 门禁、报告
    runtime-error-allowlist.json
  live/
    ollama-status.mjs           L01：本地模型可用性（不存在 → blocked）
    ollamaUrls.mjs              回环地址白名单解析
```

### 单文件行数门禁

`config.limits.maxFileLines = 300`，由 Q10 强制。当前最大文件 299 行。
拆分时保留**兼容入口**（`actions.mjs`、`cdpClient.mjs` 只是再导出），
因此既有调用方不需要因为拆分而改动 —— 这是刻意的，避免「为了整洁把改动扩散出去」。

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

## lint 基线机制（V2 新增）

V1 把 lint 记为 non-blocking warning（理由是基线本身失败）。但那意味着**债务可以无限增长**。
V2 改为**基线制**：

```json
// tests/quality/lint-baseline.json
{ "gate": { "errors": 113, "warnings": 149, "total": 262 } }
```

* `current.total > baseline.total` 或 `current.errors > baseline.errors` → **失败**；
* 只允许减少，不允许新增；债务下降时可同步下调基线以锁定收益。

**为什么不看 `npm run lint` 的退出码**：基线本来就是失败状态（113 errors），退出码恒为 1，
无法区分「还是那 113 个」与「新增了 5 个」。因此 Q06 只留档输出，**Q07 解析输出并比较数量**。

解析不出问题数时 **fail closed**（看不懂不能算通过）；基线文件缺失同样 fail closed。

### 已知 lint 债务构成

| 项目 | 数量 |
|---|---|
| `.build-portable/` 打包产物造成的 Parsing error | **107**（配置噪声，非源码问题） |
| 源码 `react-hooks`「Cannot access refs during render」error | 6 |
| 源码 warning | 149（`no-useless-assignment` 38、`exhaustive-deps` 29、`no-useless-escape` 15、`prefer-const` 13 …） |
| **`npm run lint` 合计** | **263 → 已回到基线 262** |
| `src` + `tests` 单独跑 | 155（真实代码债口径，记入基线文件的 `sourceSubset`，仅作趋势） |

> 修掉那 107 个 error 只需往 `eslint.config.js` 的 `globalIgnores` 加入 `.build-portable/`，
> 但那属于**生产配置变更**，留待独立的 lint clean-up 轮次处理。

---

## flake 处理策略

`Q02 Vitest All` 在冷启动/CPU 争用下已知存在超时抖动
（`src/__tests__/costPackage.test.ts` 冷导入 `pptxgenjs` 链路偶尔超过 5s 默认超时；
基线实测 5 次中 1 次失败，且该次与 lint 并发）。

处理方式：允许**一次**重跑（上限由 `config.tests.flakeRetryMax` 控制），并且：

* 重跑通过 → 该步骤降级为 **warning**，在报告里明确标注 `flaky`，**不静默变绿**；
* 重跑仍失败 → 判为 **fail**，理由写明「failed twice — not a flake」。

这条规则同时适用于任何声明了 `flakeRetry` 的步骤。禁止用它掩盖真实回归。

---

## 报告产物

```text
artifacts/quality/<run-id>/summary.json     机器可读（finalize 后才产出）
artifacts/quality/<run-id>/summary.md       人类可读
artifacts/quality/<run-id>/.fixture-credential  一次性凭据（0600，gitignored）
artifacts/quality/latest-summary.json
artifacts/quality/latest-summary.md
artifacts/quality/vitest-collected.json     逐测试原始结果（供 Q03 分类）
artifacts/quality/vitest-classification.json/md  边界分类报告
artifacts/quality/lint-output.txt           eslint 原始输出（供 Q07 比较）
artifacts/quality/desktop-fixture/          隔离夹具（exe + costhub.db + manifest）
artifacts/quality/desktop-e2e.json          桌面 E2E 逐场景明细
```

**草稿 → 检查 → finalize 三阶段**（V2 要求 #3）：

```text
跑完全部步骤
   ↓
写 summary.draft.json / summary.draft.md
   ↓
泄漏检查（只扫这两个文件 → 保证校验的是本次运行的报告）
   ↓ 通过                          ↓ 不通过
写正式 summary.json/md             不产出正式报告（gate=FAIL）
删除草稿                           **保留草稿**供人工取证
```

`artifacts/` 整体被 `.gitignore` 忽略（含夹具 exe 与 db 副本），因此**报告不进入版本库**；
需要长期留存的结论写进仓库根部的 `QUALITY_HARNESS_V1_REPORT.md` 与 `QUALITY_HARNESS_V2_REPORT.md`。

---

## 兼容性

* 原有 `npm test` / `npm run test:agent*` / `npm run build` / `npm run lint` 全部保留，可单独运行。
* 原有 CDP 脚本（`tests/agent-upgrade/cdp-inspect.mjs`、`cdp-e01-upload.mjs`）保留未删，
  功能不变；新的 Harness 复用其连接思路但抽出为独立 helper。
* `actions.mjs` / `cdpClient.mjs` 拆分后保留为**再导出入口**，既有导入路径继续可用。
