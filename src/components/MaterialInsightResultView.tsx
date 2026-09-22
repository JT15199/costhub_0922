import { Collapse, Tag, Tooltip, message } from 'antd';
import { AlertOutlined, ArrowDownOutlined, ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import {
  buildDecompositionContributionData,
  buildDirectTrendChartData,
  buildInsightHistoryChartData,
  buildSimulatedTrendChartData,
  getMaterialInsightResult,
  safeHttpUrl,
  shouldUseSimulatedTrend,
  type DecompositionContribution,
  type MaterialInsightResult,
} from '../materialInsight';

type ResultSnapshot = Record<string, any>;

interface Props {
  snapshot?: ResultSnapshot | null;
  snapshots?: ResultSnapshot[];
  nodes?: any[];
  subjectKind?: 'direct' | 'decomposition';
  sources?: any[];
  onSelectNode?: (id: number) => void;
}

const directionColor: Record<string, string> = { 上涨: '#EF4444', 下降: '#10B981', 震荡: '#F59E0B', 信号不明确: '#94A3B8' };
const compactTime = (value: unknown) => String(value || '').slice(0, 16).replace('T', ' ') || '时间待补';
const numberText = (value: unknown, digits = 2) => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits).replace(/\.?(0+)$/, '') : '待补';
};
const normalizedText = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();
const shortText = (value: unknown, max = 100) => {
  const text = normalizedText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const conclusionSummary = (value: unknown) => {
  const text = normalizedText(value);
  const first = text.match(/^.*?[。！？!?]/)?.[0] || text;
  return shortText(first || '本次未形成结论', 150);
};
const openSource = async (value: unknown) => {
  const url = safeHttpUrl(value);
  if (!url) { message.warning('来源链接不是安全的 HTTP/HTTPS 地址'); return; }
  try { await openUrl(url); } catch { message.error('无法打开来源链接'); }
};

function EvidenceLinks({ ids, sources, fallbackSources = [] }: { ids: number[]; sources: any[]; fallbackSources?: any[] }) {
  const wanted = new Set((ids || []).map(Number));
  const linked = sources.filter(source => wanted.has(Number(source.id)) && safeHttpUrl(source.source_url));
  const fallback = linked.length ? [] : fallbackSources.filter(source => safeHttpUrl(source.source_url));
  const shown = [...linked, ...fallback].slice(0, 3);
  return <div className="material-result-evidence-links">
    {shown.map((source, index) => <button type="button" key={`${source.id || source.source_url}-${index}`} onClick={() => void openSource(source.source_url)} title={source.source_title || source.source_url}>
      <span>{linked.length ? '证据' : '来源'}</span> {shortText(source.source_title || `来源 ${index + 1}`, 34)}
    </button>)}
    {!shown.length && ids.length > 0 && <small>证据已记录，但来源链接不可点击</small>}
    {!shown.length && ids.length === 0 && <small>依据待补</small>}
  </div>;
}

function ItemList({ items, empty, sources, fallbackSources = [] }: { items: MaterialInsightResult['drivers']; empty: string; sources: any[]; fallbackSources?: any[] }) {
  if (!items.length) return <span className="material-result-muted">{empty}</span>;
  return <div className="material-result-item-list">{items.slice(0, 4).map((item, index) => <div className="material-result-item" key={`${item.label}-${index}`}>
    <b>{item.label}</b>
    <span>{shortText(item.text, 140)}</span>
    <EvidenceLinks ids={item.evidenceIds} sources={sources} fallbackSources={fallbackSources} />
  </div>)}</div>;
}

function directOption(data: Exclude<ReturnType<typeof buildDirectTrendChartData>, { kind: 'insufficient' }>) {
  if (data.kind === 'single') return null;
  const points = data.points;
  const categories = points.map(point => compactTime(point.time));
  const tooltip = (params: any) => {
    const point = points[params?.[0]?.dataIndex ?? 0];
    if (!point) return '';
    return `${compactTime(point.time)}<br/>幅度：${numberText(point.value)}%<br/>方向：${point.direction} · ${point.confidence}置信<br/>来源：${point.sourceType}`;
  };
  if (data.kind === 'range') {
    return {
      animationDuration: 180, grid: { left: 42, right: 18, top: 28, bottom: 32 }, tooltip: { trigger: 'axis', formatter: tooltip }, legend: { top: 0, textStyle: { color: '#64748B', fontSize: 11 } },
      xAxis: { type: 'category', data: categories, axisLabel: { color: '#64748B', fontSize: 10 } }, yAxis: { type: 'value', axisLabel: { color: '#64748B', formatter: '{value}%' }, splitLine: { lineStyle: { color: '#E2E8F0' } } },
      series: [
        { name: '高点', type: 'line', data: points.map(point => point.min), stack: 'range', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, emphasis: { disabled: true } },
        { name: '高低区间', type: 'line', data: points.map(point => (point.max ?? point.value) - (point.min ?? point.value)), stack: 'range', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: '#60A5FA', opacity: 0.18 } },
        { name: '代表线', type: 'line', data: points.map(point => point.value), smooth: false, symbolSize: 7, lineStyle: { color: '#2563EB', width: 2 }, itemStyle: { color: '#2563EB' } },
      ],
    };
  }
  return {
    animationDuration: 180, grid: { left: 42, right: 18, top: 20, bottom: 32 }, tooltip: { trigger: 'axis', formatter: tooltip },
    xAxis: { type: 'category', data: categories, axisLabel: { color: '#64748B', fontSize: 10 } }, yAxis: { type: 'value', axisLabel: { color: '#64748B', formatter: '{value}%' }, splitLine: { lineStyle: { color: '#E2E8F0' } } },
    series: [{ name: '价格幅度', type: 'scatter', data: points.map(point => point.value), symbolSize: 10, itemStyle: { color: '#2563EB' } }],
  };
}

