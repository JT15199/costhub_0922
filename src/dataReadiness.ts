// 数据就绪度诊断（v2.3.19，2026-08-18 用户：引导客户如何使用——发现缺什么数据、缺了能做到什么样、建议是什么）
// 输出：每个能力 有/缺/半 + 现在有什么 + 缺了的影响 + 建议
import { getProjects, getProjectBOMs, getParts, getAllVoiceItems, getProjectSpecTemplates } from './db';
import { getAllPartSuppliers } from './db/parts';
import { getTargets } from './db/projects';
import { getCompetitors, getCompetitorBOMs } from './db/competitors';
import { detectOllama } from './aiStatus';

export interface ReadinessItem {
  key: string;
  name: string;
  level: 'ok' | 'partial' | 'missing';
  have: string;
  impact: string;
  suggestion: string;
}

/** 纯函数：就绪度 → 给模型的文本（工具 query_data_readiness 返回体） */
export function readinessToText(items: ReadinessItem[]): string {
  const levelLabel: Record<string, string> = { ok: '✅ 有', partial: '⚠️ 半', missing: '❌ 缺' };
  return items.map(it => {
    const prefix = it.level === 'ok' ? '现在能：' : '缺了会：';
    return '【' + it.name + '】' + (levelLabel[it.level] || it.level) + '（' + it.have + '）\n- ' + prefix + it.impact + (it.suggestion ? '\n- 建议：' + it.suggestion : '');
  }).join('\n\n');
}

