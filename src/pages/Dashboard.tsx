import { openInsightCenter } from '../insightNavigation';
import { useEffect, useState } from 'react';
import './Dashboard.css';
import { Spin, Tag, Button, message, Empty, Modal, Input, Table, Select } from 'antd';
import { BarChartOutlined, ShopOutlined, AimOutlined, BulbOutlined, AlertOutlined, RobotOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { getDashboardStats, getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs, getTargets, getProjectCostSnapshots, getInsights, getSetting, getProjectAnalysis, getProductionCostSavings, getProductionSavingYears } from '../db';
import { getCategoryColor } from '../constants';
import { EmojiIcon } from '../iconMap';
import DataTable from '../components/DataTable';
import type { DashboardStats, ProductionCostSaving } from '../types';
import { chartTooltip, chartAxisStyle, chartGrid, chartTextMuted, barGradient } from '../chartTheme';
import { computeTargetStatuses, summarizeTargets, detectSnapshotChanges, type TargetStatus } from '../targetInsight';
import { getAuditFindings, getRecentPartPriceChanges } from '../auditStore';
import { getAdvisorInsights } from '../db/advisor';
import { getDailyCloudUsage } from '../db/settings';
import { bomPriceState, bomQuantityState, sumBomCostStrict } from '../ai/contracts';
import { runAutoAudit } from '../autoAudit';
import AIStatusBar from '../components/AIStatusBar';
import DailyBrief from '../components/DailyBrief';
import AutoThinkPanel from '../components/AutoThinkPanel';
import GoalsCard from '../components/GoalsCard';
import KeyMaterialInsights from '../components/KeyMaterialInsights';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

// 直达项目页并选中项目
function goProject(onNavigate: ((key: string) => void) | undefined, pid: number) {
  onNavigate?.('projects');
  window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid } }));
}
// 打开 AI 情报中心（项目页弹窗：报价差异/自主建议/巡检发现 统一处理，2026-08-17）
function openAiCenter(onNavigate: ((key: string) => void) | undefined) {
  openInsightCenter(onNavigate, 'diff');
}

interface DashboardRedesignProps {
  costHistory?: Record<number, any[]>;
  stats: DashboardStats;
  projects: any[];
  productionSavings: ProductionCostSaving[];
  productionTarget: number;
  savingYear?: number;
  savingYears?: number[];
  savingsLoading?: boolean;
  onSavingYearChange?: (year: number) => void;
  projCosts: { name: string; cost: number | null; costStatus?: string; projectId?: number }[];
  snapshotChanges: { projectId: number; oldCost: number; newCost: number; pct: number; reason: string; at: string }[];
  missedByProject: { projectId: number; code: string; domains: string[]; worstDomain: string; worstRate: number }[];
  targetedProjectIds: number[];
  unknownTargetCount: number;
  unreadInsights: any[];
  recentPriceChanges: any[];
  advisorInsights: any[];
  cloudUsage: { count: number; tokens: number };
  cloudLimit: number;
  onNavigate?: (key: string) => void;
  onRunAudit: () => void;
  auditRunning: boolean;
  auditCount: number;
}

