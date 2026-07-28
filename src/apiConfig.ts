/**
 * API Key 加密存储工具
 * 使用 Web Crypto API (AES-GCM) 加密，密钥基于设备指纹派生
 * 用于加密存储在 api_providers 表中的 API Key
 */

const ALGORITHM = 'AES-GCM';

// 从设备信息派生加密密钥（不依赖外部，同一设备可解密）
async function deriveKey(salt: BufferSource): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const fp = [
    navigator.userAgent || '',
    `${window.screen.width}x${window.screen.height}`,
    'costhub-secure-vault-2026',
  ].join('|');

  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(fp),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    baseKey,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 加密明文，返回 base64 编码的密文 */
export async function encryptText(plaintext: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const key = await deriveKey(salt);
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    enc.encode(plaintext)
  );

  const bundle = {
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
  return JSON.stringify(bundle);
}

/** 解密 base64 编码的密文，返回明文 */
export async function decryptText(cipherBundle: string): Promise<string> {
  try {
    const bundle = JSON.parse(cipherBundle);
    const salt = new Uint8Array(atob(bundle.salt).split('').map(c => c.charCodeAt(0)));
    const iv = new Uint8Array(atob(bundle.iv).split('').map(c => c.charCodeAt(0)));
    const data = new Uint8Array(atob(bundle.data).split('').map(c => c.charCodeAt(0)));

    const key = await deriveKey(salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      data
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error('API Key 解密失败，可能是跨设备或浏览器数据已清除');
  }
}

/** 检查是否已配置 LLM（任一 LLM 供应商有 Key 即可） */
export async function hasLLMConfig(): Promise<boolean> {
  try {
    const { getApiProviders } = await import('./db');
    const providers = await getApiProviders();
    return providers.some((p: any) => p.provider_type === 'llm' && p.api_key && p.api_key !== '');
  } catch {
    return false;
  }
}

/** 检查是否已配置搜索（任一搜索供应商有 Key 即可） */
export async function hasSearchConfig(): Promise<boolean> {
  try {
    const { getApiProviders } = await import('./db');
    const providers = await getApiProviders();
    return providers.some((p: any) => p.provider_type === 'search' && p.api_key && p.api_key !== '');
  } catch {
    return false;
  }
}
