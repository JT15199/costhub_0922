# CostHub llama.cpp 六次验收

日期：2026-09-13；对象：当前 v2.3.19 工作区。

## 结论

**核心工具链回归持续通过；上轮五项体验修复大部分成立，启动/停止仍有一项 P2 异步状态问题。** 不需要重做长数据设计，建议补齐迟到健康检查的处理后进入公司电脑试用。

本轮没有修改产品实现或操作正式数据库。新增浏览器测试直接渲染真实 LocalBackendSettings、React 和 Ant Design，仅模拟设置存储、模型探针和 Tauri IPC；未启动真实 llama-server。

## 本轮验证

| 检查 | 结果 |
|---|---|
| 最终 npm test | 66 文件通过，378 通过、2 跳过 |
| Rust cargo test --lib | 20/20 通过 |
| npm run tauri build（含 TypeScript、前端构建） | EXE、MSI、NSIS 构建通过 |
| 非端口配置失焦保留外部 8081 地址 | 浏览器通过 |
| 未指定温度显示默认，修改其他选项不保存温度 | 浏览器通过 |
| 切换端点后丢弃旧工具探针结果 | 浏览器通过 |
| 模型启动等待中停止按钮可点击并发出 stop | 浏览器通过 |
| 停止后的迟到健康响应不应恢复 ready | **浏览器失败，重复运行可复现** |

第一次全量测试在机器负载较高时 costPackage 超时；第二次全量原配置通过，没有放宽超时或跳过断言。最终日志：`docs/check-llama-sixth-result.txt`。

产物位于 `src-tauri/target/release/costhub.exe`、`src-tauri/target/release/bundle/msi/CostHub_2.3.19_x64_en-US.msi`、`src-tauri/target/release/bundle/nsis/CostHub_2.3.19_x64-setup.exe`。测试用 5188 开发服务已关闭。

## 剩余问题：停止后的旧响应覆盖状态（P2）

位置：`src/components/LocalBackendSettings.tsx` 的 checkHealth 和 manageServer 启动轮询。

复现顺序：

1. 点击启动，模拟进程成功，健康请求保持未返回。
2. 点击停止，stop IPC 成功，界面显示“llama.cpp 已停止”。
3. 让之前的健康请求返回成功模型列表。
4. checkHealth 直接 setHealth('ready')；启动函数发现 ready 后也跳出循环并显示可用。界面重新出现“服务可用”，与已经停止的进程矛盾。

原有 serverActionRef 检查只在 await checkHealth **之前**，不能阻止 await 期间发生停止后的结果回填。仅在函数尾部清理 action 也解决不了已发生的状态更新。

最小修复：健康请求返回后先核对本次操作的唯一代次以及端点，再更新模型列表、health、notice 和成功提示；停止、切换配置、卸载时使旧代次失效。不要只比较字符串 'start'，因为停止后再次启动会再次出现同名 action，旧请求可能误认成新操作。旧启动调用迟到时的补偿 stop 也应避免误停新进程。

验收：启动→停止→旧健康成功、启动→停止→再次启动→旧响应到达，两种顺序都应以最新操作为准；不要仅禁止用户点击停止。

## 上次其余项核对

- AiPanel 增加 closeOpenRounds，在开始下一轮及最终完成/失败/取消时收口。代码路径已补齐；本轮未跑完整三轮聊天的桌面交互。
- 非端口输入现在调用 persistServer(false)，浏览器确认不会改写外部端点。
- 温度未覆盖使用 undefined，模型切换重置选项；浏览器确认无隐式温度写入。
- 模型探针绑定 generation，配置变化失效并取消；浏览器确认旧探针结果没有回填。
- 启动等待增加总期限、进程状态检查、超时说明和可点击停止；但上面的迟到健康结果仍需处理。

## 复现脚本

```powershell
npm run dev -- --host 127.0.0.1 --port 5188 --strictPort
# 另一个终端：
node docs/check-local-settings-acceptance.cjs
```

脚本使用已安装的 Playwright，入口为 `docs/local-settings-acceptance.html` 和 `.tsx`；所有模拟仅作用于此浏览器页面，不访问正式数据库。当前退出码 1 来自最后的迟到响应断言。日志：`docs/check-local-settings-acceptance-result.txt`。

本轮没有公司 27B、视觉 mmproj、真实 WebView2 或正式报价副本流程的新结果。浏览器组件测试是对前几轮纯代码复核的补充，不能代替公司实机验收。

## P2 修复后复核

已修复停止后的迟到健康响应覆盖状态问题：

- 启动、停止、配置切换和卸载均推进服务操作代次；健康请求返回前后都校验代次，旧响应不会再写入模型列表、连接状态或提示。
- 启动→停止→旧健康响应、启动→停止→再次启动→旧响应两种顺序均以最新操作为准。
- 旧启动调用迟到时，仅在最新操作确实是停止且没有新的启动操作时补偿 stop，避免误停新进程。

复核结果：`node docs/check-local-settings-acceptance.cjs` 通过；`npm test -- --run` 第二次原配置为 **378 通过、2 跳过；66 个文件**；`npm run tauri build` 通过并重新生成 EXE、MSI、NSIS。首次全量测试仍出现报告中记录的机器负载超时，未修改超时配置，重跑通过。
