// 卖点价值分析纯函数（v2.3.19，2026-08-18）
// 卖点 = 原声(声量/反响) × BOM(成本) 交叉；成本按模块均分分摊（同模块多卖点不重复计算）

export interface SellingPointRow {
  id: number;
  name: string;
  modules: string[];          // 关联模块
  sharedModules: string[];    // 与其他卖点共享的模块（成本被均分）
  cost: number;               // 分摊后成本（元）
  count: number;              // 声量（提及人数合计）
  positive: number;
  negative: number;
  quality: number;            // 好评率 positive/(positive+negative)，无正负时为 0
  costRatio: number;          // 声量成本比 = count / (cost/1000)，即每千元成本带来的声量；成本 0 时为 0
  kind: 'star' | 'fix' | 'overinvest' | 'minor';
}

// 同一模块被多卖点引用 → 成本分摊（用户 2026-08-18：同一个模块可能对应不同特性）
// ⚠️ 声量加权分摊：模块成本按各卖点声量占比分摊（客观、数据驱动——成本应投向用户在乎的地方）；无声量时均分兜底
export function allocateModuleCosts(
  spModules: { spId: number; module: string }[],
  moduleCosts: Record<string, number>,
  voiceBySp?: Record<number, number>,
): { bySp: Record<number, number>; shared: Record<string, number> } {
  const moduleToSps: Record<string, number[]> = {};
  for (const m of spModules) (moduleToSps[m.module] = moduleToSps[m.module] || []).push(m.spId);
  const bySp: Record<number, number> = {};
  const shared: Record<string, number> = {};
  for (const [mod, spIds] of Object.entries(moduleToSps)) {
    const cost = moduleCosts[mod] || 0;
    const n = spIds.length;
    if (n > 1) shared[mod] = n;
    const totalVoice = spIds.reduce((s, id) => s + (voiceBySp?.[id] || 0), 0);
    for (const spId of spIds) {
      const share = (totalVoice > 0 && (voiceBySp?.[spId] || 0) > 0)
        ? ((voiceBySp![spId] / totalVoice) * cost)
        : (cost / n);
      bySp[spId] = (bySp[spId] || 0) + share;
    }
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
  sps: { id: number; name: string; positive: number; negative: number }[];
  modules: Record<number, string[]>;
  moduleCosts: Record<string, number>;
}): SellingPointRow[] {
  const spModules: { spId: number; module: string }[] = [];
  for (const sp of input.sps) for (const m of input.modules[sp.id] || []) spModules.push({ spId: sp.id, module: m });
  const voiceBySp: Record<number, number> = {};
  for (const sp of input.sps) voiceBySp[sp.id] = (sp.positive || 0) + (sp.negative || 0);
  const { bySp, shared } = allocateModuleCosts(spModules, input.moduleCosts, voiceBySp);
  // 高阈值（前 ~30% 分位，客观数据算，不主观定义）
  const countArr = input.sps.map(sp => (sp.positive || 0) + (sp.negative || 0)).sort((a, b) => a - b);
  const costArr = input.sps.map(sp => bySp[sp.id] || 0).sort((a, b) => a - b);
  const highCount = countArr[Math.floor(countArr.length * 0.7)] || 1;
  const highCost = costArr[Math.floor(costArr.length * 0.7)] || 1;
  return input.sps.map(sp => {
    const mods = input.modules[sp.id] || [];
    const positive = sp.positive || 0;
    const negative = sp.negative || 0;
    const count = positive + negative;
    const quality = count > 0 ? positive / count : 0;
    const cost = bySp[sp.id] || 0;
    const costRatio = cost > 0 ? Math.round((count / (cost / 1000)) * 10) / 10 : 0;
    const sharedModules = mods.filter(m => shared[m]);
    return {
      id: sp.id, name: sp.name, modules: mods, sharedModules,
      cost: Math.round(cost * 100) / 100, count, positive, negative, quality, costRatio,
      kind: classifyKind(count, quality, cost, highCount, highCost),
    };
  });
}

// ===== 模块级价值分析（主视角，2026-08-18）：模块成本精确，声量=该模块支撑卖点的声量合计 =====
// 直接回答"哪个模块好又便宜/差又贵/花得不值"（模块级不需要分摊；卖点级成本才用声量加权分摊）
export interface ModuleValueRow {
  module: string;
  cost: number;
  count: number;
  positive: number;
  negative: number;
  quality: number;
  sellingPoints: string[];
  kind: 'cheap_good' | 'good_expensive' | 'bad' | 'waste' | 'minor';
}

