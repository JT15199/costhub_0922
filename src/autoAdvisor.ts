// 自主分析引擎：后台规则发现成本机会点/风险点 → 本地 AI 润色建议 → 建议卡片（LocalAIAssistant 展示）
// 触发：App 级空闲轮询（与 runAutoCompare 同机制，见 App.tsx scheduleAppAdvisor）
// 数据边界：只读本地库；AI 润色仅本地 Ollama（logLocalAICall 全程留痕）

import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './db/settings';
import { getProjects, getProjectBOMs, getProjectCostSnapshots, getTargets } from './db/projects';
import { getParts, getAllPartSuppliers } from './db/parts';
import { computeTargetStatuses } from './targetInsight';
import { findAdvisorByFingerprint, findDismissedByFingerprint, saveAdvisorInsight, updateAdvisorStatus, getAdvisorInsights } from './db/advisor';
import { getDb } from './db/core';
import { logLocalAICall } from './ollama';
import { auditPromptStrict } from './aiBridge';

// ==================== 纯规则层（可 vitest） ====================
export interface RuleInput {
  projects: { id: number; code: string; name: string; category?: string; project_type?: string; created_at?: string }[];
  bomsByProject: Record<number, { part_id?: number; part_name: string; part_model?: string; part_cost?: number; quantity?: number; main_category?: string }[]>;
  snapshotLastAt: Record<number, string>;   // 项目最近成本快照时间
  parts: { id: number; name: string; model?: string; cost?: number; updated_at?: string; main_category?: string; projects?: string }[];
  suppliersByPart: Record<number, { supplier_name: string; price?: number; is_active?: number }[]>;
  targetsByProject: Record<number, { project_id: number; domain: string; target_cost: number }[]>;
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
    if ((p.project_type || '') !== '在研') continue;
    const lastAt = input.snapshotLastAt[p.id] || p.created_at || '';
    const days = daysBetween(now, lastAt);
    if (days === null || days < STALE_PROJECT_DAYS) continue;
    const boms = input.bomsByProject[p.id] || [];
    if (boms.length === 0) continue;
    const total = boms.reduce((s, b) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
    if (total <= 0) continue;
    // 大额物料 top3（金额占比）
    const ranked = [...boms].sort((a, b) => ((b.part_cost || 0) * (b.quantity || 1)) - ((a.part_cost || 0) * (a.quantity || 1))).slice(0, 3);
    const top3 = ranked.map(b => `${b.part_name} ¥${((b.part_cost || 0) * (b.quantity || 1)).toFixed(2)}`).join('、');
    const fp = `spc|${p.id}`;
    out.push({
      insight_type: 'stale_project_cost',
      title: `项目「${p.code}」成本已 ${days} 天未变动`,
      detail: `整机 BOM 成本 ¥${total.toFixed(2)}，自 ${lastAt.slice(0, 16)} 以来无成本留痕。大额物料：${top3}。长期不动通常意味着议价/比价停滞，建议主动推动。`,
      ref_type: 'project', ref_id: p.id, ref_name: p.code,
      prompt: `你是资深成本经理。项目「${p.code}」整机成本已长期未变动，请：1) 按品类方向给出最值得推动议价的物料优先级（不列具体型号）；2) 每项目标砍价幅度；3) 可直接执行的谈判行动计划。`,
      fingerprint: fp,
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
      fingerprint: `spp|${p.id}|${p.updated_at || ''}`,
    });
  }

