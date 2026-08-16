// 成本领域工具注册表（P1 Agent，2026-08-16）
// 设计：现有能力（查询/分析）包装成统一"工具"，本地模型编排调用序列（计划-执行-总结）
// 安全：第一版只暴露只读查询 + 物料行情洞察（走现有 agentSearchLoop，外发=物料名/品类）；无任何写操作工具
// 审计：每次 Agent 任务由调用方 logLocalAICall(request_type=agent_plan/agent_answer) 留痕

import { getProjects, getProjectBOMs, getParts, getWorkLogs } from './db';
import { getAllPartSuppliers, getSupplierPriceHistory } from './db/parts';
import { getProjectCostSnapshots, getTargets } from './db/projects';
import { getInsights } from './db/compare';
import { getAdvisorInsights } from './db/advisor';
import { supplierTrendText } from './supplierTrend';
import { computeTargetStatuses } from './targetInsight';
// 工具图标（2026-08-16：按数据特征选择——查询=清单/文件夹，成本=钱币，趋势=折线，洞察=闪电，目标=靶心…）
import React from 'react';
import {
  FolderOutlined, ProfileOutlined, DollarOutlined, ShopOutlined, LineChartOutlined,
  AimOutlined, HistoryOutlined, FundOutlined, BulbOutlined, BookOutlined,
  CheckSquareOutlined, ThunderboltOutlined, BarChartOutlined,
} from '@ant-design/icons';

/** 工具图标映射（数据特征 → 语义图标；存组件引用以便在 .ts 中使用，UI 层再实例化） */
export const TOOL_ICONS: Record<string, React.ComponentType> = {
  query_projects: FolderOutlined,
  query_project_bom: ProfileOutlined,
  query_project_cost: DollarOutlined,
  query_part_suppliers: ShopOutlined,
  query_supplier_trend: LineChartOutlined,
  query_target_status: AimOutlined,
  query_cost_snapshots: HistoryOutlined,
  query_price_insights: FundOutlined,
  query_advisor_insights: BulbOutlined,
  query_worklog: BookOutlined,
  query_todos: CheckSquareOutlined,
  insight_material_trend: ThunderboltOutlined,
  compare_subcategory_cost: BarChartOutlined,
};
export function toolIcon(id: string): React.ComponentType {
  return TOOL_ICONS[id] || FolderOutlined;
}

export interface AiToolParam {
  key: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  desc: string;
}

export interface AiTool {
  id: string;
  name: string;        // 中文名（UI 展示）
  desc: string;        // 给模型的描述：何时用 + 参数说明
  params: AiToolParam[];
  execute: (args: Record<string, any>) => Promise<string>;  // 返回文本（供模型消费）
}

const fmtMoney = (n: any) => '¥' + (Number(n) || 0).toFixed(2);
const fmtDate = (t?: string) => (t || '').slice(5, 16) || '';

// ==================== 工具实现 ====================

