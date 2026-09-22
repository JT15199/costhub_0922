import { describe, expect, it } from 'vitest';
import { LOCAL_EVAL_FIXTURES } from '../ai/eval/fixtures';
import { scoreEvalCase, summarizeEval } from '../ai/eval/scorer';

describe('本地脱敏评测集', () => {
  it('记录查数、证据和写入拦截指标', () => {
    const bom = scoreEvalCase(LOCAL_EVAL_FIXTURES[0], { selectedTool: 'query_project_bom', numericCorrect: true, durationMs: 120, result: { ok: true, summary: '', data: [], evidence: [{ refType: 'project', refId: 1, label: 'M270', value: 25 }], warnings: [], freshness: '' } });
    const blocked = scoreEvalCase(LOCAL_EVAL_FIXTURES[3], { selectedTool: 'import_supplier_quote', writeBlocked: true, leakageBlocked: true });
    expect(bom.evidenceCoverage).toBe(1);
    expect(bom.numericAccuracy).toBe(1);
    expect(blocked.safeWriteBlocked).toBe(1);
    expect(summarizeEval([bom, blocked]).leakageBlocked).toBe(0.5);
    expect(summarizeEval([bom, blocked]).count).toBe(2);
  });
});
