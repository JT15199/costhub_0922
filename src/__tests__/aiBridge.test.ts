import { describe, it, expect } from 'vitest';
import { auditSensitive, sanitizeForCloud, SENSITIVE_PATTERNS } from '../aiBridge';

describe('auditSensitive 发送前审计', () => {
  it('正常脱敏提示词（含型号数字）通过', () => {
    const p = sanitizeForCloud({ material_name: '液晶面板 M270', category: '显示器件', question: '该物料近期价格走势与供需状况' });
    const r = auditSensitive(p);
    expect(r.safe).toBe(true);
    expect(r.matches).toEqual([]);
  });
  it('型号含长数字（EM68B32CWKG-25H）不误伤', () => {
    const p = sanitizeForCloud({ material_name: 'DDR3 EM68B32CWKG-25H', category: '存储', question: '该型号近期行情' });
    expect(auditSensitive(p).safe).toBe(true);
  });
  it('金额（¥）被拦截', () => {
    const p = '物料名称：屏\n品类：显示\n查询问题：价格走势\n我方成本约¥300/片';
    const r = auditSensitive(p);
    expect(r.safe).toBe(false);
    expect(r.matches.some(m => m.pattern.includes('金额'))).toBe(true);
  });
  it('金额（元）被拦截', () => {
    expect(auditSensitive('该物料成本 85 元').safe).toBe(false);
  });
  it('价格区间被拦截', () => {
    expect(auditSensitive('近期价格 100-120').safe).toBe(false);
    expect(auditSensitive('近期价格 100 至 120').safe).toBe(false);
  });
  it('供应商信息被拦截', () => {
    expect(auditSensitive('供应商：京东方').safe).toBe(false);
    expect(auditSensitive('份额：60%').safe).toBe(false);
  });
});

describe('sanitizeForCloud 模板白名单', () => {
  it('只含 物料名/品类/问题 三个字段位', () => {
    const p = sanitizeForCloud({ material_name: '面板', category: '显示', question: '走势?' });
    expect(p).toContain('物料名称：面板');
    expect(p).toContain('品类：显示');
    expect(p).toContain('查询问题：走势?');
    // 模板本身不含任何成本/供应商字段
    expect(auditSensitive(p).safe).toBe(true);
  });
  it('超长字段截断', () => {
    const p = sanitizeForCloud({ material_name: 'X'.repeat(300), category: 'Y'.repeat(100), question: 'Z'.repeat(500) });
    expect(p.length).toBeLessThan(600);
  });
});

describe('SENSITIVE_PATTERNS 覆盖', () => {
  it('所有模式编译有效', () => {
    for (const p of SENSITIVE_PATTERNS) {
      p.re.test('x'); // 不应抛错
    }
    expect(SENSITIVE_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });
});
