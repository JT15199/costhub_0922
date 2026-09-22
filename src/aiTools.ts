import { withNativeSchema, prepareBusinessArgs, validateNestedArgs, parseToolArray } from './ai/toolSchema';
// 成本领域工具注册表（P1 Agent，2026-08-16；招标分析扩展 2026-08-31）
// 设计：现有能力（查询/分析/写入）包装成统一"工具"，本地模型编排调用序列（计划-执行-总结）
// 安全：风险由 src/ai/toolRegistry.ts Manifest 声明；写工具只能经 executeTool 的确认门禁
// 审计：每次 Agent 任务由调用方 logLocalAICall(request_type=agent_plan/agent_answer) 留痕

import { getProjects, getProjectBOMs, getParts, getWorkLogs, getSellingPoints, getSellingPointMaps, getTenderOverview, getTenderMatrix, getSetting } from './db';
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
import { executeStructuredTool as executeStructuredToolAdapter, getToolManifest as resolveToolManifest, STRUCTURED_TOOL_IDS } from './ai/toolRegistry';
import { bomExtendedCostStrict, sumBomCostStrict } from './ai/contracts';
import type { AiToolManifest, AiToolResult, ExecuteToolOptions, RunContext, ToolCall } from './ai/contracts';
import { evaluateExpression } from './ai/calc';
import { detectVoiceSheet, resolveVoiceItems } from './voiceImport';
import { diagnoseSearchConfig } from './apiConfig';
import { getPendingConfirms, requestCloudConfirm } from './cloudConfirm';
import { sanitizeC2Payload } from './ai/c2Bridge';
import { getDataReadiness, readinessToText } from './dataReadiness';
import { detectOllama } from './aiStatus';

export { AI_TOOL_MANIFESTS, listToolManifests, toolRequiresConfirmation, WRITE_TOOL_IDS } from './ai/toolRegistry';
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
  visualize_cost_analysis: BarChartOutlined,
  query_target_status: AimOutlined,
  query_cost_snapshots: HistoryOutlined,
  query_price_insights: FundOutlined,
  query_advisor_insights: BulbOutlined,
  query_worklog: BookOutlined,
  query_todos: CheckSquareOutlined,
  insight_material_trend: ThunderboltOutlined,
  cloud_abstract_analysis: SafetyCertificateOutlined,
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
  query_tender_analysis: BarChartOutlined,
  estimate_similar_projects: HistoryOutlined,
  rank_quote_negotiations: DollarOutlined,
  explain_quote_change: HistoryOutlined,
};
export function toolIcon(id: string): React.ComponentType {
  return TOOL_ICONS[id] || FolderOutlined;
}

export interface AiToolParam {
  schema?: Record<string, unknown>;
  key: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  desc: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: 'string' | 'number' | 'boolean';
}

export interface AiTool {
  id: string;
  name: string;        // 中文名（UI 展示）
  desc: string;        // 给模型的描述：何时用 + 参数说明
  params: AiToolParam[];
  execute: (args: Record<string, any>, options?: ExecuteToolOptions) => Promise<string>;  // 返回文本（供模型消费）
  manifest?: AiToolManifest;
}

const fmtMoney = (n: any) => n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) ? '待补证据' : '¥' + Number(n).toFixed(2);
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
async function readExcelText(file: File, maxRows: number, offset = 0, sheetName = ''): Promise<string> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf);
  const sheet = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[sheet];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 }) as any[][];
  const page = rows.slice(offset, offset + maxRows);
  const pagination = { totalRows: rows.length, offset, returnedRows: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null };
  const lines = page.map((row: any[]) => (row || []).map(String).join('\t'));
  return '文件：' + file.name + '（工作表 ' + sheet + '；可用工作表：' + wb.SheetNames.join('、') + '）\n分页：' + JSON.stringify(pagination) + '\n' + lines.join('\n');
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

