// 自主分析（AI 助理后台建议）数据层
// 表 ai_advisor_insights 由 core.ts ensureSchema 创建

import { getDb } from './core';

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
  const rows = await d.select<any[]>('SELECT id FROM ai_advisor_insights WHERE fingerprint = ? AND status != \'dismissed\' LIMIT 1', [fingerprint]);
  return rows?.[0] || null;
}

// 降噪：被忽略过的建议（数据未变时指纹相同）→ 不重提；指纹含数据版本，数据变化自然生成新指纹重新提醒
export async function findDismissedByFingerprint(fingerprint: string) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT id FROM ai_advisor_insights WHERE fingerprint = ? AND status = \'dismissed\' LIMIT 1', [fingerprint]);
  return rows?.[0] || null;
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
}) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO ai_advisor_insights (insight_type, title, detail, ref_type, ref_id, ref_name, prompt, status, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [ins.insight_type, ins.title, ins.detail || '', ins.ref_type || '', ins.ref_id || 0, ins.ref_name || '', ins.prompt || '', 'open', ins.source || 'rule', ins.fingerprint]
  );
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
  local_result?: string;
  verdict?: string;
  reused?: number;
  reuse_of?: number;
}) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO ai_bridge_logs (material_key, material_name, category, question, cloud_result, local_result, verdict, reused, reuse_of) VALUES (?,?,?,?,?,?,?,?,?)',
    [log.material_key, log.material_name, log.category || '', log.question || '', log.cloud_result || '', log.local_result || '', log.verdict || '', log.reused || 0, log.reuse_of || 0]
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
// 物料 key 归一化（复用 normalizePartName 口径）
export function materialKey(name: string, category = ''): string {
  return (name || '').trim().toLowerCase().replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/[\s_\-/\\]+/g, '') + '|' + (category || '').trim().toLowerCase();
}

// 删除（用户主动清理历史）
export async function deleteAdvisorInsight(id: number) {
  const d = await getDb();
  await d.execute('DELETE FROM ai_advisor_insights WHERE id = ?', [id]);
}
