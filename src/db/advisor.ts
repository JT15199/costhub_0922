// 自主分析（AI 助理后台建议）数据层
// 表 ai_advisor_insights 由 core.ts ensureSchema 创建

import { getDb } from './core';

export type AdvisorUpsertDecision = 'create' | 'refresh' | 'reopen';

/** 巡视问题的稳定生命周期：证据不变不重发，证据变化重新打开。 */
export function decideAdvisorUpsert(existing: { status?: string; evidenceFingerprint?: string } | null, evidenceFingerprint: string): AdvisorUpsertDecision {
  if (!existing) return 'create';
  return existing.evidenceFingerprint === evidenceFingerprint ? 'refresh' : 'reopen';
}
function impactBand(value: number) { return value >= 100 ? 'high' : value >= 20 ? 'medium' : 'low'; }

// 全部建议（按时间倒序）
export async function getAdvisorInsights(status?: string) {
  const d = await getDb();
  if (status) {
    return d.select<any[]>('SELECT * FROM ai_advisor_insights WHERE status = ? ORDER BY id DESC', [status]);
  }
  return d.select<any[]>('SELECT * FROM ai_advisor_insights ORDER BY id DESC');
}

// 未处理建议数（侧边栏 Badge）
export async function getOpenAdvisorCount(): Promise<number> {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT COUNT(*) AS n FROM ai_advisor_insights WHERE status = \'open\'');
  return rows?.[0]?.n || 0;
}

// 指纹查重（同指纹已存在 open/done 则跳过；dismissed 允许再次出现——用户主动忽略后可再提醒）
export async function findAdvisorByFingerprint(fingerprint: string) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT id FROM ai_advisor_insights WHERE (evidence_fingerprint = ? OR fingerprint = ?) AND status != \'dismissed\' LIMIT 1', [fingerprint, fingerprint]);
  return rows?.[0] || null;
}

// 降噪：被忽略过的建议（数据未变时指纹相同）→ 不重提；指纹含数据版本，数据变化自然生成新指纹重新提醒
export async function findDismissedByFingerprint(fingerprint: string) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT id FROM ai_advisor_insights WHERE (evidence_fingerprint = ? OR fingerprint = ?) AND status = \'dismissed\' LIMIT 1', [fingerprint, fingerprint]);
  return rows?.[0] || null;
}

export async function upsertAdvisorInsight(ins: {
  insight_type: string;
  title: string;
  detail?: string;
  ref_type?: string;
  ref_id?: number;
  ref_name?: string;
  prompt?: string;
  source?: string;
  fingerprint: string;
  issue_key?: string;
  evidence_fingerprint?: string;
  severity?: string;
  impact_amount?: number;
}) {
  const d = await getDb();
  const issueKey = ins.issue_key || `${ins.insight_type}|${ins.ref_type || ''}|${ins.ref_id || 0}`;
  const evidenceFingerprint = ins.evidence_fingerprint || ins.fingerprint;
  const rows = await d.select<any[]>('SELECT id, status, evidence_fingerprint, fingerprint FROM ai_advisor_insights WHERE issue_key = ? ORDER BY id DESC LIMIT 1', [issueKey]);
  const existing = rows[0] ? { status: rows[0].status, evidenceFingerprint: rows[0].evidence_fingerprint || rows[0].fingerprint } : null;
  const decision = decideAdvisorUpsert(existing, evidenceFingerprint);
  if (rows[0] && decision === 'refresh') {
    // Evidence is unchanged: preserve AI analysis, user feedback and handled state.
    await d.execute("UPDATE ai_advisor_insights SET last_seen_at=datetime('now','localtime'), occurrence_count=COALESCE(occurrence_count,0)+1 WHERE id=?", [rows[0].id]);
    return { id: Number(rows[0].id), decision, created: false, reopened: false };
  }
  const impactAmount = Number.isFinite(Number(ins.impact_amount)) ? Number(ins.impact_amount) : 0;
  const severity = ins.severity || (impactAmount >= 100 ? 'high' : impactAmount >= 20 ? 'warning' : 'info');
  const band = impactBand(impactAmount);
  if (!rows[0]) {
    const result = await d.execute(
      'INSERT INTO ai_advisor_insights (insight_type, title, detail, ref_type, ref_id, ref_name, prompt, status, source, fingerprint, issue_key, evidence_fingerprint, severity, impact_amount, impact_band) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [ins.insight_type, ins.title, ins.detail || '', ins.ref_type || '', ins.ref_id || 0, ins.ref_name || '', ins.prompt || '', 'open', ins.source || 'rule', ins.fingerprint, issueKey, evidenceFingerprint, severity, impactAmount, band]
    );
    await d.execute("UPDATE ai_advisor_insights SET first_seen_at=datetime('now','localtime'), last_seen_at=datetime('now','localtime'), last_notified_at=datetime('now','localtime'), occurrence_count=1 WHERE id=?", [result.lastInsertId]);
    return { id: Number(result.lastInsertId) || 0, decision, created: true, reopened: false };
  }
  const status = decision === 'reopen' ? 'open' : rows[0].status;
  await d.execute(
    "UPDATE ai_advisor_insights SET insight_type=?, title=?, detail=?, ref_type=?, ref_id=?, ref_name=?, prompt=?, source=?, status=?, fingerprint=?, evidence_fingerprint=?, severity=?, impact_amount=?, impact_band=?, first_seen_at=COALESCE(NULLIF(first_seen_at,''), datetime('now','localtime')), last_seen_at=datetime('now','localtime'), last_notified_at=CASE WHEN ?='reopen' THEN datetime('now','localtime') ELSE last_notified_at END, occurrence_count=COALESCE(occurrence_count,0)+1, updated_at=datetime('now','localtime') WHERE id=?",
    [ins.insight_type, ins.title, ins.detail || '', ins.ref_type || '', ins.ref_id || 0, ins.ref_name || '', ins.prompt || '', ins.source || 'rule', status, ins.fingerprint, evidenceFingerprint, severity, impactAmount, band, decision, rows[0].id]
  );
  return { id: Number(rows[0].id), decision, created: false, reopened: decision === 'reopen' };
}

