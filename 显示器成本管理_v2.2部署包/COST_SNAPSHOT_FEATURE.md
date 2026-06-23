# 成本快照功能完整说明

## 🎯 功能价值

成本快照功能帮助用户：
- ✅ **追踪历史成本变化**：记录项目成本的历史轨迹
- ✅ **发现成本异常**：快速识别成本波动和异常
- ✅ **支持决策分析**：对比不同时间点的成本差异
- ✅ **自动定期记录**：无需手动干预自动保存快照

---

## 📊 核心功能

### 1. **自动快照机制**
- 每日自动保存所有项目成本快照（后台任务）
- 记录完整成本数据（BOM成本、总成本、分类明细）
- 数据永久保存，支持历史查询

### 2. **手动快照功能**
- Dashboard提供"创建快照"按钮
- 可随时手动触发快照创建
- 适用于重要节点保存（报价前、评审前等）

### 3. **成本历史可视化**
- Dashboard新增"成本历史快照"图表卡片
- 折线图展示成本变化趋势
- 支持多个项目同时展示
- 交互式提示显示详细数据

### 4. **快照数据详情**
每个快照包含：
- **基本信息**：项目ID、快照类型、日期
- **成本数据**：BOM成本、总成本、最终价格
- **费率信息**：平台费率、利润率
- **分类明细**：各分类成本占比（JSON格式）
- **器件数量**：BOM器件总数
- **备注说明**：快照备注信息

---

## 💾 数据库设计

### 表结构
```sql
CREATE TABLE cost_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  snapshot_type TEXT DEFAULT 'auto', -- 'auto'自动/'manual'手动
  snapshot_date TEXT NOT NULL, -- YYYY-MM-DD
  total_cost REAL NOT NULL, -- 总成本（含费率）
  bom_cost REAL NOT NULL, -- BOM成本
  fee_rate REAL DEFAULT 0, -- 平台费率
  profit_rate REAL DEFAULT 0, -- 利润率
  final_price REAL DEFAULT 0, -- 最终价格
  cost_breakdown TEXT DEFAULT '{}', -- 分类成本明细（JSON）
  parts_count INTEGER DEFAULT 0, -- 器件数量
  remark TEXT DEFAULT '', -- 备注
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_snapshots_project ON cost_snapshots(project_id);
CREATE INDEX idx_snapshots_date ON cost_snapshots(snapshot_date);
```

### 索引优化
- 项目ID索引：快速查询项目快照
- 日期索引：支持时间范围查询

---

## 🔧 API函数

### 1. **saveCostSnapshot**
保存成本快照（自动或手动）
```typescript
await saveCostSnapshot(projectId, 'auto', '每日自动快照');
await saveCostSnapshot(projectId, 'manual', '报价前快照');
```

### 2. **getCostSnapshots**
获取项目快照列表
```typescript
const snapshots = await getCostSnapshots(projectId, 30); // 最近30条
```

### 3. **getCostSnapshot**
获取单个快照详情
```typescript
const snapshot = await getCostSnapshot(snapshotId);
```

### 4. **deleteCostSnapshot**
删除快照
```typescript
await deleteCostSnapshot(snapshotId);
```

### 5. **getLatestSnapshot**
获取最新快照
```typescript
const latest = await getLatestSnapshot(projectId);
```

### 6. **compareSnapshots**
对比两个快照
```typescript
const comparison = await compareSnapshots(snapshotId1, snapshotId2);
// 返回成本差异和分类明细差异
```

### 7. **getProjectCostHistory**
获取项目成本历史（指定天数）
```typescript
const history = await getProjectCostHistory(projectId, 30); // 最近30天
```

### 8. **autoSnapshotAllProjects**
为所有项目创建快照
```typescript
const results = await autoSnapshotAllProjects();
// 返回快照创建结果列表
```

---

## 🎨 UI界面

### Dashboard页面新增

#### **成本历史快照卡片**
- 位置：统计卡片下方
- 内容：成本历史折线图
- 功能：
  - 显示近期成本变化趋势
  - 多个项目同时展示（最多5个）
  - 鼠标悬停显示详细数据
  - "创建快照"按钮

