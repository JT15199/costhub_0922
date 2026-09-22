# CostHub llama.cpp / 27B 三次验收

日期：2026-09-13，07:50–07:53；对象：当前工作区 v2.3.19。

## 结论

**前两轮 7 个定向用例全部通过；长数据读取仍有 2 个未闭环问题，暂不通过完整验收。** 这两项延续第二轮 R2 的要求，并非另开改造范围：预览必须有总量上限，完整证据必须能通过已提供的工具取回。

本轮只扩展验收脚本、生成日志和报告，没有修改产品实现，没有向正式数据库写入测试数据。

## 验证结果

| 检查 | 本轮结果 |
|---|---|
| 前两轮原有定向检查 | 7/7 通过 |
| 本轮增加的全文续读、宽行检查 | 2/2 失败 |
| 最终全量 `npm test` | **371 通过、2 失败、2 跳过**，64 个文件通过、1 个文件失败 |
| Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 20/20 通过 |
| `npm run tauri build`（含 TypeScript、前端构建） | EXE、MSI、NSIS 全部构建通过 |

首轮全量测试出现 costPackage 的 5 秒超时；针对性重跑及最终全量均通过该项，未复现功能失败。没有改超时值或跳过测试。最终两个失败都来自本轮补充的长数据断言。

产物：`src-tauri/target/release/costhub.exe`，生成时间约 07:52:40，25,750,528 字节；安装包为 `bundle/msi/CostHub_2.3.19_x64_en-US.msi` 和 `bundle/nsis/CostHub_2.3.19_x64-setup.exe`（均相对 release）。构建通过不等于实际公司电脑已验证。

## 已修复确认

- 源样例与导出 XLSX 都转成 Uint8Array 后写入，0 字节问题消失；样例按实际 nextOffset 续读并完成 450 行核对。
- calc 非法表达式正确返回失败。
- 原超长单行的可见预览已缩短，之前的预算断言通过。
- 断流、缺失导入目标、sheet schema、普通多表读取的旧检查持续通过。
- 设置页代码复核：取消后保留当前 controller，结束时按身份清理；刷新模型列表时校验旧模型；sample.reason 纳入诊断清理；read 说明区分 Excel 0-based 与普通文本 1-based。本轮没有进行真实窗口交互，不把代码复核写成桌面实测。

## 剩余问题一：全文路径存在，但超长单元格末尾仍无法读取（P1）

位置：`src/ai/piRuntime.ts:151` 的落盘/续读指引，及非 Excel 分支委托的原生 read。

复现：一个单元格约 30,000 个中文字符，末尾附唯一证据 `CELL-END-EVIDENCE-927`。Excel read 返回缩略预览和 fullResultPath。即使直接给原生 read 正确的文件路径、行号和 limit=1，仍只返回：

```text
[Line 16 is 87.9KB, exceeds 50.0KB limit. Use bash: sed -n '16p' ... | head -c 51200]
```

JSON 序列化后长字符串保持一整行，超过原生 read 的单行字节上限；模型拿不到末尾证据。默认 shellEnabled=false 时没有 Bash 工具；即使运行提示里的 head 命令，也只取头部。

要求：提供不依赖 Shell 的有界字符/字节续读，或把长单元格落成可定位、可分页的片段，保留源单元格与原文对应关系。不能仅提示“用 read 读全文”，也不要放大整个工具结果/模型预算来回避问题。

验收应证明**经实际模型可用工具**能取回末尾标记，同时每次返回都在预算内。若改变接口，允许调整本轮续读测试的调用方式，但必须保留“尾部证据可达、无需 Shell”的断言。

## 剩余问题二：限制单元格长度，不等于限制整个预览（P1）

位置：`src/ai/piRuntime.ts:136-151`。

复现：一行 300 列，每格 160 个中文字符。行数降到 1 后无法继续缩减；previewCell 只处理长度大于 160 的字符串，预览再次包含全部列。

实际输出 **52,698 字符**，生产预算估算 **73,488 tokens**，32K 配置输入硬预算为 **21,954 tokens**。这是应用估算值，不是服务端 tokenizer 实测。

要求：对最终序列化后的整个预览执行总量约束，覆盖行数、列数、单元格长度及元数据；超出部分使用可定位的续读方式。不要只继续降低“每格最多字符数”，否则列数增加后仍会失败。上一项和本项应作为同一条“保存→预览→续读”链路一起解决。

## 复现

本轮在已有 `docs/check-llama-reacceptance.test.ts` 追加两个断言，使用真实 createExecutionEnv/read/XLSX，只有 Rust IPC 存储边界使用内存模拟。为普通 read 补齐了模拟的 exists 操作，没有模拟其截断逻辑。

```powershell
npx vitest run docs/check-llama-acceptance.test.ts docs/check-llama-reacceptance.test.ts --silent=false
```

当前预期：7 通过、2 失败。全量日志保存在 `docs/check-llama-third-result.txt`。修复后保留有效断言，重跑全量与构建。

本轮未重跑本机 4B HTTP 烟测，未进行 27B 实机、mmproj 视觉、非开发目录启动和正式报价副本的桌面验收；不存在新的模型速度或任务完成率结论。AGENTS.md 末尾仍写旧的 363 项测试结果，下一次交付应同步最新结果及验证边界。

## 返修后复核（2026-09-13）

- 长单元格全文结果改为可定位的分块文本；原生 `read` 对 `.costhub-results` 提供无 Shell 的 `offset/limit` 续读，单次只返回当前行块，尾部证据可达且不会重新塞入整行。
- Excel 预览增加整行列数上限和最终序列化总量上限，覆盖宽行、长单元格、元数据和多行场景；超出部分返回定位提示及 `fullResultPath`。

返修后前两轮 7 项及本轮 2 项定向检查全部通过；全量前端测试 373 通过、2 跳过，`npm run tauri build` 的 EXE、MSI、NSIS 均构建通过。真实 27B、公司电脑桌面交互和非开发目录运行仍不在本地自动化范围内。
