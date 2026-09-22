// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';
import { getProjectBOMs } from './projects';
import { bomPriceState, bomQuantityState } from '../ai/contracts';



// ==================== Dashboard ====================
export async function getDashboardStats() {
  const d = await getDb();
  const totalParts = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM parts'))[0].c;
  const totalProjects = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM projects WHERE COALESCE(is_deleted, 0) = 0'))[0].c;
  const activeProjects = (await d.select<{ c: number }[]>("SELECT COUNT(*) as c FROM projects WHERE status='进行中' AND COALESCE(is_deleted, 0) = 0"))[0].c;
  const totalCompetitors = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM competitors'))[0].c;
  const projects = await d.select<{ id: number }[]>('SELECT id FROM projects WHERE COALESCE(is_deleted, 0) = 0');
  let totalCost = 0; let incompleteProjects = 0;
  for (const p of projects) {
    const boms = await getProjectBOMs(p.id);
    if (boms.length === 0 || boms.some((b: any) => bomPriceState(b) !== 'confirmed' || bomQuantityState(b) !== 'confirmed')) { incompleteProjects++; continue; }
    totalCost += boms.reduce((s, b: any) => s + Number(b.part_cost || 0) * (b.quantity == null ? 1 : Number(b.quantity)), 0);
  }
  const avgBomCost = projects.length > 0 && incompleteProjects === 0 ? Math.round(totalCost / projects.length * 100) / 100 : null;
  const catDist = await d.select<{ main_category: string; c: number }[]>('SELECT main_category, COUNT(*) as c FROM parts GROUP BY main_category ORDER BY c DESC');
  const recentParts = await d.select<any[]>('SELECT * FROM parts ORDER BY updated_at DESC LIMIT 5');
  return { total_parts: totalParts, total_projects: totalProjects, active_projects: activeProjects, total_competitors: totalCompetitors, avg_bom_cost: avgBomCost, incomplete_projects: incompleteProjects, category_distribution: catDist.map(r => ({ category: r.main_category, count: r.c })), recent_parts: recentParts };
}
