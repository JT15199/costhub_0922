// 本地背景图持久化：优先 IndexedDB，避免大图转 Base64 后触发 localStorage 配额。
// 不使用网络请求；localStorage 仅作为旧版本/不支持 IndexedDB 时的兼容回退。
const DB_NAME = 'costhub-local-assets';
const STORE_NAME = 'backgrounds';
const KEY = 'current';

type StoredBackground = { id: string; dataUrl: string };

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
});

export async function loadStoredBackground(): Promise<string> {
  try {
    const db = await openDb();
    const value = await new Promise<StoredBackground | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () => resolve(request.result as StoredBackground | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (value?.dataUrl) return value.dataUrl;
  } catch { /* fallback below */ }
  try { return localStorage.getItem('costhub_custom_background') || ''; } catch { return ''; }
}

export async function saveStoredBackground(dataUrl: string | null): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      const request = dataUrl ? store.put({ id: KEY, dataUrl } satisfies StoredBackground) : store.delete(KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    // 删除旧版大字符串，避免它继续占用 localStorage 配额。
    try { localStorage.removeItem('costhub_custom_background'); } catch { /* ignore */ }
    return true;
  } catch {
    try {
      if (dataUrl) localStorage.setItem('costhub_custom_background', dataUrl);
      else localStorage.removeItem('costhub_custom_background');
      return true;
    } catch { return false; }
  }
}