/** Return already-attached table rows to the model without opening a second file picker. */
export function formatAttachmentRows(attachments: any[], maxRows = 8, offset = 0, sheetName = ''): string {
  const limit = Math.max(1, Math.min(Number(maxRows) || 8, 200));
  return (attachments || []).filter((item: any) => Array.isArray(item?.rows) || Array.isArray(item?.sheets)).map((item: any) => {
    const source = sheetName && Array.isArray(item.sheets) ? item.sheets.find((sheet: any) => sheet.name === sheetName) : item;
    if (!source || !Array.isArray(source.rows) || source.rows.length < 1) return '';
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const rows = source.rows.slice(safeOffset, safeOffset + limit);
    const lines = rows.map((row: any[]) => (row || []).map((cell: any) => String(cell ?? '')).join('\t'));
    const pagination = { totalRows: source.rows.length, offset: safeOffset, returnedRows: rows.length, nextOffset: safeOffset + rows.length < source.rows.length ? safeOffset + rows.length : null };
    return `文件：${String(item.name || '附件')}（工作表 ${String(source.name || '默认')}；已从输入区读取）\n分页：${JSON.stringify(pagination)}\n${lines.join('\n')}`;
  }).filter(Boolean).join('\n\n');
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
    name: '查询与统计项目 BOM',
    desc: '项目 BOM 的全量统计和明细。最贵/最便宜/前N名用 view=rank、metric=unit_cost或extended_cost、order=desc或asc、limit=N；总额/均价/极值用 summary；模块/类别占比用 group。工具先全量计算后截取，勿逐页查明细口算。单价与数量×单价小计是不同口径。仅查看明细用 details。可直接给项目名称或代号，无需先列全部项目。',
    params: [
      { key: 'project_code', type: 'string', required: true, desc: '项目完整代号或名称，忽略大小写及分隔符；歧义需澄清' },
      { key: 'view', type: 'string', enum: ['details','summary','rank','group'], desc: 'summary汇总/极值/均价；rank排名；group分组；details明细' },
      { key: 'metric', type: 'string', enum: ['unit_cost','extended_cost'], desc: '排名/极值/均价口径：unit_cost单价（默认），extended_cost数量×单价' },
      { key: 'order', type: 'string', enum: ['desc','asc'], desc: 'desc最高优先（默认）；asc最低优先' },
      { key: 'group_by', type: 'string', enum: ['module','category','sub_category'], desc: 'group时按模块（默认）、大类、子类分组，按组总成本排序' },
      { key: 'module', type: 'string', desc: '只统计此模块，精确名称，可空' },
      { key: 'category', type: 'string', desc: '只统计此大类或子类，精确名称，可空' },
      { key: 'keyword', type: 'string', desc: '统计时筛选器件名称/型号包含此关键词，可空' },
    ],
    execute: async (a) => {
      const projects = await getProjects('', '', '');
      const p = projects.find((x: any) => !x.is_deleted && x.code === a.project_code);
      if (!p) return '未找到项目代号：' + a.project_code;
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      if (boms.length === 0) return '项目 ' + a.project_code + ' 暂无 BOM 器件';
      const costing = sumBomCostStrict(boms);
      const lines2 = boms.map((b: any) => { const value = bomExtendedCostStrict(b); return '[' + (b.module_name || '未分模块') + '] ' + (b.part_name || '') + ' ' + (b.part_model || '') + ' ×' + (b.quantity ?? 1) + ' @' + (bomExtendedCostStrict({ ...b, quantity: 1 }) == null ? '待补证据' : fmtMoney(b.part_cost ?? b.cost)) + ' =' + (value == null ? '待补证据' : fmtMoney(value)); });
      return '项目 ' + a.project_code + ' BOM 共 ' + boms.length + ' 项，合计 ' + (costing.missing.length ? '待补证据（' + costing.missing.length + ' 项）' : fmtMoney(costing.total)) + '\n' + lines2.join('\n');
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
      const costing = sumBomCostStrict(boms);
      if (costing.missing.length) return '项目 ' + a.project_code + ' BOM 总成本待补证据（' + costing.missing.length + ' 项未确认），暂不生成模块占比';
      const modMap = new Map<string, number>();
      for (const b of boms) {
        const m = b.module_name || '未分模块';
        modMap.set(m, (modMap.get(m) || 0) + (bomExtendedCostStrict(b) ?? 0));
      }
      const modLines = [...modMap.entries()].sort((x, y) => y[1] - x[1]).map(([m, c]) => m + '：' + fmtMoney(c) + '（' + Math.round((c / costing.total) * 100) + '%）');
      return '项目 ' + a.project_code + ' BOM 总成本 ' + fmtMoney(costing.total) + '\n' + modLines.join('\n');
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
        const costing = sumBomCostStrict(boms);
        if (costing.missing.length) continue;
        const total = costing.total;
        const sub = boms.filter((b: any) => String(b.sub_category || '').trim() === a.sub_category)
          .reduce((s: number, b: any) => s + (bomExtendedCostStrict(b) ?? 0), 0);
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
    execute: async (a, options) => {
      // ⚠️ 云端调用审批（2026-08-17，用户需求：本地 AI 要调云端时必须有提示+审批）——
      // preview 模式 → 挂入待确认队列（底部横幅「🔐 等待云端发送确认」），不发云端；确认后重发任务即放行（会话级记忆）
      const { getSearchApprovalEndpoint, PUBLIC_TREND_QUESTION, isNativeSearchEnabled, isDeepSeekNativeSearchAvailable } = await import('./trendService');
      const nativeReady = await isNativeSearchEnabled() && await isDeepSeekNativeSearchAvailable();
      if (!nativeReady) {
      const searchDiagnostic = await diagnoseSearchConfig();
      if (searchDiagnostic.available) {
        const ok = await requestCloudConfirm({ material: a.material_name, category: a.category || '', question: PUBLIC_TREND_QUESTION, requestUrl: await getSearchApprovalEndpoint(), requirementKind: 'insight', requirementTitle: '物料行情洞察 · ' + String(a.material_name || '') });
        if (!ok) {
          const fresh = getPendingConfirms().find(item => item.material === String(a.material_name || '').trim());
          if (fresh) {
            // ⚠️ 必须带上 APPROVAL_PENDING_MARKER：AiPanel 靠它判断"已入审批队列、还没发出去"，
            // 从而在用户批准后自动续跑（2026-09-21 用户："让我反复确认云端行情查询提交，这个是个大bug"）。
            const { APPROVAL_PENDING_MARKER } = await import('./cloudConfirm');
            return `⚠️ 云端行情查询需审批：已生成真实待审批请求「${fresh.material}」，请在右侧 AI 协作窗或全局待审批中心核对完整请求后批准本次发送。（批准后系统会自动继续本次查询，无需重新提问）${APPROVAL_PENDING_MARKER}`;
          }
          return '⚠️ 尚未生成待审批请求：当前网络模式为纯本地，或查询内容未通过本地安全检查；本次没有发送任何云端请求。';
        }
      } else if (searchDiagnostic.inactiveConfigured.length) {
        throw new Error('检测到已配置的搜索 API（' + searchDiagnostic.inactiveConfigured.join('、') + '）但未启用；请在 设置 -> AI 服务 中启用该供应商后重试。');
      } else if (searchDiagnostic.missingCredential.length) {
        throw new Error('搜索供应商（' + searchDiagnostic.missingCredential.join('、') + '）已启用，但本机 API Key 不可读；请在 设置 -> AI 服务 中重新录入 API Key 后重试。');
      }
      }
      const { agentSearchLoop } = await import('./trendService');
      const r = await agentSearchLoop(a.material_name, a.category || '', 'price-trend', undefined, options?.networkTrace);
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
    id: 'cloud_abstract_analysis',
    name: 'C2 脱敏抽象分析',
    desc: '仅将抽象领域、区间/等级特征和公开问题发送到受控云端。参数 domain 必填；features 必须是 JSON 对象，键只能是 size_band/resolution_band/refresh_band/panel_band/tier_band/module_band/supply_signal/demand_signal/availability_signal，值只能是 low/medium/high/unknown；每次都需要用户预览确认。',
    params: [
      { key: 'domain', type: 'string', required: true, desc: '不含编号和业务标识的抽象领域，如 显示器产品' },
      { key: 'features', type: 'string', required: true, desc: '抽象特征 JSON，如 {"size_band":"medium","refresh_band":"high"}' },
      { key: 'question', type: 'string', required: true, desc: '不含编号、金额和业务标识的公开问题' },
    ],
    execute: async (a, options) => {
      let features: unknown;
      try { features = JSON.parse(String(a.features || '{}')); } catch { return 'C2 参数错误：features 必须是 JSON 对象'; }
      const checked = sanitizeC2Payload({ domain: String(a.domain || ''), features: features as Record<string, any>, question: String(a.question || '') });
      if (!checked.ok) return 'C2 已拦截：' + checked.reason;
      try {
        const { runC2AbstractAnalysis } = await import('./trendService');
        return await runC2AbstractAnalysis(checked.payload, options?.networkTrace);
      } catch (e: any) {
        return String(e?.message || e);
      }
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
      const costState = sumBomCostStrict(boms);
      if (costState.missing.length) return `项目 ${a.project_code} 有 ${costState.missing.length} 行成本或数量证据缺口，模块价值成本待补证据`;
      const moduleCosts: Record<string, number> = {};
      boms.forEach((b: any) => { const m = b.module_name || '未归类'; moduleCosts[m] = (moduleCosts[m] || 0) + (bomExtendedCostStrict(b) ?? 0); });
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
      const costState = sumBomCostStrict(boms);
      if (costState.missing.length) out.push('BOM 总成本 待补证据（' + costState.missing.length + ' 行成本或数量未确认），共 ' + boms.length + ' 项');
      else {
        const total = costState.total;
        out.push('BOM 总成本 ' + fmtMoney(total) + '，共 ' + boms.length + ' 项');
        const modMap = new Map<string, number>();
        for (const b of boms) { const m = b.module_name || '未分模块'; modMap.set(m, (modMap.get(m) || 0) + (bomExtendedCostStrict(b) ?? 0)); }
        out.push('模块成本（降序）：' + [...modMap.entries()].sort((x, y) => y[1] - x[1]).map(([m, c]) => m + ' ' + fmtMoney(c) + (total ? '(' + Math.round((c / total) * 100) + '%)' : '')).join('、'));
      }
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
    desc: '读取一个 Excel（.xlsx/.xls）文件，按 sheet/offset/limit 返回表格文本（每行 tab 分隔，默认 8 行；汇总/核对/对比优先使用 analyze_spreadsheet 批量处理）。可用于读供应商报价表/用户原声表/BOM 表/竞品表等。file_path 指定任务附件名时不会弹框；不填才弹出文件选择框。',
    params: [
      { key: 'file_path', type: 'string', desc: '任务附件名/相对路径；指定后按该文件读取，不会忽略此参数' },
      { key: 'sheet', type: 'string', desc: '工作表名称，可空，默认第一个工作表' },
      { key: 'offset', type: 'number', minimum: 0, desc: '分页起点，从 0 开始' },
      { key: 'max_rows', type: 'number', minimum: 1, maximum: 200, desc: '最多返回行数，默认 8' },
    ],
    execute: async (a) => {
      const maxRows = Math.max(1, Math.min(Number(a.max_rows) || 8, 200));
      const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
      const file = await pickExcelFile();
      if (!file) return '用户取消选择文件';
      return await readExcelText(file, maxRows, offset, String(a.sheet || ''));
    },
  },
  {
    id: 'calc',
    name: '可靠计算',
    desc: '做算术计算（加减乘除/括号/百分比），返回结果。用于核验成本数字（BOM 合计、占比、单价×数量、加费率等），避免自己口算错。参数 expression 必填（如 (520*1+185*2)*1.05 或 45/300*100）。',
    params: [{ key: 'expression', type: 'string', required: true, desc: '算术表达式' }],
    execute: async (a) => {
      const expr = String(a.expression || '').trim();
      if (!expr) throw new Error('表达式为空或不合法（只支持数字和 + - * / ( ) . %）');
      try {
        return expr + ' = ' + evaluateExpression(expr);
      } catch (error: any) { throw new Error('表达式无法解析：' + String(error?.message || error)); }
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
      if (!content) throw new Error('待办内容不能为空');
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
      if (!text) throw new Error('目标内容不能为空');
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
        const competitorRows = boms.map((b: any) => ({ ...b, part_cost: b.estimated_cost }));
        const costing = sumBomCostStrict(competitorRows);
        if (costing.missing.length) { out.push('  模块：待补证据（' + costing.missing.length + ' 项未确认）'); continue; }
        const modMap = new Map<string, number>();
        for (const b of competitorRows) { const m = b.module_name || '未分模块'; modMap.set(m, (modMap.get(m) || 0) + (bomExtendedCostStrict(b) ?? 0)); }
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
      if (!p) throw new Error('未找到项目代号：' + a.project_code);
      const conclusion = String(a.conclusion || '').trim();
      if (!conclusion) throw new Error('结论内容不能为空');
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
      if (!p) throw new Error('未找到项目代号：' + a.project_code);
      const conclusion = String(a.conclusion || '').trim();
      if (!conclusion) throw new Error('结论内容不能为空');
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
      if (!p) throw new Error('未找到项目代号：' + a.project_code);
      let items: any[] = [];
      items = parseToolArray(a.items, 'items');
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
          ]).map((x: any) => ({ name: String(x.name || '').trim(), model: String(x.model || '').trim(), quantity: x.quantity === '' || x.quantity == null ? undefined : Number(x.quantity), cost: x.cost === '' || x.cost == null ? undefined : Number(x.cost), module: String(x.module || '').trim() })).filter((x: any) => x.name);
        }
      }
      if (items.length === 0) throw new Error('items 为空（可传 JSON 数组，或在输入区附加 BOM Excel 后重试）');
      const { classifyByModule } = await import('./moduleRules');
      const norm = items.map((it: any) => {
        const cls = classifyByModule(String(it.name || ''));
        return {
          name: String(it.name || '').trim(), model: String(it.model || '').trim(),
          quantity: it.quantity === '' || it.quantity == null ? undefined : Number(it.quantity), cost: it.cost === '' || it.cost == null ? undefined : Number(it.cost),
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
      rows = parseToolArray(a.rows, 'rows');
      if (!Array.isArray(rows) || rows.length === 0) {
        const att = attachmentRows('supplier');
        if (att) {
          rows = mapColumns(att.rows, [
            { names: ['名称', '器件名称', '器件名', '物料', 'name'], out: 'name' },
            { names: ['型号', 'model'], out: 'model' },
            { names: ['供应商', '供应商名称', 'supplier'], out: 'supplier' },
            { names: ['价格', '单价', '报价', 'price'], out: 'price' },
            { names: ['份额', '占比', 'share'], out: 'share' },
          ]).map((x: any) => ({ name: String(x.name || '').trim(), model: String(x.model || '').trim(), supplier: String(x.supplier || '').trim(), price: x.price === '' || x.price == null ? undefined : Number(x.price), share: x.share === '' || x.share == null ? undefined : Number(x.share) })).filter((x: any) => x.name && x.supplier);
        }
      }
      if (rows.length === 0) throw new Error('rows 为空（可传 JSON 数组，或在输入区附加供应商报价 Excel 后重试）');
      const { importSupplierQuotes } = await import('./db');
      const st = await importSupplierQuotes(rows);
      try { window.dispatchEvent(new CustomEvent('costhub-supplier-updated')); } catch { }
      return '供应商报价入库：共 ' + st.total + ' 条，匹配器件 ' + st.matched + ' 个、写入 ' + st.added + ' 条报价' + (st.invalid ? '，跳过无效数据 ' + st.invalid + ' 条' : '') + (st.unmatched > 0 ? '，未匹配器件 ' + st.unmatched + ' 个：' + st.unmatchedNames.slice(0, 10).join('、') + '（需先入器件库）' : '') + '。';
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
      if (!c) throw new Error('未找到竞品：' + a.brand + ' ' + a.model + '（可在竞品管理页先录入）');
      let rows: any[] = [];
      rows = parseToolArray(a.rows, 'rows');
      if (!Array.isArray(rows) || rows.length === 0) {
        const att = attachmentRows('competitor');
        if (att) {
          rows = mapColumns(att.rows, [
            { names: ['名称', '器件名称', '物料', 'name'], out: 'name' },
            { names: ['型号', 'model'], out: 'model' },
            { names: ['成本', '估算成本', '价格', 'cost'], out: 'cost' },
            { names: ['数量', 'quantity', 'qty'], out: 'quantity' },
            { names: ['模块', 'module'], out: 'module' },
          ]).map((x: any) => ({ name: String(x.name || '').trim(), model: String(x.model || '').trim(), cost: x.cost === '' || x.cost == null ? undefined : Number(x.cost), quantity: x.quantity === '' || x.quantity == null ? undefined : Number(x.quantity), module: String(x.module || '').trim() })).filter((x: any) => x.name);
        }
      }
      if (rows.length === 0) throw new Error('rows 为空（可传 JSON 数组，或在输入区附加竞品 Excel 后重试）');
      const { classifyByModule } = await import('./moduleRules');
      const norm = rows.map((it: any) => {
        const cls = classifyByModule(String(it.name || ''));
        return { name: String(it.name || '').trim(), model: String(it.model || '').trim(), cost: it.cost === '' || it.cost == null ? undefined : Number(it.cost), quantity: it.quantity === '' || it.quantity == null ? undefined : Number(it.quantity), module: String(it.module || '').trim() || cls?.module || '' };
      }).filter((x: any) => x.name);
      const { importCompetitorBom } = await import('./db');
      const st = await importCompetitorBom(c.id, norm);
      try { window.dispatchEvent(new CustomEvent('costhub-competitor-updated')); } catch { }
      return '竞品 ' + c.brand + ' ' + c.model + ' BOM 入库完成：共 ' + st.total + ' 项，写入 ' + st.added + ' 项' + (st.skipped ? '，跳过无效数据 ' + st.skipped + ' 项' : '') + '（竞品管理页可见）。';
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
      let contents = resolveVoiceItems(a.items);
      if (contents.length === 0) {
        const att = attachmentRows('voice');
        if (att) {
          contents = detectVoiceSheet([{ name: att.name, rows: att.rows }]).contents;
        }
      }
      if (contents.length === 0) throw new Error('没有有效原声内容（附件也未识别到正文列）');
      if (!String(a.product || '').trim()) throw new Error('无法可靠识别产品归属，请明确产品名后再导入');
      const { importVoiceItems } = await import('./db');
      const st = await importVoiceItems(String(a.product || '').trim(), contents);
      try { window.dispatchEvent(new CustomEvent('costhub-voice-updated')); } catch { }
      return '原声导入产品「' + a.product + '」：共 ' + st.total + ' 条，新增 ' + st.added + ' 条、跳过重复 ' + st.dup + ' 条（用户原声分析页可见）。';
    },
  },
  {
    id: 'generate_report',
    name: '生成报告（HTML/PPTX）',
    desc: '把分析结论生成一份报告（HTML 网页报告 或 PPTX 演示），保存到 AI 工作文件夹。参数 title 必填（报告标题），slides 必填（JSON 数组 [{heading:小节标题, points:[要点数组]}]——把结论组织成 3-6 节，每节 2-5 个要点），format 可选（html/pptx，默认 html），subtitle 可选。用于"生成一份XX报告/演示"。',
    params: [
      { key: 'title', type: 'string', required: true, desc: '报告标题' },
      { key: 'slides', type: 'string', required: true, desc: 'JSON 数组 [{heading,points}]' },
      { key: 'format', type: 'string', desc: 'html/pptx，默认 html' },
      { key: 'subtitle', type: 'string', desc: '副标题，可空' },
    ],
    execute: async (a) => {
      const title = String(a.title || '').trim();
      if (!title) throw new Error('报告标题不能为空');
      let slides: any[];
      slides = parseToolArray(a.slides, 'slides');
      if (!Array.isArray(slides) || slides.length === 0) throw new Error('slides 为空（至少一节）');
      const format = String(a.format || '').toLowerCase() === 'pptx' ? 'pptx' : 'html';
      const subtitle = String(a.subtitle || '');
      const { buildHtmlReportBase64, buildPptxBase64 } = await import('./aiReport');
      const b64 = format === 'html' ? buildHtmlReportBase64(title, slides, subtitle) : await buildPptxBase64(title, slides, subtitle);
      const safe = title.replace(/[\\/:*?"<>|]/g, '_');
      const name = '报告-' + safe + '-' + new Date().toISOString().slice(0, 10) + '.' + format;
      const { invoke } = await import('@tauri-apps/api/core');
      const configuredDir = (await getSetting('ai_work_folder', '')).trim();
      const targetDir = configuredDir || await invoke<string>('get_default_ai_work_folder').catch(() => '');
      const savedName = await invoke<string>('save_export_file', { fileName: name, base64Data: b64, targetDir: targetDir || undefined });
      return '✅ 已生成报告：' + savedName + '（' + format + ' 格式，文件位置：' + targetDir + '）';
    },
  },
  {
    id: 'write_excel',
    name: '生成 Excel 表格',
    desc: '把结构化数据生成 Excel 文件（.xlsx）保存到 AI 工作文件夹。参数 file_name 必填（文件名，可含或不含 .xlsx），sheets 必填（JSON 数组 [{name:工作表名, rows:[[单元格值...]...]}]，第一行通常为表头）。用于"把分析结果导出成 Excel 表格/清单"。',
    params: [
      { key: 'file_name', type: 'string', required: true, desc: '文件名' },
      { key: 'sheets', type: 'string', required: true, desc: 'JSON 数组 [{name,rows}]' },
    ],
    execute: async (a) => {
      let sheets: any[];
      sheets = parseToolArray(a.sheets, 'sheets');
      if (!sheets.length) throw new Error('sheets 为空');
      const { buildWorkbookBase64 } = await import('./aiReport');
      const b64 = buildWorkbookBase64(sheets);
      const raw = String(a.file_name || '').trim().replace(/[\\/:*?"<>|]/g, '_') || ('导出-' + new Date().toISOString().slice(0, 10));
      // write_excel always emits XLSX; avoid confusing names such as source.csv.xlsx
      // when a small model echoes the attached source filename.
      const withoutSourceExtension = raw.replace(/\.(?:csv|xls)$/i, '');
      const name = withoutSourceExtension.toLowerCase().endsWith('.xlsx') ? withoutSourceExtension : withoutSourceExtension + '.xlsx';
      const { invoke } = await import('@tauri-apps/api/core');
      const configuredDir = (await getSetting('ai_work_folder', '')).trim();
      const targetDir = configuredDir || await invoke<string>('get_default_ai_work_folder').catch(() => '');
      const savedName = await invoke<string>('save_export_file', { fileName: name, base64Data: b64, targetDir: targetDir || undefined });
      const rowsTotal = sheets.reduce((s: number, sh: any) => s + ((sh.rows || []).length - 1), 0);
      return '✅ 已生成 Excel：' + savedName + '（' + sheets.length + ' 个工作表，' + Math.max(0, rowsTotal) + ' 行数据，文件位置：' + targetDir + '）';
    },
  },
  {
    id: 'ask_user',
    name: '询问用户确认',
    desc: '遇到不确定的关键信息（如用户没说哪个物料/哪个项目/选哪个方案）时调用，向用户提问并给选项，等用户选择后再继续——不要瞎猜。参数 question 必填（问题），options 必填（JSON 数组字符串）——必须给出具体可选项（如项目列表/物料列表/方案名），禁止空 options；问项目选择时可先调 query_projects 拿项目列表作为选项。前端渲染选项按钮供用户点击。',
    params: [
      { key: 'question', type: 'string', required: true, desc: '要问用户的问题' },
      { key: 'options', type: 'string', required: true, desc: 'JSON 数组字符串，选项列表——必须给具体可选项，禁止空' },
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
    desc: '把某项目 BOM 的全部物料用 AI 批量规范成统一标准名（品类+规格+型号，一套通用规则套所有物料；笼统物料如"支架/底座"只归类不编造规格）。结果写入器件库的 canonical 影子字段（原名/模块库不动），匹配/统计/检索将更准。注意：导入新器件时会自动规范化（隐线），本工具仅用于存量项目一次性补录；这是写操作，必须在用户明确指定要规范哪个项目（参数 project_code）后才能调用；用户没指定项目时先调 ask_user 让用户选择，不要擅自选一个项目。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号' }],
    execute: async (a) => {
      const { getProjects } = await import('./db');
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === a.project_code);
      if (!p) throw new Error('未找到项目代号：' + a.project_code);
      // 2026-08-27 预检：模型未就绪快速报原因，不空跑（Ollama 未运行 / 模型未下载）
      const pre = await detectOllama();
      if (!pre.connected) return '规范化需要本地模型，但 ' + (pre.reason === 'model-missing' ? '模型未下载（请先在 Ollama 拉取模型，或到设置→连接设置选择已下载的模型）' : 'Ollama 未运行（请先启动 Ollama，设置 → 连接设置 → 检测连接）') + '。本次未修改任何数据。';
      const { canonicalizeProject } = await import('./canonicalize');
      const st = await canonicalizeProject(p.id);
      let msg = '项目 ' + a.project_code + ' 物料规范化完成：共 ' + st.total + ' 条，已规范 ' + st.done + ' 条（其中笼统保留 ' + st.kept + ' 条）、失败 ' + st.failed + ' 条。结果写入器件库标准名（原名/模块库不变）。';
      if (st.errors && st.errors.length) msg += '\n失败原因：' + st.errors.join('；') + '（可检查 Ollama 后重试，已规范的物料不会重复处理）。';
      return msg;
    },
  },
  {
    id: 'query_tender_analysis',
    name: '分析招标报价矩阵',
    desc: '读取指定项目本地招标工作台的当前轮次报价矩阵，返回供应商报价、可比最低、待确认数量和理论组合底价。名称+规格键一致才计入可比；参考价/待确认价不计入。仅查询，不改 BOM、不向外网发送数据。参数 project_code 必填。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号，如 M270' }],
    execute: async (a) => {
      const project = (await getProjects('', '', '')).find((item: any) => !item.is_deleted && item.code === a.project_code);
      if (!project) return '未找到项目代号：' + a.project_code;
      const [overview, matrix] = await Promise.all([getTenderOverview(project.id), getTenderMatrix(project.id)]);
      if (!matrix.length) return '项目 ' + a.project_code + ' 尚无招标报价批次，请先在项目详情→招标工作台导入供应商报价。';
      const summary = overview.summary;
      const lines = matrix.slice().sort((x, y) => y.opportunity - x.opportunity).slice(0, 80).map(row => {
        const offers = Object.values(row.offers).map(offer => offer.supplierName + ' ' + fmtMoney(offer.lineTotal) + '[' + (offer.relationType || 'unmatched') + ']').join('；');
        return '[' + (row.moduleName || '未归类') + '] ' + row.materialName + ' ' + (row.model || '') + '｜' + offers + '｜最低 ' + (row.comparableLow ? row.comparableLow.supplierName + ' ' + fmtMoney(row.comparableLow.lineTotal) : '待确认') + '｜机会 ' + fmtMoney(row.opportunity);
      });
      return '项目 ' + a.project_code + ' 招标分析（当前轮次）\n供应商 ' + summary.supplierCount + ' 家，明细 ' + summary.lineCount + ' 行，可比覆盖率 ' + Math.round(summary.comparableCoverage * 100) + '%，理论组合底价 ' + fmtMoney(summary.theoreticalLow) + '（谈判锚点，不是实际采购篮子），最佳整机报价 ' + (summary.bestFullQuote ? fmtMoney(summary.bestFullQuote) : '未填写') + '，可谈机会 ' + fmtMoney(summary.opportunity) + '\n' + lines.join('\n');
    },
  },
  {
    id: 'visualize_cost_analysis',
    name: '生成成本分析图表',
    desc: '基于数据库真实 BOM 生成成本图表。project_codes 必填（项目代号，多个用逗号分隔）；dimension 可选 module/main_category/sub_category；chart_type 可选 auto/pie/bar/pareto。单项目构成默认饼图，多项目对比默认柱状图，找成本大头用 pareto。只读，不接受模型自带数据。',
    params: [
      { key: 'project_codes', type: 'string', required: true, desc: '项目代号，多个用逗号分隔，如 M270,M320' },
      { key: 'dimension', type: 'string', desc: 'module/main_category/sub_category，默认 module' },
      { key: 'chart_type', type: 'string', desc: 'auto/pie/bar/pareto，默认 auto' },
    ],
    execute: async (a) => {
      const codes = String(a.project_codes || '').split(/[,，]/).map((x: string) => x.trim()).filter(Boolean).slice(0, 8);
      const dimension = ['module', 'main_category', 'sub_category'].includes(String(a.dimension)) ? String(a.dimension) : 'module';
      const projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted && codes.includes(String(p.code || '')));
      if (!projects.length) return '未找到项目：' + codes.join('、');
      const out: string[] = [];
      for (const p of projects) {
        const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
        const groups = new Map<string, number>();
        for (const b of boms) {
          const key = dimension === 'module' ? (b.module_name || '未分模块') : (b[dimension] || '未分类');
          const value = bomExtendedCostStrict(b);
          if (value === null) continue;
          groups.set(key, (groups.get(key) || 0) + value);
        }
        const rows = [...groups.entries()].sort((x, y) => y[1] - x[1]);
        const missing = sumBomCostStrict(boms).missing.length;
        out.push(p.code + '｜' + (missing ? '待补证据' : rows.map(([k, v]) => k + ' ¥' + v.toFixed(2)).join('；')));
      }
      return '图表数据已从本地 BOM 按 ' + dimension + ' 聚合（前端将直接渲染，不采用模型生成数字）：\n' + out.join('\n');
    },
  },
  {
    id: 'estimate_similar_projects',
    name: '类似项目预估',
    desc: '基于本地历史项目规格和 BOM 成本，找最多 3 个可比项目并给出成本区间、匹配字段和数据缺口。参数 project_code 必填；项目必须能唯一解析。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '目标项目代号或名称' }, { key: 'limit', type: 'number', desc: '最多返回 3 个，默认 3' }],
    execute: async () => '该工具由结构化 Skill 适配器执行。',
  },
  {
    id: 'rank_quote_negotiations',
    name: '报价议价排序',
    desc: '读取项目当前报价轮次，只按 exact/equivalent 可比关系计算可争取金额，并按议价空间排序；reference/unmatched 不计入理论底价。参数 project_code 必填。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号或名称' }, { key: 'limit', type: 'number', desc: '最多返回行数，默认 20' }],
    execute: async () => '该工具由结构化 Skill 适配器执行。',
  },
  {
    id: 'explain_quote_change',
    name: '报价变化归因',
    desc: '比较项目最近两个报价批次，把总价变化拆分为数量/单价变化、新增和删除物料，并提示规格基线独立核对。参数 project_code 必填。',
    params: [{ key: 'project_code', type: 'string', required: true, desc: '项目代号或名称' }],
    execute: async () => '该工具由结构化 Skill 适配器执行。',
  },
];

