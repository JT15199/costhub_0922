# 显示器成本管理系统 v2.2

一个用于管理显示器产品成本的桌面应用程序，基于 Tauri + React + TypeScript 构建。

## 功能特性

- 📊 **仪表盘** - 统计概览和可视化图表
- 🔧 **器件库** - 器件信息管理和价格历史追踪
- 📦 **模块库** - 模块定义和复用
- 📋 **项目管理** - BOM管理、成本评审、降本措施
- 🏭 **竞品管理** - 竞品分析和对比
- 📈 **对比分析** - 多维度成本对比
- 📄 **成本报告** - 报告生成和导出

## 技术栈

- **前端**: React 19 + TypeScript + Ant Design + ECharts
- **后端**: Tauri 2 + Rust
- **数据库**: SQLite
- **构建工具**: Vite

## 开发环境

### 前置要求

- Node.js 18+
- Rust 1.77.2+
- pnpm 或 npm

### 安装依赖

```bash
npm install
# 或
pnpm install
```

### 开发模式

```bash
# 仅前端开发
npm run dev

# Tauri 开发模式（完整应用）
npm run tauri:dev
```

### 构建发布

```bash
# 构建前端
npm run build

# 构建 Tauri 应用
npm run tauri:build
```

构建产物位于 `src-tauri/target/release/` 目录。

## 项目结构

```
monitor-cost-main/
├── src/                   # React 前端源代码
│   ├── App.tsx           # 主应用组件
│   ├── db.ts             # 数据库操作
│   ├── constants.ts      # 常量配置
│   ├── types.ts          # 类型定义
│   ├── main.tsx          # 入口文件
│   ├── index.css         # 样式文件
│   └── pages/            # 功能页面组件
├── src-tauri/            # Rust 后端源代码
│   ├── src/
│   │   ├── lib.rs        # 主库文件
│   │   └── main.rs       # 入口
│   ├── tauri.conf.json   # Tauri 配置
│   ├── Cargo.toml        # Rust 配置
│   └── icons/            # 应用图标
├── public/               # 静态资源
├── index.html            # 入口 HTML
├── package.json          # npm 配置
├── vite.config.ts        # Vite 配置
├── tsconfig.json         # TypeScript 配置
└── CLAUDE.md             # 详细技术文档
```

## 使用说明

1. 启动应用后，数据库文件 `monitor_cost.db` 会自动创建在 exe 同目录
2. 首次使用建议先在器件库添加基础器件数据
3. 在项目管理中创建项目并配置 BOM
4. 使用竞品管理功能对比分析竞争对手产品
5. 通过仪表盘查看整体统计数据

## 主题定制

应用支持多种主题调色板：
- Apple 紫粉
- Tiffany 蓝玻璃
- Paper 白底
- Rose Gold 玫瑰
- Aurora 极光
- Mint 薄荷
- Sky 天空

还支持深浅模式、色温调节、动效控制和缩放级别调整。

## 快捷键

- `Ctrl/Cmd + K` - 全局搜索（器件、项目、竞品）

## 详细文档

查看 [CLAUDE.md](./CLAUDE.md) 获取完整的技术文档和开发指南。

## 许可证

私有项目

## 更新日志

### v2.2.0
- 新增项目分组管理
- 新增 BOM 引用和差异分析
- 新增软删除机制
- 新增全局搜索功能
- 新增最近更新器件侧边栏
- 新增多主题调色板系统
- 新增色温调节
- 新增动效控制
- 新增缩放控制
- 优化项目拖拽排序
- 优化竞品排序功能

---

© 2024-2026 Monitor Cost Manager