  // ---- 3) 项目领域超目标 ----
  const statuses = computeTargetStatuses(
    input.projects.map(p => ({ id: p.id, code: p.code, project_type: p.project_type })),
    input.targetsByProject,
    input.bomsByProject
  );
  for (const s of statuses) {
    if (!(s.diff > 0)) continue;
    const rate = s.rate ?? 100;
    if (rate >= 100 - TARGET_GAP_MIN) continue; // 超支不足 5% 不打扰
    out.push({
      insight_type: 'target_gap',
      title: `项目「${s.code}」${s.domain} 超目标 ¥${s.diff.toFixed(2)}`,
      detail: `目标 ¥${(s.target || 0).toFixed(2)}，实际 ¥${s.actual.toFixed(2)}，超支 ${s.diff.toFixed(2)}（达成率 ${rate}%）。需要降本措施把成本压回目标线。`,
      ref_type: 'project', ref_id: s.projectId, ref_name: s.code,
      prompt: `你是资深成本经理。项目「${s.code}」的「${s.domain}」领域成本超目标，请给出降本建议：1) 该领域最可能压缩成本的子项方向；2) 建议节奏；3) 优先级排序。`,
      fingerprint: `tg|${s.projectId}|${s.domain}|${s.actual.toFixed(2)}`,
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
      fingerprint: `ss|${p.id}|${s.supplier_name}`,
    });
  }

  return out;
}

// ==================== AI 润色（本地 Ollama，失败静默降级为规则文案） ====================
const AI_INTERVAL_MS = 30 * 60 * 1000; // AI 润色 30 分钟节流

async function enhanceWithAI(cands: AdvisorCandidate[]): Promise<number> {
  const model = await getSetting('local_ai_model', '');
  if (!model || cands.length === 0) return 0;
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  const last = await getSetting('advisor_ai_last_run', '');
  if (last && Date.now() - new Date(last).getTime() < AI_INTERVAL_MS) return 0;
  const sys = '你是资深成本经理，正在审阅成本管理系统的自动分析候选（JSON 数组，每项含 index/insight_type/title/detail/ref_name）。对每项输出：{ index, title: 更精准的标题, detail: 具体建议含数字依据（200字内）, prompt: 给用户可一键执行的提示词（100字内，可直接粘贴到 AI 助手中执行或用于行业洞察） }。⚠️ prompt 字段必须脱敏：严禁出现任何器件型号、厂家名称、成本金额、供应商名称、项目代号、任何数字——只允许物料通用名称与品类描述。只输出 JSON 数组，不要任何其他文字。';
  const user = JSON.stringify(cands.map((c, i) => ({ index: i, insight_type: c.insight_type, title: c.title, detail: c.detail, ref_name: c.ref_name })));
  const userPrompt = `${user}\n\n请逐项输出优化后的建议。`;
  try {
    const resp = await invoke<{ status: number; body: string; success: boolean }>('http_post', {
      request: {
        url: `${base}/api/chat`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }], stream: false, options: { temperature: 0.3 } }),
      },
    });
    if (!resp.success) throw new Error(`HTTP ${resp.status}`);
    const parsed = JSON.parse(resp.body);
    const content: string = parsed?.message?.content || '';
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
      const existing = await findAdvisorByFingerprint(c.fingerprint);
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
  const active = projects.filter((p: any) => !p.is_deleted && (p.project_type || '') === '在研');
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
    now: new Date(),
  });
  // 指纹去重入库（规则文案先行，AI 润色后覆盖）
  let found = 0, skipped = 0;
  for (const c of cands) {
    const exist = await findAdvisorByFingerprint(c.fingerprint);
    if (exist) { skipped++; continue; }
    // 降噪：被忽略过的同类建议不重提（指纹含数据版本——物料调价/项目留痕后指纹变化，才重新提醒）
    const dismissed = await findDismissedByFingerprint(c.fingerprint);
    if (dismissed) { skipped++; continue; }
    await saveAdvisorInsight({ ...c, source: 'rule' });
    found++;
  }
  let aiEnhanced = 0;
  if (found > 0) {
    onProgress?.(`自主分析：发现 ${found} 条机会/风险点，AI 润色中…`);
    aiEnhanced = await enhanceWithAI(cands);
  }
  await setSetting('advisor_last_run', new Date().toISOString());
  window.dispatchEvent(new CustomEvent('costhub-advisor-done'));
  return { found, aiEnhanced, skipped };
}
