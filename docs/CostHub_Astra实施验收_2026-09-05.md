# CostHub Astra 实施验收 · 2026-09-05

**结论：暂不通过。已有有效修复，但尚不能认定设计蓝图的 P0 已完成。**

本轮核对当前工作区实现与《Astra 设计复核与实施蓝图》，重点复核实施记录中“完整依赖包、严格金额、冻结事实、凭据外发”四类承诺。没有重做产品设计，没有修改业务代码，没有读取正式数据库、使用真实密码/API Key 或发出云端请求。

审查对象为未提交工作区，Git HEAD 为 `512da5388ad109cf48ccd008126812e64424f81d`。工作区包含此前改动，以下发现不将全部差异归因于本次实施。

## 实测结果

| 本轮实际执行 | 结果 | 可以证明的范围 |
|---|---|---|
| `npm test -- --reporter=dot` | 50 个文件、333 项通过 | 现有前端测试覆盖的行为 |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` | 9 项通过 | 现有 Rust 离线测试覆盖的行为 |
| `npm run build` | 通过，包含 TypeScript 检查 | 当前前端可构建；仍有大分块提示 |
| 新增隔离验收脚本 | **13 项：4 通过、9 不满足验收要求** | 实际源码函数配合内存 SQLite/读取替身；不覆盖桌面 IPC 和真实网络 |

复现脚本：[review-astra-acceptance-20260905.mjs](<D:/AI coding folder/costhub/docs/review-astra-acceptance-20260905.mjs>)。在工程根目录运行 `node docs/review-astra-acceptance-20260905.mjs`，需要支持 `node:sqlite` 的 Node 和现有 TypeScript 依赖。当前退出码 1 是未满足验收要求的预期结果；修复后应改为通过，不能反改断言去接受错误结果。脚本剥离静态导入并使用明确替身，不连接应用数据库。

已通过的正向样例：有效旧密码哈希仍可登录且明文被删除；确认零价保持为零；完整包保留两个领域的有符号变化；报告样例确实使用冻结 BOM。以下问题不否定这些修复，但现有测试全绿不足以覆盖业务反例。

## 必须返修

### A01 · P1 · 密码清理早于安全迁移（原票 P0-01）

位置：[auth.ts](<D:/AI coding folder/costhub/src/db/auth.ts:7>)，重点第 10–17 行。

`ensureAuthPassword` 先删除旧明文，再读取哈希；哈希缺失时写默认密码，异常只记录后返回。内存 SQLite 实测：只有旧明文的库升级后默认密码可登录；在写入哈希处注入中断后，旧明文已经删除且没有可工作的哈希。正常哈希库已通过清理，但旧库异常与中断路径仍违反“不得重置密码、不得锁死”的验收要求。

最小修复：先验证迁移前置条件，再原子更新和清理；不能恢复时明确失败并保留可恢复状态，不能自动重置为默认密码。无需重建账户系统。

### A02 · P1 · 变更包仍可漏掉必增项，且缺口被低估（原票 P0-07）

位置：[architecture.ts 包校验](<D:/AI coding folder/costhub/src/db/architecture.ts:163>)、[机会汇总](<D:/AI coding folder/costhub/src/db/architecture.ts:283>)、[确认入口](<D:/AI coding folder/costhub/src/db/architecture.ts:235>)。

输入为同一包：硬件 100→80，必要线材 5→20，财务目标 90，平台费率 0。

| 情况 | 应有结果 | 当前实测 |
|---|---|---|
| 两行证据完整 | 领域目标 80/20，净机会 5，剩余缺口 10 | 领域目标正确，但机会为 **20**、缺口为 **0** |
| 必要线材行缺少证据 | 整包待补，不承诺硬件节省 | 跳过线材，仅保留硬件 **−20** |

根因是先逐行 `continue` 再分包；`dependency_role` 未用于整包校验。汇总又只加各领域的负向 delta，忽略配套增本。确认入口也没有完整性检查，不能假设进入计算的 confirmed 包已经合法。

最小修复：先按包验证必需行、证据和适用范围，再计算完整有符号向量；总机会与目标总额、剩余缺口使用同一个净额。不可拆包凑目标。以上两组样例必须同时通过。

### A03 · P1 · 非法金额仍能被确认，负数量仍能冻结最终 BOM（原票 P0-05）

位置：[contracts.ts](<D:/AI coding folder/costhub/src/ai/contracts.ts:129>)、[冻结入口](<D:/AI coding folder/costhub/src/db/architecture.ts:194>)；真实页面调用为 [TenderWorkspace.tsx](<D:/AI coding folder/costhub/src/components/TenderWorkspace.tsx:107>)。

隔离实测：`price_state='confirmed'` 时，缺失价格被算为 0，负价格被算为 −5。状态字段直接覆盖了金额合法性验证。另以数量 −1 调用 `freezeProjectBOMVersion(..., {sourceType:'final_bom'})`，函数成功返回，仍写入 frozen 状态；缺口只改变 cost_status，没有阻止最终冻结。

最小修复：金额必须先通过数值/范围验证，confirmed 只能区分合法零价与未确认值；最终冻结在修改旧版本状态前拒绝非法/缺失输入。若需保存不完整估算，应明确使用对应状态，不能经“最终 BOM”入口成功冻结。三个反例均需通过。

### A04 · P1 · 冻结 BOM 被配上最新规格（原票 P0-06/P1-06）

位置：[CostPackageButton.tsx](<D:/AI coding folder/costhub/src/components/CostPackageButton.tsx:81>)，以及第 93、113 行。

样例冻结 BOM 绑定规格 ID 1（60 Hz），后续新建规格 ID 2（144 Hz），BOM 行未改变。实际 `loadSnapshot` 返回 `bomState='frozen'`，但规格引用变成 **2**。函数保存了冻结项目快照，却在导出时读取 `getLatestProjectSpecBaseline`，参考项目也存在相同问题。由此生成的规格比较可能不属于所引用的历史 BOM。

最小修复：冻结路径从该版本的规格引用/快照读取；缺少历史规格则报告缺失。草稿路径才读取当前规格。预览和导出应绑定同份来源，不能把两代事实拼在一起。

### A05 · P2 · 新生成的阶段成本包立即显示过期（原票 P0-06/P1-06）

位置：[生成指纹](<D:/AI coding folder/costhub/src/components/CostPackageButton.tsx:115>)、[成果库重算指纹](<D:/AI coding folder/costhub/src/db/artifacts.ts:90>)。

实际调用 `loadSnapshot` 后将其结果交给 `getAnalysisLibraryItems`，BOM/目标版本和数据均未变，返回 freshness **stale**。生成侧加入 `skuSnapshot`、`packageRefs`，成果库仍对旧字段集合计算；规格两侧也存在来源差异。这会让“是否过期”失去判断价值。

最小修复：两端复用同一来源对象和指纹算法；覆盖不变仍 current、BOM/规格/SKU/费率/参考关系/报价改变后正确变化。不要关闭过期提示来掩盖差异。

### A06 · P1 · 云端请求与凭据目的地未完整绑定（原票 P0-02/03/04）

位置：[请求 DTO](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:38>)、[实际发送](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:1661>)、[前端调用](<D:/AI coding folder/costhub/src/trendService.ts:310>)。

本项为**源码路径确认，未发真实网络请求，也未验证真实密钥泄露**：

- 后端校验只接收 URL/method/body/approval，随后把前端传入的全部 headers 发出；请求头中的额外内容未进入审批校验。
- `provider_id` 和 `secret_mode/secret_name` 均来自调用者。校验通过后直接按 ID 解密密钥，未从后端 provider 配置核对该密钥的目标端点；因此批准给供应商 B 的合法请求并未在此函数拒绝使用供应商 A 的凭据。
- query/body 模式在校验后继续修改请求。最终外发内容与经过校验的对象并不相同。
- 授权权威也未完成蓝图要求的隔离：[票据读取仍来自业务库](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:1302>)，而 [主窗口仍有通用 SQL 写权限](<D:/AI coding folder/costhub/src-tauri/capabilities/default.json:10>)。本轮未执行伪造票据，不把该项记为已通过。

DPAPI 改善了静态凭据存储，但不能单独证明外发安全。最小修复是后端按 provider 身份构造固定端点、认证位置和允许头，校验最终请求；补离线构造/传输替身测试，覆盖头注入、错配凭据、审批后参数变化及业务库伪造票据。不要增加另一个通用 HTTP 接口。

## 交回实施的范围与验收顺序

保留已有有效修复。建议分小批收口：A01；A03+A02；A04+A05；A06。每批只修对应根因并补最小回归，不能把 333/9 通过作为这些缺口已消失的替代证据。

本轮新增上述报告和复现脚本，未改业务源码。返修后先运行隔离脚本与相关现有测试，再进入桌面验收：登录迁移、BOM 导入/冻结、目标确认、成本包预览/导出/成果新鲜度、缩放和低动效、Ollama 停止/恢复。真实云端供应商、跨电脑凭据恢复、模型速度和正式数据流程本轮均未验收。

实施记录中“无完整证据的包不进入机会池”“未知成本不再折算为零”“当前数据变化不会漂移已冻结历史”等表述应在上述反例修复后再确认。其余蓝图票据不因本轮未发现新问题而自动通过。
