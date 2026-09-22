# Gateway V2 三次验收

结论：有明显进展，但完整验收仍不通过，尤其暂不能据此宣称 CloudSafe 能自动可靠识别保密信息。本次只做核验，未修改业务实现或发布 EXE。

## 已确认修复

- 项目部分属性更新（供应商/阶段）会合并当前项目后确定事实归属；上轮 A 的 390 串到 B 的场景已有回归测试通过。
- 决策、问题、文件、步骤增加项目归属；普通状态第 33 条漏记 omitted 的实现已调整。
- 增加“路径”按钮、事件详情和信息归属表；会话加载会恢复最后一轮 Gateway 事件，持久化失败增加提示。
- 来源敏感时 Regex/Classifier 显示未执行；不再全部显示通过。
- CloudSafe 已从 AiPanel 接到构建器、Gateway、Provider 与 Rust 校验入口。上轮“生产调用未接通”的结论不再适用。
- 去掉全局网络 Trace sink，改为传递回调；区分外发尝试和已确认传输。

## P1：保密输入仍可被自动判为 PUBLIC

`src/components/AiPanel.tsx:506-511` 对用户输入直接设置 `sourceTypes: ['public_approved_content']`，并把消息标记 `approved: true`。`privacyRouter.ts` 默认 classifier 信任 public 来源，剩余保护主要是有限关键词。来源是代码赋予的标签，并非证明正文公开。

独立复现（完全虚构文本、没有联网）：

> 保密：尚未发布的新品叫蓝鹭，将于十一月上市，请勿对外透露。

用生产相同参数调用 evaluatePrivacy，结果 PUBLIC；再调用 buildCloudSafeContext，全文进入 context.messages。后端 validate_public_context_body 的禁词也不覆盖这段文本。当前仍有网络模式/审批边界，不能说已经发生泄露；但一旦用户批准这类通用公开上下文授权，内容判定本身不足以阻止此类误发。

修复要求：未核实来源默认 UNKNOWN；选择 CloudSafe 不能自行产生“已批准公开来源”。用可信来源元数据/明确的内容审阅形成批准记录；需要语义分类时走本地，异常保持本地。审批应能核对本次实际公开投影，不能只显示固定的“公开上下文”主题。不应只添加这一个句子的关键词。

## P1：失败/取消的外发记录仍不完整

- `trendService.ts:401` 的 catch 只有 !cloudTraceStatus 才记录终态；前面 attempted 已赋值，所以 Rust invoke 抛错后可能永远停在 attempted。
- `createCloudSafeProvider` 没有将 signal 传入底层网络取消链。`cloudProvider.ts` 的 abort 结束前端流，不代表网络停止；Provider 完成后还可能发 succeeded 事件。
- 使用 HTTP status>0 判定 transported 可确认收到响应，但超时/连接中断不等于正文没有发出。面板应显示“发送情况未知”，不能以 false 推导“未离开本机”。

修复要求：每个 requestId 有终态；区分未发、已确认发送和未知；取消应传播到传输层，无法取消时明确标注。必须覆盖服务端接收正文后断开连接、调用前取消、审批被拒和发送中取消。

## P2：可视化只能部分验收

- 路径入口已存在，但 switchSession 仅恢复 latestRunId，新一轮清空事件，尚无历史轮次选择或逐条回答入口。
- 信息归属表只有类型、内容、项目/共享、敏感度；缺少来源消息/文件定位、判定依据、本轮纳入/排除及是否实际发送。当前状态表也不是历史轮次的状态快照。
- metadata_unknown 仍被 Regex 显示为通过，而 privacyRouter 在该分支已提前返回，应为未执行。
- 默认 classifier 仍是规则，不是本地模型；“Classifier 已调用”应标清规则，避免让人误认为经过了语义审查。

## 验证

- 相关 10 个前端测试文件、34 项测试通过。
- npx tsc -b 通过。
- Rust 定向测试 cloud_safe_context_accepts_fixed_public_projection_only 通过（1 项）。
- 上述保密内容误判的独立探针复现成功；临时测试已移除，避免将缺陷行为固化为正常期望。
- 没有访问正式业务数据或调用真实云端；没有完成浏览器交互和公司电脑 27B 验收。源码有入口不等于已完成界面实测。

下一轮先修 PUBLIC 来源信任和发送终态，再补历史轮次/证据溯源，然后做 UI 与真实本地模型验收。