export function listTools(): AiTool[] {
  return tools.map(tool => withNativeSchema({ ...tool, manifest: resolveToolManifest(tool.id) }));
}

export function getToolManifest(id: string): AiToolManifest | undefined { return resolveToolManifest(id); }

export function getTool(id: string): AiTool | undefined {
  const tool = tools.find(t => t.id === id);
  return tool ? withNativeSchema({ ...tool, manifest: resolveToolManifest(tool.id) }) : undefined;
}

/** 参数校验：返回错误信息或 null */
export function validateArgs(tool: AiTool, args: any): string | null {
  const a = args || {};
  for (const p of tool.params) {
    const v = a[p.key];
    if (p.required && (v === undefined || v === null || v === '')) return '缺少必填参数 ' + p.key + '（' + p.desc + '）';
    if (v !== undefined && v !== null && v !== '') {
      if (p.type === 'number' && isNaN(Number(v))) return '参数 ' + p.key + ' 应为数字';
      if (p.type === 'string' && typeof v !== 'string' && typeof v !== 'number') return '参数 ' + p.key + ' 应为文本';
      if (p.type === 'boolean' && typeof v !== 'boolean') return '参数 ' + p.key + ' 应为布尔值';
      if (p.type === 'array' && !Array.isArray(v)) return '参数 ' + p.key + ' 应为数组';
      if (p.type === 'object' && (typeof v !== 'object' || Array.isArray(v))) return '参数 ' + p.key + ' 应为对象';
      if (p.enum?.length && !p.enum.includes(String(v))) return '参数 ' + p.key + ' 必须是：' + p.enum.join('、');
      if (p.type === 'number' && p.minimum !== undefined && Number(v) < p.minimum) return '参数 ' + p.key + ' 不能小于 ' + p.minimum;
      if (p.type === 'number' && p.maximum !== undefined && Number(v) > p.maximum) return '参数 ' + p.key + ' 不能大于 ' + p.maximum;
      if (p.type === 'array' && p.items && v.some((item: unknown) => typeof item !== p.items)) return '参数 ' + p.key + ' 的元素类型应为 ' + p.items;
    }
  }
  return null;
}

