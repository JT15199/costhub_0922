# 显示器成本管理系统 v2.2

## 项目概述

这是一个用于管理显示器产品成本的桌面应用程序，基于 Tauri + React + TypeScript + SQLite 构建，提供器件库、项目管理、竞品分析、成本对比等功能。

**版本**: 2.2.0
**产品名称**: 显示器成本管理_v2.2
**标识符**: com.monitor.cost.manager

## 技术架构

### 前端技术栈
- **框架**: React 19.2.7 + TypeScript
- **UI组件库**: Ant Design 6.2.5
- **图表库**: ECharts (echarts-for-react)
- **路由**: React Router DOM 7.17.0
- **构建工具**: Vite 8.0.16
- **样式**: CSS (index.css 约 50KB，包含完整的主题系统)

### 后端技术栈
- **框架**: Tauri 2.x
- **数据库**: SQLite (tauri-plugin-sql)
- **语言**: Rust (edition 2021)
- **数据库文件**: monitor_cost.db (位于 exe 同目录)

### 主要依赖
```json
{
  "@tauri-apps/api": "2.11.0",
  "@tauri-apps/plugin-sql": "2.4.0",
  "react": "19.2.7",
  "antd": "最新版本",
  "echarts-for-react": "3.0.6",
  "xlsx": "0.18.5" // 用于 Excel 导入导出
}
```

## 功能模块

### 1. 仪表盘 (Dashboard)
- **文件**: `src/pages/Dashboard.tsx`
- **功能**:
  - 统计概览：总器件数、总项目数、活跃项目、竞品数、平均BOM成本
  - 器件分类分布图表
  - 项目成本趋势分析
  - 竞品成本对比
  - 最近更新的器件列表

### 2. 器件库 (PartsLibrary)
- **文件**: `src/pages/PartsLibrary.tsx`
- **功能**:
  - 器件信息管理（增删改查）
  - 分类体系：大类（硬件类、结构类、电源类等）+ 子类
  - 价格历史追踪
  - 批量导入导出（支持 Excel）
  - 搜索和筛选

### 3. 模块库 (ModuleLibrary)
- **文件**: `src/pages/ModuleLibrary.tsx`
- **功能**:
  - 模块定义和管理
  - 模块内器件组合
  - 模块成本计算
  - 模块复用和引用

### 4. 项目管理 (Projects)
- **文件**: `src/pages/Projects.tsx` (约 85KB，功能最丰富)
- **功能**:
  - 项目基本信息（代号、名称、类型、档位、状态）
  - 产品规格（屏幕尺寸、分辨率、刷新率、面板类型）
  - BOM管理（器件清单、数量、成本计算）
  - 成本评审记录（阶段评审）
  - 目标成本设定
  - 降本措施跟踪
  - 项目分组管理
  - 项目排序（拖拽排序）
  - BOM引用和差异分析
  - 软删除机制

### 5. 竞品管理 (Competitors)
- **文件**: `src/pages/Competitors.tsx`
- **功能**:
  - 竞品信息管理（品牌、型号、档位、市场价格）
  - 竞品BOM估算
  - 与己方器件映射对比
  - 成本差异分析
  - 排序功能

### 6. 对比分析 (Compare)
- **文件**: `src/pages/Compare.tsx`
- **功能**:
  - 项目间成本对比
  - 竞品间成本对比
  - 自定义对比维度
  - 可视化对比图表

### 7. 成本报告 (Reports)
- **文件**: `src/pages/Reports.tsx`
- **功能**:
  - 成本报告生成
  - 导出功能
  - 报告模板管理

## 数据模型

### 核心实体（详见 src/types.ts）

#### Part (器件)
```typescript
interface Part {
  id?: number;
  main_category: string; // 大类（硬件类、结构类等）
  sub_category: string;  // 子类
  category: string;      // 详细分类
  name: string;          // 器件名称
  model: string;         // 型号
  cost: number;          // 成本
  specs: string;         // 规格
  projects: string;      // 关联项目
  remark: string;        // 备注
  created_at?: string;
  updated_at?: string;
}
```

#### Project (项目)
```typescript
interface Project {
  id?: number;
  code: string;          // 项目代号
  name: string;          // 项目名称
  project_type: string;  // 项目类型（在研/已完成）
  tier: string;          // 档位（入门级/主流级/中高端/高端/旗舰级）
  status: string;        // 状态（进行中/已完成/暂停）
  screen_size: string;   // 屏幕尺寸
  resolution: string;    // 分辨率
  refresh_rate: string;  // 刷新率
  panel_type: string;    // 面板类型
  platform_fee_rate: number; // 平台费率
  profit_rate: number;   // 利润率
  image?: string;        // 产品图片
  sort_order?: number;   // 排序权重
  created_at?: string;
}
```

#### ProjectBOM (项目BOM)
```typescript
interface ProjectBOM {
  id?: number;
  project_id: number;
  part_id: number;
  module_name: string;   // 所属模块
  quantity: number;      // 数量
  cost?: number;         // 成本（可选）
  remark: string;
  is_reference?: number; // 引用标记
  reference_remark?: string; // 差异备注
  is_deleted?: number;   // 软删除标记
}
```

#### Competitor (竞品)
```typescript
interface Competitor {
  id?: number;
  brand: string;         // 品牌
  model: string;         // 型号
  tier: string;          // 档位
  market_price: number;  // 市场价格
  bom_cost: number;      // BOM成本
  platform_fee_rate: number;
  remark: string;
  sort_order?: number;
  created_at?: string;
}
```

### 数据库表结构（详见 src-tauri/src/lib.rs）

完整表结构包括：
- `parts` - 器件表
- `projects` - 项目表
- `modules` - 模块表
- `module_items` - 模器件项表
- `project_boms` - 项目BOM表
- `part_price_history` - 器件价格历史表
- `competitors` - 竞品表
- `competitor_boms` - 竞品BOM表
- `competitor_parts` - 竞品器件表
- `project_cost_reviews` - 项目成本评审表
- `project_targets` - 项目目标成本表
- `project_measures` - 项目降本措施表
- `project_groups` - 项目分组表
- `project_group_members` - 项目分组成员表
- `product_features` - 产品特性表
- `product_scores` - 产品评分表

## UI/UX 特性

### 主题系统
**配置文件**: `src/constants.ts`, `src/main.tsx`, `src/index.css`

#### 调色板 (7种)
- **Apple 紫粉** (apple): 紫粉渐变
- **Tiffany 蓝玻璃** (tiffany): 青蓝渐变
- **Paper 白底** (paper): 纯白简洁
- **Rose Gold 玫瑰** (rose): 玫瑰金渐变
- **Aurora 极光** (aurora): 绿紫极光
- **Mint 薄荷** (mint): 绿黄清新
- **Sky 天空** (sky): 蓝紫天空

#### 深浅模式
- Light mode (浅色)
- Dark mode (深色)

#### 色温调节
- Default (默认)
- Warm (暖光)
- Cool (冷调)
- Sepia (护眼)

#### 动效控制
- On (开启动效)
- Off (性能模式)

#### 缩放级别
- 80%, 100%, 125%, 150%

### 分类颜色系统
```typescript
CATEGORY_COLORS = {
  '硬件类': '#3B82F6',
  '结构类': '#5AC8FA',
  '电源类': '#8B5CF6',
  '线材类': '#AF52DE',
  '包材类': '#34C759',
  '加工费类': '#FF9500',
  '软件类': '#5856D6',
  '其他': '#6E6E73'
}
```

扩展调色板支持任意新分类的稳定颜色分配（基于 djb2 哈希算法）

### 全局搜索
- **快捷键**: Ctrl+K / Cmd+K
- **搜索范围**: 器件、项目、竞品
- **搜索结果**: 点击可导航到对应页面并高亮

### 最近更新器件
- 侧边栏底部显示最近更新的5个器件
- 可折叠/展开
- 点击快速跳转到器件库

## 构建和发布

### 开发环境
```bash
# 安装依赖
npm install

# 开发模式
npm run dev  # 启动前端开发服务器 (localhost:5173)

# Tauri 开发模式
npm run tauri dev  # 启动完整应用
```

### 构建发布
```bash
# 构建前端
npm run build

# 构建 Tauri 应用
npm run tauri build
```

