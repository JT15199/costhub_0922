# Ollama 思考输出预算返修｜2026-09-12

## 结论

修复了“思考内容占满生成/上下文，最后没有答案”的生产路径：thinking 仍可展示和本地留痕，但不再作为 assistant 正文回灌下一轮，也不再计入输入预算。检测到真实 `done_reason=length` 且 assistant 只有 thinking 时，最多执行一次关闭思考的结论收尾；该请求只使用已取得的上下文，不重放工具。

## 改动

- `src/ai/piStream.ts`：assistant 请求消息仅包含 `text`，保留 tool call/result 协议字段；usage 的 `doneReason=length` 会标记截断。
- `src/ai/modelProfile.ts`：上下文 token 估算过滤 thinking，避免压缩因不会发送的内部文本提前失真触发。
- `src/ai/contextPolicy.ts`：摘要输入同样不把 thinking 当普通对话正文。
- `src/ai/piRuntime.ts`：记录实际 usage；无答案、只有 thinking、且 length 截断时，最多一次 `thinkingLevel=off` 收尾。取消后不会重新启动收尾。

## 验证

- `npx vitest run --testTimeout=60000`：360 passed，2 skipped。
- `npm run build`：退出码 0。
- 新增回归覆盖：thinking 不会出现在 Ollama assistant 输入。

## 未完成

本轮没有目标 27B 模型、24GB GPU 的生产实测，因此未宣称真实模型速度或最终答案质量已验收。仍需在实际模型上验证多轮历史、`length` 空答案收尾、正常工具调用、停止和深度思考开关。
