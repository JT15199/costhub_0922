### v2.3.19 AI 能力嵌入工作流（2026-08-14）
- **仪表盘 → 驾驶舱**：目标成本达成预警置顶（project_targets 按领域=main_category 对比 BOM 实际成本，达成率=(2-实际/目标)×100，未达标红色卡片+跨页直达 costhub-open-project 事件）+ AI 今日洞察区（part_insights 报价情报 + 最近两条快照 bom_cost 异动≥1%）；纯计算在 src/targetInsight.ts（vitest 覆盖）
- **项目页 AI 体检条**：规则驱动 4 类检查（BOM 缺单价/数量0、目标超支→analysis tab、快照异动→snapshots tab、同品类模块报价价差≥¥10且≥10%），点击直达 tab；「AI 小结」本地模型一句话概括（未配置静默）；纯逻辑 src/projectHealth.ts（vitest 覆盖）
- **快照对比 AI 解释**：BOM 详细对比弹窗「生成解释」——差异清单 top8 交 Ollama 流式生成 2-3 句原因说明（Modal.update 流式刷新）
- **全局 AI 问询**（src/components/GlobalAI.tsx）：侧边栏入口，上下文=localStorage costhub-ctx（Projects 选中项目写 BOM 摘要/目标），回答一键 saveWorkLog 记入工作手账（work_project=项目代号）；⚠️ 数据安全：只有本地模型可读项目数据（云端不接）
- **首次 AI 引导**（src/components/AIGuide.tsx）：解锁后 localStorage costhub-ai-guide-seen 控制一次，展示 5 项能力+配置就绪度
- ⚠️ 铁律：项目目标成本数据依赖用户设定（生产库仅 2 条），驾驶舱预警以目标设定为前提

# CostHub - 成本管理平台 v2.3.19

## 项目概述

这是一个用于管理电子产品成本的桌面应用程序（原名"显示器成本管理系统"），基于 Tauri + React + TypeScript + SQLite 构建，提供器件库、项目管理、竞品分析、成本对比、工作手账等功能。未来计划扩展到PC、平板等其他电子整机产品线。

**版本**: 2.3.19
**产品名称**: CostHub v2.3.19
**标识符**: com.costhub.app
