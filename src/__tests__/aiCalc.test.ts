import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../ai/calc';

describe('evaluateExpression', () => {
  it('只计算受限四则表达式', () => {
    expect(evaluateExpression('(520 + 185 * 2) * 1.05')).toBe(934.5);
    expect(evaluateExpression('15% * 200')).toBe(30);
    expect(evaluateExpression('-5 + 2')).toBe(-3);
  });

  it('拒绝代码、除零和不完整表达式', () => {
    expect(() => evaluateExpression('globalThis.alert(1)')).toThrow();
    expect(() => evaluateExpression('1 / 0')).toThrow('除数不能为 0');
    expect(() => evaluateExpression('1 +')).toThrow();
  });
});
