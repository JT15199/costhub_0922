# CostHub Astra 实施验收修复记录（2026-09-05）

针对 `CostHub_Astra实施验收_2026-09-05.md` 的 A01–A06 已完成代码修复：

- A01：旧明文密码只在哈希写入并提交后清理；失败回滚并保留恢复入口，不自动回落默认密码。
- A02：变更包按整包验证证据和成本，缺一行即不进入机会池；净机会与剩余缺口按包对账。
- A03：非法价格/数量不能被 `confirmed` 覆盖；不完整 BOM 不能冻结版本。
- A04：冻结成本包读取冻结版本内的规格快照；缺快照时明确报告缺口，不读取最新规格冒充历史事实。
- A05：成本包生成侧与成果库使用同一来源字段集合，覆盖规格、SKU、变更包引用和冻结来源。
- A06：授权票迁移到后端独立 `costhub-cloud-authority.db`；供应商端点、认证位置和允许请求头由后端绑定，前端不再直接读写授权票表，最终请求再次校验。

## 验证

- `node docs/review-astra-acceptance-20260905.mjs`：13 passed / 0 failed
- `npm test -- --run`：50 files / 333 tests passed
- `npm run build`：通过
- `cargo check --offline`：通过
- `cargo test --offline --lib`：10 passed / 0 failed

真实供应商网络、正式桌面交互、跨电脑凭据恢复仍需人工验收；本记录不把离线验证替代为真实云端验收。
