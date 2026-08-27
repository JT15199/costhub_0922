import { describe, it, expect } from 'vitest';
import { buildDataMapText } from './dataMap';

describe('buildDataMapText', () => {
  const s = { projects: 12, parts: 486, suppliers: 30, voice: 86, trends: 5, selling: 8, competitors: 4, targets: 2, worklogs: 40, memory: 15 };
  it('包含各数据域与访问工具', () => {
    const t = buildDataMapText(s);
    expect(t).toContain('项目 projects：12 个');
    expect(t).toContain('query_project_bom');
    expect(t).toContain('器件 parts：486 个');
    expect(t).toContain('query_material_insight');
    expect(t).toContain('用户原声 voice_item：86 条');
  });
  it('负值显示问号（表不存在兜底）', () => {
    const t = buildDataMapText({ ...s, memory: -1 });
    expect(t).toContain('ai_memory：? 条');
  });
});