const tools: AiTool[] = [
  {
    id: 'query_projects',
    name: '查询项目列表',
    desc: '列出全部项目（代号/名称/类型/档位/状态/当前 BOM 成本）。参数 project_type 可选：在研/已完成，空则全部。',
    params: [{ key: 'project_type', type: 'string', desc: '项目类型：在研 或 已完成，可空' }],
    execute: async (a) => {
      const rows = await getProjects('', '', '');
      const alive = rows.filter((p: any) => !p.is_deleted);
      const list = alive.filter((p: any) => !a.project_type || (p.project_type || '') === a.project_type);
      if (list.length === 0) return '没有找到项目（类型：' + (a.project_type || '全部') + '）';
      return list.map((p: any) => (p.code || '-') + '｜' + (p.name || '') + '｜' + (p.project_type || '') + '｜' + (p.tier || '') + '｜' + (p.status || '')).join('\n');
    },
  },
  {
    id: 'query_project_bom',
    name: '查询项目 BOM 明细',
    desc: '查某项目的 BOM 器件清单（模块/名称/型号/数量/单价/小计）。参数 project_code 必填（项目代号）。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号，如 M270' }],
    execute: async (a) => {
      const projects = await getProjects('', '', '');
      const p = projects.find((x: any) => !x.is_deleted && x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      if (boms.length === 0) return '项目 ' + a.project_code + ' 暂无 BOM 器件';
      const cost = (b: any) => (b.part_cost ?? b.cost ?? 0) * (b.quantity ?? 1);
      const total = boms.reduce((s: number, b: any) => s + cost(b), 0);
      const lines2 = boms.map((b: any) => '[' + (b.module_name || '未分模块') + '] ' + (b.part_name || '') + ' ' + (b.part_model || '') + ' ×' + (b.quantity ?? 1) + ' @' + fmtMoney(b.part_cost ?? b.cost) + ' =' + fmtMoney(cost(b)));
      return '项目 ' + a.project_code + ' BOM 共 ' + boms.length + ' 项，合计 ' + fmtMoney(total) + '\n' + lines2.join('\n');
    },
  },
  {
    id: 'query_project_cost',
    name: '查询项目成本结构',
    desc: '查某项目的成本汇总：按模块分组的成本与占比 + 总 BOM 成本（不含费率）。参数 project_code 必填。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号，如 M270' }],
    execute: async (a) => {
      const projects = await getProjects('', '', '');
      const p = projects.find((x: any) => !x.is_deleted && x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      if (boms.length === 0) return '项目 ' + a.project_code + ' 暂无 BOM 器件';
      const cost = (b: any) => (b.part_cost ?? b.cost ?? 0) * (b.quantity ?? 1);
      const total = boms.reduce((s: number, b: any) => s + cost(b), 0);
      const modMap = new Map<string, number>();
      for (const b of boms) {
        const m = b.module_name || '未分模块';
        modMap.set(m, (modMap.get(m) || 0) + cost(b));
      }
      const modLines = [...modMap.entries()].sort((x, y) => y[1] - x[1]).map(([m, c]) => m + '：' + fmtMoney(c) + '（' + Math.round((c / total) * 100) + '%）');
      return '项目 ' + a.project_code + ' BOM 总成本 ' + fmtMoney(total) + '\n' + modLines.join('\n');
    },
  },
  {
    id: 'query_part_suppliers',
    name: '查询器件供应商报价',
    desc: '查某器件的全部供应商报价/份额/状态。参数 part_name 必填（器件名称，模糊匹配）。',
    params: [{ key: 'part_name', type: 'string', required: true, desc: '器件名称' }],
    execute: async (a) => {
      const parts = await getParts();
      const matches = parts.filter((p: any) => (p.name || '').includes(a.part_name));
      if (matches.length === 0) return '器件库未找到包含「' + a.part_name + '」的器件';
      const all = await getAllPartSuppliers();
      const out: string[] = [];
      for (const part of matches.slice(0, 5)) {
        const sups = all.filter((s: any) => s.part_id === part.id);
        out.push('器件「' + part.name + '」(' + (part.model || '') + ') 成本 ' + fmtMoney(part.cost) + (sups.length === 0 ? '，暂无供应商报价' : ''));
        for (const s of sups) {
          out.push('  - ' + s.supplier_name + '：' + fmtMoney(s.price) + '，份额 ' + (s.share_ratio ?? 0) + '%，' + (s.is_active ? '启用' : '停用'));
        }
      }
      return out.join('\n');
    },
  },
  {
    id: 'query_supplier_trend',
    name: '查询供应商价格趋势',
    desc: '查某器件某供应商的价格历史趋势（涨/降/波动 + 累计幅度 + 最近原因）。参数 part_name 必填，supplier_name 可选。',
    params: [
      { key: 'part_name', type: 'string', required: true, desc: '器件名称' },
      { key: 'supplier_name', type: 'string', desc: '供应商名称，可空' },
    ],
    execute: async (a) => {
      const parts = await getParts();
      const part = parts.find((p: any) => (p.name || '').includes(a.part_name));
      if (!part) return '器件库未找到「' + a.part_name + '」';
      const history = await getSupplierPriceHistory(part.id, a.supplier_name || '');
      if (history.length === 0) return '「' + part.name + '」无供应商价格变动记录';
      return '「' + part.name + '」供应商价格趋势：' + supplierTrendText(history);
    },
  },
  {
    id: 'query_target_status',
    name: '查询目标成本达成',
    desc: '查项目目标成本达成情况（领域/目标/实际/达成率）。参数 project_code 可选，空=全部在研项目。',
    params: [{ key: 'project_code', type: 'string', desc: '项目代号，可空' }],
    execute: async (a) => {
      const projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted && (p.project_type || '') === '在研');
      const list = projects.filter((p: any) => !a.project_code || p.code === a.project_code);
      if (list.length === 0) return '没有符合条件的在研项目';
      const bomsBy: Record<number, any[]> = {};
      const targetsBy: Record<number, any[]> = {};
      for (const p of list) {
        try { bomsBy[p.id] = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted); } catch { bomsBy[p.id] = []; }
        try { targetsBy[p.id] = await getTargets(p.id); } catch { targetsBy[p.id] = []; }
      }
      const statuses = computeTargetStatuses(list, targetsBy, bomsBy);
      if (statuses.length === 0) return '所选项目未设定目标成本（需先在项目 → 成本分析设定）';
      return statuses.map((s: any) => (s.projectCode || '') + '｜' + (s.domain || '') + '：目标 ' + fmtMoney(s.target) + '，实际 ' + fmtMoney(s.actual) + '，达成率 ' + (s.achieveRate != null ? Math.round(s.achieveRate) + '%' : '-') + (s.missed ? ' ⚠️未达标' : ' ✓')).join('\n');
    },
  },
  {
    id: 'query_cost_snapshots',
    name: '查询成本快照与异动',
    desc: '查项目最近成本快照（时间/BOM 成本/变动）与最近异动。参数 project_code 可选，limit 默认 5。',
    params: [
      { key: 'project_code', type: 'string', desc: '项目代号，可空' },
      { key: 'limit', type: 'number', desc: '最近快照条数，默认 5' },
    ],
    execute: async (a) => {
      const projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const list = projects.filter((p: any) => !a.project_code || p.code === a.project_code);
      const out: string[] = [];
      for (const p of list.slice(0, 3)) {
        const snaps = await getProjectCostSnapshots(p.id);
        if (snaps.length === 0) { out.push('项目 ' + p.code + ' 无成本快照'); continue; }
        const top = snaps.slice(0, Math.max(1, Math.min(Number(a.limit) || 5, 10)));
        out.push('项目 ' + p.code + ' 最近 ' + top.length + ' 条快照：');
        top.forEach((s: any, i: number) => {
          const diff = i === 0 ? 0 : Number(s.bom_cost) - Number(snaps[i - 1].bom_cost);
          out.push('  ' + fmtDate(s.created_at) + ' BOM ' + fmtMoney(s.bom_cost) + (i > 0 ? (diff >= 0 ? ' +' : ' ') + diff.toFixed(2) : '') + (s.manual ? '（手动）' : ''));
        });
      }
      return out.join('\n');
    },
  },
  {
    id: 'query_price_insights',
    name: '查询报价情报',
    desc: '查未读报价情报（同物料跨项目价差）。无参数。',
    params: [],
    execute: async () => {
      const rows = await getInsights();
      const unread = rows.filter((i: any) => i.status === 'unread');
      if (unread.length === 0) return '当前没有未读报价情报';
      return unread.slice(0, 10).map((i: any) => '[' + (i.category || '') + '] ' + (i.title || i.summary || '').slice(0, 80) + (i.detail ? '｜' + String(i.detail).slice(0, 100) : '')).join('\n');
    },
  },
  {
    id: 'query_advisor_insights',
    name: '查询 AI 自主建议',
    desc: '查 AI 自主分析发现的机会/风险点。参数 status 可选：open（待处理，默认）/ done / dismissed。',
    params: [{ key: 'status', type: 'string', desc: 'open/done/dismissed，默认 open' }],
    execute: async (a) => {
      const rows = await getAdvisorInsights(a.status || 'open');
      if (rows.length === 0) return '没有' + (a.status || '待处理') + '的 AI 建议';
      return rows.slice(0, 10).map((i: any) => (i.title || '') + '：' + String(i.detail || '').slice(0, 100) + (i.prompt ? '（可执行提示词已生成）' : '')).join('\n');
    },
  },
  {
    id: 'query_worklog',
    name: '查询工作手账',
    desc: '查工作手账记录。参数 project 可选（项目标签），days 可选（最近 N 天，默认 30）。',
    params: [
      { key: 'project', type: 'string', desc: '项目标签，可空' },
      { key: 'days', type: 'number', desc: '最近 N 天，默认 30' },
    ],
    execute: async (a) => {
      const days = Math.max(1, Math.min(Number(a.days) || 30, 365));
      const start = new Date(Date.now() - days * 86400000);
      const startStr = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-' + String(start.getDate()).padStart(2, '0');
      const rows = await getWorkLogs('', '', startStr, '', a.project || '');
      const notes = rows.filter((r: any) => !r.is_todo);
      if (notes.length === 0) return '最近 ' + days + ' 天无工作手账记录';
      return notes.slice(0, 20).map((r: any) => fmtDate(r.log_date) + (r.work_project ? '【' + r.work_project + '】' : '') + ' ' + (r.title || r.content || '').slice(0, 80)).join('\n');
    },
  },
  {
    id: 'query_todos',
    name: '查询待办事项',
    desc: '查未完成的工作待办。参数 project 可选（项目标签）。',
    params: [{ key: 'project', type: 'string', desc: '项目标签，可空' }],
    execute: async (a) => {
      const rows = (await getWorkLogs('', '', '', '', a.project || '')).filter((r: any) => r.is_todo === 1 && r.done === 0);
      if (rows.length === 0) return '没有未完成的待办';
      return rows.slice(0, 15).map((r: any) => fmtDate(r.log_date) + (r.work_project ? '【' + r.work_project + '】' : '') + ' ' + String(r.content || '').slice(0, 80)).join('\n');
    },
  },
  {
    id: 'compare_subcategory_cost',
    name: '子类成本跨项目对比',
    desc: '对比同一子类（物料通用名称，如"液晶面板"）在各项目的成本：列出每个项目中该子类的成本、占项目 BOM 比例，并标注最高与最低。参数 sub_category 必填（用子类通用名，不是型号）。',
    params: [{ key: 'sub_category', type: 'string', required: true, desc: '子类通用名称，如 液晶面板' }],
    execute: async (a) => {
      const projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const rows: { code: string; sub: number; total: number }[] = [];
      for (const p of projects) {
        const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
        if (boms.length === 0) continue;
        const cost = (b: any) => (b.part_cost ?? b.cost ?? 0) * (b.quantity ?? 1);
        const total = boms.reduce((s: number, b: any) => s + cost(b), 0);
        const sub = boms.filter((b: any) => String(b.sub_category || '').trim() === a.sub_category)
          .reduce((s: number, b: any) => s + cost(b), 0);
        if (sub > 0) rows.push({ code: p.code || '', sub, total });
      }
      if (rows.length === 0) return '没有项目使用子类「' + a.sub_category + '」（子类需与 BOM 中 sub_category 完全一致，可用 query_project_bom 先确认写法）';
      const lines = rows.map(r => r.code + '：' + fmtMoney(r.sub) + '（占 ' + Math.round((r.sub / r.total) * 100) + '%）');
      const max = rows.reduce((m, r) => (r.sub > m.sub ? r : m), rows[0]);
      const min = rows.reduce((m, r) => (r.sub < m.sub ? r : m), rows[0]);
      return '子类「' + a.sub_category + '」跨项目成本对比（' + rows.length + ' 个项目）：\n'
        + lines.join('\n')
        + '\n成本最高：' + max.code + ' ' + fmtMoney(max.sub)
        + '；最低：' + min.code + ' ' + fmtMoney(min.sub)
        + '（差 ' + fmtMoney(max.sub - min.sub) + '）';
    },
  },
  {
    id: 'insight_material_trend',
    name: '物料行情洞察',
    desc: '对某物料/品类做行情洞察（联网搜索 + 分析，返回趋势方向/置信度/幅度/建议）。参数 material_name 必填（物料通用名称，如"液晶面板"），category 可选（品类）。',
    params: [
      { key: 'material_name', type: 'string', required: true, desc: '物料通用名称，如 液晶面板' },
      { key: 'category', type: 'string', desc: '品类，如 硬件类，可空' },
    ],
    execute: async (a) => {
      const { agentSearchLoop } = await import('./trendService');
      const r = await agentSearchLoop(a.material_name, a.category || '', 'price-trend');
      return '「' + a.material_name + '」行情：趋势 ' + (r.trend_direction || '信号不明确') + '，置信度 ' + (r.confidence_level || '中') + (r.magnitude_min != null ? '，幅度 ' + r.magnitude_min + '%~' + (r.magnitude_max ?? '') + '%' : '') + '\n摘要：' + (r.summary || '') + (r.suggested_action ? '\n建议：' + r.suggested_action : '');
    },
  },
];

