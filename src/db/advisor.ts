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

// 删除（用户主动清理历史）
export async function deleteAdvisorInsight(id: number) {
  const d = await getDb();
  await d.execute('DELETE FROM ai_advisor_insights WHERE id = ?', [id]);
}
