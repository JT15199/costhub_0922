import { executeTool, listTools } from '../aiTools';
import { getSetting } from '../db';
import { runThinkLoop, buildThinkSystemPrompt } from '../thinkEngine';
import { collectEvidence, verifyAnswer } from './verifier';
import { createAnalysisRun, finishAnalysisRun } from '../db/ai';
import { detectSkill } from './skills/registry';
import type { AnalysisRequest, AnalysisRunResult, AiToolResult } from './contracts';

const makeRunId = () => globalThis.crypto?.randomUUID?.() || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 唯一分析入口；UI 只负责交互，工具执行、证据汇总和结论校验统一走这里。 */
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisRunResult> {
  const runId = makeRunId();
  const skill = request.preferredSkill ? undefined : detectSkill(request.question);
  const skillId = request.preferredSkill || skill?.id || 'general-cost-analysis';
  const skillVersion = skill?.version || '1.0.0';
  const results: AiToolResult<unknown>[] = [];
  const started = Date.now();
  await createAnalysisRun({ runId, skillId, skillVersion, question: request.question });
  try {
    const model = await getSetting('local_ai_model', '');
    const baseUrl = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    if (!model) throw new Error('未配置本地模型');
    const tools = listTools();
    const names = tools.map(tool => `${tool.name}（${tool.id}）`).join('；');
    const res = await runThinkLoop({
      baseUrl, model, systemPrompt: buildThinkSystemPrompt([names]), userContent: request.question,
      localTools: tools.map(tool => ({ id: tool.id, desc: tool.desc, params: tool.params })),
      executeTool: async (id, args) => {
        const result = await executeTool(id, args);
        if (result.result) results.push(result.result);
        return result;
      },
      approveCloud: async () => false,
    });
    const verification = verifyAnswer(res.finalText, results);
    const warnings = verification.ok ? [] : verification.reasons.concat(verification.unverifiedNumbers.map(item => item.context));
    await finishAnalysisRun(runId, { status: verification.ok ? 'completed' : 'needs_review', durationMs: Date.now() - started, warning: warnings.join('；') });
    return { runId, answer: res.finalText, recommendations: [], evidence: collectEvidence(results), warnings, skillId, skillVersion };
  } catch (error: any) {
    const warning = String(error?.message || error).slice(0, 500);
    await finishAnalysisRun(runId, { status: 'failed', durationMs: Date.now() - started, warning });
    throw error;
  }
}
