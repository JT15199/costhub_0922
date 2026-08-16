// AI 今日速览（v2.3.19，2026-08-16）：打开应用时本地 AI 主动汇报当天数据重点
// 链路：本地规则收集事实（不查外部）→ 本地 Ollama 润色成自然语言 → 失败静默降级规则文案
// 节流：settings ai_daily_brief 存 {date, hash, text, model}；同日同指纹直接复用，数据变化自动重生成
// 留痕：logLocalAICall('daily_brief')；数据安全：只走本地模型通道，外部 LLM 无任何数据通道
import { invoke } from '@tauri-apps/api/core';
import { getProjects, getParts, getInsights, getWorkLogs, getSetting, setSetting } from './db';
import { getAdvisorInsights } from './db/advisor';
import { logLocalAICall } from './ollama';

export interface BriefFacts {
  date: string;            // 本地日期 YYYY-MM-DD
  totalProjects: number;   // 项目总数（非软删）
  activeProjects: number;  // 在研
  doneProjects: number;    // 已完成
  totalParts: number;      // 器件总数
  bigParts: number;        // 大额物料（成本 ≥¥10）
  advisorOpen: number;     // AI 自主建议待处理
  insightsUnread: number;  // 报价情报未读
  todosOpen: number;       // 工作待办未完成
}

/** FNV-1a 32 位字符串哈希（指纹，稳定且分布均匀） */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 本地日期 YYYY-MM-DD（与写库时间口径一致，禁止 toISOString） */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 收集当天事实（全部本地规则计算，任一查询失败不阻断整体） */
export async function collectBriefFacts(): Promise<BriefFacts> {
  let projs: any[] = [], parts: any[] = [], insights: any[] = [], advisor: any[] = [], logs: any[] = [];
  try { projs = await getProjects('', '', ''); } catch { /* 忽略 */ }
  try { parts = await getParts(); } catch { /* 忽略 */ }
  try { insights = await getInsights(); } catch { /* 忽略 */ }
  try { advisor = await getAdvisorInsights('open'); } catch { /* 忽略 */ }
  try { logs = await getWorkLogs(); } catch { /* 忽略 */ }
  const alive = projs.filter((p: any) => !p.is_deleted);
  const active = alive.filter((p: any) => (p.project_type || '') === '在研');
  const done = alive.filter((p: any) => (p.project_type || '') === '已完成');
  return {
    date: localDate(),
    totalProjects: alive.length,
    activeProjects: active.length,
    doneProjects: done.length,
    totalParts: parts.length,
    bigParts: parts.filter((p: any) => (p.cost || 0) >= 10).length,
    advisorOpen: advisor.length,
    insightsUnread: insights.filter((i: any) => i.status === 'unread').length,
    todosOpen: logs.filter((l: any) => l.is_todo === 1 && l.done === 0).length,
  };
}

/** 规则版速览（降级/未配置模型时使用；纯函数） */
export function buildRuleBrief(f: BriefFacts): string {
  const parts: string[] = [];
  parts.push(`今天共管理 ${f.totalProjects} 个项目（在研 ${f.activeProjects}、已完成 ${f.doneProjects}），器件库 ${f.totalParts} 种（大额物料 ≥¥10 共 ${f.bigParts} 种）`);
  const alerts: string[] = [];
  if (f.advisorOpen > 0) alerts.push(`AI 自主建议 ${f.advisorOpen} 条待处理`);
  if (f.insightsUnread > 0) alerts.push(`报价情报 ${f.insightsUnread} 条未读`);
  if (f.todosOpen > 0) alerts.push(`工作待办 ${f.todosOpen} 条未完成`);
  if (alerts.length > 0) {
    parts.push(`当前有 ${alerts.length} 类事项值得关注：${alerts.join('、')}`);
    parts.push('建议优先处理这些提醒——确认或处理后，驾驶舱会自动刷新状态');
  } else {
    parts.push('目前没有待处理的提醒，数据状态平稳');
    parts.push('设定项目目标成本后，驾驶舱会持续自动预警并生成 AI 建议');
  }
  return parts.join('。') + '。';
}

/** 本地模型提示词（纯函数；数据事实放 user_prompt，模型只依据事实输出，禁止编造） */
export function buildBriefPrompt(f: BriefFacts): { system: string; user: string } {
  const system = '你是 CostHub 成本管理平台的本地 AI 助理。用户打开应用时，你会收到一份当天数据摘要（JSON）。请用 3-5 句连贯的中文向用户汇报今天的重点：第一句总览整体状态；中间点出最值得注意的 1-2 件事（待处理建议、未读情报、未完成待办、项目/物料规模等）；最后一句给行动提示。要求：只依据摘要数据，严禁编造任何数字或事实；不用列表符号、不加标题，写成自然段落；语气专业但亲切。直接输出正文，不要任何前缀。';
  const user = `当天数据摘要：\n${JSON.stringify(f, null, 2)}\n\n请输出速览正文（3-5 句）。`;
  return { system, user };
}

export interface BriefResult {
  text: string;
  source: 'model' | 'rule' | 'cache';
  model?: string;
  facts: BriefFacts;
}

/** 主流程：缓存命中直接复用；否则本地模型生成；失败静默降级规则文案 */
export async function runDailyBrief(opts?: { force?: boolean }): Promise<BriefResult> {
  const model = (await getSetting('local_ai_model', '')).trim();
  const facts = await collectBriefFacts();
  const hash = hashString(JSON.stringify(facts));
  if (!opts?.force) {
    try {
      const c = JSON.parse(await getSetting('ai_daily_brief', ''));
      if (c && c.date === facts.date && c.hash === hash && c.text) {
        return { text: c.text, source: 'cache', model: c.model || model || undefined, facts };
      }
    } catch { /* 缓存缺失/损坏 → 重新生成 */ }
  }
  if (!model) return { text: buildRuleBrief(facts), source: 'rule', facts };
  const { system, user } = buildBriefPrompt(facts);
  try {
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const resp = await invoke<{ status: number; body: string; success: boolean }>('http_post', {
      request: {
        url: `${base}/api/chat`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, options: { temperature: 0.3 } }),
      },
    });
    if (!resp.success) throw new Error(`HTTP ${resp.status}`);
    const parsed = JSON.parse(resp.body);
    const content: string = (parsed?.message?.content || '').trim();
    if (!content) throw new Error('空响应');
    const text = content.slice(0, 800);
    await logLocalAICall({
      request_type: 'daily_brief',
      system_prompt: system,
      user_prompt: user.slice(0, 3000),
      response_summary: text.slice(0, 800),
      success: true,
      model_name: model,
    });
    await setSetting('ai_daily_brief', JSON.stringify({ date: facts.date, hash, text, model }));
    return { text, source: 'model', model, facts };
  } catch (e: any) {
    await logLocalAICall({
      request_type: 'daily_brief',
      system_prompt: system,
      user_prompt: user.slice(0, 3000),
      response_summary: '',
      success: false,
      error_message: String(e?.message || e).slice(0, 200),
      model_name: model,
    });
    return { text: buildRuleBrief(facts), source: 'rule', facts };
  }
}
