import { getProjectBOMs, getProjects } from '../../db';
import { executeTool } from '../../aiTools';
import { auditPromptStrict } from '../security';
import { sumBomCost } from '../contracts';
import { saveEvalResult } from '../../db/ai';
import { LOCAL_EVAL_FIXTURES } from './fixtures';
import { scoreEvalCase, summarizeEval, type EvalScore } from './scorer';

export async function runLocalEvaluation(): Promise<{ scores: EvalScore[]; summary: ReturnType<typeof summarizeEval> }> {
  const projects = (await getProjects('', '', '')).filter((project: any) => !project.is_deleted);
  const projectCode = String(projects[0]?.code || '');
  const scores: EvalScore[] = [];
  const run = async (fixtureId: string, selectedTool: string, args: Record<string, unknown>, options: { numericCorrect?: boolean } = {}) => {
    const fixture = LOCAL_EVAL_FIXTURES.find(item => item.id === fixtureId);
    if (!fixture) throw new Error('评测样例不存在：' + fixtureId);
    const started = Date.now();
    const result = await executeTool(selectedTool, args);
    const score = scoreEvalCase(fixture, {
      selectedTool,
      result: result.result,
      writeBlocked: result.requiresConfirmation === true,
      numericCorrect: options.numericCorrect,
      durationMs: Date.now() - started,
      leakageBlocked: auditPromptStrict('项目代号 M270 成本 ¥100').safe === false,
    });
    scores.push(score);
    if (fixtureId !== 'project-bom-total') {
      const metrics = Object.entries(score).filter(([key]) => key !== 'fixtureId');
      for (const [metric, value] of metrics) await saveEvalResult(fixture.id, metric, Number(value), '本地脱敏回归');
    }
    return { score, result };
  };
  const bomRun = await run('project-bom-total', 'query_project_bom', { project_code: projectCode });
  if (projectCode) {
    const project = projects[0];
    const boms = await getProjectBOMs(Number(project.id));
    const expected = sumBomCost(boms.filter((row: any) => !row.is_deleted));
    const actual = Number((bomRun.result.result?.data as any)?.total);
    bomRun.score.numericAccuracy = Number.isFinite(actual) && Math.abs(actual - expected) < 0.0001 ? 1 : 0;
  }
  for (const [metric, value] of Object.entries(bomRun.score).filter(([key]) => key !== 'fixtureId')) {
    await saveEvalResult('project-bom-total', metric, Number(value), metric === 'numericAccuracy' ? '直接 SQLite 对账' : '本地脱敏回归');
  }
  await run('target-gap', 'query_target_status', {});
  await run('quote-negotiation', 'rank_quote_negotiations', { project_code: projectCode });
  await run('unsafe-write-confirmation', 'import_supplier_quote', { rows: '[]' });
  return { scores, summary: summarizeEval(scores) };
}
