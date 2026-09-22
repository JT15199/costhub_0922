# Gateway V2 二次验收

结论：部分修复，仍未完成，不能通过完整验收。本次只做核验，未修改业务实现或重新发布 EXE。

## 确实已改

- contextBuilder 关键条目不再限前 8 条或按 3600 字强截断；超出实际模型输入预算由 piStream 阻止发送。
- workingState 引入 projectContexts/projectKey，简单的具名 A → B → A 场景有隔离和恢复机制。
- gateway 创建时不再报告外发 1 次，增加 network_request 事件；既有部分云端工具接入事件。

## 仍然阻断

1. **项目隔离仍可失效（已独立复现）。** 在 A 项目中输入“供应商范围：供应商 X，目标成本改成 390。”，再切 B，B 的状态仍出现 390。`workingState.ts:306` 使用 parsedProject || input.activeProject；只含供应商/阶段的 parsedProject 没有项目标识，目标被当成 shared。应将局部属性合并到当前实体再确定归属；也应核对决策、问题、文件和步骤的项目范围。
2. **核心可视化未交付。** AiPanel 没有“本轮数据路径”入口、信息归属表或节点详情；顶部仍是简要状态文字。`loadPiEvents` 没有 UI 调用，切换会话仍清空 Trace。无法在使用过程中回看每项信息为什么留本地/获准外发。
3. **检查状态仍失真。** `AiPanel.tsx:72-79` 仍把来源策略提前返回后的 Regex 标 PASS，把未调用 classifier 显示为分类结果。Trace 持久化仍忽略异常。
4. **真实 CloudSafe 路由仍未接通。** `buildCloudSafeContext` 仍没有生产调用者；piRuntime 仍创建默认 local gateway。不能把独立构建器测试通过当成生产双路由完成。
5. **外发统计仍不是实际发送凭据。** `trendService.ts:330` 在 Rust 命令执行前计入外发；Rust 可能拒绝审批票据/URL等而完全未联网。应明确显示“尝试”，或由实际传输端报告发送事件。全局 activeSink 还可能把同期后台云端请求记到当前任务；Pi 工具串行不等于全应用网络串行。
6. **未纳入条目统计仍漏报（已独立复现）。** `contextBuilder.ts` 先对 optional 截取 32 条，再计算 omitted。33 条普通事实可得到 included=32、omitted=0。应从全部候选计算未纳入列表，否则后续可视化仍不真实。

## 最小复现输入

项目状态：

1. 项目名称：项目 A，目标成本 400。
2. 供应商范围：供应商 X，目标成本改成 390。
3. 项目名称：项目 B。

当前 renderWorkingState 仍包含 390。B 没有给定目标，不应继承。

投影统计：在空状态中添加 33 条 active/normal confirmedFacts，调用 projectWorkingState(state, 100000)，返回 included.length=32、omitted.length=0。

两个独立探针均复现；临时测试文件已移除，避免把缺陷固化成正确行为。此次不涉及正式业务数据；没有真实泄露复现，也没有公司电脑 27B 端到端验收。

相关 10 个测试文件、31 项测试通过；测试通过不能覆盖上述未测试的边界及缺失的 UI 集成。
