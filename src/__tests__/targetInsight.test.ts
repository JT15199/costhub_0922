import { describe, it, expect } from 'vitest';
import { computeTargetStatuses, summarizeTargets, detectSnapshotChanges } from '../targetInsight';

const projects = [
  { id: 1, code: 'P1' },
  { id: 2, code: 'P2' },
];
const boms1 = [
  { main_category: '加工费类', part_cost: 20, quantity: 2 },   // 40
  { main_category: '包材类', part_cost: 10, quantity: 1 },     // 10
];
const boms2 = [
  { main_category: '硬件类', part_cost: 50, quantity: 1 },     // 50
];

describe('computeTargetStatuses — 目标达成计算', () => {
  it('达标：实际 ≤ 目标 → missed=false', () => {
    const s = computeTargetStatuses(projects, { 1: [{ id: 1, project_id: 1, domain: '加工费类', target_cost: 50 }] }, { 1: boms1 });
    expect(s[0].actual).toBe(40);
    expect(s[0].target).toBe(50);
    expect(s[0].diff).toBe(-10);
    expect(s[0].rate).toBe(Math.round((2 - 40/50) * 100)); // 120
    expect(s[0].missed).toBe(false);
  });

  it('未达标：实际 > 目标 → missed=true，红色预警', () => {
    const s = computeTargetStatuses(projects, { 1: [{ id: 1, project_id: 1, domain: '加工费类', target_cost: 30 }] }, { 1: boms1 });
    expect(s[0].missed).toBe(true);
    expect(s[0].diff).toBe(10);
  });

  it('无 BOM 的领域实际为 0', () => {
    const s = computeTargetStatuses(projects, { 1: [{ id: 1, project_id: 1, domain: '不存在类', target_cost: 100 }] }, { 1: boms1 });
    expect(s[0].actual).toBe(0);
    expect(s[0].missed).toBe(false);
  });

  it('多项目多领域汇总正确', () => {
    const s = computeTargetStatuses(projects, {
      1: [{ id: 1, project_id: 1, domain: '加工费类', target_cost: 30 }, { id: 2, project_id: 1, domain: '包材类', target_cost: 5 }],
      2: [{ id: 3, project_id: 2, domain: '硬件类', target_cost: 60 }],
    }, { 1: boms1, 2: boms2 });
    expect(s).toHaveLength(3);
    const missed = s.filter(x => x.missed);
    expect(missed.map(m => m.domain).sort()).toEqual(['包材类', '加工费类'].sort()); // 40>30 超、10>5 超
    const sum = summarizeTargets(s, projects);
    expect(sum.missedProjects).toBe(1);
    expect(sum.missedDomains).toBe(2);
    expect(sum.targetedProjects).toBe(2);
    expect(sum.untargetedProjects).toBe(0);
  });

  it('未设目标项目统计', () => {
    const s = computeTargetStatuses(projects, { 1: [{ id: 1, project_id: 1, domain: '加工费类', target_cost: 30 }] }, { 1: boms1, 2: boms2 });
    const sum = summarizeTargets(s, projects);
    expect(sum.untargetedProjects).toBe(1);
  });
});

describe('detectSnapshotChanges — 快照异动检测', () => {
  it('变化超阈值 → 标记，按幅度排序', () => {
    const r = detectSnapshotChanges({
      1: [
        { id: 1, project_id: 1, bom_cost: 100, total_cost: 100, change_reason: '初始' },
        { id: 2, project_id: 1, bom_cost: 115, total_cost: 115, change_reason: '面板涨价' },
      ],
      2: [
        { id: 3, project_id: 2, bom_cost: 200, total_cost: 200, change_reason: '初始' },
        { id: 4, project_id: 2, bom_cost: 200.4, total_cost: 200.4, change_reason: '微调' },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0].projectId).toBe(1);
    expect(r[0].pct).toBe(15);
  });

  it('变化未超阈值 → 不标记', () => {
    const r = detectSnapshotChanges({
      9: [
        { id: 1, project_id: 9, bom_cost: 100, total_cost: 100 },
        { id: 2, project_id: 9, bom_cost: 100.4, total_cost: 100.4 },
      ],
    });
    expect(r).toHaveLength(0);
  });

  it('只有一条快照 → 跳过', () => {
    const r = detectSnapshotChanges({ 1: [{ id: 1, project_id: 1, bom_cost: 100, total_cost: 100 }] });
    expect(r).toHaveLength(0);
  });
});