### 发布产物
- **位置**: `src-tauri/target/release/`
- **主执行文件**: `monitor-cost-manager.exe` (免安装版本)
- **数据库文件**: `monitor_cost.db` (自动创建，与 exe 同目录)
- **安装包**: 未配置 NSIS/MSI，采用免安装 exe 方式

### 配置文件
- **Tauri 配置**: `src-tauri/tauri.conf.json`
  - 窗口尺寸: 1400×860 (最小 1100×700)
  - 窗口居中启动
  - 可缩放、有装饰
- **Cargo 配置**: `src-tauri/Cargo.toml`

## 数据库管理

### Schema 自动补齐
项目启动时自动检测并补齐缺失的数据库列/表（`src/db.ts` ensureSchema 函数）：
- project_boms.cost
- projects.sort_order
- competitors.sort_order
- project_groups 表
- project_group_members 表
- project_boms.is_reference
- project_boms.reference_remark
- project_boms.is_deleted

### 迁移机制
- 不依赖线性迁移历史
- 启动时自动执行缺失补齐
- 错误容忍设计（表/列已存在时静默失败）

### 数据库路径
- 由 Rust 后端提供：`src-tauri/src/lib.rs` get_db_url()
- 路径规则：exe 同目录下的 monitor_cost.db
- 连接字符串格式：`sqlite:<path>/monitor_cost.db`

## 特殊功能说明

### 项目排序
- 拖拽排序支持
- 排序权重存储在 sort_order 字段
- 默认按创建时间倒序

### BOM引用机制
- 项目间BOM可引用复制
- 引用项标记 is_reference
- 支持差异备注 reference_remark
- 便于快速创建相似项目的BOM

### 软删除
- project_boms.is_deleted 标记
- 删除不物理移除，保留历史记录
- 可恢复误删项

### Excel导入导出
- 使用 xlsx 库 (0.18.5)
- 支持器件批量导入
- 支持报告导出

### 成本计算公式
```typescript
// 项目总成本 = BOM成本 × (1 + 平台费率 + 利润率)
totalCost = bomCost * (1 + (platform_fee_rate + profit_rate) / 100)
```

## 开发注意事项

### 文件结构
```
monitor-cost-main/
├── src/                   # React 前端源代码
│   ├── App.tsx           # 主应用（导航、主题、搜索）
│   ├── db.ts             # 数据库操作（约32KB）
│   ├── constants.ts      # 常量配置
│   ├── types.ts          # 类型定义
│   ├── main.tsx          # 入口文件
│   ├── index.css         # 样式（约50KB）
│   └── pages/            # 功能页面
│       ├── Dashboard.tsx
│       ├── PartsLibrary.tsx
│       ├── ModuleLibrary.tsx
│       ├── Projects.tsx
│       ├── Competitors.tsx
│       ├── Compare.tsx
│       └── Reports.tsx
├── src-tauri/            # Rust 后端源代码
│   ├── src/
│   │   ├── lib.rs        # 主库文件（迁移、命令）
│   │   └── main.rs       # 入口
│   ├── tauri.conf.json   # Tauri 配置
│   ├── Cargo.toml        # Rust 配置
│   ├── target/           # 编译产物
│   │   └── release/
│   │       ├── monitor-cost-manager.exe
│   │       ├── monitor_cost.db
│   │       └── ...
│   └── icons/            # 应用图标
├── public/               # 静态资源
└── node_modules/         # npm 依赖
```

### 关键技术点

1. **数据库连接**: 通过 Tauri invoke 获取数据库路径，前端使用 @tauri-apps/plugin-sql 操作

2. **主题切换**: 通过 HTML 属性 (data-theme, data-palette, data-motion, data-color-temp) 控制 CSS 变量

3. **状态管理**: React hooks (useState, useEffect)，无 Redux/Context

4. **路由导航**: 单页应用，通过 active state 切换页面组件

5. **图表渲染**: ECharts for React，响应式数据更新

6. **表格组件**: Ant Design Table，支持排序、筛选、编辑

7. **国际化**: 中文界面，Ant Design zhCN locale

### 性能优化

- 动效开关（性能模式）
- 缩放控制
- 分页和懒加载（大型列表）
- 数据库查询优化（索引、排序权重）

### 安全考虑

- 本地数据库，无网络传输
- 数据文件随 exe 部署
- CSP 配置开放（开发便利性优先）

## 更新历史

### v2.2 特性
- 项目分组管理
- BOM引用和差异分析
- 软删除机制
- 全局搜索（Ctrl+K）
- 最近更新器件侧边栏
- 多主题调色板
- 色温调节
- 动效控制
- 缩放控制
- 竞品排序
- 项目拖拽排序

## 后续开发建议

1. **数据库备份**: 增加数据库导出/导入功能
2. **数据同步**: 支持云端同步（可选）
3. **权限管理**: 多用户角色（管理员/编辑者）
4. **审计日志**: 记录关键操作历史
5. **报告模板**: 自定义报告格式
6. **数据导入**: 更多格式支持（CSV、JSON）
7. **图表增强**: 更多可视化维度
8. **移动端**: Web 版本或移动应用
9. **API接口**: 供第三方系统集成
10. **性能监控**: 前端性能指标采集

## 维护指南

### 修改主题
- 编辑 `src/constants.ts` PALETTES
- 编辑 `src/index.css` 对应 [data-palette="<id>"] 块
- 编辑 `src/main.tsx` PALETTE_PRIMARY 映射

### 添加新分类
- 在 `constants.ts` MAIN_CATEGORIES 或 SUB_CATEGORIES 添加
- CATEGORY_COLORS 已包含主要分类
- 新分类自动获得稳定哈希颜色

### 修改数据库表
- 在 `src-tauri/src/lib.rs` migrations 数组添加迁移
- 在 `src/db.ts` ensureSchema 添加自动补齐逻辑
- 更新 `src/types.ts` 对应接口

### 添加新页面
- 在 `src/pages/` 创建新组件
- 在 `src/App.tsx` NAV 数组添加导航项
- 在 `src/App.tsx` render 函数添加渲染逻辑

---

**文档维护**: 所有重要的项目变更应同步更新此文件。

### 2026-09-12 思考输出预算返修

- Pi 传输只将 assistant 的最终 text 回灌给 Ollama；thinking 仍保存在本地原始消息/事件中供展示和审计，但不作为普通答案重复发送，也不计入输入预算估算。
- 记录真实 `usage` 与 `done_reason`；若本轮只有 thinking 且因 `length` 结束，最多发起一次关闭思考的结论收尾请求，保留已有约束、证据和工具结果，不自动重放有副作用工具。
- 验证：前端 360 项通过、2 项跳过，生产构建退出 0；目标 27B/24GB GPU 的真实验证仍未完成。

### 2026-09-12 llama.cpp 兼容

- CostHub 本地 AI 新增 `local_ai_backend`：默认 Ollama，选择 `llama.cpp` 时使用回环地址、`/v1/models` 和 `/v1/chat/completions`，沿用 Rust `http_stream`/取消边界；工具调用分段按 index/id 合并，tool result 保留 `tool_call_id`。
- 本机已安装官方 Windows x64 Vulkan `b10919` 到 `tools/llama.cpp/b10919-vulkan`（运行包被 `.gitignore` 排除）；没有下载新模型，测试复用了现有 Ollama qwen3:4b GGUF。
- llama-server 真实 health、模型列表和对话调用已通过；当前 qwen3 Ollama 导出模板仍会输出 reasoning，`enable_thinking=false` 不应视为已生效。

**最后更新**: 2026-09-12

## 2026-06-23 调试记录

### 问题背景
在另一台电脑上运行时，Ant Design 的 Modal 弹窗和 Select 下拉菜单**渲染出来但不可见**（用户能编辑内容、能关闭，但看不到弹窗）。当前电脑运行正常。

### 排查过程

#### 1. 初始怀疑：数据库问题
- 用户最初报告"数据库初始化失败：数据库连接失败: undefined"
- 尝试添加错误处理、超时机制
- 结论：数据库连接正常，不是根本原因

#### 2. CSS 层叠上下文问题（错误方向）
- 检查 `index.css` 发现大量 `backdrop-filter` 使用
- 尝试移除 `backdrop-filter`、添加高 `z-index`、移除 `isolation: isolate`
- 尝试添加 `getPopupContainer={() => document.body}`
- 结论：这些修改无效，问题不在 backdrop-filter

