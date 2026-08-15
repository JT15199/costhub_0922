// 本地-云端 AI 桥（工具亮点）：本地模型读全库 → 脱敏意图 → 云端行业洞察 → 本地模型结合本地数据出最终建议
// 安全设计：云端 prompt 是固定模板，只有 物料名/品类/问题 三个字段位（成本/供应商/项目代号在模板里没有位置）；
//          发送前正则审计兜底，命中敏感模式即拦截；全程 logLocalAICall 留痕可审计
import { invoke } from '@tauri-apps/api/core';
import { getSetting } from './db/settings';
import { logLocalAICall } from './ollama';
import { saveBridgeLog, getRecentBridgeLog, getBridgeLogsByMaterial, materialKey } from './db/advisor';

// ==================== 敏感审计（纯函数，可测） ====================
export const SENSITIVE_PATTERNS: { re: RegExp; desc: string }[] = [
  { re: /[¥￥]\s*\d+(?:\.\d+)?/, desc: '金额（¥/￥）' },
  { re: /\b\d+(?:\.\d+)?\s*(?:元|块钱)\b/, desc: '金额（元）' },
  { re: /\b\d+(?:\.\d+)?\s*(?:-|~|至|到)\s*\d+(?:\.\d+)?(?!(?:\s*(?:月|年|周|天|日|小时)))/, desc: '价格区间' },
  { re: /(?:成本|单价|采购价|报价|价格)\s*[:：]?\s*\d/, desc: '成本类数字' },
  { re: /(?:供应商|份额|占比|项目代号|项目名)\s*[:：]?\s*\S/, desc: '供应商/项目信息' },
];
export interface AuditResult { safe: boolean; matches: { pattern: string; sample: string }[]; }

// 严格审计（建议提示词用）：在 auditSensitive 基础上增加 器件型号/规格 检测——
// 型号可反查料号与供应商，属于敏感信息，不得出现在可外传的提示词中
export function auditPromptStrict(text: string): AuditResult {
  const base = auditSensitive(text);
  if (!base.safe) return base;
  const extra = [
    { re: /\b[A-Z]{1,6}[0-9][A-Z0-9\-]{2,}\b/, desc: '器件型号' },
    { re: /\d+\s*(?:寸|英寸|mm|MHz|GHz|Hz|nm)\b/, desc: '规格参数' },
  ];
  for (const p of extra) {
    const m = text.match(p.re);
    if (m) { base.safe = false; base.matches.push({ pattern: p.desc, sample: m[0].slice(0, 40) }); }
  }
  return base;
}

export function auditSensitive(text: string): AuditResult {
  const matches: { pattern: string; sample: string }[] = [];
  for (const p of SENSITIVE_PATTERNS) {
    const m = text.match(p.re);
    if (m) matches.push({ pattern: p.desc, sample: m[0].slice(0, 40) });
  }
  return { safe: matches.length === 0, matches };
}

// ==================== 脱敏模板（云端只收到白名单字段） ====================
export function sanitizeForCloud(intent: { material_name: string; category: string; question: string }): string {
  return [
    '物料名称：' + (intent.material_name || '').trim().slice(0, 100),
    '品类：' + (intent.category || '').trim().slice(0, 50),
    '查询问题：' + (intent.question || '').trim().slice(0, 200),
    '请基于最新公开行业信息，给出该物料：1) 价格走势方向（近1-3月）2) 幅度区间 3) 供需状况 4) 主要影响因素。只基于公开行业信息回答，不得推断我司成本。',
  ].join('\n');
}

// ==================== 本地模型调用（Ollama 非流式） ====================
async function localChat(systemPrompt: string, userPrompt: string, reqType: string, material?: string): Promise<string> {
  const model = await getSetting('local_ai_model', '');
  if (!model) throw new Error('未配置本地模型');
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  const resp = await invoke<{ status: number; body: string; success: boolean }>('http_post', {
    request: {
      url: base + '/api/chat',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], stream: false, options: { temperature: 0.2 } }),
    },
  });
  if (!resp.success) throw new Error('HTTP ' + resp.status);
  const content: string = (JSON.parse(resp.body)?.message?.content) || '';
  await logLocalAICall({
    request_type: reqType,
    material_name: material,
    system_prompt: systemPrompt.slice(0, 800),
    user_prompt: userPrompt.slice(0, 3000),
    response_summary: content.slice(0, 800),
    success: true,
    model_name: model,
  });
  return content;
}

