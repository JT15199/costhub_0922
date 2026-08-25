// 报价比对后台识别引擎（v2.3.19+，App 级全局调用）
// 空闲自动 / 导入改价后自动 / 打开项目页自动：全品类扫描，指纹命中跳过，发现差异情报落 part_insights
// 数据安全：全程本地（Ollama 流式经 Rust 代理），无任何云端调用；未配置模型或 Ollama 未运行 → 静默跳过
// 2026-08-17 v3 升级（用户反馈）：
//   ① AI 输入排除"完全同名同型号"行（确定同一物料由规则组覆盖，AI 只认"看起来差不多但写法不同"的）
//   ② 识别优先同子类（都是接口/电容/电阻…），不同子类即使名称接近也不算同一；规格多指标顺序不一致按内容集合判断
//   ③ 逐行"不是同一器件"：#ROWDIFF# 别名沉淀，该行从情报/识别消失（可撤销）
//   ④ 尺寸类物料（PCB/结构件带 W×H mm/cm）按单位面积成本归一，评估"按同样尺寸成本应该是什么样"
import { getProjects, getProjectBOMs, getPartAliases, getCompareCache, saveCompareCache, upsertInsight, normalizePartName, getSetting, getPartsSpecsMap } from './db';
import { startOllamaStream, logLocalAICall } from './ollama';
import { invoke } from '@tauri-apps/api/core';

export const partKey = (r: any) => `${normalizePartName(r.name)}|${normalizePartName(r.model)}`;
// v3 前缀：识别规则升级（排除完全一致行/同子类优先）后强制旧缓存失效，重新识别一轮
export const moduleFingerprint = (rows: any[]) => 'v3|' + rows.map(r => `${r.project}|${r.name}|${r.model}|${r.cost}|${r.quantity}`).sort().join('\n');

// 逐行否定集合（用户标记"该行不是同一器件"→ #ROWDIFF#<partKey>；2026-08-17）
export function getRowDiffSet(aliases: any[]): Set<string> {
  const s = new Set<string>();
  aliases.filter((a: any) => a.source === 'marked_different' && a.alias_name.startsWith('#ROWDIFF#')).forEach((a: any) => s.add(a.alias_name.slice(9)));
  return s;
}