#### 3. Git 版本回退
- 用户确认上周版本正常
- 尝试回退到原始版本（只保留用户要求的修改：移除成本快照栏）
- Git 操作遇到合并冲突，最终回退成功

#### 4. 环境因素排查
- 另一台电脑 WebView2 版本：149.4022.80（较新版本）
- 另一台电脑上另一个 Tauri 工具运行正常（同样技术栈）
- 结论：问题在代码而非环境

#### 5. 用户发现关键线索
- 用户发现：**关闭动效开关（点击"💤"按钮）后，Modal/Select 正常显示**
- 这直接指向了 `[data-motion="off"]` 相关的 CSS 问题

#### 6. 真正原因找到
检查 `index.css` 第1379-1384行：
```css
[data-motion="off"] *,
[data-motion="off"] *::before,
[data-motion="off"] *::after {
  animation: none !important;
  transition-duration: 0.001s !important;
}
```

**问题分析：**
- 这个规则把**所有元素**的 `transition-duration` 设为 0.001s
- Ant Design Modal/Select 依赖 CSS transition 实现淡入效果
- transition 被强制缩短到 0.001s，在某些 WebView2 渲染引擎中动画状态异常
- Modal 可能"闪过"后消失，或根本不显示

**为什么这台电脑正常，另一台不行？**
- 两台电脑的 WebView2 渲染引擎对极短 transition 的处理方式不同
- 某些渲染引擎能在 0.001s 内正确完成动画，某些不能
- 这取决于底层 Chromium 版本和 GPU 渲染配置

### 最终修复方案

在 `index.css` 中添加例外规则（第1385-1393行）：
```css
/* Modal 和 Select 下拉菜单保持正常 transition，不受动效开关影响 */
[data-motion="off"] .ant-modal-content,
[data-motion="off"] .ant-modal-mask,
[data-motion="off"] .ant-select-dropdown,
[data-motion="off"] .ant-popover-inner {
  transition-duration: 0.3s !important;
}
```

**原理：**
- 动效开关只影响普通元素的动画
- Modal/Select/Popover 等弹出组件保持正常 transition
- 这样既能实现"关闭动效"的效果，又不影响弹窗显示

### 当前代码状态

#### 最终修改内容
1. **移除成本快照栏** - Dashboard.tsx 移除了成本快照相关代码
2. **移除自动生成测试数据** - main.tsx 移除了 seedTestData 自动调用
3. **修复动效开关问题** - index.css 添加 Modal/Select 的 transition 例外规则

#### 未保留的尝试
- `src/compat.css` - 已删除（不需要）
- `getPopupContainer` 配置 - 已移除（不需要）

### GitHub 仓库
- 仓库地址：https://github.com/JT15199/monitor-cost.git
- 已推送当前版本

### 经验教训

**排查 CSS 问题时的关键点：**
1. 不要只关注复杂属性（如 backdrop-filter），简单属性也可能有问题
2. 全局 CSS 规则（如 `[data-motion="off"] *`）可能影响所有组件
3. transition-duration 过短在某些环境下会导致动画状态异常
4. 用户反馈是最重要的线索——用户发现"关闭动效开关就正常"直接指向了问题根源

**类似问题的排查思路：**
1. 让用户尝试不同设置（主题、动效、色温等）
2. 检查全局 CSS 规则，特别是带 `*` 通配符的
3. 检查 `transition` 和 `animation` 相关属性
4. 在不同环境测试同一行为

---

## 业务背景：ODM模式下的成本管理

### 项目性质

**显示器产品采用ODM（Original Design Manufacturer）模式**：
- 品牌方（用户）负责产品规格定义
- ODM供应商负责物料采购、生产制造、质量控制
- 品牌方按整机采购，不直接采购器件

### 用户工作流程

```
品牌方（用户）                    ODM供应商
     │                              │
     │  1. 提出产品规格要求          │
     │ ──────────────────────────▶  │
     │                              │
     │  2. 供应商报价（整机+BOM明细） │
     │ ◀────────────────────────── │
     │                              │
     │  3. 用户细分模块、导入系统    │
     │                              │
     │  4. 审核报价合理性            │
     │    对比多家供应商报价         │
     │                              │
     │  5. 谈价、确认价格            │
     │ ──────────────────────────▶  │
```

### 数据录入方式

用户收到供应商报价BOM后：
1. **自己细分模块** - 将供应商BOM按功能拆分（电源模块、驱动板模块等）
2. **导入系统** - 通过Excel导入功能批量入库
3. **分类整理** - 按大类/子类规范器件分类

### 工具的实际用途

在ODM模式下，工具的核心价值：

| 功能 | 用途 | 备注 |
|------|------|------|
| **器件库** | 存储供应商报价的器件信息 | 数据来源是供应商报价，不是用户采购 |
| **项目管理** | 管理各项目报价BOM | 一个项目对应一次报价 |
| **模块库** | 按功能模块组织器件 | 用户手动拆分，便于分析 |
| **竞品管理** | 管理竞品报价对比 | 对比不同供应商报价 |
| **对比分析** | 多供应商报价对比 | 核心功能：A供应商vs B供应商 |

### 核心痛点

1. **报价审核**：供应商给的BOM明细，怎么判断是不是虚高？
2. **供应商对比**：多家供应商报价，哪家更合理？
3. **谈价筹码**：谈判时需要知道"这个器件市场价是多少"
4. **报价追踪**：同一产品不同阶段报价变化（试产→量产）

### 与传统成本管理的差异

| 维度 | 传统模式（自采自产） | ODM模式 |
|------|----------------------|---------|
| 器件库来源 | 自己采购积累 | 供应商报价累积 |
| BOM创建 | 自己从零构建 | 供应商报价导入 |
| 成本计算 | 自己核算成本 | 供应商已报价，审核合理性 |
| 关注重点 | 成本构成分析 | 报价合理性判断 |

### 器件库数据价值

器件库的价格数据来源于：
- **历史报价累积**：每次供应商报价都入库，形成价格历史
- **多供应商对比**：同一器件不同供应商报价，形成价格区间
- **合理性判断**：新报价与历史对比，判断是否虚高

### 后续功能建议（基于ODM模式）

#### 高优先级

| 功能 | 说明 |
|------|------|
| **报价快速导入** | 供应商报价Excel直接入库，识别模块/器件 |
| **同一器件多报价对比** | "器件X: A供应商35元，B供应商28元" |
| **报价历史追溯** | 同项目不同阶段报价对比 |
| **供应商评级** | 报价水平、配合度、质量记录 |

#### 中优先级

| 功能 | 说明 |
|------|------|
| **报价偏差提示** | 器件报价明显高于历史同类项目 |
| **模块级报价对比** | 不只看器件，也看模块整体报价差异 |
| **报价版本管理** | 同一供应商多次报价，记录版本 |

#### 低优先级（ODM模式下不需要）

| 功能 | 原因 |
|------|------|
| **良率成本** | 供应商负责生产，品牌方不管理良率 |
| **库存成本** | 供应商负责物料，品牌方不持有库存 |
| **采购管理** | 品牌方不直接采购器件 |

---

**文档维护**: 所有重要的项目变更应同步更新此文件。

### 2026-09-04 成本策划规格与费率入口

- 成本策划第一步统一称为“产品规格/产品规格版本”，不再把产品规格称为规格基线。
- 产品规格模板按品类变化：显示器使用屏幕参数，手写笔使用笔尖尺寸/压感级别/延迟，鼠标使用传感器 DPI/重量/连接方式。
- 成本策划新增“成本参数（在此编辑）”：平台费率计入标准成本，利润/管销研费率仅作为财务参数保存。

### 2026-09-04 云端确认队列去重

- 云端洞察待确认队列在统一入队入口按“物料通用名 + 品类”去重，并在读取队列时清理历史重复项，避免自动轮询重复弹出相同确认。

### 2026-09-04 供应商管理决策看板

- 供应商管理新增默认“供应商看板”，按当前筛选口径展示供应商覆盖、报价关系结构、单一来源风险；整机供应商展示 ODM 项目覆盖和项目报价区间。
- 图表只使用当前供应商关系和项目报价快照，不把缺少历史记录的数据伪装成趋势；无数据时显示明确空状态，并可从看板返回详细列表。

### 2026-09-04 二轮验收后续修复

