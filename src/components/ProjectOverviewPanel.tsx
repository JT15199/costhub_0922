import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Select, Spin, Tag, message } from 'antd';
import { freezeProjectStage, getCostLayerSummary, getProjectBOMVersions, getProjectTargetVersions, getTenderDecision, getTenderOverview, getWorkLogs } from '../db';
import { bomExtendedCostStrict } from '../ai/contracts';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';

type Props = {
  project: any;
  boms: any[];
  targets: any[];
  measures: any[];
  reviews: any[];
  snapshots: any[];
  suppliers?: any[];
  referenceProject?: any;
  referenceBoms?: any[];
};

const LAYER_LABELS: Record<string, string> = { material: '物料', packaging: '包材', odm_processing: 'ODM加工费' };
const STAGES = ['Charter', 'CDCP', 'PDCP', 'ADCP', '量产后降本'];

function money(value: unknown) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '待补证据';
  return `¥${Number(value).toFixed(2)}`;
}

function stageOf(project: any) {
  if (STAGES.includes(project?.stage)) return project.stage;
  if (STAGES.includes(project?.project_stage)) return project.project_stage;
  return project?.status === '已完成' ? '量产后降本' : 'Charter';
}

export default function ProjectOverviewPanel({ project, boms, targets, measures, reviews, snapshots, suppliers = [], referenceProject, referenceBoms = [] }: Props) {
  const [summary, setSummary] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [targetVersions, setTargetVersions] = useState<any[]>([]);
  const [tenderOverview, setTenderOverview] = useState<any>(null);
  const [tenderDecision, setTenderDecision] = useState<any>(null);
  const [workLogs, setWorkLogs] = useState<any[]>([]);
  const [timelineSnapshots, setTimelineSnapshots] = useState<any[]>(snapshots);
  const [stage, setStage] = useState('Charter');
  const [freezingStage, setFreezingStage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);

  useEffect(() => {
    if (!project?.id) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    setStage(stageOf(project));
    setTimelineSnapshots(snapshots);
    Promise.all([getCostLayerSummary(project.id), getProjectBOMVersions(project.id), getProjectTargetVersions(project.id), getTenderOverview(project.id), getTenderDecision(project.id), getWorkLogs('', '', '', '', Number(project.id))])
      .then(([nextSummary, nextVersions, nextTargetVersions, nextTenderOverview, nextTenderDecision, nextWorkLogs]) => {
        if (seq !== loadSeq.current) return;
        setSummary(nextSummary);
        setVersions(nextVersions);
        setTargetVersions(nextTargetVersions);
        setTenderOverview(nextTenderOverview);
        setTenderDecision(nextTenderDecision);
        setWorkLogs(nextWorkLogs);
      })
      .catch((reason: any) => { if (seq === loadSeq.current) setError(String(reason?.message || reason || '项目总览载入失败')); })
      .finally(() => { if (seq === loadSeq.current) setLoading(false); });
  }, [project, project?.id, project?.stage, project?.project_stage, project?.status, boms.length, snapshots]);

  const latestFrozen = versions.find(version => version.status === 'frozen');
  const latestTarget = targetVersions.find(version => version.status === 'frozen') || targetVersions[0];
  const targetCost = Number(latestTarget?.target_cost || targets.reduce((sum, row) => sum + Number(row.target_cost || 0), 0));
  const openMeasures = measures.filter(row => !['已完成', '已实现', '未实现', '放弃', '完成', 'closed'].includes(row.status));
  const forecastSaving = measures.reduce((sum, row) => sum + Number(row.forecast_saving || 0), 0);
  const realizedSaving = measures.reduce((sum, row) => sum + Number(row.realized_saving || 0), 0);
  const lowestQuote = Number(tenderOverview?.summary?.bestFullQuote || 0) > 0 ? { quoted_price: tenderOverview.summary.bestFullQuote, supplier_name: tenderDecision?.selectedSupplier || '当前轮最低报价' } : suppliers.filter(row => Number(row.quoted_price) > 0).sort((a, b) => Number(a.quoted_price) - Number(b.quoted_price))[0];
  const currentStage = stage;
  const nextStage = STAGES[Math.min(STAGES.indexOf(currentStage) + 1, STAGES.length - 1)];
  const domainRows = useMemo(() => {
    const costs = new Map<string, { value: number; unknown: boolean }>();
    (summary?.rows || boms).forEach((row: any) => {
      const domain = String(row.main_category || '其他');
      const current = costs.get(domain) || { value: 0, unknown: false };
      const lineTotal = bomExtendedCostStrict(row);
      if (lineTotal === null) current.unknown = true;
      else current.value += lineTotal;
      costs.set(domain, current);
    });
    const targetMap = new Map(targets.map(row => [String(row.domain || '其他'), Number(row.target_cost || 0)]));
    return [...costs.entries()].map(([domain, current]) => ({ domain, current: current.unknown ? null : current.value, unknown: current.unknown, target: targetMap.get(domain) || 0, gap: current.unknown ? null : current.value - (targetMap.get(domain) || 0) })).sort((a, b) => (b.current || 0) - (a.current || 0));
  }, [summary, boms, targets]);
  const layerChartRows = useMemo(() => summary?.missingCostRows?.length ? [] : Object.entries(LAYER_LABELS).map(([key, name]) => ({ name, value: Number(summary?.layers?.[key] || 0) })).filter(row => row.value > 0), [summary]);
  const layerChartOption = useMemo(() => ({
    animationDuration: 500,
    color: ['#2f6fed', '#7ec8a1', '#f2b861', '#9daec3'],
    tooltip: { trigger: 'item', formatter: (params: any) => `${params.name}<br/>${money(params.value)}（${params.percent}%）` },
    legend: { orient: 'vertical', left: '2%', top: 'middle', textStyle: { fontSize: 10, color: '#718198' } },
    series: [{ type: 'pie', radius: ['56%', '76%'], center: ['68%', '50%'], label: { show: false }, labelLine: { show: false }, data: layerChartRows }],
  }), [layerChartRows]);
  const domainChartRows = useMemo(() => domainRows.slice(0, 6).reverse(), [domainRows]);
  const domainChartOption = useMemo(() => ({
    animationDuration: 500,
    color: ['#2f6fed', '#c6d4e6'],
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value: number) => money(value) },
    legend: { top: 0, right: 0, textStyle: { fontSize: 10, color: '#718198' } },
    grid: { left: 78, right: 16, top: 28, bottom: 22 },
    xAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#8a9bb0', formatter: (value: number) => `¥${value}` }, splitLine: { lineStyle: { color: '#edf1f6' } } },
    yAxis: { type: 'category', data: domainChartRows.map(row => row.domain), axisLabel: { fontSize: 10, color: '#52667d' }, axisTick: { show: false } },
    series: [{ name: '当前成本', type: 'bar', barMaxWidth: 12, data: domainChartRows.map(row => row.current) }, { name: '目标成本', type: 'bar', barMaxWidth: 12, data: domainChartRows.map(row => row.target) }],
  }), [domainChartRows]);
  const trendChartRows = useMemo(() => [...timelineSnapshots].filter(row => Number(row.total_cost || 0) > 0).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))).slice(-8), [timelineSnapshots]);
  const trendChartOption = useMemo(() => ({
    animationDuration: 500,
    color: ['#2f6fed'],
    tooltip: { trigger: 'axis', valueFormatter: (value: number) => money(value) },
    grid: { left: 52, right: 16, top: 18, bottom: 28 },
    xAxis: { type: 'category', boundaryGap: false, data: trendChartRows.map(row => String(row.created_at || '').slice(5, 10)), axisLabel: { fontSize: 10, color: '#8a9bb0' }, axisLine: { lineStyle: { color: '#dbe3ed' } } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#8a9bb0', formatter: (value: number) => `¥${value}` }, splitLine: { lineStyle: { color: '#edf1f6' } } },
    series: [{ name: '标准成本', type: 'line', smooth: true, showSymbol: true, symbolSize: 7, data: trendChartRows.map(row => Number(row.total_cost || 0)), lineStyle: { width: 3 }, areaStyle: { opacity: 0.12 } }],
  }), [trendChartRows]);
  const specDiffCount = referenceProject ? ['screen_size', 'resolution', 'refresh_rate', 'panel_type', 'specs'].filter(key => String(project?.[key] || '') !== String(referenceProject?.[key] || '')).length : null;
  const completeness = useMemo(() => {
    const checks = [boms.length > 0, !summary?.missingCostRows?.length, boms.every(row => Boolean(row.module_name)), Boolean(targetCost), Boolean(latestFrozen), Boolean(tenderOverview?.batches?.length)];
    return Math.round(checks.filter(Boolean).length / checks.length * 100);
  }, [boms, summary, targetCost, latestFrozen, tenderOverview]);
  const latestDataAt = [project.updated_at, ...snapshots.map(row => row.created_at), ...versions.map(row => row.frozen_at || row.created_at), ...targetVersions.map(row => row.frozen_at || row.created_at), tenderDecision?.updatedAt, tenderOverview?.currentRound?.createdAt].filter(Boolean).sort().at(-1) || '—';
  const timeline = useMemo(() => [
    ...timelineSnapshots.map(row => ({ at: row.created_at, label: row.change_reason || '成本快照', detail: `标准成本 ${money(row.total_cost)}`, tone: 'blue' })),
    ...versions.map(row => ({ at: row.frozen_at || row.created_at, label: `冻结 ${row.version_name || `BOM v${row.version_no}`}`, detail: `版本成本 ${money(row.total_cost)}`, tone: 'green' })),
    ...targetVersions.map(row => ({ at: row.frozen_at || row.created_at, label: `冻结目标 v${row.version_no}`, detail: `目标 ${money(row.target_cost)}`, tone: 'orange' })),
    ...reviews.map(row => ({ at: row.reviewed_at, label: `${row.stage || '阶段'}评审`, detail: `评审成本 ${money(row.reviewed_cost)}`, tone: 'purple' })),
    ...(tenderOverview?.events || []).map((row: any) => ({ at: row.createdAt, label: `报价 · ${row.summary}`, detail: row.actor || '报价工作台', tone: 'gold' })),
    ...workLogs.map(row => ({ at: row.log_date || row.created_at, label: row.title || '工作记录', detail: `${row.stage ? `${row.stage} · ` : ''}${row.content || ''}`, tone: row.record_type === 'risk' ? 'red' : 'gray' })),
  ].filter(row => row.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12), [timelineSnapshots, versions, targetVersions, reviews, tenderOverview, workLogs]);

  const freezeStage = async () => {
    setFreezingStage(true);
    try { await freezeProjectStage(Number(project.id), stage); message.success(`已冻结阶段：${stage}`); const [nextSnapshots, nextWorkLogs] = await Promise.all([import('../db').then(db => db.getProjectCostSnapshots(Number(project.id))), getWorkLogs('', '', '', '', Number(project.id))]); setTimelineSnapshots(nextSnapshots); setWorkLogs(nextWorkLogs); window.dispatchEvent(new CustomEvent('costhub-project-saved', { detail: { projectId: project.id } })); window.dispatchEvent(new CustomEvent('costhub-project-bom-updated')); }
    catch (reason: any) { message.error(`阶段冻结失败：${String(reason?.message || reason).slice(0, 120)}`); }
    finally { setFreezingStage(false); }
  };

  if (!project?.id) return <Empty description="请选择项目" />;
  if (loading && !summary) return <div className="project-overview-loading"><Spin tip="载入项目总览…" /></div>;
  if (error && !summary) return <Alert type="error" showIcon message="项目总览载入失败" description={error} />;
  const layers = summary?.missingCostRows?.length ? {} : (summary?.layers || { material: 0, packaging: 0, odm_processing: 0 });
  const gap = targetCost > 0 && summary?.standardCost != null ? Number(summary.standardCost) - targetCost : null;

  return (
    <section className="project-overview-panel" aria-labelledby="project-overview-title">
      <div className="project-overview-heading">
        <div><span className="eyebrow">项目决策摘要</span><h2 id="project-overview-title">当前阶段：{currentStage}</h2><p>下一节点：{nextStage} · 数据以当前 BOM、冻结版本和已确认目标为准</p></div>
        <div className="project-overview-stage-actions"><Select size="small" value={stage} onChange={setStage} options={STAGES.map(value => ({ value, label: value }))} aria-label="项目阶段" /><Button size="small" type="primary" loading={freezingStage} onClick={() => void freezeStage()}>冻结阶段</Button>{latestFrozen ? <Tag color="green">已冻结 {latestFrozen.version_name || `BOM v${latestFrozen.version_no}`}</Tag> : <Tag color="orange">尚未冻结 BOM</Tag>}</div>
      </div>
      <div className="project-overview-kpi-grid">
        <Card size="small"><span className="overview-kpi-label">标准成本</span><strong className="overview-kpi-value">{money(summary?.standardCost)}</strong><small>可分解 {money(summary?.decomposable)} + 平台费 {money(summary?.platformFee)}</small></Card>
        <Card size="small"><span className="overview-kpi-label">目标差距</span><strong className={`overview-kpi-value ${gap !== null && gap > 0 ? 'is-danger' : gap === null ? '' : 'is-good'}`}>{targetCost ? money(gap) : '未设目标'}</strong><small>{targetCost ? (gap === null ? '成本证据未完整' : gap > 0 ? '高于当前冻结目标' : '已达目标') : '先确认基线和目标版本'}</small></Card>
        <Card size="small"><span className="overview-kpi-label">开放措施</span><strong className="overview-kpi-value">{openMeasures.length}</strong><small>预计节省 {money(forecastSaving)} · 已实现 {money(realizedSaving)}</small></Card>
        <Card size="small"><span className="overview-kpi-label">最低整机报价</span><strong className="overview-kpi-value">{lowestQuote ? money(lowestQuote.quoted_price) : '暂无'}</strong><small>{lowestQuote?.supplier_name || '等待供应商报价'}</small></Card>
      </div>
      <div className="overview-visual-grid">
        <Card size="small" title="成本结构占比">
          {layerChartRows.length ? <ReactECharts echarts={echarts} option={layerChartOption} notMerge style={{ height: 210 }} /> : <div className="overview-chart-empty">暂无成本结构数据</div>}
        </Card>
        <Card size="small" title="领域成本 vs 目标">
          {domainChartRows.length ? <ReactECharts echarts={echarts} option={domainChartOption} notMerge style={{ height: 210 }} /> : <div className="overview-chart-empty">暂无领域成本数据</div>}
        </Card>
        <Card size="small" title="标准成本版本趋势" className="overview-chart-wide">
          {trendChartRows.length > 1 ? <ReactECharts echarts={echarts} option={trendChartOption} notMerge style={{ height: 210 }} /> : <div className="overview-chart-empty">冻结多个成本版本后显示趋势</div>}
        </Card>
      </div>
      <div className="overview-detail-grid">
        <Card size="small" title="四层成本结构"><div className="overview-layer-list">{Object.entries(layers).map(([key, value]) => <div className="overview-layer-row" key={key}><span>{LAYER_LABELS[key] || key}</span><b>{money(value)}</b><em>{summary?.decomposable ? `${(Number(value) / summary.decomposable * 100).toFixed(1)}%` : '—'}</em></div>)}<div className="overview-layer-row overview-layer-total"><span>平台费</span><b>{money(summary?.platformFee)}</b><em>{Number(project.platform_fee_rate || 0)}%</em></div></div>{summary?.missingCostRows?.length > 0 && <Alert className="overview-alert" type="warning" showIcon message={`${summary.missingCostRows.length} 行缺少有效成本，未按 0 元当作已完成`} />}</Card>
        <Card size="small" className="overview-reference-card" title="项目参照、版本与完整性"><div className="overview-check-grid"><span>BOM当前行数 <b>{boms.length}</b></span><span>冻结BOM版本 <b>{versions.length}</b></span><span>目标版本 <b>{targetVersions.length}</b></span><span>报价批次 <b>{tenderOverview?.batches?.length || 0}</b></span><span>阶段评审 <b>{reviews.length}</b></span><span>数据完整度 <b>{completeness}%</b></span></div><div className="overview-reference-row"><span>主要参照项目</span><b>{referenceProject ? `${referenceProject.code || ''} ${referenceProject.name || ''}` : '未选择'}</b><em>{referenceProject ? `规格差异 ${specDiffCount} 项 · 参照 BOM ${referenceBoms.length} 行` : '成本策划中可选择已冻结参照项目'}</em></div><div className="overview-reference-row"><span>最低报价 / 定点 ODM</span><b>{lowestQuote ? `${lowestQuote.supplier_name || '待确认'} · ${money(lowestQuote.quoted_price)}` : '暂无报价'}</b><em>{tenderDecision?.status === 'selected' ? '已定点' : tenderDecision?.status === 'cancelled' ? '已取消' : '未定点'}</em></div>{!latestFrozen && <Alert className="overview-alert" type="info" showIcon message="建议先在成本策划中冻结当前 BOM，后续目标、Charter 和成本报告才能追溯。" />}{latestTarget && <div className="overview-version-note">最新目标版本 v{latestTarget.version_no}：目标 {money(latestTarget.target_cost)}，挑战缺口 {money(latestTarget.challenge_gap)}。</div>}{tenderOverview?.currentRound && <div className="overview-version-note">当前报价：第{tenderOverview.currentRound.roundNo}轮 · {tenderOverview.currentRound.name} · 可比覆盖 {Math.round((tenderOverview.summary?.comparableCoverage || 0) * 100)}%。</div>}</Card>
        <Card size="small" title="领域目标达成"><div className="overview-domain-list">{domainRows.length ? domainRows.slice(0, 8).map(row => <div className="overview-domain-row" key={row.domain}><span>{row.domain}</span><b>{money(row.current)}</b><small>{row.unknown ? '待补证据，无法判断' : row.target ? `目标 ${money(row.target)} · ${row.gap !== null && row.gap <= 0 ? '达成' : `超支 ${money(row.gap)}`}` : '未设目标'}</small></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无有效 BOM 成本" />}</div></Card>
        <Card size="small" title="数据新鲜度"><div className="overview-freshness"><strong>{latestDataAt}</strong><span>最近一次项目数据更新</span><span>{summary?.missingCostRows?.length ? `缺少成本 ${summary.missingCostRows.length} 行` : '成本字段完整'}</span><span>{openMeasures.length ? `待处理措施 ${openMeasures.length} 条` : '暂无开放措施'}</span></div></Card>
      </div>
      <Card size="small" title="不可变时间线" className="overview-timeline-card">{timeline.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无快照、版本或评审记录" /> : <div className="overview-timeline">{timeline.map((row, index) => <div className="overview-timeline-row" key={`${row.at}-${row.label}-${index}`}><i className={`timeline-dot ${row.tone}`} /><time>{row.at}</time><div><b>{row.label}</b><span>{row.detail}</span></div></div>)}</div>}</Card>
    </section>
  );
}