export async function getDataReadiness(): Promise<ReadinessItem[]> {
  const out: ReadinessItem[] = [];

  // 1) AI 大脑（本地模型）
  let st: any = null;
  try { st = await detectOllama(); } catch { }
  const brainOk = !!st?.connected;
  out.push({
    key: 'brain', name: 'AI 大脑（本地模型）',
    level: brainOk ? 'ok' : 'missing',
    have: brainOk ? '已连接：' + (st.model || '模型') : '未配置本地模型',
    impact: brainOk ? '审价/原声/体检/建议等 AI 分析可用' : '所有 AI 分析不可用（审价、原声、卖点价值、体检、自主建议都做不了），只能手动查表',
    suggestion: brainOk ? '' : '设置 → 连接设置 → 配置本地 Ollama 模型（如 qwen3）并启动 Ollama',
  });

  // 2) 项目 + BOM（成本分析）
  let projects: any[] = [];
  try { projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted); } catch { }
  let withBom = 0;
  const cats = new Set<string>();
  for (const p of projects) {
    let b: any[] = [];
    try { b = (await getProjectBOMs(p.id)).filter((x: any) => !x.is_deleted); } catch { }
    if (b.length > 0) { withBom++; if (p.category) cats.add(p.category); }
  }
  out.push({
    key: 'cost', name: '项目成本分析',
    level: withBom === 0 ? 'missing' : 'ok',
    have: '项目 ' + projects.length + ' 个，其中有 BOM 的 ' + withBom + ' 个',
    impact: withBom === 0 ? '看不到任何成本结构/成本构成/报价差异' : '可看成本结构、模块占比、跨项目比价、成本快照',
    suggestion: withBom === 0 ? '项目管理 → 导入 BOM（Excel 或逐条录入）' : (projects.length < 2 ? '想比价：至少再建/录入 1 个同品类项目' : ''),
  });

  // 3) 报价情报（跨项目比价）
  const multiCats = [...cats].filter(c => projects.filter((p: any) => p.category === c).length >= 2).length;
  out.push({
    key: 'compare', name: '报价情报（跨项目比价）',
    level: multiCats > 0 ? 'ok' : 'missing',
    have: '有 ' + multiCats + ' 个品类有 ≥2 个项目',
    impact: multiCats > 0 ? '后台自动比对同物料跨项目价差，红点提醒' : '无法自动比价（同一物料需在 ≥2 个项目里才有价差可报）',
    suggestion: multiCats > 0 ? '' : '再建/录入同品类项目，或用「AI 对话」让我先做单项目成本结构分析',
  });

  // 4) 器件库 + 供应商报价（审价参考）
  let parts: any[] = [];
  try { parts = await getParts(); } catch { }
  let suppliers: any[] = [];
  try { suppliers = await getAllPartSuppliers(); } catch { }
  const partsWithSup = new Set((suppliers || []).map((s: any) => s.part_id)).size;
  out.push({
    key: 'review', name: '审价参考（器件库 + 供应商报价）',
    level: partsWithSup === 0 ? (parts.length === 0 ? 'missing' : 'partial') : 'ok',
    have: '器件 ' + parts.length + ' 种，有供应商报价的 ' + partsWithSup + ' 种',
    impact: partsWithSup > 0 ? '审价可对照本地参考价，判断更准' : '审价只能靠模型品类常识，无本地价格参考（虚高/偏高判断偏主观）',
    suggestion: partsWithSup === 0 ? '器件库 → 给器件录入供应商报价（价格历史），审价就能对照' : '',
  });

  // 5) 用户原声（原声分析/卖点价值）
  let voiceCount = 0;
  try { const items = await getAllVoiceItems(''); voiceCount = items.length; } catch { }
  out.push({
    key: 'voice', name: '用户原声（关注度/声量来源）',
    level: voiceCount === 0 ? 'missing' : 'ok',
    have: '已导入原声 ' + voiceCount + ' 条',
    impact: voiceCount > 0 ? '可分析用户最在意什么、做得好不好（声量/好评率）' : '看不到用户在乎什么——卖点价值分析只剩成本视角（无声量与市场反响）',
    suggestion: voiceCount === 0 ? '用户原声分析 → 导入上一代产品的评价/口碑 Excel（评价/评论/反馈列自动识别）' : '',
  });

  // 6) 目标成本（超支预警）
  let targetProjects = 0;
  for (const p of projects) { try { const t = await getTargets(p.id); if (t.length) targetProjects++; } catch { } }
  out.push({
    key: 'target', name: '目标成本（超支预警）',
    level: targetProjects === 0 ? 'missing' : 'ok',
    have: targetProjects + ' 个项目设了目标成本',
    impact: targetProjects > 0 ? '驾驶舱自动预警超支、AI 建议降本' : '无法判断"贵不贵"——只能看绝对成本，不知道离目标差多少',
    suggestion: targetProjects === 0 ? '项目管理 → 成本分析 → 设目标成本（目标值）' : '',
  });

  // 7) 竞品（对标）
  let competitors: any[] = [];
  try { competitors = await getCompetitors(); } catch { }
  let compWithBom = 0;
  for (const c of competitors) { try { const b = await getCompetitorBOMs(c.id); if (b.length) compWithBom++; } catch { } }
  out.push({
    key: 'bench', name: '竞品对标',
    level: competitors.length === 0 ? 'missing' : (compWithBom === 0 ? 'partial' : 'ok'),
    have: '竞品 ' + competitors.length + ' 个，有 BOM 估算的 ' + compWithBom + ' 个',
    impact: compWithBom > 0 ? '可逐模块对比竞品成本、找差距' : '只能比整机售价，无法看"贵在哪"（需要竞品 BOM 估算）',
    suggestion: competitors.length === 0 ? '竞品管理 → 录入竞品与市场售价' : (compWithBom === 0 ? '竞品管理 → 给竞品做 BOM 估算' : ''),
  });

  // 8) 规格分类（卖点分析靠齐）
  let specCount = 0;
  for (const p of projects) { try { const s = await getProjectSpecTemplates(p.id); if (s.length) specCount += s.length; } catch { } }
  out.push({
    key: 'spec', name: '规格分类（卖点分析靠齐目标）',
    level: specCount === 0 ? 'partial' : 'ok',
    have: specCount > 0 ? '已设 ' + specCount + ' 个规格分类' : '未设规格分类',
    impact: specCount > 0 ? 'AI 卖点分析严格按你的规格分类走，结论更贴近你的产品定义' : 'AI 会自由提炼卖点，可能与你的产品语言不一致（可随时补）',
    suggestion: specCount === 0 ? '用户原声分析 → 卖点价值分析 →「⚙ 规格分类」加几个（如 分辨率/刷新率/色域）' : '',
  });

  return out;
}
