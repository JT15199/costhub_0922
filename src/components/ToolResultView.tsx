// 工具结果可视化（v2.3.19，2026-08-19 用户：体验的结果可视化很重要——分析结果直接看图）
// 原则：代码级确定（不依赖模型），从工具参数+库数据渲染；与文本结论并存；v2 视觉
import { useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { Table, Tag, Popconfirm } from 'antd';
import { getProjects, getProjectBOMs, getTargets, getCompetitors, getCompetitorBOMs, getSellingPoints, getSellingPointMaps, getLatestTrendSnapshot, getSupplierPriceProfiles, getTenderOverview, getTenderMatrix } from '../db';
import { computeSellingPointRows, computeModuleValueRows, type ModuleValueRow } from '../sellingPointAnalyzer';
import { computeTargetStatuses } from '../targetInsight';
import ModuleValueMatrix from './ModuleValueMatrix';

const COLORS = ['#3B82F6', '#8B5CF6', '#F97316', '#34C759', '#0891B2', '#AF52DE', '#FF9500', '#5856D6'];
const mono = { fontVariantNumeric: 'tabular-nums' } as const;

interface ViewData {
  type: 'pie' | 'bar' | 'chart' | 'table' | 'matrix' | 'card' | 'competitor' | 'canonical';
  title?: string;
  // pie
  pie?: { name: string; value: number }[];
  // bar
  cats?: string[]; vals?: number[]; barColors?: string[];
  // table
  columns?: any[]; rows?: any[];
  // matrix
  matrixRows?: ModuleValueRow[]; modRows?: ModuleValueRow[];
  // card
  card?: { label: string; value: string; color?: string }[]; text?: string;
  chartOption?: any;
}

async function loadData(toolId: string, args: any): Promise<ViewData | null> {
  try {
    if (toolId === 'query_project_cost' || toolId === 'query_project_bom') {
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === args?.project_code);
      if (!p) return null;
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      if (toolId === 'query_project_cost') {
        const cost = (b: any) => (Number(b.part_cost ?? b.cost) || 0) * (Number(b.quantity) || 1);
        const total = boms.reduce((s, b) => s + cost(b), 0);
        const modMap = new Map<string, number>();
        boms.forEach(b => { const m = b.module_name || '未分模块'; modMap.set(m, (modMap.get(m) || 0) + cost(b)); });
        const sorted = [...modMap.entries()].sort((a, b) => b[1] - a[1]);
        return {
          type: 'pie', title: p.code + ' 成本结构 · 总 ' + '¥' + total.toFixed(0),
          pie: sorted.map(([name, value]) => ({ name, value: Math.round(value) })),
          columns: [
            { title: '模块', dataIndex: 'mod' }, { title: '成本', dataIndex: 'cost', align: 'right', render: (v: number) => <span style={mono}>¥{v.toFixed(0)}</span> },
            { title: '占比', dataIndex: 'pct', align: 'right', render: (v: string) => <span style={{ color: '#A67C1F', fontWeight: 600 }}>{v}</span> },
          ],
          rows: sorted.map(([mod, value]) => ({ mod, cost: value, pct: Math.round((value / total) * 100) + '%' })),
        } as ViewData;
      }
      const cost2 = (b: any) => (Number(b.part_cost ?? b.cost) || 0) * (Number(b.quantity) || 1);
      return {
        type: 'table', title: p.code + ' BOM 明细 · ' + boms.length + ' 项',
        columns: [
          { title: '模块', dataIndex: 'mod' }, { title: '名称', dataIndex: 'name' }, { title: '型号', dataIndex: 'model' },
          { title: '数量', dataIndex: 'qty', align: 'right' }, { title: '单价', dataIndex: 'price', align: 'right', render: (v: number) => <span style={mono}>¥{(v || 0).toFixed(0)}</span> },
          { title: '小计', dataIndex: 'sub', align: 'right', render: (v: number) => <b style={mono}>¥{(v || 0).toFixed(0)}</b> },
        ],
        rows: boms.map(b => ({ mod: b.module_name || '未分模块', name: b.part_name || '', model: b.part_model || '', qty: b.quantity || 1, price: Number(b.part_cost ?? b.cost) || 0, sub: cost2(b) })),
      };
    }
    if (toolId === 'query_target_status') {
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const tByP: Record<number, any[]> = {};
      const bByP: Record<number, any[]> = {};
      for (const p of projs) {
        try { tByP[p.id] = await getTargets(p.id); } catch { tByP[p.id] = []; }
        try { bByP[p.id] = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted); } catch { bByP[p.id] = []; }
      }
      const st = computeTargetStatuses(projs, tByP, bByP);
      return {
        type: 'table', title: '目标成本达成',
        columns: [
          { title: '项目', dataIndex: 'code' }, { title: '目标', dataIndex: 'target', align: 'right', render: (v: number) => <span style={mono}>¥{(v || 0).toFixed(0)}</span> },
          { title: '实际', dataIndex: 'actual', align: 'right', render: (v: number) => <span style={mono}>¥{(v || 0).toFixed(0)}</span> },
          { title: '达成率', dataIndex: 'rate', align: 'right', render: (v: number) => <b style={{ color: (v || 0) >= 100 ? '#1F7A4C' : '#C0392B' }}>{(v || 0).toFixed(0)}%</b> },
          { title: '状态', dataIndex: 'status', align: 'center', render: (v: string) => <Tag color={v === '达成' ? 'green' : v === '超支' ? 'red' : 'orange'}>{v}</Tag> },
        ],
        rows: st.map(s => ({ code: s.code || '', target: s.target, actual: s.actual, rate: s.rate, status: s.missed ? '超支' : '达成' })),
      };
    }
    if (toolId === 'compare_subcategory_cost') {
      const db = await (await import('../db')).getDb();
      const rows = await db.select<any[]>(`SELECT p.name, p.model, p.cost, pr.code FROM project_boms pb JOIN parts p ON pb.part_id = p.id JOIN projects pr ON pb.project_id = pr.id WHERE pb.sub_category = ? AND COALESCE(pb.is_deleted,0)=0 ORDER BY p.cost DESC`, [args?.sub_category]);
      const byCode = new Map<string, number>();
      rows.forEach((r: any) => byCode.set(r.code, (byCode.get(r.code) || 0) + (Number(r.cost) || 0)));
      const arr = [...byCode.entries()].sort((a, b) => a[1] - b[1]);
      const colors = arr.map((_, i) => (i === 0 ? '#1F7A4C' : i === arr.length - 1 ? '#C0392B' : '#B0895A'));
      return { type: 'bar', title: '子类「' + args?.sub_category + '」跨项目成本', cats: arr.map(x => x[0]), vals: arr.map(x => Math.round(x[1])), barColors: colors };
    }
    if (toolId === 'query_project_module_value') {
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === args?.project_code);
      if (!p) return null;
      const sps = await getSellingPoints(p.id);
      const maps = await getSellingPointMaps(p.id);
      const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
      const moduleCosts: Record<string, number> = {};
      boms.forEach(b => { const m = b.module_name || '未归类'; moduleCosts[m] = (moduleCosts[m] || 0) + (Number(b.part_cost ?? b.cost) || 0) * (Number(b.quantity) || 1); });
      const rows = computeSellingPointRows({ sps: sps.map((s: any) => ({ id: s.id, name: s.name, positive: s.positive, negative: s.negative })), modules: maps.modules, moduleCosts });
      const modRows = computeModuleValueRows(rows, moduleCosts);
      return { type: 'matrix', title: p.code + ' 模块价值矩阵', matrixRows: modRows, modRows };
    }
    if (toolId === 'query_competitor_bom') {
      const comps = await getCompetitors();
      const list = comps.filter((c: any) => (!args?.brand || String(c.brand || '').includes(args.brand)) && (!args?.model || String(c.model || '').includes(args.model)));
      const out: any[] = [];
      for (const c of list.slice(0, 5)) {
        const boms = await getCompetitorBOMs(c.id);
        out.push({ code: (c.brand || '') + ' ' + (c.model || ''), price: c.market_price, bom: c.bom_cost, tier: c.tier || '', mods: boms.length });
      }
      return {
        type: 'competitor', title: '竞品对比',
        columns: [
          { title: '竞品', dataIndex: 'code' }, { title: '档位', dataIndex: 'tier' },
          { title: '售价', dataIndex: 'price', align: 'right', render: (v: number) => <span style={mono}>¥{(v || 0).toFixed(0)}</span> },
          { title: '估算BOM', dataIndex: 'bom', align: 'right', render: (v: number) => <b style={mono}>¥{(v || 0).toFixed(0)}</b> },
          { title: '模块数', dataIndex: 'mods', align: 'center' },
        ],
        rows: out,
      };
    }
    if (toolId === 'query_supplier_profile') {
      const rows = await getSupplierPriceProfiles();
      const list = (rows || []).filter((r: any) => !args?.supplier || String(r.supplier_name || '').includes(String(args.supplier || '')));
      return {
        type: 'competitor', title: '供应商画像' + (args?.supplier ? '（含「' + args.supplier + '」）' : ''),
        columns: [
          { title: '供应商', dataIndex: 'name' }, { title: '覆盖器件', dataIndex: 'count', align: 'center' },
          { title: '平均价', dataIndex: 'avg', align: 'right', render: (v: number) => <span style={mono}>¥{(v || 0).toFixed(0)}</span> },
          { title: '价格水平', dataIndex: 'level', align: 'center', render: (v: number) => v === 0 ? <Tag color="default">持平</Tag> : v > 0 ? <Tag color="orange">偏高 {v}%</Tag> : <Tag color="green">偏低 {-v}%</Tag> },
          { title: '最大份额', dataIndex: 'share', align: 'center', render: (v: number) => (v || 0) > 0 ? v + '%' : '—' },
        ],
        rows: list.map((r: any) => ({ name: r.supplier_name || '', count: r.part_count || 0, avg: r.avg_price || 0, level: r.level || 0, share: r.max_share || 0 })),
      };
    }
    if (toolId === 'canonicalize_project') {
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === args?.project_code);
      if (!p) return null;
      const db = await (await import('../db')).getDb();
      const rows = await db.select<any[]>(`SELECT p.id as part_id,
        COALESCE(NULLIF(pb.part_name,''), p.name) as part_name,
        COALESCE(NULLIF(pb.part_model,''), p.model) as part_model,
        COALESCE(p.canonical_name,'') as canonical_name,
        COALESCE(p.canonical_category,'') as canonical_category,
        COALESCE(p.canonical_specs,'[]') as canonical_specs
        FROM project_boms pb LEFT JOIN parts p ON pb.part_id = p.id
        WHERE pb.project_id = ? AND COALESCE(pb.is_deleted,0)=0 AND p.id IS NOT NULL
        GROUP BY p.id, part_name, part_model ORDER BY part_name`, [p.id]);
      const statusOf = (r: any) => {
        if (!r.canonical_name) return { text: '未处理', color: 'default' };
        let specs: any[] = []; try { specs = JSON.parse(r.canonical_specs || '[]'); } catch { }
        return specs.length ? { text: '已规范', color: 'green' } : { text: '笼统保留', color: 'gold' };
      };
      return {
        type: 'canonical', title: p.code + ' 物料规范化明细 · ' + rows.length + ' 条',
        columns: [
          { title: '原名', dataIndex: 'part_name' },
          { title: '型号', dataIndex: 'part_model' },
          { title: '规范名', dataIndex: 'canonical_name', render: (v: string) => v ? <b>{v}</b> : <span style={{ color: '#B8B5AA' }}>—</span> },
          { title: '品类', dataIndex: 'canonical_category', render: (v: string) => v ? v : '—' },
          { title: '规格', dataIndex: 'specsText', render: (v: string) => v || '—' },
          { title: '状态', dataIndex: 'status', align: 'center', render: (v: any) => <Tag color={v.color}>{v.text}</Tag> },
        ],
        rows: rows.map((r: any) => { const st = statusOf(r); let specs: any[] = []; try { specs = JSON.parse(r.canonical_specs || '[]'); } catch { } return { ...r, specsText: specs.join(' / '), status: st }; }),
      } as ViewData;
    }
    if (toolId === 'query_tender_analysis') {
      const projs = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted);
      const p = projs.find((x: any) => x.code === args?.project_code);
      if (!p) return null;
      const [overview, matrix] = await Promise.all([getTenderOverview(p.id), getTenderMatrix(p.id)]);
      if (!matrix.length) return null;
      const suppliers = [...new Set(matrix.flatMap(row => Object.keys(row.offers)))];
      const columns: any[] = [
        { title: '器件', dataIndex: 'name', width: 160 },
        ...suppliers.map(s => ({ title: s, dataIndex: 'supplier_' + s, align: 'right', render: (v: any) => v || '—' })),
        { title: '可比最低', dataIndex: 'low', align: 'right' },
        { title: '机会', dataIndex: 'opportunity', align: 'right', render: (v: number) => <b style={{ color: v > 0 ? '#C0392B' : '#5F5D54' }}>{v > 0 ? '¥' + v.toFixed(2) : '—'}</b> },
      ];
      const rows = matrix.slice().sort((a, b) => b.opportunity - a.opportunity).slice(0, 12).map(row => {
        const item: any = { name: (row.moduleName ? row.moduleName + ' · ' : '') + row.materialName, low: row.comparableLow ? '¥' + row.comparableLow.lineTotal.toFixed(2) : '待确认', opportunity: row.opportunity };
        suppliers.forEach(s => { const offer = row.offers[s]; item['supplier_' + s] = offer ? '¥' + offer.lineTotal.toFixed(2) + (offer.relationType === 'unmatched' ? ' · 待确认' : '') : ''; });
        return item;
      });
      return { type: 'table', title: p.code + ' 招标比价 · ' + (overview.currentRound ? `第${overview.currentRound.roundNo}轮` : '当前') + ` · 可比覆盖 ${Math.round(overview.summary.comparableCoverage * 100)}% · 理论组合底价 ¥${overview.summary.theoreticalLow.toFixed(2)}`, columns, rows };
    }
    if (toolId === 'visualize_cost_analysis') {
      const codes = String(args?.project_codes || '').split(/[,，]/).map((x: string) => x.trim()).filter(Boolean).slice(0, 8);
      const dimension = ['module', 'main_category', 'sub_category'].includes(String(args?.dimension)) ? String(args.dimension) : 'module';
      const chartType = ['pie', 'bar', 'pareto'].includes(String(args?.chart_type)) ? String(args.chart_type) : (codes.length > 1 ? 'bar' : 'pie');
      const projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted && codes.includes(String(p.code || '')));
      if (!projects.length) return null;
      const rowsByProject: { code: string; values: Map<string, number> }[] = [];
      for (const p of projects) {
        const values = new Map<string, number>();
        const boms = (await getProjectBOMs(p.id)).filter((b: any) => !b.is_deleted);
        for (const b of boms) {
          const key = dimension === 'module' ? (b.module_name || '未分模块') : (b[dimension] || '未分类');
          const value = (Number(b.part_cost ?? b.cost) || 0) * (Number(b.quantity) || 1);
          values.set(key, (values.get(key) || 0) + value);
        }
        rowsByProject.push({ code: p.code, values });
      }
      const dimensionLabel = dimension === 'module' ? '模块' : dimension === 'main_category' ? '大类' : '子类';
      const title = codes.join(' vs ') + ' · 按' + dimensionLabel + '成本';
      if (chartType === 'pie' && rowsByProject.length === 1) {
        const data = [...rowsByProject[0].values.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }));
        return { type: 'chart', title, chartOption: {
          tooltip: { trigger: 'item', formatter: '{b}<br/>¥{c}（{d}%）' }, color: COLORS,
          legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 10 } },
          series: [{ type: 'pie', radius: ['38%', '68%'], center: ['50%', '43%'], data, label: { formatter: '{b}\n{d}%', fontSize: 10 }, itemStyle: { borderRadius: 4 } }],
        } };
      }
      if (chartType === 'pareto' && rowsByProject.length === 1) {
        const sorted = [...rowsByProject[0].values.entries()].sort((a, b) => b[1] - a[1]);
        const total = sorted.reduce((s, x) => s + x[1], 0) || 1;
        let running = 0;
        const cumulative = sorted.map(x => Number(((running += x[1]) / total * 100).toFixed(1)));
        return { type: 'chart', title: title + ' · 帕累托', chartOption: {
          tooltip: { trigger: 'axis' }, grid: { left: 52, right: 42, top: 24, bottom: 58 },
          xAxis: { type: 'category', data: sorted.map(x => x[0]), axisLabel: { rotate: 28, fontSize: 10 } },
          yAxis: [{ type: 'value', name: '成本 ¥' }, { type: 'value', name: '累计占比', min: 0, max: 100, axisLabel: { formatter: '{value}%' } }],
          series: [
            { name: '成本', type: 'bar', data: sorted.map(x => Number(x[1].toFixed(2))), itemStyle: { color: '#6366F1', borderRadius: [4, 4, 0, 0] } },
            { name: '累计占比', type: 'line', yAxisIndex: 1, data: cumulative, smooth: true, symbolSize: 5, lineStyle: { color: '#F59E0B', width: 2 } },
          ],
        } };
      }
      const cats = [...new Set(rowsByProject.flatMap(r => [...r.values.keys()]))]
        .sort((a, b) => Math.max(...rowsByProject.map(r => r.values.get(b) || 0)) - Math.max(...rowsByProject.map(r => r.values.get(a) || 0)));
      return { type: 'chart', title, chartOption: {
        tooltip: { trigger: 'axis' }, legend: { bottom: 0 }, grid: { left: 52, right: 16, top: 24, bottom: 58 },
        xAxis: { type: 'category', data: cats, axisLabel: { rotate: 28, fontSize: 10 } }, yAxis: { type: 'value', name: '成本 ¥' },
        series: rowsByProject.map((r, i) => ({ name: r.code, type: 'bar', data: cats.map(c => Number((r.values.get(c) || 0).toFixed(2))), itemStyle: { color: COLORS[i % COLORS.length], borderRadius: [3, 3, 0, 0] } })),
      } };
    }
    if (toolId === 'insight_material_trend' || toolId === 'query_material_insight') {
      const db = await (await import('../db')).getDb();
      const items = await db.select<any[]>('SELECT * FROM trend_items WHERE query_category LIKE ? ORDER BY id DESC LIMIT 1', ['%' + (args?.material_name || '') + '%']);
      if (!items.length) return null;
      const snap = await getLatestTrendSnapshot(items[0].id);
      if (!snap) return null;
      const dirColor = (snap.direction || '').includes('涨') ? '#C0392B' : (snap.direction || '').includes('跌') ? '#1F7A4C' : '#A67C1F';
      return {
        type: 'card', title: (args?.material_name || items[0].query_category) + ' 最新洞察 · ' + String(snap.query_time || '').slice(0, 10),
        card: [
          { label: '趋势', value: snap.direction || '-', color: dirColor },
          { label: '置信度', value: snap.confidence_level || '-' },
        ],
        text: snap.summary || '',
      };
    }
    return null;
  } catch { return null; }
}

