# 开发指南

## 开发环境设置

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发服务器

**仅前端开发（快速预览）**：
```bash
npm run dev
```
访问 http://localhost:5173

**完整应用开发（包含 Tauri）**：
```bash
npm run tauri:dev
```
注意：需要先安装 Rust 环境

### 3. 构建生产版本

```bash
# 构建前端
npm run build

# 构建完整应用
npm run tauri:build
```

## 代码规范

### TypeScript 严格模式

项目使用 TypeScript 严格模式，确保类型安全：
- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

### 代码格式化

使用 Prettier 格式化代码：
```bash
npm run format
```

### 类型检查

单独运行 TypeScript 类型检查：
```bash
npm run type-check
```

## 项目结构

```
src/
├── App.tsx           # 主应用组件
├── db.ts             # 数据库操作层
├── constants.ts      # 常量和配置
├── types.ts          # 类型定义
├── main.tsx          # 入口文件
├── index.css         # 全局样式
├── vite-env.d.ts     # 类型声明
└── pages/            # 功能页面
    ├── Dashboard.tsx
    ├── PartsLibrary.tsx
    ├── ModuleLibrary.tsx
    ├── Projects.tsx
    ├── Competitors.tsx
    ├── Compare.tsx
    ├── Reports.tsx
    └── CostControl.tsx
```

## 路径别名

使用 `@` 别名简化导入：

```typescript
// 旧方式
import { getCategoryColor } from './constants';

// 新方式（推荐）
import { getCategoryColor } from '@/constants';
```

## 数据库操作

### 基本查询

```typescript
import { getParts, savePart, deletePart } from '@/db';

// 查询器件
const parts = await getParts('关键词', '子类', '大类');

// 保存器件
await savePart({
  name: '器件名称',
  model: '型号',
  cost: 100,
  // ...
});

// 删除器件
await deletePart(partId);
```

### 数据库迁移

数据库 schema 自动补齐机制：
- 启动时自动检测缺失列/表
- 通过 `ensureSchema()` 函数补齐
- 不依赖线性迁移历史

## 主题系统

### 调色板配置

在 `constants.ts` 中定义：

```typescript
export const PALETTES = [
  { id: 'apple', name: 'Apple 紫粉', swatch: '...' },
  // ...
];
```

### CSS 变量

使用 HTML 属性控制主题：

```html
<html data-theme="light" data-palette="apple" data-motion="on">
```

## 常见问题

### 1. TypeScript 报错找不到模块

检查 `tsconfig.json` 的 `paths` 配置是否正确。

### 2. 数据库路径错误

确保 exe 和数据库在同一目录，或检查 `src-tauri/src/lib.rs` 的 `get_db_url()` 函数。

### 3. 前端样式不生效

检查 `index.css` 是否被正确导入到 `main.tsx`。

### 4. Tauri 构建失败

检查 Rust 版本 >= 1.77.2，并确保已安装所有依赖。

## 性能优化

### 1. 开启动效性能模式

用户可在侧边栏关闭动效（性能模式），减少动画开销。

### 2. 缩放控制

根据屏幕分辨率调整缩放级别（80%-150%）。

### 3. 数据库查询优化

- 使用索引（如 sort_order）
- 避免全表扫描
- 合理使用 LIMIT

## 安全注意事项

### 1. Excel 导入安全

xlsx 库已更新至 SheetJS 官方分发 0.20.3，修复了已知安全漏洞。仍应避免导入来源不明的 Excel 文件。

### 2. 数据备份

定期备份 `monitor_cost.db` 文件，避免数据丢失。

### 3. 数据验证

所有用户输入应进行前端验证，必要时在 Rust 后端进行二次验证。

## 测试建议

目前项目缺少测试框架，建议添加：

1. **单元测试** - Jest + React Testing Library
2. **E2E测试** - Playwright 或 Cypress
3. **数据库测试** - 测试 CRUD 操作

## 调试技巧

### 前端调试

- 使用浏览器 DevTools
- 添加 `debugger` 语句
- 使用 `console.log` 调试

### Tauri 调试

```bash
# 开启调试模式构建
npm run tauri:build -- --debug
```

### 数据库调试

使用 SQLite 工具查看数据库：
- DB Browser for SQLite
- SQLite Studio

## 发布清单

发布前检查：

1. ✅ 更新版本号（package.json + Cargo.toml）
2. ✅ 运行所有测试
3. ✅ 构建测试（`npm run build`）
4. ✅ Tauri 构建（`npm run tauri:build`）
5. ✅ 测试 exe 文件运行
6. ✅ 更新 CHANGELOG.md
7. ✅ 备份数据库

---

更新日期：2026-06-21
