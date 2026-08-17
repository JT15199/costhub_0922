// AI 后台自主思考引擎（v2.3.19，2026-08-17 用户核心需求：不是用户指挥的分析，而是 AI 自发的分析，并把过程呈现出来）
// 设计：
//   · 后台自发（App 级调度：启动 + 每 15 分钟一轮 + 数据变更后节流触发），无需用户输入
//   · 本地模型自主：读数据概览 → 自己决定深挖方向 → 多轮工具调用（复用 runThinkLoop）→ 结论
//   · 云端需要行情 → cloud_market_query 走 requestCloudConfirm 审批（preview 挂非打断式队列，auto 放行）
//   · 全过程落库 ai_think_logs（思考/工具/云端/结论），驾驶舱 AutoThinkPanel 实时流式呈现
// 现有后台引擎（比价/巡检/洞察）是它思考的一部分：各自完成时也记入时间线（由 AutoThinkPanel 汇总展示）
import { getProjects, getProjectBOMs, getSetting, getInsights } from './db';
import { getAdvisorInsights } from './db/advisor';
import { getThinkLogs, saveThinkLog } from './db/think';

export interface AutoThinkResult { topic: string; logId: number; rounds: number; clouds: number; }

// 本轮数据概览（模型自主探索的起点；纯本地规则收集，失败不阻断）
export async function buildThinkOverview(): Promise<string> {
  const lines: string[] = [];
  try {
    const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
    if (projs.length === 0) return '暂无项目数据。';
    lines.push('在研项目 ' + projs.filter((p: any) => p.project_type === '在研').length + ' 个，已完成 ' + projs.filter((p: any) => p.project_type === '已完成').length + ' 个：');
    for (const p of projs.slice(0, 8)) {
      try {
        const boms = await getProjectBOMs(p.id);
        const bomCost = boms.reduce((s: number, b: any) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
        const items = boms.length;
        lines.push('- ' + (p.code || p.name) + '（' + (p.project_type || '') + '）BOM ¥' + Math.round(bomCost * 100) / 100 + '，' + items + ' 项');
      } catch { /* 单项目失败跳过 */ }
    }
  } catch { lines.push('项目数据读取失败。'); }
  try {
    const ins = await getInsights();
    const unread = ins.filter((i: any) => i.status === 'unread');
    if (unread.length > 0) lines.push('报价情报：' + unread.length + ' 个模块有待处理差异情报。');
  } catch { /* 忽略 */ }
  try {
    const adv = await getAdvisorInsights('open');
    if (adv.length > 0) lines.push('自主建议：' + adv.length + ' 条待处理机会/风险点。');
  } catch { /* 忽略 */ }
  lines.push('注：你拥有 13 个本地只读工具可深挖（BOM/供应商/规格/目标/快照/工作手账等）；如需市场行情可申请 cloud_market_query（会请求用户审批）。');
  return lines.join('\n');
}

// 后台自主分析一轮（防重入由调用方负责）：
// onEvent：{ kind: 'thought'|'tool'|'cloud'|'answer'|'done', ... } 供 UI 实时渲染
export async function runAutoThink(opts?: {
  onEvent?: (ev: any) => void;
  approveCloud?: (call: any) => Promise<boolean>;
  maxRounds?: number;
}): Promise<AutoThinkResult | null> {
  try {
    const model = await getSetting('local_ai_model', '');
    if (!model) return null;
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    // 上次运行时间节流（App 级调度已做，这里兜底 10 分钟）
    try {
      const last = await getThinkLogs(1);
      if (last[0] && last[0].status === 'running') return null; // 有未完成的一轮
    } catch { /* 忽略 */ }
    const overview = await buildThinkOverview();
    const { listTools } = await import('./aiTools');
    const { buildThinkSystemPrompt, runThinkLoop } = await import('./thinkEngine');
    const { requestCloudConfirm } = await import('./cloudConfirm');
    const { agentSearchLoop } = await import('./trendService');
    const sysPrompt = buildThinkSystemPrompt(listTools().map(t => t.name)) +
      '\n【任务】你现在是后台自主分析员：阅读上面的数据概览，自主决定分析方向（如成本异常/机会/风险/需要核实的数字），' +
      '先调用本地工具核实与深挖，需要行情时申请云端；最后输出一段 200-400 字的分析结论：' +
      '①发现（事实+数字依据）②判断（机会/风险/正常）③建议行动（具体到项目/物料）。没有值得深挖的就说明并结束。';
    const logId = await saveThinkLog({ status: 'running', topic: '', overview, thoughts: '', tools_json: '[]', clouds_json: '[]', conclusion: '', started_at: '' });
    opts?.onEvent?.({ kind: 'start', logId });
    const thoughts: string[] = [];
    const toolsRec: any[] = [];
    const cloudsRec: any[] = [];
    let curThought = '';
    const { finalText, rounds, clouds } = await runThinkLoop({
      baseUrl: base,
      model,
      systemPrompt: sysPrompt,
      userContent: overview,
      localTools: listTools(),
      executeTool: async (id, args) => {
        const { executeTool } = await import('./aiTools');
        return executeTool(id, args);
      },
      approveCloud: async (call) => {
        opts?.onEvent?.({ kind: 'cloud_request', call });
        return requestCloudConfirm({ material: call.material_name, category: call.category || '', question: call.question });
      },
      runCloud: async (call) => {
        const r = await agentSearchLoop(call.material_name, call.category || '', 'price-trend');
        return r;
      },
      onEvent: {
        onRoundStart: (round) => { curThought = ''; thoughts.push(''); opts?.onEvent?.({ kind: 'round', round }); },
        onThought: (t) => { curThought += t; thoughts[thoughts.length - 1] = curThought; opts?.onEvent?.({ kind: 'thought', text: t }); },
        onToolResult: (name, args, ok, text) => { toolsRec.push({ name, args, ok, text: text.slice(0, 400) }); opts?.onEvent?.({ kind: 'tool', name, args, ok, text: text.slice(0, 400) }); },
        onCloudResult: (call, ok, result) => { cloudsRec.push({ material: call.material_name, question: call.question, ok, result: result.slice(0, 400) }); opts?.onEvent?.({ kind: 'cloud', call, ok, result: result.slice(0, 400) }); },
        onAnswer: (t) => opts?.onEvent?.({ kind: 'answer', text: t }),
      },
      maxRounds: opts?.maxRounds ?? 6,
    });
    // 主题：取结论第一句做标题
    const firstLine = (finalText || '').split('\n').find((l: string) => l.trim().length > 4) || '自主分析';
    const topic = firstLine.trim().slice(0, 40);
    await saveThinkLog({
      id: logId, status: 'done', topic, overview, thoughts: thoughts.join('\n\n---\n'),
      tools_json: JSON.stringify(toolsRec), clouds_json: JSON.stringify(cloudsRec),
      conclusion: finalText, finished_at: new Date().toLocaleString('zh-CN', { hour12: false }),
    });
    opts?.onEvent?.({ kind: 'done', topic, conclusion: finalText, rounds, clouds: clouds.length });
    return { topic, logId, rounds, clouds: clouds.length };
  } catch (e: any) {
    opts?.onEvent?.({ kind: 'error', error: String(e?.message || e).slice(0, 300) });
    return null;
  }
}