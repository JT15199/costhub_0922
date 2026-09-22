import { getDb, sha256 } from './core';
import { invoke } from '@tauri-apps/api/core';
import type { AiRecommendation, EvidenceRef } from '../ai/contracts';

const json = (value: unknown, fallback: unknown) => {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
};

export async function approvalPayloadHash(input: { material: string; category?: string; question?: string }): Promise<string> {
  // Rust serde_json 默认按键名排序；两端必须使用同一字节序列，否则合法授权会被网关拒绝。
  return sha256(JSON.stringify({ category: (input.category || '').trim(), material: input.material.trim(), question: (input.question || '').trim() }));
}

export async function createApprovalGrant(input: { material: string; category?: string; question?: string; scopeLevel?: string; payloadHash?: string; previewJson?: string; expiresMinutes?: number; requestUrl?: string; requestMethod?: string; grantClass?: 'payload' | 'theme' }) {
  // 授权哈希必须由 Rust 网关在写入时计算；前端传入的哈希只保留兼容字段，不能作为签发依据。
  // grantClass='theme'（用户勾选"记住此主题不再询问"）：Rust 侧把有效期放宽到最长 7 天，仅对 C1 / 公开型号检索主题生效。
  return invoke<any>('create_cloud_approval_grant', {
    request: {
      scopeLevel: input.scopeLevel || 'C1',
      material: input.material,
      category: input.category || '',
      question: input.question || '',
      previewJson: input.previewJson || '',
      expiresMinutes: input.expiresMinutes || 30,
      requestUrl: input.requestUrl || '',
      requestMethod: input.requestMethod || '',
      grantClass: input.grantClass || 'payload',
    },
  });
}

export async function getValidApprovalGrant(input: { material: string; category?: string; question?: string; payloadHash?: string; scopeLevel?: string; requestUrl?: string }) {
  return invoke<any>('get_valid_cloud_approval_grant', {
    request: {
      material: input.material.trim(), category: (input.category || '').trim(), question: (input.question || '').trim(),
      payloadHash: input.payloadHash, scopeLevel: input.scopeLevel, requestUrl: input.requestUrl,
    },
  });
}

export async function revokeApprovalGrant(id: number) {
  await invoke('revoke_cloud_approval_grant', { id });
}

export async function getActiveApprovalGrants() {
  return invoke<any[]>('get_active_cloud_approval_grants');
}

export async function revokeActiveApprovalGrants() {
  await invoke('revoke_active_cloud_approval_grants');
}

export async function saveEgressAudit(input: { grantId?: number; target: string; model?: string; payloadHash: string; fields: string[]; status: string; errorMessage?: string }) {
  const d = await getDb();
  const result = await d.execute('INSERT INTO ai_egress_audit (grant_id, target, model, payload_hash, fields_json, status, error_message) VALUES (?,?,?,?,?,?,?)', [input.grantId || 0, input.target, input.model || '', input.payloadHash, json(input.fields, []), input.status, (input.errorMessage || '').slice(0, 500)]);
  return result.lastInsertId;
}

export async function createAnalysisRun(input: { runId: string; skillId?: string; skillVersion?: string; question?: string; dataFingerprint?: string }) {
  const result = await (await getDb()).execute('INSERT INTO ai_analysis_runs (run_id, skill_id, skill_version, question, data_fingerprint) VALUES (?,?,?,?,?)', [input.runId, input.skillId || '', input.skillVersion || '', (input.question || '').slice(0, 1000), input.dataFingerprint || '']);
  return result.lastInsertId;
}

export async function finishAnalysisRun(runId: string, input: { status: string; durationMs?: number; warning?: string }) {
  await (await getDb()).execute('UPDATE ai_analysis_runs SET status=?, duration_ms=?, warning=? WHERE run_id=?', [input.status, input.durationMs || 0, (input.warning || '').slice(0, 1000), runId]);
}

