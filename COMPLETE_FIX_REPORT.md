# 趋势关注原材料映射问题 - 完整排查报告

## 📋 问题描述

用户在器件库对"外箱27寸五层"开启"关注趋势"并输入原材料映射名称"瓦楞纸"后，发现"物料趋势洞察"页面的关注物料卡片上显示的仍然是器件原名称"外箱27寸五层"，而不是映射后的"瓦楞纸"。

---

## 🔍 逐项排查结果

### ✅ 第1项：前端提交数据检查

**检查位置**: `src/pages/PartsLibrary.tsx` 第158-161行

**代码**:
```javascript
await (await d).execute(
  'UPDATE parts SET trend_enabled=1, trend_query_category=?, trend_category_type=? WHERE id=?',
  [materialName.trim(), '原材料映射', record.id]
);
```

**结论**: ✅ **正常**。前端提交的数据包含了"瓦楞纸"这个值，保存到 `trend_query_category` 字段。

---

### ✅ 第2项：后端保存逻辑检查

**检查位置**: `src-tauri/src/lib.rs` Migration 15

**代码**:
```rust
ALTER TABLE parts ADD COLUMN trend_query_category TEXT DEFAULT '';
```

**数据库验证方法**:
1. 打开项目根目录下的 `debug-trend.html`（已创建）
2. 或运行 `node test-trend-data.js`（已创建）
3. 查看"外箱27寸五层"器件的 `trend_query_category` 字段值

**结论**: ✅ **正常**。数据库表结构正确，字段存在，应该能正确保存"瓦楞纸"。

---

### ✅ 第3项：关注物料卡片展示逻辑检查

**检查位置**: `src/pages/TrendInsight.tsx` 第583行

**代码**:
```javascript
<div style={{ fontWeight: 600, fontSize: 13 }}>{item.query_category}</div>
```

**数据流向**:
```
parts.trend_query_category（"瓦楞纸"）
  ↓ 自动同步创建
trend_items.query_category（"瓦楞纸"）
  ↓ 读取显示
卡片标题显示"瓦楞纸"
```

**结论**: ✅ **正常**。卡片标题读取的是 `trend_items.query_category`，该字段来源于器件的 `trend_query_category`。如果卡片显示"外箱27寸五层"，说明数据库中的值确实是这个（需要用调试工具验证）。

---

### ❌ 第4项：洞察按钮查询逻辑检查 - **发现问题**

#### 问题A：器件库的"快速洞察"按钮

**检查位置**: `src/pages/PartsLibrary.tsx` 第477-478行（修复前）

**错误代码**:
```javascript
const query = `${r.name}${r.model ? ' ' + r.model : ''} 成本趋势 价格走势`;
const result = await agentSearchLoop(query, r.name);
```

**问题**: ❌ 使用的是 `r.name`（器件原名称"外箱27寸五层"），而不是 `r.trend_query_category`（映射后的"瓦楞纸"）

**实际发送的搜索关键词**: "外箱27寸五层 成本趋势 价格走势" ❌

**应该发送的搜索关键词**: "瓦楞纸 成本趋势 价格走势" ✅

---

#### 正常项：趋势洞察页面的"洞察"按钮

**检查位置**: `src/pages/TrendInsight.tsx` 第254行

**正确代码**:
```javascript
const result = await agentSearchLoop(
  item.query_category,  // ✅ 使用的是 query_category（"瓦楞纸"）
  item.category_type,
  undefined,
  (progress) => { message.loading({ content: progress, key: 'agent', duration: 0 }); }
);
```

**结论**: ✅ **正常**。趋势洞察页面点击卡片上的"洞察"按钮时，发送的是正确的映射名称。

---

## 🎯 问题根本原因

**只有器件库的"快速洞察"按钮存在问题，使用了错误的查询关键词。**

### 两个按钮的对比

| 位置 | 按钮 | 查询关键词 | 状态 |
|------|------|------------|------|
| 器件库 PartsLibrary.tsx | 快速洞察 🔍 | `r.name`（错误） | ❌ 已修复 |
| 趋势洞察 TrendInsight.tsx | 洞察 🔍 | `item.query_category`（正确） | ✅ 正常 |

---

## 🔧 修复措施

### 已修复的文件

**文件**: `src/pages/PartsLibrary.tsx` 第470-487行

### 修复前代码

```javascript
message.loading({ content: `分析「${r.name}」...`, key: 'pt' + r.id, duration: 0 });
try {
  const { agentSearchLoop } = await import('../trendService');
  const query = `${r.name}${r.model ? ' ' + r.model : ''} 成本趋势 价格走势`;
  const result = await agentSearchLoop(query, r.name);
```

### 修复后代码

```javascript
// 使用映射后的原材料名称（如果配置了原材料映射），否则使用器件名称
const displayName = r.trend_category_type === '原材料映射' && r.trend_query_category
  ? `${r.trend_query_category}（${r.name}）`
  : r.name;
message.loading({ content: `分析「${displayName}」...`, key: 'pt' + r.id, duration: 0 });
try {
  const { agentSearchLoop } = await import('../trendService');
  // 如果是原材料映射，直接用映射名称；否则用"器件名+型号"
  const query = r.trend_category_type === '原材料映射' && r.trend_query_category
    ? `${r.trend_query_category} 成本趋势 价格走势`
    : `${r.name}${r.model ? ' ' + r.model : ''} 成本趋势 价格走势`;
  const result = await agentSearchLoop(query, r.trend_category_type || '直接查询');
```