// ===== 尺寸类物料按同样尺寸评估成本（2026-08-17，用户需求：PCB/结构件带明显尺寸，可按面积归一） =====
// 支持 200×150mm / 200*150MM / 12.5x8.5cm / 150x90mm / 7英寸 等；英寸按 2.54cm 换算
const DIM_RE = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米|inch|inches|英寸|寸|in)["”]?/i;
export function parseDimension(text: string): { w: number; h: number; areaCm2: number; unit: string; label: string } | null {
  if (!text) return null;
  const m = text.match(DIM_RE);
  if (!m) return null;
  const w = parseFloat(m[1]), h = parseFloat(m[2]);
  if (!w || !h) return null;
  const u = m[3].toLowerCase();
  const mm = u === 'mm' || u === '毫米';
  const cm = u === 'cm' || u === '厘米';
  const wCm = mm ? w / 10 : cm ? w : w * 2.54;
  const hCm = mm ? h / 10 : cm ? h : h * 2.54;
  return { w, h, areaCm2: Math.round(wCm * hCm * 100) / 100, unit: m[3], label: `${w}×${h}${m[3]}` };
}

// 尺寸归一评估：组内 ≥2 行有尺寸 → 以单位面积成本（¥/cm²）中位数为参考口径，折算"按同样尺寸"的成本对比
// 返回 null = 无足够尺寸信息；note 供情报卡片直接展示
export function dimensionAnalysis(rows: { project?: string; name?: string; model?: string; specs?: string; cost: number }[]): { note: string } | null {
  const dims = rows.map(r => {
    const d = parseDimension(`${r.specs || ''} ${r.name || ''} ${r.model || ''}`);
    if (!d) return null;
    const cost = Number(r.cost) || 0;
    return { row: r, ...d, unitCost: d.areaCm2 > 0 ? cost / d.areaCm2 : 0 };
  }).filter((x: any): x is any => !!x && x.areaCm2 > 0);
  if (dims.length < 2) return null;
  const sorted = [...dims].sort((a: any, b: any) => a.unitCost - b.unitCost);
  const med = sorted[Math.floor(sorted.length / 2)].unitCost;
  const parts = dims.map((d: any) => `${d.row.project || '?'} ${d.label} ¥${(Number(d.row.cost) || 0).toFixed(2)}（¥${d.unitCost.toFixed(4)}/cm²）`);
  const note = `📐 按同样尺寸评估：参考单位面积 ¥${med.toFixed(4)}/cm²（中位）—— ` + parts.join(' / ');
  return { note };
}

// 规则分组：已确认别名 + 归一化同名同型号 → 直接归组（免费实时，不用 AI）
export function buildRuleGroups(rows: any[], aliases: any[]) {
  const aliasMap = new Map<string, { name: string; model: string }>();
  aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => {
    aliasMap.set(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`, { name: a.canonical_name, model: a.canonical_model });
  });
  const groups: Record<string, any[]> = {};
  const order: string[] = [];
  rows.forEach(r => {
    const mapped = aliasMap.get(partKey(r));
    const key = mapped ? `${mapped.name}|${mapped.model}` : partKey(r);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push({ ...r, _canonical: mapped ? mapped.name : r.name });
  });
  return order.map(k => ({ key: k, canonical: groups[k][0]._canonical, rows: groups[k] }));
}

function extractJsonText(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  return s >= 0 && e > s ? t.slice(s, e + 1) : t;
}
// 健壮 JSON 解析：本地模型输出常带 中文引号/单引号/尾逗号/BOM，逐级清洗降级
function robustJsonParse(text: string): any {
  const t = extractJsonText(text);
  const clean = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/^﻿/, '').trim();
  const attempts = [
    () => JSON.parse(t),
    () => JSON.parse(clean(t)),
    () => JSON.parse(clean(t).replace(/,(\s*[}\]])/g, '$1')),                    // 尾逗号
    () => JSON.parse(clean(t).replace(/,(\s*[}\]])/g, '$1').replace(/'/g, '"')), // 单引号 → 双引号
  ];
  for (const fn of attempts) { try { return fn(); } catch { /* 下一级 */ } }
  throw new Error('模型输出无法解析为 JSON');
}
// 解析 AI 输出为疑似组：优先 JSON（兼容），失败降级为纯文本行格式（组名|序号1,序号2）
// 解析不出 = 未发现疑似组（模型回显输入清单/格式不符时保守处理，不报错打扰用户）
function parseAiGroups(text: string, ungrouped: any[]): any[] {
  try {
    const data = robustJsonParse(text);
    if (data && Array.isArray(data.groups)) {
      const gs = data.groups.filter((g: any) => Array.isArray(g.rows) && g.rows.length >= 2)
        .map((g: any) => ({ name: String(g.name || '疑似组'), reason: String(g.reason || ''), rows: (g.rows as number[]).map(i => ungrouped[Number(i)]).filter(Boolean) }))
        .filter((g: any) => g.rows.length >= 2);
      if (gs.length > 0 || /"groups"/.test(text)) return gs;
    }
  } catch { /* 降级文本解析 */ }
  const groups: any[] = [];
  text.split('\n').forEach(line => {
    const l = line.trim();
    if (!l || l === '无' || /没有|无疑似/.test(l)) return;
    const m = l.match(/^(.{1,40}?)[|:：]\s*([0-9][0-9\s,，、]*)$/);
    if (!m) return;
    const idxs = (m[2].match(/\d+/g) || []).map(Number).filter(i => i >= 0 && i < ungrouped.length);
    if (idxs.length >= 2) groups.push({ name: m[1].trim(), reason: '', rows: idxs.map(i => ungrouped[i]) });
  });
  return groups;
}

// 单次 AI 识别（返回疑似组；失败抛错由调用方决定重试）
export async function runAiIdentifyOnce(rows: any[], aliases: any[]): Promise<any[]> {
  const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
  const model = await getSetting('local_ai_model', '');
  if (!model) throw new Error('未配置本地模型——请在 系统设置 → 连接设置 配置 Ollama 模型');
  const aliasSet = new Set<string>();
  aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => aliasSet.add(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`));
  const negSet = new Set(aliases.filter((a: any) => a.source === 'marked_different' && a.alias_name.startsWith('#NEG#')).map((a: any) => a.alias_name.slice(5)));
  const rowDiff = getRowDiffSet(aliases);
  // 完全同名同型号的行（跨项目重复出现）→ 规则组已覆盖（确定同一物料，价差是谈判信息），不进 AI 输入
  const exactCount = new Map<string, number>();
  rows.forEach(r => { const k = partKey(r); exactCount.set(k, (exactCount.get(k) || 0) + 1); });
  const ungrouped = rows.filter(r => {
    const k = partKey(r);
    return !aliasSet.has(k) && !rowDiff.has(k) && (exactCount.get(k) || 0) < 2;
  });
  if (ungrouped.length < 2) return [];
  const sysPrompt = `你是物料识别助手。以下是同一模块下、不同项目的器件清单，部分器件是同一物料但名称/型号/规格写法不同（可能含规格词差异、指标顺序不同或口语化写法）。
找出"疑似同一物料"的组，输出格式（每行一组，不要任何解释）：
组名|序号1,序号2
例如：27寸液晶面板|0,2,4
规则：
1) 必须是同一种器件才能归组：优先看子类——都是接口、都是电容、都是电阻等；不同子类即使名称接近也不算同一物料
2) 名称与型号完全一样的行不要列入（那是确定同一物料，无需识别）
3) 名称/规格相近、可能因写法或顺序不同表达同一器件的才列入（如"27寸液晶面板"与"27英寸LCD屏"；"24V 3A 适配器"与"3A 24V 适配器"）
4) 同一器件可能有多个指标规格但书写顺序不一致，按规格内容集合判断是否同一
5) 每组至少 2 个序号；每行只能出现在一组；不确定就不要列出；没有疑似组就只输出"无"`;
  const userPrompt = ungrouped.map((r, i) => `[${i}] ${r.project} | ${r.name} | ${r.model} | 子类:${r.sub_category || '未知'} | ¥${r.cost}${r.specs ? ' | 规格:' + r.specs : ''}`).join('\n');
  let full = '';
  // 单模块超时（60s）：模型太慢/卡住时直接跳过，不拖住整轮识别；超时后取消流监听
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let cleanupFn: (() => void) | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (typeof cleanupFn === 'function') cleanupFn(); } catch { /* 取消监听失败忽略 */ }
      fn();
    };
    // ⚠️ 不截断：num_predict 已提到 16384；超时仅作极宽松护栏（10 分钟），慢模型不会被误杀（用户 2026-08-18：所有本地 AI 不要截断，只要在线有输出就等）
    const timer = setTimeout(() => finish(() => reject(new Error('识别超时（10 分钟）——模型响应异常缓慢，该模块将在下一轮自动续试'))), 600000);
    startOllamaStream(url, model,
      [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      t => { full += t; }, () => {},
      () => finish(resolve), e => finish(() => reject(new Error(e))),
      { endpoint: 'native', json: false, think: false, num_predict: 16384, temperature: 0.2 },
    ).then(fn => { cleanupFn = fn; }).catch(() => { /* 错误会走 onError */ });
  });
  const groups = parseAiGroups(full, ungrouped)
    .filter((g: any) => { const gk = g.rows.map((r: any) => partKey(r)).sort().join(';'); return !negSet.has(gk); });
  logLocalAICall({
    request_type: 'quote_compare',
    material_name: rows[0]?.name || '',
    system_prompt: sysPrompt,
    user_prompt: userPrompt,
    response_summary: `疑似组 ${groups.length} 个`,
    success: true,
    model_name: model,
  });
  return groups;
}