function simulatedOption(points: ReturnType<typeof buildSimulatedTrendChartData>, sourceFallback: number) {
  return {
    animationDuration: 180, grid: { left: 42, right: 18, top: 30, bottom: 34 },
    legend: { top: 0, textStyle: { color: '#64748B', fontSize: 10 } },
    tooltip: { trigger: 'axis', formatter: (params: any) => { const point = points[params?.[0]?.dataIndex ?? 0]; return point ? `${compactTime(point.time)}<br/>AI 模拟趋势：${numberText(point.value, 1)}<br/>方向：${point.direction}<br/>置信度：${point.confidence}<br/>来源：${point.sourceCount || sourceFallback} 条<br/>结论：${shortText(point.summary || '本次未形成结论')}<br/><span style="color:#64748B">非实际市场价格</span>` : ''; } },
    xAxis: { type: 'category', data: points.map(point => compactTime(point.time)), axisLabel: { color: '#64748B', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#64748B' }, splitLine: { lineStyle: { color: '#E2E8F0' } } },
    series: [
      { name: '置信区间（非实际价格）', type: 'line', data: points.map(point => point.low), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, emphasis: { disabled: true } },
      { name: 'AI 模拟趋势（基准=100）', type: 'line', data: points.map(point => point.high - point.low), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: '#93C5FD', opacity: 0.2 } },
      { name: 'AI 模拟趋势（非实际市场价格）', type: 'line', data: points.map(point => point.value), smooth: false, symbolSize: 7, lineStyle: { color: '#2563EB', width: 2 }, itemStyle: { color: '#2563EB' } },
    ],
  };
}

function contributionOption(points: DecompositionContribution[]) {
  return {
    animationDuration: 180, grid: { left: 100, right: 18, top: 12, bottom: 28 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (params: any) => { const point = points[params?.[0]?.dataIndex ?? 0]; return point ? `${point.name}<br/>影响：${numberText(point.score)} 个百分点<br/>成本占比：${numberText(point.ratio)}%<br/>${point.asOf ? `时间：${compactTime(point.asOf)}<br/>` : ''}来源：${point.sourceType} · ${point.confidence}置信` : ''; } },
    xAxis: { type: 'value', axisLabel: { color: '#64748B', formatter: '{value}' }, splitLine: { lineStyle: { color: '#E2E8F0' } } },
    yAxis: { type: 'category', data: points.map(point => point.name).reverse(), axisLabel: { color: '#334155', width: 88, overflow: 'truncate' } },
    series: [{ name: '节点影响', type: 'bar', data: points.map(point => ({ value: point.score, itemStyle: { color: point.score >= 0 ? '#EF4444' : '#10B981' } })).reverse(), barMaxWidth: 18, label: { show: true, position: 'right', color: '#475569', formatter: (item: any) => numberText(item.value, 1) } }],
  };
}

function InsightTimeline({ points, snapshots, sources, subjectKind }: { points: ReturnType<typeof buildInsightHistoryChartData>; snapshots: ResultSnapshot[]; sources: any[]; subjectKind: 'direct' | 'decomposition' }) {
  if (!points.length) return <span className="material-result-muted">暂无洞察时间点。</span>;
  return <div className="material-result-signal-timeline">{points.slice().reverse().map((point, index) => {
    const row = snapshots.find(snapshot => (point.id != null && Number(snapshot.id) === Number(point.id)) || compactTime(snapshot.query_time || snapshot.asOf) === compactTime(point.time)) || snapshots[snapshots.length - index - 1] || {};
    const item = getMaterialInsightResult(row, subjectKind === 'decomposition' ? 'decompose' : 'direct');
    const rowSources = sources.filter(source => Number(source.trend_item_id) === Number(row.trend_item_id) && safeHttpUrl(source.source_url));
    const evidenceSources = rowSources.length ? rowSources : sources;
    return <div className="material-result-signal-event" key={`${point.id || point.time}-${index}`}>
      <span className="material-result-signal-dot" style={{ background: directionColor[point.direction] || '#94A3B8' }} />
      <div className="material-result-signal-event-body">
        <div className="material-result-signal-event-head"><b>{compactTime(point.time)}</b><Tag color={directionColor[point.direction] || 'default'}>{point.direction}</Tag><Tag>{point.confidence}置信</Tag><span>{rowSources.length} 条可点击依据</span></div>
        <p>{conclusionSummary(item.headline || point.summary)}</p>
        <EvidenceLinks ids={item.evidenceIds} sources={sources} fallbackSources={evidenceSources} />
        <details><summary>查看本次完整结论</summary><div className="material-result-signal-event-detail"><p>{normalizedText(item.headline) || '本次未形成结论'}</p>{item.dataGaps.length > 0 && <small>数据缺口：{item.dataGaps.slice(0, 3).join('；')}</small>}</div></details>
      </div>
    </div>;
  })}</div>;
}

function Coverage({ coverage }: { coverage: { total: number; completed: number; failed: number; skipped: number; rate: number; costRate: number | null } }) {
  return <div className="material-result-coverage"><span>子节点综合覆盖率 <b>{Math.round(coverage.rate * 100)}%</b></span><span>已完成 {coverage.completed}/{coverage.total}</span>{coverage.failed > 0 && <span className="is-warning">失败 {coverage.failed}</span>}{coverage.skipped > 0 && <span>跳过 {coverage.skipped}</span>}{coverage.costRate != null && <span>成本覆盖 {Math.round(coverage.costRate * 100)}%</span>}</div>;
}

export default function MaterialInsightResultView({ snapshot, snapshots = [], nodes = [], subjectKind = 'direct', sources = [], onSelectNode }: Props) {
  const mode = subjectKind === 'decomposition' ? 'decompose' : 'direct';
  const actualSnapshots = snapshots.filter(item => item.source_type !== 'aggregated');
  const chartSnapshots = actualSnapshots.length > 0 ? actualSnapshots : snapshot ? [snapshot] : [];
  const result = getMaterialInsightResult(snapshot || chartSnapshots[chartSnapshots.length - 1] || {}, mode);
  const directData = buildDirectTrendChartData(chartSnapshots);
  const historyData = buildInsightHistoryChartData(chartSnapshots);
  const simulatedData = buildSimulatedTrendChartData(chartSnapshots);
  const decompositionData = buildDecompositionContributionData(nodes, snapshots);
  const validSources = sources.filter(source => safeHttpUrl(source.source_url));
  const latestSources = validSources.filter(source => Number(source.trend_item_id) === Number((snapshot || chartSnapshots[chartSnapshots.length - 1])?.trend_item_id));
  const conclusionSources = latestSources.length ? latestSources : validSources;
  const hasSourceGap = validSources.length === 0;
  const qualityGaps = [...(hasSourceGap ? ['未获取可点击公开来源'] : []), ...result.dataGaps.filter(gap => gap !== '缺少可追溯证据ID')];
  const upstreamDrivers = result.drivers.filter(item => item.direction === '上涨' || !item.direction);
  const downstreamDrivers = result.drivers.filter(item => item.direction === '下降');
  const opportunities = result.opportunities.length ? result.opportunities : [{ label: '机会待补', text: '本次未形成可核验机会，补充来源后再判断。', evidenceIds: [] }];
  const risks = result.risks.length ? result.risks : [{ label: '数据风险', text: '本次未形成可核验风险，当前不应据此做采购决策。', evidenceIds: [] }];
  const actions = result.actions.length ? result.actions : [{ label: '下一步', text: hasSourceGap ? '先补充可点击来源，再重新洞察；未有来源时不输出器件级金额建议。' : '核对项目 BOM 中的关联器件、供应商报价和数量后再确定动作。', evidenceIds: [] }];
  const validEvidenceCount = result.evidenceIds.filter(id => validSources.some(source => Number(source.id) === Number(id))).length;
  const coverage = decompositionData.coverage;

  return <section className="material-structured-result" aria-label="结构化物料洞察结果">
    <div className="material-structured-headline">
      <div className="material-result-conclusion-head"><span className="eyebrow">STRUCTURED INSIGHT · 结论摘要</span><h3>{conclusionSummary(result.headline)}</h3>
        <div className="material-result-meta"><Tag color={directionColor[result.direction] || 'default'}>{result.direction}</Tag><Tag>{result.confidence}置信</Tag><span><ClockCircleOutlined /> {compactTime(result.asOf)}</span><span>{validSources.length} 条可点击来源</span></div>
        <EvidenceLinks ids={result.evidenceIds} sources={sources} fallbackSources={conclusionSources} />
        <details className="material-result-full-conclusion"><summary>展开完整结论</summary><p>{normalizedText(result.headline) || '本次未形成结论'}</p></details>
      </div>
      <Tooltip title={qualityGaps.length ? qualityGaps.join('；') : '结构化字段完整'}><span className={`material-result-quality ${qualityGaps.length ? 'is-gap' : 'is-ready'}`}>{qualityGaps.length ? '有数据缺口' : '结构化完整'}</span></Tooltip>
    </div>

    <div className="material-result-key-numbers">
      <div><span>价格幅度</span><b>{result.magnitudeMin != null && result.magnitudeMax != null ? `${numberText(result.magnitudeMin)}% ~ ${numberText(result.magnitudeMax)}%` : '待估算'}</b></div>
      <div><span>证据引用</span><b>{validEvidenceCount || validSources.length || 0} 条</b></div>
      {subjectKind === 'decomposition' ? <div><span>图表节点</span><b>{decompositionData.points.length} 个</b></div> : <div><span>历史快照</span><b>{chartSnapshots.length} 次</b></div>}
    </div>

    <div className="material-result-charts">
      {historyData.length > 0 && <div className="material-result-chart-card material-result-timeline-card"><div className="material-result-chart-title"><b>洞察时间轴</b><span>按时间回看方向、置信度与依据</span></div><InsightTimeline points={historyData} snapshots={chartSnapshots} sources={sources} subjectKind={subjectKind} /></div>}
      {subjectKind === 'direct' && directData.kind === 'range' && <div className="material-result-chart-card"><div className="material-result-chart-title"><b>价格/幅度趋势</b><span>仅使用真实数值 · 单位：%</span></div><ReactECharts echarts={echarts} option={directOption(directData)} style={{ height: 180 }} /></div>}
      {subjectKind === 'direct' && directData.kind === 'points' && <div className="material-result-chart-card"><div className="material-result-chart-title"><b>价格/幅度趋势</b><span>真实数值点：{directData.points.length} 个</span></div><ReactECharts echarts={echarts} option={directOption(directData)} style={{ height: 180 }} /></div>}
      {subjectKind === 'direct' && directData.kind === 'single' && <div className="material-result-single-signal"><b>当前价格/幅度记录</b><span>{numberText(directData.point.value)}% · {compactTime(directData.point.time)} · 只有 1 个真实数值点，暂不绘制空白趋势图。</span></div>}
      {subjectKind === 'direct' && directData.kind === 'insufficient' && <div className="material-result-data-gap"><AlertOutlined /> 暂无真实价格/幅度数值；保留洞察时间轴，不绘制空白价格图。</div>}
      {subjectKind === 'direct' && shouldUseSimulatedTrend(directData) && simulatedData.length >= 2 && <div className="material-result-chart-card"><div className="material-result-chart-title"><b>AI 模拟趋势</b><span>基准=100 · 仅辅助观察，不代表实际市场价格</span></div><ReactECharts echarts={echarts} option={simulatedOption(simulatedData, validSources.length)} style={{ height: 180 }} /></div>}
      {subjectKind === 'decomposition' && decompositionData.kind !== 'insufficient' && <div className="material-result-chart-card"><div className="material-result-chart-title"><b>节点贡献与方向影响</b><span>按成本占比加权</span></div><ReactECharts echarts={echarts} option={contributionOption(decompositionData.points)} style={{ height: Math.max(190, decompositionData.points.length * 30 + 58) }} onEvents={{ click: (event: any) => { const point = decompositionData.points.slice().reverse()[event?.dataIndex ?? -1]; if (point && onSelectNode) onSelectNode(point.nodeId); } }} /></div>}
      {subjectKind === 'decomposition' && decompositionData.kind === 'insufficient' && <div className="material-result-chart-empty"><AlertOutlined /> 数据不足：{decompositionData.reason}，不绘制贡献图。</div>}
    </div>

    {subjectKind === 'decomposition' && <Coverage coverage={coverage} />}

    <div className="material-result-driver-grid"><div><h4><ArrowUpOutlined /> 上行驱动</h4><ItemList items={upstreamDrivers} sources={sources} fallbackSources={conclusionSources} empty="本次未形成上行驱动" /></div><div><h4><ArrowDownOutlined /> 下行驱动</h4><ItemList items={downstreamDrivers} sources={sources} fallbackSources={conclusionSources} empty="本次未形成下行驱动" /></div></div>
    <Collapse className="material-result-more-details" ghost defaultActiveKey={[]} items={[{ key: 'details', label: '展开机会、风险、行动、项目影响与来源详情', children: <>
      <div className="material-result-three-columns"><div><h4><ThunderboltOutlined /> 机会</h4><ItemList items={opportunities} sources={sources} fallbackSources={conclusionSources} empty="本次未形成机会" /></div><div><h4><AlertOutlined /> 风险</h4><ItemList items={risks} sources={sources} fallbackSources={conclusionSources} empty="本次未形成风险" /></div><div><h4><CheckCircleOutlined /> 行动</h4><ItemList items={actions} sources={sources} fallbackSources={conclusionSources} empty="本次未形成行动" /></div></div>

    <div className="material-result-project-impact"><h4>项目影响</h4>{result.projectImpacts.length > 0 ? result.projectImpacts.map((item, index) => <div key={`${item.projectId || item.projectName}-${index}`}><b>{item.projectName || `项目 #${item.projectId}`}</b><span>{item.value == null ? '待计算' : `${numberText(item.value)}${item.unit}`}</span><small>{item.baseline == null ? '基线待补' : `基线 ${numberText(item.baseline)}`} · {item.target == null ? '目标待补' : `目标 ${numberText(item.target)}`}</small></div>) : <div><b>项目级估算待补</b><span>暂不计算</span><small>{hasSourceGap ? '缺少可核验来源' : '请先把物料关联到项目 BOM，提供单价与数量后估算影响。'}</small></div>}</div>

    <div className="material-result-evidence-compact"><div><b>来源与数据质量</b><span>{validSources.length} 条可点击来源 · {validEvidenceCount} 个已绑定证据ID</span></div>{qualityGaps.length > 0 && <p>{qualityGaps.slice(0, 4).join('；')}</p>}{validSources.slice(0, 6).map((source, index) => { const url = safeHttpUrl(source.source_url); let domain = ''; try { domain = new URL(url).hostname; } catch {} return <div className="material-result-source" key={`${source.id || source.source_url || index}`}><div><b>{source.source_title || `来源 ${index + 1}`}</b><small>{domain} · {compactTime(source.created_at || snapshot?.query_time)}</small></div><p>{shortText(source.excerpt || '未提供摘要')}</p><button type="button" onClick={() => void openSource(url)}>打开来源</button></div>; })}</div>

    </> }]} />
    <Collapse ghost items={[{ key: 'raw', label: '展开原始分析文本（调试）', children: <pre className="material-result-raw">{result.rawText || '无原始文本'}</pre> }]} />
  </section>;
}