export function computeModuleValueRows(rows: SellingPointRow[], moduleCosts: Record<string, number>): ModuleValueRow[] {
  const modMap: Record<string, { sps: Set<string>; count: number; positive: number; negative: number }> = {};
  for (const r of rows) {
    for (const m of r.modules) {
      const e = modMap[m] = modMap[m] || { sps: new Set(), count: 0, positive: 0, negative: 0 };
      e.sps.add(r.name);
      e.count += r.count;
      e.positive += r.positive;
      e.negative += r.negative;
    }
  }
  const out: ModuleValueRow[] = [];
  for (const [module, e] of Object.entries(modMap)) {
    const cost = moduleCosts[module] || 0;
    const count = e.count;
    const quality = count > 0 ? e.positive / count : 0;
    out.push({ module, cost, count, positive: e.positive, negative: e.negative, quality, sellingPoints: [...e.sps], kind: 'minor' });
  }
  const counts = out.map(x => x.count).sort((a, b) => a - b);
  const costs = out.map(x => x.cost).sort((a, b) => a - b);
  const highCount = counts[Math.floor(counts.length * 0.7)] || 1;
  const highCost = costs[Math.floor(costs.length * 0.7)] || 1;
  for (const x of out) {
    const highVoice = x.count >= highCount;
    const good = x.quality >= 0.6;
    const expensive = x.cost >= highCost;
    if (highVoice && good && !expensive) x.kind = 'cheap_good';          // 好又便宜 → 保留放大
    else if (highVoice && good && expensive) x.kind = 'good_expensive';  // 好但贵 → 降本机会
    else if (highVoice && !good) x.kind = 'bad';                          // 声量高但做得差 → 待改进
    else if (!highVoice && expensive) x.kind = 'waste';                   // 花得不值 → 下代减配/砍
    else x.kind = 'minor';                                                // 次要
  }
  return out;
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
export function buildSellingPointAnalysisPrompt(rows: SellingPointRow[], moduleRows: ModuleValueRow[]): { system: string; user: string } {
  const system = '你是产品经理成本顾问。一个产品（上一代）已上市，以下数据来自其用户原声与 BOM 成本：卖点级（声量=多少用户提及、好评率=市场反响、成本=声量加权分摊）、模块级（成本精确、声量=该模块支撑卖点的声量合计）。上一代无法改变，但它是下一代产品定义的参考——重点找出"成本花得不值"的地方。请输出：①哪些模块「好又便宜」应保留放大 ②哪些「做得好但贵」是降本机会 ③哪些「做得差」（声量高好评低）待改进 ④哪些「花得不值」（成本高但声量低，用户不买账）下代减配/砍 ⑤给下一代产品定义的 2-3 条具体建议。要求：每个判断引用具体数字，不确定说数据不足，只依据数据不编造。';
  const user = '卖点数据表：\n' + rows.map((r, i) => {
    const qp = Math.round(r.quality * 100);
    const sharedNote = r.sharedModules.length ? '（模块「' + r.sharedModules.join('、') + '」共享·声量加权分摊）' : '';
    return (i + 1) + '. ' + r.name + '：声量 ' + r.count + '、好评率 ' + qp + '%（正 ' + r.positive + '/负 ' + r.negative + '）、成本 ¥' + r.cost.toFixed(0) + '、声量成本比 ' + r.costRatio + sharedNote;
  }).join('\n') + '\n\n模块数据表（成本精确）：\n' + moduleRows.map((m, i) => {
    const qp = Math.round(m.quality * 100);
    return (i + 1) + '. ' + m.module + '：成本 ¥' + m.cost.toFixed(0) + '、声量 ' + m.count + '、好评率 ' + qp + '%（正 ' + m.positive + '/负 ' + m.negative + '）、支撑卖点：' + (m.sellingPoints.join('、') || '无');
  }).join('\n') + '\n\n请输出分析结论。';
  return { system, user };
}

// ===== AI 归纳：把原声归类到卖点（卖点优先，避免维度太细、每点声量=1） =====
// 模型只做「每条评价归到哪些卖点 + 正负」，计数由代码精确累加（不靠模型报数，更准）
export function buildAiAggregatePrompt(spNames: string[], items: string[]): { system: string; user: string } {
  const system = '你是产品口碑归纳助手。下面给出一组「卖点清单」和一批用户评价（每条带序号）。请把每条评价归纳到最相关的卖点：一条评价可归到多个卖点，也可归到「其他」；同时判断情感倾向。只输出 JSON：{"items":[{"index":序号,"selling_points":["卖点名"],"sentiment":"positive或negative"}]}，不要任何其他文字。归纳要到位：相近说法（如"颜色准/发黄/偏红"）归同一个卖点，不要把评价原样当卖点，也不要自造清单之外的卖点。';
  const user = '卖点清单：' + spNames.join('、') + '\n\n用户评价：\n' + items.map((it, i) => '[' + i + '] ' + it).join('\n') + '\n\n请输出归纳结果 JSON。';
  return { system, user };
}

// ===== AI 预生成卖点建议：根据品类+档位先给大致特性，用户再编辑采纳（用户 2026-08-18） =====
export function buildAiSuggestPrompt(category: string, tier: string): { system: string; user: string } {
  const system = '你是产品定义专家。根据产品品类和档位，给出这个产品最有价值的卖点清单（卖点 = 用户会为之买单的差异化特性）。只输出 JSON：{"selling_points":[{"name":"卖点名（不超过8字）","description":"一句话说明为什么值钱"}]}，不要任何其他文字。卖点要具体、有差异化，符合该档位的用户预期，不要泛泛而谈。';
  const user = '产品品类：' + (category || '未指定') + '；档位：' + (tier || '未指定') + '。请给出 6-8 个卖点。';
  return { system, user };
}

export function parseAiSuggest(text: string): { name: string; description: string }[] {
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
      if (Array.isArray(c.selling_points)) arr = c.selling_points;
      else if (Array.isArray(c.suggestions)) arr = c.suggestions;
      else if (Array.isArray(c.features)) arr = c.features;
      else for (const k of Object.keys(c)) if (Array.isArray(c[k])) { arr = c[k]; break; }
    }
    if (!arr) continue;
    const out: { name: string; description: string }[] = [];
    for (const it of arr) {
      if (!it) continue;
      if (typeof it === 'string') { out.push({ name: it.trim(), description: '' }); continue; }
      const name = String(it.name ?? it.feature ?? it.title ?? '').trim();
      if (name) out.push({ name, description: String(it.description ?? it.desc ?? '').trim() });
    }
    if (out.length) return out;
  }
  return [];
}