- 目标版本只接入已确认且未计入基线的变更包机会；量产后降本项目纳入巡视范围；成本长城缺失评分保持待评分，不按 0 计算。
- 云端授权由 Rust 后端按数据库票据绑定规范化 URL/参数；C2 绑定正文并原子消费，公开型号使用独立的受控查询范围。预检与实际搜索复用同一搜索端点。
- 原声分析、阶段成本包、资料库深链接、供应商有效来源口径和不可达旧渲染分支已完成代码收口。阶段成本包导出前重新读取来源并区分草稿/冻结。
- 最终离线验证记录见 `docs/CostHub_二轮验收报告_2026-09-04.md`；当前版本通过前端 322 项测试、8 项 Rust 测试及 Tauri MSI/NSIS 构建，但真实云端、桌面交互、模型速度和正式数据流程仍需人工验收。

**最后更新**: 2026-09-04

### 2026-09-12 输出长度策略

- 本地 Pi/llama.cpp 不按机器性能默认限制输出；未配置时不发送 `num_predict` 或 `max_tokens`。
- 用户或模型配置明确给出上限时才发送该值；模型上下文窗口及 llama.cpp/Ollama 服务端自身上限仍生效。

### 2026-09-08 原生 Pi 执行链落地

- Pi 原生模式接入独立任务目录、真实文件 read/write/edit、Windows PowerShell 命令、可用时 Bash、超时/取消、输出截断与全文落盘。
- 文件工具在 Rust 侧拒绝任务目录外路径及 junction/symlink 越界；任务 cwd 不视为安全沙箱，界面按本机执行模式提示真实边界。
- 通过依赖的 `loadSkills` 加载内置 `quote-analysis` Skill；附件会复制进任务目录，界面可打开任务目录；会话保存完整 Pi 消息并支持重启恢复，执行中回车通过 `steer` 注入补充指令。
- 验证：前端 `npm test` 333/333、生产构建通过；Rust `cargo test --lib` 14/14（含 PowerShell 事实执行测试）；Tauri MSI/NSIS 发布构建通过。真实 Ollama 模型质量仍需业务人员验收。

### 2026-09-08 对话图表与 Pi 关键返修

- Pi 新增 `render_analysis_chart`，复用现有 ECharts，支持比较柱形、时间折线和环形构成；对话卡片支持放大、数据表、SVG 导出和打开产物。必须提供来源与计算口径，缺失值保留为 null；图表注明 AI 整理，不能据此宣称来源已自动核验。
- 内置 `analysis-charts` 与 `quote-analysis` Skills 编译进 Rust，在任务 `.skills` 目录释放；普通文件工具只读该目录，独立 EXE 不再依赖开发目录的 public/skills 文件树。
- 任务目录与会话恢复记录绑定；完整 JSON 不再按字符截断；工具执行前后保存检查点。恢复检测到结果未知时禁止业务写入，先核对数据再开新会话；这不是数据库事务级 exactly-once 保证。
- 图表和任务文件不依赖命令执行。PowerShell/Bash 默认关闭，用户通过对话“终端”按钮授权当前会话；后端也检查授权。网络提示改为 Ollama 进程范围，不把 Shell 描述为沙箱。
- 命令先注册再执行，预先取消不启动；输出边读边存文件，预览保留末尾 12KB，每流 32MB 硬上限。Windows Job Object 管理进程树生命周期；提供真实取消检查。
- 传输保留原生工具长文本及图片，原生工具开始/结束事件去重。前端快照、图表合约和实际 Pi 循环有回归检查；视觉样例位于 `prototypes/pi-charts-20260908`，样例数据不属于正式业务数据。
- 本轮最终验证：前端 341 项、Rust 16 项通过，实际组件视觉、SVG 下载与放大通过；`npm run tauri build` 已生成新的 EXE/MSI/NSIS。真实模型正式数据流程未在本轮实测；详细交付与构建提示见 `docs/CostHub_对话图表与Pi返修记录_2026-09-08.md`。
### 2026-09-09 工作手账书脊书架

- 手账册入口改为横向书脊书架，名称对应实际项目或手动关联名称；根据书册稳定标识分配布面色、书脊宽度和高度，新增或排序不改变已有配色。
- 悬停抬升放大，点击抽出并转向封面；阅读器使用等宽双页、独立双面封面与错时纸页，前后翻页不重复打开封面。
- 兼容键盘、窄屏横向滚动、系统减少动态效果和应用动效关闭。浏览器回归脚本：`docs/check-journal-shelf.cjs`（仅浏览器模拟数据，不写正式数据库）。
- 二次调整：书册默认居中；书脊使用细纹布面、浅金文字和双线装帧；翻页约 1.6 秒，使用分段曲面与连续阴影模拟纸张卷曲。
- 修复新建手账 `database is locked`：旧 SQL 接口的分次 BEGIN/COMMIT 固定使用单个持久连接，避免事务跨连接留下写锁；并发加载复用同一连接池。未来扩展并发前需迁移为有明确事务归属的后端命令，单连接并不提供业务任务间事务隔离。
- 手账新建/编辑复用有限次数的 SQLite 锁重试，保存期间按钮显示加载，失败保留输入；覆盖手写项目、下拉项目、重试成功和锁持续占用的浏览器检查及 Rust 事务测试。

### 2026-09-10 手账记录语义与书架分类

- 一本书对应一个项目，空项目也能打开书册；记录按时间排列，打开时定位最近一条。阅读器“继续记录”新建一条且锁定当前项目，“修改本条”仅更新当前 ID；按钮分别为“保存为新记录”和“保存本条修改”。保存后定位到保存的记录，离开未保存的编辑时提示保留输入。
- 书架只保留单排，上方分类筛选；全部视图将同类项目相邻排列，多项目横向滚动。书架分类默认沿用项目品类，可通过“调整书册分类”选择或手写类别。书册分组覆盖值保存到业务数据库 settings 的 `worklog_book_categories`，不更改项目规格品类；搜索只筛选书册入口，打开后仍能阅读该书的完整历史。
- 书脊长名称根据实测空间自动缩小并分列，覆盖 100% / 125% / 150% 缩放；阅读器操作区为关闭按钮留出独立空间。
- 翻页期间不改变记录 ID，动画结束后才切换文字、目录选中项和页码；翻页锁定重复操作，移除翻页过程中的彩色封面边框。只有初次打开书册播放封面动画。
- `node docs/check-journal-shelf.cjs` 已验证长书名、延后切换内容、按钮间距、新增不覆盖、单条修改、锁重试与草稿保留、空书册、分类重载持久化和窄屏。测试使用浏览器模拟数据，不向正式数据库写入。

### 2026-09-10 报价审核简化

- 项目“成本策划”入口改为“报价审核”，默认仅展示本轮报价、报价审核、谈价跟进；产品规格、费用参数、目标及 Charter 等原有功能收进默认关闭的高级策划。
- 保存本轮报价复用 BOM 冻结版本，保留轮次名称和历史。审核选择本项目历史或其他项目已保存的报价，按模块对齐并展示来源；缺失价格、模块或参考均不当作零，不将差额直接计为节省。
- 谈价跟进复用 project_measures，明确预计与已实现降本，有已实现金额时要求依据；新增和更新沿用既有持久化入口。
- 验证：报价及成本合约相关 13 项测试通过，生产构建通过；docs/check-quote-review.cjs 以浏览器模拟数据验证保存轮次、切换参考、新增/更新跟进及默认折叠，不写正式数据库。


### 2026-09-10 AI 情报降噪与审价未知态

- 相同证据的巡视只更新最后见到时间和次数，保留已有 AI 分析、用户反馈及已处理/忽略状态；AI 润色只接收新增或证据变化的候选，避免旧项反复改写。
- 共用审价提示及解析器将证据不足标为 unknown，页面显示待核实，不再计入合理项；禁止凭常识编造价格与来源。后台仍是规则候选加模型润色，不代表已经实现自主研究。
- 相关 19 项测试通过；新增持久化刷新及未知判定回归检查。

### 2026-09-12 llama.cpp 27B 改造落地

