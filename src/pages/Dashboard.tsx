import { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { BarChartOutlined, ShopOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../echartsSetup';
import { getDashboardStats, getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs } from '../db';
import { getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';
import type { DashboardStats } from '../types';
import { CHART_COLORS, chartTooltip, chartAxisStyle, chartGrid, chartTextMuted, barGradient } from '../chartTheme';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>('');
  const [projCosts, setProjCosts] = useState<{ name: string; cost: number }[]>([]);
  const [compCosts, setCompCosts] = useState<{ name: string; cost: number }[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const s = await getDashboardStats();
        setStats(s);
        const [projs, comps] = await Promise.all([getProjects(), getCompetitors()]);
        const [allProjBoms, allCompBoms] = await Promise.all([
          Promise.all(projs.map((p: any) => getProjectBOMs(p.id))),
          Promise.all(comps.map((c: any) => getCompetitorBOMs(c.id))),
        ]);
        const pc = projs.map((p: any, i: number) => ({
          name: p.code,
          cost: Math.round(allProjBoms[i].reduce((sum: number, b: any) => sum + (b.part_cost || 0) * (b.quantity || 1), 0) * 100) / 100,
        }));
        setProjCosts(pc);
        const cc = comps.map((c: any, i: number) => ({
          name: `${c.brand} ${c.model}`,
          cost: Math.round(allCompBoms[i].reduce((sum: number, b: any) => sum + (b.estimated_cost || 0) * (b.quantity || 1), 0) * 100) / 100,
        }));
        setCompCosts(cc);
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error('Dashboard load error:', e);
        setLoadError(msg);
      }
      setLoading(false);
    })();
  }, []);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;
  if (!stats) return (
    <div style={{ padding: 32 }}>
      <div className="page-title"><BarChartOutlined /> 仪表盘</div>
      {loadError && (
        <div style={{ marginTop: 16, padding: 16, background: '#FFF1F2', borderRadius: 8, color: '#DC2626', fontSize: 13 }}>
          <strong>加载失败，错误信息：</strong><br />{loadError}
        </div>
      )}
      {!loadError && <div style={{ marginTop: 16, color: '#64748B' }}>暂无数据，请先添加器件或项目。</div>}
    </div>
  );

  const projBarOption = {
    tooltip: chartTooltip('axis'),
    xAxis: { type: 'category', data: projCosts.map(d => d.name), ...chartAxisStyle(12) },
    yAxis: { type: 'value', name: '¥', ...chartAxisStyle() },
    series: [{
      type: 'bar', barWidth: '55%',
      data: projCosts.map((d, i) => ({ value: d.cost, itemStyle: { color: barGradient(CHART_COLORS[i % CHART_COLORS.length]), borderRadius: [8, 8, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, fontWeight: 600, color: chartTextMuted() },
    }],
    grid: chartGrid(),
  };

  const compBarOption = {
    tooltip: chartTooltip('axis'),
    xAxis: { type: 'category', data: compCosts.map(d => d.name), ...chartAxisStyle(10, { rotate: 20 }) },
    yAxis: { type: 'value', name: '¥', ...chartAxisStyle() },
    series: [{
      type: 'bar', barWidth: '55%',
      data: compCosts.map((d, i) => ({ value: d.cost, itemStyle: { color: barGradient(CHART_COLORS[(i + 2) % CHART_COLORS.length]), borderRadius: [8, 8, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, fontWeight: 600, color: chartTextMuted() },
    }],
    grid: chartGrid({ bottom: 60 }),
  };

  const recentCols = [
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <span style={{ color: getCategoryColor(v), fontWeight: 500 }}>{v}</span> },
    { title: '子类', dataIndex: 'sub_category', width: 100 },
    { title: '名称', dataIndex: 'name' },
    { title: '型号', dataIndex: 'model', ellipsis: true },
    { title: '成本(¥)', dataIndex: 'cost', width: 100, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
    { title: '更新时间', dataIndex: 'updated_at', width: 150 },
  ];

  return (
    <div>
      <div className="page-title"><BarChartOutlined /> 仪表盘</div>
      <div className="stat-cards">
        <div className="stat-card card-a" onClick={() => onNavigate?.('parts')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">器件总数</div><div className="stat-value">{stats.total_parts}</div></div>
        <div className="stat-card card-b" onClick={() => onNavigate?.('projects')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">项目总数</div><div className="stat-value">{stats.total_projects}</div></div>
        <div className="stat-card card-c" onClick={() => onNavigate?.('projects')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">进行中项目</div><div className="stat-value">{stats.active_projects}</div></div>
        <div className="stat-card card-d"><div className="stat-label">平均BOM成本</div><div className="stat-value">¥{stats.avg_bom_cost.toLocaleString()}</div></div>
        <div className="stat-card card-e" onClick={() => onNavigate?.('competitors')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">竞品数量</div><div className="stat-value">{stats.total_competitors}</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="content-card">
          <div className="card-header"><h3><BarChartOutlined /> 各项目BOM成本</h3></div>
          <ReactECharts echarts={echarts} option={projBarOption} style={{ height: 320 }} />
        </div>
        <div className="content-card">
          <div className="card-header"><h3><ShopOutlined /> 竞品BOM成本</h3></div>
          <ReactECharts echarts={echarts} option={compBarOption} style={{ height: 320 }} />
        </div>
      </div>

      <div className="content-card">
        <div className="card-header"><h3>最近更新器件</h3></div>
        <DataTable tableId="dash_recent_parts" dataSource={stats.recent_parts} columns={recentCols} rowKey="id" size="small" pagination={false} />
      </div>
    </div>
  );
}
