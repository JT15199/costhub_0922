// 卖点价值分析纯函数（v2.3.19，2026-08-18）
// 卖点 = 原声(声量/反响) × BOM(成本) 交叉；成本按模块均分分摊（同模块多卖点不重复计算）

export interface SellingPointRow {
  id: number;
  name: string;
  modules: string[];          // 关联模块
  sharedModules: string[];    // 与其他卖点共享的模块（成本被均分）
  dimNames: string[];         // 关联原声维度名
  cost: number;               // 分摊后成本（元）
  count: number;              // 声量（提及人数合计）
  positive: number;
  negative: number;
  quality: number;            // 好评率 positive/(positive+negative)，无正负时为 0
  costRatio: number;          // 声量成本比 = count / (cost/1000)，即每千元成本带来的声量；成本 0 时为 0
  kind: 'star' | 'fix' | 'overinvest' | 'minor';
}

// 同一模块被多卖点引用 → 均分分摊（用户 2026-08-18：同一个模块可能对应不同特性，成本不能重复计算）
export function allocateModuleCosts(
  spModules: { spId: number; module: string }[],
  moduleCosts: Record<string, number>
): { bySp: Record<number, number>; shared: Record<string, number> } {
  const moduleToSps: Record<string, number[]> = {};
  for (const m of spModules) (moduleToSps[m.module] = moduleToSps[m.module] || []).push(m.spId);
  const bySp: Record<number, number> = {};
  const shared: Record<string, number> = {};
  for (const [mod, spIds] of Object.entries(moduleToSps)) {
    const cost = moduleCosts[mod] || 0;
    const n = spIds.length;
    if (n > 1) shared[mod] = n;
    const share = cost / n;
    for (const spId of spIds) bySp[spId] = (bySp[spId] || 0) + share;
  }
  return { bySp, shared };
}

export function classifyKind(count: number, quality: number, cost: number, highCount: number, highCost: number): 'star' | 'fix' | 'overinvest' | 'minor' {
  if (count >= highCount && quality >= 0.6) return 'star';
  if (count >= highCount && quality < 0.6) return 'fix';
  if (count < highCount && cost >= highCost) return 'overinvest';
  return 'minor';
}

export function computeSellingPointRows(input: {
  sps: { id: number; name: string }[];
  modules: Record<number, string[]>;
  dims: Record<number, number[]>;
  moduleCosts: Record<string, number>;
  dimById: Record<number, { name: string; count: number; positive: number; negative: number }>;
}): SellingPointRow[] {
  const spModules: { spId: number; module: string }[] = [];
  for (const sp of input.sps) for (const m of input.modules[sp.id] || []) spModules.push({ spId: sp.id, module: m });
  const { bySp, shared } = allocateModuleCosts(spModules, input.moduleCosts);
  // 高阈值（前 ~30% 分位，客观数据算，不主观定义）
  const countArr = input.sps.map(sp => {
    const ds = input.dims[sp.id] || [];
    return ds.reduce((s, di) => s + (input.dimById[di]?.count || 0), 0);
  }).sort((a, b) => a - b);
  const costArr = input.sps.map(sp => bySp[sp.id] || 0).sort((a, b) => a - b);
  const highCount = countArr[Math.floor(countArr.length * 0.7)] || 1;
  const highCost = costArr[Math.floor(costArr.length * 0.7)] || 1;
  return input.sps.map(sp => {
    const mods = input.modules[sp.id] || [];
    const ds = input.dims[sp.id] || [];
    const dimNames = ds.map(di => input.dimById[di]?.name || '').filter(Boolean);
    let count = 0, positive = 0, negative = 0;
    for (const di of ds) {
      const d = input.dimById[di];
      if (!d) continue;
      count += d.count; positive += d.positive; negative += d.negative;
    }
    const denom = positive + negative;
    const quality = denom > 0 ? positive / denom : 0;
    const cost = bySp[sp.id] || 0;
    const costRatio = cost > 0 ? Math.round((count / (cost / 1000)) * 10) / 10 : 0;
    const sharedModules = mods.filter(m => shared[m]);
    return {
      id: sp.id, name: sp.name, modules: mods, sharedModules, dimNames,
      cost: Math.round(cost * 100) / 100, count, positive, negative, quality, costRatio,
      kind: classifyKind(count, quality, cost, highCount, highCost),
    };
  });
}

