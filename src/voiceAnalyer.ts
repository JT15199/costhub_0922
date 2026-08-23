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

// 汇总合并：聚合同类维度（名称归一化去空格小写）、按 出现次数 + 情感 加权
export function mergeDimensions(blockResults: BlockDimension[][]): { name: string; weight: number; count: number; positive: number; negative: number }[] {
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
  const out = Object.values(map).map(m => ({
    name: m.name,
    count: m.count,
    positive: m.positive,
    negative: m.negative,
    // 权重 = 提及次数 + 正面强度（用户正面提及该特性 = 用户在意 → 该特性有市场价值）
    weight: Math.round((m.count + m.positive * 0.5) * 100) / 100,
  }));
  return out.sort((a, b) => b.weight - a.weight);
}
