// 数据就绪度纯函数测试（v2.3.19，2026-08-18）
import { describe, it, expect } from 'vitest';
import { readinessToText, type ReadinessItem } from './dataReadiness';

const mk = (level: 'ok' | 'partial' | 'missing'): ReadinessItem => ({
  key: 'k', name: '能力', level, have: '现状', impact: '影响描述', suggestion: '',
});

describe('readinessToText', () => {
  it('ok 项用「现在能」前缀', () => {
    const t = readinessToText([mk('ok')]);
    expect(t).toContain('✅ 有');
    expect(t).toContain('现在能：影响描述');
  });
  it('missing/partial 项用「缺了会」前缀', () => {
    expect(readinessToText([mk('missing')])).toContain('❌ 缺');
    expect(readinessToText([mk('missing')])).toContain('缺了会：影响描述');
    expect(readinessToText([mk('partial')])).toContain('⚠️ 半');
    expect(readinessToText([mk('partial')])).toContain('缺了会：影响描述');
  });
  it('有建议时追加建议行', () => {
    const t = readinessToText([{ ...mk('missing'), suggestion: '去补原声' }]);
    expect(t).toContain('建议：去补原声');
  });
  it('多行之间空行分隔，每项含名称', () => {
    const t = readinessToText([mk('ok'), { ...mk('missing'), name: '原声' }]);
    expect(t.split('\n\n')).toHaveLength(2);
    expect(t).toContain('【能力】');
    expect(t).toContain('【原声】');
  });
  it('空数组返回空串', () => {
    expect(readinessToText([])).toBe('');
  });
});
