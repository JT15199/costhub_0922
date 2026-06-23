import { useEffect, useState } from 'react';
import { Table, Spin } from 'antd';
import ReactECharts from 'echarts-for-react';
import { getDashboardStats, getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs } from '../db';
import { CATEGORY_COLORS } from '../constants';
import type { DashboardStats } from '../types';

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [projCosts, setProjCosts] = useState<{ name: string; cost: number }[]>([]);
  const [compCosts, setCompCosts] = useState<{ name: string; cost: number }[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s = await getDashboardStats(); setStats(s);
        // Project BOM costs
        const projs = await getProjects();
        const pc: { name: string; cost: number }[] = [];
        for (const p of projs) {
          const boms = await getProjectBOMs(p.id);
          const total = boms.reduce((sum, b) => sum + (b.part_cost || 0) * (b.quantity || 1), 0);
          pc.push({ name: p.code, cost: Math.round(total * 100) / 100 });
        }
        setProjCosts(pc);
        // Competitor costs
        const comps = await getCompetitors();
        const cc: { name: string; cost: number }[] = [];
        for (const c of comps) {
          const cboms = await getCompetitorBOMs(c.id);
          const total = cboms.reduce((sum: number, b: any) => sum + (b.estimated_cost || 0) * (b.quantity || 1), 0);
          cc.push({ name: `${c.brand} ${c.model}`, cost: Math.round(total * 100) / 100 });
        }
        setCompCosts(cc);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;
  if (!stats) return <div className="page-title">📊 仪表盘</div>;

  const projBarOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].name}<br/>BOM成本: <b>¥${p[0].value.toFixed(2)}</b>` },
    xAxis: { type: 'category', data: projCosts.map(d => d.name), axisLabel: { fontSize: 12 } },
    yAxis: { type: 'value', name: '¥' },
    series: [{
      type: 'bar', barWidth: '55%',
      data: projCosts.map((d, i) => ({ value: d.cost, itemStyle: { color: ['#CF0A2C', '#2563EB', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'][i % 6], borderRadius: [6, 6, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, fontWeight: 500 },
    }],
    grid: { top: 25, right: 20, bottom: 40, left: 60 },
  };

  const compBarOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].name}<br/>BOM成本: <b>¥${p[0].value.toFixed(2)}</b>` },
    xAxis: { type: 'category', data: compCosts.map(d => d.name), axisLabel: { rotate: 20, fontSize: 10 } },
    yAxis: { type: 'value', name: '¥' },
    series: [{
      type: 'bar', barWidth: '55%',
      data: compCosts.map((d, i) => ({ value: d.cost, itemStyle: { color: ['#8B5CF6', '#EC4899', '#F97316', '#14B8A6', '#64748B'][i % 5], borderRadius: [6, 6, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, fontWeight: 500 },
    }],
    grid: { top: 25, right: 20, bottom: 60, left: 60 },
  };

  const recentCols = [
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <span style={{ color: CATEGORY_COLORS[v], fontWeight: 500 }}>{v}</span> },
    { title: '子类', dataIndex: 'sub_category', width: 100 },
    { title: '名称', dataIndex: 'name' },
    { title: '型号', dataIndex: 'model', ellipsis: true },
    { title: '成本(¥)', dataIndex: 'cost', width: 100, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
    { title: '更新时间', dataIndex: 'updated_at', width: 150 },
  ];

  return (
    <div>
      <div className="page-title">📊 仪表盘</div>
      <div className="stat-cards">
        <div className="stat-card card-a"><div className="stat-label">器件总数</div><div className="stat-value">{stats.total_parts}</div></div>
        <div className="stat-card card-b"><div className="stat-label">项目总数</div><div className="stat-value">{stats.total_projects}</div></div>
        <div className="stat-card card-c"><div className="stat-label">进行中项目</div><div className="stat-value">{stats.active_projects}</div></div>
        <div className="stat-card card-d"><div className="stat-label">平均BOM成本</div><div className="stat-value">¥{stats.avg_bom_cost.toLocaleString()}</div></div>
        <div className="stat-card card-e"><div className="stat-label">竞品数量</div><div className="stat-value">{stats.total_competitors}</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="content-card">
          <div className="card-header"><h3>📊 各项目BOM成本</h3></div>
          <ReactECharts option={projBarOption} style={{ height: 320 }} />
        </div>
        <div className="content-card">
          <div className="card-header"><h3>🏭 竞品BOM成本</h3></div>
          <ReactECharts option={compBarOption} style={{ height: 320 }} />
        </div>
      </div>

      <div className="content-card">
        <div className="card-header"><h3>最近更新器件</h3></div>
        <Table dataSource={stats.recent_parts} columns={recentCols} rowKey="id" size="small" pagination={false} />
      </div>
    </div>
  );
}