function DashboardRedesign({
  costHistory = {}, stats, projects, productionSavings, productionTarget, projCosts, snapshotChanges, missedByProject, targetedProjectIds, unknownTargetCount,
  unreadInsights, recentPriceChanges, advisorInsights, cloudUsage, cloudLimit,
  onNavigate, onRunAudit, auditRunning, auditCount, savingYear = new Date().getFullYear(), savingYears = [new Date().getFullYear()], savingsLoading = false, onSavingYearChange,
}: DashboardRedesignProps) {
  const [savingsOpen, setSavingsOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [costSearch, setCostSearch] = useState('');
  const [costCategory, setCostCategory] = useState<string>();
  const [historyProject, setHistoryProject] = useState<any>(null);
  const overviewRows = projects.map(project => {
    const bom = projCosts.find(row => row.projectId === project.id)?.cost ?? null;
    const rate = Number(project.platform_fee_rate ?? 0);
    return { ...project, category: project.category || '未分类', bom, rate: Number.isFinite(rate) && rate >= 0 ? rate : null,
      total: bom != null && Number.isFinite(rate) && rate >= 0 ? bom * (1 + rate / 100) : null };
  });
  const shownCosts = overviewRows.filter(row => (!costCategory || row.category === costCategory) && `${row.code} ${row.name} ${row.category || ''}`.toLowerCase().includes(costSearch.trim().toLowerCase()));
  const money = (value: number | null) => value == null ? '待补充' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const [compactPanel, setCompactPanel] = useState('projects');
  const projectById = new Map(projects.map(p => [p.id, p]));
  const projectOrder = [...projects]
    .sort((a, b) => Number(b.status === '进行中') - Number(a.status === '进行中'))
    .slice(0, 5);
  const recentSavings = snapshotChanges.reduce((sum, item) => sum + Math.max(0, item.oldCost - item.newCost), 0);
  // 项目之间是类别比较，不使用会暗示时间连续性的曲线；改用排序式成本分布展示项目层级。
  const costRows = [...projCosts].filter(row => row.cost != null && Number.isFinite(row.cost)).sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const [costPage, setCostPage] = useState(0);
  const costPages = Math.max(1, Math.ceil(costRows.length / 6));
  const currentCostPage = Math.min(costPage, costPages - 1);
  const visibleCosts = costRows.slice(currentCostPage * 6, currentCostPage * 6 + 6);
  const maxCost = costRows[0]?.cost || 1;
  const tasks: { label: string; action: string; onClick: () => void }[] = [];
  missedByProject.slice(0, 2).forEach(item => tasks.push({
    label: `复核 ${item.code} 的${item.worstDomain || '目标成本'}偏差`, action: '查看项目 →', onClick: () => goProject(onNavigate, item.projectId),
  }));
  const firstInsight = unreadInsights[0];
  if (firstInsight) tasks.push({
    label: `确认报价差异：${firstInsight.module_name || '待审模块'}`, action: '打开情报 →', onClick: () => openAiCenter(onNavigate),
  });
  const visibleTasks = tasks.slice(0, 3);
  const firstOpportunity = recentPriceChanges
    .map(item => ({ name: item.name || item.model || '物料', amount: Number(item.old_cost || 0) - Number(item.new_cost || 0) }))
    .filter(item => item.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0];
  const aiSavingText = recentSavings > 0 ? `近期已确认降本 ¥${recentSavings.toFixed(0)}` : (firstOpportunity ? `可争取降本 ¥${firstOpportunity.amount.toFixed(0)}` : '等待新的报价机会');
  const aiSavingHint = firstInsight?.module_name ? `${firstInsight.module_name} 存在跨供应商比价机会` : '导入报价后，AI 会自动识别可比关系与异常价差';
  // 将“议价机会”变成可行动的决策抓手：优先显示尚未处理的报价差异，其次显示已确认的降本记录。
  const decisionItems = (() => {
    const insightItems = unreadInsights.flatMap((insight: any) => {
      let rows: any[] = [];
      try { const parsed = JSON.parse(insight.insight_json || '[]'); rows = Array.isArray(parsed) ? parsed : []; } catch { rows = []; }
      return rows.map((row: any) => ({
        title: row.name || row.model || insight.module_name || '待审物料',
        detail: `${insight.module_name || '报价模块'} · ${Array.isArray(row.rows) ? row.rows.length : 0} 条报价`,
        amount: Number(row.diff || row.delta || row.amount || 0),
        action: '打开情报 →',
        onClick: () => openAiCenter(onNavigate),
      }));
    }).filter((item: any) => item.amount > 0);
    if (insightItems.length > 0) return insightItems.sort((a: any, b: any) => b.amount - a.amount).slice(0, 3);
    return recentPriceChanges
      .map((item: any) => ({
        title: item.name || item.model || '已降本物料',
        detail: '历史报价已确认下降 · 可作为供应商谈价锚点',
        amount: Number(item.old_cost || 0) - Number(item.new_cost || 0),
        action: '查看器件 →',
        onClick: () => onNavigate?.('parts'),
      }))
      .filter((item: any) => item.amount > 0)
      .sort((a: any, b: any) => b.amount - a.amount)
      .slice(0, 3);
  })();

  const annualBenefit = productionSavings.reduce((sum, row) => sum + Number(row.annual_benefit || row.unit_saving * row.annual_shipments || 0), 0);
  const totalShipments = productionSavings.reduce((sum, row) => sum + Number(row.annual_shipments || 0), 0);
  const targetRate = productionTarget > 0 ? Math.max(0, Math.min(100, annualBenefit / productionTarget * 100)) : 0;
  const remainingTarget = Math.max(0, productionTarget - annualBenefit);
  const coveredProjects = new Set(productionSavings.map(row => row.project_id || row.project_code || row.project_name).filter(Boolean)).size;
  const moduleTotals = new Map<string, number>();
  productionSavings.forEach(row => {
    const module = String(row.module_name || '其他模块').trim() || '其他模块';
    const benefit = Number(row.annual_benefit || row.unit_saving * row.annual_shipments || 0);
    if (benefit > 0) moduleTotals.set(module, (moduleTotals.get(module) || 0) + benefit);
  });
  const sortedModules = [...moduleTotals.entries()].sort((a, b) => b[1] - a[1]);
  const moduleRows = sortedModules.length > 5
    ? [...sortedModules.slice(0, 4), ['其他模块', sortedModules.slice(4).reduce((sum, [, value]) => sum + value, 0)] as [string, number]]
    : sortedModules;
  const moduleTotal = moduleRows.reduce((sum, [, value]) => sum + value, 0);
  let moduleCursor = 0;
  const moduleColors = ['#2f7df6', '#61a1ef', '#2fc4c3', '#a7bad2', '#8299b8'];


  return (
    <div className="dashboard-redesign" data-panel={compactPanel}>
      <div className="dashboard-head">
        <div>
          <h1><BarChartOutlined /> 今日工作台</h1>
        </div>
        <div className="dashboard-head-actions">
          <Button aria-label="成本总览" icon={<BarChartOutlined />} onClick={() => setOverviewOpen(true)}>成本总览</Button>
          <Button className="dashboard-audit-entry" onClick={() => openInsightCenter(onNavigate, 'audit')}>巡检发现 <b>{auditCount}</b> →</Button>
          <Button className="dashboard-advice-entry" onClick={() => openInsightCenter(onNavigate, 'advice')}>自主建议 <b>{advisorInsights.length}</b> →</Button>
          <Button type="primary" className="dashboard-primary-action" onClick={onRunAudit} loading={auditRunning} icon={<RobotOutlined />}>开始分析</Button>
        </div>
      </div>

      <Modal title="项目成本总览" open={overviewOpen} onCancel={() => setOverviewOpen(false)} footer={null} width={1120} className="cost-overview-modal">
        <div className="cost-overview-summary"><span>项目 <b>{shownCosts.length}</b> / {overviewRows.length}</span><span>成本完整 <b>{shownCosts.filter(row => row.total != null).length}</b></span><span>待补充 <b>{shownCosts.filter(row => row.total == null).length}</b></span><Select aria-label="筛选项目类别" placeholder="全部类别" allowClear value={costCategory} onChange={setCostCategory} options={[...new Set(overviewRows.map(row => row.category))].sort().map(value => ({label:value, value}))} /><Input className="cost-overview-search" aria-label="搜索成本总览" placeholder="搜索项目代号、名称或品类" allowClear value={costSearch} onChange={e => setCostSearch(e.target.value)} /></div>
        <p className="cost-overview-note">人民币 / 台 · 带费率成本 = BOM × (1 + 平台费率)，不含利润/管销研费率；缺报价或数量显示待补充。</p>
        <Table size="small" rowKey="id" dataSource={shownCosts} pagination={{ defaultPageSize: 20, showSizeChanger: true, showTotal: total => `共 ${total} 个项目` }} scroll={{ x: 930, y: '60vh' }} columns={[
          { title: '项目', key: 'project', width: 280, render: (_, row) => <button type="button" className="cost-overview-project" title={`${row.code} · ${row.name}`} onClick={() => { setOverviewOpen(false); goProject(onNavigate, row.id); }}><strong>{row.code || '未命名项目'}</strong><small>{row.name}</small></button> },
          { title: '类别', dataIndex: 'category', width: 95, sorter: (a, b) => a.category.localeCompare(b.category, 'zh-CN') },
          { title: '状态', dataIndex: 'status', width: 100, filters: [...new Set(projects.map(p => p.status).filter(Boolean))].map(value => ({ text: value, value })), onFilter: (value, row) => row.status === value },
          { title: 'BOM 成本', dataIndex: 'bom', width: 150, align: 'right', render: money, sorter: (a, b) => (a.bom ?? -1) - (b.bom ?? -1) },
          { title: '平台费率', dataIndex: 'rate', width: 110, align: 'right', render: value => value == null ? '待补充' : `${value}%` },
          { title: '带费率成本', dataIndex: 'total', width: 160, align: 'right', render: value => <strong className={value == null ? '' : 'cost-overview-total'}>{money(value)}</strong>, sorter: (a, b) => (a.total ?? -1) - (b.total ?? -1) },
          { title: '历史', key: 'history', width: 95, render: (_, row) => <button type="button" className="cost-history-link" onClick={() => setHistoryProject(row)}>成本历史</button> },
        ]} />
      </Modal>

      <Modal title={`${historyProject?.code || historyProject?.name || ''} · 成本历史`} open={!!historyProject} onCancel={() => setHistoryProject(null)} footer={null} width={920} className="cost-overview-modal">
        <p className="cost-overview-note">按保存时间倒序，金额及费率沿用当时记录；旧记录的总成本可能包含历史利润口径，未重新计算。</p>
        <Table size="small" rowKey="id" dataSource={costHistory[historyProject?.id] || []} locale={{emptyText:'暂无成本历史，项目保存成本快照后会显示在这里'}} pagination={{defaultPageSize:15}} scroll={{x:780,y:'55vh'}} columns={[
          {title:'记录时间',dataIndex:'created_at',width:165},
          {title:'BOM 成本',dataIndex:'bom_cost',width:125,align:'right',render:(value,row)=>money(row.cost_status === 'unknown' || value == null || !Number.isFinite(Number(value)) ? null : Number(value))},
          {title:'当时总成本',dataIndex:'total_cost',width:125,align:'right',render:(value,row)=>money(row.cost_status === 'unknown' || value == null || !Number.isFinite(Number(value)) ? null : Number(value))},
          {title:'平台费率',dataIndex:'platform_fee_rate',width:85,render:value=>value == null ? '—' : `${value}%`},
          {title:'历史利润率',dataIndex:'profit_rate',width:95,render:value=>value == null ? '—' : `${value}%`},
          {title:'变更说明',key:'reason',width:260,render:(_,row)=>row.change_details || row.change_reason || row.stage || '成本记录'},
        ]}/>
      </Modal>

      <section className="dashboard-metrics">
        <button className="dashboard-metric" onClick={() => onNavigate?.('projects')}><span>进行中项目</span><strong>{stats.active_projects}</strong><em>{projects.length} 个项目总计</em></button>
        <button className={`dashboard-metric ${missedByProject.length > 0 ? 'is-risk' : unknownTargetCount > 0 ? '' : 'is-good'}`} onClick={() => onNavigate?.('projects')}><span>目标风险</span><strong>{missedByProject.length}</strong><em>{missedByProject.length > 0 ? '需要今天处理' : unknownTargetCount > 0 ? `${unknownTargetCount} 个领域待补证据` : targetedProjectIds.length === 0 ? '目标待确认' : '全部达标'}</em></button>
        <button className="dashboard-metric" onClick={() => openAiCenter(onNavigate)}><span>待审报价</span><strong>{unreadInsights.length}</strong><em>{unreadInsights.length > 0 ? '来自报价情报' : '暂无待审差异'}</em></button>
        <div className="dashboard-metric is-good"><span>近期降本</span><strong>¥{recentSavings.toFixed(0)}</strong><em>{snapshotChanges.length > 0 ? `${snapshotChanges.length} 条成本变动` : '等待数据积累'}</em></div>
      </section>

      <div className="dashboard-compact-tabs" role="group" aria-label="工作台内容">{[['projects', '项目进展'], ['todo', '优先处理'], ['cost', '成本分布'], ['opportunities', '报价决策']].map(([key, label]) => <button type="button" key={key} aria-pressed={compactPanel === key} onClick={() => setCompactPanel(key)}>{label}</button>)}</div>
      <div className="dashboard-layout">
        <section className="dashboard-panel dashboard-production-board">
          <div className="dashboard-production-head">
            <div>
              <span className="dashboard-kicker">ANNUAL COST REALIZATION / {savingYear}</span>
              <div className="dashboard-production-title-line"><h2>年度量产成本收益</h2>{productionSavings.length > 0 && <Tag>按录入数据测算</Tag>}</div>
              <p>按单台降本与年度发货量测算规模化收益</p>
            </div>
            <select className="dashboard-production-year" aria-label="收益年份" value={savingYear} onChange={event => onSavingYearChange?.(Number(event.target.value))}>{savingYears.map(year => <option key={year} value={year}>{year} 年</option>)}</select>
          </div>
          <div className="dashboard-production-main">
            <div className="dashboard-production-summary">
              <span className="dashboard-production-label">年度测算收益</span>
              <strong className="dashboard-production-benefit" aria-busy={savingsLoading}>¥{annualBenefit.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</strong>
              <span className="dashboard-production-target-copy">全年目标 {productionTarget > 0 ? '¥' + productionTarget.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '未设定'}</span>
              <div className="dashboard-production-progress" role="progressbar" aria-label="年度成本收益达成率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(targetRate)}><i style={{ width: targetRate + '%' }} /></div>
              <div className="dashboard-production-rate"><span>达成率</span><b>{productionTarget > 0 ? targetRate.toFixed(1) + '%' : '—'}</b></div>
              <div className="dashboard-production-stats">
                <div><span>距离目标</span><strong>{productionTarget > 0 ? '¥' + remainingTarget.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '—'}</strong></div>
                <div><span>覆盖项目</span><strong>{coveredProjects}<small> 个</small></strong></div>
              </div>
            </div>
            <div className="dashboard-production-modules">
              <div className="dashboard-production-module-head"><h3>降本贡献 · 按模块</h3><span>{totalShipments > 0 ? '发货 ' + totalShipments.toLocaleString('zh-CN') + ' 台' : '暂无发货量'}</span></div>
              <div className="dashboard-production-module-content">
                <div className="dashboard-production-donut" aria-label={moduleRows.length ? '按模块统计降本贡献' : '暂无模块贡献数据'}>
                  <svg className="module-ring" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="76" fill="none" stroke="#dbe6f1" strokeWidth="24" />{moduleRows.map(([name, value], index) => { const fraction = value / moduleTotal; const offset = moduleCursor; moduleCursor += fraction * 100; return <circle key={name} cx="100" cy="100" r="76" pathLength="100" fill="none" stroke={moduleColors[index % moduleColors.length]} strokeWidth="24" strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`} strokeDashoffset={-offset} transform="rotate(-90 100 100)"><title>{name}：¥{value.toLocaleString('zh-CN')}</title></circle>; })}</svg>
                  <div><strong>模块贡献</strong><span>{moduleRows.length ? '¥' + moduleTotal.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '暂无数据'}</span></div>
                </div>
                <div className="dashboard-production-legend">
                  {moduleRows.length ? moduleRows.map(([name, value], index) => <button type="button" key={name} onClick={() => onNavigate?.('projects')}><i style={{ background: moduleColors[index % moduleColors.length] }} /><span>{name}</span><b>{Math.round(value / moduleTotal * 100)}%</b></button>) : <span className="dashboard-production-empty">在手账录入关键成本后显示模块贡献</span>}
                </div>
              </div>
            </div>
          </div>
          <button type="button" className="dashboard-production-details" disabled={savingsLoading} onClick={() => setSavingsOpen(true)}><span>{savingsLoading ? '正在读取年度数据…' : '查看项目明细'}<small>{productionSavings.length} 条记录</small></span><span aria-hidden="true">↗</span></button>
          <Modal title={`${savingYear} 年降本项目明细`} open={savingsOpen} onCancel={() => setSavingsOpen(false)} footer={null} width={760} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }}>
            {productionSavings.length ? <div className="dashboard-production-table">{productionSavings.map(row => { const benefit = Number(row.annual_benefit || row.unit_saving * row.annual_shipments || 0); const canOpen = Number(row.project_id) > 0; const width = Math.max(8, Math.min(100, benefit / Math.max(1, annualBenefit) * 100)); return <div className="dashboard-production-row" key={row.id}><button type="button" disabled={!canOpen} onClick={() => { if (canOpen) { setSavingsOpen(false); goProject(onNavigate, Number(row.project_id)); } }}><strong>{row.project_code || row.project_name || '手写项目'}</strong><small>{row.project_name || '未命名项目'} · {row.part_name || '项目器件'} · ¥{Number(row.unit_saving || 0).toFixed(2)}/台</small></button><span className="dashboard-production-rail"><i style={{ width: width + '%' }} /></span><b>¥{benefit.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b></div>; })}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请在手账的关键成本进展中录入" />}
          </Modal>
        </section>
        <section className="dashboard-panel dashboard-projects">
          <div className="dashboard-panel-head"><h2>招标项目进展</h2><span>进行中优先</span><a onClick={() => onNavigate?.('projects')}>查看全部 →</a></div>
          {projectOrder.length === 0 ? <div className="dashboard-empty">还没有项目，先创建一个项目开始成本管理。</div> : projectOrder.map((project) => {
            const risk = missedByProject.find(item => item.projectId === project.id);
            const costRow = projCosts.find(item => item.projectId === project.id);
            const cost = costRow?.cost;
            const phase = project.status === '已完成' ? '已完成' : costRow?.costStatus === 'unknown' ? '待补证据' : risk ? '目标风险' : (project.stage || project.status || '进行中');
            const hasTarget = targetedProjectIds.includes(Number(project.id));
            const deviation = risk ? `-${Math.max(0, 100 - risk.worstRate).toFixed(1)}%` : costRow?.costStatus === 'unknown' ? '待补证据' : hasTarget ? '达标' : '目标待确认';
            return <button className="dashboard-project-row" key={project.id} onClick={() => goProject(onNavigate, project.id)}>
              <span className="dashboard-project-name"><strong>{project.code || '未命名项目'}　{project.name || ''}</strong><small>{cost != null ? `当前 BOM ¥${cost.toFixed(0)}` : '下一步：补充报价与目标成本'}</small></span>
              <span className={`dashboard-phase ${risk ? 'phase-active' : phase === '已完成' ? 'phase-done' : ''}`}>{phase}</span>
              <span className={`dashboard-deviation ${risk ? 'is-risk' : costRow?.costStatus === 'unknown' ? '' : 'is-good'}`}>{deviation}</span>
              <span className="dashboard-progress"><i style={{ width: project.status === '已完成' ? '100%' : '0%' }} /></span>
            </button>;
          })}
        </section>

        <section className="dashboard-panel dashboard-todo">
          <div className="dashboard-panel-head"><h2>今日优先处理</h2><span>{visibleTasks.length} 项</span></div>
          {visibleTasks.map((task, index) => <div className="dashboard-task" key={`${task.label}-${index}`}><span className="dashboard-task-num">{index + 1}</span><div><strong>{task.label}</strong><button onClick={task.onClick}>{task.action}</button></div></div>)}
          {visibleTasks.length === 0 && <div className="dashboard-empty compact">暂无需要今天确认的事项，工作台保持安静。</div>}
          <div className="dashboard-ai-note"><small>AI 发现的可执行机会</small><strong>{aiSavingText}</strong><p>{aiSavingHint}</p></div>
        </section>

        <section className="dashboard-panel dashboard-cost-distribution"><div className="dashboard-panel-head"><div><h2>项目成本分布</h2><span>共 {costRows.length} 个项目 · 单台 BOM 成本，人民币</span></div><div className="cost-page-controls">{costPages > 1 && <><button type="button" aria-label="上一组项目成本" disabled={currentCostPage === 0} onClick={() => setCostPage(currentCostPage - 1)}>‹</button><span>{currentCostPage + 1}/{costPages}</span><button type="button" aria-label="下一组项目成本" disabled={currentCostPage === costPages - 1} onClick={() => setCostPage(currentCostPage + 1)}>›</button></>}<a onClick={() => onNavigate?.('compare')}>查看明细 →</a></div></div>{costRows.length > 0 ? <><div className="chart-bars" style={{ gridTemplateColumns: `repeat(${visibleCosts.length}, minmax(0, 1fr))` }} role="group" aria-label="项目 BOM 成本分布图，点击柱体查看项目">{visibleCosts.map(row => { const openProject = () => row.projectId ? goProject(onNavigate, row.projectId) : onNavigate?.('compare'); return <button type="button" className="chart-bar" key={row.name} style={{ '--h': `${Math.max(4, ((row.cost || 0) / maxCost) * 100)}%` } as React.CSSProperties} onClick={openProject} aria-label={`${row.name} BOM成本 ¥${(row.cost || 0).toFixed(2)}`}><b>¥{(row.cost || 0).toFixed(0)}</b></button>; })}</div><div className="chart-labels" style={{ gridTemplateColumns: `repeat(${visibleCosts.length}, minmax(0, 1fr))` }}>{visibleCosts.map(row => <button type="button" key={row.name} onClick={() => row.projectId ? goProject(onNavigate, row.projectId) : onNavigate?.('compare')} aria-label={`打开项目 ${row.name}`}>{row.name}</button>)}</div></> : <div className="dashboard-empty">积累项目报价后，这里会出现项目成本分布。</div>}</section>

        <section className="dashboard-panel dashboard-opportunities"><div className="dashboard-panel-head"><h2>报价决策抓手</h2><span>按价差与影响范围</span><a onClick={() => openAiCenter(onNavigate)}>查看情报 →</a></div>{decisionItems.length > 0 ? <div className="dashboard-decision-list">{decisionItems.map((item: any, index: number) => <div className="dashboard-decision-item" key={`${item.title}-${index}`}><span className="dashboard-decision-rank">{String(index + 1).padStart(2, '0')}</span><div className="dashboard-decision-copy"><strong>{item.title}</strong><small>{item.detail}</small></div><span className="dashboard-decision-amount">¥{item.amount.toFixed(0)}</span><button className="dashboard-decision-action" onClick={item.onClick}>{item.action}</button></div>)}</div> : <div className="dashboard-empty compact">暂无待决报价差异，导入新报价后这里会给出谈价抓手。</div>}</section>
      </div>

      <div className="dashboard-activity"><strong>最近动态</strong><span className="dashboard-activity-dot" />{snapshotChanges[0] ? `${projectById.get(snapshotChanges[0].projectId)?.code || '项目'} 成本 ${snapshotChanges[0].pct > 0 ? '上升' : '下降'} ${Math.abs(snapshotChanges[0].pct)}%` : '数据会在导入报价、改价或 AI 识别后自动汇总'}<time>刚刚</time></div>
      <div className="dashboard-security-note"><span>●</span> 本地数据受控 · 云端分析需脱敏并经过审批 · 云端今日 {cloudUsage.count}/{cloudLimit}</div>
      {advisorInsights.length > 0 && <span className="dashboard-advisor-hint" aria-hidden="true">AI 建议 {advisorInsights.length}</span>}
    </div>
  );
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const [costHistory, setCostHistory] = useState<Record<number, any[]>>({});
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>('');
  const [projCosts, setProjCosts] = useState<{ name: string; cost: number | null; costStatus?: string; projectId?: number }[]>([]);
  const [compCosts, setCompCosts] = useState<{ name: string; cost: number | null }[]>([]);
  // 驾驶舱数据
  const [targetStatuses, setTargetStatuses] = useState<TargetStatus[]>([]);
  const [snapshotChanges, setSnapshotChanges] = useState<{ projectId: number; oldCost: number; newCost: number; pct: number; reason: string; at: string }[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [productionSavings, setProductionSavings] = useState<ProductionCostSaving[]>([]);
  const [productionTarget, setProductionTarget] = useState(0);
  const [savingYear, setSavingYear] = useState(new Date().getFullYear());
  const [savingYears, setSavingYears] = useState([new Date().getFullYear()]);
  const [savingsLoading, setSavingsLoading] = useState(true);
  // AI 自主巡检
  const [auditFindings, setAuditFindings] = useState<any[]>([]);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditLastAt, setAuditLastAt] = useState('');
  const [recentPriceChanges, setRecentPriceChanges] = useState<any[]>([]);
  // 自主建议（autoAdvisor）
  const [advisorInsights, setAdvisorInsights] = useState<any[]>([]);
  // 最近 AI 分析结论（save_project_analysis 写回，驾驶舱展示）
  const [recentAnalysis, setRecentAnalysis] = useState<any[]>([]);
  useEffect(() => { getProjectAnalysis(8).then(setRecentAnalysis).catch(() => {}); }, []);
  useEffect(() => {
    const h = () => { getProjectAnalysis(8).then(setRecentAnalysis).catch(() => {}); };
    window.addEventListener('costhub-project-analysis-updated', h);
    return () => window.removeEventListener('costhub-project-analysis-updated', h);
  }, []);
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      setSavingsLoading(true);
      setProductionSavings([]);
      setProductionTarget(0);
      try {
        const [rows, target, years] = await Promise.all([getProductionCostSavings(savingYear), getSetting(`production_cost_target_${savingYear}`, '0'), getProductionSavingYears()]);
        if (request !== generation) return;
        setProductionSavings(rows);
        setProductionTarget(Number(target) || 0);
        setSavingYears([...new Set([savingYear, new Date().getFullYear(), ...years])].sort((a,b) => b-a));
      } catch { if (request === generation) message.error('年度收益读取失败，请重新选择年份'); }
      finally { if (request === generation) setSavingsLoading(false); }
    };
    void refresh();
    window.addEventListener('costhub-production-saving-updated', refresh);
    window.addEventListener('costhub-production-target-updated', refresh);
    return () => { generation++; window.removeEventListener('costhub-production-saving-updated', refresh); window.removeEventListener('costhub-production-target-updated', refresh); };
  }, [savingYear]);
  // 云端用量（今日请求/阈值）
  const [cloudUsage, setCloudUsage] = useState<{ count: number; tokens: number }>({ count: 0, tokens: 0 });
  const [cloudLimit, setCloudLimit] = useState(50);
  // 折叠控制
  const [costOpen, setCostOpen] = useState(false);
  // 洞察直达：objects 里匹配项目代号 → 项目页；器件名 → 器件库搜索


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
        setCostHistory(sByP);
        // 图表
        const pc = projs.map((p: any, i: number) => ({
          name: p.code || p.name,
          projectId: Number(p.id),
          cost: allProjBoms[i].length > 0 && allProjBoms[i].every((b: any) => bomPriceState(b) === 'confirmed' && bomQuantityState(b) === 'confirmed')
            ? sumBomCostStrict(allProjBoms[i]).total
            : null,
          costStatus: allProjBoms[i].length > 0 && allProjBoms[i].every((b: any) => bomPriceState(b) === 'confirmed' && bomQuantityState(b) === 'confirmed') ? 'confirmed' : 'unknown',
        }));
        setProjCosts(pc);
        const cc = comps.map((c: any, i: number) => { const costState = sumBomCostStrict(allCompBoms[i].map((b: any) => ({ ...b, part_cost: b.estimated_cost }))); return {
          name: `${c.brand} ${c.model}`,
          cost: costState.missing.length ? null : Math.round(costState.total * 100) / 100,
        }; });
        setCompCosts(cc);
        // AI 自主巡检：加载发现列表；无历史发现时自动触发一次（后台，不阻塞）
        try {
          setRecentPriceChanges(await getRecentPartPriceChanges(8));
          const fs2 = await getAuditFindings();
          setAuditFindings(fs2);
          if (fs2.length === 0) refreshAudit(true);
        } catch { /* 忽略 */ }
        // 自主建议（AI 助理后台分析）
        try { setAdvisorInsights(await getAdvisorInsights('open')); } catch { /* 忽略 */ }
        // 云端用量（今日请求/阈值）
        try {
          setCloudUsage(await getDailyCloudUsage());
          setCloudLimit(Math.max(1, Number(await getSetting('ai_usage_cloud_daily_limit', '50')) || 50));
        } catch { /* 忽略 */ }
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error('Dashboard load error:', e);
        setLoadError(msg);
      }
      setLoading(false);
    })();
    const onAdv = () => { getAdvisorInsights('open').then(setAdvisorInsights).catch(() => {}); };
    window.addEventListener('costhub-advisor-done', onAdv);
    // 巡检已读/忽略后刷新列表与计数（2026-08-18：标记已读立即生效，不再残留未读数）
    const onAuditChanged = () => { getAuditFindings().then(setAuditFindings).catch(() => {}); };
    window.addEventListener('costhub-audit-changed', onAuditChanged);
    window.addEventListener('costhub-insights-changed', onAuditChanged);
    return () => { window.removeEventListener('costhub-advisor-done', onAdv); window.removeEventListener('costhub-audit-changed', onAuditChanged); window.removeEventListener('costhub-insights-changed', onAuditChanged); };
  }, []);

  // 立即巡检（规则 + 本地 AI 深度洞察；后台执行，完成后刷新列表）
  const refreshAudit = async (silent = false) => {
    if (auditRunning) return;
    setAuditRunning(true);
    try {
      const r = await runAutoAudit();
      if (r) {
        const findings = await getAuditFindings();
        setAuditFindings(findings);
        if (!silent) message.success({ content: <span>巡检已更新，{findings.filter(item => item.status === 'unread').length} 条待处理 <Button type="link" size="small" onClick={() => openInsightCenter(onNavigate, 'audit')}>查看巡检发现 →</Button></span>, duration: 8 });
        setRecentPriceChanges(await getRecentPartPriceChanges(8));
        setAuditLastAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        // ⚠️ 2026-08-18：自动触发静默——「数据无变化/AI 失败」只在手动点击「AI 自主巡检」时提示，避免反复打扰
        if (!silent) {
          if ((r as any).aiSkipped) message.info('数据无变化，AI 未重复思考（规则检查已更新）');
          else if ((r as any).aiFailed) message.warning('规则发现已更新；AI 深度洞察暂不可用（本地模型未连接或失败），可修复连接后重试');
        }
      }
    } catch (e) { console.warn('巡检失败:', e); }
    setAuditRunning(false);
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;
  if (!stats) return (
    <div style={{ padding: 32 }}>
      <div className="page-title"><BarChartOutlined /> AI 工作台</div>
      {loadError && (
        <div style={{ marginTop: 16, padding: 16, background: '#FFF1F2', borderRadius: 8, color: '#DC2626', fontSize: 13 }}>
          <strong>加载失败，错误信息：</strong><br />{loadError}
        </div>
      )}
      {!loadError && (
        <div style={{ marginTop: 24, padding: 32, background: '#fff', border: '1px solid #E8ECF1', borderRadius: 14, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1D1D1F', marginBottom: 6 }}>开始你的成本管理</div>
          <div style={{ fontSize: 12.5, color: '#6E6E73', marginBottom: 16 }}>先添加器件和项目，AI 工作台会自动生成成本洞察、报价情报与 AI 建议</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <Button type="primary" onClick={() => onNavigate?.('parts')}>添加器件</Button>
            <Button onClick={() => onNavigate?.('projects')}>创建项目</Button>
          </div>
        </div>
      )}
    </div>
  );

  const missed = targetStatuses.filter(t => t.missed);
  const summary = summarizeTargets(targetStatuses, projects);
  const unreadInsights = insights.filter((i: any) => i.status === 'unread');
  const parseInsightRows = (i: any): any[] => {
    try { const arr = JSON.parse(i.insight_json || '[]'); return Array.isArray(arr) ? arr : []; } catch { return []; }
  };

  // 未达标领域（按差额排序，最严重在前）
  const missedSorted = [...missed].sort((a, b) => Math.abs(Number(b.diff)) - Math.abs(Number(a.diff)));
  // 目标成本达成（项目维度，2026-08-17 简化）：每项目聚合未达标领域 + 最差达成率
  const missedByProject = (() => {
    const map = new Map<number, { projectId: number; code: string; domains: string[]; worstDomain: string; worstRate: number }>();
    missedSorted.forEach(t => {
      const m = map.get(t.projectId) || { projectId: t.projectId, code: t.code, domains: [], worstDomain: t.domain, worstRate: Number(t.rate) };
      m.domains.push(t.domain);
      if (Number(t.rate) < m.worstRate) { m.worstRate = Number(t.rate); m.worstDomain = t.domain; }
      map.set(t.projectId, m);
    });
    return [...map.values()];
  })();

  // ⚠️ 图表优化（2026-08-16，按 ui-ux-pro-max 图表选型）：比较类柱状图必须降序排列（类别比较核心洞察是排序），
  // 颜色统一品牌主色系（比较场景禁止每柱彩虹色——skill: same hue family），最高值同色系深色高亮
  const projSorted = [...projCosts].filter(d => d.cost != null).sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const maxProjCost = projSorted[0]?.cost;
  const projBarOption = {
    tooltip: chartTooltip('axis'),
    xAxis: { type: 'category', data: projSorted.map(d => d.name), ...chartAxisStyle(12) },
    yAxis: { type: 'value', name: '¥', ...chartAxisStyle() },
    series: [{
      type: 'bar', barWidth: '55%',
      data: projSorted.map(d => ({ value: d.cost || 0, itemStyle: { color: d.cost === maxProjCost ? barGradient('#1D4ED8') : barGradient('#60A5FA'), borderRadius: [8, 8, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, fontWeight: 600, color: chartTextMuted() },
    }],
    grid: chartGrid(),
  };

  const compSorted = [...compCosts].filter(d => d.cost != null).sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const maxCompCost = compSorted[0]?.cost;
  const compBarOption = {
    tooltip: chartTooltip('axis'),
    xAxis: { type: 'category', data: compSorted.map(d => d.name), ...chartAxisStyle(10, { rotate: 20 }) },
    yAxis: { type: 'value', name: '¥', ...chartAxisStyle() },
    series: [{
      type: 'bar', barWidth: '55%',
      data: compSorted.map(d => ({ value: d.cost, itemStyle: { color: barGradient(d.cost === maxCompCost ? '#1D4ED8' : '#60A5FA'), borderRadius: [8, 8, 0, 0] } })),
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

  // 驾驶舱新版布局：保留旧视图代码作为回滚参考，默认使用更聚焦的招标工作台布局。
  return <DashboardRedesign
    costHistory={costHistory}
    stats={stats}
    projects={projects}
    productionSavings={productionSavings}
    productionTarget={productionTarget}
    savingYear={savingYear} savingYears={savingYears} savingsLoading={savingsLoading} onSavingYearChange={setSavingYear}
    projCosts={projCosts}
    snapshotChanges={snapshotChanges}
    missedByProject={missedByProject}
    unreadInsights={unreadInsights}
    recentPriceChanges={recentPriceChanges}
    advisorInsights={advisorInsights}
    cloudUsage={cloudUsage}
    cloudLimit={cloudLimit}
    onNavigate={onNavigate}
    targetedProjectIds={[...new Set(targetStatuses.map(item => item.projectId))]}
    unknownTargetCount={summary.unknownDomains}
    onRunAudit={() => refreshAudit(false)}
    auditRunning={auditRunning}
    auditCount={auditFindings.filter(item => item.status === 'unread').length}
  />;

  return (
    <div>
      {/* ===== 标题行：驾驶舱 + 今日速览（紧凑单行）+ AI 连接状态 ===== */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="page-title" style={{ marginBottom: 0 }}><BarChartOutlined /> AI 工作台</div>
        <DailyBrief onNavigate={onNavigate} inline />
        <span style={{ marginLeft: 'auto' }}><AIStatusBar onNavigate={onNavigate} compact /></span>
      </div>

            {/* ===== 状态仪表：一眼扫出哪里需要我 ===== */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
        <div onClick={() => onNavigate?.('projects')} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '12px 14px', cursor: onNavigate ? 'pointer' : 'default', transition: 'box-shadow 150ms ease-out, transform 150ms ease-out' }}>
          <div style={{ fontSize: 11, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="🎯" /> 目标预警</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: missedSorted.length > 0 ? '#DC2626' : '#16A34A' }}>{missedSorted.length}</div>
          <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 2 }}>{missedSorted.length > 0 ? '未达标' : '全部达标'}</div>
        </div>
        <div onClick={() => window.dispatchEvent(new Event('costhub-ai-focus'))} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '12px 14px', cursor: onNavigate ? 'pointer' : 'default', transition: 'box-shadow 150ms ease-out, transform 150ms ease-out' }}>
          <div style={{ fontSize: 11, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="🤖" /> AI 建议</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: advisorInsights.length > 0 ? '#D97706' : '#16A34A' }}>{advisorInsights.length}</div>
          <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 2 }}>{advisorInsights.length > 0 ? '待处理' : '无'}</div>
        </div>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="📈" /> 成本变动</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: (snapshotChanges.length + recentPriceChanges.length) > 0 ? '#2563EB' : '#16A34A' }}>{snapshotChanges.length + recentPriceChanges.length}</div>
          <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 2 }}>近期变动</div>
        </div>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="🛡" /> 安全状态</div>
          <div style={{ fontSize: 16, fontWeight: 800, marginTop: 6, color: '#16A34A', display: 'flex', alignItems: 'center', gap: 5 }}><EmojiIcon e="✓" /> 受控</div>
          <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 2 }}>本地处理 · 审计留痕</div>
        </div>
        <div onClick={() => window.dispatchEvent(new Event('costhub-ai-focus'))} style={{ background: 'var(--color-surface)', border: '1px solid ' + (cloudUsage.count >= cloudLimit ? '#FECACA' : '#E8ECF1'), borderRadius: 12, padding: '12px 14px', cursor: onNavigate ? 'pointer' : 'default', transition: 'box-shadow 150ms ease-out, transform 150ms ease-out' }}>
          <div style={{ fontSize: 11, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="☁" /> 云端用量</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: cloudUsage.count >= cloudLimit ? '#DC2626' : '#16A34A' }}>{cloudUsage.count}<span style={{ fontSize: 12, color: '#94A3B8' }}>/{cloudLimit}</span></div>
          <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 2 }}>{cloudUsage.count >= cloudLimit ? '已达上限' : (cloudUsage.tokens > 0 ? cloudUsage.tokens.toLocaleString() + ' token' : '未调用')}</div>
        </div>
      </div>

      {/* ===== 目标成本达成（项目维度紧凑条） ===== */}
      <div className="content-card" style={{ marginBottom: 14, padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><AimOutlined style={{ color: '#CF0A2C' }} /> 目标成本达成</b>
        {missedSorted.length === 0 ? (
          <Tag color="green" style={{ margin: 0 }}>{summary.targetedProjects > 0 ? '全部达标' : '尚未设定目标'}</Tag>
        ) : (
          <>
            <Tag color="red" style={{ margin: 0 }}>{missedByProject.length} 项目未达标</Tag>
            {missedByProject.map(m => (
              <span key={m.projectId} onClick={() => goProject(onNavigate, m.projectId)}
                title={m.domains.join('、') + ' 未达标'}
                style={{ border: '1px solid #FECACA', background: '#FFF5F5', borderRadius: 20, padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}>
                {m.code} · 最差 {m.worstDomain}（达成 {m.worstRate}%）
              </span>
            ))}
          </>
        )}
        {summary.untargetedProjects > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#B45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AlertOutlined /> {summary.untargetedProjects} 项目未设目标
            <a onClick={() => onNavigate?.('projects')}>前往设定 →</a>
          </span>
        )}
      </div>

      {/* ===== 第二行：左=关键物料洞察 | 右=AI 洞察建议（等高对齐） ===== */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, marginBottom: 14, alignItems: 'stretch' }}>
        <KeyMaterialInsights onNavigate={onNavigate} compact />

        <div className="content-card" style={{ marginBottom: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="card-header">
          <h3><RobotOutlined style={{ color: '#0A84FF' }} /> AI 洞察建议</h3>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            <Button size="small" icon={<RobotOutlined />} loading={auditRunning} onClick={() => refreshAudit()} style={{ fontSize: 11.5 }}>
              {auditRunning ? 'AI 巡检中…' : 'AI 自主巡检'}
            </Button>
            {auditLastAt && <span style={{ marginLeft: 8 }}>上次 {auditLastAt}</span>}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          {/* 🧠 最近 AI 分析结论（AI 协作窗分析后写回） */}
          {recentAnalysis.length > 0 && (
            <div style={{ border: '1px solid #E8ECF1', borderRadius: 10, padding: '8px 12px', background: '#F4F3EE' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <BulbOutlined style={{ color: '#D97706' }} />
                <b style={{ fontSize: 13 }}>🧠 最近 AI 分析结论</b>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10.5, color: '#94A3B8' }}>AI 协作窗分析后自动记录</span>
              </div>
              {recentAnalysis.slice(0, 3).map((a: any) => (
                <div key={a.id} style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.6, marginBottom: 5, whiteSpace: 'pre-wrap' }}>
                  <b style={{ color: '#181713' }}>{a.project_code || '项目'}</b>
                  <span style={{ color: '#94A3B8', margin: '0 6px', fontSize: 10 }}>{String(a.created_at || '').slice(5, 16)}</span>
                  {a.conclusion}
                </div>
              ))}
            </div>
          )}
          {/* 🧠 自主分析结论（合并：AI 后台自发分析结果） */}
          <GoalsCard />
          <AutoThinkPanel mode="inline" onNavigate={onNavigate} />
          {/* 📋 待处理事项（统一入口：AI 情报中心——报价差异/自主建议/巡检发现） */}
          <div style={{ border: '1px solid #E8ECF1', borderRadius: 10, padding: '8px 12px', background: '#FAFBFC', marginTop: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <RobotOutlined style={{ color: '#0A84FF' }} />
              <b style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>📋 待处理事项</b>
              <span style={{ flex: 1 }} />
              <a style={{ fontSize: 11.5, color: '#0A84FF' }} onClick={() => openAiCenter(onNavigate)}>前往处理 →</a>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="blue" style={{ margin: 0, cursor: 'pointer' }} onClick={() => openAiCenter(onNavigate)}>📊 报价差异 {unreadInsights.length}</Tag>
              <Tag color="purple" style={{ margin: 0, cursor: 'pointer' }} onClick={() => openAiCenter(onNavigate)}>💡 自主建议 {advisorInsights.length}</Tag>
              <Tag color="orange" style={{ margin: 0, cursor: 'pointer' }} onClick={() => openAiCenter(onNavigate)}>🔍 巡检发现 {auditFindings.filter((x: any) => x.status === 'unread').length}</Tag>
            </div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 5 }}>三类 AI 情报统一处理：报价差异确认 / 建议处理 / 巡检已读</div>
          </div>
        </div>
      </div>
      </div>

{/* ===== ② 最近成本变动（事实汇总：用户输入数据的变动，不叫 AI） ===== */}
      <div className="content-card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3><BarChartOutlined style={{ color: '#D97706' }} /> 最近成本变动</h3>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>快照异动 · 最近改价物料 · 跨项目报价差异（数据来源：您维护的成本数据）</span>
        </div>
        {(() => {
          // 三类卡片合成一个展示数组（默认折叠：只显示第一条，其余展开）
          const cards: any[] = [];
          snapshotChanges.forEach((c2, idx) => {
            const p = projects.find((x: any) => x.id === c2.projectId);
            cards.push(
              <div key={'snap-' + c2.projectId + '-' + idx} onClick={() => goProject(onNavigate, c2.projectId)}
                style={{ border: c2.pct > 0 ? '1px solid #FECACA' : '1px solid #A7F3D0', background: c2.pct > 0 ? '#FFFBF5' : '#F3FEF8', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', transition: 'box-shadow 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(16,185,129,0.12)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <b style={{ fontSize: 13, color: '#1F2937' }}>{p?.code || c2.projectId}</b>
                  <span style={{ fontSize: 12, color: c2.pct > 0 ? '#DC2626' : '#059669', fontWeight: 600 }}>
                    {c2.pct > 0 ? '▲' : '▼'} {Math.abs(c2.pct)}%
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94A3B8' }}>¥{c2.oldCost.toFixed(2)} → ¥{c2.newCost.toFixed(2)}</span>
                </div>
                {c2.reason && <div style={{ fontSize: 12, color: '#6B7280' }}>原因：{c2.reason}</div>}
              </div>
            );
          });
          recentPriceChanges.forEach((ch: any, idx: number) => {
            cards.push(
              <div key={'pc-' + ch.id + '-' + idx} onClick={() => onNavigate?.('parts')}
                style={{ border: '1px solid #E8ECF1', background: '#FAFBFC', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', transition: 'box-shadow 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <b style={{ fontSize: 13, color: '#1F2937' }}>{ch.name}</b>
                  <span style={{ fontSize: 11.5, color: '#94A3B8' }}>{ch.model}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: ch.new_cost > ch.old_cost ? '#DC2626' : '#059669', fontWeight: 600 }}>
                    {ch.new_cost > ch.old_cost ? '▲' : '▼'} ¥{(ch.new_cost - ch.old_cost).toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#6B7280' }}>¥{ch.old_cost?.toFixed?.(2) ?? ch.old_cost} → ¥{ch.new_cost?.toFixed?.(2) ?? ch.new_cost} · {ch.changed_at}</div>
              </div>
            );
          });
          unreadInsights.forEach((i: any) => {
            const rows = parseInsightRows(i);
            if (rows.length === 0) return;
            rows.forEach((r: any, idx: number) => {
              cards.push(
                <div key={'ins-' + i.id + '-' + idx} onClick={() => { onNavigate?.('projects'); window.dispatchEvent(new CustomEvent('costhub-open-insights')); }}
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
              );
            });
          });
          if (cards.length === 0) {
            return <div style={{ padding: '6px 2px', fontSize: 13, color: '#94A3B8' }}>近期无成本变动。改价、快照异动、报价差异会自动汇总到这里。</div>;
          }
          const visible = costOpen ? cards : cards.slice(0, 1);
          return (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10 }}>{visible}</div>
              {cards.length > 1 && (
                <div style={{ marginTop: 8, textAlign: 'center' }}>
                  <a onClick={() => setCostOpen(o => !o)} style={{ fontSize: 12, color: '#0A84FF' }}>
                    {costOpen ? '收起 ▲' : '展开全部（' + (cards.length - 1) + ' 条）▼'}
                  </a>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ===== ④ 统计卡（导航入口） ===== */}
      <div className="stat-cards">
        <div className="stat-card card-a" onClick={() => onNavigate?.('parts')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">器件总数</div><div className="stat-value">{stats!.total_parts}</div></div>
        <div className="stat-card card-b" onClick={() => onNavigate?.('projects')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">项目总数</div><div className="stat-value">{stats!.total_projects}</div></div>
        <div className="stat-card card-c" onClick={() => onNavigate?.('projects')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">进行中项目</div><div className="stat-value">{stats!.active_projects}</div></div>
        <div className="stat-card card-d"><div className="stat-label">平均BOM成本</div><div className="stat-value">¥{(stats!.avg_bom_cost ?? 0).toLocaleString()}</div></div>
        <div className="stat-card card-e" onClick={() => onNavigate?.('competitors')} style={{ cursor: onNavigate ? 'pointer' : 'default' }}><div className="stat-label">竞品数量</div><div className="stat-value">{stats!.total_competitors}</div></div>
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
        <DataTable tableId="dash_recent_parts" dataSource={stats!.recent_parts} columns={recentCols} rowKey="id" size="small" pagination={false} />
      </div>
    </div>
  );
}
