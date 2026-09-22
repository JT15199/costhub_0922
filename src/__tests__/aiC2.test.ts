import { describe, expect, it } from 'vitest';
import { canonicalC2Body, c2SafeSystemPrompt, sanitizeC2Payload } from '../ai/c2Bridge';

describe('C2 脱敏抽象请求', () => {
  it('只接受白名单等级特征并按稳定顺序生成请求体', () => {
    const result = sanitizeC2Payload({
      domain: '显示器产品',
      features: { refresh_band: 'high', size_band: 'medium' },
      question: '判断公开市场趋势',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = canonicalC2Body({ ...result.payload, model: 'deepseek-chat', messages: [{ role: 'system', content: c2SafeSystemPrompt() }, { role: 'user', content: 'abstract' }] });
    expect(body).toContain('"model":"deepseek-chat"');
    expect(sanitizeC2Payload({ ...result.payload, features: { raw_model: 'high' } }).ok).toBe(false);
    expect(sanitizeC2Payload({ ...result.payload, domain: '项目 M270' }).ok).toBe(false);
  });
});
