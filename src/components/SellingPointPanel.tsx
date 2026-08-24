// 卖点价值分析面板（v2.3.19，2026-08-18）：卖点 = 原声(声量/反响) × BOM(成本)
// 并入「用户原声分析」页；卖点挂项目（成本来源），成本按模块均分分摊（同模块多卖点不重复计算）；
// 声量由 AI 语义匹配原声维度（可人工改）；最后 AI 基于串起来的数据给取舍判断
import { useEffect, useMemo, useState } from 'react';
import { Card, Select, Button, Table, Tag, Input, message, Empty, Popconfirm, Space, Modal, Tooltip } from 'antd';
import { PlusOutlined, ThunderboltOutlined, RobotOutlined, DeleteOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import { getProjects, getProjectBOMs, getVoiceDimensions, getSellingPoints, addSellingPoint, updateSellingPoint, deleteSellingPoint, setSellingPointModules, setSellingPointDims, getSellingPointMaps, getSetting } from '../db';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { computeSellingPointRows, buildAiDimMatchPrompt, parseAiDimMatch, buildSellingPointAnalysisPrompt, type SellingPointRow } from '../sellingPointAnalyzer';

const KIND_TAG: Record<string, { color: string; text: string }> = {
  star: { color: 'red', text: '⭐强卖点' },
  fix: { color: 'orange', text: '⚠️待改进' },
  overinvest: { color: 'purple', text: '💸过度投入' },
  minor: { color: 'default', text: '○次要' },
};

export default function SellingPointPanel({ product }: { product: string }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<number | undefined>(undefined);
  const [sellingPoints, setSellingPoints] = useState<any[]>([]);
  const [spModules, setSpModules] = useState<Record<number, string[]>>({});
  const [spDims, setSpDims] = useState<Record<number, number[]>>({});
  const [moduleOptions, setModuleOptions] = useState<string[]>([]);
  const [moduleCosts, setModuleCosts] = useState<Record<string, number>>({});
  const [dims, setDims] = useState<any[]>([]);
  const [editing, setEditing] = useState<null | { id?: number; name: string; description: string; modules: string[]; dims: number[] }>(null);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [busy, setBusy] = useState(false);

  // 项目列表
  useEffect(() => { (async () => { try { setProjects(await getProjects('', '', '')); } catch { } })(); }, []);
  // 原声维度（随产品变化）
  useEffect(() => { (async () => { try { setDims(await getVoiceDimensions(product)); } catch { setDims([]); } })(); }, [product]);
  // 卖点 + 模块成本（随项目变化）
  useEffect(() => {
    if (!projectId) { setSellingPoints([]); setSpModules({}); setSpDims({}); setModuleOptions([]); setModuleCosts({}); return; }
    (async () => {
      try {
        setSellingPoints(await getSellingPoints(projectId));
        const maps = await getSellingPointMaps(projectId);
        setSpModules(maps.modules); setSpDims(maps.dims);
        const boms = await getProjectBOMs(projectId);
        const mods = new Set<string>(); const costs: Record<string, number> = {};
        boms.forEach((b: any) => { const m = b.module_name || '未归类'; mods.add(m); costs[m] = (costs[m] || 0) + (Number(b.part_cost) || 0) * (Number(b.quantity) || 1); });
        setModuleOptions([...mods]); setModuleCosts(costs);
      } catch { }
    })();
  }, [projectId]);

  const dimById = useMemo(() => { const m: Record<number, any> = {}; dims.forEach((d: any) => { m[d.id] = d; }); return m; }, [dims]);

  const rows: SellingPointRow[] = useMemo(() => computeSellingPointRows({
    sps: sellingPoints.map((s: any) => ({ id: s.id, name: s.name })),
    modules: spModules, dims: spDims, moduleCosts, dimById,
  }), [sellingPoints, spModules, spDims, moduleCosts, dimById]);

  const refreshMaps = async (pid: number) => {
    setSellingPoints(await getSellingPoints(pid));
    const maps = await getSellingPointMaps(pid);
    setSpModules(maps.modules); setSpDims(maps.dims);
  };

  const saveSellingPoint = async () => {
    if (!editing || !projectId) return;
    const name = editing.name.trim();
    if (!name) { message.warning('卖点名不能为空'); return; }
    let id = editing.id;
    if (id) await updateSellingPoint(id, name, editing.description);
    else id = await addSellingPoint(projectId, product, name, editing.description);
    await setSellingPointModules(id, editing.modules);
    await setSellingPointDims(id, editing.dims);
    setEditing(null);
    await refreshMaps(projectId);
    message.success('已保存卖点「' + name + '」');
  };

  const removeSellingPoint = async (id: number) => {
    await deleteSellingPoint(id);
    if (projectId) await refreshMaps(projectId);
  };

  const runAiMatch = async () => {
    if (!projectId || sellingPoints.length === 0 || dims.length === 0) { message.warning('需要先选项目、建卖点、并完成原声分析'); return; }
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）'); return; }
    setBusy(true);
    try {
      const { system, user } = buildAiDimMatchPrompt(sellingPoints.map((s: any) => s.name), dims.map((d: any) => d.name));
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
          t => { full += t; }, () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', think: false, json: false, num_predict: 16384 });
      });
      const matches = parseAiDimMatch(full);
      const dimNameToId: Record<string, number> = {};
      dims.forEach((d: any) => { dimNameToId[d.name] = d.id; });
      let mapped = 0;
      for (const m of matches) {
        let sp = sellingPoints.find((s: any) => s.name === m.selling_point);
        if (!sp) sp = sellingPoints.find((s: any) => s.name.includes(m.selling_point) || m.selling_point.includes(s.name));
        if (!sp) continue;
        const ids = m.dimensions.map((dn: string) => dimNameToId[dn]).filter((x: number) => !!x);
        if (ids.length) { await setSellingPointDims(sp.id, ids); setSpDims(prev => ({ ...prev, [sp.id]: ids })); mapped++; }
      }
      await logLocalAICall({ request_type: 'voice_analyze', system_prompt: system, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model });
      if (mapped === 0) message.warning('AI 未匹配到维度（可能卖点/维度名称差异较大），请手动勾选');
      else message.success('AI 已自动对应 ' + mapped + ' 个卖点的声量维度，请核对');
    } catch (e: any) { message.error('AI 匹配失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const runAiAnalysis = async () => {
    if (rows.length === 0) { message.warning('请先建卖点并关联模块/维度'); return; }
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）'); return; }
    setBusy(true);
    setAiAnalysis('');
    try {
      const { system, user } = buildSellingPointAnalysisPrompt(rows);
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
          t => { full += t; setAiAnalysis(full); }, () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', think: false, json: false, num_predict: 16384 });
      });
      setAiAnalysis(full);
      await logLocalAICall({ request_type: 'voice_analyze', system_prompt: system, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model });
    } catch (e: any) { message.error('AI 分析失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}><LinkOutlined /> 卖点价值分析（原声声量 × BOM成本）</div>
      <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10, lineHeight: 1.6 }}>
        把「用户原声提炼的特性」对应到「卖点」，再关联「BOM 模块」——自动算出每个卖点的 声量（在乎的人多）、好评率（市场反响）、成本（投入），串成一张表交给 AI 判断哪个卖点该放大/改进/砍掉。
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <Select style={{ width: 220 }} placeholder="选择项目（成本来源）" value={projectId} allowClear
          options={projects.map((p: any) => ({ value: p.id, label: (p.code || '') + ' ' + (p.name || '') }))}
          onChange={(v: number | undefined) => setProjectId(v)} showSearch optionFilterProp="label" />
        <Button icon={<ThunderboltOutlined />} loading={busy} onClick={runAiMatch} disabled={!projectId || sellingPoints.length === 0}>AI 自动对应维度</Button>
        <Button icon={<RobotOutlined />} loading={busy} onClick={runAiAnalysis} disabled={rows.length === 0}>AI 分析卖点价值</Button>
      </div>

      {!projectId ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选项目，再添加卖点" style={{ margin: '12px 0' }} />
      ) : (
        <>
          <div style={{ marginBottom: 6 }}>
            <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing({ name: '', description: '', modules: [], dims: [] })}>添加卖点</Button>
          </div>
          {sellingPoints.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有卖点，点「添加卖点」先建几个（如：2K高刷屏、广色域、Type-C直连）" style={{ margin: '8px 0' }} />
          ) : (
            <Table size="small" dataSource={rows} rowKey="id" pagination={false} style={{ marginBottom: 10 }}
              columns={[
                { title: '卖点', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
                { title: '🔥声量', dataIndex: 'count', width: 70, align: 'center', render: (v: number) => <b style={{ color: '#0A84FF' }}>{v}</b> },
                { title: '💬好评率', key: 'q', width: 84, align: 'center', render: (_: any, r: SellingPointRow) => { const q = Math.round(r.quality * 100); return <Tag color={q >= 60 ? 'green' : q >= 30 ? 'orange' : 'red'}>{q}%</Tag>; } },
                { title: '👍/👎', key: 'pn', width: 70, align: 'center', render: (_: any, r: SellingPointRow) => <span style={{ fontSize: 11 }}><span style={{ color: '#10B981' }}>{r.positive}</span>/<span style={{ color: '#DC2626' }}>{r.negative}</span></span> },
                { title: '💰成本', dataIndex: 'cost', width: 80, align: 'right', render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{v.toFixed(0)}</span> },
                { title: '声量成本比', dataIndex: 'costRatio', width: 84, align: 'center', render: (v: number, r: SellingPointRow) => <Tooltip title="每千元成本带来的声量（越大越划算）"><span>{r.cost > 0 ? v : '—'}</span></Tooltip> },
                { title: '类型', key: 'kind', width: 96, align: 'center', render: (_: any, r: SellingPointRow) => <Tag color={KIND_TAG[r.kind].color}>{KIND_TAG[r.kind].text}</Tag> },
                { title: '关联', key: 'maps', render: (_: any, r: SellingPointRow) => (
                  <div style={{ fontSize: 11, color: '#64748B', lineHeight: 1.5 }}>
                    {r.modules.length > 0 && <div>模块：{r.modules.map(m => <Tag key={m} style={{ margin: 1 }} color="blue">{m}{r.sharedModules.includes(m) ? '·分摊' : ''}</Tag>)}</div>}
                    {r.dimNames.length > 0 && <div>声量：{r.dimNames.map(d => <Tag key={d} style={{ margin: 1 }} color="cyan">{d}</Tag>)}</div>}
                  </div>
                ) },
                { title: '', key: 'ops', width: 100, render: (_: any, r: SellingPointRow) => {
                  const sp = sellingPoints.find((s: any) => s.id === r.id);
                  return <Space size={4}>
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ id: r.id, name: r.name, description: sp?.description || '', modules: r.modules, dims: spDims[r.id] || [] })} />
                    <Popconfirm title="删除这个卖点？" onConfirm={() => removeSellingPoint(r.id)}><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Popconfirm>
                  </Space>;
                } },
              ]} />
          )}
        </>
      )}

      {aiAnalysis && (
        <div style={{ marginTop: 8, background: '#FAFBFC', border: '1px solid #EEF1F4', borderRadius: 8, padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 12, color: '#334155', lineHeight: 1.7 }}>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 4 }}>🤖 AI 卖点价值判断（基于上表数据）：</div>
          {aiAnalysis}
        </div>
      )}

      <Modal open={!!editing} title={editing?.id ? '编辑卖点' : '添加卖点'} onOk={saveSellingPoint} onCancel={() => setEditing(null)} okText="保存" cancelText="取消" width={560}>
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>卖点名</div>
              <Input value={editing.name} placeholder="如：2K高刷屏 / 广色域 / Type-C直连" onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>描述（可选）</div>
              <Input value={editing.description} placeholder="一句话说明这个卖点" onChange={e => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>关联 BOM 模块（成本来源，可多选；同模块被多个卖点引用会自动均分）</div>
              <Select mode="multiple" style={{ width: '100%' }} value={editing.modules} options={moduleOptions.map(m => ({ value: m, label: m }))} onChange={(v: string[]) => setEditing({ ...editing, modules: v })} placeholder="选择模块" />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>关联原声维度（声量/好评率来源，可多选；也可点「AI 自动对应维度」）</div>
              <Select mode="multiple" style={{ width: '100%' }} value={editing.dims} options={dims.map(d => ({ value: d.id, label: d.name }))} onChange={(v: number[]) => setEditing({ ...editing, dims: v })} placeholder="选择维度" />
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
