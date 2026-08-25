// 模块价值矩阵（v2.3.19，2026-08-18 用户认可 mockup 版：声量×成本四象限散点）
// 真实数据：computeModuleValueRows 产出的模块价值行（成本/声量/好评率/类型）
// 设计：骨色底+墨色+信号色（无 AI 味），气泡大小=好评率，四象限=好又便宜/好但贵/花得不值/次要
import type { ModuleValueRow } from '../sellingPointAnalyzer';

const KIND_COLOR: Record<string, string> = {
  cheap_good: '#1F7A4C',
  good_expensive: '#B0895A',
  bad: '#C0392B',
  waste: '#C0392B',
  minor: '#9A978B',
};
const KIND_LABEL: Record<string, string> = {
  cheap_good: '好又便宜', good_expensive: '好但贵', bad: '做得差', waste: '花得不值', minor: '次要',
};
const KIND_ORDER = ['cheap_good', 'good_expensive', 'bad', 'waste', 'minor'];

export default function ModuleValueMatrix({ rows }: { rows: ModuleValueRow[] }) {
  if (!rows || rows.length === 0) return null;
  const PL = 74, PR = 588, PT = 32, PB = 288;
  const W = PR - PL, H = PB - PT;
  const maxCost = Math.max(...rows.map(r => r.cost), 1);
  const maxCount = Math.max(...rows.map(r => r.count), 1);
  const xMid = PL + W * 0.5, yMid = PT + H * 0.5;
  const pts = rows.map(r => ({
    ...r,
    cx: PL + (r.cost / maxCost) * W,
    cy: PT + (1 - (r.count / maxCount)) * H,
    rr: 6 + Math.min(1, r.quality || 0) * 7,
    color: KIND_COLOR[r.kind] || '#9A978B',
    label: String(r.module || '').slice(0, 2),
  }));
  return (
    <div style={{ padding: '8px 6px 4px' }}>
      <svg viewBox="0 0 620 340" style={{ width: '100%', height: 'auto', maxHeight: 300, display: 'block' }}>
        <rect x={PL} y={PT} width={W} height={H} fill="#FBFAF6" stroke="#E6E4DC" rx={6} />
        <line x1={xMid} y1={PT} x2={xMid} y2={PB} stroke="#D5D2C6" strokeDasharray="4 4" />
        <line x1={PL} y1={yMid} x2={PR} y2={yMid} stroke="#D5D2C6" strokeDasharray="4 4" />
        {/* 象限标签 */}
        <text x={(PL + xMid) / 2} y={PT + 16} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#1F7A4C">好又便宜 → 放大</text>
        <text x={(xMid + PR) / 2} y={PT + 16} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#B0895A">好但贵 → 降本</text>
        <text x={(xMid + PR) / 2} y={PB - 8} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#C0392B">花得不值 → 减配</text>
        <text x={(PL + xMid) / 2} y={PB - 8} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#9A978B">次要</text>
        <text x={PL} y={PT - 12} fontSize={10.5} fill="#9A978B">声量（提及用户数）</text>
        <text x={PR} y={PB + 26} textAnchor="end" fontSize={10.5} fill="#9A978B">成本 ¥</text>
        {/* 气泡 */}
        {pts.map(p => (
          <g key={p.module}>
            <circle cx={p.cx} cy={p.cy} r={p.rr} fill={p.color} fillOpacity={0.18} stroke={p.color} strokeWidth={2} />
            <text x={p.cx} y={p.cy + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#181713">{p.label}</text>
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: '#5F5D54', marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {KIND_ORDER.filter(k => rows.some(r => r.kind === k)).map(k => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: KIND_COLOR[k], display: 'inline-block' }} />
            {KIND_LABEL[k]}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', color: '#9A978B' }}>气泡越大 = 好评率越高</span>
      </div>
    </div>
  );
}
