// AI 学习引擎（v2.3.19，2026-08-16）：让本地模型在日常对话中学习"用户关注什么、什么逻辑是对的"
// 三层学习：
//  ① 关注主题统计：分类用户问题（纯本地关键词规则）→ settings ai_user_focus（每次对话自动累计，旧数据衰减）
//  ② 显式反馈学习：回答 👍/👎+原因 → 沉淀为逻辑偏好规则（settings ai_learned_rules）
//  ③ 偏好注入：buildFocusContext / buildLearnedRulesContext 拼入后续所有 AI prompt（对话/Agent/速览）
// 数据边界：全部本地存储；模型不微调，用"规则注入"实现行为修正（务实且可审查）

import { getSetting, setSetting } from './db';

// ==================== ① 关注主题分类（纯函数） ====================

export const FOCUS_TOPICS = ['项目成本', '物料行情', '供应商', '目标达成', '成本结构', '工作安排'] as const;
export type FocusTopic = typeof FOCUS_TOPICS[number];

export const FOCUS_KEYWORDS: Record<FocusTopic, string[]> = {
  项目成本: ['成本', '项目', 'bom', '报价', '预算', '费用', '花销', '花钱', '整机', '单价'],
  物料行情: ['行情', '趋势', '洞察', '上涨', '下跌', '涨价', '降价', '供需', '物料', '子类', '波动', '景气'],
  供应商: ['供应商', '供货', '交期', '份额', '议价', '谈判', '厂商', '工厂', 'odm', '采购'],
  目标达成: ['目标', '达成', '达标', '超支', '预警', '差距', '达成率', '未达标'],
  成本结构: ['结构', '占比', '模块', '明细', '构成', '大头', '拆解', '分布'],
  工作安排: ['待办', '手账', '总结', '工作', '计划', '安排', '备忘', '今天', '本周'],
};

/** 分类用户问题：返回命中的主题（按关键词命中数降序；无命中返回空） */
export function classifyUserQuestion(text: string): FocusTopic[] {
  const t = (text || '').toLowerCase();
  const hits: { topic: FocusTopic; count: number }[] = [];
  for (const topic of FOCUS_TOPICS) {
    let count = 0;
    for (const kw of FOCUS_KEYWORDS[topic]) {
      if (t.includes(kw.toLowerCase())) count++;
    }
    if (count > 0) hits.push({ topic, count });
  }
  return hits.sort((a, b) => b.count - a.count).map(h => h.topic);
}

/** 关注统计聚合（纯函数）：新命中并入旧统计（旧数据衰减一半，近似 30 天窗口） */
export function mergeFocus(old: Record<string, number>, topics: FocusTopic[]): Record<string, number> {
  const decayed: Record<string, number> = {};
  for (const [k, v] of Object.entries(old || {})) {
    if (typeof v === 'number' && v > 0) decayed[k] = Math.max(0, Math.round(v * 0.5));
  }
  for (const t of topics) {
    decayed[t] = (decayed[t] || 0) + 1;
  }
  return decayed;
}

/** 排序后的关注列表 [{topic, weight}] */
export function focusRanked(focus: Record<string, number>): { topic: string; weight: number }[] {
  return Object.entries(focus || {})
    .map(([topic, weight]) => ({ topic, weight: Number(weight) || 0 }))
    .filter(x => x.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/** 记录一次用户问题（写入 settings ai_user_focus） */
export async function trackUserFocus(text: string): Promise<void> {
  try {
    const topics = classifyUserQuestion(text || '');
    if (topics.length === 0) return;
    let old: Record<string, number> = {};
    try { old = JSON.parse(await getSetting('ai_user_focus', '{}')); } catch { old = {}; }
    await setSetting('ai_user_focus', JSON.stringify(mergeFocus(old, topics)));
  } catch { /* 学习失败静默，不影响对话 */ }
}

/** 读取关注统计 */
export async function getUserFocus(): Promise<Record<string, number>> {
  try { return JSON.parse(await getSetting('ai_user_focus', '{}')); } catch { return {}; }
}

// ==================== ② 逻辑偏好规则（显式反馈学习） ====================

export interface LearnedRule {
  id: string;         // 时间戳 id
  topic: string;      // 相关主题（分类而来或手动）
  preference: string; // 用户认可的/期望的逻辑
  source: string;     // feedback / manual
  createdAt: string;
}

export const FEEDBACK_REASONS: Record<string, string> = {
  vague: '回答太泛泛，没有落到具体行动建议',
  nodata: '没有结合我的本地数据（成本/占比/项目）',
  wrong_logic: '结论逻辑不对，我想要另一种分析方式',
  focus: '没有优先回答我最关注的部分',
};

/** 从反馈原因生成规则文本 */
export function feedbackToPreference(reasonKey: string, custom?: string): string {
  if (custom && custom.trim()) return custom.trim();
  return FEEDBACK_REASONS[reasonKey] || FEEDBACK_REASONS.vague;
}

/** 新增一条学习规则（settings ai_learned_rules JSON 数组，最多 20 条） */
export async function addLearnedRule(rule: Omit<LearnedRule, 'id' | 'createdAt'>): Promise<void> {
  try {
    let rules: LearnedRule[] = [];
    try { rules = JSON.parse(await getSetting('ai_learned_rules', '[]')); } catch { rules = []; }
    rules.unshift({
      ...rule,
      id: Date.now().toString(36),
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
    });
    if (rules.length > 20) rules = rules.slice(0, 20);
    await setSetting('ai_learned_rules', JSON.stringify(rules));
  } catch { /* 静默 */ }
}

export async function getLearnedRules(): Promise<LearnedRule[]> {
  try { return JSON.parse(await getSetting('ai_learned_rules', '[]')); } catch { return []; }
}

export async function deleteLearnedRule(id: string): Promise<void> {
  try {
    const rules = await getLearnedRules();
    await setSetting('ai_learned_rules', JSON.stringify(rules.filter(r => r.id !== id)));
  } catch { /* 静默 */ }
}

// ==================== ③ 偏好上下文生成（注入 prompt） ====================

/** 关注偏好文本（注入 AI prompt：让 AI 优先回应用户关注的主题） */
export function buildFocusContext(focus: Record<string, number>): string {
  const ranked = focusRanked(focus);
  if (ranked.length === 0) return '';
  const top = ranked.slice(0, 3);
  const list = top.map((x, i) => i + 1 + '.' + x.topic + '（近期提及 ' + x.weight + ' 次）').join(' ');
  return '【用户近期关注重点（按提及频率）】' + list + '——在回答时优先覆盖这些主题的结论，其他内容从简。';
}

/** 学习规则文本（注入 prompt：让 AI 遵守用户认可的逻辑） */
export function buildLearnedRulesContext(rules: LearnedRule[]): string {
  if (!rules || rules.length === 0) return '';
  const list = rules.map((r, i) => (i + 1) + '. ' + r.preference).join('\n');
  return '【你已学习到的用户逻辑偏好（必须遵守）】\n' + list;
}

/** 汇总全部偏好上下文（对话/Agent/速览共用） */
export async function buildPreferenceContext(): Promise<string> {
  try {
    const parts: string[] = [];
    const focusCtx = buildFocusContext(await getUserFocus());
    if (focusCtx) parts.push(focusCtx);
    const rulesCtx = buildLearnedRulesContext(await getLearnedRules());
    if (rulesCtx) parts.push(rulesCtx);
    return parts.join('\n\n');
  } catch { return ''; }
}
