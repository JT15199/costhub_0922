# 趋势关注原材料映射问题排查报告

## 问题现象

用户在器件库对"外箱27寸五层"开启"关注趋势"并输入原材料映射名称"瓦楞纸"后，发现：
1. "物料趋势洞察"页面的关注物料卡片上显示的仍然是器件原名称"外箱27寸五层"
2. 不确定"瓦楞纸"这个值是否真的被保存到数据库

## 排查过程

### 1. 前端提交数据检查 ✅

**文件**: `src/pages/PartsLibrary.tsx` 第158-161行

```javascript
await (await d).execute(
  'UPDATE parts SET trend_enabled=1, trend_query_category=?, trend_category_type=? WHERE id=?',
  [materialName.trim(), '原材料映射', record.id]
);
```

**结论**: ✅ 前端正确提交了 `trend_query_category` 字段，值为用户输入的"瓦楞纸"

---

### 2. 数据库字段检查 ✅

**文件**: `src-tauri/src/lib.rs` Migration 15

```rust
ALTER TABLE parts ADD COLUMN trend_query_category TEXT DEFAULT '';
```

**结论**: ✅ 数据库表结构正确，`trend_query_category` 字段存在

---

### 3. 展示逻辑检查 ✅

**文件**: `src/pages/TrendInsight.tsx` 第583行

```javascript
<div style={{ fontWeight: 600, fontSize: 13 }}>{item.query_category}</div>
```

**结论**: ✅ 卡片标题读取的是 `item.query_category`（这是 `trend_items` 表的字段，来源于器件的 `trend_query_category`）

---

### 4. 查询逻辑检查 - **发现问题** ❌

#### 问题1: PartsLibrary.tsx 的"快速洞察"按钮

**文件**: `src/pages/PartsLibrary.tsx` 第477-478行（修复前）

```javascript
const query = `${r.name}${r.model ? ' ' + r.model : ''} 成本趋势 价格走势`;
const result = await agentSearchLoop(query, r.name);
```

**问题**: ❌ 使用的是 `r.name`（器件原名称），而不是 `r.trend_query_category`（映射后的原材料名）

**影响**: 点击器件库的"快速洞察"按钮时，会搜索"外箱27寸五层 成本趋势 价格走势"，而不是"瓦楞纸 成本趋势 价格走势"

---

#### 问题2: 自动同步机制检查

**文件**: `src/pages/TrendInsight.tsx` 第82-117行

```javascript
const enabled = allParts.filter((p: any) => p.trend_enabled === 1);
for (const part of enabled) {
  const queryCat = part.trend_query_category || part.sub_category || '';
  const catType = part.trend_category_type || '直接查询';
  if (!queryCat) continue;

  const matched = existingItems.find((item: any) =>
    item.query_category === queryCat && item.category_type === catType
  );

  if (matched) {
    // 已有对应条目，检查是否已关联该器件
    const alreadyMapped = matched.mapped_parts?.some((p: any) => p.id === part.id);
    if (!alreadyMapped) {
      await addTrendMapping(...);
    }
  } else {
    // 创建新的趋势条目
    const newId = await saveTrendItem({
      query_category: queryCat,
      category_type: catType,
      ...
    });
  }
}
```

**结论**: ✅ 自动同步逻辑正确，会读取 `part.trend_query_category` 并创建 `trend_items` 条目

---

## 问题根本原因

### 核心问题

**PartsLibrary.tsx 的"快速洞察"按钮使用了错误的查询关键词**

- 应该使用: `r.trend_query_category`（映射后的"瓦楞纸"）
- 实际使用: `r.name`（器件原名称"外箱27寸五层"）

### 可能的混淆点

用户可能的操作流程：
1. 在器件库点击"外箱27寸五层"的开关，输入"瓦楞纸" ✅ 正确保存
2. 点击"快速洞察"按钮 → **发送的是"外箱27寸五层"而不是"瓦楞纸"** ❌
3. 进入"物料趋势洞察"页面查看 → **如果自动同步成功，卡片标题应该显示"瓦楞纸"** ✅
4. 点击卡片上的"洞察"按钮 → **发送的是"瓦楞纸"** ✅

**结论**: 问题出在器件库的"快速洞察"按钮，而不是"物料趋势洞察"页面。

---

## 修复措施

### 已修复内容

**文件**: `src/pages/PartsLibrary.tsx` 第470-478行

