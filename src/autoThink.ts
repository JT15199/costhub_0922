// AI 后台自主思考引擎（v2.3.19，2026-08-17 用户核心需求：不是用户指挥的分析，而是 AI 自发的分析，并把过程呈现出来）
// 设计：
//   · 后台自发（App 级调度：启动 + 每 15 分钟一轮 + 数据变更后节流触发），无需用户输入
//   · 本地模型自主：读数据概览 → 自己决定深挖方向 → 多轮工具调用（复用 runThinkLoop）→ 结论
//   · 云端需要行情 → cloud_market_query 走 requestCloudConfirm 审批（preview 挂非打断式队列，auto 放行）
//   · 全过程落库 ai_think_logs（思考/工具/云端/结论），驾驶舱 AutoThinkPanel 实时流式呈现
// 现有后台引擎（比价/巡检/洞察）是它思考的一部分：各自完成时也记入时间线（由 AutoThinkPanel 汇总展示）
import { getProjects, getProjectBOMs, getSetting, setSetting, getInsights } from './db';
import { getAdvisorInsights } from './db/advisor';
import { getThinkLogs, saveThinkLog } from './db/think';

export interface AutoThinkResult { topic: string; logId: number; rounds: number; clouds: number; }

// 本轮数据概览（模型自主探索的起点；纯本地规则收集，失败不阻断）
export async function buildThinkOverview(): Promise<string> {
  const lines: string[] = [];
  // 阶段①目标注入（2026-08-18）：未完成目标优先进入概览，AI 围绕目标分析
  try {
    const { getActiveGoals } = await import('./db/goals');
    const goals = await getActiveGoals();
    if (goals.length > 0) {
      lines.push('【用户目标（优先围绕这些分析）】');
      goals.slice(0, 3).forEach((g: any) => lines.push('- ' + g.text + (g.linked_project ? '（项目 ' + g.linked_project + '）' : '') + (g.progress ? '；已推进：' + g.progress.split('\n').pop() : '')));
    }
  } catch { /* 目标读取失败不阻断 */ }
  try {
    const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
    if (projs.length === 0) return '暂无项目数据。';
    const bomsByP: Record<number, any[]> = {};
    for (const p of projs.slice(0, 8)) {
      try { bomsByP[p.id] = await getProjectBOMs(p.id); } catch { bomsByP[p.id] = []; }
    }
    lines.push('在研项目 ' + projs.filter((p: any) => p.project_type === '在研').length + ' 个，已完成 ' + projs.filter((p: any) => p.project_type === '已完成').length + ' 个：');
    for (const p of projs.slice(0, 8)) {
      const boms = bomsByP[p.id] || [];
      const bomCost = boms.reduce((s: number, b: any) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
      lines.push('- ' + (p.code || p.name) + '（' + (p.project_type || '') + '）BOM ¥' + Math.round(bomCost * 100) / 100 + '，' + boms.length + ' 项');
    }
    // 目标达成（领域级，2026-08-18 加入概览供模型规划目标差距分析任务）
    try {
      const { getTargets } = await import('./db');
      const { computeTargetStatuses } = await import('./targetInsight');
      const tByP: Record<number, any[]> = {};
      for (const p of projs.slice(0, 8)) { try { tByP[p.id] = await getTargets(p.id); } catch { tByP[p.id] = []; } }
      const st = computeTargetStatuses(projs, tByP, bomsByP);
      const missed = st.filter(s => s.missed);
      if (missed.length) lines.push('目标达成：' + missed.length + ' 个领域超目标（' + missed.slice(0, 4).map(s => s.code + '·' + s.domain + ' ' + s.rate + '%').join('、') + '）');
      const untargeted = projs.filter((p: any) => p.project_type !== '已完成' && !(tByP[p.id] || []).length).length;
      if (untargeted) lines.push('另有 ' + untargeted + ' 个在研项目未设定目标成本。');
    } catch { /* 忽略 */ }
    // 成本结构信号：关键模块占比 + 跨项目同模块价差（议价机会线索）
    try {
      const modAgg: Record<string, { cost: number; count: number; projCosts: Record<number, number> }> = {};
      projs.slice(0, 8).forEach(p => {
        const boms = bomsByP[p.id] || [];
        const total = boms.reduce((s, b) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
        if (total <= 0) return;
        const byMod: Record<string, number> = {};
        boms.forEach(b => { const m = b.module_name || '未归类'; byMod[m] = (byMod[m] || 0) + (b.part_cost || 0) * (b.quantity || 1); });
        const top = Object.entries(byMod).sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] / total >= 0.4) lines.push(p.code + ' 模块「' + top[0] + '」占比 ' + Math.round(top[1] / total * 100) + '%（关键依赖）');
        Object.entries(byMod).forEach(([m, cost]) => {
          if (!modAgg[m]) modAgg[m] = { cost: 0, count: 0, projCosts: {} };
          modAgg[m].cost += cost; modAgg[m].count += 1; modAgg[m].projCosts[p.id] = cost;
        });
      });
      const gaps: string[] = [];
      Object.entries(modAgg).forEach(([m, agg]) => {
        if (agg.count < 2 || agg.cost <= 0) return;
        const avg = agg.cost / agg.count;
        Object.entries(agg.projCosts).forEach(([pid, cost]) => {
          if (avg > 0 && (cost - avg) / avg >= 0.2 && (cost - avg) >= 50) {
            const p = projs.find(x => x.id === Number(pid));
            gaps.push((p?.code || pid) + '「' + m + '」高' + Math.round((cost - avg) / avg * 100) + '%');
          }
        });
      });
      if (gaps.length) lines.push('跨项目价差：' + gaps.slice(0, 4).join('、') + '（值得议价核实）');
    } catch { /* 忽略 */ }
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
  force?: boolean; // 手动触发时跳过【数据无变化】去重
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
    // ⚠️ 轮间去重（2026-08-17）：数据概览指纹无变化 → 不重复思考（复用上轮结论）
    const { hashString } = await import('./dailyBrief');
    const ovHash = hashString(overview);
    if (!opts?.force) {
      try {
        const lastHash = await getSetting('ai_think_overview_hash', '');
        if (lastHash === ovHash) {
          opts?.onEvent?.({ kind: 'skipped', reason: '数据无变化，复用上轮结论' });
          return null;
        }
      } catch { /* 指纹读取失败不阻断 */ }
    }
    const { listTools } = await import('./aiTools');
    const { buildThinkSystemPrompt, runThinkLoop, cleanProtocolText } = await import('./thinkEngine');
    const { requestCloudConfirm } = await import('./cloudConfirm');
    const { agentSearchLoop } = await import('./trendService');
    const { getActiveGoals, appendGoalProgress } = await import('./db/goals');
    const activeGoals = await getActiveGoals();
    const sysPrompt = buildThinkSystemPrompt(listTools().map(t => t.name)) +
      (activeGoals.length > 0
        ? '\n【当前目标】用户下达了目标：' + activeGoals.slice(0, 3).map((g: any) => '「' + g.text + '」' + (g.linked_project ? '(' + g.linked_project + ')' : '')).join('、') + '。请优先围绕这些目标做深入分析，结论要直接回应目标。'
        : '') +
      '\n【任务】你现在是后台成本分析员：请先规划 2-4 个本地分析任务（候选方向：目标达成差距核实 / 模块成本结构与关键依赖 / 跨项目同模块价差与议价机会 / 大额物料供应商集中度 / 成本异常数字核实），' +
      '逐个调用本地工具执行（每个任务先查数据再下结论）；本地数据能回答的就不要申请云端；只有决策确实需要外部行情（如某物料近期市场价趋势）时才申请 cloud_market_query；' +
      '最后输出一段 200-400 字的分析结论：①发现（事实+数字依据）②判断（机会/风险/正常）③建议行动（具体到项目/物料）。没有值得深挖的就说明并结束。';
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
        // ⚠️ 云端去重（2026-08-17）：同一物料 7 天内已洞察 → 复用 ai_bridge_logs 结论，不重复烧云端
        try {
          const { materialKey, getRecentBridgeLog, saveBridgeLog } = await import('./db/advisor');
          const key = materialKey(call.material_name, call.category || '');
          const recent = await getRecentBridgeLog(key, 7);
          if (recent && recent.cloud_result) {
            try {
              const cached = JSON.parse(recent.cloud_result);
              return { ...cached, reused: true };
            } catch { /* 解析失败走实时查询 */ }
          }
          const r = await agentSearchLoop(call.material_name, call.category || '', 'price-trend');
          try {
            await saveBridgeLog({ material_key: key, material_name: call.material_name, category: call.category || '', question: call.question || '', cloud_result: JSON.stringify(r), cloud_prompt: '', local_result: '', verdict: '', reused: 0 });
          } catch { /* 存档失败忽略 */ }
          return r;
        } catch {
          return agentSearchLoop(call.material_name, call.category || '', 'price-trend');
        }
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
    // 主题：取结论第一句做标题（先清理协议标记）
    const cleanConcl = cleanProtocolText(finalText || '');
    const firstLine = cleanConcl.split('\n').find((l: string) => l.trim().length > 4) || '自主分析';
    const topic = firstLine.trim().slice(0, 40);
    await saveThinkLog({
      id: logId, status: 'done', topic, overview, thoughts: cleanProtocolText(thoughts.join('\n\n---\n')),
      tools_json: JSON.stringify(toolsRec), clouds_json: JSON.stringify(cloudsRec),
      conclusion: cleanConcl, finished_at: new Date().toLocaleString('zh-CN', { hour12: false }),
    });
    try { await setSetting('ai_think_overview_hash', ovHash); } catch { /* 忽略 */ }
    // 阶段①目标进度回写（2026-08-18）：结论摘要追加到第一个未完成目标，用户可见推进痕迹
    if (cleanConcl && activeGoals.length > 0) {
      try { await appendGoalProgress(activeGoals[0].id, cleanConcl.slice(0, 200)); } catch { /* 忽略 */ }
    }
    opts?.onEvent?.({ kind: 'done', topic, conclusion: finalText, rounds, clouds: clouds.length });
    return { topic, logId, rounds, clouds: clouds.length };
  } catch (e: any) {
    opts?.onEvent?.({ kind: 'error', error: String(e?.message || e).slice(0, 300) });
    return null;
  }
}