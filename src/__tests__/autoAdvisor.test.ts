import { describe, it, expect } from 'vitest';
import { buildRuleCandidates, daysBetween } from '../autoAdvisor';
import { auditPromptStrict } from '../aiBridge';
import type { RuleInput } from '../autoAdvisor';

const NOW = new Date('2026-08-14T10:00:00');

function baseInput(): RuleInput {
  return {
    projects: [
      { id: 1, code: 'P1', name: '项目一', project_type: '在研', created_at: '2026-01-01 10:00:00' },
      { id: 2, code: 'P2', name: '项目二', project_type: '在研', created_at: '2026-08-01 10:00:00' },
    ],
    bomsByProject: {
      1: [
        { part_id: 11, part_name: '屏', part_model: 'M270', part_cost: 300, quantity: 1, main_category: '硬件类' },
        { part_id: 12, part_name: 'PCB', part_model: 'B100', part_cost: 80, quantity: 2, main_category: '硬件类' },
      ],
      2: [{ part_id: 13, part_name: '外壳', part_model: 'S1', part_cost: 20, quantity: 1, main_category: '结构类' }],
    },
    snapshotLastAt: { 1: '2026-01-15 10:00:00' }, // P1 快照 7 个月前
    parts: [
      { id: 11, name: '屏', model: 'M270', cost: 300, updated_at: '2026-01-10 10:00:00', main_category: '硬件类' },
      { id: 12, name: 'PCB', model: 'B100', cost: 160, updated_at: '2026-08-10 10:00:00', main_category: '硬件类' },
      { id: 13, name: '外壳', model: 'S1', cost: 20, updated_at: '2026-08-10 10:00:00', main_category: '结构类' },
      { id: 14, name: '小螺丝', model: 'X1', cost: 0.05, updated_at: '2026-01-01 10:00:00', main_category: '结构类' }, // 低于大额阈值，不应出现
    ],
    suppliersByPart: {
      11: [{ supplier_name: '京东方', price: 300, is_active: 1 }], // 屏单一供应商
      13: [{ supplier_name: 'A厂', price: 20, is_active: 1 }, { supplier_name: 'B厂', price: 19, is_active: 1 }],
    },
    targetsByProject: {},
    now: NOW,
  };
}

describe('daysBetween', () => {
  it('计算天数', () => {
    expect(daysBetween(NOW, '2026-08-10 10:00:00')).toBe(4);
    expect(daysBetween(NOW, '2026-08-14 10:00:00')).toBe(0);
    expect(daysBetween(NOW, undefined)).toBeNull();
    expect(daysBetween(NOW, 'bad-date')).toBeNull();
  });
});

describe('buildRuleCandidates', () => {
  it('项目成本长期未变动（快照 >60 天）→ 提醒，且含大额物料 top3', () => {
    const out = buildRuleCandidates(baseInput());
    const spc = out.filter(c => c.insight_type === 'stale_project_cost');
    expect(spc.length).toBe(1);
    expect(spc[0].ref_name).toBe('P1');
    expect(spc[0].title).toContain('P1');
    expect(spc[0].detail).toContain('屏');
    expect(spc[0].prompt).toContain('资深成本经理');
  });

  it('新项目（快照不久）不提醒', () => {
    const input = baseInput();
    input.snapshotLastAt[1] = '2026-08-10 10:00:00';
    const out = buildRuleCandidates(input);
    expect(out.filter(c => c.insight_type === 'stale_project_cost').length).toBe(0);
  });

  it('大额物料 90 天未调价 → 提醒；小物料不提醒', () => {
    const out = buildRuleCandidates(baseInput());
    const spp = out.filter(c => c.insight_type === 'stale_part_price');
    expect(spp.length).toBe(1); // 只有屏（PCB 8月10日更新过）
    expect(spp[0].ref_id).toBe(11);
    expect(spp[0].title).toContain('300');
  });

  it('单一供应商（大额 + 仅一家启用）→ 提醒；两家不提醒', () => {
    const out = buildRuleCandidates(baseInput());
    const ss = out.filter(c => c.insight_type === 'single_supplier');
    expect(ss.length).toBe(1);
    expect(ss[0].ref_id).toBe(11);
    // 供应商名只留在 detail（本地展示），提示词必须脱敏
    expect(ss[0].detail).toContain('京东方');
    expect(ss[0].prompt).not.toContain('京东方');
  });

  it('领域超目标 ≥5% → 提醒；未超不提醒', () => {
    const input = baseInput();
    input.targetsByProject = {
      1: [
        { project_id: 1, domain: '硬件类', target_cost: 300 }, // 实际 460 → 超 53%
        { project_id: 2, domain: '结构类', target_cost: 20 },  // 实际 20 → 达标
      ],
    };
    const out = buildRuleCandidates(input);
    const tg = out.filter(c => c.insight_type === 'target_gap');
    expect(tg.length).toBe(1);
    expect(tg[0].ref_name).toBe('P1');
    expect(tg[0].title).toContain('超目标');
  });

  it('提示词全部脱敏（无型号/厂家/成本，通过严格审计）', () => {
    const out = buildRuleCandidates(baseInput());
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      const r = auditPromptStrict(c.prompt);
      expect(r.safe, c.insight_type + ': ' + c.prompt + ' → ' + JSON.stringify(r.matches)).toBe(true);
    }
  });

  it('指纹唯一且稳定', () => {
    const a = buildRuleCandidates(baseInput());
    const b = buildRuleCandidates(baseInput());
    expect(a.map(c => c.fingerprint).sort()).toEqual(b.map(c => c.fingerprint).sort());
    const fps = a.map(c => c.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
