import { describe, expect, it } from 'vitest';
import { buildConfirmedPackageDeltaVector, buildTargetDomainRows, calculateTargetAllocation } from '../db/architecture';

describe('target allocation', () => {
  it('does not allocate more than a domain confirmed opportunity', () => {
    const rows = calculateTargetAllocation([{ domain: '硬件类', baseline: 80 }, { domain: '包材类', baseline: 20 }], 50, { 硬件类: 10, 包材类: 0 });
    expect(rows[0].allocated).toBe(10);
    expect(rows[0].target).toBe(70);
    expect(rows[1].allocated).toBe(0);
  });
});

describe('confirmed baseline opportunities', () => {
  it('uses confirmed material baselines without lowering a domain below zero', () => {
    const rows = buildTargetDomainRows([
      { part_id: 7, main_category: '硬件类', quantity: 2, part_cost: 12, line_total: 24 },
      { part_id: 8, main_category: '硬件类', quantity: 1, part_cost: 5, line_total: 5 },
    ], [{ baseline_type: 'material', scope_key: 'part:7', value: 8, project_id: 0 }], 3);
    expect(rows[0]).toMatchObject({ current: 29, baseline: 21, opportunity: 8 });
  });

  it('does not reuse confirmed baseline reduction as a second target opportunity', () => {
    const rows = buildTargetDomainRows([{ part_id: 7, main_category: '硬件类', quantity: 1, part_cost: 100, line_total: 100 }], [{ baseline_type: 'material', scope_key: 'part:7', value: 80, project_id: 0 }], 3);
    expect(rows[0]).toMatchObject({ current: 100, baseline: 80, opportunity: 20 });
  });
});

describe('confirmed package conservation', () => {
  it('keeps required additions in the same signed vector instead of proportional allocation', () => {
    const vector = buildConfirmedPackageDeltaVector([
      { package_id: 1, package_status: 'confirmed', module_name: '屏幕', cost_before: 100, cost_after: 80, evidence_json: JSON.stringify({ sourceVersionId: 3 }) },
      { package_id: 1, package_status: 'confirmed', module_name: '互联', cost_before: 5, cost_after: 20, evidence_json: JSON.stringify({ sourceVersionId: 3 }) },
    ], [
      { module_name: '屏幕', main_category: '硬件类' },
      { module_name: '互联', main_category: '线材类' },
    ]);
    expect(vector).toEqual({ 硬件类: -20, 线材类: 15 });
  });

  it('does not commit a confirmed package with empty evidence', () => {
    expect(buildConfirmedPackageDeltaVector([
      { package_id: 1, package_status: 'confirmed', module_name: '屏幕', cost_before: 100, cost_after: 80, evidence_json: '{}' },
    ], [{ module_name: '屏幕', main_category: '硬件类' }])).toEqual({});
  });
});
