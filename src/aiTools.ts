// 成本领域工具注册表（P1 Agent，2026-08-16）
// 设计：现有能力（查询/分析）包装成统一"工具"，本地模型编排调用序列（计划-执行-总结）
// 安全：第一版只暴露只读查询 + 物料行情洞察（走现有 agentSearchLoop，外发=物料名/品类）；无任何写操作工具
// 审计：每次 Agent 任务由调用方 logLocalAICall(request_type=agent_plan/agent_answer) 留痕

import { getProjects, getProjectBOMs, getParts, getWorkLogs, getSellingPoints, getSellingPointMaps } from './db';
import { getAllPartSuppliers, getSupplierPriceHistory } from './db/parts';
import { getProjectCostSnapshots, getTargets } from './db/projects';
import { getInsights } from './db/compare';
import { getAdvisorInsights } from './db/advisor';
import { getCompetitors, getCompetitorBOMs } from './db/competitors';
import { supplierTrendText } from './supplierTrend';
import { computeTargetStatuses } from './targetInsight';
import { computeSellingPointRows, computeModuleValueRows } from './sellingPointAnalyzer';
import { startOllamaStream, logLocalAICall } from './ollama';
import { buildQuoteReviewPrompt, parseQuoteReview } from './quoteReview';
import * as XLSX from 'xlsx';
// 工具图标（2026-08-16：按数据特征选择——查询=清单/文件夹，成本=钱币，趋势=折线，洞察=闪电，目标=靶心…）
import React from 'react';
import {
  FolderOutlined, ProfileOutlined, DollarOutlined, ShopOutlined, LineChartOutlined,
  AimOutlined, HistoryOutlined, FundOutlined, BulbOutlined, BookOutlined,
  CheckSquareOutlined, ThunderboltOutlined, BarChartOutlined, AuditOutlined, AppstoreOutlined, HeartOutlined,
  FileExcelOutlined, CalculatorOutlined, ClockCircleOutlined, MessageOutlined, SafetyCertificateOutlined,
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
  quote_review: AuditOutlined,
  query_project_module_value: AppstoreOutlined,
  query_project_health: HeartOutlined,
  query_competitor_bom: ShopOutlined,
  read_excel: FileExcelOutlined,
  calc: CalculatorOutlined,
  now: ClockCircleOutlined,
  create_todo: CheckSquareOutlined,
  add_goal: AimOutlined,
  query_voice_dims: MessageOutlined,
  query_data_readiness: SafetyCertificateOutlined,
  query_material_insight: HistoryOutlined,
  save_selling_analysis: CheckSquareOutlined,
  save_project_analysis: BulbOutlined,
  import_bom_to_project: FileExcelOutlined,
  import_supplier_quote: ShopOutlined,
  import_competitor_bom: ShopOutlined,
  import_voice_items: MessageOutlined,
  generate_report: BookOutlined,
  write_excel: FileExcelOutlined,
  ask_user: MessageOutlined,
  query_supplier_profile: ShopOutlined,
  canonicalize_project: AuditOutlined,
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

// ===== 工具辅助：读 Excel（read_excel 用；WebView 环境弹文件选择框，用户选文件） =====
function pickExcelFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = (ev: any) => resolve(ev.target?.files?.[0] || null);
    input.click();
  });
}
async function readExcelText(file: File, maxRows: number): Promise<string> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 }) as any[][];
  const lines = rows.slice(0, maxRows).map((row: any[]) => (row || []).map(String).join('\t'));
  return '文件：' + file.name + '（工作表 ' + wb.SheetNames.join('、') + '，共 ' + rows.length + ' 行，显示前 ' + Math.min(maxRows, rows.length) + ' 行）\n' + lines.join('\n');
}

