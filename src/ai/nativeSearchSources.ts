// 原生联网搜索（DeepSeek Responses API / 兼容 OpenAI 结构）响应解析（2026-09-21）
// 背景：用户实测「日志显示成功但什么都没收集到」——旧实现按固定键名列表走查来源，
// 而 DeepSeek/OpenAI 的引用是嵌套结构 `{type:'url_citation', url_citation:{url,title}}`，
// 固定键名（url/link/href）取不到 → 来源数=0 → 结构化洞察判定"无可点击来源"→ 返回空壳结论。
// 这里改为"通用深度遍历 + 显式识别 url_citation"，并对文本做多层兜底。

export interface NativeSearchSource { title: string; url: string; snippet: string }

const TEXT_FIELDS = ['snippet', 'content', 'summary', 'text', 'description'] as const;
const TITLE_FIELDS = ['title', 'name', 'headline'] as const;
const URL_FIELDS = ['url', 'link', 'href', 'uri'] as const;

function pickString(source: any, fields: readonly string[]): string {
  for (const field of fields) {
    const value = source?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 从任意节点里抠出 URL（含 url_citation 嵌套、annotations 数组、字符串型 citation）。 */
export function extractCitationUrl(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return /^https?:\/\//i.test(node.trim()) ? node.trim() : '';
  const direct = pickString(node, URL_FIELDS);
  if (direct) return direct;
  for (const key of ['url_citation', 'citation', 'source', 'web', 'document']) {
    const nested = node[key];
    if (!nested) continue;
    if (typeof nested === 'string' && /^https?:\/\//i.test(nested.trim())) return nested.trim();
    const nestedUrl = pickString(nested, URL_FIELDS);
    if (nestedUrl) return nestedUrl;
  }
  return '';
}

function extractTitle(node: any): string {
  const direct = pickString(node, TITLE_FIELDS);
  if (direct) return direct;
  for (const key of ['url_citation', 'citation', 'source', 'web', 'document']) {
    const nested = node?.[key];
    const nestedTitle = pickString(nested, TITLE_FIELDS);
    if (nestedTitle) return nestedTitle;
  }
  return '';
}

/** 通用深度遍历收集带 URL 的来源（去重、限量）。 */
export function collectNativeSources(data: unknown, limit = 12): NativeSearchSource[] {
  const found: NativeSearchSource[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const pushUrl = (raw: string, title = '', snippet = '') => {
    const url = raw.trim();
    if (!/^https?:\/\//i.test(url) || found.length >= limit) return;
    const key = url.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ title: title || url, url, snippet });
  };
  const visit = (node: any, depth: number) => {
    if (!node || depth > 6 || found.length >= limit || visited > 4000) return;
    if (typeof node === 'string') { pushUrl(node); return; }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    visited += 1;
    const url = extractCitationUrl(node);
    if (url) pushUrl(url, extractTitle(node), pickString(node, TEXT_FIELDS));
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
      else if (typeof value === 'string') pushUrl(value);
    }
  };
  visit(data, 0);
  return found;
}

/** 从响应里取模型正文（Responses API 的 output_text / output[].content[].text / choices 兼容）。 */
export function collectNativeText(data: any): string {
  const collect = (value: any, depth = 0): string => {
    if (!value || depth > 6) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => collect(item, depth + 1)).join('');
    if (typeof value !== 'object') return '';
    if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text;
    if ((value.type === 'output_text' || value.type === 'text') && typeof value.text === 'string') return value.text;
    if (value.type === 'url_citation') return '';
    return collect(value.content, depth + 1) || collect(value.output, depth + 1) || (typeof value.text === 'string' ? value.text : '');
  };
  const candidates = [
    typeof data?.output_text === 'string' ? data.output_text : '',
    collect(data?.output),
    collect(data?.response?.output),
    collect(data?.data?.output),
    typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '',
    typeof data?.answer === 'string' ? data.answer : '',
    typeof data?.content === 'string' ? data.content : '',
    typeof data?.text === 'string' ? data.text : '',
  ];
  return candidates.map(value => String(value || '')).find(value => value.trim()) || '';
}

/** 响应结构摘要，便于诊断（不记录正文内容）。 */
export function describeNativeShape(data: any): string {
  try {
    return JSON.stringify({
      keys: Object.keys(data || {}),
      outputTypes: Array.isArray(data?.output) ? data.output.map((item: any) => item?.type).filter(Boolean) : [],
      contentTypes: Array.isArray(data?.output?.[0]?.content) ? data.output[0].content.map((item: any) => item?.type).filter(Boolean) : [],
      choiceKeys: data?.choices?.[0]?.message ? Object.keys(data.choices[0].message) : [],
    }).slice(0, 240);
  } catch { return '{}'; }
}
