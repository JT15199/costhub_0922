// CostHub 机密模式：成本数据只能交给本机回环地址上的模型。
// 真正不可绕过的网络闸门位于 src-tauri/src/lib.rs；这里负责前端预检与清晰提示。
export const EXTERNAL_NETWORK_DENIED = '机密模式已禁止外部网络：成本数据和 AI 提示词只能发送给本机 Ollama';

export function normalizeLocalAiBaseUrl(value: string): string {
  const raw = String(value || 'http://127.0.0.1:11434').trim();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('本地模型地址无效，请使用 http://127.0.0.1:端口'); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(EXTERNAL_NETWORK_DENIED);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('本地模型只允许 HTTP/HTTPS 地址');
  if (host === 'localhost') parsed.hostname = '127.0.0.1';
  return parsed.toString().replace(/\/$/, '');
}

export function isLoopbackAiUrl(value: string): boolean {
  try { normalizeLocalAiBaseUrl(value); return true; } catch { return false; }
}