- 本地 AI 支持 Ollama 原生接口与 llama.cpp OpenAI 兼容接口；llama-server 使用回环地址，支持应用托管启动/停止、健康检查、模型列表、上下文/视觉能力探测和诊断导出。
- 本地流式传输补齐 UTF-8 分片、SSE/NDJSON、usage、finish_reason、length、工具调用 index/id 合并、取消和未标记 EOF 错误；思考内容、输出上限和模型上下文按实际配置传递，不按机器性能擅自截断。
- Pi 工具支持工作表选择和分页续读，导入遇到缺失价格/数量保留待核实并统计跳过项；工具发现按用户意图预加载只读工具，不依赖趋势任务硬编码禁用。
- 验证：前端 374 项通过、2 项跳过；Rust 20 项通过；`npm run build` 与 `npm run tauri build` 通过，发布包见 `src-tauri/target/release/`。27B 公司电脑上的真实速度、视觉附件和正式报价流程仍需现场验收。

### 2026-09-13 llama.cpp 五次验收 P2 收口

- AiPanel 多轮卡片统一收口；llama.cpp 托管配置不再因非端口字段失焦改写外部 loopback 地址，启动等待按总期限检查进程并保留停止入口。
- 温度未显式覆盖时显示并传递“模型默认”，模型切换重置选项；探针结果绑定配置代次，旧结果不会回填新模型。
- 验证：前端 378 项通过、2 项跳过；Tauri EXE/MSI/NSIS 构建通过；公司 27B、真实 4B HTTP 烟测和正式业务流程仍需现场验收。

### 2026-09-13 llama.cpp 六次验收迟到响应修复

- llama.cpp 启动、停止、配置切换和卸载使用单调服务操作代次；健康响应回填前后校验代次，停止后的旧响应不会恢复“服务可用”，旧启动补偿 stop 不会误停新启动。
- 浏览器专项验收通过；前端 378 项通过、2 项跳过；Tauri EXE/MSI/NSIS 构建通过。公司 27B、视觉 mmproj 和正式业务流程仍需现场验收。

### 2026-09-13 llama.cpp 七次验收与公司数据安全 P1 收口

- 云端策略新增 Rust 强制的 local_only/preview/auto 模式；local_only 默认安全拒绝，授权签发、授权读取和真实供应商发送均拦截，前端同步清空待确认队列及旧授权。
- C1 共享网关校验收紧非查询字段的类型、枚举、范围和嵌套结构；api_key 仅接受后端注入，JSON/URL 侧信道回归用例通过。
- 本地安全状态拆分“仅本机访问”和“模型进程外联隔离”；llama.cpp 不再冒充进程隔离已验证，实际 server 路径和外联策略仍需公司 IT 现场验证。
- 验证：前端 379 项通过、2 项跳过；Rust 20 项通过；Tauri EXE/MSI/NSIS 构建通过。未读取公司数据，未修改公司设备策略。

### 2026-09-14 今日工作台自适应布局

- 工作台布局集中到 `src/pages/Dashboard.css`，移除旧网格定位与收益摘要遗留网格，按实际内容宽度切换三列、两列、单列，兼容侧栏及 AI 面板占用空间。
- 保留现有业务内容、年度收益与模块贡献、项目成本柱状图及详情入口；统一卡片间距、标题和列表对齐，窄窗口自然纵向展开。
- `node docs/check-dashboard-layout.cjs` 使用真实组件及 CSS、虚构数据检查 1360/980/740/560/360px 内容宽度，无卡片重叠、横向越界或收益摘要溢出，详情入口及空状态通过。截图使用示例数据，不写业务数据库。

### 2026-09-14 工作台一屏与立体玻璃图表

- 工作台按父容器宽高分配两行总览，项目列表展示前三项并保留查看全部；内容区不足 900px 时用标签切换下半区，低高度收起次要摘要，避免整页滚动。
- 年度明细改为有独立滚动区的弹层，点击项目关闭弹层并导航；环图增加静态透视、厚度与玻璃高光，柱状图保留真实比例并增加玻璃侧面效果。
- 浏览器检查增加页面与卡片纵向溢出、满三条待办/报价、明细弹层和低高度窗口；六组尺寸通过，使用虚构数据，不改正式数据库。

### 2026-09-14 工作台密度与情报入口收口

- 工作台改为连续玻璃面板，压缩指标与列表留白；宽裕窗口展示五个项目，较小窗口展示三个并保留详情入口。一屏布局和图表真实比例保持不变。
- 侧栏 AI 情报进入实际情报中心，工作台及完成提示提供巡检/自主建议直达入口；导航兼容页面尚未挂载，标签展示实际待处理数量并刷新。
- 修复结构化建议存在时隐藏全部原自主建议的问题：原建议持续可见，结构化参考单独折叠展示。
- 验证：六组尺寸浏览器布局检查通过；真实情报弹层以虚构数据验证冷启动、标签切换、已读计数及 12 条建议与结构化参考共存。前端全量测试 379 项通过、1 项超时、2 项跳过，超时项独立重跑通过（合计 380 项）；Tauri EXE/MSI/NSIS 构建通过。未调用公司模型或读取公司数据。

### 2026-09-14 图表与手账书册管理

- 项目成本分布取消四项截断，按六项翻页并保持全局比例尺；模块贡献改用 SVG 细环与浅浮雕，年度进度条采用玻璃高光，保留小窗口一屏适配。
- 书架使用 settings.worklog_books 保存用户书册目录；首次保留已有记录对应的书册，不再自动生成空项目书册。支持主动新建（可关联项目）、改名、分类和删除；删除仅移除书架入口，记录列表与历史数据保留。
- 独立书册沿用稳定记录归属，改名不移动历史；saveWorkLog 明确传入 project_id=0 时保持不关联，避免同名项目自动吸附独立书册记录。
- 移除内容卡片通用按压缩放和长期 will-change，避免拖选文字时整卡栅格缩放；非显示器项目标题显示关键规格，缺失字段不再拼接占位横线。
- 验证：六组布局、13 项成本翻页、规格与拖选样式、书册 CRUD/重载/独立写入及既有翻页和锁重试浏览器检查通过；工作记录保存单测 2 项通过。全部使用虚构数据，未验证公司 WebView2 的实际渲染。
- 本轮 `npm run tauri build` 完成，已更新 EXE/MSI/NSIS；公司更新时仅替换程序，保留原数据库和模型配置。

### 2026-09-14 BOM 模块快速定位恢复

- 项目 BOM 的模块分组视图增加吸顶模块导航，支持按名称搜索并跳转；列表沿用当前筛选后的模块顺序及器件数，全量表格不显示此入口。
- 跳转复用模块锚点，预留导航高度并将键盘焦点移到目标卡片；特殊字符模块名无需 CSS 选择器转义。
- `node docs/check-module-navigation.cjs` 以真实导航 JSX、Ant Design Tabs 和虚构 30 个模块验证前后跳转、搜索、特殊名称、吸顶遮挡、焦点和窄窗口；TypeScript 检查通过。
- 本轮 Tauri EXE/MSI/NSIS 发布构建通过，已更新 release 下的程序。

### 2026-09-16 本地模型 Excel 批量处理

- 新增 Pi 原生 analyze_spreadsheet：有限结构预览、明确列/明细范围的整表金额计算、模块汇总、小计核对及两表精确对比；完整证据落盘，模型只接收摘要。无需 Shell，不增加外发或业务写入权限。
- 按内容哈希复用工作簿及相同计算；连续重复无变化计算时切入结论。原生数据读取/分析计入已执行，避免业务读取补跑。附件预读和 Excel 默认读取收紧为 8 行，显式续读保留。
- 不信任公式缓存，不把缺失值当零。单价和数量明确时可重算金额，来源公式小计仍待核实；重复标识及不同数量/口径不自动对比，差额不视为实际节省。
- 7 项专项与模拟模型的真实 Pi 执行循环通过；1 万行样例的模型摘要少于 2500 字符，原文留在本地。全量测试 385 项通过、1 项超时、2 项跳过，超时项独立重跑通过；公司 27B 实际速度未实测。详见 docs/CostHub_Excel批量计算优化_2026-09-16.md。
- 最终 Tauri EXE/MSI/NSIS 构建通过，发布产物已更新。


### 2026-09-17 供应商资源池、整机地图、成本总览与首次登录

