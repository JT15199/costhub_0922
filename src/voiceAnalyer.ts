// 用户原声分块分析（v2.3.19，2026-08-18）：自动分块 → 本地模型提炼维度 → 汇总合并权重
// 纯函数：chunkVoiceItems（分块，不切断单条）/ mergeDimensions（跨块合并去重+加权）/ parseDimensions（健壮解析模型输出）
export interface VoiceBlock { index: number; items: string[]; }
export interface BlockDimension { name: string; sentiment: 'positive' | 'negative'; }

// 自动分块：按总字数预算切，块间不切断单条原声（一条完整归一块）
export function chunkVoiceItems(items: string[], maxCharsPerChunk = 3000): VoiceBlock[] {
  const blocks: VoiceBlock[] = [];
  let cur: string[] = []; let curLen = 0;
  for (const it of items) {
    const s = String(it || '').trim();
    if (!s) continue;
    const len = s.length;
    // 单条超过预算 → 单独一块（避免溢出）
    if (len > maxCharsPerChunk) {
      if (cur.length) { blocks.push({ index: blocks.length, items: cur }); cur = []; curLen = 0; }
      blocks.push({ index: blocks.length, items: [s] }); continue;
    }
    if (curLen + len > maxCharsPerChunk && cur.length) {
      blocks.push({ index: blocks.length, items: cur }); cur = []; curLen = 0;
    }
    cur.push(s); curLen += len;
  }
  if (cur.length) blocks.push({ index: blocks.length, items: cur });
  return blocks;
}

// 汇总合并：聚合同类维度（名称归一化去重）。⚠️ 声量（count）= 提及该特性的用户数量 = 关注人数，是第一信号（用户 2026-08-18：某个特性声量大 = 在乎的人多）；
// 正负（positive/negative）= 质量补充（做得好不好）。类型：声量高+口碑好=strong 卖点；声量高+负面多=fix 待改进；声量低=minor 次要
export function mergeDimensions(blockResults: BlockDimension[][]): { name: string; weight: number; count: number; positive: number; negative: number; quality: number; kind: 'strong' | 'fix' | 'minor' }[] {
  const map: Record<string, { name: string; count: number; positive: number; negative: number }> = {};
  const norm = (n: string) => String(n || '').trim().toLowerCase().replace(/[\s+|]/g, '');
  for (const res of blockResults) {
    for (const d of res || []) {
      const name = String(d.name || '').trim();
      if (!name) continue;
      const k = norm(name);
      if (!map[k]) map[k] = { name, count: 0, positive: 0, negative: 0 };
      map[k].count++;
      if (d.sentiment === 'positive') map[k].positive++; else map[k].negative++;
    }
  }
  // 声量阈值：排前 ~30% 视为「高关注」，其余「次要」（用 count 分位）
  const counts = Object.values(map).map(m => m.count).sort((a, b) => a - b);
  const highCount = counts[Math.floor(counts.length * 0.7)] || 1;
  const out = Object.values(map).map(m => {
    const quality = m.count > 0 ? m.positive / m.count : 0;
    const kind = m.count >= highCount
      ? (m.negative > m.positive ? ('fix' as const) : ('strong' as const))
      : ('minor' as const);
    return {
      name: m.name,
      count: m.count,
      positive: m.positive,
      negative: m.negative,
      quality,
      // ⚠️ 声量优先：weight = 提及次数（多少人关注），高关注排前
      weight: m.count,
      kind,
    };
  });
  return out.sort((a, b) => b.weight - a.weight);
}

// ===== 健壮解析模型输出（2026-08-18 修"分析完成但 0 个维度"）=====
// 本地模型输出不稳，不能只认 {"dimensions":[...]} 一种形状。兼容：
//   1) {dimensions:[...]} / {features:[...]} / {items:[...]} 等任意数组字段
//   2) 顶层数组 [{name,sentiment},...]
//   3) 前后夹散文 / 中文引号 / 尾逗号（括号切片自动忽略代码围栏）
//   4) 行级兜底：- 名称：正面  /  名称（positive）
function normSentiment(s: any): 'positive' | 'negative' {
  const v = String(s || '').trim().toLowerCase();
  if (/neg|negative|差评|吐槽|不满|缺陷|缺点|负面/.test(v)) return 'negative';
  if (/pos|positive|好评|喜欢|满意|优点|正面/.test(v)) return 'positive';
  return 'positive'; // 无法判定默认正面（仅兜底路径）
}

