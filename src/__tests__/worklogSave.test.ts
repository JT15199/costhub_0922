import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(async () => []) }));
vi.mock('../db/core', async importOriginal => ({
  ...await importOriginal<typeof import('../db/core')>(),
  getDb: async () => state,
}));
import { saveWorkLog } from '../db/worklog';

it('retries SQLite write locks for new and edited notes without duplicating a successful write', async () => {
  for (const data of [{ content: '新手账', work_project: '手写项目' }, { id: 9, content: '编辑手账', project_id: 3 }]) {
    state.execute.mockReset().mockRejectedValueOnce('数据库写入失败: (code: 5) database is locked').mockResolvedValueOnce({ rowsAffected: 1, lastInsertId: 9 });
    await expect(saveWorkLog(data)).resolves.toBe(9);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[0]).toEqual(state.execute.mock.calls[1]);
  }
  state.execute.mockReset().mockRejectedValue(new Error('database is locked'));
  await expect(saveWorkLog({ content: '保留草稿' })).rejects.toThrow('database is locked');
  expect(state.execute).toHaveBeenCalledTimes(4);
  state.execute.mockReset().mockRejectedValue(new Error('constraint failed'));
  await expect(saveWorkLog({ content: '不重试其他错误' })).rejects.toThrow('constraint failed');
  expect(state.execute).toHaveBeenCalledTimes(1);
});

it('keeps explicitly unlinked notebook records independent of same-named projects', async () => {
  state.select.mockClear();
  state.execute.mockReset().mockResolvedValue({ rowsAffected: 1, lastInsertId: 10 });
  await saveWorkLog({ content: '独立记录', project_id: 0, work_project: '同名项目' });
  expect(state.select).not.toHaveBeenCalled();
  const [sql, values] = state.execute.mock.calls[0];
  const columns = sql.match(/\(([^)]+)\)/)[1].split(',');
  expect(values[columns.indexOf('project_id')]).toBe(0);
});