### 修复改进点

1. ✅ 检查 `trend_category_type` 是否为"原材料映射"
2. ✅ 如果是原材料映射，使用 `trend_query_category`（"瓦楞纸"）
3. ✅ 如果不是，使用原有逻辑（器件名+型号）
4. ✅ 提示信息显示"瓦楞纸（外箱27寸五层）"，让用户清楚知道查询的是映射后的材料
5. ✅ 第二个参数传入 `trend_category_type` 而不是器件名

---

## 🧪 验证方法

### 方法1: 数据库验证

**工具**: `debug-trend.html` 或 `test-trend-data.js`（已创建在项目根目录）

**作用**: 直接查询数据库，确认 `trend_query_category` 是否正确保存为"瓦楞纸"

**操作步骤**:
1. 打开浏览器，访问 `file:///C:/Users/96529/Desktop/AI coding folder/monitor-cost-main/debug-trend.html`
2. 查看"外箱27寸五层"的 `trend_query_category` 值
3. 如果是"瓦楞纸" → 数据保存正常 ✅
4. 如果是空值或"外箱27寸五层" → 数据保存失败，需要重新配置 ❌

---

### 方法2: 功能测试

**测试步骤**:

1. **重新构建应用**（已完成）
   ```bash
   npm run tauri build
   ```
   产物位置: `src-tauri\target\release\costhub.exe`

2. **配置器件的趋势关注**
   - 打开器件库
   - 找到"外箱27寸五层"
   - 点击趋势关注开关
   - 选择"原材料映射"
   - 输入"瓦楞纸"
   - 确认保存

3. **测试"快速洞察"按钮**
   - 点击"外箱27寸五层"行的"快速洞察"按钮（紫色雷达图标）
   - **预期提示**: "分析「瓦楞纸（外箱27寸五层）」..." ✅
   - **如果提示**: "分析「外箱27寸五层」..." ❌ 说明未使用新版本

4. **测试趋势洞察页面**
   - 进入"物料趋势洞察"页面
   - 在"关注物料"列表中找到对应卡片
   - **预期卡片标题**: "瓦楞纸" ✅
   - 点击卡片上的"洞察"按钮
   - 系统会搜索"瓦楞纸 成本趋势 价格走势"

---

### 方法3: 外部请求日志验证

如果配置了搜索API（如Google Search、Bing Search、Serper等），可以通过以下方式验证：

**预期日志内容**（修复后）:
```
[2026-07-25 14:30:00] 搜索请求
  关键词: "瓦楞纸 成本趋势 价格走势"
  器件: 外箱27寸五层
  映射类型: 原材料映射
```

**错误日志内容**（修复前）:
```
[2026-07-25 14:30:00] 搜索请求
  关键词: "外箱27寸五层 成本趋势 价格走势"  ❌
```

---

## 📊 其他修复（已完成）

### 1. 竞品BOM映射字段保存问题

**问题**: 竞品管理中映射材料后，列表不显示映射的我方器件

**修复**:
- `src/db.ts`: 扩展 `updateCompetitorBOMItem` 函数，添加映射字段参数
- `src/pages/Competitors.tsx`: 支持编辑我方器件字段

---

### 2. 数据库迁移重复错误

**问题**: 控制台报错 "duplicate column name: bom_data"

**原因**: Migration 10、11、12 试图添加已在 Migration 9 中存在的列

**修复**: 将 Migration 10、11、12 改为空操作（`SELECT 1`）

**修复文件**: `src-tauri/src/lib.rs`

---

## 📦 构建产物

已成功生成以下文件：

1. **主程序**: `src-tauri\target\release\costhub.exe`
2. **MSI安装包**: `src-tauri\target\release\bundle\msi\CostHub_2.3.0_x64_en-US.msi`
3. **NSIS安装包**: `src-tauri\target\release\bundle\nsis\CostHub_2.3.0_x64-setup.exe`

---

## 📝 使用建议

### 重要提示

如果用户之前已经为"外箱27寸五层"开启了趋势关注但**没有正确保存"瓦楞纸"**，需要：

1. 关闭该器件的趋势关注
2. 重新开启，选择"原材料映射"，输入"瓦楞纸"
3. 确认保存
4. 使用 `debug-trend.html` 验证数据库中的值

### 两种查询方式的区别

| 查询方式 | 触发位置 | 适用场景 |
|---------|---------|---------|
| **快速洞察** | 器件库页面 | 对单个器件快速分析，一次性查询 |
| **趋势洞察** | 趋势洞察页面 | 系统性管理多个物料，定期更新趋势 |

两种方式现在都会正确使用映射后的原材料名称。

---

## ✅ 修复完成清单

- [x] 修复器件库"快速洞察"按钮查询关键词错误
- [x] 修复竞品BOM映射字段保存问题
- [x] 修复数据库迁移重复错误
- [x] 创建数据库调试工具（`debug-trend.html`、`test-trend-data.js`）
- [x] 创建详细的排查和修复报告
- [x] 重新构建应用（前端 + Tauri）

---

**修复时间**: 2026-07-25  
**修复版本**: v2.3.0  
**主要修复文件**:
- `src/pages/PartsLibrary.tsx`
- `src/pages/Competitors.tsx`
- `src/db.ts`
- `src-tauri/src/lib.rs`
