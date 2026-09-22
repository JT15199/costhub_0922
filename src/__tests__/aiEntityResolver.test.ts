import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  getProjects: async () => [
    { id: 1, code: 'M270', name: '27英寸项目', is_deleted: 0 },
    { id: 2, code: 'M271', name: '27英寸项目升级版', is_deleted: 0 },
  ],
}));

import { resolveProject } from '../ai/entityResolver';

describe('项目实体解析', () => {
  it('完全匹配自动选择，模糊匹配要求确认', async () => {
    expect((await resolveProject('M270')).selected?.id).toBe(1);
    expect((await resolveProject('27英寸')).selected).toBeNull();
  });
});
