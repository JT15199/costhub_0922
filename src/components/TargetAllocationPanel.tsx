// 新项目目标成本制定面板（v2.3.19，2026-08-28 用户：直接做到位——特性级可编辑+视图切换+持久化）
// 领域 = BOM main_category 分组；特性 = 卖点（声量）；新特性（无声量）预算手输；分配明细持久化 project_target_features
import { useEffect, useMemo, useState } from 'react';
import { Select, InputNumber, Button, Table, Tag, message } from 'antd';
import { getProjects, getProjectBOMs, getSellingPoints, getSellingPointMaps, getTargets, saveTarget, getTargetFeatures, saveTargetFeatures } from '../db';
import { buildTargetAllocation, computeModuleCosts } from '../targetAllocation';
import { bomExtendedCostStrict } from '../ai/contracts';

const COLORS = ['#3B82F6', '#8B5CF6', '#F97316', '#0891B2', '#AF52DE', '#34C759', '#FF9500', '#5856D6', '#B0895A'];
const mono = { fontVariantNumeric: 'tabular-nums' } as const;
const fmt = (v: number) => Number(v || 0).toFixed(0);

export default function TargetAllocationPanel({ projectId }: { projectId: number }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [refPid, setRefPid] = useState<number | null>(null);
  const [targetTotal, setTargetTotal] = useState<number>(0);
  const [result, setResult] = useState<any>(null);
  const [featTargets, setFeatTargets] = useState<Record<string, number>>({});
  const [view, setView] = useState<'dom' | 'att'>('dom');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const featKey = (d: string, f: string) => d + '|' + f;

  useEffect(() => { (async () => { try { setProjects((await getProjects('', '', '')).filter((p: any) => !p.is_deleted)); } catch { } })(); }, []);

  const generate = async () => {
    if (!refPid) { message.warning('请选择参考上一代项目'); return; }
    if (!targetTotal || targetTotal <= 0) { message.warning('请输入目标总成本'); return; }
    setLoading(true);
    try {
      const boms = (await getProjectBOMs(refPid)).filter((b: any) => !b.is_deleted);
      if (boms.some(b => bomExtendedCostStrict(b) === null)) { message.warning('参考项目存在成本或数量证据缺口，不能生成目标分配'); return; }
      const moduleCosts = computeModuleCosts(boms.map((b: any) => ({ ...b, module_name: b.main_category || '其他' })));
      const sps = await getSellingPoints(refPid);
      const maps = await getSellingPointMaps(refPid);
      const spInput = sps.map((s: any) => ({ id: s.id, name: s.name, positive: s.positive || 0, negative: s.negative || 0, isNew: ((s.positive || 0) + (s.negative || 0)) === 0 }));
      let saved: any[] = []; try { saved = await getTargetFeatures(projectId); } catch { }
      const budget: Record<string, number> = {};
      saved.forEach((s: any) => { if (s.is_new) budget[s.feature_name] = s.target_cost; });
      const r = buildTargetAllocation({ targetTotal, moduleCosts, sps: spInput, spModules: maps.modules, newFeatureBudgets: budget });
      setResult(r);
      const init: Record<string, number> = {};
      (r.domains as any[]).forEach((d: any) => d.features.forEach((f: any) => { init[featKey(d.name, f.name)] = f.targetCost; }));
      saved.forEach((s: any) => { if (!s.is_new) { const k = featKey(s.domain, s.feature_name); if (k in init) init[k] = s.target_cost; } });
      setFeatTargets(init);
    } catch (e: any) { message.error('生成失败：' + String(e?.message || e).slice(0, 200)); }
    setLoading(false);
  };

  const domainTargets = useMemo(() => {
    const m: Record<string, number> = {};
    if (result) (result.domains as any[]).forEach((d: any) => { m[d.name] = d.features.reduce((s: number, f: any) => s + (Number(featTargets[featKey(d.name, f.name)]) || 0), 0); });
    return m;
  }, [result, featTargets]);
  const total = Object.values(domainTargets).reduce((s, v) => s + (Number(v) || 0), 0);
  const diff = Math.round((targetTotal - total) * 100) / 100;
  const setFeat = (d: string, f: string, v: number) => setFeatTargets(prev => ({ ...prev, [featKey(d, f)]: v }));

  const save = async () => {
    if (!projectId || !result) return;
    setSaving(true);
    try {
      const feats: any[] = []; let order = 0;
      (result.domains as any[]).forEach((d: any) => d.features.forEach((f: any) => {
        feats.push({ domain: d.name, feature_name: f.name, is_new: f.isNew ? 1 : 0, voice: f.voice || 0, prev_cost: f.prevCost || 0, target_cost: Number(featTargets[featKey(d.name, f.name)]) || 0, sort_order: order++ });
      }));
      await saveTargetFeatures(projectId, feats);
      const existing = await getTargets(projectId);
      for (const d of result.domains as any[]) {
        const v = Math.round((domainTargets[d.name] || 0) * 100) / 100;
        const ex = existing.find((t: any) => t.domain === d.name);
        if (ex) await saveTarget({ id: ex.id, domain: d.name, target_cost: v });
        else await saveTarget({ project_id: projectId, domain: d.name, target_cost: v });
      }
      message.success('已保存 ' + result.domains.length + ' 个领域目标（含 ' + feats.length + ' 个特性分配明细）——驾驶舱目标达成按新分配跟踪');
      try { window.dispatchEvent(new CustomEvent('costhub-targets-updated')); } catch { }
    } catch (e: any) { message.error('保存失败：' + String(e?.message || e).slice(0, 200)); }
    setSaving(false);
  };

  const rows = useMemo(() => {
    const out: any[] = [];
    if (!result) return out;
    const doms = result.domains as any[];
    if (view === 'dom') {
      doms.forEach((d: any, di: number) => {
        d.features.forEach((f: any, fi: number) => {
          out.push({ key: 'r' + d.name + fi, kind: 'feat', d, f, first: fi === 0, rowSpan: fi === 0 ? d.features.length + 1 : 0, color: COLORS[di % COLORS.length], subTarget: domainTargets[d.name] || 0 });
        });
        out.push({ key: 's' + d.name, kind: 'sub', d, color: COLORS[di % COLORS.length], subTarget: domainTargets[d.name] || 0, prevTotal: d.prevCost });
      });
    } else {
      const feats: any[] = [];
      doms.forEach((d: any) => d.features.forEach((f: any) => feats.push({ d, f })));
      const old = feats.filter((x: any) => !x.f.isNew).sort((a: any, b: any) => (b.f.voice || 0) - (a.f.voice || 0));
      const fresh = feats.filter((x: any) => x.f.isNew);
      [...old, ...fresh].forEach((x: any, i: number) => out.push({ key: 'a' + i, kind: 'feat', d: x.d, f: x.f, first: false, rowSpan: 0, color: COLORS[0], subTarget: 0 }));
    }
    return out;
  }, [result, view, domainTargets]);

  const domCell = (r: any) => {
    const inner = (<span style={{ fontWeight: 700, fontSize: 11.5 }}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: r.color, marginRight: 6 }}></i>{r.d.name}{view === 'dom' ? <span style={{ display: 'block', fontWeight: 600, color: '#5F5D54', fontSize: 10, marginTop: 3 }}>目标 ¥{fmt(r.subTarget)}</span> : null}</span>);
    if (view === 'dom' && r.first) return { children: inner, props: { rowSpan: r.rowSpan } };
    if (view === 'dom') return { children: null, props: { rowSpan: 0 } };
    return inner;
  };

  const columns: any[] = [
    { title: '领域', dataIndex: 'd', width: 128, render: (_: any, r: any) => r.kind === 'sub' ? { children: <span style={{ color: '#5F5D54', fontSize: 10.5 }}>领域小计</span>, props: { rowSpan: 0 } } : domCell(r) },
    { title: '特性', dataIndex: 'f', width: 150, render: (_: any, r: any) => r.kind === 'sub' ? null : (<span>{r.f.name}{r.f.isNew ? <Tag color="gold" style={{ marginLeft: 5, fontSize: 10 }}>新</Tag> : null}</span>) },
    { title: '声量', dataIndex: 'v', width: 66, align: 'right' as const, render: (_: any, r: any) => r.kind === 'sub' ? null : (r.f.voice > 0 ? <span style={mono}>{r.f.voice}</span> : <span style={{ color: '#B8B5AA' }}>—</span>) },
    { title: '上一代成本(¥)', dataIndex: 'prev', width: 96, align: 'right' as const, render: (_: any, r: any) => r.kind === 'sub' ? <span style={{ color: '#5F5D54' }}>{fmt(r.prevTotal)}</span> : <span style={mono}>{fmt(r.f.prevCost)}</span> },
    { title: '这一代目标(¥)', dataIndex: 'target', width: 108, align: 'right' as const, render: (_: any, r: any) => r.kind === 'sub' ? <b style={mono}>{fmt(r.subTarget)}</b> : (<InputNumber size="small" value={featTargets[featKey(r.d.name, r.f.name)]} onChange={v => setFeat(r.d.name, r.f.name, Number(v) || 0)} style={{ width: 88, borderColor: r.f.isNew ? '#D5A94E' : undefined }} min={0} />) },
    { title: '增减(¥)', dataIndex: 'delta', width: 76, align: 'right' as const, render: (_: any, r: any) => {
      const dlt = Math.round((((r.kind === 'sub' ? r.subTarget : (Number(featTargets[featKey(r.d.name, r.f.name)]) || 0)) - (r.kind === 'sub' ? r.prevTotal : r.f.prevCost))) * 100) / 100;
      return <span style={{ ...mono, color: dlt > 0 ? '#1F7A4C' : dlt < 0 ? '#C0392B' : '#8A877C', fontWeight: 600 }}>{dlt > 0 ? '+' : ''}{fmt(dlt)}</span>;
    } },
    { title: '分配依据', dataIndex: 'basis', render: (_: any, r: any) => r.kind === 'sub' ? null : (r.f.isNew ? <span style={{ fontSize: 10.5, color: '#A67C1F' }}>新特性 · 预算由你手输</span> : <span style={{ fontSize: 10.5, color: '#8A877C' }}>价值密度 {r.d.density} · 声量占比</span>) },
  ];

  const segBtn = (v: 'dom' | 'att', label: string) => (<button onClick={() => setView(v)} style={{ border: 'none', background: view === v ? '#fff' : 'transparent', fontSize: 11, fontWeight: 600, color: view === v ? '#181713' : '#5F5D54', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', boxShadow: view === v ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>{label}</button>);

  return (
    <div className="content-card" style={{ margin: 0, padding: 12, marginTop: 12 }}>
      <div className="card-header"><h3>目标成本制定（按上一代价值分配）</h3></div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 11.5, color: '#5F5D54' }}>参考上一代：</span>
        <Select showSearch optionFilterProp="label" placeholder="选择项目" style={{ width: 200 }} value={refPid || undefined} onChange={v => setRefPid(v)} options={projects.map((p: any) => ({ label: p.code + ' · ' + p.name, value: p.id }))} />
        <span style={{ fontSize: 11.5, color: '#5F5D54' }}>目标总成本（外部输入）：</span>
        <InputNumber prefix="¥" min={0} style={{ width: 130 }} value={targetTotal} onChange={v => setTargetTotal(Number(v) || 0)} />
        <Button type="primary" size="small" loading={loading} onClick={generate}>生成分配建议</Button>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', background: '#EFEDE4', borderRadius: 8, padding: 2, gap: 2 }}>{segBtn('dom', '按领域归集')}{segBtn('att', '按关注度')}</div>
      </div>
      {result ? (
        <div>
          <Table size="small" pagination={false} rowKey="key" dataSource={rows} columns={columns} rowClassName={(r: any) => r.kind === 'sub' ? 'ta-sub-row' : 'ta-feat-row'}
            summary={() => (
              <Table.Summary.Row style={{ background: '#F3F1E9' }}>
                <Table.Summary.Cell index={0} colSpan={4}><b>对账</b>　目标总成本 ¥{targetTotal} · 领域合计 ¥{fmt(total)}</Table.Summary.Cell>
                <Table.Summary.Cell index={1} colSpan={3}><b style={{ color: Math.abs(diff) < 0.5 ? '#1F7A4C' : '#C0392B' }}>差额 ¥{fmt(diff)}{Math.abs(diff) < 0.5 ? ' ✓' : '（调整特性目标使差额归零）'}</b></Table.Summary.Cell>
              </Table.Summary.Row>
            )} />
          <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button type="primary" size="small" loading={saving} onClick={save}>保存为领域目标</Button>
            <span style={{ fontSize: 10.5, color: '#8A877C' }}>特性目标可编辑（新特性预算你手输）→ 领域目标 = 特性合计，实时对账；保存后写入本项目领域目标 + 特性分配明细（重开可恢复）</span>
          </div>
        </div>
      ) : <div style={{ fontSize: 11.5, color: '#8A877C', padding: 8 }}>选参考上一代项目并输入目标总成本，点「生成分配建议」——按 价值密度（声量÷成本占比）分配目标到领域，领域内特性按声量展开；新特性（无声量）预算你手输。</div>}
    </div>
  );
}
