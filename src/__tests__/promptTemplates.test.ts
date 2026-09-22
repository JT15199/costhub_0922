import { expect, it } from 'vitest';
import { splitPreviewPayload, splitPromptSegments } from '../ai/promptTemplates';

const TEMPLATES = [
  { label: '内置技能「价格趋势分析」', text: '你是价格趋势分析专家。请按四因子框架分析价格走势，并给出证据。' },
  { label: '云端安全系统提示词（内置）', text: '你是公开信息助手，只依据已批准的公开内容回答。' },
];

it('内置模板整段命中时标记为 builtin，动态内容单独成段', () => {
  const text = '开头说明。\n你是价格趋势分析专家。请按四因子框架分析价格走势，并给出证据。\n物料：驱动板\n品类：显示器';
  const segments = splitPromptSegments(text, TEMPLATES);
  expect(segments.map(segment => segment.kind)).toEqual(['dynamic', 'builtin', 'dynamic']);
  expect(segments[1].label).toBe('内置技能「价格趋势分析」');
  expect(segments[2].text).toContain('驱动板');
});

it('多段模板命中时全部折叠，动态内容一字不丢', () => {
  const text = 'A 你是公开信息助手，只依据已批准的公开内容回答。 B 你是价格趋势分析专家。请按四因子框架分析价格走势，并给出证据。 C';
  const segments = splitPromptSegments(text, TEMPLATES);
  expect(segments.filter(segment => segment.kind === 'builtin')).toHaveLength(2);
  expect(segments.filter(segment => segment.kind === 'dynamic').map(segment => segment.text.trim()).filter(Boolean)).toEqual(['A', 'B', 'C']);
  expect(segments.map(segment => segment.text).join('')).toBe(text);
});

it('没有任何命中时整段算动态（新增提示词必须让用户看）', () => {
  const segments = splitPromptSegments('这是一段全新写法的提示词，需要人工核对。', TEMPLATES);
  expect(segments).toHaveLength(1);
  expect(segments[0].kind).toBe('dynamic');
});

it('载荷是 messages 形状时按条拆分并统计折叠字数', () => {
  const payload = JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是公开信息助手，只依据已批准的公开内容回答。' },
      { role: 'user', content: '物料：驱动板\n品类：显示器\n请分析近 1-3 月公开价格趋势。' },
    ],
  });
  const split = splitPreviewPayload(payload, TEMPLATES);
  expect(split).not.toBeNull();
  expect(split!.messages).toHaveLength(2);
  expect(split!.messages[0].builtinChars).toBeGreaterThan(0);
  expect(split!.messages[0].dynamicChars).toBe(0);
  expect(split!.messages[1].builtinChars).toBe(0);
  expect(split!.dynamicChars).toBeGreaterThan(0);
  expect(split!.builtinLabels).toContain('云端安全系统提示词（内置）');
});

it('原生搜索 input 形状也能拆；非 messages 载荷返回 null 由调用方退回原文', () => {
  const native = JSON.stringify({ model: 'deepseek-chat', tools: [{ type: 'web_search' }], input: [{ role: 'system', content: '你是价格趋势分析专家。请按四因子框架分析价格走势，并给出证据。' }, { role: 'user', content: '物料：铜' }] });
  expect(splitPreviewPayload(native, TEMPLATES)!.messages).toHaveLength(2);
  expect(splitPreviewPayload(JSON.stringify({ method: 'POST', url: 'https://api.tavily.com/search', body: '{"query":"铜"}' }), TEMPLATES)).toBeNull();
});
