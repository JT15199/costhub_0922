import { describe, it, expect } from 'vitest';
import { parseQuoteReview } from '../quoteReview';

describe('parseQuoteReview — AI 审价结果解析', () => {
  it('标准 JSON', () => {
    const r = parseQuoteReview('{"items":[{"index":1,"item":"面板","verdict":"虚高","fair_price":"¥550","reason":"比系统参考高10%","negotiate":"按¥550谈"}]}');
    expect(r.length).toBe(1);
    expect(r[0].verdict).toBe('虚高');
    expect(r[0].fair_price).toBe('¥550');
    expect(r[0].negotiate).toBe('按¥550谈');
  });
  it('中文判定归一（"价格明显虚高"→虚高）', () => {
    const r = parseQuoteReview('{"items":[{"index":1,"item":"电源","verdict":"价格明显虚高"}]}');
    expect(r[0].verdict).toBe('虚高');
  });
});