// 差异情报判定：AI 疑似组必报（已确认/已逐行否定的行先过滤）；规则组价差明显（≥¥10 且 ≥10%）也报；
// 组内 ≥2 行有尺寸 → 附加 dimension（按同样尺寸评估）
export function buildInsights(aiGroups: any[], rows: any[], aliases: any[]): any[] {
  const out: any[] = [];
  // 已确认别名集合（user_confirmed → alias 归到 canonical，这些行不再算疑似）
  const confirmed = new Set<string>();
  aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => confirmed.add(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`));
  const rowDiff = getRowDiffSet(aliases);
  const okRow = (r: any) => !confirmed.has(partKey(r)) && !rowDiff.has(partKey(r));
  aiGroups.forEach((g: any) => {
    const unconfirmed = (g.rows || []).filter(okRow);
    if (unconfirmed.length < 2) return; // 整组已确认/被逐行否定 → 情报消失
    const prices = unconfirmed.map((r: any) => r.cost);
    const ins: any = { type: 'ai', name: g.name, reason: g.reason, rows: unconfirmed, diff: Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 };
    const dim = dimensionAnalysis(unconfirmed);
    if (dim) ins.dimension = dim.note;
    out.push(ins);
  });
  buildRuleGroups(rows, aliases).forEach((g: any) => {
    const kept = (g.rows || []).filter(okRow);
    if (kept.length < 2) return;
    // 全部行都已被用户确认归组 → 该组已处理，不再提醒（与 rebuildModuleInsight 过滤一致，防止后台轮询让已确认组重现）
    if (kept.every((r: any) => confirmed.has(partKey(r)))) return;
    const prices = kept.map((r: any) => r.cost);
    const min = Math.min(...prices); const max = Math.max(...prices);
    const diff = max - min;
    if (diff >= 10 && diff / min >= 0.1) {
      const ins: any = { type: 'rule', name: g.canonical, reason: '同名同型号报价差异明显', rows: kept, diff: Math.round(diff * 100) / 100 };
      const dim = dimensionAnalysis(kept);
      if (dim) ins.dimension = dim.note;
      out.push(ins);
    }
  });
  return out;
}

export interface AutoCompareResult { scanned: number; insights: number; failed: number; remaining: number; }

/**
 * 全品类后台识别。跳过条件（返回 null，静默）：未配置模型 / Ollama 未运行 / 无 ≥2 项目的品类。
 * onProgress：进度回调（done/total/current）。
 * 识别失败自动重试一次；单模块失败计入 failed 不阻塞队列。
 */
export async function runAutoCompare(onProgress?: (p: { done: number; total: number; current: string; remaining?: number }) => void): Promise<AutoCompareResult | null> {
  const model = await getSetting('local_ai_model', '');
  if (!model) return null;
  // Ollama 运行探测：走 Rust http_get 代理（浏览器 fetch 会被 CORS 拦截——localhost:11434 无 Access-Control-Allow-Origin 头）；不可用则静默跳过
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  // 探测：配置 localhost 时先试 127.0.0.1（IP 字面量绕过公司代理/DNS，避免 localhost 被转发到代理 → 504），失败再试配置地址
  const candidates = [...new Set([
    ...(base.includes('localhost') ? ['http://127.0.0.1:11434'] : []),
    base,
    'http://127.0.0.1:11434',
  ])];
  let reachable = false;
  for (const u of candidates) {
    try {
      const r = await invoke<{ status: number; success: boolean }>('http_get', { request: { url: u + '/api/tags', headers: {}, body: null } });
      if (r?.success) { reachable = true; break; }
    } catch { /* 试下一个 */ }
  }
  if (!reachable) return null;
  const projs = await getProjects('', '', '');
  const cats = [...new Set(projs.filter((p: any) => !p.is_deleted).map((p: any) => p.category || '未分类'))];
  const jobs: { cat: string; mod: string; projs: any[] }[] = [];
  for (const cat of cats) {
    const sameCat = projs.filter((p: any) => (p.category || '未分类') === cat);
    if (sameCat.length < 2) continue;
    const mods = new Set<string>();
    for (const p of sameCat) {
      const boms = await getProjectBOMs(p.id);
      boms.forEach((b: any) => { if (b.module_name) mods.add(b.module_name); });
    }
    mods.forEach(m => jobs.push({ cat, mod: m, projs: sameCat }));
  }
  if (jobs.length === 0) return { scanned: 0, insights: 0, failed: 0, remaining: 0 };
  // 分批识别：每轮最多识别 BATCH_SIZE 个"需要 AI"的模块（缓存命中秒过不计批容量）。
  // 一轮跑完即停，App 60 秒轮询自动续下一批 → 结果渐进出现，不会一次转半天；单模块超时/失败跳过不阻塞。
  const BATCH_SIZE = 3;
  let failCount = 0, insightTotal = 0, scannedCount = 0, aiBatch = 0, i = 0;
  for (; i < jobs.length && aiBatch < BATCH_SIZE; i++) {
    const { cat, mod, projs } = jobs[i];
    try {
      const rows: any[] = [];
      for (const p of projs) {
        const boms = await getProjectBOMs(p.id);
        boms.filter((b: any) => b.module_name === mod).forEach((b: any) => {
          rows.push({ project: p.code || p.name, projectId: p.id, name: b.part_name, model: b.part_model || '', sub_category: b.sub_category || '', cost: b.part_cost || 0, quantity: b.quantity || 1, partId: b.part_id || 0 });
        });
      }
      try {
        const specsMap = await getPartsSpecsMap(rows.map((r: any) => r.partId));
        rows.forEach((r: any) => { r.specs = specsMap[r.partId] || ''; });
      } catch { /* 规格缺失不阻断识别 */ }
      const fp = moduleFingerprint(rows);
      const aliases = await getPartAliases(mod);
      const cache = await getCompareCache(cat, mod);
      let groups: any[] = [];
      const needsAI = !(cache && cache.fingerprint === fp && cache.result_json);
      if (!needsAI) {
        try { groups = JSON.parse(cache.result_json); } catch { groups = []; }
      } else {
        aiBatch++; // 计入批容量（无论成败，防止坏模块占满整轮）
        // ⚠️ 只对"真正需要 AI 识别"的模块报进度（2026-08-17 修复：缓存全命中时不再闪现"正在识别"进度条/任务广播）
        onProgress?.({ done: i, total: jobs.length, current: mod, remaining: jobs.length - i });
        try {
          groups = await runAiIdentifyOnce(rows, aliases);
        } catch (e: any) {
          if (String(e?.message || '').includes('超时')) throw e; // 超时是模型太慢，直接跳过不重试
          groups = await runAiIdentifyOnce(rows, aliases); // 其他偶发错误自动重试一次
        }
        await saveCompareCache(cat, mod, fp, JSON.stringify(groups));
        onProgress?.({ done: i + 1, total: jobs.length, current: mod, remaining: jobs.length - i - 1 });
      }
      const ins = buildInsights(groups, rows, aliases);
      insightTotal += ins.length;
      await upsertInsight(cat, mod, JSON.stringify(ins));
      scannedCount++;
    } catch {
      failCount++;
    }
  }
  return { scanned: scannedCount, insights: insightTotal, failed: failCount, remaining: Math.max(0, jobs.length - i) };
}
