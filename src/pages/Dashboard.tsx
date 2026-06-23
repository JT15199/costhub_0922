import { useEffect, useState } from 'react';
import { Spin, Row, Col } from 'antd';
import ReactECharts from 'echarts-for-react';
import { getDashboardStats, getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs, getParts, getModules } from '../db';
import { getCategoryColor } from '../constants';
import type { DashboardStats } from '../types';

// 导出最近更新数据供 App 使用
export let recentPartsData: any[] = [];

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [projCosts, setProjCosts] = useState<{ name: string; cost: number; feeRate?: number }[]>([]);
  const [compCosts, setCompCosts] = useState<{ name: string; cost: number }[]>([]);
  const [partsByCategory, setPartsByCategory] = useState<{ category: string; count: number }[]>([]);
  const [costTrends, setCostTrends] = useState<{ name: string; values: number[] }[]>([]);
  const [moduleCount, setModuleCount] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s = await getDashboardStats(); setStats(s);
        // 更新全局最近器件数据
        recentPartsData = s.recent_parts || [];
        // Project BOM costs
        const projs = await getProjects();
        const pc: { name: string; cost: number; feeRate?: number }[] = [];
        // 计算模组总数
        let totalModules = 0;
        for (const p of projs) {
          const boms = await getProjectBOMs(p.id);
          const bomCost = boms.reduce((sum, b) => sum + (b.part_cost || 0) * (b.quantity || 1), 0);
          const feeRate = (p.platform_fee_rate || 0) + (p.profit_rate || 0);
          const total = bomCost * (1 + feeRate / 100);
          pc.push({ name: p.code, cost: Math.round(total * 100) / 100, feeRate });
          const mods = await getModules(p.id);
          totalModules += mods.length;
        }
        setProjCosts(pc);
        setModuleCount(totalModules);
        // Competitor costs
        const comps = await getCompetitors();
        const cc: { name: string; cost: number }[] = [];
        for (const c of comps) {
          const cboms = await getCompetitorBOMs(c.id);
          const total = cboms.reduce((sum: number, b: any) => sum + (b.estimated_cost || 0) * (b.quantity || 1), 0);
          cc.push({ name: `${c.brand} ${c.model}`, cost: Math.round(total * 100) / 100 });
        }
        setCompCosts(cc);
        // Parts by category
        const parts = await getParts('', '', '');
        const catMap: Record<string, number> = {};
        parts.forEach(p => { catMap[p.main_category] = (catMap[p.main_category] || 0) + 1; });
        setPartsByCategory(Object.entries(catMap).map(([k, v]) => ({ category: k, count: v })).sort((a, b) => b.count - a.count));
        // Cost trends simulation (for demo, show different stages)
        const trends: { name: string; values: number[] }[] = [];
        for (const p of projs.slice(0, 5)) {
          const boms = await getProjectBOMs(p.id);
          const total = boms.reduce((sum, b) => sum + (b.part_cost || 0) * (b.quantity || 1), 0);
          // Simulate cost reduction trend: Charter -> CDCP -> PDCP -> ADCP -> Mass
          trends.push({ name: p.code, values: [total * 1.15, total * 1.08, total, total * 0.95, total * 0.88] });
        }
        setCostTrends(trends);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;
  if (!stats) return <div className="page-title"><span className="emoji">📊</span> 仪表盘</div>;

  // Mac风格图表颜色
  const projBarOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => {
      const d = projCosts[p[0].dataIndex];
      const feeInfo = (d?.feeRate ?? 0) > 0 ? `<br/>含费率: ${d.feeRate}%` : '';
      return `${p[0].name}<br/>含费总额: <b>¥${p[0].value.toFixed(2)}</b>${feeInfo}`;
    }},
    xAxis: { type: 'category', data: projCosts.map(d => d.name), axisLabel: { fontSize: 13, fontWeight: 500 } },
    yAxis: { type: 'value', name: '¥' },
    series: [{
      type: 'bar', barWidth: '50%',
      data: projCosts.map((d, i) => ({ value: d.cost, itemStyle: { color: ['#3B82F6', '#34C759', '#FF9500', '#8B5CF6', '#FF3B30', '#5AC8FA'][i % 6], borderRadius: [8, 8, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 12, fontWeight: 600, color: '#1D1D1F' },
    }],
    grid: { top: 30, right: 24, bottom: 36, left: 60 },
  };

  const compBarOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].name}<br/>BOM成本: <b>¥${p[0].value.toFixed(2)}</b>` },
    xAxis: { type: 'category', data: compCosts.map(d => d.name), axisLabel: { rotate: 15, fontSize: 11, fontWeight: 500 } },
    yAxis: { type: 'value', name: '¥' },
    series: [{
      type: 'bar', barWidth: '50%',
      data: compCosts.map((d, i) => ({ value: d.cost, itemStyle: { color: ['#8B5CF6', '#AF52DE', '#FF9500', '#5AC8FA', '#6E6E73'][i % 5], borderRadius: [8, 8, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 12, fontWeight: 600, color: '#1D1D1F' },
    }],
    grid: { top: 30, right: 24, bottom: 48, left: 60 },
  };

  // 器件分类分布饼图 (环形图)
  const pieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c}件 ({d}%)' },
    legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { fontSize: 12 } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['35%', '50%'],
      avoidLabelOverlap: false,
      itemStyle: { borderRadius: 8, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      labelLine: { show: false },
      data: partsByCategory.slice(0, 8).map(d => ({ name: d.category, value: d.count, itemStyle: { color: getCategoryColor(d.category) } })),
    }],
  };

  // 项目成本趋势折线图
  const trendOption = {
    tooltip: { trigger: 'axis', formatter: (params: any) => {
      const names = params.map((p: any) => `${p.seriesName}: ¥${p.value.toFixed(2)}`).join('<br/>');
      return `<b>${params[0].axisValue}</b><br/>${names}`;
    }},
    legend: { data: costTrends.map(t => t.name), show: false, bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 60, right: 20, top: 20, bottom: 50 },
    xAxis: { type: 'category', data: ['Charter', 'CDCP', 'PDCP', 'ADCP', '量产'], axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', name: '成本 (¥)' },
    series: costTrends.map((t, i) => ({
      name: t.name,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 8,
      data: t.values,
      lineStyle: { width: 2 },
      itemStyle: { color: ['#3B82F6', '#34C759', '#FF9500', '#8B5CF6', '#FF3B30'][i % 5] },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
        { offset: 0, color: ['#3B82F6', '#34C759', '#FF9500', '#8B5CF6', '#FF3B30'][i % 5] + '30' },
        { offset: 1, color: ['#3B82F6', '#34C759', '#FF9500', '#8B5CF6', '#FF3B30'][i % 5] + '00' },
      ]}},
    })),
  };

  // 竞品成本对比雷达图
  const radarOption = {
    tooltip: {},
    legend: { data: compCosts.slice(0, 4).map(c => c.name), show: false, bottom: 10 },
    radar: {
      indicator: [
        { name: 'BOM成本', max: Math.max(...compCosts.map(c => c.cost), 1000) },
        { name: '市场价格', max: Math.max(...compCosts.map(c => c.cost * 1.5), 1500) },
        { name: '毛利率', max: 100 },
        { name: '器件数量', max: 100 },
        { name: '模块化程度', max: 100 },
      ],
      center: ['50%', '55%'],
      radius: '60%',
    },
    series: [{
      type: 'radar',
      data: compCosts.slice(0, 4).map((c, i) => ({
        name: c.name,
        value: [c.cost, c.cost * 1.3, 30, 50, 70],
        itemStyle: { color: ['#8B5CF6', '#AF52DE', '#FF9500', '#5AC8FA'][i % 4] },
        areaStyle: { color: ['#8B5CF6', '#AF52DE', '#FF9500', '#5AC8FA'][i % 4] + '20' },
      })),
    }],
  };

  return (
    <div>
      <div className="page-title"><span className="emoji">📊</span> 仪表盘</div>
      <div className="stat-cards">
        <div className="stat-card card-a"><div className="stat-label">器件总数</div><div className="stat-value">{stats.total_parts}</div></div>
        <div className="stat-card card-b"><div className="stat-label">模组数量</div><div className="stat-value">{moduleCount}</div></div>
        <div className="stat-card card-c"><div className="stat-label">项目总数</div><div className="stat-value">{stats.total_projects}</div></div>
        <div className="stat-card card-d"><div className="stat-label">进行中项目</div><div className="stat-value">{stats.active_projects}</div></div>
        <div className="stat-card card-e"><div className="stat-label">竞品数量</div><div className="stat-value">{stats.total_competitors}</div></div>
      </div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <div className="content-card">
            <div className="card-header"><h3><span className="emoji">📊</span> 器件分类分布</h3></div>
            <ReactECharts option={pieOption} style={{ height: 280 }} />
          </div>
        </Col>
        <Col span={8}>
          <div className="content-card">
            <div className="card-header"><h3><span className="emoji">📈</span> 项目成本趋势</h3></div>
            <ReactECharts option={trendOption} style={{ height: 280 }} />
          </div>
        </Col>
        <Col span={8}>
          <div className="content-card">
            <div className="card-header"><h3><span className="emoji">🎯</span> 竞品对比雷达</h3></div>
            <ReactECharts option={radarOption} style={{ height: 280 }} />
          </div>
        </Col>
      </Row>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="content-card">
          <div className="card-header"><h3><span className="emoji">📊</span> 各项目BOM成本</h3></div>
          <ReactECharts option={projBarOption} style={{ height: 320 }} />
        </div>
        <div className="content-card">
          <div className="card-header"><h3><span className="emoji">🏭</span> 竞品BOM成本</h3></div>
          <ReactECharts option={compBarOption} style={{ height: 320 }} />
        </div>
      </div>
    </div>
  );
}