import { describe, expect, it } from 'vitest';
import { resolveLibraryTab } from '../pages/Library';
import { buildContinuePrompt } from '../pages/AnalysisResults';

describe('资料库深链接', () => {
  it('把旧入口和资料库页签映射到唯一页签', () => {
    expect(resolveLibraryTab('supplierManagement')).toBe('suppliers');
    expect(resolveLibraryTab('competitors')).toBe('competitors');
    expect(resolveLibraryTab('unknown')).toBeUndefined();
  });
});

describe('分析成果继续问 AI 上下文', () => {
  it.each([
    ['project_cost', { projectId: 8, baseline: 845 }],
    ['quote_review', { supplier: '华东 ODM', quote: 1298 }],
    ['product_voice', { theme: '支架稳定性', count: 24 }],
  ])('保留 %s 成果的对象与已保存数据', (resultForm, savedData) => {
    const prompt = buildContinuePrompt({
      id: 1,
      item_key: `test-${resultForm}`,
      domain: resultForm === 'project_cost' ? 'project' : resultForm === 'quote_review' ? 'quote' : 'product',
      result_form: resultForm,
      object_type: 'test',
      object_id: 8,
      object_name: 'CM27QHD180-26',
      title: '已保存结论',
      summary: '成本与风险摘要',
      data_json: JSON.stringify(savedData),
      source_json: JSON.stringify({ source_url: 'https://example.com/evidence' }),
      favorite: 0,
      archived: 0,
    } as any);
    expect(prompt).toContain('不要从零开始');
    expect(prompt).toContain('CM27QHD180-26');
    expect(prompt).toContain(JSON.stringify(savedData));
    expect(prompt).toContain('https://example.com/evidence');
  });
});
