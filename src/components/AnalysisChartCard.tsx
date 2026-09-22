import { useState } from 'react';
import { Button, Modal, message } from 'antd';
import { ExpandOutlined, DownloadOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { analysisChartOption, renderAnalysisSvg, type ChartArtifact } from '../ai/analysisChart';
import { openPiExecutionPath } from '../ai/piExecution';

export default function AnalysisChartCard({ artifact }: { artifact: ChartArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const chart = artifact.chart;
  const motion = typeof document !== 'undefined' && document.documentElement.dataset.motion !== 'off' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const exportSvg = () => {
    const url = URL.createObjectURL(new Blob([renderAnalysisSvg(chart)], { type: 'image/svg+xml;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${chart.title.replace(/[\\/:*?"<>|]/g, '_')}.svg`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const content = (large = false) => <>
    <div className="analysis-chart-kicker">COSTHUB <span>/ ANALYSIS</span></div>
    <h3>{chart.title}</h3>
    <p className="analysis-chart-takeaway">{chart.takeaway}</p>
    <ReactECharts echarts={echarts} option={analysisChartOption(chart, motion)} opts={{ renderer: 'svg' }} style={{ height: chart.type === 'bar' ? Math.max(260, chart.labels.length * chart.series.length * 23 + 80) : large ? 380 : 280 }} />
    <div className="analysis-chart-source"><span>来源 · {chart.source}</span><span>口径 · {chart.basis}</span><span>AI 整理 · 请结合原始数据核对</span></div>
    <details className="analysis-chart-data"><summary>查看图表数据 · {chart.unit || '数值'}</summary><div style={{ overflowX: 'auto' }}><table><thead><tr><th>分类 / 时间</th>{chart.series.map(s => <th key={s.name}>{s.name}</th>)}</tr></thead><tbody>{chart.labels.map((label, i) => <tr key={label}><th>{label}</th>{chart.series.map(s => <td key={s.name}>{s.values[i] === null ? '缺失' : s.values[i]?.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}</td>)}</tr>)}</tbody></table></div></details>
  </>;
  return <>
    <article className="analysis-chart-card" aria-label={chart.title}>
      {content()}
      <div className="analysis-chart-actions"><Button size="small" type="text" icon={<ExpandOutlined />} onClick={() => setExpanded(true)}>放大</Button><Button size="small" type="text" icon={<DownloadOutlined />} onClick={exportSvg}>导出 SVG</Button><Button size="small" type="text" onClick={() => void openPiExecutionPath(artifact.workspace, artifact.path).catch(e => message.error(String(e)))}>打开文件</Button></div>
    </article>
    <Modal open={expanded} onCancel={() => setExpanded(false)} footer={null} width={980} destroyOnHidden title="分析图表"><div className="analysis-chart-card">{content(true)}</div></Modal>
  </>;
}
