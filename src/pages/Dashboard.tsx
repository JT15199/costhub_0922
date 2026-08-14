import { useEffect, useState } from 'react';
import { Spin, Tag, Badge } from 'antd';
import { BarChartOutlined, ShopOutlined, AimOutlined, BulbOutlined, AlertOutlined, RobotOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../echartsSetup';
import { getDashboardStats, getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs, getTargets, getProjectCostSnapshots, getInsights } from '../db';
import { getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';
import type { DashboardStats } from '../types';
import { CHART_COLORS, chartTooltip, chartAxisStyle, chartGrid, chartTextMuted, barGradient } from '../chartTheme';
import { computeTargetStatuses, summarizeTargets, detectSnapshotChanges, type TargetStatus } from '../targetInsight';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

// 直达项目页并选中项目
function goProject(onNavigate: ((key: string) => void) | undefined, pid: number) {
  onNavigate?.('projects');
  window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid } }));
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>('');
  const [projCosts, setProjCosts] = useState<{ name: string; cost: number }[]>([]);
  const [compCosts, setCompCosts] = useState<{ name: string; cost: number }[]>([]);
  // 驾驶舱数据
  const [targetStatuses, setTargetStatuses] = useState<TargetStatus[]>([]);
  const [snapshotChanges, setSnapshotChanges] = useState<{ projectId: number; oldCost: number; newCost: number; pct: number; reason: string; at: string }[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const s = await getDashboardStats();
        setStats(s);
        const [projs, comps, insights] = await Promise.all([getProjects(), getCompetitors(), getInsights()]);
        setProjects(projs);
        setInsights(insights);
        const [allProjBoms, allCompBoms, targetsByP, snapsByP] = await Promise.all([
          Promise.all(projs.map((p: any) => getProjectBOMs(p.id))),
          Promise.all(comps.map((c: any) => getCompetitorBOMs(c.id))),
          Promise.all(projs.map((p: any) => getTargets(p.id))),
          Promise.all(projs.map((p: any) => getProjectCostSnapshots(p.id))),
        ]);
        // 目标达成
        const bomsByP: Record<number, any[]> = {};
        const tByP: Record<number, any[]> = {};
        const sByP: Record<number, any[]> = {};
        projs.forEach((p: any, i: number) => { bomsByP[p.id] = allProjBoms[i]; tByP[p.id] = targetsByP[i]; sByP[p.id] = snapsByP[i]; });
        setTargetStatuses(computeTargetStatuses(projs, tByP, bomsByP));
        setSnapshotChanges(detectSnapshotChanges(sByP));
        // 图表
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
      <div className="page-title"><BarChartOutlined /> 驾驶舱</div>
      {loadError && (
        <div style={{ marginTop: 16, padding: 16, background: '#FFF1F2', borderRadius: 8, color: '#DC2626', fontSize: 13 }}>
          <strong>加载失败，错误信息：</strong><br />{loadError}
        </div>
      )}
      {!loadError && <div style={{ marginTop: 16, color: '#64748B' }}>暂无数据，请先添加器件或项目。</div>}
    </div>
  );

  const missed = targetStatuses.filter(t => t.missed);
  const summary = summarizeTargets(targetStatuses, projects);
  const unreadInsights = insights.filter((i: any) => i.status === 'unread');
  const parseInsightRows = (i: any): any[] => {
    try { const arr = JSON.parse(i.insight_json || '[]'); return Array.isArray(arr) ? arr : []; } catch { return []; }
  };

  // 未达标领域（按差额排序，最严重在前）
  const missedSorted = [...missed].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

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
      <div className="page-title"><BarChartOutlined /> 驾驶舱</div>

      {/* ===== ① 目标成本达成（最显眼） ===== */}
      <div className="content-card" style={{ marginBottom: 16, border: missedSorted.length > 0 ? '1.5px solid #FF4D4F' : '1px solid #E2E8F0', background: missedSorted.length > 0 ? 'linear-gradient(180deg, #FFF7F7 0%, #FFFFFF 100%)' : undefined }}>
        <div className="card-header">
          <h3><AimOutlined style={{ color: '#CF0A2C' }} /> 目标成本达成</h3>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            {missedSorted.length > 0
              ? <Tag color="red">未达标 {summary.missedProjects} 个项目 / {summary.missedDomains} 个领域</Tag>
              : <Tag color="green">全部达标</Tag>}
            {summary.targetedProjects > 0 && <Tag style={{ marginLeft: 6 }}>{summary.targetedProjects} 个项目已设目标</Tag>}
          </span>
        </div>

        {missedSorted.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {missedSorted.map(t => (
              <div key={`${t.projectId}-${t.domain}`} onClick={() => goProject(onNavigate, t.projectId)}
                style={{ border: '1px solid #FECACA', background: '#FFF5F5', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', transition: 'box-shadow 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(239,68,68,0.15)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <b style={{ fontSize: 14, color: '#DC2626' }}>{t.code}</b>
                  <Tag color={getCategoryColor(t.domain)} style={{ margin: 0 }}>{t.domain}</Tag>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#DC2626', fontWeight: 600 }}>达成率 {t.rate}%</span>
                </div>
                <div style={{ fontSize: 12.5, color: '#374151', display: 'flex', justifyContent: 'space-between' }}>
                  <span>目标 <b style={{ color: '#2563EB' }}>¥{t.target.toFixed(2)}</b></span>
                  <span>实际 <b style={{ color: '#DC2626' }}>¥{t.actual.toFixed(2)}</b></span>
                  <span style={{ color: '#EF4444', fontWeight: 600 }}>超 ¥{t.diff.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '6px 2px', fontSize: 13, color: '#10B981' }}>
            {summary.targetedProjects > 0 ? '✓ 所有已设目标的领域均达成（实际 ≤ 目标）' : '尚未设定目标成本'}
          </div>
        )}

        {summary.untargetedProjects > 0 && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#FFF7E6', border: '1px solid #FFE7BA', borderRadius: 8, fontSize: 12.5, color: '#B45309', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertOutlined />
            <span>{summary.untargetedProjects} 个项目尚未设定目标成本（在研项目建议先在「项目管理 → 成本分析」设定领域目标，驾驶舱才会预警）</span>
            <span style={{ marginLeft: 'auto' }}><a onClick={() => onNavigate?.('projects')}>前往设定 →</a></span>
          </div>
        )}
      </div>

      {/* ===== ② AI 今日洞察 ===== */}
      <div className="content-card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3><RobotOutlined style={{ color: '#0A84FF' }} /> AI 今日洞察</h3>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            {unreadInsights.length > 0 && <Badge count={unreadInsights.length} size="small" style={{ marginRight: 6 }} />}
            {snapshotChanges.length > 0 && <Tag color="orange">{snapshotChanges.length} 条成本异动</Tag>}
          </span>
        </div>

        {(unreadInsights.length > 0 || snapshotChanges.length > 0) ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10 }}>
            {/* 报价情报 */}
            {unreadInsights.map((i: any) => {
              const rows = parseInsightRows(i);
              if (rows.length === 0) return null;
              return rows.map((r: any, idx: number) => (
                <div key={`ins-${i.id}-${idx}`} onClick={() => { onNavigate?.('projects'); window.dispatchEvent(new CustomEvent('costhub-open-insights')); }}
                  style={{ border: '1px solid #BFDBFE', background: '#F0F7FF', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', transition: 'box-shadow 0.2s' }}
                  onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(10,132,255,0.15)'; }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <BulbOutlined style={{ color: '#D97706' }} />
                    <b style={{ fontSize: 13, color: '#1E40AF' }}>{r.type === 'ai' ? 'AI 疑似同物料' : '同名同型号价差'}</b>
                    <span style={{ fontSize: 12, color: '#64748B' }}>「{i.module_name}」</span>
                    <Tag color="orange" style={{ marginLeft: 'auto' }}>价差 ¥{r.diff?.toFixed?.(2) ?? r.diff}</Tag>
                  </div>
                  <div style={{ fontSize: 12, color: '#374151' }}>{r.name} · {r.rows?.length ?? 0} 个项目报价不一致</div>
                </div>
              ));
            })}
            {/* 成本快照异动 */}
            {snapshotChanges.map((c, idx) => {
              const p = projects.find((x: any) => x.id === c.projectId);
              return (
                <div key={`snap-${c.projectId}-${idx}`} onClick={() => goProject(onNavigate, c.projectId)}
                  style={{ border: c.pct > 0 ? '1px solid #FECACA' : '1px solid #A7F3D0', background: c.pct > 0 ? '#FFFBF5' : '#F3FEF8', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', transition: 'box-shadow 0.2s' }}
                  onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(16,185,129,0.12)'; }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <b style={{ fontSize: 13, color: '#1F2937' }}>{p?.code || c.projectId}</b>
                    <span style={{ fontSize: 12, color: c.pct > 0 ? '#DC2626' : '#059669', fontWeight: 600 }}>
                      {c.pct > 0 ? '▲' : '▼'} {Math.abs(c.pct)}%
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94A3B8' }}>¥{c.oldCost.toFixed(2)} → ¥{c.newCost.toFixed(2)}</span>
                  </div>
                  {c.reason && <div style={{ fontSize: 12, color: '#6B7280' }}>原因：{c.reason}</div>}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: '6px 2px', fontSize: 13, color: '#94A3B8' }}>
            今日暂无异常情报。报价差异、成本异动会自动扫描，有发现会在这里提醒。
          </div>
        )}
      </div>

      {/* ===== ③ 统计卡（导航入口） ===== */}
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
