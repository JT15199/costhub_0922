// 供应商价格趋势小结（v2.3.19）：基于 part_supplier_price_history 生成一句话趋势结论
// 规则驱动（稳定可靠，不依赖模型）：持续上涨/持续下降/波动/基本平稳/仅一次变动

export interface SupplierPriceChange {
  old_price: number;
  new_price: number;
  change_reason?: string;
  changed_at?: string;
}

export interface SupplierTrend {
  direction: 'up' | 'down' | 'mixed' | 'flat' | 'once' | 'none';
  totalPct: number;      // 首末总变化（%）
  count: number;         // 变动次数
  minPct: number;        // 单次最小变化（%）
  maxPct: number;        // 单次最大变化（%）
  lastReason: string;    // 最近一次变动原因
}

export function summarizeSupplierTrend(history: SupplierPriceChange[]): SupplierTrend {
  if (!history || history.length === 0) return { direction: 'none', totalPct: 0, count: 0, minPct: 0, maxPct: 0, lastReason: '' };
  // 按时间正序（changed_at 可能缺失，用输入顺序兜底）
  const sorted = [...history].sort((a, b) => String(a.changed_at || '').localeCompare(String(b.changed_at || '')));
  const pcts = sorted.map(h => {
    const base = h.old_price || 0;
    return base > 0 ? ((h.new_price - h.old_price) / base) * 100 : 0;
  });
  // 累计变化 = 复合口径（首价 → 末价），与单次变化算术和不同（100→110→121 = +21% 而非 +20%）
  const first = sorted[0].old_price || 0;
  const lastPrice = sorted[sorted.length - 1].new_price || 0;
  const totalPct = first > 0 ? ((lastPrice - first) / first) * 100 : pcts.reduce((s, p) => s + p, 0);
  const last = sorted[sorted.length - 1];
  if (sorted.length === 1) {
    return { direction: 'once', totalPct: pcts[0], count: 1, minPct: pcts[0], maxPct: pcts[0], lastReason: last?.change_reason || '' };
  }
  const allUp = pcts.every(p => p > 0.5);
  const allDown = pcts.every(p => p < -0.5);
  const allFlat = pcts.every(p => Math.abs(p) <= 0.5);
  if (allFlat) return { direction: 'flat', totalPct, count: sorted.length, minPct: Math.min(...pcts), maxPct: Math.max(...pcts), lastReason: last?.change_reason || '' };
  if (allUp) return { direction: 'up', totalPct, count: sorted.length, minPct: Math.min(...pcts), maxPct: Math.max(...pcts), lastReason: last?.change_reason || '' };
  if (allDown) return { direction: 'down', totalPct, count: sorted.length, minPct: Math.min(...pcts), maxPct: Math.max(...pcts), lastReason: last?.change_reason || '' };
  return { direction: 'mixed', totalPct, count: sorted.length, minPct: Math.min(...pcts), maxPct: Math.max(...pcts), lastReason: last?.change_reason || '' };
}

// 一句话小结（展示用）
export function supplierTrendText(history: SupplierPriceChange[]): string {
  const t = summarizeSupplierTrend(history);
  const fmtPct = (p: number) => `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
  const reason = t.lastReason ? `，最近一次原因：${t.lastReason}` : '';
  switch (t.direction) {
    case 'none': return '暂无价格变动记录';
    case 'once': return `仅一次变动：${fmtPct(t.totalPct)}${reason}`;
    case 'up': return `持续上涨（${t.count} 次累计 ${fmtPct(t.totalPct)}）${reason}`;
    case 'down': return `持续下降（${t.count} 次累计 ${fmtPct(t.totalPct)}）${reason}`;
    case 'flat': return `基本平稳（${t.count} 次微调，累计 ${fmtPct(t.totalPct)}）${reason}`;
    case 'mixed': return `价格波动（${t.count} 次，${fmtPct(t.minPct)} ~ ${fmtPct(t.maxPct)}）${reason}`;
  }
}

// 趋势标签（表格列用）：direction → { text, color }
export function supplierTrendTag(t: SupplierTrend): { text: string; color: string } {
  switch (t.direction) {
    case 'up': return { text: `↑ 涨 ${t.totalPct.toFixed(1)}%`, color: 'red' };
    case 'down': return { text: `↓ 降 ${Math.abs(t.totalPct).toFixed(1)}%`, color: 'green' };
    case 'mixed': return { text: '↕ 波动', color: 'orange' };
    case 'flat': return { text: '— 平稳', color: 'default' };
    case 'once': return { text: t.totalPct > 0 ? `↑ ${t.totalPct.toFixed(1)}%` : `↓ ${Math.abs(t.totalPct).toFixed(1)}%`, color: t.totalPct > 0 ? 'red' : 'green' };
    default: return { text: '—', color: 'default' };
  }
}
