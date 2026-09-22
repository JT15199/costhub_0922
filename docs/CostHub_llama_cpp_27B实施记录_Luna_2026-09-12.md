# CostHub llama.cpp 27B 改造实施记录

日期：2026-09-12
依据：`docs/CostHub_llama_cpp_27B改造交接_Luna_2026-09-12.md`

## 已完成

- 后端选择：Ollama 保留原生 `/api/chat`；llama.cpp 使用回环 `/v1/chat/completions`、`/v1/models` 和 `/health`。
- 流式协议：处理 UTF-8 分片、SSE/NDJSON、`usage`、`finish_reason`、`length`、`[DONE]`、工具调用分段合并以及取消；未标记结束的 EOF 不再误报成功。
- 上下文与输出：图片只按固定保守额度计入上下文，不把 base64 当文本；未配置输出上限时不发送 `max_tokens`/`num_predict`；保留思考由模型设置控制。
- Pi 工具：Excel 原生读取支持工作表和 `offset/limit/nextOffset`；附件读取保留多工作表；工具发现按意图预加载只读工具；全量结果提供任务目录路径。
- 数据安全：导入 BOM、供应商报价和竞品 BOM 时，缺失或非法价格/数量不再静默变成 0/1，改为跳过并统计；报价分析缺失值显示为待补证据。
- 设置页：增加 llama-server 可执行文件、模型、mmproj、端口、上下文、GPU 层数、线程、batch、reasoning 配置，支持启动/停止、健康轮询、工具链自检、独立 450 行样例验收和脱敏诊断导出。

## 验证结果

- `npx tsc -b --pretty false`：通过。
- `npm test -- --run`：63 个测试文件通过，363 通过，2 跳过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：20/20 通过。
- `npm run build`：通过。
- `npm run tauri build`：通过，生成：
  - `src-tauri/target/release/costhub.exe`
  - `src-tauri/target/release/bundle/msi/CostHub_2.3.19_x64_en-US.msi`
  - `src-tauri/target/release/bundle/nsis/CostHub_2.3.19_x64-setup.exe`
- 本机回环 llama.cpp 的 `/health` 与 `/v1/models`：可达。当前未用 27B 正式模型做业务验收。

## 现场验收待办

在公司电脑部署 27B GGUF、必要的 mmproj 和 llama-server 后，重点验证：首 token/持续生成速度、视觉附件、工具调用、多轮长上下文、450 行以上 Excel 分页、正式报价导入以及取消后无重复写入。验收数据应使用脱敏副本。