// ==================== 注册表 API ====================

export function listTools(): AiTool[] { return tools; }

export function getTool(id: string): AiTool | undefined { return tools.find(t => t.id === id); }

/** 参数校验：返回错误信息或 null */
export function validateArgs(tool: AiTool, args: any): string | null {
  const a = args || {};
  for (const p of tool.params) {
    const v = a[p.key];
    if (p.required && (v === undefined || v === null || v === '')) return '缺少必填参数 ' + p.key + '（' + p.desc + '）';
    if (v !== undefined && v !== null && v !== '') {
      if (p.type === 'number' && isNaN(Number(v))) return '参数 ' + p.key + ' 应为数字';
      if (p.type === 'string' && typeof v !== 'string' && typeof v !== 'number') return '参数 ' + p.key + ' 应为文本';
    }
  }
  return null;
}

/** 执行单个工具：校验 + 执行 + 结果截断（返回文本供模型消费） */
export async function executeTool(id: string, args: any): Promise<{ ok: boolean; text: string }> {
  const tool = getTool(id);
  if (!tool) return { ok: false, text: '未知工具：' + id };
  const err = validateArgs(tool, args);
  if (err) return { ok: false, text: '参数错误：' + err };
  try {
    const text = await tool.execute(args || {});
    return { ok: true, text: text.length > 2000 ? text.slice(0, 2000) + '…（已截断）' : text };
  } catch (e: any) {
    return { ok: false, text: '工具执行失败：' + String(e?.message || e).slice(0, 200) };
  }
}