export default function ToolResultView({ toolId, args }: { toolId: string; args: any }) {
  const [data, setData] = useState<ViewData | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    loadData(toolId, args).then(d => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [toolId, JSON.stringify(args || {}), reload]);
  async function doReset(partId: number, name: string) {
    try {
      const { resetPartCanonical } = await import('../canonicalize');
      const { logWriteAudit } = await import('../db');
      const ok = await resetPartCanonical(partId);
      if (ok) {
        try { await logWriteAudit('reset_canonical', '物料还原:' + String(name || '').slice(0, 60), '已清空规范结果（可重新规范化）', ''); } catch { }
        setReload(x => x + 1);
      }
    } catch { }
  }
  if (!data) return null;
  return (
    <div style={{ background: '#FBFAF6', border: '1px solid #E6E4DC', borderRadius: 8, padding: '8px 10px', marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {data.title && <div style={{ fontSize: 11, fontWeight: 700, color: '#181713' }}>{data.title}</div>}
        {['query_project_cost', 'query_project_bom', 'query_project_module_value'].includes(toolId) && args?.project_code && (
          <a style={{ fontSize: 10.5, color: '#0A84FF', marginLeft: 'auto', cursor: 'pointer', flexShrink: 0 }} onClick={async () => {
            try { const ps = await getProjects('', '', ''); const p = ps.find((x: any) => x.code === args.project_code); if (p) {
              localStorage.setItem('costhub-open-project-pending', String(p.id));
              window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid: p.id } }));
            } } catch { }
          }}>去项目页 →</a>
        )}
      </div>
      {data.type === 'pie' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ width: 150, flexShrink: 0 }}>
            <ReactECharts echarts={echarts} option={{
              tooltip: { trigger: 'item' },
              color: COLORS,
              series: [{ type: 'pie', radius: ['45%', '70%'], data: data.pie, label: { formatter: '{b}\n{d}%', fontSize: 10 }, itemStyle: { borderRadius: 4 } }],
            }} style={{ height: 130 }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Table size="small" pagination={false} rowKey="mod" dataSource={data.rows} columns={data.columns} scroll={{ x: 130 }} />
          </div>
        </div>
      )}
      {data.type === 'bar' && (
        <ReactECharts echarts={echarts} option={{
          tooltip: { trigger: 'axis' },
          grid: { left: 44, right: 12, top: 16, bottom: 26 },
          xAxis: { type: 'category', data: data.cats, axisLabel: { fontSize: 10 } },
          yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
          series: [{ type: 'bar', data: data.vals, barWidth: 22, itemStyle: { color: (p: any) => (data.barColors || [])[p.dataIndex] || '#B0895A', borderRadius: 3 } }],
        }} style={{ height: 150 }} />
      )}
      {data.type === 'chart' && data.chartOption && (
        <ReactECharts echarts={echarts} option={data.chartOption} style={{ height: 270 }} />
      )}
      {(data.type === 'table' || data.type === 'competitor') && (
        <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={data.rows} columns={data.columns} scroll={{ x: 320 }} />
      )}
      {data.type === 'matrix' && data.matrixRows && <ModuleValueMatrix rows={data.matrixRows} />}
      {data.type === 'canonical' && (
        <Table size="small" pagination={{ pageSize: 8 }} rowKey={(_, i) => String(i)} dataSource={data.rows} columns={[
          ...(data.columns || []),
          { title: '操作', dataIndex: 'op', align: 'center', width: 64, render: (_: any, row: any) => row.canonical_name ? (
            <Popconfirm title="还原此物料规范化？" description="清空该物料规范结果（原名不受影响），之后可重新规范化。" okText="还原" cancelText="取消" onConfirm={() => doReset(row.part_id, row.part_name)}>
              <a style={{ fontSize: 11, color: '#C0392B', whiteSpace: 'nowrap' }}>还原</a>
            </Popconfirm>
          ) : null },
        ]} scroll={{ x: 580 }} />
      )}
      {data.type === 'card' && (
        <div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 4 }}>
            {(data.card || []).map((c, i) => (
              <span key={i} style={{ fontSize: 11.5, color: '#5F5D54' }}>{c.label}：<b style={{ color: c.color || '#181713', fontSize: 13 }}>{c.value}</b></span>
            ))}
          </div>
          {data.text && <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.text}</div>}
        </div>
      )}
    </div>
  );
}