// ===== 智能附件（2026-08-19）：AI 窗 📎 附加 Excel 后完整数据存 window.__costhub_attachment_data，工具直接读取 =====
function attachmentRows(type?: string): { rows: any[][]; name: string } | null {
  try {
    const W = window as any;
    const attach = W.__costhub_attachment_data || [];
    const match = type ? attach.find((x: any) => x.type === type) || attach[0] : attach[0];
    if (match && Array.isArray(match.rows) && match.rows.length > 1) return { rows: match.rows, name: match.name };
  } catch { }
  return null;
}
// 按表头列名映射成对象数组（第一行是表头）
function mapColumns(rows: any[][], defs: { names: string[]; out: string }[]): Record<string, any>[] {
  const header = rows[0] || [];
  const h = (header || []).map((x: any) => String(x || '').toLowerCase());
  const idx = defs.map(d => ({ out: d.out, i: h.findIndex(c => d.names.includes(c)) }));
  return rows.slice(1).map(r => {
    const o: Record<string, any> = {};
    idx.forEach(({ out, i }) => { if (i >= 0) o[out] = r[i]; });
    return o;
  });
}

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
      // ⚠️ 云端调用审批（2026-08-17，用户需求：本地 AI 要调云端时必须有提示+审批）——
      // preview 模式 → 挂入待确认队列（底部横幅「🔐 等待云端发送确认」），不发云端；确认后重发任务即放行（会话级记忆）
      const { requestCloudConfirm } = await import('./cloudConfirm');
      const ok = await requestCloudConfirm({ material: a.material_name, category: a.category || '' });
      if (!ok) {
        return '⚠️ 云端行情查询需审批：已加入待确认队列（屏幕底部「🔐 N 个物料洞察等待云端发送确认」横幅）。请在横幅中确认发送，确认后重新执行本任务即可获取行情。';
      }
      const { agentSearchLoop } = await import('./trendService');
      const r = await agentSearchLoop(a.material_name, a.category || '', 'price-trend');
      // 2026-08-18 数据一致性：洞察结果同步写入 trend_snapshots（匹配物料洞察列表），Decomposition 卡片自动更新
      let synced = false;
      try {
        const { getDb, saveTrendSnapshot } = await import('./db');
        const db = await getDb();
        const items = await db.select<any[]>('SELECT * FROM trend_items WHERE query_category LIKE ? ORDER BY id DESC LIMIT 1', ['%' + a.material_name + '%']);
        if (items.length) {
          await saveTrendSnapshot({
            trend_item_id: items[0].id, source_type: 'ai_panel',
            direction: r.trend_direction || '', confidence_level: r.confidence_level || '',
            summary: r.summary || '', suggested_action: r.suggested_action || '',
            skill_used: 'insight_material_trend', magnitude_min: r.magnitude_min, magnitude_max: r.magnitude_max,
          });
          await db.execute("UPDATE trend_items SET last_queried_at=datetime('now','localtime') WHERE id=?", [items[0].id]);
          synced = true;
          try { window.dispatchEvent(new CustomEvent('costhub-trend-updated')); } catch { /* 非浏览器忽略 */ }
        }
      } catch (e) { console.error('同步洞察列表失败:', e); }
      return '「' + a.material_name + '」行情：趋势 ' + (r.trend_direction || '信号不明确') + '，置信度 ' + (r.confidence_level || '中') + (r.magnitude_min != null ? '，幅度 ' + r.magnitude_min + '%~' + (r.magnitude_max ?? '') + '%' : '') + '\n摘要：' + (r.summary || '') + (r.suggested_action ? '\n建议：' + r.suggested_action : '') + (synced ? '\n✅ 已同步更新洞察列表（物料趋势洞察页卡片已更新）' : '\n（该物料不在洞察列表 trend_items 中，未保存卡片；可去物料趋势洞察页添加后再次洞察）');
    },
  },
  {
    id: 'quote_review',
    name: 'AI 审价',
    desc: '对供应商报价逐项审价（合理/偏高/虚高 + 合理价 + 议价要点），对照器件库参考价与品类常识。参数 quote 必填（报价文本，每行一项含 器件名/型号/单价）。',
    params: [{ key: 'quote', type: 'string', required: true, desc: '供应商报价文本' }],
    execute: async (a) => {
      const base2 = (await (await import('./db')).getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
      const model = await (await import('./db')).getSetting('local_ai_model', '');
      if (!model) return '未配置本地模型（设置 → 连接设置）';
      let context = '';
      try {
        const parts = await getParts();
        const suppliers = await getAllPartSuppliers();
        const byPart: Record<number, string[]> = {};
        (suppliers || []).forEach((s: any) => { (byPart[s.part_id] = byPart[s.part_id] || []).push(s.supplier_name + ' ¥' + (Number(s.price) || 0)); });
        const lines: string[] = [];
        for (const p of parts.slice(0, 50)) { const sups = byPart[p.id] || []; if (sups.length) lines.push(p.name + (p.model ? '(' + p.model + ')' : '') + '：' + sups.join('；')); }
        context = lines.slice(0, 50).join('\n');
      } catch { }
      const { system, user } = buildQuoteReviewPrompt(String(a.quote || ''), context);
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base2, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
          t => { full += t; }, () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', think: false, json: false, num_predict: 16384 });
      });
      await logLocalAICall({ request_type: 'quote_review', system_prompt: system, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model });
      const items = parseQuoteReview(full);
      if (items.length === 0) return '审价未识别出结果（模型输出：' + full.slice(0, 120) + '）';
      // 2026-08-18 写回：审价结论落库（AI 审价助手历史可见），不覆盖任何用户数据
      try {
        const { saveQuoteReviewLog } = await import('./db');
        const summary = items.map(i => i.item + '：' + i.verdict + (i.fair_price ? '，合理价 ' + i.fair_price : '')).join('；');
        await saveQuoteReviewLog(String(a.quote || ''), summary);
        try { window.dispatchEvent(new CustomEvent('costhub-quote-review-updated')); } catch { }
      } catch (e) { console.error('审价记录保存失败:', e); }
      return items.map(i => '[' + i.index + '] ' + i.item + '：' + i.verdict + (i.fair_price ? '，合理价 ' + i.fair_price : '') + (i.reason ? '（' + i.reason + '）' : '') + (i.negotiate ? '；议价：' + i.negotiate : '')).join('\n') + '\n✅ 审价记录已保存（AI 审价助手历史可见）';
    },
  },
  {
    id: 'query_project_module_value',
    name: '查询模块级价值分析',
    desc: '查某项目（上代产品）的模块级价值分析：每个模块的成本/声量/好评率/类型（好又便宜/好但贵/做得差/花得不值/次要），声量来自用户原声。参数 project_code 必填。需该项目已在「用户原声分析」页做过卖点分析与原声归纳。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号' }],
    execute: async (a) => {
      const projects = await getProjects('', '', '');
      const p = projects.find((x: any) => !x.is_deleted && x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const sps = await getSellingPoints(p.id);
      if (sps.length === 0) return '项目 ' + a.project_code + ' 还没有卖点分析。请先在「用户原声分析」页的卖点价值分析中完成 AI 智能分析和归纳原声，再来查模块价值。';
      const maps = await getSellingPointMaps(p.id);
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      const moduleCosts: Record<string, number> = {};
      boms.forEach((b: any) => { const m = b.module_name || '未归类'; moduleCosts[m] = (moduleCosts[m] || 0) + (Number(b.part_cost ?? b.cost) || 0) * (Number(b.quantity) || 1); });
      const rows = computeSellingPointRows({ sps: sps.map((s: any) => ({ id: s.id, name: s.name, positive: s.positive, negative: s.negative })), modules: maps.modules, moduleCosts });
      const modRows = computeModuleValueRows(rows, moduleCosts);
      if (modRows.length === 0) return '项目 ' + a.project_code + ' 没有模块关联到卖点（请先给卖点关联 BOM 模块）';
      const kindLabel: Record<string, string> = { cheap_good: '好又便宜', good_expensive: '好但贵', bad: '做得差', waste: '花得不值', minor: '次要' };
      return modRows.map(m => m.module + '：成本 ¥' + m.cost.toFixed(0) + '、声量 ' + m.count + '、好评率 ' + Math.round(m.quality * 100) + '%、类型「' + (kindLabel[m.kind] || m.kind) + '」、支撑卖点：' + (m.sellingPoints.join('、') || '无')).join('\n');
    },
  },
  {
    id: 'query_project_health',
    name: '查询项目深度体检数据',
    desc: '查某项目的体检原始数据（BOM 成本结构/目标达成/成本快照异动），供综合分析"为什么贵、哪里贵、怎么降"。参数 project_code 必填。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号' }],
    execute: async (a) => {
      const projects = await getProjects('', '', '');
      const p = projects.find((x: any) => !x.is_deleted && x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const out: string[] = [];
      out.push('项目 ' + a.project_code + '（' + (p.name || '') + '，' + (p.tier || '') + ' ' + (p.category || '') + '）');
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      const cost = (b: any) => (b.part_cost ?? b.cost ?? 0) * (b.quantity ?? 1);
      const total = boms.reduce((s: number, b: any) => s + cost(b), 0);
      out.push('BOM 总成本 ' + fmtMoney(total) + '，共 ' + boms.length + ' 项');
      const modMap = new Map<string, number>();
      for (const b of boms) { const m = b.module_name || '未分模块'; modMap.set(m, (modMap.get(m) || 0) + cost(b)); }
      out.push('模块成本（降序）：' + [...modMap.entries()].sort((x, y) => y[1] - x[1]).map(([m, c]) => m + ' ' + fmtMoney(c) + '(' + Math.round((c / total) * 100) + '%)').join('、'));
      try {
        const targets = await getTargets(p.id);
        if (targets.length) out.push('目标成本：' + targets.map((t: any) => t.domain + ' 目标 ' + fmtMoney(t.target_cost)).join('、'));
      } catch { }
      try {
        const snaps = await getProjectCostSnapshots(p.id);
        if (snaps.length) out.push('最近成本快照：' + snaps.slice(0, 3).map((s: any) => fmtDate(s.created_at) + ' ' + fmtMoney(s.bom_cost)).join(' → '));
      } catch { }
      return out.join('\n');
    },
  },
  {
    id: 'read_excel',
    name: '读取 Excel 文件',
    desc: '读取一个 Excel（.xlsx/.xls）文件，把第一个工作表返回为表格文本（每行 tab 分隔，最多 max_rows 行，默认 60）。可用于读供应商报价表/用户原声表/BOM 表/竞品表等。参数 file_path 可选；不填会弹出文件选择框由用户选择（推荐）。',
    params: [
      { key: 'file_path', type: 'string', desc: 'Excel 文件路径（可空，空则弹出选择框由用户选）' },
      { key: 'max_rows', type: 'number', desc: '最多返回行数，默认 60' },
    ],
    execute: async (a) => {
      const maxRows = Math.max(1, Math.min(Number(a.max_rows) || 60, 200));
      const file = await pickExcelFile();
      if (!file) return '用户取消选择文件';
      return await readExcelText(file, maxRows);
    },
  },
  {
    id: 'calc',
    name: '可靠计算',
    desc: '做算术计算（加减乘除/括号/百分比），返回结果。用于核验成本数字（BOM 合计、占比、单价×数量、加费率等），避免自己口算错。参数 expression 必填（如 (520*1+185*2)*1.05 或 45/300*100）。',
    params: [{ key: 'expression', type: 'string', required: true, desc: '算术表达式' }],
    execute: async (a) => {
      const expr = String(a.expression || '').replace(/[^0-9+\-*/().%\s]/g, '');
      if (!expr) return '表达式为空或不合法（只支持数字和 + - * / ( ) . %）';
      try {
        const result = new Function('return (' + expr + ')')();
        if (typeof result !== 'number' || !isFinite(result)) return '无法计算：' + expr;
        return expr + ' = ' + (Math.round(result * 10000) / 10000);
      } catch { return '表达式无法解析：' + expr; }
    },
  },
  {
    id: 'now',
    name: '当前时间',
    desc: '返回当前本地日期时间（YYYY-MM-DD HH:MM），供报告落款/判断时效用。无参数。',
    params: [],
    execute: async () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },
  },
  {
    id: 'create_todo',
    name: '创建待办事项',
    desc: '在工作手账创建一条待办（如 AI 分析后发现的跟进事项：该去谈价的物料、该降本的项目）。参数 content 必填（待办内容），project 可选（关联项目标签）。',
    params: [
      { key: 'content', type: 'string', required: true, desc: '待办内容' },
      { key: 'project', type: 'string', desc: '关联项目标签，可空' },
    ],
    execute: async (a) => {
      const { saveWorkLog } = await import('./db/worklog');
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const content = String(a.content || '').trim();
      if (!content) return '待办内容不能为空';
      const id = await saveWorkLog({ log_date: date, title: '', content, category: '其他', tags: '', work_project: a.project || '', is_todo: 1, done: 0 });
      return '已创建待办：' + content + (a.project ? '（项目 ' + a.project + '）' : '') + '（id ' + id + '）';
    },
  },
  {
    id: 'add_goal',
    name: '下达目标',
    desc: '给后台自主分析下达一个目标（如"把M270整机成本降到¥900"），自主分析会优先围绕它推进，每轮结论回写目标进度。参数 text 必填（目标内容），linked_project 可选（关联项目代号）。',
    params: [
      { key: 'text', type: 'string', required: true, desc: '目标内容' },
      { key: 'linked_project', type: 'string', desc: '关联项目代号，可空' },
    ],
    execute: async (a) => {
      const { saveGoal } = await import('./db/goals');
      const text = String(a.text || '').trim();
      if (!text) return '目标内容不能为空';
      const id = await saveGoal(text, a.linked_project || '');
      return '已下达目标：' + text + '（id ' + id + '，后台自主分析将优先推进）';
    },
  },
  {
    id: 'query_voice_dims',
    name: '查询原声维度',
    desc: '查某产品的用户原声提炼维度（特性名/声量/好评率/正负），了解用户最在意什么。参数 product 必填（产品名，与「用户原声分析」页的产品一致）。',
    params: [{ key: 'product', type: 'string', required: true, desc: '产品名' }],
    execute: async (a) => {
      const { getVoiceDimensions } = await import('./db');
      const dims = await getVoiceDimensions(String(a.product || '').trim());
      if (dims.length === 0) return '产品「' + a.product + '」还没有原声分析结果（请先在「用户原声分析」页导入原声并分析）';
      return dims.slice(0, 20).map((d: any) => d.name + '：声量 ' + d.count + '、好评率 ' + Math.round((d.count > 0 ? d.positive / d.count : 0) * 100) + '%（正 ' + d.positive + '/负 ' + d.negative + '）').join('\n');
    },
  },
  {
    id: 'query_competitor_bom',
    name: '查询竞品 BOM 对标数据',
    desc: '查竞品的 BOM 估算与市场售价（及其模块成本结构），供竞品成本对标分析。参数 brand 可选（品牌），model 可选（型号）；不填则列出全部竞品。',
    params: [
      { key: 'brand', type: 'string', desc: '竞品品牌，可空' },
      { key: 'model', type: 'string', desc: '竞品型号，可空' },
    ],
    execute: async (a) => {
      const competitors = await getCompetitors();
      const list = competitors.filter((c: any) => (!a.brand || String(c.brand || '').includes(a.brand)) && (!a.model || String(c.model || '').includes(a.model)));
      if (list.length === 0) return '未找到竞品（品牌：' + (a.brand || '任意') + '）';
      const out: string[] = [];
      for (const c of list.slice(0, 5)) {
        out.push('竞品 ' + (c.brand || '') + ' ' + (c.model || '') + '：售价 ' + fmtMoney(c.market_price) + '，估算 BOM ' + fmtMoney(c.bom_cost) + '，档位 ' + (c.tier || ''));
        const boms = await getCompetitorBOMs(c.id);
        if (boms.length === 0) { out.push('  （无 BOM 估算明细）'); continue; }
        const modMap = new Map<string, number>();
        for (const b of boms) { const m = b.module_name || '未分模块'; modMap.set(m, (modMap.get(m) || 0) + (Number(b.estimated_cost) || 0) * (Number(b.quantity) || 1)); }
        out.push('  模块：' + [...modMap.entries()].sort((x, y) => y[1] - x[1]).map(([m, c2]) => m + ' ' + fmtMoney(c2)).join('、'));
      }
      return out.join('\n');
    },
  },
  {
    id: 'query_data_readiness',
    name: '数据就绪度诊断',
    desc: '扫描用户全部数据（本地模型/项目BOM/器件与供应商报价/用户原声/目标成本/竞品/规格分类），逐项给出 有/缺/半 状态、现在能做什么、缺了影响什么、建议补什么。用户问"我该补什么数据/现在能做哪些分析"或刚上手想了解能做什么时调用。无参数。',
    params: [],
    execute: async () => {
      const { getDataReadiness, readinessToText } = await import('./dataReadiness');
      return readinessToText(await getDataReadiness());
    },
  },
  {
    id: 'query_material_insight',
    name: '查询物料洞察历史',
    desc: '查某物料是否洞察过及最近洞察结论（趋势方向/置信度/摘要/时间/来源：免分解/分解/自动）。参数 material_name 必填（物料通用名，如 Scaler IC、液晶面板）。先查历史洞察再决定是否需要查最新行情。',
    params: [{ key: 'material_name', type: 'string', required: true, desc: '物料通用名' }],
    execute: async (a) => {
      const { getDb } = await import('./db');
      const db = await getDb();
      const name = String(a.material_name || '').trim();
      if (!name) return '物料名不能为空';
      const items = await db.select<any[]>('SELECT * FROM trend_items WHERE query_category LIKE ? ORDER BY last_queried_at DESC, id DESC', ['%' + name + '%']);
      if (items.length === 0) return '「' + name + '」还没有洞察记录（可在物料趋势洞察页洞察，或告诉我用 insight_material_trend 查最新行情）';
      const lines: string[] = [];
      for (const it of items.slice(0, 5)) {
        const src = it.source_type === 'quick' ? '免分解' : it.source_type === 'auto' ? '自动洞察' : '分解洞察';
        const snaps = await db.select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY query_time DESC, id DESC LIMIT 1', [it.id]);
        if (snaps.length === 0) { lines.push('「' + it.query_category + '」（' + src + '）有物料但暂无洞察结论' + (it.last_queried_at ? '，上次查询 ' + String(it.last_queried_at || '').slice(0, 16) : '')); continue; }
        const s = snaps[0];
        // 2026-08-19：附关联器件型号（用户：不知道是什么型号——Scaler IC 是品类，库内可能有关联具体型号）
        let modelLine = '';
        try {
          const mp = await db.select<any[]>('SELECT p.name, p.model FROM parts p JOIN trend_part_mapping tpm ON p.id = tpm.part_id WHERE tpm.trend_item_id = ? LIMIT 6', [it.id]);
          if (mp.length) modelLine = '。关联器件型号：' + mp.map((x: any) => (x.model || x.name || '')).filter(Boolean).join('、');
        } catch { }
        lines.push('「' + it.query_category + '」（' + src + '）最近洞察 ' + String(s.query_time || '').slice(0, 16) + '：趋势 ' + (s.direction || '-') + '，置信度 ' + (s.confidence_level || '-') + (s.summary ? '。摘要：' + String(s.summary || '').slice(0, 150) : '') + modelLine);
      }
      return lines.join('\n');
    },
  },
  {
    id: 'save_selling_analysis',
    name: '保存卖点价值分析结论',
    desc: '把 AI 对某项目卖点/模块价值的分析结论写回系统（卖点价值分析面板显示「最近 AI 分析结论」）。参数 project_code 必填（项目代号），conclusion 必填（分析结论要点，如哪个卖点值得保留/哪个模块该降本减配）。只记录 AI 结论，不覆盖用户编辑的卖点数据。',
    params: [
      { key: 'project_code', type: 'string', required: true, desc: '项目代号' },
      { key: 'conclusion', type: 'string', required: true, desc: '分析结论要点' },
    ],
    execute: async (a) => {
      const { getProjects } = await import('./db');
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const conclusion = String(a.conclusion || '').trim();
      if (!conclusion) return '结论内容不能为空';
      const { saveSellingAnalysis } = await import('./db/selling');
      const id = await saveSellingAnalysis(p.id, p.code || '', conclusion);
      try { const W = window as any; W.__costhub_undo = { toolId: 'save_selling_analysis', inserts: { selling_point_analysis: [id] } }; } catch { }
      try { window.dispatchEvent(new CustomEvent('costhub-selling-updated')); } catch { /* 非浏览器忽略 */ }
      return '已保存项目 ' + a.project_code + ' 的卖点价值分析结论（id ' + id + '），卖点价值分析面板已更新「最近 AI 分析结论」。';
    },
  },
  {
    id: 'save_project_analysis',
    name: '保存项目分析结论',
    desc: '把 AI 对某项目的分析结论（降本建议/体检结论/价值判断等）写回系统，驾驶舱「最近 AI 分析结论」展示。参数 project_code 必填（项目代号），conclusion 必填（结论要点）。只记录 AI 结论，不修改项目数据。',
    params: [
      { key: 'project_code', type: 'string', required: true, desc: '项目代号' },
      { key: 'conclusion', type: 'string', required: true, desc: '分析结论要点' },
    ],
    execute: async (a) => {
      const { getProjects } = await import('./db');
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const conclusion = String(a.conclusion || '').trim();
      if (!conclusion) return '结论内容不能为空';
      const { saveProjectAnalysis } = await import('./db');
      const id2 = await saveProjectAnalysis(p.id, p.code || '', conclusion);
      try { const W = window as any; W.__costhub_undo = { toolId: 'save_project_analysis', inserts: { project_analysis_logs: [id2] } }; } catch { }
      try { window.dispatchEvent(new CustomEvent('costhub-project-analysis-updated')); } catch { }
      return '已保存项目 ' + a.project_code + ' 的分析结论，驾驶舱「最近 AI 分析结论」已更新。';
    },
  },
  {
    id: 'import_bom_to_project',
    name: 'BOM 拆解入库',
    desc: '把一份原始 BOM（器件清单）拆解后自动录入某项目：器件按名称+型号去重入器件库（复用已有），按模块归类（内置规则自动归：面板/电源/驱动板/结构件等），写入项目 BOM。参数 project_code 必填（目标项目代号），items 必填（JSON 数组字符串，每项 {name:器件名, model?:型号, quantity?:数量, cost?:单价, module?:模块名(可空自动归类), mainCat?:大类, sub?:子类}）。用于"丢一份BOM帮我录入"。',
    params: [
      { key: 'project_code', type: 'string', required: true, desc: '目标项目代号' },
      { key: 'items', type: 'string', required: true, desc: 'JSON 数组字符串' },
    ],
    execute: async (a) => {
      const { getProjects } = await import('./db');
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      let items: any[] = [];
      try { items = JSON.parse(String(a.items || '[]')); } catch { items = []; }
      if (!Array.isArray(items) || items.length === 0) {
        // 2026-08-19 智能附件：未传 items → 从附加的 BOM 表自动读取（列名映射）
        const att = attachmentRows('bom');
        if (att) {
          items = mapColumns(att.rows, [
            { names: ['名称', '器件名称', '器件名', '物料名称', '物料', 'name'], out: 'name' },
            { names: ['型号', 'model'], out: 'model' },
            { names: ['数量', 'quantity', 'qty'], out: 'quantity' },
            { names: ['单价', '成本', '价格', 'cost', 'price'], out: 'cost' },
            { names: ['模块', 'module'], out: 'module' },
          ]).map((x: any) => ({ name: String(x.name || '').trim(), model: String(x.model || '').trim(), quantity: Number(x.quantity) || 1, cost: Number(x.cost) || 0, module: String(x.module || '').trim() })).filter((x: any) => x.name);
        }
      }
      if (items.length === 0) return 'items 为空（可传 JSON 数组，或在输入区附加 BOM Excel 后重试）';
      const { classifyByModule } = await import('./moduleRules');
      const norm = items.map((it: any) => {
        const cls = classifyByModule(String(it.name || ''));
        return {
          name: String(it.name || '').trim(), model: String(it.model || '').trim(),
          quantity: Number(it.quantity) || 1, cost: Number(it.cost) || 0,
          module: String(it.module || '').trim() || cls?.module || '',
          mainCat: String(it.mainCat || '').trim() || cls?.mainCat || '硬件类',
          sub: String(it.sub || '').trim() || cls?.sub || '',
        };
      }).filter((x: any) => x.name);
      const { importProjectBom } = await import('./db');
      const st = await importProjectBom(p.id, norm);
      try { window.dispatchEvent(new CustomEvent('costhub-project-bom-updated')); } catch { }
      const modLine = Object.entries(st.byModule).map(([m, c]) => m + '×' + c).join('、');
      return '已导入项目 ' + a.project_code + '：共 ' + st.total + ' 项，新建器件 ' + st.created + ' 个、复用已有 ' + st.reused + ' 个、跳过重复/无效 ' + st.skipped + ' 项。模块分布：' + (modLine || '无') + '。项目 BOM 已更新（项目管理页可见）。';
    },
  },
  {
    id: 'import_supplier_quote',
    name: '供应商报价入库',
    desc: '把供应商报价表录入供应商管理：按器件名+型号匹配已有器件，写入该器件的供应商报价（价格/份额）。参数 rows 必填（JSON 数组字符串，每项 {name:器件名, model?:型号, supplier:供应商名, price:报价, share?:份额%}）。未匹配到器件的会列出，提示先入器件库。',
    params: [{ key: 'rows', type: 'string', required: true, desc: 'JSON 数组字符串' }],
    execute: async (a) => {
      let rows: any[] = [];
      try { rows = JSON.parse(String(a.rows || '[]')); } catch { rows = []; }
      if (!Array.isArray(rows) || rows.length === 0) {
        const att = attachmentRows('supplier');
        if (att) {
          rows = mapColumns(att.rows, [
            { names: ['名称', '器件名称', '器件名', '物料', 'name'], out: 'name' },
            { names: ['型号', 'model'], out: 'model' },
            { names: ['供应商', '供应商名称', 'supplier'], out: 'supplier' },
            { names: ['价格', '单价', '报价', 'price'], out: 'price' },
            { names: ['份额', '占比', 'share'], out: 'share' },
          ]).map((x: any) => ({ name: String(x.name || '').trim(), model: String(x.model || '').trim(), supplier: String(x.supplier || '').trim(), price: Number(x.price) || 0, share: Number(x.share) || 0 })).filter((x: any) => x.name && x.supplier);
        }
      }
      if (rows.length === 0) return 'rows 为空（可传 JSON 数组，或在输入区附加供应商报价 Excel 后重试）';
      const { importSupplierQuotes } = await import('./db');
      const st = await importSupplierQuotes(rows);
      try { window.dispatchEvent(new CustomEvent('costhub-supplier-updated')); } catch { }
      return '供应商报价入库：共 ' + st.total + ' 条，匹配器件 ' + st.matched + ' 个、写入 ' + st.added + ' 条报价' + (st.unmatched > 0 ? '，未匹配器件 ' + st.unmatched + ' 个：' + st.unmatchedNames.slice(0, 10).join('、') + '（需先入器件库）' : '') + '。';
    },
  },
  {
    id: 'import_competitor_bom',
    name: '竞品 BOM 入库',
    desc: '把竞品 BOM（拆解估算清单）录入竞品管理：按品牌+型号定位竞品，写入 BOM 估算明细（器件/估算成本/数量/模块）。参数 brand 必填、model 必填（定位竞品），rows 必填（JSON 数组，每项 {name, model?, cost, quantity?, module?}）。',
    params: [
      { key: 'brand', type: 'string', required: true, desc: '竞品品牌' },
      { key: 'model', type: 'string', required: true, desc: '竞品型号' },
      { key: 'rows', type: 'string', required: true, desc: 'JSON 数组字符串' },
    ],
    execute: async (a) => {
      const { getCompetitors } = await import('./db');
      const comps = await getCompetitors();
      const c = comps.find((x: any) => String(x.brand || '').includes(String(a.brand || '')) && String(x.model || '').includes(String(a.model || '')));
      if (!c) return '未找到竞品：' + a.brand + ' ' + a.model + '（可在竞品管理页先录入）';
      let rows: any[] = [];
      try { rows = JSON.parse(String(a.rows || '[]')); } catch { rows = []; }
      if (!Array.isArray(rows) || rows.length === 0) {
        const att = attachmentRows('competitor');
        if (att) {
          rows = mapColumns(att.rows, [
            { names: ['名称', '器件名称', '物料', 'name'], out: 'name' },
            { names: ['型号', 'model'], out: 'model' },
            { names: ['成本', '估算成本', '价格', 'cost'], out: 'cost' },
            { names: ['数量', 'quantity', 'qty'], out: 'quantity' },
            { names: ['模块', 'module'], out: 'module' },
          ]).map((x: any) => ({ name: String(x.name || '').trim(), model: String(x.model || '').trim(), cost: Number(x.cost) || 0, quantity: Number(x.quantity) || 1, module: String(x.module || '').trim() })).filter((x: any) => x.name);
        }
      }
      if (rows.length === 0) return 'rows 为空（可传 JSON 数组，或在输入区附加竞品 Excel 后重试）';
      const { classifyByModule } = await import('./moduleRules');
      const norm = rows.map((it: any) => {
        const cls = classifyByModule(String(it.name || ''));
        return { name: String(it.name || '').trim(), model: String(it.model || '').trim(), cost: Number(it.cost) || 0, quantity: Number(it.quantity) || 1, module: String(it.module || '').trim() || cls?.module || '' };
      }).filter((x: any) => x.name);
      const { importCompetitorBom } = await import('./db');
      const st = await importCompetitorBom(c.id, norm);
      try { window.dispatchEvent(new CustomEvent('costhub-competitor-updated')); } catch { }
      return '竞品 ' + c.brand + ' ' + c.model + ' BOM 入库完成：共 ' + st.total + ' 项，写入 ' + st.added + ' 项（竞品管理页可见）。';
    },
  },
  {
    id: 'import_voice_items',
    name: '原声批量导入',
    desc: '把用户原声（评价/评论/反馈文本）批量导入指定产品（用户原声分析页数据源，供 AI 提炼维度/卖点分析）。参数 product 必填（产品名/项目代号），items 必填（JSON 数组字符串，元素为文本或 {content/text}）。重复内容自动跳过。',
    params: [
      { key: 'product', type: 'string', required: true, desc: '产品名/项目代号' },
      { key: 'items', type: 'string', required: true, desc: 'JSON 数组字符串' },
    ],
    execute: async (a) => {
      let arr: any[] = [];
      try { arr = JSON.parse(String(a.items || '[]')); } catch { arr = []; }
      if (!Array.isArray(arr) || arr.length === 0) {
        const att = attachmentRows('voice');
        if (att) {
          const mapped = mapColumns(att.rows, [
            { names: ['评价', '评论', '反馈', '内容', '意见', '点评', '口碑'], out: 'content' },
          ]);
          arr = mapped.map((x: any) => String(x.content || '')).filter(Boolean);
        }
      }
      if (arr.length === 0) return 'items 为空（可传 JSON 数组，或在输入区附加原声 Excel 后重试）';
      const contents = arr.map((x: any) => String(typeof x === 'string' ? x : (x?.content ?? x?.text ?? '')).trim()).filter(Boolean);
      if (contents.length === 0) return '没有有效原声内容';
      const { importVoiceItems } = await import('./db');
      const st = await importVoiceItems(String(a.product || '').trim(), contents);
      try { window.dispatchEvent(new CustomEvent('costhub-voice-updated')); } catch { }
      return '原声导入产品「' + a.product + '」：共 ' + st.total + ' 条，新增 ' + st.added + ' 条、跳过重复 ' + st.dup + ' 条（用户原声分析页可见）。';
    },
  },
  {
    id: 'generate_report',
    name: '生成报告（HTML/PPTX）',
    desc: '把分析结论生成一份报告（HTML 网页报告 或 PPTX 演示），保存到应用导出目录 exports/。参数 title 必填（报告标题），slides 必填（JSON 数组 [{heading:小节标题, points:[要点数组]}]——把结论组织成 3-6 节，每节 2-5 个要点），format 可选（html/pptx，默认 html），subtitle 可选。用于"生成一份XX报告/演示"。',
    params: [
      { key: 'title', type: 'string', required: true, desc: '报告标题' },
      { key: 'slides', type: 'string', required: true, desc: 'JSON 数组 [{heading,points}]' },
      { key: 'format', type: 'string', desc: 'html/pptx，默认 html' },
      { key: 'subtitle', type: 'string', desc: '副标题，可空' },
    ],
    execute: async (a) => {
      const title = String(a.title || '').trim();
      if (!title) return '报告标题不能为空';
      let slides: any[];
      try { slides = JSON.parse(String(a.slides || '[]')); } catch { return 'slides 不是合法 JSON 数组'; }
      if (!Array.isArray(slides) || slides.length === 0) return 'slides 为空（至少一节）';
      const format = String(a.format || '').toLowerCase() === 'pptx' ? 'pptx' : 'html';
      const subtitle = String(a.subtitle || '');
      const { buildHtmlReportBase64, buildPptxBase64 } = await import('./aiReport');
      const b64 = format === 'html' ? buildHtmlReportBase64(title, slides, subtitle) : await buildPptxBase64(title, slides, subtitle);
      const safe = title.replace(/[\\/:*?"<>|]/g, '_');
      const name = '报告-' + safe + '-' + new Date().toISOString().slice(0, 10) + '.' + format;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_export_file', { fileName: name, base64Data: b64 });
      return '✅ 已生成报告：' + name + '（' + format + ' 格式，' + slides.length + ' 节，保存在应用导出目录 exports/，可在导出目录查看/打开）';
    },
  },
  {
    id: 'write_excel',
    name: '生成 Excel 表格',
    desc: '把结构化数据生成 Excel 文件（.xlsx）保存到应用导出目录 exports/。参数 file_name 必填（文件名，可含或不含 .xlsx），sheets 必填（JSON 数组 [{name:工作表名, rows:[[单元格值...]...]}]，第一行通常为表头）。用于"把分析结果导出成 Excel 表格/清单"。',
    params: [
      { key: 'file_name', type: 'string', required: true, desc: '文件名' },
      { key: 'sheets', type: 'string', required: true, desc: 'JSON 数组 [{name,rows}]' },
    ],
    execute: async (a) => {
      let sheets: any[];
      try { sheets = JSON.parse(String(a.sheets || '[]')); } catch { return 'sheets 不是合法 JSON 数组'; }
      if (!Array.isArray(sheets) || sheets.length === 0) return 'sheets 为空';
      const { buildWorkbookBase64 } = await import('./aiReport');
      const b64 = buildWorkbookBase64(sheets);
      const raw = String(a.file_name || '').trim().replace(/[\\/:*?"<>|]/g, '_') || ('导出-' + new Date().toISOString().slice(0, 10));
      const name = raw.toLowerCase().endsWith('.xlsx') ? raw : raw + '.xlsx';
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_export_file', { fileName: name, base64Data: b64 });
      const rowsTotal = sheets.reduce((s: number, sh: any) => s + ((sh.rows || []).length - 1), 0);
      return '✅ 已生成 Excel：' + name + '（' + sheets.length + ' 个工作表，' + Math.max(0, rowsTotal) + ' 行数据，保存在导出目录 exports/）';
    },
  },
  {
    id: 'ask_user',
    name: '询问用户确认',
    desc: '遇到不确定的关键信息（如用户没说哪个物料/哪个项目/选哪个方案）时调用，向用户提问并给选项，等用户选择后再继续——不要瞎猜。参数 question 必填（问题），options 可选（JSON 数组字符串，选项列表）。前端会渲染选项按钮供用户点击。',
    params: [
      { key: 'question', type: 'string', required: true, desc: '要问用户的问题' },
      { key: 'options', type: 'string', desc: 'JSON 数组字符串，选项列表，可空' },
    ],
    execute: async (_a) => {
      // AiPanel 会拦截本工具渲染选项并等待用户点击；这里只是兜底（正常情况下不执行到这里）
      return '已向用户提问，等待选择…';
    },
  },
  {
    id: 'query_supplier_profile',
    name: '查询供应商画像',
    desc: '查每个供应商的画像（覆盖器件数/平均价/价格水平比库内均价高或低%/最大份额）——审价或谈价前了解"这家历来贵不贵、好不好压价"。参数 supplier 可选（供应商名，不填列出全部）。',
    params: [{ key: 'supplier', type: 'string', desc: '供应商名，可空（空则全部）' }],
    execute: async (_a) => {
      const { getSupplierPriceProfiles } = await import('./db');
      const rows = await getSupplierPriceProfiles();
      const list = (rows || []).filter((r: any) => !_a.supplier || String(r.supplier_name || '').includes(String(_a.supplier || '')));
      if (list.length === 0) return '没有供应商报价数据（先在器件库录入供应商报价）';
      return list.slice(0, 15).map((r: any) => (r.supplier_name || '') + '：覆盖 ' + r.part_count + ' 个器件，平均价 ¥' + r.avg_price + '，价格水平 ' + (r.level > 0 ? '偏高 ' + r.level + '%' : r.level < 0 ? '偏低 ' + (-r.level) + '%' : '持平') + (r.max_share > 0 ? '，最大份额 ' + r.max_share + '%' : '')).join('\n');
    },
  },
  {
    id: 'canonicalize_project',
    name: '规范化项目物料',
    desc: '把某项目 BOM 的全部物料用 AI 批量规范成统一标准名（品类+规格+型号，一套通用规则套所有物料；笼统物料如"支架/底座"只归类不编造规格）。结果写入器件库的 canonical 影子字段（原名/模块库不动），匹配/统计/检索将更准。参数 project_code 必填（项目代号）。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号' }],
    execute: async (a) => {
      const { getProjects } = await import('./db');
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      // 2026-08-27 预检：模型未就绪快速报原因，不空跑（Ollama 未运行 / 模型未下载）
      const { detectOllama } = await import('./aiStatus');
      const pre = await detectOllama();
      if (!pre.connected) return '规范化需要本地模型，但 ' + (pre.reason === 'model-missing' ? '模型未下载（请先在 Ollama 拉取模型，或到设置→连接设置选择已下载的模型）' : 'Ollama 未运行（请先启动 Ollama，设置 → 连接设置 → 检测连接）') + '。本次未修改任何数据。';
      const { canonicalizeProject } = await import('./canonicalize');
      const st = await canonicalizeProject(p.id);
      let msg = '项目 ' + a.project_code + ' 物料规范化完成：共 ' + st.total + ' 条，已规范 ' + st.done + ' 条（其中笼统保留 ' + st.kept + ' 条）、失败 ' + st.failed + ' 条。结果写入器件库标准名（原名/模块库不变）。';
      if (st.errors && st.errors.length) msg += '\n失败原因：' + st.errors.join('；') + '（可检查 Ollama 后重试，已规范的物料不会重复处理）。';
      return msg;
    },
  },
];

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
    // 2026-08-18 单路深挖：结果放宽到 4000 字（thinkEngine 有 compressMessages 兜底上下文），关键数据尽量完整给模型
    return { ok: true, text: text.length > 4000 ? text.slice(0, 4000) + '…（已截断）' : text };
  } catch (e: any) {
    return { ok: false, text: '工具执行失败：' + String(e?.message || e).slice(0, 200) };
  }
}