// 自主分析引擎：后台规则发现成本机会点/风险点 → 本地 AI 润色建议 → 建议卡片（驾驶舱待处理事项展示）
// 触发：App 级空闲轮询（与 runAutoCompare 同机制，见 App.tsx scheduleAppAdvisor）
// 数据边界：只读本地库；AI 润色仅本地 Ollama（logLocalAICall 全程留痕）

import { getSetting, setSetting } from './db/settings';
import { getProjects, getProjectBOMs, getProjectCostSnapshots, getTargets, getMeasures } from './db/projects';
import { getParts, getAllPartSuppliers } from './db/parts';
import { computeTargetStatuses } from './targetInsight';
import { findAdvisorByFingerprint, upsertAdvisorInsight, updateAdvisorStatus, getAdvisorInsights } from './db/advisor';
import { getDb } from './db/core';
import { logLocalAICall } from './ollama';
import { auditPromptStrict } from './ai/security';
import { saveRecommendation } from './db/ai';
import { bomExtendedCostStrict, bomQuantity } from './ai/contracts';

// ==================== 纯规则层（可 vitest） ====================
export interface RuleInput {
  projects: { id: number; code: string; name: string; category?: string; project_type?: string; stage?: string; created_at?: string }[];
  bomsByProject: Record<number, { part_id?: number; part_name: string; part_model?: string; part_specs?: string; part_cost?: number; quantity?: number; price_state?: string; main_category?: string }[]>;
  snapshotLastAt: Record<number, string>;   // 项目最近成本快照时间
  parts: { id: number; name: string; model?: string; cost?: number; updated_at?: string; main_category?: string; projects?: string }[];
  suppliersByPart: Record<number, { supplier_name: string; price?: number; is_active?: number }[]>;
  targetsByProject: Record<number, { project_id: number; domain: string; target_cost: number }[]>;
  baselineByKey?: Record<string, number>;
  measuresByProject?: Record<number, { id: number; measure: string; status?: string; due_date?: string }[]>;
  marketDownParts?: { id: number; name: string; trend: string }[];
  now: Date;
}
export interface AdvisorCandidate {
  insight_type: string;
  title: string;
  detail: string;
  ref_type: string;
  ref_id: number;
  ref_name: string;
  prompt: string;
  fingerprint: string;
  issue_key: string;
  evidence_fingerprint: string;
  impact_amount?: number;
  severity?: string;
}

const DAY = 86400000;
const STALE_PROJECT_DAYS = 60;   // 项目成本 N 天未变动 → 提醒
const STALE_PART_DAYS = 90;      // 大额物料 N 天未调价 → 提醒
const BIG_PART_MIN = 10;         // 大额物料阈值（元）
const TARGET_GAP_MIN = 5;        // 超目标 ≥ 5% 才提醒

export function daysBetween(now: Date, t?: string): number | null {
  if (!t) return null;
  const d = new Date(t.replace('T', ' '));
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY));
}