function parseJsonObj(text: string): any {
  const t = text.trim().replace(/^\uFEFF/, '');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  const core = s >= 0 && e > s ? body.slice(s, e + 1) : body;
  const attempts = [
    () => JSON.parse(core),
    () => JSON.parse(core.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,([\s]*[}\]])/g, '$1')),
  ];
  for (const fn of attempts) { try { return fn(); } catch { /* 下一级 */ } }
  return null;
}

// ==================== 三步链路 ====================
export interface BridgedInsightResult {
  cloud: any;
  local: {
    verdict: string;          // 机会 / 风险 / 中性
    target_price: string;
    risk: string;
    actions: string[];
    raw: string;
  };
  cloudPrompt: string;        // 实际发送云端的脱敏提示词
  audited: boolean;
  usedLocalIntent: boolean;
  reused?: boolean;           // 是否复用了历史洞察（防重复查询云端）
  reuseOf?: any;              // 复用的来源记录
}

// 第一步：本地模型读建议卡上下文（含本地数据 + 历史洞察）→ 产出脱敏意图（只输出物料名/品类/问题）
// 历史注入：本地模型能看到上次洞察结论，判断本次是否重复——同题则标记 reuse，避免云端重复查询
export async function extractLocalIntent(ins: any, history: any[] = []): Promise<{ material_name: string; category: string; question: string; usedLocal: boolean; reuse?: boolean }> {
  const fallback = {
    material_name: ins?.ref_name || '',
    category: '',
    question: '该物料近期价格走势、供需状况与主要影响因素',
    usedLocal: false,
  };
  try {
    const sys = '你是成本分析助手。以下是本地发现的成本机会点（仅用于理解，绝不外传）与历史洞察记录。你的任务：判断需要向外部行业知识库查询什么。只输出 JSON：{"reuse":true}（若本次查询问题与历史重复且无需更新）；否则 {"material_name":"对外查询的物料名称（可含通用型号，不得含成本/金额/供应商/项目信息）","category":"物料品类","question":"要查询的具体问题（一句话）"}。不得输出任何其他文字。';
    const historyBlock = history.length > 0
      ? '\n历史洞察（同物料，仅参考，判断是否重复）：\n' + history.map(h => `- ${(h.created_at || '').slice(0, 16)}：方向 ${(() => { try { return JSON.parse(h.cloud_result || '{}').trend_direction || '未知'; } catch { return '未知'; } })()}，判定 ${h.verdict || '未知'}`).join('\n')
      : '';
    const user = `本地机会点：${ins?.title || ''}\n详情：${(ins?.detail || '').slice(0, 600)}${historyBlock}\n\n请输出查询意图 JSON。`;
    const raw = await localChat(sys, user, 'bridge_intent', ins?.ref_name);
    const parsed = parseJsonObj(raw);
    if (parsed && parsed.reuse === true) {
      return { ...fallback, usedLocal: true, reuse: true };
    }
    if (parsed && typeof parsed.material_name === 'string' && parsed.material_name.trim()) {
      return {
        material_name: parsed.material_name.trim().slice(0, 100),
        category: String(parsed.category || '').trim().slice(0, 50),
        question: String(parsed.question || '').trim().slice(0, 200) || fallback.question,
        usedLocal: true,
      };
    }
  } catch (e) {
    console.warn('本地意图提取失败（降级为规则意图）:', e);
  }
  return fallback;
}

// 第三步：本地模型结合本地数据 + 云端洞察 → 最终建议
export async function summarizeWithLocal(ins: any, cloud: any): Promise<BridgedInsightResult['local']> {
  const fallback: BridgedInsightResult['local'] = {
    verdict: '中性',
    target_price: '',
    risk: '',
    actions: [cloud?.suggested_action || ''].filter(Boolean),
    raw: '',
  };
  try {
    const sys = '你是资深成本经理。结合"本地数据"（仅本地，不外传）与"行业洞察"（外部查询结果），给出最终议价建议。只输出 JSON：{"verdict":"机会/风险/中性","target_price":"目标谈判价建议（不含具体金额数字，用策略描述如：按近期低位谈判）","risk":"风险等级与要点","actions":["行动1","行动2","行动3"]}。不得输出任何其他文字。';
    const user = `本地数据：${ins?.title || ''} \n${(ins?.detail || '').slice(0, 500)}\n\n行业洞察：方向 ${cloud?.trend_direction || '未知'}，置信度 ${cloud?.confidence_level || '未知'}${cloud?.magnitude_min != null ? `，幅度 ${cloud.magnitude_min}%~${cloud.magnitude_max}%` : ''}\n${cloud?.summary || ''}\n建议：${cloud?.suggested_action || ''}\n\n请输出最终建议 JSON。`;
    const raw = await localChat(sys, user, 'bridge_summary', ins?.ref_name);
    const parsed = parseJsonObj(raw);
    if (parsed) {
      return {
        verdict: String(parsed.verdict || '中性'),
        target_price: String(parsed.target_price || ''),
        risk: String(parsed.risk || ''),
        actions: Array.isArray(parsed.actions) ? parsed.actions.map(String).slice(0, 3) : [],
        raw,
      };
    }
  } catch (e) {
    console.warn('本地总结失败（降级为云端结论）:', e);
  }
  return fallback;
}

