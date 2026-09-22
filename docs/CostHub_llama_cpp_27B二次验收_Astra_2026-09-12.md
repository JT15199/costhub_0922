# CostHub llama.cpp / 27B 二次验收

时间：2026-09-12 22:11–22:15；对象：当前 v2.3.19 工作区。对照第一次 Astra 验收报告逐项复验。

## 结论

**上次 4 个定向用例全部修复，但完整验收仍未通过。** 本轮扩展到真实文件适配器和长单行后，新增 3 个断言全部失败。没有修改产品实现、没有向正式数据库写测试数据。

## 本轮检查结果

| 检查 | 结果 |
|---|---|
| 原验收脚本 `docs/check-llama-acceptance.test.ts` | 4/4 通过；断言未被跳过或削弱 |
| 扩展检查之前的全量 `npm test` | 64 个文件通过，368 通过、2 跳过 |
| Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 20/20 通过 |
| `npm run tauri build`（含 tsc、前端 build） | EXE、MSI、NSIS 构建通过 |
| 新增 `docs/check-llama-reacceptance.test.ts` | **3/3 失败** |

本轮 EXE：`src-tauri/target/release/costhub.exe`，生成时间 22:13:36，25,745,920 字节。安装包位于 `src-tauri/target/release/bundle/msi/CostHub_2.3.19_x64_en-US.msi` 与 `src-tauri/target/release/bundle/nsis/CostHub_2.3.19_x64-setup.exe`。这些是构建结果，不表示公司电脑已经验收。

新增脚本保留在 docs；此后运行全量测试也会收集新的失败，不能继续笼统写“所有测试通过”。

## 已确认的改善

- 模型断流产生的 error 会从 Host 抛出，原先半句答案被当成完成的问题在旧复现中消失。
- BOM 导入目标不存在已返回失败，几个写工具的空数据/未找到目标也改成明确抛错。
- Pi read 已暴露 sheet，默认只读首个工作表并提供 availableSheets；原 5 张表 × 450 行 × 20 列的检查通过。
- 设置页取消按钮不再 loading，原先 Ant Design 阻止点击的原因已移除。
- 托管启动显式使用配置端口构建 URL，轮询使用本地 ready 返回值，不再依赖旧 health 闭包。
- 诊断增加导出内容说明，model 改成文件名，工具探针原因做了初步路径清理。

后面三项是代码复核结果，本轮没有真实桌面点击验收。

## 仍需返修的三项（有可执行复现）

### R1 / P1：真实样例入口会把 XLSX 写成 0 字节

位置：`src/ai/piCapability.ts` 的 `runLocalProductionSampleAcceptance`，两处 `XLSX.write(..., { type: 'array' })`；`src/ai/piExecution.ts` 的 `base64FromBytes` 和 `writeFile`。

`XLSX.write` 返回 ArrayBuffer，生产 `writeFile` 的二进制分支按 Uint8Array 处理。ArrayBuffer 没有 `.length`，编码循环执行 0 次，发给 Rust 的 base64 是空串。

本轮用真实 `createExecutionEnv`，只在 Rust IPC 层模拟存储，记录到首个二进制写入 **0 字节**，随后真实 read 报 `worksheet not found: 报价样例`。现有 localBackend 单测直接将传入对象保存进 Map，绕开了此编码过程，因此假通过。

最小修复：两处输出明确转换为 Uint8Array 后传入既有接口；或在确实要支持 ArrayBuffer 的共用接口规范化输入。核对同类调用者，不能只补样例源文件而漏掉导出文件。保留使用生产适配器的回归检查，并确保源文件与导出文件都非空且回读内容一致。

### R2 / P1：长单行仍会绕过 Excel 结果体积限制

位置：`src/ai/piRuntime.ts`，read 的 `while (text.length > 48000 && limit > 1)` 和落盘后的 `makePayload(Math.min(limit, 20))`。

行数降到 1 后停止缩减；保存全文后，预览又完整复制这一行。只要这一行本身很长，落盘也无法减少回传消息。

