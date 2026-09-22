# Gateway V2 六次验收

结论：上轮两个阻断项通过本次代码及定向自动化复验，可以进入桌面实机验收。此结论不等同于整个规范、真实云端、公司电脑 27B 或发布 EXE 已全面验收。

## 来源定位

- piRuntime 为用户提示分配稳定 ID，预更新状态、message_end 入账和后续状态提取共用该 ID；其他原始消息也获得稳定 ID。
- loadPiSourceMessages 按当前 session 查询所有运行中的 message_raw，并按来源 ID 匹配，不再限制为所选 runId。
- 工作状态跨轮保留来源 ID、跨运行查找的定向测试通过。
- 旧版本已经保存且没有稳定 ID 的记录，不能仅凭此修复自动补回来源；界面仍应提示缺失。

## 预取消与网络执行

- Rust 共用 provider_cloud_select 在轮询网络 future 前检查 watch 取消值，并用 biased select 优先检查取消。
- 生产发送及响应读取均调用这一函数。
- 新测试覆盖注册前取消、注册后且 future 开始前取消、读取期间取消；前两项断言请求 future 未被执行，不再只断言 watch 标志。
- 这验证的是受控 future 边界，不代表已发到远端的数据可撤回，也不是实际外网抓包测试。

## 本轮结果

- 7 个相关前端测试文件，30 项通过（piPanelChat.raw、bomRuntime、cloudGateway、privacyRouter、workingState、contextBuilder、gatewayLongSession）。
- Rust network_policy_tests 7 项通过。
- npx tsc -b 通过。
- 没有修改业务实现、操作正式业务数据库或重新发布 EXE。

## 交付前仍需实机验证

1. 桌面连续三轮交流：确认事实、沿用事实、选择旧轮次并点击来源；关闭重开后重复。
2. 查看历史运行的状态和分页，确认 UI 可用、正文定位正确。
3. 使用合成内容验证云端批准/拒绝/取消及审计状态；不使用公司真实数据试验。
4. 公司电脑本地 27B 的速度、多轮工具质量与离线模式单独验收。

此次不再把上述两个已修项列为阻断，也不以尚未执行的实机步骤冒充测试通过。