export async function getAnalysisRuns(limit = 20) {
  return (await getDb()).select<any[]>('SELECT * FROM ai_analysis_runs ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(limit, 200))]);
}

export async function saveRecommendation(input: AiRecommendation & { runId?: string; source?: string }) {
  const result = await (await getDb()).execute('INSERT INTO ai_recommendations (run_id, title, conclusion, evidence_json, confidence, assumptions_json, expected_impact_json, action_json, data_gaps_json, risks_json, status, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [input.runId || '', input.title, input.conclusion, json(input.evidence, []), input.confidence, json(input.assumptions, []), input.expectedImpact ? json(input.expectedImpact, {}) : '', json(input.action, {}), json(input.dataGaps, []), json(input.risks, []), input.status || 'open', input.source || 'local_rule']);
  return Number(result.lastInsertId);
}

function mapRecommendation(row: any): AiRecommendation {
  const parse = (value: unknown, fallback: any) => { try { return JSON.parse(String(value || '')) || fallback; } catch { return fallback; } };
  const evidence = parse(row.evidence_json, []);
  const assumptions = parse(row.assumptions_json, []);
  const dataGaps = parse(row.data_gaps_json, []);
  const risks = parse(row.risks_json, []);
  const rawImpact = parse(row.expected_impact_json, undefined);
  const rawMin = Number(rawImpact?.min ?? rawImpact?.saving);
  const rawMax = Number(rawImpact?.max ?? rawImpact?.saving);
  const expectedImpact = Number.isFinite(rawMin) && Number.isFinite(rawMax)
    ? { min: Math.min(rawMin, rawMax), max: Math.max(rawMin, rawMax), currency: 'CNY' as const }
    : undefined;
  const rawAction = parse(row.action_json, {});
  const actionType = rawAction?.type === 'todo' || rawAction?.type === 'draft' ? rawAction.type : 'open';
  return {
    id: Number(row.id), title: String(row.title || ''), conclusion: String(row.conclusion || ''),
    evidence: Array.isArray(evidence) ? evidence as EvidenceRef[] : [],
    confidence: row.confidence === 'high' || row.confidence === 'medium' ? row.confidence : 'low',
    assumptions: Array.isArray(assumptions) ? assumptions : [], expectedImpact,
    action: { label: String(rawAction?.label || '打开'), type: actionType },
    dataGaps: Array.isArray(dataGaps) ? dataGaps : [], risks: Array.isArray(risks) ? risks : [],
    status: row.status, source: row.source, createdAt: row.created_at,
  };
}

export async function getRecommendations(status?: string): Promise<AiRecommendation[]> {
  const d = await getDb();
  const rows = status ? await d.select<any[]>('SELECT * FROM ai_recommendations WHERE status=? ORDER BY id DESC', [status]) : await d.select<any[]>('SELECT * FROM ai_recommendations ORDER BY id DESC');
  return rows.map(mapRecommendation);
}

export async function updateRecommendationStatus(id: number, status: NonNullable<AiRecommendation['status']>) {
  const allowed = new Set(['open', 'useful', 'not_useful', 'adopted', 'dismissed', 'done']);
  if (!allowed.has(status)) throw new Error('建议状态无效');
  await (await getDb()).execute("UPDATE ai_recommendations SET status=?, updated_at=datetime('now','localtime') WHERE id=?", [status, id]);
}

export async function recordRecommendationOutcome(input: { recommendationId: number; usefulness?: 'useful' | 'not_useful'; adoptionStatus?: 'adopted' | 'dismissed' | 'done'; actualSaving?: number; actualResult?: string; note?: string }) {
  const d = await getDb();
  await d.execute('INSERT INTO ai_recommendation_feedback (recommendation_id, usefulness, adoption_status, actual_saving, actual_result, note) VALUES (?,?,?,?,?,?)', [input.recommendationId, input.usefulness || '', input.adoptionStatus || '', input.actualSaving ?? null, (input.actualResult || '').slice(0, 1000), (input.note || '').slice(0, 500)]);
  if (input.usefulness) await updateRecommendationStatus(input.recommendationId, input.usefulness);
  else if (input.adoptionStatus) await updateRecommendationStatus(input.recommendationId, input.adoptionStatus);
}

export async function getRecommendationMetrics() {
  const d = await getDb();
  const rows = await d.select<any[]>(`SELECT
    COUNT(DISTINCT recommendation_id) AS feedback_count,
    SUM(CASE WHEN usefulness='useful' THEN 1 ELSE 0 END) AS useful_count,
    SUM(CASE WHEN usefulness='not_useful' THEN 1 ELSE 0 END) AS not_useful_count,
    SUM(CASE WHEN adoption_status IN ('adopted','done') THEN 1 ELSE 0 END) AS adopted_count,
    COALESCE(SUM(actual_saving), 0) AS actual_saving
    FROM ai_recommendation_feedback`);
  const row = rows[0] || {};
  return {
    feedbackCount: Number(row.feedback_count) || 0,
    usefulCount: Number(row.useful_count) || 0,
    notUsefulCount: Number(row.not_useful_count) || 0,
    adoptedCount: Number(row.adopted_count) || 0,
    actualSaving: Number(row.actual_saving) || 0,
  };
}

export async function saveEvalResult(fixtureId: string, metric: string, score: number, detail = '') {
  await (await getDb()).execute('INSERT INTO ai_eval_results (fixture_id, metric, score, detail) VALUES (?,?,?,?)', [fixtureId, metric, score, detail.slice(0, 1000)]);
}

export async function getEvalResults(limit = 200) {
  return (await getDb()).select<any[]>('SELECT * FROM ai_eval_results ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(limit, 200))]);
}
