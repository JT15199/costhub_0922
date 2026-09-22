import { verifyConclusionNumbers } from '../verifyConclusion';
import type { AiRecommendation, AiToolManifest, AiToolResult, EvidenceRef, VerifyResult } from './contracts';

export function verifyToolResult(result: AiToolResult<unknown>, manifest?: AiToolManifest): VerifyResult {
  const reasons: string[] = [];
  if (!result.ok) reasons.push('工具执行失败');
  if (manifest?.evidencePolicy === 'required' && result.ok && result.evidence.length === 0) {
    reasons.push('查询结果缺少证据引用');
  }
  return { ok: reasons.length === 0, reasons, unverifiedNumbers: [], evidence: result.evidence || [] };
}

export function verifyRecommendation(input: AiRecommendation, toolResults: AiToolResult<unknown>[]): VerifyResult {
  const evidence = toolResults.flatMap(result => result.evidence || []);
  const known = new Set(evidence.map(item => item.refType + ':' + item.refId));
  const missing = (input.evidence || []).filter(item => !known.has(item.refType + ':' + item.refId));
  const reasons = missing.length ? ['建议引用了未出现在本次工具结果中的证据'] : [];
  if (input.expectedImpact && input.evidence.length === 0) reasons.push('预期影响缺少证据');
  return {
    ok: reasons.length === 0,
    reasons,
    unverifiedNumbers: [],
    evidence,
  };
}

export function verifyAnswer(answer: string, toolResults: AiToolResult<unknown>[], extraEvidence = '', projectId?: number): VerifyResult {
  const evidence = toolResults.flatMap(result => result.evidence || []);
  const structuredResult = verifyConclusionNumbers(answer, evidence, { projectId });
  const unverified = evidence.length ? structuredResult.unverified : verifyConclusionNumbers(answer, extraEvidence).unverified;
  return {
    ok: unverified.length === 0,
    reasons: unverified.length ? ['结论中存在未被工具证据覆盖的数字'] : [],
    unverifiedNumbers: unverified.map(item => ({ num: item.num, context: item.ctx })),
    evidence,
  };
}

export function collectEvidence(results: AiToolResult<unknown>[]): EvidenceRef[] {
  const seen = new Set<string>();
  return results.flatMap(result => result.evidence || []).filter(item => {
    const key = item.refType + ':' + item.refId + ':' + (item.field || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
