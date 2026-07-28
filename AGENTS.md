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

**最后更新**: 2026-06-23

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

**最后更新**: 2026-06-26