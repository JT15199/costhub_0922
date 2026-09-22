# Astra 返修复验 · 2026-09-05

**结论：部分修复通过，整体仍未通过。** 本轮针对上次 A01–A06 复验，没有重新展开设计，也没有修改业务源码。

## 当前实测

| 检查 | 本轮结果 |
|---|---|
| 上轮原有隔离样例 | **13/13 通过**，原断言未放宽 |
| 前端现有测试 | **50 个文件、333 项通过** |
| Rust 现有离线测试 | **10 项通过** |
| `npm run build` | **通过**，仍有大分块提示 |
| 扩充后的业务隔离脚本 | **16 项：13 通过、3 失败** |
| 新增真实 Rust 请求头函数隔离检查 | **3 项：2 通过、1 失败** |

确认已修复：原先明文缺哈希时重置默认密码的样例、迁移写入中断样例、缺价/负价冒充 confirmed、负数量冻结、完整包净额和必要证据、冻结规格 ID 混用、相同来源生成即过期的原始样例。

上轮报告样例的冻结行保留了 `part_cost`，这不是实际冻结表字段，因此不足以验证真实冻结报告。本轮保留原样例并补充正确表结构，发现下面的回归；不能用原 13 项通过代替这项验证。

## 仍需修复

### B01 · P1 · 正常冻结 BOM 的成本全部变成待补证据

位置：[CostPackageButton.tsx:118](<D:/AI coding folder/costhub/src/components/CostPackageButton.tsx:118>)；字段依据：[core.ts:189](<D:/AI coding folder/costhub/src/db/core.ts:189>)，金额校验：[contracts.ts:129](<D:/AI coding folder/costhub/src/ai/contracts.ts:129>)。

真实冻结表保存 `unit_cost`、`line_total`，没有 `part_cost/cost`。报告把冻结行交给只识别后两者的 `bomPriceState`，这次加强校验后，即使行状态 confirmed、数量合法、金额完整，也会被识别为 unknown。

隔离输入两行已确认冻结成本 100+5，期望 `{cost:105,status:'confirmed'}`，实际 `{cost:null,status:'unknown'}`。报告首页和领域成本因此显示待补证据。这是正常冻结流程的回归，不是旧库缺字段的特例。

最小修复：在冻结读取边界统一金额字段/状态契约，或让严格校验明确支持冻结行类型；不能撤销缺价校验，也不能改用当前器件库价格补历史值。必须使用真实冻结列名验证总额和领域金额。

### B02 · P2 · 草稿费率改变后，成本包指纹不变

位置：[CostPackageButton.tsx:131](<D:/AI coding folder/costhub/src/components/CostPackageButton.tsx:131>)、[artifacts.ts:119](<D:/AI coding folder/costhub/src/db/artifacts.ts:119>)。

无冻结版本的同一草稿，BOM 为 105，费率从 0% 改为 10%。两次报告读取到的费率分别为 0/10，标准成本随之变化，但 `dataFingerprint` **相同**。当前两端虽对齐了原字段集合，却都遗漏费率；报价/定点等已出现在正文里的来源也不在该集合中。

最小修复：生成侧和成果侧共同使用覆盖实际报告来源的对象，纳入费率、引用关系、报价/定点等影响正文的字段。仅把相同旧字段复制两份不能保证报告新鲜度。验收至少包含“数据不变保持 current”和“草稿只改费率也能失效”。

### B03 · P1 · 非法旧哈希仍会触发删除唯一恢复密码

位置：[auth.ts:13](<D:/AI coding folder/costhub/src/db/auth.ts:13>)、[auth.ts:28](<D:/AI coding folder/costhub/src/db/auth.ts:28>)。

此次已修复“无哈希”和中断路径，但 `if (hash)` 仍把任何非空字符串当作有效哈希。内存 SQLite 中放入截断哈希与一个合法旧明文后，初始化成功返回、明文被删，旧密码无法验证。

最小修复：清理前验证已有校验记录有效性；遇到损坏/不一致应安全恢复或明确失败并保留恢复条件，不能仅因非空而删除旧值。本轮没有使用任何真实密码或数据库。

### B04 · P1 · 请求头仅校验名称，允许值仍可携带未审批内容

位置：[lib.rs:1806](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:1806>)，发送路径：[lib.rs:1915](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:1915>)。

从当前源码提取 `safe_provider_headers`，用已安装 rustc 原样编译执行：普通 JSON 头通过、`X-Private` 被拒绝，但 `Accept: application/json; note=SYNTHETIC_PRIVATE_MARKER` **被接受**。最终请求校验对象仍没有 headers，随后该值原样进入发送器。

最小修复：后端按供应商模板固定必要的 Accept/Content-Type，或对完整值做有限校验；禁止任意参数。此处需要验证最终传输内容，不能只验证头名称。本轮仅运行纯函数，未发送网络请求。

### B05 · P1 · 授权库换了文件，但主窗口通用 SQL 能力未隔离

位置：[独立库路径](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:271>)、[插件注册](<D:/AI coding folder/costhub/src-tauri/src/lib.rs:2202>)、[主窗口权限](<D:/AI coding folder/costhub/src-tauri/capabilities/default.json:9>)。

**本项为源码路径确认，未打开或伪造正式授权库。** 新授权和凭据库在同一进程可读写目录下；main 仍有 `sql:allow-load/execute/select`，插件使用默认构造，没有限制加载的数据库。已核对本机 tauri-plugin-sql 2.4.0：load 接收调用者连接字符串，SQLite `path_mapper` 使用 `PathBuf::push`，绝对路径不会被限制在应用配置目录；execute 对已加载库接受任意 SQL。因此移动至 `costhub-cloud-authority.db` 本身没有切断渲染层访问该文件的能力。

本机依赖证据：[commands.rs:13](<C:/Users/96529/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-sql-2.4.0/src/commands.rs:13>)、[wrapper.rs:319](<C:/Users/96529/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-sql-2.4.0/src/wrapper.rs:319>)。这些路径是本机依赖位置，不是要修改依赖缓存的建议。

最小修复：在实际 IPC/数据库能力边界阻止渲染层打开、附加或写入授权/凭据库；授权签发还需可信确认。保留正常业务数据功能，用隔离桌面环境验证私有库 load/ATTACH/写票据均被拒绝。只从前端删除票据操作函数不构成安全隔离。

## 复测方式与交回范围

保留本次已通过的 A02/A03 样例和冻结规格修复，不必回滚。优先修 B01；B02/B03 各自收口；B04/B05 合并检查同一外发安全边界。

运行 [业务复验脚本](<D:/AI coding folder/costhub/docs/review-astra-acceptance-20260905.mjs>)：`node docs/review-astra-acceptance-20260905.mjs`。当前 13 passed / 3 failed。

运行 [请求头复验脚本](<D:/AI coding folder/costhub/docs/review-astra-cloud-20260905.mjs>)：`node docs/review-astra-cloud-20260905.mjs`。当前 2 passed / 1 failed；只在 `src-tauri/target/review-astra` 写入检查源码和二进制，无网络、无数据库访问。

本轮只新增报告/请求头脚本，并扩充已有业务复验脚本。没有修改业务源码、读取正式库、触发真实外发或正式冻结。桌面 UI、真实 IPC 防护、DPAPI 迁移、模型速度、实际导出文件仍未验收，不能因构建和单元测试通过而写成整体验收通过。
