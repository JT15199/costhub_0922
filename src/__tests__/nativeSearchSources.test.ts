import { expect, it } from 'vitest';
import { collectNativeSources, collectNativeText, extractCitationUrl } from '../ai/nativeSearchSources';

it('识别 DeepSeek/OpenAI 的嵌套 url_citation 引用（旧实现取不到的那一种）', () => {
  const payload = {
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: '{"trend_direction":"上涨","summary":"铜价小幅上行"}', annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/copper', title: '铜价月报', start_index: 0, end_index: 10 } }] },
        ],
      },
      { type: 'web_search_call', status: 'completed' },
    ],
  };
  const sources = collectNativeSources(payload);
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({ url: 'https://example.com/copper', title: '铜价月报' });
});

it('兼容扁平 results / citations / 字符串 URL 三种形态并去重限量', () => {
  const payload = {
    results: [
      { url: 'https://a.example.com/1', title: 'A', content: '摘要 A' },
      { url: 'https://a.example.com/1#frag', title: 'A 重复' },
      { url: 'https://b.example.com/2', title: 'B', snippet: '摘要 B' },
    ],
    citations: ['https://c.example.com/3'],
  };
  const sources = collectNativeSources(payload);
  expect(sources.map(source => source.url)).toEqual(['https://a.example.com/1', 'https://b.example.com/2', 'https://c.example.com/3']);
  expect(sources[0].snippet).toBe('摘要 A');
  expect(collectNativeSources(payload, 2)).toHaveLength(2);
});

it('从 output[].content[].text 取正文，且不会把引用节点当成正文', () => {
  const text = collectNativeText({ output: [{ type: 'message', content: [{ type: 'output_text', text: '分析正文' }, { type: 'url_citation', url: 'https://x.example.com' }] }] });
  expect(text).toBe('分析正文');
  expect(collectNativeText({ output_text: '直接字段' })).toBe('直接字段');
  expect(collectNativeText({ choices: [{ message: { content: '兼容 chat 结构' } }] })).toBe('兼容 chat 结构');
});

it('extractCitationUrl 覆盖各种嵌套键', () => {
  expect(extractCitationUrl({ url_citation: { url: 'https://n1.example.com' } })).toBe('https://n1.example.com');
  expect(extractCitationUrl({ citation: { link: 'https://n2.example.com' } })).toBe('https://n2.example.com');
  expect(extractCitationUrl({ source: 'https://n3.example.com' })).toBe('https://n3.example.com');
  expect(extractCitationUrl({ title: '没有链接' })).toBe('');
});
