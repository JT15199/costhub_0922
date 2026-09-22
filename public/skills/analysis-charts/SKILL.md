---
name: analysis-charts
description: 在 CostHub 对话中将已查询的成本、供应商报价、目标差额和时间序列生成精致的可交互图表与 SVG 产物。
---

# 分析图表

当图表能帮助回答当前问题时，先查询真实业务工具结果或读取用户附件，再调用 `render_analysis_chart`。该工具无需 Python、Shell 或联网，自动生成聊天卡片及带来源和口径的 SVG。

传入 `spec` JSON 字符串，字段：title、takeaway、type、unit、source、basis、labels、series。series 是 `{name, values}` 数组。数值必须可追溯到本轮查询或附件计算；缺失为 null，不补零。不要把示例数值当用户数据。

- 比较供应商、项目或模块用 bar，按业务含义或数值排序；时间序列用 line，保持时间顺序且不补造日期。
- 同一总额的 2–6 个非负组成可用 donut。涉及差值或精确比较优先 bar。
- 一图回答一个问题，最多 4 个系列。币种、税率、时间范围及计算口径写入 basis；source 指明查询对象/文件及工作表。不同币种或含税口径不能直接混合。
- takeaway 写有数据依据的观察，不把相关性当因果。用户只给少量数据时如实展示，不为了“高级”凑趋势或三维效果。
- 同时保留简短文字结论。工具返回的产物路径可用于后续读取和修改。

结构示例（占位符需替换为真实结果）：
`{"title":"模块成本比较","takeaway":"填写有依据的发现","type":"bar","unit":"元/台","source":"项目代号及 BOM 查询","basis":"填写报价版本和税率口径","labels":["模块一","模块二"],"series":[{"name":"已确认报价","values":[实际数值一,实际数值二]}]}`
