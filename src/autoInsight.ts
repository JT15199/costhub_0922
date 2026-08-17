// 关键物料自动洞察（v2.3.19，2026-08-16）：根据项目 BOM 自动识别关键物料，节流式自动洞察行情
// 设计原则：识别免费（纯本地规则）、触发吝啬（四道闸门：变化/频率/指纹/预算）、呈现主动（驾驶舱卡片）
// 节流默认：30 天洞察周期（settings ai_insight_interval_days 可调）+ 7 天复用历史结论 + 每日云端预算共用
// 落库：复用快捷洞察链路（trend_items source_type='auto' + trend_snapshots），Decomposition 快捷洞察区可见
import { getProjects, getProjectBOMs, getSetting } from './db';
import { getDb } from './db/core';
import { materialKey } from './db/advisor';

// ==================== ① 关键物料识别（纯本地规则，按子类聚合） ====================
// 2026-08-16（用户要求）：洞察对象从"具体物料"改为"子类"——子类一般是物料的通用名称（如"液晶面板"），
// 行情洞察对通用名称更有意义，且避免具体型号外发。sub_category 为空的行回退用物料名（part_name）。

export interface KeyMaterial {
  projectId: number;
  projectCode: string;
  name: string;        // 子类名（通用名称；sub_category 为空时回退物料名）
  models: string[];    // 该子类涉及的具体型号（UI 展示用，最多 5 个）
  category: string;    // main_category
  subtotal: number;    // 子类小计（Σ 单价×数量，原始值）
  ratio: number;       // 项目内成本占比 0-1
}

/**
 * 帕累托识别（按子类分组）：每个项目内先把 BOM 行按 sub_category（为空回退 part_name）分组，
 * 组小计降序，累计占比 ≥80% 或 top5（先到者，至少 2 个才触发帕累托截断）
 * 数量为 0 / 无单价 / 总成本为 0 的项目跳过（占位物料不算关键料）
 */
export function identifyKeyMaterials(
  projects: { id: number; code?: string }[],
  bomsByProject: Record<number, any[]>,
  opts?: { maxPerProject?: number; cumRatio?: number }
): KeyMaterial[] {
  const maxPerProject = opts?.maxPerProject ?? 5;
  const cumRatio = opts?.cumRatio ?? 0.8;
  const out: KeyMaterial[] = [];
  for (const p of projects) {
    const boms = (bomsByProject[p.id] || []).filter(
      (b: any) => !b.is_deleted && b.part_id && (b.quantity ?? 0) > 0
    );
    const cost = (b: any) => (b.part_cost ?? b.cost ?? 0) * (b.quantity ?? 1);
    // 按子类分组
    const groups = new Map<string, { rows: any[]; subtotal: number; category: string }>();
    for (const b of boms) {
      const gname = String(b.sub_category || '').trim() || String(b.part_name || '').trim();
      if (!gname) continue;
      let g = groups.get(gname);
      if (!g) { g = { rows: [], subtotal: 0, category: b.main_category || '未分类' }; groups.set(gname, g); }
      g.rows.push(b);
      g.subtotal += cost(b);
    }
    const total = [...groups.values()].reduce((s, g) => s + g.subtotal, 0);
    if (total <= 0) continue;
    const sorted = [...groups.entries()].sort((a, b) => b[1].subtotal - a[1].subtotal);
    const picked: [string, { rows: any[]; subtotal: number; category: string }][] = [];
    let acc = 0;
    for (const entry of sorted) {
      if (picked.length >= maxPerProject) break;
      picked.push(entry);
      acc += entry[1].subtotal;
      if (picked.length >= 2 && acc / total >= cumRatio) break;
    }
    for (const [gname, g] of picked) {
      out.push({
        projectId: p.id,
        projectCode: p.code || '',
        name: gname,
        models: [...new Set(g.rows.map(r => String(r.part_model || '').trim()).filter(Boolean))].slice(0, 5),
        category: g.category,
        subtotal: g.subtotal,
        ratio: total > 0 ? g.subtotal / total : 0,
      });
    }
  }
  return out;
}

// ==================== ② 跨项目聚合（同一物料只洞察一次） ====================

export interface MaterialAggregate {
  key: string;          // materialKey(name, category)
  name: string;         // 子类名（通用名称）
  models: string[];     // 涉及的具体型号（跨项目合并去重）
  category: string;
  projects: { projectId: number; projectCode: string; ratio: number; subtotal: number }[];
  totalSubtotal: number;
}

