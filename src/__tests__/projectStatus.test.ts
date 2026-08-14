import { describe, it, expect } from 'vitest';
import { computeProjectStatuses, statusPointMeta } from '../projectStatus';

const projects = [
  { id: 1, code: 'P1' },
  { id: 2, code: 'P2' },
  { id: 3, code: 'P3' },
];

describe('computeProjectStatuses — 项目状态点', () => {
  it('无任何问题 → none', () => {
    const s = computeProjectStatuses(projects, {}, {}, [], {});
    expect(s[1].level).toBe('none');
    expect(s[1].reasons).toEqual([]);
  });

  it('目标超支 → danger', () => {
    const s = computeProjectStatuses(projects,
      { 1: [{ id: 1, project_id: 1, domain: '加工费类', target_cost: 30 }] },
      { 1: [{ main_category: '加工费类', part_cost: 40, quantity: 1 }] },
      [], {});
    expect(s[1].level).toBe('danger');
    expect(s[1].reasons[0]).toContain('超目标');
  });

  it('报价情报（未读涉及项目）→ warn', () => {
    const s = computeProjectStatuses(projects, {}, {},
      [{ id: 1, module_name: '显示模块', status: 'unread', insight_json: JSON.stringify([{ name: 'g', rows: [{ projectId: 2 }] }]) }],
      {});
    expect(s[2].level).toBe('warn');
    expect(s[2].reasons[0]).toContain('报价情报');
  });

  it('快照异动 → warn', () => {
    const s = computeProjectStatuses(projects, {}, {}, [],
      { 3: [{ id: 1, project_id: 3, bom_cost: 100, total_cost: 100 }, { id: 2, project_id: 3, bom_cost: 115, total_cost: 115 }] });
    expect(s[3].level).toBe('warn');
    expect(s[3].reasons[0]).toContain('成本异动');
  });

  it('已读情报不提示', () => {
    const s = computeProjectStatuses(projects, {}, {},
      [{ id: 1, module_name: '显示模块', status: 'read', insight_json: JSON.stringify([{ rows: [{ projectId: 2 }] }]) }],
      {});
    expect(s[2].level).toBe('none');
  });

  it('danger 优先于 warn', () => {
    const s = computeProjectStatuses(projects,
      { 1: [{ id: 1, project_id: 1, domain: '加工费类', target_cost: 30 }] },
      { 1: [{ main_category: '加工费类', part_cost: 40, quantity: 1 }] },
      [{ id: 1, module_name: '显示模块', status: 'unread', insight_json: JSON.stringify([{ rows: [{ projectId: 1 }] }]) }],
      { 1: [{ id: 1, project_id: 1, bom_cost: 100, total_cost: 100 }, { id: 2, project_id: 1, bom_cost: 115, total_cost: 115 }] });
    expect(s[1].level).toBe('danger');
    expect(s[1].reasons.length).toBe(3);
  });

  it('statusPointMeta 映射', () => {
    expect(statusPointMeta('danger').color).toBe('#EF4444');
    expect(statusPointMeta('none').label).toBe('正常');
  });
});
