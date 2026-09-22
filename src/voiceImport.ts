const HEADER_WORDS = ['评价内容', '评价', '评论内容', '评论', '反馈', '内容', '意见', '点评', '口碑', 'review', 'comment', 'content', 'text'];
const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase();
const natural = (value: string) => /[\u4e00-\u9fffA-Za-z]{2,}/.test(value) && !/^\d+[./-]?\d*$/.test(value);

export type VoiceSheetDetection = { sheetName: string; rows: any[][]; headerRow: number; contentColumn: number; headers: string[]; contents: string[]; preview: string[]; confidence: number; headerFound: boolean };

export function isLikelyVoiceAttachment(name: string, detection: Pick<VoiceSheetDetection, 'confidence' | 'headerFound'>): boolean {
  const fileHint = /评论|评价|原声|反馈|review|comment|voice/i.test(String(name || ''));
  return detection.confidence >= 0.32 && (detection.headerFound || fileHint);
}

function scoreHeader(row: any[], body: any[][]) {
  const cells = row.map(normalize); const hits = cells.filter(c => HEADER_WORDS.some(word => c === word || c.includes(word))).length;
  const nonEmpty = cells.filter(Boolean).length; const continuity = body.slice(0, 8).filter(r => r?.some((c: any) => String(c ?? '').trim())).length;
  return hits * 5 + Math.min(nonEmpty, 8) * .3 + continuity * .25;
}
function profileColumn(rows: any[][], start: number) {
  const columns = Math.max(1, ...rows.slice(start).map(r => r?.length || 0));
  let best = { index: 0, score: -Infinity };
  for (let i = 0; i < columns; i++) {
    const values = rows.slice(start).map(r => String(r?.[i] ?? '').trim()).filter(Boolean); if (!values.length) continue;
    const avg = values.reduce((s, v) => s + v.length, 0) / values.length; const unique = new Set(values).size / values.length; const naturalRate = values.filter(natural).length / values.length; const numericRate = values.filter(v => /^[-+]?\d+(?:\.\d+)?%?$/.test(v) || /^\d{4}[-/.]\d{1,2}/.test(v)).length / values.length;
    const score = avg * .035 + unique * 1.2 + naturalRate * 2 - numericRate * 3 + Math.min(values.length / 100, 1);
    if (score > best.score) best = { index: i, score };
  }
  return best;
}
export function detectVoiceSheet(sheets: { name: string; rows: any[][] }[]): VoiceSheetDetection {
  const candidates = (sheets || []).map(sheet => {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : []; let bestRow = -1; let bestScore = 0;
    for (let i = 0; i < Math.min(50, rows.length); i++) { const score = scoreHeader(rows[i] || [], rows.slice(i + 1)); if (score > bestScore) { bestScore = score; bestRow = i; } }
    const headerFound = bestRow >= 0 && rows[bestRow].some((c: any) => HEADER_WORDS.some(word => normalize(c).includes(word)));
    const header = headerFound ? rows[bestRow].map((c: any) => String(c ?? '').trim()) : ['内容']; const start = headerFound ? bestRow + 1 : 0; const contentColumn = headerFound ? Math.max(0, header.findIndex(h => HEADER_WORDS.some(word => normalize(h).includes(word)))) : profileColumn(rows, 0).index;
    const body = rows.slice(start); const contents = body.map(r => String(r?.[contentColumn] ?? '').trim()).filter(Boolean); const profileScore = profileColumn(rows, start).score; const confidence = headerFound ? Math.min(1, .55 + bestScore / 40) : Math.min(.72, Math.max(.2, profileScore / 8));
    return { sheetName: sheet.name, rows: [header, ...body], headerRow: headerFound ? bestRow : -1, contentColumn, headers: header, contents, preview: contents.slice(0, 3), confidence, headerFound };
  }).filter(x => x.contents.length).sort((a, b) => b.confidence * Math.log1p(b.contents.length) - a.confidence * Math.log1p(a.contents.length));
  return candidates[0] || { sheetName: '', rows: [], headerRow: -1, contentColumn: 0, headers: [], contents: [], preview: [], confidence: 0, headerFound: false };
}

export function normalizeVoiceItems(value: unknown): string[] {
  let arr: any[] = []; try { arr = Array.isArray(value) ? value : JSON.parse(String(value || '[]')); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(item => typeof item === 'string' ? item : item?.content ?? item?.text ?? item?.comment ?? item?.review ?? item?.['评价内容'] ?? item?.['评论内容'] ?? item?.['评价'] ?? item?.['评论'] ?? item?.['反馈'] ?? item?.['内容'] ?? '').map((x: any) => String(x || '').trim()).filter(Boolean);
}
export function resolveVoiceItems(value: unknown, fallback: string[] = []): string[] { const items = normalizeVoiceItems(value); return items.length ? items : fallback.map(x => String(x || '').trim()).filter(Boolean); }
