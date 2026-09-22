import { beforeEach, expect, it } from 'vitest';
import { classifyProviderError, clearProviderFailure, markProviderFailure, providerCooldown, providerCooldownReason, resetProviderHealth } from '../ai/providerHealth';

beforeEach(() => resetProviderHealth());

it('额度不足与鉴权失败归类为长时间冷却（不再反复申请审批）', () => {
  expect(classifyProviderError('DeepSeek 官方 HTTP 402: {"error":{"message":"Insufficient Balance"}}')).toBe('quota');
  expect(classifyProviderError('DeepSeek 官方 HTTP 401: invalid_api_key')).toBe('auth');
  markProviderFailure('DeepSeek 官方', 'HTTP 402: Insufficient Balance');
  const cooldown = providerCooldown('DeepSeek 官方');
  expect(cooldown.cooling).toBe(true);
  expect(cooldown.kind).toBe('quota');
  expect(providerCooldownReason('DeepSeek 官方')).toContain('云端额度不足');
  expect(providerCooldownReason('DeepSeek 官方')).toContain('设置 → AI 服务');
});

it('网络类冷却很短：过了窗口自动恢复尝试', () => {
  markProviderFailure('DeepSeek 官方', '网络请求失败: timeout');
  const now = Date.now();
  expect(providerCooldown('DeepSeek 官方', now).cooling).toBe(true);
  expect(providerCooldown('DeepSeek 官方', now + 3 * 60_000).cooling).toBe(false);
});

it('成功的调用清除冷却记录', () => {
  markProviderFailure('Tavily', 'HTTP 402');
  expect(providerCooldown('Tavily').cooling).toBe(true);
  clearProviderFailure('Tavily');
  expect(providerCooldown('Tavily').cooling).toBe(false);
});

it('未记录的供应商不受影响', () => {
  expect(providerCooldown('未配置的供应商').cooling).toBe(false);
  expect(providerCooldownReason('未配置的供应商')).toBe('');
});
