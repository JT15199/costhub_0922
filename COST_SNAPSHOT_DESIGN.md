# 成本快照功能实现方案

## 功能设计

### 核心价值
- ✅ 追踪项目成本历史变化
- ✅ 发现成本异常波动
- ✅ 支持时间点对比分析
- ✅ 自动定期记录成本状态

### 数据库表设计

```sql
CREATE TABLE cost_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  snapshot_type TEXT DEFAULT 'auto',  -- 'auto'自动/'manual'手动
  snapshot_date TEXT NOT NULL,         -- 快照时间
  total_cost REAL NOT NULL,            -- 总成本
  bom_cost REAL NOT NULL,              -- BOM成本
  fee_rate REAL DEFAULT 0,             -- 平台费率
  profit_rate REAL DEFAULT 0,          -- 利润率
  final_price REAL DEFAULT 0,          -- 最终价格
  cost_breakdown TEXT,                 -- JSON：分类成本明细
  parts_count INTEGER DEFAULT 0,       -- 器件数量
  remark TEXT DEFAULT '',              -- 备注
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_snapshots_project ON cost_snapshots(project_id);
CREATE INDEX idx_snapshots_date ON cost_snapshots(snapshot_date);
```

### 功能模块

#### 1. 自动快照机制
- 每日自动保存快照（后台任务）
- 项目状态变更时自动快照
- BOM修改后自动快照（可选）

#### 2. 手动快照功能
- 用户手动触发快照
- 添加备注说明（如"报价前快照"）
- 重要节点保存（如评审前、发布前）

#### 3. 快照查看功能
- 快照列表查看
- 快照详情查看
- 成本明细对比

#### 4. 成本趋势图表
- 成本历史折线图
- 成本变化率分析
- 成本异常标记

#### 5. 快照对比分析
- 选择两个快照对比
- 显示成本差异
- 分析差异原因

### UI设计

#### Dashboard页面
- 新增"成本趋势"图表卡片
- 显示近期成本变化趋势
- 标记异常波动

#### 项目详情页
- 新增"快照历史"Tab页
- 快照列表（时间、成本、类型）
- 快照详情查看
- 快照对比功能

#### 快照管理界面
- 快照列表管理
- 快照删除功能
- 快照备注编辑

### 实现步骤

#### 步骤1：数据库扩展
- 添加cost_snapshots表到lib.rs
- 在ensureSchema中自动创建表

#### 步骤2：后端功能函数
- saveCostSnapshot() - 保存快照
- getCostSnapshots() - 查询快照列表
- getCostSnapshot() - 查询单个快照
- deleteCostSnapshot() - 删除快照
- compareSnapshots() - 快照对比

#### 步骤3：自动触发机制
- 项目创建时自动快照
- BOM修改时触发快照（可选）
- 定期自动快照（每日）

#### 步骤4：前端界面
- Dashboard趋势图
- 项目详情快照历史
- 快照对比界面

#### 步骤5：测试验证
- 自动快照测试
- 手动快照测试
- 图表显示测试
- 对比功能测试

---

创建时间：2026-06-21