export async function saveAdvisorInsight(ins: {
  insight_type: string;
  title: string;
  detail?: string;
  ref_type?: string;
  ref_id?: number;
  ref_name?: string;
  prompt?: string;
  source?: string;
  fingerprint: string;
  issue_key?: string;
  evidence_fingerprint?: string;
}) {
  return upsertAdvisorInsight(ins);
}

// 更新状态：done（已处理）/ dismissed（忽略）；可回填行业洞察结论
export async function updateAdvisorStatus(id: number, status: string, extra?: { detail?: string; insight?: string }) {
  const d = await getDb();
  if (extra?.detail !== undefined && extra.insight !== undefined) {
    await d.execute('UPDATE ai_advisor_insights SET status = ?, detail = ?, prompt = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [status, extra.detail, extra.insight, id]);
  } else if (extra?.detail !== undefined) {
    await d.execute('UPDATE ai_advisor_insights SET status = ?, detail = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [status, extra.detail, id]);
  } else {
    await d.execute('UPDATE ai_advisor_insights SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [status, id]);
  }
}

// ===== 本地-云端桥洞察存档（防重复洞察 + 历史可查） =====
export async function saveBridgeLog(log: {
  material_key: string;
  material_name: string;
  category?: string;
  question?: string;
  cloud_result?: string;
  cloud_prompt?: string;
  local_result?: string;
  verdict?: string;
  reused?: number;
  reuse_of?: number;
}) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO ai_bridge_logs (material_key, material_name, category, question, cloud_result, cloud_prompt, local_result, verdict, reused, reuse_of) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [log.material_key, log.material_name, log.category || '', log.question || '', log.cloud_result || '', log.cloud_prompt || '', log.local_result || '', log.verdict || '', log.reused || 0, log.reuse_of || 0]
  );
}
// 最近一条洞察（同物料，用于复用）
export async function getRecentBridgeLog(materialKey: string, days = 7) {
  const d = await getDb();
  const rows = await d.select<any[]>(
    'SELECT * FROM ai_bridge_logs WHERE material_key = ? AND created_at >= datetime(\'now\',\'localtime\', ?) ORDER BY id DESC LIMIT 1',
    [materialKey, '-' + days + ' days']
  );
  return rows?.[0] || null;
}
// 该物料全部洞察历史（时间线展示）
export async function getBridgeLogsByMaterial(materialKey: string, limit = 10) {
  const d = await getDb();
  return d.select<any[]>('SELECT * FROM ai_bridge_logs WHERE material_key = ? ORDER BY id DESC LIMIT ?', [materialKey, limit]);
}
// 最近 N 条洞察记录（安全中心"发送记录"用）
export async function getRecentBridgeLogs(limit = 10) {
  const d = await getDb();
  return d.select<any[]>('SELECT * FROM ai_bridge_logs ORDER BY id DESC LIMIT ?', [limit]);
}

// 物料 key 归一化（复用 normalizePartName 口径）
export function materialKey(name: string, category = ''): string {
  return (name || '').trim().toLowerCase().replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/[\s_\-/\\]+/g, '') + '|' + (category || '').trim().toLowerCase();
}

// 删除（用户主动清理历史）
export async function deleteAdvisorInsight(id: number) {
  const d = await getDb();
  await d.execute('DELETE FROM ai_advisor_insights WHERE id = ?', [id]);
}
