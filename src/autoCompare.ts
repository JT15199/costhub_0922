// 报价比对后台识别引擎（v2.3.19+，App 级全局调用）
// 空闲自动 / 导入改价后自动 / 打开项目页自动：全品类扫描，指纹命中跳过，发现差异情报落 part_insights
// 数据安全：全程本地（Ollama 流式经 Rust 代理），无任何云端调用；未配置模型或 Ollama 未运行 → 静默跳过
import { getProjects, getProjectBOMs, getPartAliases, getCompareCache, saveCompareCache, upsertInsight, normalizePartName, getSetting } from './db';
import { startOllamaStream, logLocalAICall } from './ollama';
import { invoke } from '@tauri-apps/api/core';

export const partKey = (r: any) => `${normalizePartName(r.name)}|${normalizePartName(r.model)}`;
export const moduleFingerprint = (rows: any[]) => rows.map(r => `${r.project}|${r.name}|${r.model}|${r.cost}|${r.quantity}`).sort().join('\n');

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
  if (groups.length === 0 && text.trim() && !/无/.test(text)) {
  }
  return groups;
}

// 单次 AI 识别（返回疑似组；失败抛错由调用方决定重试）
export async function runAiIdentifyOnce(rows: any[], aliases: any[]): Promise<any[]> {
  const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
  const model = await getSetting('local_ai_model', '');
  if (!model) throw new Error('未配置本地模型——请先在「本地 AI 助手」页配置 Ollama 模型');
  const aliasSet = new Set<string>();
  aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => aliasSet.add(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`));
  const negSet = new Set(aliases.filter((a: any) => a.source === 'marked_different' && a.alias_name.startsWith('#NEG#')).map((a: any) => a.alias_name.slice(5)));
  const ungrouped = rows.filter(r => !aliasSet.has(partKey(r)));
  if (ungrouped.length < 2) return [];
  const sysPrompt = `你是物料识别助手。以下是同一模块下、不同项目的器件清单，部分器件是同一物料但名称/型号写法不同（可能含规格词差异或口语化写法）。
找出"疑似同一物料"的组，输出格式（每行一组，不要任何解释）：
组名|序号1,序号2
例如：27寸液晶面板|0,2,4
规则：1) 每组至少 2 个序号 2) 每行只能出现在一组 3) 不确定就不要列出 4) 没有疑似组就只输出"无"`;
  const userPrompt = ungrouped.map((r, i) => `[${i}] ${r.project} | ${r.name} | ${r.model} | ¥${r.cost}`).join('\n');
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
    const timer = setTimeout(() => finish(() => reject(new Error('识别超时（60s）——模型响应太慢，该模块已跳过，可稍后手动重试'))), 60000);
    startOllamaStream(url, model,
      [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      t => { full += t; }, () => {},
      () => finish(resolve), e => finish(() => reject(new Error(e))),
      { endpoint: 'native', json: false, think: false, num_predict: 1500, temperature: 0.2 },
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

// 差异情报判定：AI 疑似组必报（已人工确认的行先过滤——确认后该组应消失，不再打扰）；
// 规则组价差明显（≥¥10 且 ≥10%）也报
export function buildInsights(aiGroups: any[], rows: any[], aliases: any[]): any[] {
  const out: any[] = [];
  // 已确认别名集合（user_confirmed → alias 归到 canonical，这些行不再算疑似）
  const confirmed = new Set<string>();
  aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => confirmed.add(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`));
  aiGroups.forEach((g: any) => {
    const unconfirmed = (g.rows || []).filter((r: any) => !confirmed.has(partKey(r)));
    if (unconfirmed.length < 2) return; // 整组已确认 → 情报消失
    const prices = unconfirmed.map((r: any) => r.cost);
    out.push({ type: 'ai', name: g.name, reason: g.reason, rows: unconfirmed, diff: Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 });
  });
  buildRuleGroups(rows, aliases).forEach((g: any) => {
    if (g.rows.length < 2) return;
    // 全部行都已被用户确认归组 → 该组已处理，不再提醒（与 rebuildModuleInsight 过滤一致，防止后台轮询让已确认组重现）
    if ((g.rows || []).every((r: any) => confirmed.has(partKey(r)))) return;
    const prices = g.rows.map((r: any) => r.cost);
    const min = Math.min(...prices); const max = Math.max(...prices);
    const diff = max - min;
    if (diff >= 10 && diff / min >= 0.1) out.push({ type: 'rule', name: g.canonical, reason: '同名同型号报价差异明显', rows: g.rows, diff: Math.round(diff * 100) / 100 });
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
          rows.push({ project: p.code || p.name, projectId: p.id, name: b.part_name, model: b.part_model || '', cost: b.part_cost || 0, quantity: b.quantity || 1 });
        });
      }
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
