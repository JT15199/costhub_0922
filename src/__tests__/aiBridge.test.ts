import { describe, it, expect } from 'vitest';
import { auditSensitive, auditPromptStrict, sanitizeForCloud, SENSITIVE_PATTERNS, buildSanitizedContext, stripModelCodes, isProjectInsight, validateCloudQueryArgs, validatePublicModelQueryArgs } from '../aiBridge';
import { materialKey } from '../db/advisor';

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

describe('脱敏上下文（提示词红线）', () => {
  it('buildSanitizedContext 不含型号/金额/供应商/项目代号', () => {
    const ctx = buildSanitizedContext({
      insight_type: 'stale_part_price', ref_name: '屏',
      title: '物料「屏」¥300 已 90 天未调价',
      detail: '供应商：京东方，成本 ¥300，使用：P1(2件)、M270',
    });
    expect(ctx).not.toContain('京东方');
    expect(ctx).not.toContain('300');
    expect(ctx).not.toContain('M270');
    expect(auditPromptStrict(ctx).safe).toBe(true);
  });
  it('项目类建议不携带项目代号', () => {
    const ctx = buildSanitizedContext({ insight_type: 'stale_project_cost', ref_name: 'P1', detail: '整机成本 ¥1000' });
    expect(ctx).not.toContain('P1');
    expect(ctx).not.toContain('1000');
    expect(isProjectInsight({ insight_type: 'target_gap' })).toBe(true);
    expect(isProjectInsight({ insight_type: 'stale_part_price' })).toBe(false);
  });
  it('stripModelCodes 剥离型号', () => {
    expect(stripModelCodes('液晶面板 M270')).toBe('液晶面板');
    expect(stripModelCodes('DDR3 EM68B32CWKG-25H')).toBe('DDR3');
    expect(stripModelCodes('27寸屏')).toBe('屏');
  });
  it('云端提示词含型号被严格审计拦截', () => {
    const p = sanitizeForCloud({ material_name: '液晶面板 M270', category: '显示', question: '走势' });
    expect(auditSensitive(p).safe).toBe(true);       // 宽松审计放过
    expect(auditPromptStrict(p).safe).toBe(false);   // 严格审计拦截（型号）
  });
});

describe('validateCloudQueryArgs 云端工具闸门', () => {
  it('合法参数（通用名）通过', () => {
    const r = validateCloudQueryArgs({ material: '液晶面板', category: '显示器件', question: '近期价格走势' });
    expect(r.ok).toBe(true);
    expect(r.clean?.material).toBe('液晶面板');
  });
  it('含型号被拒', () => {
    const r = validateCloudQueryArgs({ material: '液晶面板 M270', question: '走势' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('敏感');
  });
  it('含金额被拒', () => {
    expect(validateCloudQueryArgs({ material: '屏', question: '我方成本¥300，近期走势' }).ok).toBe(false);
  });
  it('含供应商/项目代号被拒', () => {
    expect(validateCloudQueryArgs({ material: '屏', question: '京东方科技供货情况' }).ok).toBe(false);
    expect(validateCloudQueryArgs({ material: '屏', question: '供应商：京东方' }).ok).toBe(false);
    expect(validateCloudQueryArgs({ material: '屏', question: '项目P1用量' }).ok).toBe(false);
  });
  it('缺参数被拒', () => {
    expect(validateCloudQueryArgs({}).ok).toBe(false);
    expect(validateCloudQueryArgs({ material: '屏' }).ok).toBe(false);
  });
});

describe('validatePublicModelQueryArgs 受控公开型号路径', () => {
  it('允许型号数字但拒绝内部成本语境', () => {
    expect(validatePublicModelQueryArgs({ material: '27英寸显示器', category: '公开型号', question: '公开规格与接口' }).ok).toBe(true);
    expect(validatePublicModelQueryArgs({ material: '27英寸显示器', category: '公开型号', question: '我方成本和供应商报价' }).ok).toBe(false);
    expect(validatePublicModelQueryArgs({ material: '27英寸显示器', category: '显示器', question: '公开规格' }).ok).toBe(false);
  });
});

describe('materialKey 物料去重键', () => {
  it('归一化：全角/大小写/空格横线一致', () => {
    expect(materialKey('DDR3 512MB', '存储')).toBe(materialKey('ｄｄｒ３ 512-MB', '存储'));
    expect(materialKey('液晶面板 M270', '显示')).toBe(materialKey('液晶面板M270', '显示'));
  });
  it('品类参与区分', () => {
    expect(materialKey('屏', '显示')).not.toBe(materialKey('屏', '结构'));
  });
  it('空值安全', () => {
    expect(materialKey('', '')).toBe('|');
    expect(materialKey('屏', '')).toBeTruthy();
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
