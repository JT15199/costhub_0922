import { describe, it, expect } from 'vitest';
import { computeProjectHealth } from '../projectHealth';

const base = {
  projectId: 1,
  code: 'P1',
  boms: [
    { part_name: '面板', part_model: 'M270', module_name: '显示模块', main_category: '硬件类', part_cost: 500, quantity: 1 },
    { part_name: '驱动板', part_model: 'DRV', module_name: '显示模块', main_category: '硬件类', part_cost: 30, quantity: 1 },
  ],
  targets: [],
  snapshots: [],
};

describe('computeProjectHealth — 项目 AI 体检', () => {
  it('健康项目无问题', () => {
    const issues = computeProjectHealth(base);
    expect(issues).toHaveLength(0);
  });

  it('缺单价器件 → warn', () => {
    const issues = computeProjectHealth({ ...base, boms: [...base.boms, { part_name: '外壳', part_model: 'SH', module_name: '结构', main_category: '结构类', part_cost: 0, quantity: 1 }] });
    const i = issues.find(x => x.type === 'bom_no_cost');
    expect(i).toBeTruthy();
    expect(i!.level).toBe('warn');
    expect(i!.detail).toContain('外壳');
  });

  it('数量为 0 → warn', () => {
    const issues = computeProjectHealth({ ...base, boms: [...base.boms, { part_name: '线材', part_model: 'C', module_name: '线材', main_category: '线材类', part_cost: 5, quantity: 0 }] });
    expect(issues.find(x => x.type === 'bom_zero_qty')).toBeTruthy();
  });

  it('目标超支 → danger + 建议跳转 analysis', () => {
    const issues = computeProjectHealth({
      ...base,
      targets: [{ domain: '硬件类', target_cost: 500 }],   // 实际 530 > 500
    });
    const i = issues.find(x => x.type === 'target_over');
    expect(i).toBeTruthy();
    expect(i!.level).toBe('danger');
    expect(i!.actionTab).toBe('analysis');
    expect(i!.detail).toContain('530');
  });

  it('快照上涨 ≥1% → warn', () => {
    const issues = computeProjectHealth({
      ...base,
      snapshots: [
        { id: 1, bom_cost: 500, change_reason: '初始' },
        { id: 2, bom_cost: 520, change_reason: '面板涨价' },
      ],
    });
    const i = issues.find(x => x.type === 'snapshot_change');
    expect(i).toBeTruthy();
    expect(i!.title).toContain('上涨');
    expect(i!.detail).toContain('面板涨价');
  });

  it('快照微调 <1% → 不报', () => {
    const issues = computeProjectHealth({
      ...base,
      snapshots: [
        { id: 1, bom_cost: 500 },
        { id: 2, bom_cost: 501 },
      ],
    });
    expect(issues.find(x => x.type === 'snapshot_change')).toBeFalsy();
  });

  it('同品类模块报价偏高 → warn（价差 ≥¥10 且 ≥10%）', () => {
    const issues = computeProjectHealth({
      ...base,
      peerBoms: [
        { projectId: 2, code: 'P2', boms: [{ module_name: '显示模块', part_name: '面板', part_model: 'M270', part_cost: 450, quantity: 1 }] },
      ],
    });
    const i = issues.find(x => x.type === 'module_price_gap');
    expect(i).toBeTruthy();
    expect(i!.detail).toContain('P2');
    expect(i!.detail).toContain('50');
  });

  it('价差不足阈值 → 不报', () => {
    const issues = computeProjectHealth({
      ...base,
      peerBoms: [
        { projectId: 2, code: 'P2', boms: [{ module_name: '显示模块', part_name: '面板', part_model: 'M270', part_cost: 490, quantity: 1 }] },
      ],
    });
    expect(issues.find(x => x.type === 'module_price_gap')).toBeFalsy();
  });
});
