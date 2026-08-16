// Agent 循环（P1，2026-08-16）：计划-执行-总结
// 流程：本地模型读工具清单 → 输出 JSON 计划（工具调用序列）→ 系统逐步执行（轨迹回调）→ 结果汇总交模型生成最终回答
// 安全：工具全部只读（见 aiTools.ts）；计划解析失败自动降级为普通对话提示；调用方负责 logLocalAICall 留痕

import { listTools, executeTool, type AiTool } from './aiTools';

export interface AgentStepCall {
  tool: string;
  args: Record<string, any>;
  reason?: string;
}

export interface AgentPlan {
  steps: AgentStepCall[];
}

/** 容错解析模型输出的计划 JSON（兼容代码块/中文引号/尾逗号/前后杂文本） */
export function parseAgentPlan(text: string): AgentPlan | null {
  if (!text) return null;
  let t = String(text).trim();
  // 去代码块围栏（` = 反引号）
  const fence = t.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60/);
  if (fence) t = fence[1].trim();
  // 提取第一个 { ... } 块
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  const raw = t.slice(start, end);
  // 中文引号/单引号 → 双引号；去尾逗号
  const cleaned = raw
    .replace(/[“”]/g, '"')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  try {
    const obj = JSON.parse(cleaned);
    const steps = Array.isArray(obj?.steps) ? obj.steps : (Array.isArray(obj) ? obj : null);
    if (!steps) return null;
    const out: AgentStepCall[] = [];
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      const tool = String(s.tool || s.id || '').trim();
      if (!tool) continue;
      out.push({
        tool,
        args: (s.args && typeof s.args === 'object') ? s.args : {},
        reason: s.reason ? String(s.reason).slice(0, 100) : undefined,
      });
    }
    if (out.length === 0) return null;
    // 工具名容错：别名映射
    const alias: Record<string, string> = {
      query_bom: 'query_project_bom',
      query_cost: 'query_project_cost',
      query_suppliers: 'query_part_suppliers',
      query_insights: 'query_price_insights',
      query_advisor: 'query_advisor_insights',
      insight: 'insight_material_trend',
      query_trend: 'insight_material_trend',
      query_snapshots: 'query_cost_snapshots',
    };
    for (const s of out) { if (alias[s.tool]) s.tool = alias[s.tool]; }
    return { steps: out };
  } catch {
    return null;
  }
}

/** 生成工具清单 prompt（给模型选择） */
export function buildToolsPrompt(tools: AiTool[]): string {
  const t = tools.map(tool => {
    const params = tool.params.length === 0 ? '无' : tool.params.map(p => p.key + (p.required ? '*' : '') + '（' + p.desc + '）').join('，');
    return '- ' + tool.id + '：' + tool.desc + '｜参数：' + params;
  }).join('\n');
  return '可用工具清单：\n' + t;
}

/** 计划阶段系统提示词 */
export function buildPlanSystemPrompt(toolsPrompt: string): string {
  return '你是 CostHub 成本管理平台的执行规划器。用户会提出一个任务，你需要判断能否用下面的工具完成，并输出一个 JSON 计划。'
    + '\n\n' + toolsPrompt
    + '\n\n要求：'
    + '1. 只输出 JSON，格式：{"steps":[{"tool":"工具id","args":{"参数名":"值"},"reason":"为什么调用（10字内）"}]}；'
    + '2. 按执行顺序排列步骤；需要先查项目再查明细时保持依赖顺序；'
    + '3. 项目代号/物料名等具体值从用户问题中提取，不知道就空着或跳过该步；'
    + '4. 不要调用与任务无关的工具；最多 6 步；'
    + '5. 若任务根本不需要工具（纯咨询/闲聊），输出 {"steps":[]}。';
}

/** 总结阶段系统提示词：基于工具执行报告生成最终回答 */
export function buildAnswerSystemPrompt(): string {
  return '你是 CostHub 成本管理平台的 AI 助理。下面是系统为你执行的一系列工具调用及其真实结果。'
    + '请基于这些结果回答用户的原始问题：先给结论，再给关键数据支撑，需要时可以指出数据缺失或需要注意的地方。'
    + '要求：只使用执行结果中的数据，不要编造数字；金额用人民币元表述；条理清晰但不要使用过长的列表。';
}

export interface AgentStepTrace {
  tool: string;
  name: string;
  argsText: string;
  status: 'running' | 'ok' | 'fail';
  result: string;
}

/** 顺序执行计划步骤，返回执行报告 + 轨迹 */
export async function runAgentPlan(
  plan: AgentPlan,
  onStep?: (trace: AgentStepTrace) => void,
): Promise<{ report: string; traces: AgentStepTrace[] }> {
  const tools = listTools();
  const traces: AgentStepTrace[] = [];
  const parts: string[] = [];
  for (const step of plan.steps) {
    const tool = tools.find(t => t.id === step.tool);
    const name = tool?.name || step.tool;
    const argsText = Object.entries(step.args || {}).map(([k, v]) => k + '=' + v).join('，') || '无参数';
    const trace: AgentStepTrace = { tool: step.tool, name, argsText, status: 'running', result: '' };
    traces.push(trace);
    onStep?.({ ...trace });
    const r = await executeTool(step.tool, step.args);
    trace.status = r.ok ? 'ok' : 'fail';
    trace.result = r.text;
    onStep?.({ ...trace });
    parts.push('【步骤：' + name + (argsText !== '无参数' ? '（' + argsText + '）' : '') + '】\n' + r.text);
  }
  return { report: parts.join('\n\n'), traces };
}

/** 校验计划中的工具 id 是否都存在（返回不存在的 id 列表） */
export function unknownTools(plan: AgentPlan): string[] {
  const known = new Set(listTools().map(t => t.id));
  return [...new Set(plan.steps.map(s => s.tool).filter(t => !known.has(t)))];
}