- 供应商管理增加资源池，复用供应商档案；合并器件、整机和报价中已使用的名称。项目“报价与定点 → 供应商定点”、器件供应商、供应商关系、报价导入可选择已有资源或直接输入。资源档案不代表有效合作或已有报价。
- 整机供应商地图复用供应商多厂区地址，按项目数量显示覆盖；点击落点编辑对应厂区，缺少定位的厂家保留维护地址入口。地图数据本地读取，无新增外发或地理编码请求。
- 今日工作台增加“成本总览”，显示全部项目当前单台 BOM 成本、平台费率及带费率成本，支持搜索、状态筛选、排序、分页和项目跳转。带费率成本 = BOM × (1 + 平台费率)，与现有标准成本一致，利润/管销研费率不计入；缺报价/数量不按零展示。
- 数据库初始化统一复用同一个进行中的任务，完成建表后才发布连接；不再通过受限数据代理执行建表。密码初始化串行复用，校验等待初始化，数据库异常直接显示原因。新数据库为 admin / 666666，已有密码不会重置。
- 验证：392 项前端测试通过、2 项跳过；包含真实空白 SQLite 并发启动、默认密码、改密后重启、错误传播。浏览器以模拟数据验证资源维护、输入复用、ODM 多厂区地图、成本总览及六档工作台布局，不写正式数据库。脚本见 docs/check-supplier-resources.cjs、docs/check-supplier-map.cjs、docs/check-dashboard-layout.cjs。
- 本轮 Tauri 发布构建通过，免安装 EXE 及 MSI/NSIS 已于 2026-09-17 更新。

### 2026-09-17 成本总览密度与历史
- 总览统计改为单行，压缩表格行高，默认每页 20 项；项目列改为无边框文本按钮并修复测量行留白。
- 新增项目类别筛选及类别排序，每行可查看已有成本快照；历史金额和费率按当时记录显示，旧利润口径明确提示，不按当前费率回算。
- 类型检查、六档工作台布局及总览类别筛选/历史记录/项目列边框和行高检查通过，测试使用模拟数据。

### 2026-09-17 免安装首次建库与 Agent 固定计算返修

- 修复 Rust `open_frontend_sql_pool` 未设置 `create_if_missing(true)` 导致仅复制 EXE 时不能创建 `costhub.db` 的根因。使用实际文件路径而非 URL 参数解析，兼容中文、空格和 #。只访问主库的后端边界保留；已有库不重置。
- 登录页明确显示初始化状态，失败保留具体原因和重试按钮；数据库未就绪时不误报密码错误。默认用户名 admin，首次成功建库后显示 666666 提示。
- `query_project_bom` 增加 summary/rank/group：全量筛选后在工具内计算总额、均价、极值、单价/小计排名、模块/大类/子类汇总和占比，再限制返回项数；缺失、并列和空集合显式报告。支持完整项目名称/规范化代号，避免先拉取所有项目再定位。
- Pi 原生工具模式明确固定计算分工，预加载排名工具；同轮连续相同成功只读查询在 30 秒内复用证据，第三次重复进入结论收尾。写工具或原生文件/命令操作清空复用记录，失败不缓存，不跨任务复用；未强制限制用户配置的思考或输出预算。
- 测试：394 项前端通过、2 项跳过；Rust SQL 边界 3 项通过，含真实空白磁盘建库/重开和特殊路径。10,002 行 BOM 覆盖分页外最大值、单价/小计区别、分组、缺失和并列；Pi 模拟传输检查重复查询只执行一次并收尾。
- 独立发布 EXE 的真实 WebView2 验证通过：空目录仅 EXE 自动创建 costhub.db、初始化 admin / 666666、首次登录及重启登录；无模拟 IPC、未使用正式数据库。记录见 docs/portable-first-run-result.json。发布 EXE/MSI/NSIS 已重建。

### 2026-09-17 供应商地图分层与交互优化

- 默认省界及省名，3.5 倍起显示当前视野内的城市边界和避让后的城市名；不绘制区县细分，城市数据按需加载。
- 地理路径投影和轻量简化只在数据变化时计算；拖拽、滚轮更新按动画帧合并，滚轮围绕鼠标位置缩放。
- 修正全国地图居中、省份点击定位和供应商聚合点位置；拖动不再误触省份，保留键盘定位及厂家地址入口。
- 浏览器检查：node docs/check-supplier-map.cjs，覆盖分层、可见区域裁剪、地名避让、定位、拖动防误触及 ODM 多厂址维护。测试使用模拟数据；公司电脑实际帧率尚未实测。

### 2026-09-18 年度收益控件修复与 Agent 复用评估

- 今日工作台年份改为真实选择，按已有收益年份和当年生成选项，收益及目标按选中年同步读取；异步过期结果丢弃。
- 明细入口移除全局 AntD 按钮背景干扰并显示年份标题；收益进度使用细刻度、轻薄模块环图，测算数据明确标注。
- Agent 本轮只评估：当前已使用 Pi Agent 核心；建议收敛原生提示、表格工具及事件链，保留写入确认与本地安全边界。详见 docs/CostHub_Agent复用与工作台修复_2026-09-18.md。

### 2026-09-18 Agent 原生执行链收敛与审计通道修复

- 新会话默认 Pi 原生模式，自检失败不再自动降级；旧模型兼容需在空会话手动选择，协议随会话保存。原生提示独立于旧文本协议，表格附件不再重复预读，统一优先 analyze_spreadsheet。
- 本轮只读查询缓存支持交替重复识别；写入、原生文件操作及上下文压缩使缓存失效。继续保持串行工具执行、写入确认及中断恢复保护。
- Pi 记录轮次、工具次数、token、首输出/首工具和模型回合/工具/检查点耗时，执行统计不含业务内容。真实目标模型对照入口：src/__tests__/agentLocalComparison.test.ts，默认跳过，仅允许回环地址及合成数据。
- ai_request_logs 新增 request_channel，调用入口显式标记 local/cloud；旧 Ollama、llama.cpp 各种名称统一识别，空来源标为 unknown。审计列表支持通道筛选，云端日用量和 token 汇总共用相同口径。
- UI 摘要日志不再把失败或取消记为成功；未记录来源不默认显示本地。受控云端外发日志与请求通道分类仍是两个不同维度，分类修复不更改网络权限。

### 2026-09-18 AI Gateway Phase 1-2

- Phase 1 新增薄 Gateway 适配层，`runPiAgent` 继续复用现有 Pi Agent、Ollama 和 llama.cpp Local Stream；当前仅选择 Local 路由，保留原有请求与工具行为。
- Phase 2 在现有请求预算计算处增加发送前上下文估算：context window、当前 tokens、系统提示、历史消息、Tool Result、工具 Schema、输出预留、安全余量和最大来源；面板显示摘要，完整分项写入会话事件账本。
- 未修改 Pi 上游、Compaction、隐私路由或 Cloud Route。定向测试 11 项通过，`npm run build` 通过；构建保留既有 xlsx 动态导入和大 chunk 警告。

### 2026-09-18 AI Gateway Phase 3

- 大型 Tool Result 统一写入任务目录并生成稳定 `resultId` 与本地元数据；模型上下文只接收摘要和 `resultId`，完整结果通过新增只读 `result_read` 按范围或关键词取回。
- 兼容已有 `.costhub-results` 路径，原生表格/读取结果也会注册到结果存储；完整 Session 与任务文件不删除。新增 Local Context Builder 作为后续 Structured State / Retrieval 的唯一投影入口。
- 验证：结果存储、分页、路径兼容、表格运行链及既有 Pi 回归共 8 个测试文件、18 项通过；`npm run build` 通过。未修改 Compaction、Privacy Router 或 Cloud Route。

### 2026-09-18 AI Gateway Phase 4

- 新增共享 `ContextMetadata` 与 `WorkingState`：保存当前目标/任务、项目引用、约束、事实、决策、开放问题、工具、步骤和业务上下文，并为条目记录 priority、sensitivity、provenance、sourceMessageIds 与 superseded/closed 状态。
- Pi 每个主 Turn 结束只把本轮消息交给本地确定性 State Extractor，增量更新并通过现有 `pi_state_json` 持久化；旧 Session 和原始消息不删除。解析失败不影响 Agent 回复，恢复会话继续沿用工作状态。
- 目标成本支持“新确认值替代旧值”；不确定的新陈述不能覆盖 confirmed fact。验证：工作状态三项冲突/保留测试通过；未修改 Compaction、Privacy Router 或 Cloud Route。

### 2026-09-18 AI Gateway Phase 5

