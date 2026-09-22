export type SearchRequestMethod = 'GET' | 'POST';

export interface SearchRequest {
  method: SearchRequestMethod;
  url: string;
  body: string | null;
}

export type SearchProviderKind = 'tavily' | 'serper' | 'bing' | 'brave' | 'bocha' | 'searchapi' | 'exa' | 'unknown';

export function inferSearchProviderKind(nameOrUrl = '', baseUrl = ''): SearchProviderKind {
  const hint = `${nameOrUrl} ${baseUrl}`.toLowerCase();
  if (hint.includes('tavily')) return 'tavily';
  if (hint.includes('serper') || hint.includes('google.serper')) return 'serper';
  if (hint.includes('bing')) return 'bing';
  if (hint.includes('brave')) return 'brave';
  if (hint.includes('bocha') || hint.includes('博查')) return 'bocha';
  if (hint.includes('searchapi')) return 'searchapi';
  if (hint.includes('exa')) return 'exa';
  return 'unknown';
}

export function normalizeSearchEndpoint(nameOrUrl: string, rawBaseUrl = ''): string {
  const kind = inferSearchProviderKind(nameOrUrl, rawBaseUrl);
  let url = String(rawBaseUrl || '').replace(/\/+$/, '');
  if (!url && kind === 'tavily') url = 'https://api.tavily.com/search';
  if (!url && kind === 'bing') url = 'https://api.bing.microsoft.com/v7.0/search';
  if (!url && kind === 'serper') url = 'https://google.serper.dev/search';
  if (kind === 'serper' && url && !url.includes('/search')) url += '/search';
  return url;
}

export function buildSearchRequest(kind: SearchProviderKind, baseUrl: string, query: string): SearchRequest {
  const q = String(query || '');
  const url = String(baseUrl || '').replace(/\/+$/, '');
  switch (kind) {
    case 'tavily':
      return {
        method: 'POST',
        url: url || 'https://api.tavily.com/search',
        body: JSON.stringify({ query: q, search_depth: 'basic', max_results: 8, include_answer: false }),
      };
    case 'serper': {
      let finalUrl = url || 'https://google.serper.dev/search';
      if (!finalUrl.includes('/search')) finalUrl = `${finalUrl.replace(/\/+$/, '')}/search`;
      return {
        method: 'POST',
        url: finalUrl,
        body: JSON.stringify({ q, num: 8, gl: 'cn', hl: 'zh-CN', tbs: 'qdr:m3' }),
      };
    }
    case 'bing':
      return {
        method: 'GET',
        url: `${url || 'https://api.bing.microsoft.com/v7.0/search'}?q=${encodeURIComponent(q)}&count=8&mkt=zh-CN&freshness=Month`,
        body: null,
      };
    case 'brave':
      return {
        method: 'GET',
        url: `${url || 'https://api.search.brave.com/res/v1/web/search'}?q=${encodeURIComponent(q)}&count=8&search_lang=zh-hans&freshness=pm`,
        body: null,
      };
    case 'bocha':
      return {
        method: 'POST',
        url: url || 'https://api.bochaai.com/v1/web-search',
        body: JSON.stringify({ query: q, freshness: 'oneMonth', summary: true, count: 8 }),
      };
    case 'searchapi':
      return {
        method: 'GET',
        url: `${url || 'https://www.searchapi.io/api/v1/search'}?engine=google&q=${encodeURIComponent(q)}`,
        body: null,
      };
    case 'exa':
      return {
        method: 'POST',
        url: url || 'https://api.exa.ai/search',
        body: JSON.stringify({ query: q, numResults: 8, type: 'auto', contents: { text: { maxCharacters: 500 } } }),
      };
    default:
      return { method: 'POST', url: url || '', body: JSON.stringify({ query: q }) };
  }
}

export function buildSearchRequestFromUrl(endpoint: string, query: string): SearchRequest {
  const raw = String(endpoint || '').trim();
  const kind = inferSearchProviderKind(raw, raw);
  return buildSearchRequest(kind, normalizeSearchEndpoint(raw, raw), query);
}

/** Canonical JSON shown in the approval card and also used for the payload hash. */
export function searchRequestPreview(request: SearchRequest): string {
  return JSON.stringify({ body: request.body, method: request.method, url: request.url });
}

/** Keep the exact byte convention with the Rust gateway: method + newline + url + newline + body. */
export function searchRequestHashText(request: SearchRequest): string {
  return `${request.method}\n${request.url}\n${request.body ?? ''}`;
}
