# 应用部署指南

## 📦 构建应用

### 1. 构建 exe 文件

```bash
# 在项目根目录执行
npm run tauri:build
```

**构建时间**：
- 首次构建：约 5-10 分钟
- 后续构建：约 2-3 分钟（增量编译）

**构建产物位置**：
```
src-tauri/target/release/
├── monitor-cost-manager.exe  ← 主应用程序
├── monitor_cost.db           ← 数据库（首次运行自动创建）
└── 其他依赖文件...
```

### 2. 构建状态检查

构建过程中可以看到：
- ✅ 前端编译（Vite）
- ✅ TypeScript 类型检查
- ✅ Rust 编译（Cargo）
- ✅ Tauri 打包

## 📁 部署到另一台电脑

### **方案1：最小部署（推荐）**

**只需要复制这一个文件**：
```
monitor-cost-manager.exe
```

**首次运行**：
- 数据库文件 `monitor_cost.db` 会自动创建在 exe 同目录
- 应用窗口自动打开（1400×860）

**注意事项**：
- ✅ 无需安装，直接运行
- ✅ 无需额外依赖（Windows 系统自带 WebView2）
- ✅ 数据文件与 exe 同目录（便于管理）

### **方案2：完整部署（包含数据）**

如果你想保留现有数据，复制这两个文件：
```
monitor-cost-manager.exe
monitor_cost.db  ← 你的数据库文件
```

放到目标电脑的任意目录，双击 exe 即可运行。

### **方案3：便携版部署**

创建便携包结构：
```
显示器成本管理_v2.2/
├── monitor-cost-manager.exe
├── monitor_cost.db          ← 数据文件（可选）
├── README.txt               ← 使用说明
└── backups/                 ← 备份目录（建议创建）
```

**README.txt 内容建议**：
```
显示器成本管理系统 v2.2

使用方法：
1. 双击 monitor-cost-manager.exe 启动应用
2. 数据库 monitor_cost.db 会自动创建/使用
3. 建议定期备份 monitor_cost.db 文件

功能说明：
- 器件库管理
- 项目成本计算
- 竞品分析
- 成本报告导出

技术支持：查看 CLAUDE.md 文档
```

## ⚠️ 目标电脑环境要求

### **最低要求**：
- ✅ Windows 10 或更高版本
- ✅ WebView2 运行库（Windows 10+ 通常自带）

### **检查 WebView2**：

如果目标电脑缺少 WebView2，应用会提示安装：
- 自动下载安装包
- 或手动下载：https://developer.microsoft.com/microsoft-edge/webview2/

**大多数 Windows 10/11 电脑已自带 WebView2，无需额外安装。**

## 🔄 数据迁移

### **场景1：新电脑首次使用**
- 只复制 exe 文件
- 数据库自动创建（空数据库）
- 需要重新录入数据或导入 Excel

### **场景2：迁移现有数据**
- 复制 exe + db 文件
- 所有数据完整保留
- 直接继续使用

### **场景3：多电脑共享数据**
**方案A：手动同步**
- 定期复制 db 文件
- 手动替换目标电脑的 db 文件

**方案B：云盘同步（推荐）**
```
显示器成本管理/
├── monitor-cost-manager.exe
├── monitor_cost.db  ← 放在 OneDrive/坚果云同步目录
└── backups/
```

**注意**：
- ⚠️ 不要在多台电脑同时打开应用（数据库冲突）
- ✅ 使用云盘同步时，关闭应用后再同步

## 📊 数据备份建议

### **自动备份方案**：

创建批处理脚本 `backup.bat`：
```batch
@echo off
set DATE=%date:~0,4%%date:~5,2%%date:~8,2%
set TIME=%time:~0,2%%time:~3,2%
copy monitor_cost.db backups\monitor_cost_%DATE%_%TIME%.db
echo 备份完成: monitor_cost_%DATE%_%TIME%.db
pause
```

**使用方法**：
- 双击 `backup.bat` 手动备份
- 或添加到计划任务自动备份

### **云盘备份方案**：
```
显示器成本管理/
├── exe 和 db 文件放在云盘同步目录
├── OneDrive/坚果云自动同步
└── 版本历史自动保留
```

## 🚀 快速部署步骤

### **步骤1：等待构建完成**
当前构建正在后台运行，约 5-10 分钟

### **步骤2：找到 exe 文件**
```
src-tauri/target/release/monitor-cost-manager.exe
```

### **步骤3：测试运行**
- 双击 exe 测试是否正常运行
- 测试主要功能（器件库、项目管理）

### **步骤4：打包部署**
```
创建文件夹：显示器成本管理_v2.2
复制文件：
  - monitor-cost-manager.exe
  - monitor_cost.db（如果有数据）
  - README.txt（可选）
```

### **步骤5：传输到目标电脑**
- USB 拷贝
- 云盘传输
- 网络共享

### **步骤6：目标电脑运行**
- 解压/复制到任意目录
- 双击 exe 启动
- 首次运行自动创建数据库

## 🛠️ 故障排查

### **问题1：exe 无法运行**
**可能原因**：
- 缺少 WebView2 运行库
- 杀毒软件拦截

**解决方案**：
- 安装 WebView2：https://developer.microsoft.com/microsoft-edge/webview2/
- 添加杀毒软件白名单

### **问题2：数据库找不到**
**症状**：
- 数据丢失
- 数据库文件不在 exe 同目录

**检查**：
- exe 和 db 必须在同一目录
- 不要通过快捷方式启动（路径问题）
- 使用绝对路径运行

### **问题3：应用闪退**
**可能原因**：
- 数据库损坏
- 权限不足

**解决方案**：
- 用备份 db 文件替换
- 以管理员权限运行
- 查看错误日志（如果有）

## 💡 高级部署选项

### **创建桌面快捷方式**

手动创建快捷方式：
```
目标：C:\你的路径\monitor-cost-manager.exe
起始位置：C:\你的路径\  ← 重要！确保数据库在同目录
```

### **添加到开始菜单**

复制 exe 到：
```
C:\ProgramData\Microsoft\Windows\Start Menu\Programs\
```

### **注册表安装（可选）**

创建注册表项：
```
HKEY_CURRENT_USER\Software\MonitorCostManager
```

---

## 📝 当前构建进度

构建正在后台运行，你可以：
1. 等待构建完成通知（约 5-10 分钟）
2. 查看构建日志：`src-tauri/target/release/build.log`

构建完成后，我会告诉你文件的确切位置。

---

**最后更新**：2026-06-21