export function buildRuleCandidates(input: RuleInput): AdvisorCandidate[] {
  const out: AdvisorCandidate[] = [];
  const now = input.now;

  // ---- 1) 项目成本长期未变动（快照留痕） ----
  for (const p of input.projects) {
    const lastAt = input.snapshotLastAt[p.id] || p.created_at || '';
    const days = daysBetween(now, lastAt);
    if (days === null || days < STALE_PROJECT_DAYS) continue;
    const boms = input.bomsByProject[p.id] || [];
    if (boms.length === 0) continue;
    const costs = boms.map(bomExtendedCostStrict);
    if (costs.some(value => value === null)) continue;
    const total = costs.reduce<number>((s, value) => s + (value ?? 0), 0);
    if (total <= 0) continue;
    // 大额物料 top3（金额占比）
    const ranked = boms.map((bom, index) => ({ bom, cost: costs[index] as number })).sort((a, b) => b.cost - a.cost).slice(0, 3);
    const top3 = ranked.map(({ bom, cost }) => `${bom.part_name} ¥${cost.toFixed(2)}`).join('、');
    const fp = `spc|${p.id}|${lastAt}|${total.toFixed(4)}`;
    out.push({
      insight_type: 'stale_project_cost',
      title: `项目「${p.code}」成本已 ${days} 天未变动`,
      detail: `整机 BOM 成本 ¥${total.toFixed(2)}，自 ${lastAt.slice(0, 16)} 以来无成本留痕。大额物料：${top3}。长期不动通常意味着议价/比价停滞，建议主动推动。`,
      ref_type: 'project', ref_id: p.id, ref_name: p.code,
      prompt: `你是资深成本经理。项目「${p.code}」整机成本已长期未变动，请：1) 按品类方向给出最值得推动议价的物料优先级（不列具体型号）；2) 每项目标砍价幅度；3) 可直接执行的谈判行动计划。`,
      fingerprint: fp,
      issue_key: `stale_project_cost|project|${p.id}`,
      evidence_fingerprint: fp,
    });
  }

  // ---- 2) 大额物料价格长期未调 ----
  // 物料使用上下文：从各项目 BOM 反查（工具不存总用量，只有单项目用量——如实呈现）
  const usageOf = (partId: number) => {
    const out: string[] = [];
    for (const [pid, boms] of Object.entries(input.bomsByProject)) {
      const qty = boms.filter(b => b.part_id === partId).reduce((s, b) => s + (b.quantity || 0), 0);
      if (qty > 0) {
        const proj = input.projects.find(pr => pr.id === Number(pid));
        out.push(`${proj?.code || pid}(${qty}件)`);
      }
    }
    return out.length > 0 ? out.join('、') : '';
  };
  const bigParts = input.parts.filter(p => (p.cost || 0) >= BIG_PART_MIN);
  for (const p of bigParts) {
    const days = daysBetween(now, p.updated_at);
    if (days === null || days < STALE_PART_DAYS) continue;
    // 只关注在用物料（parts.projects 有引用或供应商存在）
    const sups = input.suppliersByPart[p.id] || [];
    const activeSup = sups.filter(s => s.is_active !== 0);
    const supplierDesc = activeSup.length > 0 ? `供应商：${activeSup.map(s => s.supplier_name).join('、')}` : '暂无启用供应商';
    const usageDesc = usageOf(p.id);
    out.push({
      insight_type: 'stale_part_price',
      title: `物料「${p.name}」¥${(p.cost || 0).toFixed(2)} 已 ${days} 天未调价`,
      detail: `型号 ${p.model || '—'}（${p.main_category || '未分类'}），现成本 ¥${(p.cost || 0).toFixed(2)}，自 ${(p.updated_at || '').slice(0, 16)} 起未变动。${supplierDesc}。${usageDesc ? `使用：${usageDesc}。` : ''}超过 ${STALE_PART_DAYS} 天未动价，值得作为议价抓手重新谈价。`,
      ref_type: 'part', ref_id: p.id, ref_name: p.name,
      prompt: `你是资深成本经理。针对「${p.name}」品类物料开展议价评估：1) 结合品类近期行情给出合理采购价区间与砍价幅度；2) 给 3 条谈判话术要点；3) 判断是否值得做行业行情洞察，值得则给出洞察关键词。`,
      fingerprint: `spp|${p.id}|${p.updated_at || ''}|${Number(p.cost || 0).toFixed(4)}`,
      issue_key: `stale_part_price|part|${p.id}`,
      evidence_fingerprint: `spp|${p.id}|${p.updated_at || ''}|${Number(p.cost || 0).toFixed(4)}`,
    });
  }

  // ---- 3) 项目领域超目标 ----
  const statuses = computeTargetStatuses(
    input.projects.map(p => ({ id: p.id, code: p.code, project_type: p.project_type })),
    input.targetsByProject,
    input.bomsByProject
  );
  for (const s of statuses) {
    if (s.diff == null || s.actual == null) continue;
    if (!(s.diff > 0)) continue;
    const rate = s.rate ?? 100;
    if (rate >= 100 - TARGET_GAP_MIN) continue; // 超支不足 5% 不打扰
    out.push({
      insight_type: 'target_gap',
      title: `项目「${s.code}」${s.domain} 超目标 ¥${s.diff.toFixed(2)}`,
      detail: `目标 ¥${(s.target || 0).toFixed(2)}，实际 ¥${s.actual.toFixed(2)}，超支 ${s.diff.toFixed(2)}（达成率 ${rate}%）。需要降本措施把成本压回目标线。`,
      ref_type: 'project', ref_id: s.projectId, ref_name: s.code,
      prompt: `你是资深成本经理。项目「${s.code}」的「${s.domain}」领域成本超目标，请给出降本建议：1) 该领域最可能压缩成本的子项方向；2) 建议节奏；3) 优先级排序。`,
      fingerprint: `tg|${s.projectId}|${s.domain}|${s.actual.toFixed(4)}|${(s.target || 0).toFixed(4)}`,
      issue_key: `target_gap|project|${s.projectId}|domain|${s.domain}`,
      evidence_fingerprint: `tg|${s.projectId}|${s.domain}|${s.actual.toFixed(4)}|${(s.target || 0).toFixed(4)}`,
      impact_amount: s.diff,
      severity: s.diff >= 100 ? 'high' : 'warning',
    });
  }

  // ---- 4) 大额物料单一供应商 ----
  for (const p of bigParts) {
    const sups = (input.suppliersByPart[p.id] || []).filter(s => s.is_active !== 0);
    if (sups.length !== 1) continue;
    const s = sups[0];
    out.push({
      insight_type: 'single_supplier',
      title: `物料「${p.name}」仅单一供应商${s.supplier_name}`,
      detail: `型号 ${p.model || '—'} 成本 ¥${(p.cost || 0).toFixed(2)}（≥¥${BIG_PART_MIN} 大额），仅 ${s.supplier_name} 一家供货。${(() => { const u = usageOf(p.id); return u ? `使用：${u}。` : ''; })()}供应中断风险集中，且议价筹码有限，建议评估引入二供。`,
      ref_type: 'part', ref_id: p.id, ref_name: p.name,
      prompt: `你是资深成本经理。评估「${p.name}」品类物料的供应风险管理：1) 单一供货风险等级与影响；2) 当前议价空间；3) 引入二供的评估要点与验证方向；4) 若暂不引入二供，如何管理该风险。`,
      fingerprint: `ss|${p.id}|${s.supplier_name}|${Number(p.cost || 0).toFixed(4)}`,
      issue_key: `single_supplier|part|${p.id}`,
      evidence_fingerprint: `ss|${p.id}|${s.supplier_name}|${Number(p.cost || 0).toFixed(4)}`,
    });
  }

  // ---- 3) 新报价高于已确认基线 / 同规格跨项目价差 ----
  for (const [pid, boms] of Object.entries(input.bomsByProject)) {
    for (const bom of boms) {
      const key = `${bom.part_name}|${bom.part_model || ''}`;
      const baseline = input.baselineByKey?.[`part:${bom.part_id}`] ?? input.baselineByKey?.[key];
      const currentLine = bomExtendedCostStrict(bom);
      const quantity = bomQuantity(bom);
      const current = currentLine === null || quantity === 0 ? null : currentLine / quantity;
      if (current === null || !baseline || current <= baseline * 1.05) continue;
      const project = input.projects.find(item => item.id === Number(pid));
      const impact = (current - baseline) * quantity;
      out.push({ insight_type: 'price_above_baseline', title: `项目「${project?.code || pid}」${bom.part_name} 高于已确认基线`, detail: `当前单价 ¥${current.toFixed(2)}，已确认基线 ¥${baseline.toFixed(2)}，单价高出 ¥${(current - baseline).toFixed(2)}，按当前用量影响 ¥${impact.toFixed(2)}。请先核对规格和报价来源，再决定是否转议价措施。`, ref_type: 'project', ref_id: Number(pid), ref_name: project?.code || String(pid), prompt: `请检查该领域物料报价与历史确认基线的差异，给出核价和议价动作。`, fingerprint: `pab|${pid}|${key}|${current.toFixed(4)}|${baseline.toFixed(4)}`, issue_key: `price_above_baseline|project|${pid}|${key}`, evidence_fingerprint: `pab|${pid}|${key}|${current.toFixed(4)}|${baseline.toFixed(4)}`, impact_amount: impact, severity: impact >= 100 ? 'high' : 'warning' });
    }
  }
  const comparablePrices = new Map<string, { name: string; model: string; values: Array<{ pid: number; price: number; quantity: number }> }>();
  for (const [pid, boms] of Object.entries(input.bomsByProject)) for (const bom of boms) {
    const key = bom.part_id ? `part:${bom.part_id}` : `${bom.part_name}|${bom.part_model || ''}|${bom.part_specs || ''}`; const item = comparablePrices.get(key) || { name: bom.part_name, model: bom.part_model || '', values: [] };
    const line = bomExtendedCostStrict(bom);
    const quantity = bomQuantity(bom);
    const price = line === null || quantity === 0 ? null : line / quantity;
    if (price === null) continue;
    item.values.push({ pid: Number(pid), price, quantity }); comparablePrices.set(key, item);
  }
  for (const [key, item] of comparablePrices) {
    const values = item.values.filter(value => value.price > 0); const projectIds = new Set(values.map(value => value.pid)); if (projectIds.size < 2) continue;
    const low = Math.min(...values.map(value => value.price)); const high = Math.max(...values.map(value => value.price)); if (high - low < 1 || high <= low * 1.05) continue;
    const project = input.projects.find(row => row.id === values.find(value => value.price === high)?.pid);
    const highValue = values.find(value => value.price === high)!;
    out.push({ insight_type: 'cross_project_price_gap', title: `同规格物料「${item.name}」跨项目单价不一致`, detail: `同名同型号单价区间 ¥${low.toFixed(2)} ~ ¥${high.toFixed(2)}，单价差异 ¥${(high - low).toFixed(2)}，高价项目按用量影响 ¥${((high - low) * highValue.quantity).toFixed(2)}。数量不同不会被误判为价格差异。`, ref_type: 'project', ref_id: project?.id || values[0].pid, ref_name: project?.code || String(values[0].pid), prompt: '请核对同规格物料的跨项目价格差异，并列出需要人工确认的可比条件。', fingerprint: `cpg|${key}|${low.toFixed(4)}|${high.toFixed(4)}`, issue_key: `cross_project_price_gap|part|${key}`, evidence_fingerprint: `cpg|${key}|${low.toFixed(4)}|${high.toFixed(4)}`, impact_amount: high - low, severity: high - low >= 100 ? 'high' : 'warning' });
  }

  // ---- 4) 行情下行但现价未调整 / 措施逾期 ----
  for (const part of input.marketDownParts || []) {
    const current = input.parts.find(row => row.id === part.id); if (!current) continue;
    out.push({ insight_type: 'market_down_unadjusted', title: `物料「${part.name}」行情下行但现价未调整`, detail: `本地行情记录显示“${part.trend}”，器件库现价 ¥${Number(current.cost || 0).toFixed(2)}。请核对供应商报价是否同步。`, ref_type: 'part', ref_id: part.id, ref_name: part.name, prompt: '请根据公开行情下行信号，制定一次供应商复核和价格更新动作。', fingerprint: `mdu|${part.id}|${part.trend}|${current.updated_at || ''}`, issue_key: `market_down_unadjusted|part|${part.id}`, evidence_fingerprint: `mdu|${part.id}|${part.trend}|${current.updated_at || ''}` });
  }
  for (const [pid, measures] of Object.entries(input.measuresByProject || {})) {
    const overdue = measures.filter(item => item.due_date && new Date(item.due_date.replace(' ', 'T')).getTime() < now.getTime() && !['已完成', '已关闭', '已实现'].includes(item.status || ''));
    if (!overdue.length) continue;
    const project = input.projects.find(item => item.id === Number(pid));
    out.push({ insight_type: 'overdue_measure', title: `项目「${project?.code || pid}」有 ${overdue.length} 项降本措施逾期`, detail: overdue.slice(0, 3).map(item => `${item.measure}（截止 ${item.due_date}）`).join('、'), ref_type: 'project', ref_id: Number(pid), ref_name: project?.code || String(pid), prompt: '请按措施逾期情况给出责任人确认、供应商跟进或关闭原因的下一步动作。', fingerprint: `om|${pid}|${overdue.map(item => `${item.id}:${item.due_date}`).join(',')}`, issue_key: `overdue_measure|project|${pid}`, evidence_fingerprint: `om|${pid}|${overdue.map(item => `${item.id}:${item.due_date}`).join(',')}` });
  }

  return out;
}

