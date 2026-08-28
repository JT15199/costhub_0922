// 新项目目标成本制定面板（v2.3.19，2026-08-27 用户：整体目标外部输入，按上一代特性价值+价值密度分配到领域）
// 领域 = BOM main_category 分组（用户：大结构/大硬件/多媒体/包装/互连等）；特性 = 卖点（声量）；新特性（无声量）预算并入领域
// 交互：选参考上一代 → 输入目标总成本 → 生成分配建议（领域行可编辑）→ 对账实时 → 保存为领域目标（project_targets）
import { useEffect, useMemo, useState } from 'react';
import { Select, InputNumber, Button, Table, Tag, message } from 'antd';
import { getProjects, getProjectBOMs, getSellingPoints, getSellingPointMaps, getTargets, saveTarget } from '../db';
import { buildTargetAllocation, computeModuleCosts } from '../targetAllocation';

const COLORS = ['#3B82F6', '#8B5CF6', '#F97316', '#0891B2', '#AF52DE', '#34C759', '#FF9500', '#5856D6', '#B0895A'];
const mono = { fontVariantNumeric: 'tabular-nums' } as const;

export default function TargetAllocationPanel({ projectId }: { projectId: number }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [refPid, setRefPid] = useState<number | null>(null);
  const [targetTotal, setTargetTotal] = useState<number>(0);
  const [result, setResult] = useState<any>(null);
  const [edited, setEdited] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { (async () => { try { setProjects((await getProjects('', '', '')).filter((p: any) => !p.is_deleted)); } catch { } })(); }, []);

  const generate = async () => {
    if (!refPid) { message.warning('请选择参考上一代项目'); return; }
    if (!targetTotal || targetTotal <= 0) { message.warning('请输入目标总成本'); return; }
    setLoading(true);
    try {
      const boms = (await getProjectBOMs(refPid)).filter((b: any) => !b.is_deleted);
      // 领域 = main_category 分组（与项目页「领域成本目标设定」一致）
      const moduleCosts = computeModuleCosts(boms.map((b: any) => ({ ...b, module_name: b.main_category || '其他' })));
      const sps = await getSellingPoints(refPid);
      const maps = await getSellingPointMaps(refPid);
      const spInput = sps.map((s: any) => ({ id: s.id, name: s.name, positive: s.positive || 0, negative: s.negative || 0, isNew: ((s.positive || 0) + (s.negative || 0)) === 0 }));
      const r = buildTargetAllocation({ targetTotal, moduleCosts, sps: spInput, spModules: maps.modules });
      setResult(r);
      const init: Record<string, number> = {}; r.domains.forEach((d: any) => { init[d.name] = d.targetCost; });
      setEdited(init);
    } catch (e: any) { message.error('生成失败：' + String(e?.message || e).slice(0, 200)); }
    setLoading(false);
  };

  // 对账实时重算（编辑领域目标）
  const total = useMemo(() => Object.values(edited).reduce((s, v) => s + (Number(v) || 0), 0), [edited]);
  const diff = Math.round((targetTotal - total) * 100) / 100;

  const save = async () => {
    if (!projectId || !result) return;
    setSaving(true);
    try {
      const existing = await getTargets(projectId);
      let n = 0;
      for (const d of result.domains as any[]) {
        const v = Number(edited[d.name] ?? d.targetCost) || 0;
        const ex = existing.find((t: any) => t.domain === d.name);
        if (ex) await saveTarget({ id: ex.id, domain: d.name, target_cost: v });
        else { await saveTarget({ project_id: projectId, domain: d.name, target_cost: v }); n++; }
      }
      message.success('已保存 ' + result.domains.length + ' 个领域目标（新增 ' + n + '）——驾驶舱「目标达成」按新分配跟踪');
      try { window.dispatchEvent(new CustomEvent('costhub-targets-updated')); } catch { }
    } catch (e: any) { message.error('保存失败：' + String(e?.message || e).slice(0, 200)); }
    setSaving(false);
  };

  const rows: any[] = [];
  if (result) {
    (result.domains as any[]).forEach((d: any, di: number) => {
      rows.push({ key: 'd' + d.name, isDomain: true, d, color: COLORS[di % COLORS.length] });
      d.features.forEach((f: any, fi: number) => rows.push({ key: 'f' + d.name + fi, isDomain: false, d, f }));
    });
  }

  const columns = [
    { title: '领域', dataIndex: 'isDomain', width: 130, render: (_: any, r: any) => r.isDomain ? <span style={{ fontWeight: 700 }}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: r.color, marginRight: 6 }}></i>{r.d.name}</span> : <span style={{ color: '#8A877C' }}>└ {r.f.name}{r.f.isNew ? <Tag color="gold" style={{ marginLeft: 4, fontSize: 10 }}>新</Tag> : null}</span> },
    { title: '声量', dataIndex: 'v', width: 70, align: 'right' as const, render: (_: any, r: any) => r.isDomain ? null : (r.f.voice > 0 ? <span style={mono}>{r.f.voice}</span> : <span style={{ color: '#B8B5AA' }}>—</span>) },
    { title: '上一代成本(¥)', dataIndex: 'prev', width: 100, align: 'right' as const, render: (_: any, r: any) => r.isDomain ? <b style={mono}>{r.d.prevCost.toFixed(0)}</b> : <span style={mono}>{r.f.prevCost.toFixed(0)}</span> },
    { title: '目标成本(¥)', dataIndex: 'target', width: 120, align: 'right' as const, render: (_: any, r: any) => r.isDomain ? (
        <InputNumber size="small" value={edited[r.d.name]} onChange={v => setEdited(prev => ({ ...prev, [r.d.name]: Number(v) || 0 }))} style={{ width: 96 }} min={0} />
      ) : (r.f.isNew ? <Tag color="gold" style={{ margin: 0 }}>你定</Tag> : <span style={mono}>{r.f.targetCost.toFixed(0)}</span>) },
    { title: '增减(¥)', dataIndex: 'delta', width: 80, align: 'right' as const, render: (_: any, r: any) => {
      if (r.isDomain) { const dlt = Math.round(((Number(edited[r.d.name]) || 0) - r.d.prevCost) * 100) / 100; return <span style={{ ...mono, color: dlt > 0 ? '#1F7A4C' : dlt < 0 ? '#C0392B' : '#8A877C', fontWeight: 600 }}>{dlt > 0 ? '+' : ''}{dlt}</span>; }
      const dlt = r.f.targetCost - r.f.prevCost; return r.f.isNew ? <span style={{ color: '#A67C1F' }}>手输</span> : <span style={{ ...mono, color: dlt > 0 ? '#1F7A4C' : dlt < 0 ? '#C0392B' : '#8A877C' }}>{dlt > 0 ? '+' : ''}{dlt.toFixed(0)}</span>;
    } },
    { title: '依据', dataIndex: 'basis', render: (_: any, r: any) => r.isDomain ? <span style={{ fontSize: 10.5, color: '#5F5D54' }}>价值密度 <b style={mono}>{r.d.density}</b> · 声量 {r.d.voice} · 上一代占比 {(r.d.prevRatio * 100).toFixed(0)}%</span> : (r.f.isNew ? <span style={{ fontSize: 10.5, color: '#A67C1F' }}>新特性 · 预算并入领域，由你调整</span> : <span style={{ fontSize: 10.5, color: '#8A877C' }}>声量占比分配</span>) },
  ];

  return (
    <div className="content-card" style={{ margin: 0, padding: 12, marginTop: 12 }}>
      <div className="card-header"><h3>目标成本制定（按上一代价值分配）</h3></div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 11.5, color: '#5F5D54' }}>参考上一代：</span>
        <Select showSearch optionFilterProp="label" placeholder="选择项目" style={{ width: 220 }} value={refPid || undefined} onChange={v => setRefPid(v)}
          options={projects.map((p: any) => ({ label: p.code + ' · ' + p.name, value: p.id }))} />
        <span style={{ fontSize: 11.5, color: '#5F5D54' }}>目标总成本（外部计算输入）：</span>
        <InputNumber prefix="¥" min={0} style={{ width: 140 }} value={targetTotal} onChange={v => setTargetTotal(Number(v) || 0)} />
        <Button type="primary" size="small" loading={loading} onClick={generate}>生成分配建议</Button>
      </div>
      {result ? (
        <div>
          <Table size="small" pagination={false} rowKey="key" dataSource={rows} columns={columns as any}
            rowClassName={(r: any) => r.isDomain ? 'ta-dom-row' : 'ta-feat-row'}
            summary={() => (
              <Table.Summary.Row style={{ background: '#F3F1E9' }}>
                <Table.Summary.Cell index={0} colSpan={3}><b>对账</b>　目标总成本 ¥{targetTotal} · 领域合计 ¥{total.toFixed(0)}</Table.Summary.Cell>
                <Table.Summary.Cell index={1} colSpan={3}><b style={{ color: Math.abs(diff) < 0.5 ? '#1F7A4C' : '#C0392B' }}>差额 ¥{diff.toFixed(0)}{Math.abs(diff) < 0.5 ? ' ✓' : '（调整领域目标使差额归零）'}</b></Table.Summary.Cell>
              </Table.Summary.Row>
            )} />
          <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Button type="primary" size="small" loading={saving} onClick={save}>保存为领域目标</Button>
            <span style={{ fontSize: 10.5, color: '#8A877C' }}>保存后写入本项目的领域成本目标（覆盖同名领域），驾驶舱目标达成按新分配跟踪；新特性（无声量）预算已并入所属领域可在此调整</span>
          </div>
        </div>
      ) : <div style={{ fontSize: 11.5, color: '#8A877C', padding: 8 }}>选参考上一代项目并输入目标总成本，点「生成分配建议」——按 价值密度（声量÷成本占比）把目标分配到各领域，领域内特性按声量展开。</div>}
    </div>
  );
}