// 报价比对后台识别引擎（v2.3.19+，App 级全局调用）
// 空闲自动 / 导入改价后自动 / 打开项目页自动：全品类扫描，指纹命中跳过，发现差异情报落 part_insights
// 数据安全：全程本地（Ollama 流式经 Rust 代理），无任何云端调用；未配置模型或 Ollama 未运行 → 静默跳过
import { getProjects, getProjectBOMs, getPartAliases, getCompareCache, saveCompareCache, upsertInsight, normalizePartName, getSetting } from './db';
import { startOllamaStream } from './ollama';
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
    console.log('[报价比对] 模型输出未识别出疑似组（视为无）：', text.slice(0, 200).replace(/\n/g, ' '));
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
  await new Promise<void>((resolve, reject) => {
    startOllamaStream(url, model,
      [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      t => { full += t; }, () => {},
      () => resolve(), e => reject(new Error(e)),
      { endpoint: 'native', json: false, think: false, num_predict: 1500, temperature: 0.2 },
    );
  });
  const groups = parseAiGroups(full, ungrouped)
    .filter((g: any) => { const gk = g.rows.map((r: any) => partKey(r)).sort().join(';'); return !negSet.has(gk); });
  return groups;
}

// 差异情报判定：AI 疑似组必报；规则组价差明显（≥¥10 且 ≥10%）也报
export function buildInsights(aiGroups: any[], rows: any[], aliases: any[]): any[] {
  const out: any[] = [];
  aiGroups.forEach((g: any) => {
    const prices = g.rows.map((r: any) => r.cost);
    out.push({ type: 'ai', name: g.name, reason: g.reason, rows: g.rows, diff: Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 });
  });
  buildRuleGroups(rows, aliases).forEach((g: any) => {
    if (g.rows.length < 2) return;
    const prices = g.rows.map((r: any) => r.cost);
    const min = Math.min(...prices); const max = Math.max(...prices);
    const diff = max - min;
    if (diff >= 10 && diff / min >= 0.1) out.push({ type: 'rule', name: g.canonical, reason: '同名同型号报价差异明显', rows: g.rows, diff: Math.round(diff * 100) / 100 });
  });
  return out;
}

export interface AutoCompareResult { scanned: number; insights: number; failed: number; }

/**
 * 全品类后台识别。跳过条件（返回 null，静默）：未配置模型 / Ollama 未运行 / 无 ≥2 项目的品类。
 * onProgress：进度回调（done/total/current）。
 * 识别失败自动重试一次；单模块失败计入 failed 不阻塞队列。
 */
export async function runAutoCompare(onProgress?: (p: { done: number; total: number; current: string }) => void): Promise<AutoCompareResult | null> {
  const model = await getSetting('local_ai_model', '');
  if (!model) return null;
  // Ollama 运行探测：走 Rust http_get 代理（浏览器 fetch 会被 CORS 拦截——localhost:11434 无 Access-Control-Allow-Origin 头）；不可用则静默跳过
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  try {
    const r = await invoke<{ status: number; success: boolean }>('http_get', { request: { url: base + '/api/tags', headers: {}, body: null } });
    if (!r?.success) return null;
  } catch { return null; }
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
  if (jobs.length === 0) return { scanned: 0, insights: 0, failed: 0 };
  let failCount = 0, insightTotal = 0;
  for (let i = 0; i < jobs.length; i++) {
    const { cat, mod, projs } = jobs[i];
    onProgress?.({ done: i, total: jobs.length, current: mod });
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
      if (cache && cache.fingerprint === fp && cache.result_json) {
        try { groups = JSON.parse(cache.result_json); } catch { groups = []; }
      } else {
        try {
          groups = await runAiIdentifyOnce(rows, aliases);
        } catch {
          groups = await runAiIdentifyOnce(rows, aliases); // 自动重试一次
        }
        await saveCompareCache(cat, mod, fp, JSON.stringify(groups));
      }
      const ins = buildInsights(groups, rows, aliases);
      insightTotal += ins.length;
      await upsertInsight(cat, mod, JSON.stringify(ins));
    } catch {
      failCount++;
    }
    onProgress?.({ done: i + 1, total: jobs.length, current: mod });
  }
  return { scanned: jobs.length, insights: insightTotal, failed: failCount };
}