// ==================== AI 润色（本地 Ollama，失败静默降级为规则文案） ====================
const AI_INTERVAL_MS = 30 * 60 * 1000; // AI 润色 30 分钟节流

async function enhanceWithAI(cands: AdvisorCandidate[]): Promise<number> {
  const model = await getSetting('local_ai_model', '');
  if (!model || cands.length === 0) return 0;
  const last = await getSetting('advisor_ai_last_run', '');
  if (last && Date.now() - new Date(last).getTime() < AI_INTERVAL_MS) return 0;
  const sys = '你是资深成本经理，正在审阅成本管理系统的自动分析候选（JSON 数组，每项含 index/insight_type/title/detail/ref_name）。对每项输出：{ index, title: 更精准的标题, detail: 具体建议含数字依据（200字内）, prompt: 给用户可一键执行的提示词（100字内，可直接粘贴到 AI 助手中执行或用于行业洞察） }。⚠️ prompt 字段必须脱敏：严禁出现任何器件型号、厂家名称、成本金额、供应商名称、项目代号、任何数字——只允许物料通用名称与品类描述。只输出 JSON 数组，不要任何其他文字。';
  const user = JSON.stringify(cands.map((c, i) => ({ index: i, insight_type: c.insight_type, title: c.title, detail: c.detail, ref_name: c.ref_name })));
  const userPrompt = `${user}\n\n请逐项输出优化后的建议。`;
  try {
    const { localCompletion } = await import('./localBackend');
    const content = await localCompletion(sys, userPrompt);
    await logLocalAICall({
      request_type: 'auto_advisor',
      system_prompt: sys,
      user_prompt: userPrompt.slice(0, 3000),
      response_summary: content.slice(0, 800),
      success: true,
      model_name: model,
    });
    const arr = parseJsonArray(content);
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    let enhanced = 0;
    for (const item of arr) {
      const i = Number(item?.index);
      if (!Number.isInteger(i) || i < 0 || i >= cands.length) continue;
      const c = cands[i];
      const title = String(item?.title || '').trim();
      const detail = String(item?.detail || '').trim();
      const prompt = String(item?.prompt || '').trim();
      if (!title && !detail && !prompt) continue;
      // 严格审计：润色输出的提示词含型号/金额/厂家 → 丢弃润色（保留规则脱敏模板）
      if (prompt && !auditPromptStrict(prompt).safe) continue;
      const existing = await findAdvisorByFingerprint(c.evidence_fingerprint);
      if (existing) {
        // ⚠️ 不覆盖用户已处理/已忽略的状态（2026-08-16 修复：润色曾把 done 改回 open，导致"已处理"记录消失）
        const cur = await (await getDb()).select<any[]>('SELECT status FROM ai_advisor_insights WHERE id = ?', [existing.id]).catch(() => [] as any[]);
        if (cur?.[0]?.status !== 'open') { enhanced++; continue; }
        await updateAdvisorStatus(existing.id, 'open', {
          detail: detail || c.detail,
          insight: prompt || c.prompt,
        });
        enhanced++;
      }
    }
    await setSetting('advisor_ai_last_run', new Date().toISOString());
    return enhanced;
  } catch (e: any) {
    await logLocalAICall({
      request_type: 'auto_advisor',
      system_prompt: sys,
      user_prompt: userPrompt.slice(0, 3000),
      response_summary: '',
      success: false,
      error_message: String(e?.message || e).slice(0, 200),
      model_name: model,
    });
    return 0;
  }
}