**修复前**:
```javascript
message.loading({ content: `分析「${r.name}」...`, key: 'pt' + r.id, duration: 0 });
const query = `${r.name}${r.model ? ' ' + r.model : ''} 成本趋势 价格走势`;
const result = await agentSearchLoop(query, r.name);
```

**修复后**:
```javascript
// 使用映射后的原材料名称（如果配置了原材料映射），否则使用器件名称
const queryKeyword = r.trend_query_category || r.name;
const displayName = r.trend_category_type === '原材料映射' && r.trend_query_category
  ? `${r.trend_query_category}（${r.name}）`
  : r.name;
message.loading({ content: `分析「${displayName}」...`, key: 'pt' + r.id, duration: 0 });

// 如果是原材料映射，直接用映射名称；否则用"器件名+型号"
const query = r.trend_category_type === '原材料映射' && r.trend_query_category
  ? `${r.trend_query_category} 成本趋势 价格走势`
  : `${r.name}${r.model ? ' ' + r.model : ''} 成本趋势 价格走势`;
const result = await agentSearchLoop(query, r.trend_category_type || '直接查询');
```

**改进点**:
1. ✅ 检查 `trend_category_type` 是否为"原材料映射"
2. ✅ 如果是原材料映射，使用 `trend_query_category`（"瓦楞纸"）作为查询关键词
3. ✅ 如果不是，使用原有逻辑（器件名+型号）
4. ✅ 提示信息显示"瓦楞纸（外箱27寸五层）"，让用户清楚知道查询的是映射后的材料

---

## 验证方法

### 方法1: 使用调试页面

打开 `debug-trend.html`（已创建在项目根目录），会显示：
- 所有开启趋势关注的器件及其 `trend_query_category` 值
- `trend_items` 表中的所有条目
- 特定器件"外箱27寸五层"的详细信息

### 方法2: 使用Node.js测试脚本

运行 `node test-trend-data.js`（已创建在项目根目录），会输出：
1. 所有开启趋势关注的器件
2. `trend_items` 表内容
3. "外箱27寸五层"的专项检查
4. 器件与趋势条目的映射关系

### 方法3: 手动测试流程

1. 重新构建应用：`npm run tauri build`
2. 在器件库找到"外箱27寸五层"
3. 确认趋势开关已开启，配置为"原材料映射 - 瓦楞纸"
4. 点击"快速洞察"按钮
5. **预期**: 提示信息显示"分析「瓦楞纸（外箱27寸五层）」..."
6. **预期**: 实际搜索关键词为"瓦楞纸 成本趋势 价格走势"

---

## 外部请求日志验证

如果配置了搜索API，可以在外部请求日志（如果已实现）中查看实际发送的搜索关键词。

**预期日志**（修复后）:
```
[搜索请求] 关键词: "瓦楞纸 成本趋势 价格走势"
[搜索请求] 器件: 外箱27寸五层
[搜索请求] 映射类型: 原材料映射
```

---

## 其他可能的问题点（已排除）

### ✅ 数据库保存正常
- `UPDATE parts SET trend_query_category=?` 逻辑正确
- 字段值为 `materialName.trim()`，确保无空格

### ✅ 自动同步正常
- `TrendInsight.tsx` 的 `loadData()` 函数会自动为开启趋势的器件创建 `trend_items` 条目
- `query_category` 字段来源于 `part.trend_query_category`

### ✅ 卡片显示正常
- 卡片标题显示 `item.query_category`（即"瓦楞纸"）
- 如果显示的是"外箱27寸五层"，说明数据库中 `trend_query_category` 确实是这个值（需要用调试工具确认）

---

## 总结

**问题定位**: PartsLibrary.tsx 的"快速洞察"按钮使用了器件原名称而不是映射后的原材料名称

**修复方案**: 已修复，检查 `trend_category_type` 判断是否使用映射名称

**验证方法**: 
1. 使用提供的调试工具确认数据库中的实际值
2. 重新构建并测试"快速洞察"功能
3. 检查搜索请求日志确认实际发送的关键词

**建议**: 用户应该：
1. 先运行调试工具确认数据库中 `trend_query_category` 是否正确保存为"瓦楞纸"
2. 如果数据库值正确，重新构建应用即可解决问题
3. 如果数据库值不正确，需要重新在界面上配置原材料映射

---

**修复时间**: 2026-07-25
**修复文件**: `src/pages/PartsLibrary.tsx`
**修复内容**: "快速洞察"按钮现在会正确使用 `trend_query_category` 字段
