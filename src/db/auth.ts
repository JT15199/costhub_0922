// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { AUTH_CHANGED_KEY, AUTH_KEY, AUTH_USERNAME_KEY, DEFAULT_PASSWORD, DEFAULT_USERNAME, getRawDb, sha256 } from './core';

const isValidPasswordHash = (value: string) => /^[0-9a-f]{64}$/i.test(value);

// 初始化密码。旧版本明文只允许在成功写入哈希后清理；任何失败都保留恢复入口。
let authInitializing: Promise<void> | null = null;
export function ensureAuthPassword(): Promise<void> {
  if (!authInitializing) authInitializing = initializeAuthPassword().finally(() => { authInitializing = null; });
  return authInitializing;
}

async function initializeAuthPassword(): Promise<void> {
  const raw = await getRawDb();
  const [hashRows, plainRows] = await Promise.all([
    raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]),
    raw.select<any[]>('SELECT value FROM settings WHERE key=?', ['auth_password_plain']),
  ]);
  const hash = String(hashRows[0]?.value || '');
  const legacy = String(plainRows[0]?.value || '');
  const install = async (value: string, changed: string) => {
    await raw.execute('BEGIN');
    try {
      await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, value]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, changed]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_USERNAME_KEY, DEFAULT_USERNAME]);
      if (legacy) await raw.execute("DELETE FROM settings WHERE key='auth_password_plain'");
      await raw.execute('COMMIT');
    } catch (error) {
      await raw.execute('ROLLBACK').catch(() => { });
      throw error;
    }
  };
  if (hash && isValidPasswordHash(hash)) {
    if (legacy) await install(hash, '0');
    return;
  }
  if (hash && !legacy) throw new Error('现有密码校验记录损坏，未找到可恢复密码');
  if (legacy) {
    await install(await sha256(legacy), '0');
    return;
  }
  await install(await sha256(DEFAULT_PASSWORD), '0');
}



// 获取用户名
export async function getUsername(): Promise<string> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_USERNAME_KEY]);
    return rows.length > 0 && rows[0].value ? rows[0].value : DEFAULT_USERNAME;
  } catch { return DEFAULT_USERNAME; }
}



// 修改用户名
export async function changeUsername(newName: string): Promise<{ ok: boolean; msg: string }> {
  if (!newName || !newName.trim()) return { ok: false, msg: '用户名不能为空' };
  try {
    const raw = await getRawDb();
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_USERNAME_KEY, newName.trim()]);
    return { ok: true, msg: '用户名已更新' };
  } catch (e: any) { return { ok: false, msg: `修改失败：${e?.message || e}` }; }
}



// 是否首次使用（未改过密码 → 登录页显示初始密码提示）
export async function isFirstUse(): Promise<boolean> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_CHANGED_KEY]);
    return rows.length === 0 || rows[0].value !== '1';
  } catch { return true; }
}



// 验证密码（用原始实例，绕过数据锁）
export async function verifyPassword(input: string): Promise<boolean> {
  await ensureAuthPassword();
  const raw = await getRawDb();
  const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
  if (!isValidPasswordHash(String(rows[0]?.value || ''))) throw new Error('密码校验记录未就绪，请重试');
  return (await sha256(input)).toLowerCase() === String(rows[0].value).toLowerCase();
}



// 修改密码（仅保存不可逆校验值）
export async function changePassword(oldPwd: string, newPwd: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await verifyPassword(oldPwd))) return { ok: false, msg: '当前密码不正确' };
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: '新密码至少 4 位' };
  try {
    const raw = await getRawDb();
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await sha256(newPwd)]);
    await raw.execute("DELETE FROM settings WHERE key='auth_password_plain'");
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '1']);
    return { ok: true, msg: '密码已更新' };
  } catch (e: any) { return { ok: false, msg: `修改失败：${e?.message || e}` }; }
}