// 主入口：三步链路（onNeedReview 返回 true=用户确认放行；force=true 强制重新洞察）
export async function runBridgedInsight(
  ins: any,
  opts: { onProgress?: (m: string) => void; onNeedReview?: (prompt: string) => Promise<boolean>; force?: boolean } = {},
): Promise<BridgedInsightResult> {
  const { onProgress, onNeedReview, force } = opts;
  const key = materialKey(ins?.ref_name || '', '');
  // 复用检查：同一物料近期（7 天）已洞察过且未强制 → 直接复用，不再查云端
  const recent = await getRecentBridgeLog(key, 7);
  if (recent && !force) {
    onProgress?.(`♻ 该物料 ${(recent.created_at || '').slice(0, 16)} 已洞察（判定 ${recent.verdict || '未知'}），直接复用，不再重复查询云端`);
    let cloud: any = {};
    try { cloud = JSON.parse(recent.cloud_result || '{}'); } catch { cloud = {}; }
    let local: BridgedInsightResult['local'] = { verdict: recent.verdict || '中性', target_price: '', risk: '', actions: [], raw: '' };
    try { const lr = JSON.parse(recent.local_result || '{}'); if (lr) local = { ...local, ...lr }; } catch { /* 保持默认 */ }
    return { cloud, local, cloudPrompt: '', audited: true, usedLocalIntent: false, reused: true, reuseOf: recent };
  }
  // 第一步：本地意图（注入历史洞察，让模型判断是否重复；无本地模型时降级规则意图）
  onProgress?.('① 本地模型判断查询意图…');
  const history = await getBridgeLogsByMaterial(key, 3);
  const intent = await extractLocalIntent(ins, history);
  // 本地模型判定"同题无需更新"且存在历史 → 复用
  if (intent.reuse && recent) {
    onProgress?.('本地模型判定与上次洞察重复，直接复用');
    let cloud: any = {};
    try { cloud = JSON.parse(recent.cloud_result || '{}'); } catch { cloud = {}; }
    let local: BridgedInsightResult['local'] = { verdict: recent.verdict || '中性', target_price: '', risk: '', actions: [], raw: '' };
    try { const lr = JSON.parse(recent.local_result || '{}'); if (lr) local = { ...local, ...lr }; } catch { /* 保持默认 */ }
    return { cloud, local, cloudPrompt: '', audited: true, usedLocalIntent: true, reused: true, reuseOf: recent };
  }
  // 第二步：脱敏模板 + 发送前审计
  const cloudPrompt = sanitizeForCloud(intent);
  const audit = auditSensitive(cloudPrompt);
  if (!audit.safe) {
    const detail = audit.matches.map(m => m.pattern + '(' + m.sample + ')').join('、');
    throw new Error('发送前审计拦截：提示词疑似含敏感数据（' + detail + '），已阻止发送');
  }
  if (onNeedReview) {
    const ok = await onNeedReview(cloudPrompt);
    if (!ok) throw new Error('已取消发送（预览确认）');
  }
  // 第二步后半：云端洞察
  onProgress?.('② 云端行业洞察（搜索+分析，约 1-3 分钟）…');
  const { agentSearchLoop } = await import('./trendService');
  const cloud = await agentSearchLoop(intent.material_name, intent.category, 'price-trend', m => onProgress?.('② ' + m));
  // 第三步：本地总结
  onProgress?.('③ 本地模型结合本地数据出最终建议…');
  const local = await summarizeWithLocal(ins, cloud);
  // 存档（供后续复用 + 历史时间线）
  try {
    await saveBridgeLog({
      material_key: key,
      material_name: intent.material_name || ins?.ref_name || '',
      category: intent.category,
      question: intent.question,
      cloud_result: JSON.stringify(cloud),
      local_result: JSON.stringify(local),
      verdict: local.verdict,
    });
  } catch (e) { console.warn('洞察存档失败:', e); }
  onProgress?.('');
  return { cloud, local, cloudPrompt, audited: true, usedLocalIntent: intent.usedLocal };
}