export async function executeStructuredTool(call: ToolCall, context: RunContext = {}): Promise<AiToolResult<unknown>> {
  return executeStructuredToolAdapter(call, context);
}

/** 把 write_excel / generate_report 的文本回执转成可渲染的文件卡片元数据。 */
function generatedFileToolResult(id: string, text: string): AiToolResult<unknown> | undefined {
  if (id !== 'write_excel' && id !== 'generate_report') return undefined;
  const nameMatch = /已生成(?:报告| excel)：([^（()]+)/i.exec(text);
  const dirMatch = /文件位置：(.+?)(?:）|$)/m.exec(text);
  if (!nameMatch || !dirMatch) return undefined;
  const name = nameMatch[1].trim();
  const dir = dirMatch[1].trim().replace(/[\\/]+$/, '');
  const separator = dir.includes('\\') ? '\\' : '/';
  const type = (name.split('.').pop() || (id === 'write_excel' ? 'xlsx' : 'html')).toLowerCase();
  return {
    ok: true,
    summary: text,
    data: { file: { name, type, dir, path: `${dir}${separator}${name}` } },
    evidence: [],
    warnings: [],
    freshness: '',
  };
}

/** 执行单个工具：风险门禁 + 参数校验 + 执行 + 结果截断 */
export async function executeTool(id: string, args: any, options: ExecuteToolOptions = {}): Promise<{ ok: boolean; text: string; result?: AiToolResult<unknown>; requiresConfirmation?: boolean }> {
  args = prepareBusinessArgs(id, args);
  const tool = getTool(id);
  if (!tool) return { ok: false, text: '未知工具：' + id };
  const manifest = resolveToolManifest(id);
  if (!manifest) return { ok: false, text: '工具未声明风险，已拒绝执行：' + id };
  if (manifest.kind === 'write' && manifest.requiresConfirmation && !options.confirmed) {
    return { ok: false, text: '写工具「' + tool.name + '」必须先取得用户确认，未执行任何写入。', requiresConfirmation: true };
  }
  const err = validateArgs(tool, args);
  if (err) return { ok: false, text: '参数错误：' + err };
  try {
    validateNestedArgs(tool, args);
    if (STRUCTURED_TOOL_IDS.some(toolId => toolId === id)) {
      const structured = await executeStructuredTool({ name: id, args: args || {} }, {});
      return { ok: structured.ok, text: structured.summary, result: structured };
    }
    const text = await tool.execute(args || {}, options);
    // 2026-08-18 单路深挖：结果放宽到 4000 字（thinkEngine 有 compressMessages 兜底上下文），关键数据尽量完整给模型
    return { ok: true, text, result: generatedFileToolResult(id, text) };
  } catch (e: any) {
    return { ok: false, text: '工具执行失败：' + String(e?.message || e).slice(0, 200) };
  }
}
