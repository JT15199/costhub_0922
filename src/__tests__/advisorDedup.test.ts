import { describe, expect, it } from 'vitest';
import { decideAdvisorUpsert } from '../db/advisor';

describe('advisor issue lifecycle', () => {
  it('same evidence only refreshes and does not reopen', () => {
    expect(decideAdvisorUpsert({ status: 'dismissed', evidenceFingerprint: 'v1' }, 'v1')).toBe('refresh');
  });

  it('changed evidence reopens the same issue', () => {
    expect(decideAdvisorUpsert({ status: 'dismissed', evidenceFingerprint: 'v1' }, 'v2')).toBe('reopen');
  });

  it('missing issue creates a new one', () => {
    expect(decideAdvisorUpsert(null, 'v1')).toBe('create');
  });

  it('ten scans with unchanged evidence create only one reminder', () => {
    let current: { status: string; evidenceFingerprint: string } | null = null;
    let created = 0;
    for (let i = 0; i < 10; i += 1) {
      const decision = decideAdvisorUpsert(current, 'v1');
      if (decision === 'create') created += 1;
      current = { status: 'open', evidenceFingerprint: 'v1' };
    }
    expect(created).toBe(1);
  });
});
