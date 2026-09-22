import { describe, expect, it } from 'vitest';
import { bomExtendedCostStrict, sumBomCostStrict } from '../ai/contracts';

describe('strict BOM cost contract', () => {
  it('uses quantity for extended cost', () => {
    expect(bomExtendedCostStrict({ price_state: 'confirmed', part_cost: 10, quantity: 2 })).toBe(20);
  });

  it('distinguishes confirmed zero from legacy unknown zero', () => {
    expect(bomExtendedCostStrict({ price_state: 'confirmed', part_cost: 0, quantity: 1 })).toBe(0);
    expect(bomExtendedCostStrict({ part_cost: 0, quantity: 1 })).toBeNull();
  });

  it('keeps known total while reporting missing rows', () => {
    const result = sumBomCostStrict([
      { price_state: 'confirmed', part_cost: 10, quantity: 2 },
      { price_state: 'unknown', part_cost: 99, quantity: 1 },
    ]);
    expect(result.total).toBe(20);
    expect(result.missing).toHaveLength(1);
  });

  it('rejects negative quantity as invalid', () => {
    expect(bomExtendedCostStrict({ price_state: 'confirmed', part_cost: 10, quantity: -1 })).toBeNull();
  });
});
