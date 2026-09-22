# CostHub llama.cpp / 27B 四次验收

日期：2026-09-13；当前工作区 v2.3.19。

## 结论

**原有 9 个定向检查全部通过；完整长数据链仍有 1 个阻塞：全文续读结果没有总量上限。**

之前的修改确实解决了尾部单行不可达和多列预览超限。但不能只验证“指定一行能读出”，还必须验证模型按照指引直接打开全文时不会再次超出预算。本轮新增的正是这一步，属于上一轮同一验收要求。

## 本轮结果

| 检查 | 结果 |
|---|---|
| 原有两个定向脚本 | 9/9 通过 |
| 增加新断言前全量 npm test | 65 个文件通过，373 通过、2 跳过 |
| 新增默认全文续读检查 | 1 项失败 |
| 增加断言后重跑两个定向脚本 | 9 通过、1 失败 |
| Rust cargo test --lib | 20/20 通过 |
| npm run tauri build（包含 TypeScript 和前端构建） | EXE、MSI、NSIS 全部通过 |

发布产物：`src-tauri/target/release/costhub.exe`；安装包为同目录下 `bundle/msi/CostHub_2.3.19_x64_en-US.msi` 和 `bundle/nsis/CostHub_2.3.19_x64-setup.exe`。构建成功不代表已在公司电脑完成验收。

本轮只追加验收断言、日志和本报告，没有修改产品代码，没有操作正式数据库。全量“373 通过”是新增检查前的结果，不能据此声称当前所有测试通过。

## 唯一新增阻塞：续读又把全文一次塞回上下文（P1）

位置：`src/ai/piRuntime.ts` 中 read 对 `.costhub-results/` 的专用分支（约 124–135 行）。

现在每个长单元格按 4,000 字符拆成若干行，原生工具可以按行读取，这是有效改进。但是专用分支只限制行数，默认 40 行、最多 200 行，直接序列化全部选中行；没有限制总字符、字节或 token，也覆盖了业务工具保存的 JSON/TXT 结果路径。

最小复现：

1. 构造只有一个长单元格的 XLSX，包含 30,000 个中文字符。
2. 调用真实 read 读取 Excel，获得有界预览和 fullResultPath。
3. 按返回指引调用 `read({path: fullResultPath})`，不指定 limit。
4. 返回 **30,777 字符**，生产预算估算 **45,307 tokens**；32K 模型配置的输入硬预算为 **21,954 tokens**。

这是应用自己的估算，不是服务端 tokenizer 实测。仅这个工具结果就超过输入预算，后续对话还要叠加原请求、工具 schema 和其他证据。因此“落盘后能续读”尚未形成可用闭环。

## 最小返修要求

- 在共用结果续读分支，按最终响应总量累积行/片段；limit 只是请求的行数上限，不保证一定返回这么多。
- nextOffset 或片段游标必须指向实际未返回的内容；默认调用也要受同样限制。
- 超长单行要继续分片，覆盖旧业务 JSON 结果，不能靠隐藏内容、改小模型上下文或要求用户启用 Shell 处理。
- 验证“预览→默认打开全文→依据游标读完”全过程：每次结果有界、最终可重建原始长文本和定位信息，无漏字/重复字，尾部证据可达。

无需重写 runtime 或引入新框架。修复点是结果读取函数，不应继续仅缩短 Excel 预览。

## 复现脚本

追加在 `docs/check-llama-reacceptance.test.ts`：`bounds a default follow-up read of the saved long-cell result`。它使用实际 createExecutionEnv、XLSX、read 和生产预算函数，只模拟 Rust IPC 的存储边界。

```powershell
npx vitest run docs/check-llama-acceptance.test.ts docs/check-llama-reacceptance.test.ts --silent=false
```

当前 9 通过、1 失败；日志：`docs/check-llama-fourth-result.txt`。修复后保留该断言及之前所有用例。

本轮未复验真实窗口、公司 27B、视觉 mmproj 或独立部署目录。以前的小模型 HTTP 结果不作为新的实机证据；本报告也不宣称除上述问题外已穷尽所有业务边界。

## 返修后复核（2026-09-13）

- `.costhub-results` 默认续读现在按最终响应字符预算截取，`limit` 仅作为行数上限；超长行同时返回 `nextOffset` 和 `nextCharOffset`，可无 Shell 连续读取。
- 结果文件使用行/字符块格式，单次续读不会把全文重新放入上下文，仍保留工作表、行号、列号和块序号定位信息。

返修后前四轮定向检查 10/10 通过；全量前端测试 374 通过、2 跳过，`npm run tauri build` 的 EXE、MSI、NSIS 均通过。真实 27B、视觉 mmproj、公司电脑桌面交互和独立部署目录仍需现场验收。
