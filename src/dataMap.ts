// 数据库地图（v2.3.19，2026-08-19 用户：AI 访问数据库能否清晰知道什么内容在哪里？——注入数据全景，精准定位不盲试）
// 设计：系统提示注入「数据库地图」（表·数量·访问工具），模型先看地图再选工具，不用猜/全量扫
import { getDb } from './db';

async function count(table: string, where = ''): Promise<number> {
  try {
    const d = await getDb();
    const r = await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM ' + table + (where ? ' WHERE ' + where : ''));
    return r[0]?.c || 0;
  } catch { return -1; }
}

export interface DataStats { projects: number; parts: number; suppliers: number; voice: number; trends: number; selling: number; competitors: number; targets: number; worklogs: number; memory: number; }

export async function collectDataStats(): Promise<DataStats> {
  const [projects, parts, suppliers, voice, trends, selling, competitors, targets, worklogs, memory] = await Promise.all([
    count('projects', 'COALESCE(is_deleted,0)=0'), count('parts'), count('part_suppliers', 'is_active=1'),
    count('voice_item'), count('trend_items'), count('selling_points'), count('competitors'),
    count('project_targets'), count('work_logs'), count('ai_memory'),
  ]);
  return { projects, parts, suppliers, voice, trends, selling, competitors, targets, worklogs, memory };
}

const L = (n: number) => (n < 0 ? '?' : String(n));

/** 纯函数：统计 → 数据库地图文本 */
export function buildDataMapText(s: DataStats): string {
  return '【数据库地图】你的成本数据库（表·数量·访问工具——先看这里再选工具，不要盲目调用）：\n' +
    '· 项目 projects：' + L(s.projects) + ' 个（代号/名称/档位/状态/品类）→ query_projects 列表、query_project_bom 明细、query_project_cost 成本结构、query_project_health 体检、query_project_module_value 卖点价值\n' +
    '· 项目 BOM project_boms：挂在项目下（模块/器件/数量/成本快照列）→ query_project_bom\n' +
    '· 器件 parts：' + L(s.parts) + ' 个（名称/型号/大类/成本）→ query_part_suppliers、query_supplier_trend、compare_subcategory_cost\n' +
    '· 供应商报价 part_suppliers：' + L(s.suppliers) + ' 条（器件/供应商/价格/份额）→ query_part_suppliers、import_supplier_quote\n' +
    '· 用户原声 voice_item：' + L(s.voice) + ' 条（按产品）→ query_voice_dims 维度、import_voice_items 导入\n' +
    '· 物料洞察 trend_items：' + L(s.trends) + ' 个（免分解/分解/自动）→ query_material_insight 历史、insight_material_trend 最新行情\n' +
    '· 卖点 selling_points：' + L(s.selling) + ' 个（挂项目+声量+模块）→ query_project_module_value、save_selling_analysis\n' +
    '· 竞品 competitors：' + L(s.competitors) + ' 个（品牌/型号/售价/BOM估算）→ query_competitor_bom、import_competitor_bom\n' +
    '· 目标成本 project_targets：' + L(s.targets) + ' 条 → query_target_status\n' +
    '· 工作手账 work_logs：' + L(s.worklogs) + ' 条（含待办）→ query_worklog、query_todos、create_todo\n' +
    '· 长期记忆 ai_memory：' + L(s.memory) + ' 条（跨会话业务背景）\n' +
    '· 成本快照/报价情报/AI建议 → query_cost_snapshots、query_price_insights、query_advisor_insights；数据就绪度总览 → query_data_readiness';
}

/** 完整地图（扫库统计 + 格式化），供 AiPanel 注入系统提示 */
export async function buildDataMap(): Promise<string> {
  return buildDataMapText(await collectDataStats());
}