- 基于当前实际使用的 Pi Agent 0.84.4 `transformContext` 扩展点接入上下文治理；未虚构或替换当前 Agent 不具备的 `session_before_compact` 生命周期钩子。原始 Session 仍保留，发送前只生成投影。
- 新增 GREEN/YELLOW/ORANGE/RED 水位策略：低水位直通，YELLOW 轻量去重/降噪，ORANGE/RED 生成结构化摘要并保留最近窗口；摘要记录覆盖范围、版本、敏感度和 `compactionState`。
- 压缩失败或预算不足时采用保守尾部裁剪并发出 warning，保留 Working State，不把完整历史继续发送；Local Context Builder 将有界 Working State 注入 provider 投影，且不修改原始消息。
- 验证：80 个测试文件通过、1 个跳过；411 个测试通过、3 个跳过；`npm run build` 通过。保留既有 xlsx 动态导入和大 chunk 警告；未修改 Privacy Router 或 Cloud Route。

### 2026-09-18 AI Gateway Phase 6

- 新增统一 Privacy Router：Source Policy → Regex Guard → 本地分类器，复用既有 `security.ts` 严格审计并补齐 Private Key、API Key、Bearer Token、Password、Email、Phone、Local Path 及 ODM 敏感词规则；Source Policy 与 Regex 命中不可被分类器降级。
- 输出 `public / sensitive / unknown`、`cloudSafe`、候选路由和不含敏感样本的 reason code；任何分类器异常或无明确公共信号均回到 `unknown → local`。当前会话默认标记 `private_workspace`，不产生云端发送。
- Gateway 在实际 provider 请求前发出 `privacy_evaluation` trace；Pi Runtime、Context Metadata 和 Working State 共用隐私元数据类型。Phase 6 保留本地执行，Cloud Route / CloudSafe Projection 留到 Phase 7。
- 验证：81 个测试文件通过、1 个跳过；421 个测试通过、3 个跳过；`npm run build` 通过。保留既有 xlsx 动态导入和大 chunk 警告。

### 2026-09-18 AI Gateway Phase 7

- 新增独立 CloudSafe Context Builder：只接收显式 approved messages/retrieval，Working State 仅保留 `public + cloudSafe` 条目；不接收原始 Agent Context，不带本地文件、Tool Result、BOM、报价或内部工具定义。
- Cloud projection 使用固定 Cloud System，重新构造消息/检索/公开状态，并强制 `tools=[]`；非 Public、UNKNOWN、未批准内容均被过滤或阻止。
- Gateway 增加显式 Cloud Provider 适配器：只有 `public + cloud_candidate + cloudSafe` 且上下文无工具时才调用；现有默认 Pi Agent 和受控行情/C2 工具链仍保持原路径，不自动把本地会话切到云端。
- 验证：83 个测试文件通过、1 个跳过；425 个测试通过、3 个跳过；`npm run build` 通过。构建保留既有 xlsx 动态导入和大 chunk 警告。

### 2026-09-18 AI Gateway Phase 8

- AI 协作窗顶部新增本地模型在线状态、隐私路由开关状态、Route/Provider 和外发计数；Context 可展开查看核心指令、Working State、最近对话、检索内容、工具上下文与输出预留。
- 统一 Trace 接入 Context Preparation、Privacy Check、Route/Provider、CloudSafe Context 重建和 Outbound Count；Privacy 展示 Source Policy / Regex / Classifier 结果，不展示原始敏感内容。
- Compaction Trace 展示旧对话 tokens 前后、关键事实数、决策数，并明确 Working State 与原始 Session 仍保存在本地；新增 cloud_context 事件供公开请求审计。
- 验证：83 个测试文件通过、1 个跳过；425 个测试通过、3 个跳过；`npm run build` 通过。构建保留既有 xlsx 动态导入和大 chunk 警告。

### 2026-09-18 AI Gateway Phase 9

- 新增 `src/__tests__/gatewayLongSession.test.ts` scripted scenario，覆盖 100 turns（含 50-turn 检查点）、10 次 Compaction、项目 A→B、目标成本 400→390、策略/待确认项、大量 Tool Call、180 行 BOM Result、Public/Sensitive/UNKNOWN、分类器失败、Cloud 失败、Local 失败和 Gateway Trace。
- 长会话验收验证 raw Session token 大于 active projection、active context 始终不超过 inputHard、Working State 关键事实/决策/项目切换仍可召回，完整 BOM 只在本地 Result Store，模型消息只保留 resultId 与受限标量摘要。
- 修复 Compaction 预算遗漏 Local Working State 注入的问题；保守剪枝现在会再次按实际 Local projection 拟合 inputHard。修复结构化大 Tool Result 被 `extra` 原样带回 active context 的问题。
- Cloud 安全判定失败时 Gateway 阻止 Cloud 并回落 Local；Cloud Provider 自身失败仍显式报错。全量验证：84 个测试文件通过、1 个跳过；426 个测试通过、3 个跳过；`npm run build` 通过。构建保留既有 xlsx 动态导入和大 chunk 警告。

### 2026-09-18 AI Gateway 二次验收修复

- Working State 的决策、开放问题、文件、产物和步骤按当前项目归属；局部项目属性先合并到当前项目再写入目标成本，A→B 不再继承 A 的项目状态。Context Builder、CloudSafe 投影和 Trace 归属表只展示当前可见项目内容。
- AiPanel 新增“本轮数据路径”回放入口，切换会话从 `loadPiEvents` 恢复最新运行的 Gateway Trace；隐私 Trace 正确区分 Source Policy/Regex/Classifier 的“未运行”，Trace 持久化失败会显示为失败步骤。
- CloudSafe 由实际 AiPanel 路径构建并通过 `C1_PUBLIC_CONTEXT` Rust 边界发送；只接受固定公共系统边界、无工具的公开投影，必须经过本轮审批。网络 Trace 改为显式随调用传递，区分外发尝试与已确认传输，并记录真实 egress audit 结果。
- 验证：前端 84 个测试文件、431 项通过、3 项跳过；Rust `cargo test --lib` 22/22；`npm run build` 和 `npm run tauri build` 通过。新产物为 `src-tauri/target/release/costhub.exe`、MSI 与 NSIS 安装包。

### 2026-09-18 AI Gateway 三次验收修复

- `public_*` 来源标签和 `approved` 布尔值不再自证公开；隐私分类要求可信元数据或用户明确审阅实际文字，并在本地规则发现保密/未发布信号时回到 `UNKNOWN → Local`。
- `C1_PUBLIC_CONTEXT` 审批票绑定实际 `model/messages` JSON 的 SHA-256；审批队列展示本轮真实公开投影，Provider 使用同一请求体序列化，Rust 侧拒绝篡改或附加本地字段。
- 网络 Trace 增加 `not_sent / confirmed / unknown`；调用前取消/审批拦截明确为未发送，Rust 调用中断、超时或底层不可取消明确为发送情况未知，取消会传入 Provider 并阻止迟到响应伪装成功。
- 数据路径面板支持历史运行选择，信息归属表补充来源、判定依据、本轮投影和实际外发，并明确当前状态不是历史快照；早期隐私阶段显示 Regex 未运行，Classifier 标为规则分类器。
- 验证：前端 84 个测试文件、432 项通过、3 项跳过；Rust `cargo test --lib` 22/22；`npm run build` 和 `npm run tauri build` 通过。真实云端凭据、正式数据和桌面交互仍需人工验收。

### 2026-09-19 AI Gateway 四次验收修复

- Cloud Provider 请求新增 Rust 侧 `requestId` 取消注册表；前端停止等待时通知后端，后端用 `tokio::select!` 终止发送/读取响应的网络 future，并将取消或失败写入 egress audit。取消通知失败时界面明确提示后台请求可能继续，保留 `unknown`，不伪称已取消网络。
- Gateway 历史回放改为仅读取 Gateway 事件与 checkpoint，并按数据库 ID 游标分页；加载异常显示告警，不把空结果解释成无事件。checkpoint 保存该运行的 Working State 与任务目录，历史运行不会再套用当前会话状态。
- 数据路径面板的来源 ID 可打开同一运行的原始消息或任务文件；公开投影条目标出实际主模型 `requestId`，历史状态快照缺失时明确提示，不提供伪历史。
- 验证：前端全量 84 个测试文件、432 项通过、3 项跳过；Rust `cargo test --lib` 23/23；`npm run build` 和 `npm run tauri build` 通过。新产物为 `src-tauri/target/release/costhub.exe`、`CostHub_2.3.19_x64_en-US.msi` 与 `CostHub_2.3.19_x64-setup.exe`。真实云端取消、正式数据和公司电脑桌面交互仍需人工验收。