// ===== AI 自动匹配：卖点 ↔ 原声维度（语义对应，用户确认） =====
export function buildAiDimMatchPrompt(spNames: string[], dimNames: string[]): { system: string; user: string } {
  const system = '你是产品卖点匹配助手。下面给出一个产品的「卖点清单」和用户原声提炼出的「特性维度清单」。请把每个特性维度匹配到最相关的卖点上：一个维度只归一个卖点；找不到对应卖点的维度不要输出；一个卖点可以对应多个维度。只输出 JSON：{"mappings":[{"selling_point":"卖点名","dimensions":["维度名1","维度名2"]}]}，不要任何其他文字。';
  const user = '卖点清单：\n' + spNames.map((n, i) => (i + 1) + '. ' + n).join('\n') + '\n\n特性维度清单：\n' + dimNames.map((n, i) => (i + 1) + '. ' + n).join('\n') + '\n\n请输出匹配结果 JSON。';
  return { system, user };
}

export function parseAiDimMatch(text: string): { selling_point: string; dimensions: string[] }[] {
  const t = String(text || '').trim();
  if (!t) return [];
  const candidates: any[] = [];
  const tryJSON = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  const segs = [t];
  for (const pair of [['{', '}'], ['[', ']']] as const) {
    const s = t.indexOf(pair[0]); const e = t.lastIndexOf(pair[1]);
    if (s >= 0 && e > s) segs.push(t.slice(s, e + 1));
  }
  for (const seg of segs) {
    for (const v of [seg, seg.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']')]) {
      const p = tryJSON(v); if (p != null) { candidates.push(p); break; }
    }
  }
  for (const c of candidates) {
    let arr: any[] | null = null;
    if (Array.isArray(c)) arr = c;
    else if (c && typeof c === 'object') {
      if (Array.isArray(c.mappings)) arr = c.mappings;
      else if (Array.isArray(c.matches)) arr = c.matches;
    }
    if (!arr) continue;
    const out: { selling_point: string; dimensions: string[] }[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const sp = String(it.selling_point ?? it.name ?? it.sellingPoint ?? it.卖点 ?? '').trim();
      const dims = (Array.isArray(it.dimensions) ? it.dimensions : Array.isArray(it.dims) ? it.dims : Array.isArray(it.voice_dimensions) ? it.voice_dimensions : []).map(String).filter((x: string) => x.trim());
      if (sp && dims.length) out.push({ selling_point: sp, dimensions: dims });
    }
    if (out.length) return out;
  }
  return [];
}

// ===== AI 分析：基于串起来的数据（声量×好评率×成本）给取舍判断 =====
export function buildSellingPointAnalysisPrompt(rows: SellingPointRow[]): { system: string; user: string } {
  const system = '你是产品经理成本顾问。下面是一个产品各「卖点」的客观数据表：声量=多少用户提及（在乎的人多）、好评率=市场反响、成本=该卖点分摊到的 BOM 成本、声量成本比=每千元成本带来的声量。请基于数据给出：①「高价值卖点」（声量高+好评高+成本合理）应重点放大 ②「待改进」（声量高但好评低） ③「过度投入」（成本高但声量低，用户不买账） ④「次要」可精简。要求：每个判断都引用具体数字；不确定就说数据不足；最后给 2-3 条可执行的取舍建议。只依据数据，不编造。';
  const user = '卖点数据表：\n' + rows.map((r, i) => {
    const qp = Math.round(r.quality * 100);
    const sharedNote = r.sharedModules.length ? '（模块「' + r.sharedModules.join('、') + '」与其他卖点共享、成本已分摊）' : '';
    return (i + 1) + '. ' + r.name + '：声量 ' + r.count + '、好评率 ' + qp + '%（正 ' + r.positive + '/负 ' + r.negative + '）、成本 ¥' + r.cost.toFixed(2) + '、声量成本比 ' + r.costRatio + sharedNote;
  }).join('\n') + '\n\n请输出分析结论。';
  return { system, user };
}
