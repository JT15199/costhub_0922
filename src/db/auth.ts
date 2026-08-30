// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { AUTH_CHANGED_KEY, AUTH_KEY, AUTH_PLAIN_KEY, AUTH_USERNAME_KEY, DEFAULT_PASSWORD, DEFAULT_USERNAME, getRawDb, sha256 } from './core';

const PASSWORD_HASH_VERSION = 2;
const PASSWORD_HASH_ITERATIONS = 210_000;

interface PasswordRecord { v: number; iterations: number; salt: string; hash: string }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, baseKey, 256,
  );
  return new Uint8Array(bits);
}

async function createPasswordRecord(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
  return JSON.stringify({
    v: PASSWORD_HASH_VERSION, iterations: PASSWORD_HASH_ITERATIONS,
    salt: bytesToBase64(salt), hash: bytesToBase64(hash),
  } satisfies PasswordRecord);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function verifyPasswordRecord(input: string, stored: string): Promise<boolean> {
  try {
    const record = JSON.parse(stored) as PasswordRecord;
    if (record.v !== PASSWORD_HASH_VERSION || !record.salt || !record.hash || !record.iterations) return false;
    const actual = await derivePasswordHash(input, base64ToBytes(record.salt), record.iterations);
    return safeEqual(actual, base64ToBytes(record.hash));
  } catch { return false; }
}



// 初始化密码：仅保存带随机盐的 PBKDF2 记录；旧版明文副本启动时自动清理
export async function ensureAuthPassword(): Promise<void> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
    if (rows.length === 0) {
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await createPasswordRecord(DEFAULT_PASSWORD)]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '0']);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_USERNAME_KEY, DEFAULT_USERNAME]);
    }
    await raw.execute('DELETE FROM settings WHERE key=?', [AUTH_PLAIN_KEY]);
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



// 验证密码（用原始实例，绕过数据锁）。旧版 SHA-256 记录成功后就地迁移。
export async function verifyPassword(input: string): Promise<boolean> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
    if (rows.length === 0) return false;
    const stored = String(rows[0].value || '');
    if (stored.startsWith('{')) return verifyPasswordRecord(input, stored);
    const legacyOk = (await sha256(input)) === stored;
    if (legacyOk) {
      await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await createPasswordRecord(input)]);
      await raw.execute('DELETE FROM settings WHERE key=?', [AUTH_PLAIN_KEY]);
    }
    return legacyOk;
  } catch (e) { console.error('验证密码失败:', e); return false; }
}



// 修改密码（验证旧密码后写入带随机盐的 PBKDF2 记录，不保存明文）
export async function changePassword(oldPwd: string, newPwd: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await verifyPassword(oldPwd))) return { ok: false, msg: '当前密码不正确' };
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: '新密码至少 4 位' };
  try {
    const raw = await getRawDb();
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await createPasswordRecord(newPwd)]);
    await raw.execute('DELETE FROM settings WHERE key=?', [AUTH_PLAIN_KEY]);
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '1']);
    return { ok: true, msg: '密码已更新' };
  } catch (e: any) { return { ok: false, msg: `修改失败：${e?.message || e}` }; }
}