### 2026-09-19 AI Gateway 五次验收修复

- Pi 消息在入账边界统一分配稳定 `message.id`；Working State、原始消息持久化和无事件时的用户消息回退共用同一来源 ID。来源查询改为按当前会话扫描全部运行，早期轮次的事实可以从后续运行的归属表回看。
- Rust 云端请求在发送前先检查取消状态，并用优先取消分支覆盖发送与响应读取；新增合成检查覆盖取消先到、注册后取消和读取期间取消。已发出的网络内容仍不承诺可撤回。
- 数据路径表将“仅准备投影”“已确认外发”“未发送”和“发送情况未知”分开，不再凭公开投影 ID 宣称请求已成功发出；来源按钮改为当前会话级定位。
- 验证：前端全量 84 个测试文件、435 项通过、3 项跳过（复核时提高单测试等待上限）；Rust `cargo test --lib` 24/24；`npm run build` 和 `npm run tauri build` 通过。新产物为 `src-tauri/target/release/costhub.exe`、`CostHub_2.3.19_x64_en-US.msi` 与 `CostHub_2.3.19_x64-setup.exe`。真实云端、正式数据、浏览器/桌面交互和公司电脑 27B 仍需人工验收。

### 2026-09-20 AI Gateway 六次验收发布打包

- 六次验收确认前两项阻断已通过代码和定向自动化复验；本轮未修改业务实现、未访问正式数据，仅重新执行发布构建。
- 新产物：`src-tauri/target/release/costhub.exe`、`CostHub_2.3.19_x64_en-US.msi`、`CostHub_2.3.19_x64-setup.exe`。真实桌面三轮交互、合成云端取消和公司电脑 27B 仍按验收文档单独人工验证。

### 2026-09-20 对话内云端审批

- CloudSafe 的公开正文审阅、实际请求体批准改为对话卡片；沿用既有正文哈希授权和 Rust 校验，批准后继续当前请求，拒绝本次不会自动发送。审批等待期间禁止切换任务或重复发送。
- 对话区可直接处理既有云端工具/后台待审批队列，显示请求范围、目标与正文预览；全局待确认入口保留。没有新增“本地模型自主切换云端主模型”能力，CloudSafe 主路由仍手动选择。
- llama.cpp 上下文仍以服务 `/props` 报告为准；托管启动参数改动需重启服务，外部启动服务需在外部修改。输出上限按后端/地址/模型保存，主对话发送 `max_tokens`；留空不发送该字段。新增请求体参数回归。
- 验证：审批/本地后端相关 24 项测试通过；合成浏览器卡片的批准、拒绝、无弹窗、窄屏检查通过（`node docs/check-cloud-approval.cjs`，先启动 5179 Vite）；前端生产构建通过。未使用正式数据或真实云端，未重新打包 EXE。

### 2026-09-20 AI 协作界面与审批可视化改造

- 依据更新后的 `CostHub_AI协作界面与审批可视化改造方案_交付Luna_2026-09-20.md` 完成收口：对话区采用单一消息流，移除右侧结果画布；执行过程、推理、决策路径和上下文准备分层折叠，状态只由真实事件驱动。
- 云端审批改为当前会话/运行/requestId 绑定的对话卡片，显示完整实际载荷、来源、审计、敏感区间、字符/消息/token 估算；审批前不截断、不发送工具，拒绝、取消、旧载荷失效和后端复核均保留明确状态。全局通知只负责定位，不批量放行或混合其他会话队列。
- AI 工作文件默认落在 EXE 同目录，可在设置中指定有效文件夹；输出使用碰撞安全文件名，不覆盖既有文件，生成失败明确提示。前端不能直接给模型开放 EXE 目录，产物通过后端受控写出。
- 验证：`npx vitest run --maxWorkers=1` 为 85 个测试文件通过、1 个跳过，444 项通过、3 项跳过；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib` 为 24/24；`npm run build` 和 `npm run tauri build` 均通过。保留既有 xlsx 动态导入和大 chunk 警告。
- 新产物：`src-tauri/target/release/costhub.exe`、`src-tauri/target/release/bundle/msi/CostHub_2.3.19_x64_en-US.msi`、`src-tauri/target/release/bundle/nsis/CostHub_2.3.19_x64-setup.exe`。真实云端、正式数据、桌面交互、审批取消和公司电脑 27B 模型仍需人工验收。

### 2026-09-20 API 凭据持久化修复

- 修复旧版本供应商密钥只有 DPAPI 密文、尚未补齐端点/注入方式时被误报为“未配置”的问题；读取和实际请求前会按当前供应商配置补齐绑定，旧明文记录仅在 Windows 后端迁移到保险库后清理，无法迁移的旧浏览器加密值保留并提示重新录入。
- 设置页不回显 API Key，但会明确显示“已配置/留空保持不变”；保存和读取失败不再静默伪装成未配置。
- 验证：前端全量 85 个测试文件通过、1 个跳过；445 项通过、3 项跳过；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib` 24/24；`npm run build` 通过。随后重新执行 Tauri 发布打包。

### 2026-09-20 洞察审批入口与 LLM 配置一致性修复

- 修复物料洞察进入待审批后只有提示、找不到批准按钮的问题：右下角入口改为“查看并审批”，点击后直接展开右侧 AI 协作窗并定位审批卡；未绑定会话的洞察请求也会显示完整的公开查询范围和批准/拒绝按钮。
- LLM/搜索预检改为只认可当前启用且可读的供应商；运行时配置读取在状态短暂失败时保留已确认状态，并在旧状态为未配置时主动重读后端保险库，避免“设置页测试成功、洞察流程却说未配置”。
- 验证：前端定向审批测试 10/10；全量 85 个测试文件通过、1 个跳过，445 项通过、3 项跳过；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib` 24/24；`npm run build` 和 `npm run tauri build` 均通过。真实云端与正式数据仍需人工验收。

### 2026-09-20 协作窗控制与授权库一致性修复

- 云端审批请求统一以 Rust 云端授权库的网络策略为准，避免设置页已开启条件审批但业务库仍按纯本地模式拦截，导致没有真实待审批项。
- 恢复右上角全屏按钮；思考模式改为协作窗内可见开关，放在顶部控制下方，并沿用原有本地记忆和执行参数。
- 验证：定向审批测试 10/10；全量 85 个测试文件通过、1 个跳过，446 项通过、3 项跳过；`npm run build` 和 `npm run tauri build` 均通过。

### 2026-09-20 审批卡实际入队状态修复

- 修复纯本地模式或请求校验未通过时仍提示“批准后可继续”的误导：没有真实队列项时抛出独立的未入队状态，并明确提示开启“新主题先审批”后重试。
- 未绑定会话的真实待审批项到达时，右侧 AI 协作窗自动展开并定位审批卡；后台任务仍保留独立待审批入口，不伪造对话卡。
- 验证：相关审批测试 10/10；全量前端 85 个测试文件通过、1 个跳过，446 项通过、3 项跳过；`npm run build` 和 `npm run tauri build` 均通过。

### 2026-09-20 审批持久化与完整载荷修复

- 待审批队列持久化；审批绑定 session/run/message/requestId；后台/其他会话进入独立待审批中心。
- C1 搜索审批绑定完整 method/url/body，Rust 按完整请求哈希复核；主 CloudSafe 审批卡支持修改候选载荷并重新审批。
- 拒绝本次只作用本次；30 天忽略改为独立选项；新增只读审批历史。
- 新增可选本地模型敏感复核、琥珀色高亮与依据展示。
- 生成文件返回可渲染元数据并写入历史；设置页新增选择文件夹，导出记录按当前 AI 工作文件夹读取。
- 验证：npx tsc -b、npm run build、npx vitest run --maxWorkers=1（85 文件通过、446 项通过、3 项跳过）、cargo test --manifest-path src-tauri/Cargo.toml --lib（24/24）通过。真实云端、正式数据和桌面交互仍需人工验收。
