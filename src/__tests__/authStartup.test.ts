import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => bridge);
let db: DatabaseSync;
afterEach(() => { db?.close(); vi.resetModules(); });

it('fresh SQLite: concurrent locked reads and immediate default login wait for schema; existing password survives; I/O errors are not wrong-password results', async () => {
  db = new DatabaseSync(':memory:');
  let fail = false;
  bridge.invoke.mockImplementation(async (command: string, args: any) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (command === 'get_db_path' || command === 'sql_load') return 'sqlite:test';
    if (command === 'sql_close') return true;
    const { query, values } = args.request;
    if (fail && query.includes('auth_password') || fail && values?.includes('auth_password_hash')) throw new Error('disk read failed');
    const statement = db.prepare(query);
    if (command === 'sql_select') return statement.all(...values);
    const result = statement.run(...values);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  });
  const core = await import('../db/core');
  const auth = await import('../db/auth');
  const results = await Promise.all([
    core.getDb().then(d => d.select('SELECT * FROM projects')),
    auth.ensureAuthPassword(), auth.verifyPassword('666666'), auth.verifyPassword('wrong'),
  ]);
  expect(results).toEqual([[], undefined, true, false]);
  expect(await auth.getUsername()).toBe('admin');
  expect(await auth.changePassword('666666', 'custom-secret')).toMatchObject({ ok: true });
  await core.closeDbConnections();
  await Promise.all([auth.ensureAuthPassword(), core.getDb()]);
  expect(await auth.verifyPassword('666666')).toBe(false);
  expect(await auth.verifyPassword('custom-secret')).toBe(true);
  fail = true;
  await expect(auth.verifyPassword('666666')).rejects.toThrow('disk read failed');
  fail = false;
  expect(await auth.verifyPassword('custom-secret')).toBe(true);
}, 20000);
