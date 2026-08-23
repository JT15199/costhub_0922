// 用户原声分块分析（v2.3.19，2026-08-18）：自动分块 → 本地模型提炼维度 → 汇总合并权重
// 纯函数：chunkVoiceItems（分块，不切断单条）/ mergeDimensions（跨块合并去重+加权）
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
