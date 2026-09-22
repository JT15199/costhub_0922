# Gateway V2 五次验收

结论：上轮三个缺口均有实质修改；完整交付仍需修好来源定位，并补取消发送边界验证。本次只审查源码和自动化测试，未修改业务实现、未发布 EXE、未访问正式业务数据。

## 已确认

- provider 云端命令携带 request_id，取消命令到达 Rust，tokio::select! 可终止发送/响应读取 future；取消通知失败有明确提示。
- 每轮 checkpoint 保存 WorkingState，回放使用所选运行的状态，不再使用当前轮状态。
- Gateway 记录采用游标分页加载，有失败/不完整提示，不再静默截断到 500 条。
- 相关前端 11 文件、37 项测试通过；Rust network_policy_tests 6 项通过；npx tsc -b 通过。

## 待修 P2：来源按钮与实际消息 ID 不一致

`workingState.ts` 的 sourceId 在消息没有 id 时产生 `${sourcePrefix}:${index}`。`piRuntime.ts:531-549` 使用随机 turn prefix，预更新还构造了一个没有 id 的临时用户消息；这个生成的来源 ID 没有写入原始消息。onRawMessage 保存原始 Pi 消息，而 `AiPanel.tsx` 点击来源时仅以 message.id === source 查找。

因此给归属表加按钮并不能让这些真实生成的 sourceMessageIds 定位到正文；并且引用早期轮次的事实时，仅查询选中 runId 的 message_raw，也找不到来源轮次。

修复应在消息入账时分配一次稳定 ID，状态提取和持久化共用该 ID；来源查询按当前会话内的稳定 ID 定位原始轮次，不能只查当前运行。增加“第一轮确认事实，第二轮沿用，第三轮回看并点击来源”的集成检查。

## 待修 P1：预取消没有在发送前明确阻断

`src-tauri/src/lib.rs:3096` 注册取消后直接进入 tokio::select!，没有先检查 receiver.borrow()。pending 取消虽把 watch 标为 true，但 select 默认随机轮询分支；builder.send() 可能先被轮询，不能作为“预取消绝不发送”的保证。当前借用取消状态的检查在 send 返回后，太晚。

应在开始发送前检查已取消状态，并让 select 优先检查取消分支。补真正覆盖发送边界的合成测试：取消先到、注册后取消、响应读取时取消；现有 provider_cloud_cancel_covers_active_and_pre_start_races 仅断言 watch 值，不检验 HTTP 请求是否开始。

已发出的内容无法撤回。这里要求的是收到预取消时不再开始发送，不是承诺撤回网络数据。

## 剩余验证边界

- 本轮未运行真实浏览器/原生桌面交互，来源按钮结论来自完整代码链核对。
- 未调用外部云端，未测试公司电脑 27B。
- 状态表“实际外发”目前以纳入公开投影推导“实际请求体包含”，应继续区分准备的载荷与已确认发送，避免仅凭投影 ID 宣称发送成功。

下一轮不需重做架构：修稳定来源 ID 与发送前取消检查，再用真实 UI 和合成传输测试收口。