export function aggregateMaterials(materials: KeyMaterial[]): MaterialAggregate[] {
  const map = new Map<string, MaterialAggregate>();
  for (const m of materials) {
    const key = materialKey(m.name, m.category);
    let a = map.get(key);
    if (!a) {
      a = { key, name: m.name, models: [], category: m.category, projects: [], totalSubtotal: 0 };
      map.set(key, a);
    }
    for (const md of m.models || []) { if (!a.models.includes(md)) a.models.push(md); }
    if (a.models.length > 5) a.models = a.models.slice(0, 5);
    if (!a.projects.some(x => x.projectId === m.projectId)) {
      a.projects.push({ projectId: m.projectId, projectCode: m.projectCode, ratio: m.ratio, subtotal: m.subtotal });
    }
    a.totalSubtotal += m.subtotal;
  }
  return [...map.values()].sort((a, b) => b.totalSubtotal - a.totalSubtotal);
}

// ==================== ③ 闸门（频率/复用/预算） ====================

export type InsightAction = 'insight' | 'reuse' | 'wait';

export interface LastInsightInfo {
  time?: string;
  direction?: string;
  confidence?: string;
  summary?: string;
  suggested_action?: string;
  magnitudeMin?: number | null;
  magnitudeMax?: number | null;
}

export interface InsightPlanItem {
  aggregate: MaterialAggregate;
  action: InsightAction;
  reason: string;        // 中文原因（UI 直接展示）
  lastAt?: string;       // 上次洞察时间
  nextAt?: string;       // wait 时下次可洞察日期
  lastDirection?: string;
  lastConfidence?: string;
  lastSummary?: string;
  lastAction?: string;
  lastMagnitudeMin?: number | null;
  lastMagnitudeMax?: number | null;
}