// 健壮 JSON 数组解析（兼容代码块/中文引号/尾逗号）
function parseJsonArray(text: string): any[] | null {
  let t = text.trim();
  const m = t.match(/\[\s\S]*\]/);
  if (m) t = m[0];
  const attempts = [
    () => JSON.parse(t),
    () => JSON.parse(t.replace(/[\u201c\u201d]/g, '"').replace(/'/g, '"').replace(/,([\s]*[}\]])/g, '$1')),
  ];
  for (const fn of attempts) {
    try { const v = fn(); if (Array.isArray(v)) return v; } catch { /* 下一级 */ }
  }
  return null;
}

// ==================== 主流程 ====================
export interface AdvisorRunResult { found: number; aiEnhanced: number; skipped: number; }

/** 成本巡视仍关注量产后的维护/降本项目；只有明确归档的项目才退出范围。 */
export function isAdvisorProjectInScope(project: { is_deleted?: number; is_archived?: number; archived_at?: string; project_type?: string; stage?: string }): boolean {
  if (project.is_deleted || project.is_archived || project.archived_at) return false;
  return project.project_type !== '已完成' || project.stage === '量产后降本';
}

export async function runAutoAdvisor(onProgress?: (msg: string) => void): Promise<AdvisorRunResult | null> {
  // 存量提示词脱敏清理：历史建议若含型号/金额/厂家（旧模板或 AI 润色）→ 清空提示词，防止外传泄露
  try {
    const openList = await getAdvisorInsights('open');
    for (const e of openList) {
      if (e.prompt && !auditPromptStrict(e.prompt).safe) {
        await updateAdvisorStatus(e.id, 'open', { detail: e.detail || '', insight: '' });
      }
    }
  } catch { /* 忽略清理失败 */ }
  onProgress?.('自主分析：读取项目与 BOM…');
  const projects = await getProjects('', '', '');
  const active = projects.filter(isAdvisorProjectInScope);
  if (active.length === 0) { await setSetting('advisor_last_run', new Date().toISOString()); return null; }
  const bomsByProject: Record<number, any[]> = {};
  const snapshotLastAt: Record<number, string> = {};
  for (const p of active) {
    const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
    bomsByProject[p.id] = boms;
    const snaps = await getProjectCostSnapshots(p.id);
    if (snaps?.[0]?.created_at) snapshotLastAt[p.id] = snaps[0].created_at;
  }
  onProgress?.('自主分析：扫描物料与供应商…');
  const [parts, suppliers] = await Promise.all([getParts(), getAllPartSuppliers()]);
  const measuresByProject: Record<number, any[]> = {};
  for (const p of active) { try { measuresByProject[p.id] = await getMeasures(p.id); } catch { measuresByProject[p.id] = []; } }
  const baselineByKey: Record<string, number> = {};
  try {
    const baselineRows = await (await getDb()).select<any[]>("SELECT scope_key, value FROM cost_baseline_decisions WHERE status='confirmed' AND baseline_type='material'");
    baselineRows.forEach(row => { baselineByKey[String(row.scope_key || '')] = Number(row.value || 0); });
  } catch { }
  let marketDownParts: { id: number; name: string; trend: string }[] = [];
  try {
    const trends = await (await getDb()).select<any[]>('SELECT query_category, trend_direction, summary FROM trend_items');
    marketDownParts = parts.flatMap((part: any) => trends.filter(row => row.query_category && row.query_category === part.trend_query_category && /下降|下行|下跌|降价|down/i.test(`${row.trend_direction || ''}${row.summary || ''}`)).map(row => ({ id: part.id, name: part.name, trend: row.trend_direction || row.summary || '下行' })));
  } catch { }
  const targetRows: any[] = [];
  for (const p of active) {
    try { targetRows.push(...(await getTargets(p.id))); } catch { /* 无目标 */ }
  }
  const suppliersByPart: Record<number, any[]> = {};
  for (const s of suppliers || []) {
    (suppliersByPart[s.part_id] = suppliersByPart[s.part_id] || []).push(s);
  }
  const targetsByProject: Record<number, any[]> = {};
  for (const t of targetRows || []) {
    (targetsByProject[t.project_id] = targetsByProject[t.project_id] || []).push(t);
  }
  const cands = buildRuleCandidates({
    projects: active,
    bomsByProject,
    snapshotLastAt,
    parts,
    suppliersByPart,
    targetsByProject,
    baselineByKey,
    measuresByProject,
    marketDownParts,
    now: new Date(),
  });
  // 指纹去重入库（规则文案先行，AI 润色后覆盖）
  let found = 0, skipped = 0;
  const newCandidates: AdvisorCandidate[] = [];
  for (const c of cands) {
    const saved = await upsertAdvisorInsight({ ...c, source: 'rule', impact_amount: c.impact_amount, severity: c.severity });
    if (!saved.created && !saved.reopened) { skipped++; continue; }
    newCandidates.push(c);
    try {
      await saveRecommendation({
        title: c.title,
        conclusion: c.detail,
        evidence: [{ refType: c.ref_type as any, refId: c.ref_id, label: c.ref_name, field: 'source', value: c.ref_name, deepLink: c.ref_type === 'project' ? { page: 'projects', params: { projectId: c.ref_id } } : undefined }],
        confidence: 'medium', assumptions: ['建议来自本地规则扫描，需结合当前报价确认'],
        action: { label: c.ref_type === 'project' ? '打开项目' : '发起议价', type: c.ref_type === 'project' ? 'open' : 'draft' },
        dataGaps: [], risks: ['建议不替代成本经理最终决策'], source: 'auto_advisor',
      });
    } catch { /* 旧库/建议表不可用时不影响原有自主建议 */ }
    found++;
  }
  let aiEnhanced = 0;
  if (found > 0) {
    onProgress?.(`自主分析：发现 ${found} 条机会/风险点，AI 润色中…`);
    aiEnhanced = await enhanceWithAI(newCandidates);
  }
  await setSetting('advisor_last_run', new Date().toISOString());
  window.dispatchEvent(new CustomEvent('costhub-advisor-done'));
  return { found, aiEnhanced, skipped };
}
