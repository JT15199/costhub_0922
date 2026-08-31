// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { AUTH_CHANGED_KEY, AUTH_KEY, AUTH_PLAIN_KEY, AUTH_USERNAME_KEY, DEFAULT_PASSWORD, DEFAULT_USERNAME, getRawDb, sha256 } from './core';

// 初始化密码（仅当未设置过时写入默认密码 666666 + 明文副本 + 默认用户名）
export async function ensureAuthPassword(): Promise<void> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
    if (rows.length === 0) {
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await sha256(DEFAULT_PASSWORD)]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_PLAIN_KEY, DEFAULT_PASSWORD]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '0']);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_USERNAME_KEY, DEFAULT_USERNAME]);
    }
  } catch (e) { console.error('初始化密码失败:', e); }
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



// 获取明文密码（用于找回显示；仅本地，未改过密码时返回默认密码）
export async function getPlainPassword(): Promise<string> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_PLAIN_KEY]);
    if (rows.length > 0 && rows[0].value) return rows[0].value;
    return DEFAULT_PASSWORD;
  } catch { return DEFAULT_PASSWORD; }
}



// 验证密码（用原始实例，绕过数据锁）
export async function verifyPassword(input: string): Promise<boolean> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
    if (rows.length === 0) return false;
    return (await sha256(input)) === rows[0].value;
  } catch (e) { console.error('验证密码失败:', e); return false; }
}



// 修改密码（验证旧密码后同步更新校验值与本机找回副本）
export async function changePassword(oldPwd: string, newPwd: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await verifyPassword(oldPwd))) return { ok: false, msg: '当前密码不正确' };
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: '新密码至少 4 位' };
  try {
    const raw = await getRawDb();
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await sha256(newPwd)]);
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_PLAIN_KEY, newPwd]);
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '1']);
    return { ok: true, msg: '密码已更新' };
  } catch (e: any) { return { ok: false, msg: `修改失败：${e?.message || e}` }; }
}
