// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { getDb } from './core';



// ==================== Dashboard ====================
export async function getDashboardStats() {
  const d = await getDb();
  const totalParts = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM parts'))[0].c;
  const totalProjects = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM projects WHERE COALESCE(is_deleted, 0) = 0'))[0].c;
  const activeProjects = (await d.select<{ c: number }[]>("SELECT COUNT(*) as c FROM projects WHERE status='进行中' AND COALESCE(is_deleted, 0) = 0"))[0].c;
  const totalCompetitors = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM competitors'))[0].c;
  const projects = await d.select<{ id: number }[]>('SELECT id FROM projects WHERE COALESCE(is_deleted, 0) = 0');
  let totalCost = 0;
  for (const p of projects) {
    const boms = await d.select<{ quantity: number; cost: number }[]>('SELECT pb.quantity, CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?', [p.id]);
    totalCost += boms.reduce((s, b) => s + b.quantity * b.cost, 0);
  }
  const avgBomCost = projects.length > 0 ? Math.round(totalCost / projects.length * 100) / 100 : 0;
  const catDist = await d.select<{ main_category: string; c: number }[]>('SELECT main_category, COUNT(*) as c FROM parts GROUP BY main_category ORDER BY c DESC');
  const recentParts = await d.select<any[]>('SELECT * FROM parts ORDER BY updated_at DESC LIMIT 5');
  return { total_parts: totalParts, total_projects: totalProjects, active_projects: activeProjects, total_competitors: totalCompetitors, avg_bom_cost: avgBomCost, category_distribution: catDist.map(r => ({ category: r.main_category, count: r.c })), recent_parts: recentParts };
}