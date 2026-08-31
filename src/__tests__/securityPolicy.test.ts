import { describe, expect, it } from 'vitest';
import { isLoopbackAiUrl, normalizeLocalAiBaseUrl } from '../securityPolicy';

describe('机密模式网络策略', () => {
  it('允许并规范化本机 Ollama 地址', () => {
    expect(normalizeLocalAiBaseUrl('http://localhost:11434')).toBe('http://127.0.0.1:11434');
    expect(isLoopbackAiUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackAiUrl('http://[::1]:11434')).toBe(true);
  });

  it('拒绝公网与局域网模型地址', () => {
    expect(isLoopbackAiUrl('https://api.example.com/v1')).toBe(false);
    expect(isLoopbackAiUrl('http://192.168.1.8:11434')).toBe(false);
    expect(isLoopbackAiUrl('http://10.0.0.8:11434')).toBe(false);
  });
});