export function parseDimensions(text: string): BlockDimension[] {
  const t = String(text || '').trim();
  if (!t) return [];
  const out: BlockDimension[] = [];
  const seen = new Set<string>();
  const push = (name: any, sentiment: any) => {
    const nm = String(name || '').trim().replace(/^[-*•\d.\s]+/, '').trim();
    if (!nm || nm.length > 40 || seen.has(nm)) return;
    seen.add(nm);
    out.push({ name: nm, sentiment: normSentiment(sentiment) });
  };
  // 候选 JSON 片段：整体 + 首尾括号切片（自动忽略前后散文/代码围栏）
  const candidates: any[] = [];
  const tryJSON = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  const segs = [t];
  for (const pair of [['{', '}'], ['[', ']']] as const) {
    const s = t.indexOf(pair[0]); const e = t.lastIndexOf(pair[1]);
    if (s >= 0 && e > s) segs.push(t.slice(s, e + 1));
  }
  for (const seg of segs) {
    const variants = [seg, seg.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']')];
    for (const v of variants) { const p = tryJSON(v); if (p != null) { candidates.push(p); break; } }
  }
  // 从候选提取维度（有结果即停）
  for (const c of candidates) {
    let arr: any[] | null = null;
    if (Array.isArray(c)) arr = c;
    else if (c && typeof c === 'object') {
      const prefer = ['dimensions', 'features', 'aspects', 'items', 'dimension', 'results', 'list', 'data'];
      for (const k of prefer) if (Array.isArray(c[k])) { arr = c[k]; break; }
      if (!arr) for (const k of Object.keys(c)) if (Array.isArray(c[k])) { arr = c[k]; break; }
    }
    if (!arr) continue;
    for (const it of arr) {
      if (it && typeof it === 'object') {
        const name = it.name ?? it.dimension ?? it.feature ?? it.aspect ?? it.label ?? it.title ?? it.特性 ?? it.维度 ?? it.方面;
        const sent = it.sentiment ?? it.polarity ?? it.sentiment_type ?? it.情感 ?? it.倾向 ?? '';
        const pos = it.positive ?? it.is_positive ?? it.positive_count;
        const neg = it.negative ?? it.is_negative ?? it.negative_count;
        let s: any = sent;
        if (!String(s || '').trim()) { if (pos === true || pos === 1) s = 'positive'; else if (neg === true || neg === 1) s = 'negative'; }
        push(name, s);
      } else if (typeof it === 'string' && it.trim()) {
        push(it, '');
      }
    }
    if (out.length > 0) break;
  }
  // 兜底：JSON 被截断（num_predict 不够/模型啰嗦）时逐个提取完整对象 {"name":...,"sentiment":...}
  // —— 即便整个 JSON 被切断，也能抠出已生成完的维度（2026-08-18 修"7 千字输出识别 0 维"）
  if (out.length === 0) {
    const objRe = /\{[^{}]*\}/g;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(t)) !== null) {
      const p = tryJSON(m[0]);
      if (p && typeof p === 'object') {
        const name = p.name ?? p.dimension ?? p.feature ?? p.aspect ?? p.label;
        const sent = p.sentiment ?? p.polarity ?? '';
        if (name) push(name, sent);
      }
      if (out.length >= 30) break;
    }
  }
  // 行级兜底：整行「名称：情感」/「名称（情感）」
  if (out.length === 0) {
    for (const line of t.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const m = l.match(/^[-*•\d.\s]*([^:：()（）]{1,20})\s*[:：]\s*([^,，;；]{1,12})$/)
        || l.match(/^[-*•\d.\s]*([^:：()（）]{1,20})\s*[（(]\s*([^)）]{1,12})[)）]$/);
      if (m) push(m[1], m[2]);
    }
  }
  return out.slice(0, 30);
}
