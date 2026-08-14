// AI 自主巡检（v2.3.19）：本地 AI 直接访问数据库，主动发现用户注意不到的细枝末节
// 两层：①规则层（免费实时可测：数据质量/成本模式/占比异常）②AI 层（本地模型深度洞察全库模式）
// 数据安全：仅本地模型（Ollama）读取全库摘要；云端模型不接入（与全局问询同边界）
import { startOllamaStream } from './ollama';
import { getSetting } from './db';
import { replaceAuditFindings, type AuditFinding } from './auditStore';

// ============ 规则层发现（纯函数，可单测） ============

export interface RuleCtx {
  projects: { id: number; code: string; project_type?: string; status?: string }[];
  targetsByProject: Record<number, { domain: string; target_cost: number }[]>;
  bomsByProject: Record<number, { module_name?: string; main_category?: string; part_name: string; part_cost?: number; quantity?: number }[]>;
  suppliersByPart: Record<number, { supplier_name: string; price: number; share_ratio: number; is_active: number }[]>;
  skus: { id: number; project_id: number; sku_code: string }[];
  skuCostBySku: Record<number, { cost: number; baseCost: number }>;
  insightsCount: number;
}

export function ruleFindings(ctx: RuleCtx): Omit<AuditFinding, 'id' | 'created_at'>[] {
  const out: Omit<AuditFinding, 'id' | 'created_at'>[] = [];

  // 1) 在研项目未设目标
  ctx.projects.filter(p => p.project_type !== '已完成' && !(ctx.targetsByProject[p.id] || []).length).forEach(p => {
    out.push({
      type: 'rule_no_target', level: 'info', source: 'rule',
      title: `${p.code} 未设定目标成本`,
      detail: '在研项目建议设定领域目标成本，驾驶舱才能自动预警超支',
      suggestion: '到「项目管理 → 成本分析」为关键领域设定目标，之后 AI 才能给出达成差距与降本思路',
      objects: JSON.stringify([p.code]), status: 'unread',
    });
  });

  // 2) 供应商份额总和异常（偏离 100%）
  Object.entries(ctx.suppliersByPart).forEach(([partId, sups]) => {
    const active = sups.filter(s => s.is_active);
    if (active.length === 0) return;
    const total = active.reduce((s, x) => s + (x.share_ratio || 0), 0);
    if (Math.abs(total - 100) > 5) {
      out.push({
        type: 'rule_share_anomaly', level: 'warn', source: 'rule',
        title: `器件 #${partId} 供应商份额合计 ${total.toFixed(0)}%`,
        detail: '启用供应商份额合计 ' + total.toFixed(0) + '%，偏离 100%（' + active.map(s => s.supplier_name + ' ' + s.share_ratio + '%').join('、') + '），加权成本可能失真',
        suggestion: '调整份额至合计 100%，或明确停用部分供应商，保证加权成本口径可信',
        objects: JSON.stringify([`part:${partId}`]), status: 'unread',
      });
    }
  });

  // 3) 单模块占比异常（≥60% —— 关键物料依赖信号）
  ctx.projects.forEach(p => {
    const boms = ctx.bomsByProject[p.id] || [];
    const total = boms.reduce((s, b) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
    if (total <= 0) return;
    const byMod: Record<string, number> = {};
    boms.forEach(b => { const m = b.module_name || '未归类'; byMod[m] = (byMod[m] || 0) + (b.part_cost || 0) * (b.quantity || 1); });
    Object.entries(byMod).forEach(([mod, cost]) => {
      const ratio = cost / total;
      if (ratio >= 0.6) {
        out.push({
          type: 'rule_module_dominance', level: 'warn', source: 'rule',
          title: `${p.code} 模块「${mod}」占比 ${(ratio * 100).toFixed(0)}%`,
          detail: '单模块占比过高=关键物料依赖集中，议价空间与供应风险并存',
        suggestion: '这是最大成本项，议价杠杆最大：①关注该模块主要物料行情 ②评估引入二供比价 ③对照目标成本看差距',
          objects: JSON.stringify([p.code, mod]), status: 'unread',
        });
      }
    });
  });

  // 4) SKU 成本偏离基座过大（≥40%）
  Object.entries(ctx.skuCostBySku).forEach(([skuId, sc]) => {
    if (!sc.baseCost) return;
    const pct = (sc.cost - sc.baseCost) / sc.baseCost * 100;
    if (Math.abs(pct) >= 40) {
      const sku = ctx.skus.find(s => s.id === Number(skuId));
      out.push({
        type: 'rule_sku_deviation', level: 'warn', source: 'rule',
        title: `SKU ${sku?.sku_code || skuId} 较基座 ${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`,
        detail: 'SKU 成本偏离基座超过 40%，请确认差异规则是否合理（新增/替换器件单价）',
        suggestion: '打开 SKU 详情检查差异规则的单价/数量，确认是否为真实配置差异',
        objects: JSON.stringify([sku?.sku_code || String(skuId)]), status: 'unread',
      });
    }
  });


  // 5) 跨项目同模块成本对比：某项目模块总成本显著高于其他项目同模块 → 议价机会
  const modCostsByProj: Record<string, { cost: number; projects: number }> = {};
  ctx.projects.forEach(p => {
    (ctx.bomsByProject[p.id] || []).forEach(b => {
      const m = b.module_name || '未归类';
      const k = p.id + '|' + m;
      if (!modCostsByProj[k]) modCostsByProj[k] = { cost: 0, projects: 0 };
      modCostsByProj[k].cost += (b.part_cost || 0) * (b.quantity || 1);
    });
  });
  const modAgg: Record<string, { cost: number; count: number; projCosts: Record<number, number> }> = {};
  Object.entries(modCostsByProj).forEach(([k, v]) => {
    const [pid, mod] = k.split('|');
    if (!modAgg[mod]) modAgg[mod] = { cost: 0, count: 0, projCosts: {} };
    modAgg[mod].cost += v.cost; modAgg[mod].count += 1;
    modAgg[mod].projCosts[Number(pid)] = v.cost;
  });
  Object.entries(modAgg).forEach(([mod, agg]) => {
    if (agg.count < 2) return;
    const avg = agg.cost / agg.count;
    Object.entries(agg.projCosts).forEach(([pid, cost]) => {
      if (avg <= 0) return;
      const pct = (cost - avg) / avg * 100;
      if (pct >= 20 && (cost - avg) >= 50) {
        const p = ctx.projects.find(x => x.id === Number(pid));
        out.push({
          type: 'rule_module_cost_gap', level: 'warn', source: 'rule',
          title: `${p?.code || pid}「${mod}」成本高于同类项目均值 ${pct.toFixed(0)}%`,
          detail: `该模块 ¥${cost.toFixed(0)} vs 其他项目均值 ¥${avg.toFixed(0)}（+¥${(cost - avg).toFixed(0)}），值得重点议价`,
          suggestion: '对比同模块其他项目的器件单价明细，找价差最大的器件逐一谈价；也可参照低报价项目的 BOM 结构',
          objects: JSON.stringify([p?.code || String(pid), mod]), status: 'unread',
        });
      }
    });
  });

  return out;
}

// ============ 全库摘要（给本地模型的上下文） ============

export async function buildAuditContext(
  projects: any[], bomsByProject: Record<number, any[]>, targetsByProject: Record<number, any[]>,
  suppliersByPart: Record<number, any[]>, snapshotsByProject: Record<number, any[]>, insights: any[],
  skus: any[], skuCostBySku: Record<number, { cost: number; baseCost: number }>,
): Promise<string> {
  const lines: string[] = [];
  lines.push(`共 ${projects.length} 个项目、${Object.values(bomsByProject).reduce((s, b) => s + b.length, 0)} 个 BOM 项、${Object.keys(suppliersByPart).length} 个器件有供应商、${insights.length} 条报价情报、${skus.length} 个 SKU`);
  projects.forEach(p => {
    const boms = bomsByProject[p.id] || [];
    const total = boms.reduce((s, b) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
    const specs = [p.screen_size, p.resolution, p.refresh_rate, p.panel_type].filter(Boolean).join('/');
    const t = (targetsByProject[p.id] || []).map(x => `${x.domain}:${x.target_cost}`).join(',') || '无目标';
    const snaps = snapshotsByProject[p.id] || [];
    const snapInfo = snaps.length >= 2
      ? `最近快照 ${snaps[snaps.length - 1].bom_cost}（共 ${snaps.length} 条）`
      : `快照 ${snaps.length} 条`;
    lines.push(`项目 ${p.code}[${p.name || ''}] ${p.project_type || ''} 规格(${specs}) BOM成本¥${total.toFixed(2)} 目标(${t}) ${snapInfo}`);
  });
  // 模块成本分布（跨项目看模式）
  const modCosts: Record<string, { cost: number; projects: number }> = {};
  projects.forEach(p => {
    (bomsByProject[p.id] || []).forEach(b => {
      const m = b.module_name || '未归类';
      if (!modCosts[m]) modCosts[m] = { cost: 0, projects: 0 };
      modCosts[m].cost += (b.part_cost || 0) * (b.quantity || 1);
      modCosts[m].projects += 1;
    });
  });
  lines.push('模块成本汇总：' + Object.entries(modCosts).map(([m, v]) => `${m} ¥${v.cost.toFixed(0)}(${v.projects}项)`).join('、'));
  // 供应商价格概况
  const supInfo = Object.entries(suppliersByPart).slice(0, 15).map(([pid, sups]) => {
    const s = sups.filter(x => x.is_active);
    return s.length ? `器件#${pid}: ${s.map(x => `${x.supplier_name} ¥${x.price} 份额${x.share_ratio}%`).join(';')}` : '';
  }).filter(Boolean);
  if (supInfo.length) lines.push('供应商报价：' + supInfo.join(' | '));
  // SKU
  if (skus.length) lines.push('SKU：' + skus.map(s => `${s.sku_code}(基座¥${skuCostBySku[s.id]?.baseCost || 0}→¥${skuCostBySku[s.id]?.cost || 0})`).join('、'));
  return lines.join('\n');
}

// ============ 主流程 ============

export interface AutoAuditResult { rules: number; ai: number; aiFailed: boolean; }

export async function runAutoAudit(): Promise<AutoAuditResult | null> {
  const { getProjects, getProjectBOMs, getTargets, getProjectCostSnapshots, getInsights, getAllSkuDiffs } = await import('./db');
  const { calcSkuCost } = await import('./skuCalc');
  const { getPartSuppliers } = await import('./db');
  try {
    const projects = await getProjects('', '', '');
    const [bomsByP, targetsByP, snapsByP] = await Promise.all([
      Promise.all(projects.map((p: any) => getProjectBOMs(p.id))),
      Promise.all(projects.map((p: any) => getTargets(p.id))),
      Promise.all(projects.map((p: any) => getProjectCostSnapshots(p.id))),
    ]);
    const bByP: Record<number, any[]> = {}; const tByP: Record<number, any[]> = {}; const sByP: Record<number, any[]> = {};
    projects.forEach((p: any, i: number) => { bByP[p.id] = bomsByP[i]; tByP[p.id] = targetsByP[i]; sByP[p.id] = snapsByP[i]; });
    const insights = await getInsights();
    // 供应商
    const partsWithSuppliers = new Set<number>();
    (await Promise.all(projects.map((p: any) => getProjectBOMs(p.id)))).forEach((boms: any[]) => boms.forEach((b: any) => { if (b.part_id) partsWithSuppliers.add(b.part_id); }));
    const suppliersByPart: Record<number, any[]> = {};
    for (const pid of partsWithSuppliers) {
      try { suppliersByPart[pid] = await getPartSuppliers(pid); } catch { /* 忽略 */ }
    }
    // SKU
    const skus2 = await (await import('./db')).getAllSkus().catch(() => []);
    let skuDiffsMap: Record<number, any[]> = {};
    try { skuDiffsMap = await getAllSkuDiffs(skus2.map((s: any) => s.id)); } catch { /* 忽略 */ }
    const skuCostBySku: Record<number, { cost: number; baseCost: number }> = {};
    for (const s of skus2) {
      const baseCost = (bByP[s.project_id] || []).reduce((sum: number, b: any) => sum + (b.part_cost || 0) * (b.quantity || 1), 0);
      const r = calcSkuCost(bByP[s.project_id] || [], skuDiffsMap[s.id] || [], baseCost);
      skuCostBySku[s.id] = { cost: r.cost, baseCost };
    }
    // 规则层
    const rules = ruleFindings({ projects, targetsByProject: tByP, bomsByProject: bByP, suppliersByPart, skus: skus2, skuCostBySku, insightsCount: insights.length });
    const findings: Omit<AuditFinding, 'id' | 'created_at'>[] = [...rules];
    let aiFindings: Omit<AuditFinding, 'id' | 'created_at'>[] = [];
    let aiFailed = false;
    // AI 层（本地模型，失败不影响规则结果）
    try {
      const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
      const model = await getSetting('local_ai_model', '');
      if (model) {
        const ctxText = await buildAuditContext(projects, bByP, tByP, suppliersByPart, sByP, insights, skus2, skuCostBySku);
        aiFindings = await aiAuditFindings(url, model, ctxText, rules);
      }
    } catch (e) {
      console.warn('AI 巡检失败（规则层仍生效）:', e);
      aiFailed = true;
    }
    findings.push(...aiFindings);
    await replaceAuditFindings(findings);
    return { rules: rules.length, ai: aiFindings.length, aiFailed };
  } catch (e) {
    console.warn('自主巡检失败:', e);
    return null;
  }
}

// AI 深度洞察：把全库摘要交给本地模型，找规则覆盖不到的"细枝末节"
async function aiAuditFindings(url: string, model: string, ctxText: string, rules: Omit<AuditFinding, 'id' | 'created_at'>[]): Promise<Omit<AuditFinding, 'id' | 'created_at'>[]> {
  const ruleSummary = rules.map(r => `- ${r.title}：${r.detail}`).join('\n') || '（规则层未发现）';
  const sysPrompt = '你是嵌入 CostHub 成本管理工具的资深成本分析师。系统已用规则检查了常见问题（见规则发现）。你的任务不是复述事实（物料涨跌是用户自己输入的，他都知道），而是输出有决策价值的洞察与建议：1) 成本机会点：哪里有降本空间（模块占比过高的议价杠杆、同类物料跨项目价差可统一采购、供应商集中可引入二供等），给出具体思路 2) 成本结构意见：成本占比明显偏高的模块/领域，对照目标/历史/同类给出判断和行动建议 3) 数据矛盾或可疑模式（用户可能注意不到的细枝末节）。只输出 JSON（不要任何其他文字）：{"findings":[{"title":"简短标题","detail":"具体说明（引用真实数据）","suggestion":"给用户的建议/思路（一句话，可执行）","level":"warn或info","objects":["涉及项目/器件"]}]}。规则：1) 必须基于提供的数据，不能编造数字 2) 最多 5 条 3) 宁缺毋滥，只报真正值得行动的 4) 不要重复规则已报的。';
  const userPrompt = `全库数据摘要：\n${ctxText}\n\n规则层发现：\n${ruleSummary}`;
  let full = '';
  await new Promise<void>((resolve, reject) => {
    startOllamaStream(url, model,
      [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      t => { full += t; }, () => {}, () => resolve(), e => reject(new Error(e)),
      { endpoint: 'native', json: true, think: false, num_predict: 900, temperature: 0.3 },
    );
  });
  const data = parseFindingsJson(full);
  return (data || []).map((f: any) => ({
    type: 'ai_insight', level: f.level === 'warn' ? 'warn' : 'info', source: 'ai' as const,
    title: String(f.title || 'AI 发现'), detail: String(f.detail || ''), suggestion: String(f.suggestion || ''), objects: JSON.stringify(Array.isArray(f.objects) ? f.objects : []), status: 'unread' as const,
  }));
}

// 健壮 JSON 解析（本地模型输出容错：代码围栏/中文引号/尾逗号）
function parseFindingsJson(text: string): any[] {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return [];
  const candidates = [
    body.slice(s, e + 1),
    body.slice(s, e + 1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    body.slice(s, e + 1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,(s*[}]])/g, '$1'),
  ];
  for (const c of candidates) {
    try {
      const d = JSON.parse(c);
      if (d && Array.isArray(d.findings)) return d.findings;
    } catch { /* 下一级 */ }
  }
  return [];
}
