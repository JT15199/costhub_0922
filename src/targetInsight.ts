// 仪表盘驾驶舱的计算纯函数（v2.3.19）
// 目标达成：领域（main_category）粒度，实际成本 = BOM 按领域汇总（原始值）
// 达成率 = (2 - actual/target) * 100，>=100 达标（与项目页口径一致）
import { bomPriceState, bomQuantityState } from './ai/contracts';

export interface TargetRow { id?: number; project_id: number; domain: string; target_cost: number; }
export interface BomRowLite { main_category?: string; part_cost?: number; quantity?: number; price_state?: string; }
export interface TargetStatus {
  projectId: number;
  code: string;
  domain: string;
  actual: number | null;
  target: number;
  diff: number | null;      // 实际 - 目标（>0 超支）
  rate: number | null;      // 达成率 %
  missed: boolean;   // 有目标且超支
  unknown: boolean;  // 领域存在未确认价格/数量
}

export interface SnapshotLite { id: number; project_id: number; bom_cost: number; total_cost: number; change_reason?: string; created_at?: string; }

// 计算各项目各领域的目标达成状态
export function computeTargetStatuses(
  projects: { id: number; code: string; project_type?: string }[],
  targetsByProject: Record<number, TargetRow[]>,
  bomsByProject: Record<number, BomRowLite[]>,
): TargetStatus[] {
  const out: TargetStatus[] = [];
  for (const p of projects) {
    const targets = targetsByProject[p.id] || [];
    const boms = bomsByProject[p.id] || [];
    // 领域实际成本（原始值累加）
    const byDomain: Record<string, number> = {};
    const unknownDomains = new Set<string>();
    for (const b of boms) {
      const d = b.main_category || '其他';
      if (bomPriceState(b as any) !== 'confirmed' || bomQuantityState(b as any) !== 'confirmed') { unknownDomains.add(d); continue; }
      const quantity = Number(b.quantity);
      byDomain[d] = (byDomain[d] || 0) + Number(b.part_cost || 0) * quantity;
    }
    for (const t of targets) {
      const unknown = unknownDomains.has(t.domain);
      const actual = unknown ? null : (byDomain[t.domain] || 0);
      const target = t.target_cost || 0;
      const diff = unknown || actual == null ? null : target ? actual - target : 0;
      const rate = unknown || actual == null ? null : target ? Math.round((2 - actual / target) * 100) : 0;
      out.push({
        projectId: p.id, code: p.code, domain: t.domain,
        actual, target, diff, rate,
        missed: !unknown && actual != null && target > 0 && actual > target,
        unknown,
      });
    }
  }
  return out;
}

// 汇总：未达标项目数（任一领域超支）/ 有目标项目数 / 未设目标项目数
export function summarizeTargets(statuses: TargetStatus[], projects: { id: number }[]): {
  missedProjects: number;
  missedDomains: number;
  targetedProjects: number;
  untargetedProjects: number;
  unknownDomains: number;
} {
  const withTarget = new Set(statuses.map(s => s.projectId));
  const missedProjects = new Set(statuses.filter(s => s.missed).map(s => s.projectId));
  return {
    missedProjects: missedProjects.size,
    missedDomains: statuses.filter(s => s.missed).length,
    targetedProjects: withTarget.size,
    untargetedProjects: projects.length - withTarget.size,
    unknownDomains: statuses.filter(s => s.unknown).length,
  };
}

// 成本快照异动检测：最近两条快照 bom_cost 变化超阈值（默认 1% 或绝对 5 元）→ 标记
export function detectSnapshotChanges(
  snapshotsByProject: Record<number, SnapshotLite[]>,
  minPct = 1,        // 变化百分比阈值
  minAbs = 5,        // 绝对变化阈值（元）
): { projectId: number; oldCost: number; newCost: number; pct: number; reason: string; at: string }[] {
  const out: { projectId: number; oldCost: number; newCost: number; pct: number; reason: string; at: string }[] = [];
  for (const [pid, snaps] of Object.entries(snapshotsByProject)) {
    // 按时间取最新两条（created_at 统一 'YYYY-MM-DD HH:MM:SS' 格式，字符串比较安全；id 兜底）
    const sorted = [...snaps].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id));
    if (sorted.length < 2) continue;
    const [newest, prev] = sorted;
    const oldCost = prev.bom_cost || 0;
    const newCost = newest.bom_cost || 0;
    if (oldCost <= 0) continue;
    const pct = ((newCost - oldCost) / oldCost) * 100;
    if (Math.abs(pct) >= minPct || Math.abs(newCost - oldCost) >= minAbs) {
      out.push({
        projectId: Number(pid),
        oldCost, newCost,
        pct: Math.round(pct * 100) / 100,
        reason: newest.change_reason || '',
        at: newest.created_at || '',
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
}