// ===== AI 智能分析（统一流程，2026-08-18）：按品类+档位+BOM 模块，自动给出卖点及对应模块 =====
// 上一代已上市无法改变，其原声×成本 = 下一代产品定义指导；卖点先由 AI 给，用户再修改
export function buildAiUnifiedPrompt(project: { tier?: string; category?: string }, modules: string[]): { system: string; user: string } {
  const system = '你是产品经理。下面是一个产品的品类/档位和 BOM 模块清单。请识别出这个产品最有价值的卖点（用户会为之买单的差异化特性），并为每个卖点关联对应的 BOM 模块：一个卖点可关联多个模块，一个模块也可被多个卖点关联（同一个模块可能支撑不同特性）。只输出 JSON：{"selling_points":[{"name":"卖点名（不超过8字）","description":"一句话说明","modules":["模块名"]}]}，不要任何其他文字。';
  const user = '产品品类：' + (project?.category || '未指定') + '；档位：' + (project?.tier || '未指定') + '\nBOM 模块：' + (modules.join('、') || '无') + '\n\n请给出 5-8 个卖点及对应模块。';
  return { system, user };
}

export function parseAiUnified(text: string): { name: string; description: string; modules: string[] }[] {
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
      if (Array.isArray(c.selling_points)) arr = c.selling_points;
      else if (Array.isArray(c.features)) arr = c.features;
      else for (const k of Object.keys(c)) if (Array.isArray(c[k])) { arr = c[k]; break; }
    }
    if (!arr) continue;
    const out: { name: string; description: string; modules: string[] }[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const name = String(it.name ?? it.feature ?? it.title ?? '').trim();
      if (!name) continue;
      let mods: string[] = [];
      if (Array.isArray(it.modules)) mods = it.modules.map(String);
      else if (it.module) mods = [String(it.module)];
      out.push({ name, description: String(it.description ?? it.desc ?? '').trim(), modules: mods.map(s => s.trim()).filter(Boolean) });
    }
    if (out.length) return out;
  }
  return [];
}

export function parseAiAggregate(text: string): { selling_points: string[]; sentiment: 'positive' | 'negative' }[] {
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
  const normSent = (s: any): 'positive' | 'negative' => {
    const v = String(s || '').trim().toLowerCase();
    if (/neg|negative|差评|吐槽|不满|缺陷|负面/.test(v)) return 'negative';
    return 'positive';
  };
  for (const c of candidates) {
    let arr: any[] | null = null;
    if (Array.isArray(c)) arr = c;
    else if (c && typeof c === 'object') {
      if (Array.isArray(c.items)) arr = c.items;
      else if (Array.isArray(c.results)) arr = c.results;
      else for (const k of Object.keys(c)) if (Array.isArray(c[k])) { arr = c[k]; break; }
    }
    if (!arr) continue;
    const out: { selling_points: string[]; sentiment: 'positive' | 'negative' }[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      let sps: string[] = [];
      if (Array.isArray(it.selling_points)) sps = it.selling_points.map(String);
      else if (Array.isArray(it.dimensions)) sps = it.dimensions.map(String);
      else if (it.selling_point) sps = [String(it.selling_point)];
      sps = sps.map((s: string) => s.trim()).filter(Boolean);
      if (sps.length) out.push({ selling_points: sps, sentiment: normSent(it.sentiment) });
    }
    if (out.length) return out;
  }
  return [];
}