/** 解析洞察时间（兼容本地格式 "2026-08-14 10:00" 与 ISO） */
export function parseInsightTime(t?: string): Date | null {
  if (!t) return null;
  const d = new Date(String(t).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 闸门判断：
 * - 无记录 → insight（首次识别，立即洞察）
 * - 距上次 < reuseDays(7) → reuse（复用历史结论）
 * - 距上次 < intervalDays(30) → wait（显示下次时间）
 * - 超过 intervalDays → insight
 * - 预算不足 → wait（明日自动继续）
 */
export function buildInsightPlan(
  aggregates: MaterialAggregate[],
  lastInsights: Record<string, LastInsightInfo>,
  opts?: { intervalDays?: number; reuseDays?: number; now?: Date; budgetLeft?: number }
): InsightPlanItem[] {
  const intervalDays = opts?.intervalDays ?? 30;
  const reuseDays = opts?.reuseDays ?? 7;
  const now = opts?.now ?? new Date();
  const budgetLeft = opts?.budgetLeft ?? Infinity;
  return aggregates.map(a => {
    const last = lastInsights[a.key];
    const plan: InsightPlanItem = {
      aggregate: a,
      action: "insight",
      reason: "首次识别为关键物料，待自动洞察",
      lastAt: last?.time,
      lastDirection: last?.direction,
      lastConfidence: last?.confidence,
      lastSummary: last?.summary,
      lastAction: last?.suggested_action,
      lastMagnitudeMin: last?.magnitudeMin,
      lastMagnitudeMax: last?.magnitudeMax,
    };
    if (budgetLeft <= 0) {
      plan.action = "wait";
      plan.reason = "今日云端调用已达预算上限，明日自动继续（可手动洞察）";
      return plan;
    }
    const lastDate = parseInsightTime(last?.time);
    if (lastDate) {
      const days = Math.floor((now.getTime() - lastDate.getTime()) / 86400000);
      if (days < reuseDays) {
        plan.action = "reuse";
        plan.reason = days + " 天前已洞察，结论仍有效（" + reuseDays + " 天内复用）";
        return plan;
      }
      if (days < intervalDays) {
        plan.action = "wait";
        plan.reason = (intervalDays - days) + " 天后到洞察周期";
        const next = new Date(lastDate.getTime() + intervalDays * 86400000);
        plan.nextAt = next.getFullYear() + "-" + String(next.getMonth() + 1).padStart(2, "0") + "-" + String(next.getDate()).padStart(2, "0");
        return plan;
      }
      plan.action = "insight";
      plan.reason = "已 " + days + " 天未洞察（周期 " + intervalDays + " 天），触发自动洞察";
      return plan;
    }
    return plan;
  });
}

// ==================== ④ 上次洞察查询（引擎与 UI 共用） ====================

/** 查全部快捷/自动洞察的最新批次（按 materialKey 索引；无记录不产生条目） */
export async function queryLastInsights(): Promise<Record<string, LastInsightInfo>> {
  const lastInsights: Record<string, LastInsightInfo> = {};
  try {
    const d = await getDb();
    const items = await d.select<any[]>("SELECT * FROM trend_items WHERE source_type IN ('quick','auto')");
    for (const it of items) {
      const key = materialKey(it.query_category || "", it.category_type || "");
      const snap = await d.select<any[]>(
        "SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY id DESC LIMIT 1", [it.id]
      ).then(r => r[0] || null);
      const time = snap?.query_time || it.last_queried_at || "";
      if (!lastInsights[key] || time > (lastInsights[key].time || "")) {
        lastInsights[key] = {
          time,
          direction: snap?.direction || snap?.trend_direction || "",
          confidence: snap?.confidence_level || snap?.confidence || "",
          summary: snap?.summary || "",
          suggested_action: snap?.suggested_action || "",
          magnitudeMin: snap?.magnitude_min ?? null,
          magnitudeMax: snap?.magnitude_max ?? null,
        };
      }
    }
  } catch { /* 查询失败返回空索引 */ }
  return lastInsights;
}

// ==================== ⑤ 机会点/风险点建议（纯函数：方向+幅度+占比 → 具体行动） ====================
// 2026-08-16（用户反馈）：洞察不能只给泛泛结论，要落到"这个机会点/风险点 + 怎么行动"
// 规则：行情下行+置信度达标 → 机会（降价谈判窗口）；行情上行 → 风险（锁价/备货）；幅度大/占比高 → 强化

export interface MaterialSuggestion {
  level: 'opportunity' | 'risk' | 'info';
  title: string;   // 一句话定性
  action: string;  // 具体行动建议
}

export function buildMaterialSuggestion(aggregate: MaterialAggregate, last?: LastInsightInfo): MaterialSuggestion | null {
  if (!last?.direction) return null;
  const dir = String(last.direction);
  const conf = String(last.confidence || '');
  const magMax = Number(last.magnitudeMax ?? last.magnitudeMin ?? 0) || 0;
  const magMin = Number(last.magnitudeMin ?? 0) || 0;
  const top = aggregate.projects[0];
  const ratioPct = top ? Math.round(top.ratio * 100) : 0;
  const projText = top ? '占 ' + top.projectCode + ' BOM ' + ratioPct + '%' : '占比较高';
  const magText = magMax > 0 ? '，幅度约 ' + Math.abs(magMin) + '%~' + Math.abs(magMax) + '%' : '';
  const confident = conf.includes('高') || conf.includes('中');
  const isDown = dir.includes('下降') || dir.includes('跌');
  const isUp = dir.includes('上涨') || dir.includes('涨');
  const bigImpact = ratioPct >= 30;
  const bigMove = magMax >= 10;

  if (isDown) {
    const s: MaterialSuggestion = {
      level: 'opportunity',
      title: '「' + aggregate.name + '」行情下行' + magText + (confident ? '' : '（信号待确认）'),
      action: '该子类' + projText + '，行情走低存在降价空间——建议向当前供应商发起降价谈判或重新询价' + (bigImpact ? '，成本影响大，优先处理' : '') + '；若已与供应商约定调价联动，可据此主张下调。',
    };
    if (!confident) s.action = '信号强度不足，建议先观察 1-2 周再行动；' + s.action;
    return s;
  }
  if (isUp) {
    const s: MaterialSuggestion = {
      level: 'risk',
      title: '「' + aggregate.name + '」行情上行' + magText + (bigMove ? '，涨幅明显' : ''),
      action: '该子类' + projText + '，成本有上行压力——建议提前锁定价格/备货' + (bigImpact ? '，或评估替代物料' : '') + '；与供应商沟通远期订单以对冲涨价。',
    };
    if (!confident) s.action = '信号强度不足，先跟踪行情；' + s.action;
    return s;
  }
  return {
    level: 'info',
    title: '「' + aggregate.name + '」行情' + dir + magText,
    action: '该子类' + projText + '，当前无明确趋势信号，维持现有采购节奏，下次洞察周期自动复查。',
  };
}

// ==================== ⑥ 主流程（App 级 60 秒轮询调用） ====================

export interface AutoInsightResult {
  planned: number;   // 关键物料总数
  insights: number;  // 本轮完成洞察数
  reused: number;    // 复用历史结论数
  waiting: number;   // 等待中（未到周期/预算不足）
  failed: number;    // 本轮失败数
}

/**
 * 一轮自动洞察：
 * 识别关键物料（免费）→ 聚合去重 → 查上次洞察 → 预算闸门 → 计划 → 最多跑 limit 个（默认 3，分批渐进）
 * 洞察走 agentSearchLoop("price-trend")（云端搜索 + 分析，外发内容=物料名/品类，与快捷洞察一致）
 */
export async function runAutoInsight(opts?: {
  limit?: number;
  onProgress?: (msg: string) => void;
}): Promise<AutoInsightResult | null> {
  const limit = opts?.limit ?? 3;
  try {
    const projects = (await getProjects("", "", "")).filter(
      (p: any) => !p.is_deleted && (p.project_type || "") === "在研"
    );
    if (projects.length === 0) return null;
    const bomsByProject: Record<number, any[]> = {};
    for (const p of projects) {
      try { bomsByProject[p.id] = await getProjectBOMs(p.id); } catch { bomsByProject[p.id] = []; }
    }
    const aggregates = aggregateMaterials(identifyKeyMaterials(projects, bomsByProject));
    if (aggregates.length === 0) return null;

    // 上次洞察索引（trend_items + 最新 snapshot）
    const lastInsights = await queryLastInsights();

    // 预算闸门（与云端用量统计共用每日上限）
    let budgetLeft = Infinity;
    try {
      const { getDailyCloudUsage } = await import("./db/settings");
      const dailyLimit = Math.max(1, Number(await getSetting("ai_usage_cloud_daily_limit", "50")) || 50);
      const usage = await getDailyCloudUsage();
      budgetLeft = Math.max(0, dailyLimit - (usage?.count || 0));
    } catch { /* 预算查询失败不阻断 */ }

    const intervalDays = Math.max(1, Number(await getSetting("ai_insight_interval_days", "30")) || 30);
    const plan = buildInsightPlan(aggregates, lastInsights, { intervalDays, now: new Date(), budgetLeft });
    const todo = plan.filter(x => x.action === "insight");
    const reused = plan.filter(x => x.action === "reuse").length;
    const waiting = plan.filter(x => x.action === "wait").length;
    let insights = 0, failed = 0;

    for (const item of todo.slice(0, limit)) {
      try {
        // ⚠️ 发送前确认（2026-08-16 起：preview 模式拦截；2026-08-17 重构为非打断式队列，确认后 costhub-insight-request 继续）
        const { requestCloudConfirm } = await import("./cloudConfirm");
        const ok = await requestCloudConfirm({
          material: item.aggregate.name,
          category: item.aggregate.category,
        });
        if (!ok) { failed++; continue; }
        opts?.onProgress?.("关键物料洞察：" + item.aggregate.name + "…"); // 确认放行后才广播任务（被拦截轮次不打扰）
        const { saveQuickTrendItem } = await import("./db");
        const { agentSearchLoop } = await import("./trendService");
        const trendItemId = await saveQuickTrendItem({
          material_name: item.aggregate.name,
          category_type: item.aggregate.category,
        });
        const r = await agentSearchLoop(
          item.aggregate.name,
          item.aggregate.category,
          "price-trend",
          (msg: string) => opts?.onProgress?.("关键物料洞察：" + item.aggregate.name + " · " + msg)
        );
        const { saveTrendSnapshot } = await import("./db");
        await saveTrendSnapshot({
          trend_item_id: trendItemId,
          source_type: "auto",
          direction: r.trend_direction,
          confidence_level: r.confidence_level,
          summary: r.summary,
          suggested_action: r.suggested_action,
          magnitude_min: r.magnitude_min,
          magnitude_max: r.magnitude_max,
          magnitude_reference: r.magnitude_reference,
        });
        insights++;
      } catch { failed++; }
    }
    return { planned: plan.length, insights, reused, waiting, failed };
  } catch {
    return null;
  }
}