复现：一个工作表、一行两列，每个单元格 30,000 个中文字符（各自未超过 XLSX 常见单元格长度上限）。真实 read 返回 **60,505 字符**，生产估算 **90,191 tokens**；32K 配置输入硬预算为 **21,954 tokens**。这是应用估算，不是服务端 tokenizer 实测。

最小修复：回传内容按总字节/字符预算约束，包括单元格预览；全文落盘后只给有限摘要和定位信息，不重新嵌入超长行。提供不依赖 Shell 的全文续读办法；目前原生文本 read 的长行超过限制时会建议 bash，而公司用户默认未授权 Shell。不能简单截断后宣称全部证据已经读取。

### R3 / P2：工具失败状态只修了部分写入口，计算工具仍误报成功

位置：`src/aiTools.ts` 的 calc execute 与共用 executeTool 返回。

复现：`executeTool('calc', { expression: '1+(' })` 返回 `{ ok: true, text: '表达式无法解析：数字格式不合法' }`。

最小修复：calc 解析错误进入统一失败路径；检查其余非结构化工具的明确失败分支。无需将正常查询“0 条结果”一律判成错误，但非法计算、无效目标操作必须有正确状态。不要用中文字符串正则猜结果。

## 设置页剩余边界（代码确认，待交互验证）

1. **取消后立即重试的竞争**：runProbe 取消时立即把 probeAbort 清空，允许启动新请求；旧请求的 finally 随后仍会清空新 controller、覆盖新结果/运行状态。用当前 controller 身份校验再更新状态，或等待旧请求结束后开放重试。
2. **新端点保留旧模型**：切换 backend/baseUrl 会清理列表和 capability，但没有清空或校验当前 model；刷新也未确认其仍属于新列表。可能继续向新后端发送旧模型标识。
3. **诊断 sample.reason 未净化**：toolchain.reason 做了 cleanText，但 sample 整体直接导出；样例读写失败时的原始异常可能带绝对路径。清理这个字段，不能只处理工具探针错误。
4. **read 文本参数说明被覆盖**：新 schema 把 offset 一律描述成 Excel 0-based，但非 Excel 分支仍委托原生 1-based 文本 read。说明应明确两种格式，不让模型猜测。

这些是上一轮要求的边界延续，不需要新增管理框架。

## 复现与下一步

```powershell
npx vitest run docs/check-llama-acceptance.test.ts docs/check-llama-reacceptance.test.ts --silent=false
```

预期当前 4 项通过、3 项失败。修复后保留断言，补设置页取消→重试与非默认端口/切换后端检查，再跑全量回归和发布构建。

本轮没有重跑上次 4B HTTP 烟测，也没有在公司 27B、真实视觉附件或独立发布目录中验收；不存在新的 27B 速度/质量结论。真正多轮任务、写入成功后断流不重放、重启恢复以及公司电脑只用 UI 完成样例流程仍应作为最终交付条件。

## 返修后复核（2026-09-12）

- R1：生产文件适配器统一兼容 `ArrayBuffer`/`Uint8Array`，样例源 XLSX 与导出 XLSX 均以非空二进制写入并完成回读。
- R2：Excel 原生 read 将总结果控制在约 10,000 字符以内；长单元格只回传有限预览并标明字符数，完整页落盘或通过 `sheet/offset/limit` 续读。
- R3：`calc` 空表达式和解析异常改为统一 `ok:false`。
- 设置页：取消自检等待原请求终态后再开放重试，避免旧请求覆盖新状态；端点变化清空旧模型并在刷新时校验模型归属；sample.reason 脱敏；read schema 明确文本与 Excel 两套 offset 语义。

返修后 `docs/check-llama-reacceptance.test.ts` 3/3、原验收 4/4、全量前端测试 371 通过/2 跳过，`npm run tauri build` 的 EXE、MSI、NSIS 均通过。真实公司 27B、桌面交互和独立发布目录验收仍待现场完成。
