// 项目状态点（v2.3.19 界面轻量化）：每个项目的健康状态汇总
// danger = 目标超支（驾驶舱红色预警）；warn = 报价情报涉及/成本快照异动；info = 有其他提示
import { computeTargetStatuses, detectSnapshotChanges } from './targetInsight';

export interface StatusPoint {
  level: 'danger' | 'warn' | 'info' | 'none';
  reasons: string[];
}

// insights: part_insights 行（insight_json 内含 rows[].projectId）
export function computeProjectStatuses(
  projects: { id: number; code: string; project_type?: string }[],
  targetsByProject: Record<number, any[]>,
  bomsByProject: Record<number, any[]>,
  insights: { id: number; module_name: string; status: string; insight_json: string }[],
  snapshotsByProject: Record<number, any[]>,
): Record<number, StatusPoint> {
  const out: Record<number, StatusPoint> = {};
  projects.forEach(p => { out[p.id] = { level: 'none', reasons: [] }; });

  // 1) 目标超支 → danger
  computeTargetStatuses(projects, targetsByProject, bomsByProject)
    .filter(t => t.missed)
    .forEach(t => {
      if (t.diff != null) out[t.projectId].reasons.push(`${t.domain} 超目标 ¥${t.diff.toFixed(2)}`);
    });

  // 2) 报价情报（未读且涉及该项目）→ warn
  insights.filter(i => i.status === 'unread').forEach(i => {
    try {
      const arr = JSON.parse(i.insight_json || '[]');
      const pids = new Set<number>();
      arr.forEach((g: any) => (g.rows || []).forEach((r: any) => { if (r.projectId) pids.add(Number(r.projectId)); }));
      pids.forEach(pid => {
        if (out[pid]) out[pid].reasons.push(`报价情报：${i.module_name}`);
      });
    } catch { /* 忽略解析失败 */ }
  });

  // 3) 快照异动 ≥1% → warn
  detectSnapshotChanges(snapshotsByProject).forEach(c => {
    if (out[c.projectId]) out[c.projectId].reasons.push(`成本异动 ${c.pct > 0 ? '+' : ''}${c.pct}%`);
  });

  // 定级：danger > warn > info > none
  Object.values(out).forEach(s => {
    if (s.reasons.some(r => r.includes('超目标'))) s.level = 'danger';
    else if (s.reasons.length > 0) s.level = 'warn';
  });
  return out;
}

// 状态点展示映射
export function statusPointMeta(level: StatusPoint['level']): { color: string; label: string } {
  switch (level) {
    case 'danger': return { color: '#EF4444', label: '需关注' };
    case 'warn': return { color: '#F59E0B', label: '有提示' };
    case 'info': return { color: '#0A84FF', label: '信息' };
    default: return { color: '#C0C8D0', label: '正常' };
  }
}
