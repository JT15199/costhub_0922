// AI 审价助手纯函数（v2.3.19，2026-08-18，大模型解锁新能力 #1）
// 贴供应商报价 → AI 逐项审价（合理/偏高/虚高 + 合理价 + 议价弹药），对照系统已有参考价 + 品类常识

export interface QuoteReviewItem {
  index: number;
  item: string;
  verdict: '合理' | '偏高' | '虚高' | 'unknown';
  fair_price: string;
  reason: string;
  negotiate: string;
}

export function buildQuoteReviewPrompt(quote: string, context: string): { system: string; user: string } {
  const system = '你是资深 ODM 采购审价专家，帮品牌方审核供应商报价。下面是供应商的报价清单（每行一项，可能含 器件名/型号/单价/数量/备注）。系统内已有部分同类器件的参考价（见"系统参考价"）。请逐项审价，只输出 JSON：{"items":[{"index":序号(从1开始),"item":"器件名或型号","verdict":"合理|偏高|虚高","fair_price":"合理价（数字或区间，确实无法判断写无法判断）","reason":"一句话依据","negotiate":"给买方的议价要点/话术（一句话）"}]}，不要任何其他文字。判断口径：当前价≈系统/常识同类价 → 合理；明显高于 → 虚高；略高但可谈 → 偏高；不确定 → 合理。';
  const user = '供应商报价：\n' + quote + '\n\n系统参考价：\n' + (context || '（暂无，请基于品类常识判断）') + '\n\n请逐项审价输出 JSON。';
  return { system, user };
}

export function parseQuoteReview(text: string): QuoteReviewItem[] {
  const t = String(text || '').trim();
  if (!t) return [];
  const candidates: any[] = [];
  const tryJSON = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  const segs = [t];
  for (const pair of [['{', '}'], ['[', ']']] as const) {
    const s = t.indexOf(pair[0]); const e = t.lastIndexOf(pair[1]);
    if (s >= 0 && e > s) segs.push(t.slice(s, e + 1));
  }
  for (const seg of segs) {
    for (const v of [seg, seg.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']')]) {
      const p = tryJSON(v); if (p != null) { candidates.push(p); break; }
    }
  }
  for (const c of candidates) {
    let arr: any[] | null = null;
    if (Array.isArray(c)) arr = c;
    else if (c && typeof c === 'object') {
      if (Array.isArray(c.items)) arr = c.items;
      else for (const k of Object.keys(c)) if (Array.isArray(c[k])) { arr = c[k]; break; }
    }
    if (!arr) continue;
    const out: QuoteReviewItem[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const v = String(it.verdict || '').trim();
      out.push({
        index: Number(it.index) || out.length + 1,
        item: String(it.item ?? it.name ?? '').trim() || '（未识别）',
        verdict: v === '合理' || v === '偏高' || v === '虚高' ? v : (v.includes('虚高') ? '虚高' : v.includes('偏高') ? '偏高' : '合理'),
        fair_price: String(it.fair_price ?? it.fairPrice ?? '').trim(),
        reason: String(it.reason ?? '').trim(),
        negotiate: String(it.negotiate ?? it.suggestion ?? '').trim(),
      });
    }
    if (out.length) return out;
  }
  return [];
}