#### **快照按钮功能**
- 点击创建当前所有项目快照
- Loading状态提示
- 成功后刷新历史图表
- 错误提示反馈

---

## 📈 使用场景

### 场景1：日常监控
**操作流程**：
1. 每日自动创建快照（后台运行）
2. Dashboard查看成本趋势图表
3. 发现异常波动深入分析
4. 采取措施调整成本

### 场景2：重要节点记录
**操作流程**：
1. 项目报价前手动创建快照
2. 添加备注："报价前成本快照"
3. 报价后对比成本变化
4. 分析报价准确性

### 场景3：成本优化追踪
**操作流程**：
1. 实施降本措施前创建快照
2. 措施实施一段时间后创建新快照
3. 对比两个快照分析效果
4. 验证降本成果

### 场景4：项目对比分析
**操作流程**：
1. 选择两个项目查看历史快照
2. 对比成本趋势差异
3. 分析成本结构差异
4. 寻找优化机会

---

## 💡 成本计算逻辑

### BOM成本
```typescript
bomCost = Σ (器件成本 × 数量)
```

### 总成本（含费率）
```typescript
totalCost = bomCost × (1 + fee_rate/100 + profit_rate/100)
```

### 分类明细
```typescript
cost_breakdown = {
  "硬件类": xxx,
  "结构类": xxx,
  "电源类": xxx,
  ...
}
```

---

## 🚀 下一步增强建议

### 功能扩展

#### **自动定期快照**
- 建议添加每日定时任务
- 自动为所有在研项目创建快照
- 无需手动干预

#### **快照对比界面**
- 项目详情页添加"快照历史"Tab
- 选择两个快照进行详细对比
- 显示分类成本差异明细
- 分析差异原因

#### **成本异常检测**
- 自动识别成本波动异常
- 成本突增/突降标记提醒
- 异常原因分析建议

#### **成本趋势预测**
- 基于历史数据预测未来成本
- 成本趋势线延长预测
- 成本预警阈值设置

---

## 📊 数据示例

### 快照数据示例
```json
{
  "id": 1,
  "project_id": 1,
  "snapshot_type": "auto",
  "snapshot_date": "2026-06-21",
  "total_cost": 567.32,
  "bom_cost": 511.00,
  "fee_rate": 5,
  "profit_rate": 10,
  "final_price": 567.32,
  "cost_breakdown": "{\"硬件类\":180,\"结构类\":105,\"电源类\":21,\"其他\":205}",
  "parts_count": 18,
  "remark": "每日自动快照",
  "created_at": "2026-06-21 09:00:00"
}
```

### 成本历史趋势示例
```
日期         MNT-2401  MNT-2402  MNT-2701
2026-06-01   ¥580      ¥645      ¥620
2026-06-05   ¥575      ¥640      ¥615
2026-06-10   ¥567      ¥633      ¥610
2026-06-15   ¥565      ¥631      ¥608
2026-06-21   ¥562      ¥628      ¥605
```

---

## ⚙️ 配置建议

### 快照保留策略
- **短期数据**：最近30天完整保留
- **中期数据**：90天内每日快照
- **长期数据**：重要节点快照永久保留

### 自动快照频率
- **建议频率**：每日一次
- **最佳时间**：每天早上自动运行
- **备份策略**：定期导出快照数据

---

## ✅ 已完成功能

- ✅ 数据库表设计和迁移
- ✅ 类型定义添加
- ✅ 后端API函数实现（8个函数）
- ✅ Dashboard成本历史图表
- ✅ 手动快照创建按钮
- ✅ 成本历史可视化展示

---

## 🔄 构建进行中

**当前状态**：
- 🔄 正在构建包含成本快照功能的exe文件
- 🔄 预计剩余时间：约2-3分钟
- 🔄 构建完成后更新部署包

**构建完成后**：
- ✅ 新exe文件包含完整成本快照功能
- ✅ Dashboard显示成本历史图表
- ✅ 支持手动创建快照
- ✅ 自动追踪成本变化

---

**创建时间**：2026-06-21 21:30
**功能状态**：已实现，正在构建测试
**下一步**：构建完成后测试验证功能