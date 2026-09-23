# Agent Runtime Stage 3.5 修复报告

## 1. Gateway 重复问题根因

Runtime 路径的 `onGatewayTrace` 同时有两个投递来源：底层 `sessionCallbacks.onGatewayTrace` 会直接通知 UI；Runtime 又将同一个 gateway 转成 `RuntimeEvent`，由 `runtimeEventMapper` 映射后通知 UI。此前用最近事件 JSON 内容去重来掩盖双投递，因此内容相同但实际发生两次的事件也可能被误吞。

## 2. 修复方案

- Runtime adapter 调用 `runAgentTurn()` 时仅在 Runtime 路径移除请求中的旧 `onGatewayTrace` callback。gateway 由 RuntimeEvent 单一路径送入 UI。
- AiPanel 移除内容去重器，直接处理映射后的 Runtime gateway 事件；budget、privacy、route 等 Runtime 事件映射保持不变。
- legacy 路径未改变，仍由原 `onGatewayTrace` callback 接收事件。
- 删除 `createGatewayEventDeduplicator`，不再按事件内容过滤。
- 回归测试验证 Runtime 双来源只投递一次、两条内容完全相同的真实 gateway 事件均被保留、legacy callback 行为不变。

## 3. devTools 环境限制方案

- 开发工具必须同时满足 Vite 编译期 `import.meta.env.DEV` 为真和 `localStorage` 中 `costhub-dev-tools=1`。
- `/runtime on|off|status` 的底层命令入口、RuntimeEvent recorder 的安装与每次记录均执行该检查；生产构建即使手动设置 localStorage 也不能启用。
- Stage 3.5 手动验证驱动只允许操作 `localhost:5173` / `127.0.0.1:5173` 开发服务。
- `AGENT_RUNTIME_DEFAULT` 仍为 `false`，Runtime Feature Flag 默认关闭且其正常逻辑未改。

## 4. 修改文件

- `src/components/ai/runtimeAdapter.ts`
- `src/components/AiPanel.tsx`
- `src/components/ai/runtimeEventMapper.ts`
- `src/components/ai/devTools.ts`
- `src/components/ai/runtimeDevSwitch.ts`
- `src/components/ai/runtimeEventRecorder.ts`
- `tests/quality/validate/runtimeDriver.mjs`
- `src/__tests__/runtimeTraceDuplicate.test.ts`
- `src/__tests__/devTools.test.ts`
- `src/__tests__/runtimeDevSwitch.test.ts`
- `src/__tests__/runtimeEventRecorder.test.ts`

本报告为新增文件。未修改 `piRuntime.ts`、`privacyRouter.ts`、业务页面或 Tool Gateway；未新建分支，也未开启 Runtime Feature Flag。

## 5. 测试结果

以下命令在最终代码状态下通过：

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过；存在项目已有的大 chunk / ineffective dynamic import 提示 |
| `npm run quality:core` | 10/10 通过，0 fail、0 blocked、0 warn |
| `npm run quality:full` | 13/13 通过，包含 WebView2/CDP E2E-001..008，0 fail、0 warn |
| `npx vitest run` | 100 个测试文件：99 passed、1 skipped；639 passed、3 skipped（642 total） |

## 6. 真实链路验证与 PR 状态

沿用 Stage 3.5 现有验证记录：本地真实问答链路可工作，工具调用链基本可工作；云端审批完整链路尚未完成端到端验证。本次 `quality:full` 的桌面 E2E 使用隔离数据库，不代表云端审批验证。

因此 Runtime Feature Flag 仍必须默认关闭，当前不能据此默认开启 Runtime。PR #4 继续作为本分支现有审查入口；本次修复应补充到该 PR，不另开 PR。

## 剩余风险

- 云端审批完整链路尚未验证，需要后续具备有效云端配置和人工验收条件时完成。
- 生产构建当前有已有的大 chunk 和动态导入提示；不属于本次修复范围。
- Runtime 默认关闭；开启前仍需完成云端审批验证及必要的发布前实际环境验收。
