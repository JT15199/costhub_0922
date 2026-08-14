# CostHub 构建指南

## 快速构建（推荐）

在项目根目录双击运行：
```
build.bat
```

该脚本会自动完成以下步骤：
1. ✓ 检查 Node.js 和 npm 环境
2. ✓ 构建前端资源（TypeScript + React + Vite）
3. ✓ 构建 Tauri 应用（Rust 后端 + 前端打包）
4. ✓ 输出最终可执行文件

## 输出位置

构建成功后，可执行文件位于：
```
src-tauri\target\release\costhub.exe
```

## 手动构建步骤

如果需要手动构建，在项目根目录执行：

### 1. 安装依赖（首次构建）
```bash
npm install
```

### 2. 构建前端
```bash
npm run build
```

### 3. 构建 Tauri 应用
```bash
npm run tauri:build
```

## 开发模式

### 前端开发（热重载）
```bash
npm run dev
```
访问：http://localhost:5173

### 完整应用开发
```bash
npm run tauri:dev
```

## 环境要求

- **Node.js**: 18+ 
- **npm**: 9+
- **Rust**: 1.77.2+ (Tauri 会自动安装)
- **操作系统**: Windows 10/11

## 常见问题

### Q: 构建失败，提示找不到 tauri 命令
**A:** 确保已在 package.json 中添加了 tauri 脚本：
```json
"scripts": {
  "tauri": "tauri",
  "tauri:dev": "tauri dev",
  "tauri:build": "tauri build"
}
```

### Q: 数据库文件在哪里？
**A:** `costhub.db` 会在首次运行时自动创建，位于 `costhub.exe` 同目录下。

### Q: 如何保留旧版本数据？
**A:** 如果之前使用的是 `monitor_cost.db`，需要手动复制并重命名：
```bash
copy monitor_cost.db costhub.db
```

### Q: 构建的 exe 文件很大（15-17MB）
**A:** 这是正常的，包含了：
- Rust 运行时
- WebView2 引导程序
- 前端资源（React + Ant Design + ECharts）
- SQLite 数据库引擎

## 版本信息

当前版本：**v2.3.15**
- 应用标识符：`com.costhub.app`
- 数据库文件：`costhub.db`
- 构建目标：Windows x64

## 更多信息

详细文档请参阅：`CLAUDE.md`
