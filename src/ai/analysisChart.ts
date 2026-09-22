import echarts from '../echartsSetup';

export interface AnalysisChart {
  title: string;
  takeaway: string;
  type: 'bar' | 'line' | 'donut';
  unit: string;
  source: string;
  basis: string;
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
}
export interface ChartArtifact { chart: AnalysisChart; workspace: string; path: string; }

export function parseAnalysisChart(input: unknown): AnalysisChart {
  if (typeof input === 'string' && input.length > 64000) throw new Error('图表数据超过 64KB，请先聚合数据');
  const x = typeof input === 'string' ? JSON.parse(input) : input;
  if (!x || typeof x !== 'object') throw new Error('图表必须是 JSON 对象');
  const field = (key: string, max: number, required = true) => {
    if (typeof x[key] !== 'string' || x[key].length > max || (required && !x[key].trim())) throw new Error(`${key} 必须是 1–${max} 字符的文字`);
    return x[key].trim();
  };
  if (!['bar', 'line', 'donut'].includes(x.type)) throw new Error('type 使用 bar、line 或 donut');
  if (!Array.isArray(x.labels) || x.labels.length < 2 || x.labels.length > 40 || x.labels.some((v: unknown) => typeof v !== 'string' || !v.trim() || v.length > 80)) throw new Error('需要 2–40 个有效分类/时间标签');
  if (new Set(x.labels).size !== x.labels.length) throw new Error('标签不能重复');
  if (!Array.isArray(x.series) || x.series.length < 1 || x.series.length > 4) throw new Error('需要 1–4 个数据系列');
  const series = x.series.map((s: any) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60 || !Array.isArray(s.values) || s.values.length !== x.labels.length || s.values.some((v: unknown) => v !== null && (typeof v !== 'number' || !Number.isFinite(v)))) throw new Error('系列名称、长度或数值不合法；缺失值使用 null');
    return { name: s.name, values: s.values as (number | null)[] };
  });
  if (!series.some((s: AnalysisChart['series'][number]) => s.values.some(v => v !== null))) throw new Error('没有已知数据可绘图');
  if (x.type === 'donut' && (series.length !== 1 || x.labels.length > 6 || series[0].values.some((v: number | null) => v === null || v < 0) || !series[0].values.some((v: number | null) => v !== null && v > 0))) throw new Error('构成图要求单系列、2–6 个非负已知值且合计大于零');
  return { title: field('title', 80), takeaway: field('takeaway', 180), type: x.type, unit: field('unit', 20, false), source: field('source', 240), basis: field('basis', 240), labels: [...x.labels], series };
}

const colors = ['#4678ed', '#77a6bc', '#9b9fc1', '#b7c9d9', '#677ea4', '#c5d3e9'];
export function analysisChartOption(chart: AnalysisChart, motion = false): any {
  const { type, labels, series } = chart;
  const base: any = {
    animation: motion, animationDuration: 420, animationEasing: 'cubicOut',
    color: colors, backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', color: '#566781' },
    aria: { enabled: true },
    tooltip: { trigger: type === 'donut' ? 'item' : 'axis', renderMode: 'richText', confine: true },
    legend: { show: series.length > 1 || type === 'donut', bottom: 0, type: 'scroll', icon: 'circle', itemWidth: 7, itemHeight: 7, textStyle: { color: '#65728b', fontSize: 11 } },
  };
  if (type === 'donut') return { ...base, title: { text: series[0].values.reduce<number>((sum, value) => sum + (value ?? 0), 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }), subtext: chart.unit || '合计', left: 'center', top: '33%', textStyle: { fontSize: 24, color: '#223b60', fontWeight: 600 }, subtextStyle: { color: '#8a9ab0', fontSize: 11 } }, series: [{ type: 'pie', radius: ['52%', '72%'], center: ['50%', '43%'], label: { show: false }, itemStyle: { borderColor: '#f8faff', borderWidth: 3, borderRadius: 5 }, data: labels.map((name, i) => ({ name, value: series[0].values[i] })) }] };
  const horizontal = type === 'bar';
  const category = { type: 'category', data: labels, inverse: horizontal, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#5a6b84', fontSize: 11, width: 110, overflow: 'truncate', interval: horizontal ? 0 : 'auto' } };
  const value = { type: 'value', name: chart.unit, nameTextStyle: { color: '#8492a9' }, axisLine: { show: false }, axisLabel: { color: '#8492a9', fontSize: 10 }, splitLine: { lineStyle: { color: '#e7edf7', type: 'dashed' } } };
  return { ...base, grid: { top: 26, right: 28, bottom: series.length > 1 ? 42 : 24, left: 12, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' }, xAxis: horizontal ? value : category, yAxis: horizontal ? category : value,
    series: series.map((s, i) => ({ name: s.name, type, data: s.values, barMaxWidth: 19, barGap: '30%', connectNulls: false, smooth: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.5 }, itemStyle: { color: colors[i], borderRadius: horizontal ? [0, 5, 5, 0] : undefined }, emphasis: { focus: 'series' } })),
  };
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export function renderAnalysisSvg(chart: AnalysisChart): string {
  const height = chart.type === 'bar' ? Math.max(340, chart.labels.length * chart.series.length * 25 + 75) : 380;
  const plot = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 1000, height });
  try {
    plot.setOption(analysisChartOption(chart));
    const inner = plot.renderToSVGString().replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const lines = [chart.takeaway, `来源（AI 整理，请核对）：${chart.source}`, `口径：${chart.basis}`].flatMap(v => v.match(/.{1,58}/gu) || []);
    const footer = lines.map((line, i) => `<text x="38" y="${height + 130 + i * 22}" font-size="13" fill="#64748b">${escapeXml(line)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height + 158 + lines.length * 22}" viewBox="0 0 1080 ${height + 158 + lines.length * 22}"><rect width="100%" height="100%" rx="24" fill="#f8faff"/><rect x="1" y="1" width="1078" height="${height + 156 + lines.length * 22}" rx="24" fill="none" stroke="#dbe5f5"/><g font-family="Segoe UI,Microsoft YaHei,sans-serif"><text x="38" y="35" font-size="11" letter-spacing="3" fill="#4678ed">COSTHUB / ANALYSIS</text><text x="38" y="73" font-size="${chart.title.length > 40 ? 17 : 24}" font-weight="600" fill="#192e50">${escapeXml(chart.title)}</text>${footer}</g><g transform="translate(40,96)">${inner}</g></svg>`;
  } finally { plot.dispose(); }
}
