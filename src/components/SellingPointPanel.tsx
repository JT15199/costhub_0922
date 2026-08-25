// 卖点价值分析面板（v2.3.19，2026-08-18）：上一代已上市不可改，原声×成本 = 下一代产品定义指导
// 统一流程：选项目 → AI 自动分析主要卖点+对应模块（用户可改）→ 归纳原声 → 模块级价值分析 → AI 给下一代建议
// 成本：模块级精确不摊；卖点级用声量加权分摊（同模块多卖点时）
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Select, Button, Table, Tag, Input, message, Empty, Popconfirm, Space, Modal, Tooltip } from 'antd';
import { PlusOutlined, ThunderboltOutlined, RobotOutlined, DeleteOutlined, EditOutlined, LinkOutlined, SyncOutlined } from '@ant-design/icons';
import { getProjects, getProjectBOMs, getAllVoiceItems, getSellingPoints, addSellingPoint, updateSellingPoint, deleteSellingPoint, setSellingPointModules, getSellingPointMaps, setSellingPointVoice, getProjectSpecTemplates, saveProjectSpecTemplate, deleteProjectSpecTemplate, getSetting } from '../db';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { chunkVoiceItems } from '../voiceAnalyer';
import { computeSellingPointRows, computeModuleValueRows, buildAiUnifiedPrompt, parseAiUnified, buildAiAggregatePrompt, parseAiAggregate, buildSellingPointAnalysisPrompt, type SellingPointRow, type ModuleValueRow } from '../sellingPointAnalyzer';
import ModuleValueMatrix from './ModuleValueMatrix';

const MOD_KIND_TAG: Record<string, { color: string; text: string }> = {
  cheap_good: { color: 'green', text: '✅好又便宜' },
  good_expensive: { color: 'blue', text: '💰好但贵·降本' },
  bad: { color: 'orange', text: '⚠️做得差' },
  waste: { color: 'red', text: '❌花得不值' },
  minor: { color: 'default', text: '○次要' },
};

export default function SellingPointPanel({ product }: { product: string }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<number | undefined>(undefined);
  const [sellingPoints, setSellingPoints] = useState<any[]>([]);
  const [spModules, setSpModules] = useState<Record<number, string[]>>({});
  const [moduleOptions, setModuleOptions] = useState<string[]>([]);
  const [moduleCosts, setModuleCosts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<null | { id?: number; name: string; description: string; modules: string[] }>(null);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceCount, setVoiceCount] = useState(0);
  const [status, setStatus] = useState('');
  const [specs, setSpecs] = useState<any[]>([]);
  const [specModal, setSpecModal] = useState<null | { id?: number; name: string; value: string }>(null);
  const [viewMode, setViewMode] = useState<'table' | 'chart'>('chart');
  const analyzedRef = useRef<number | null>(null);

  useEffect(() => { (async () => { try { setProjects(await getProjects('', '', '')); } catch { } })(); }, []);
  useEffect(() => { (async () => { try { setVoiceCount((await getAllVoiceItems(product)).length); } catch { setVoiceCount(0); } })(); }, [product]);

  const refreshMaps = async (pid: number) => {
    setSellingPoints(await getSellingPoints(pid));
    const maps = await getSellingPointMaps(pid);
    setSpModules(maps.modules);
  };

  const runUnifiedAnalyze = async (modOptions: string[], replace = false) => {
    const proj = projects.find((p: any) => p.id === projectId);
    if (!proj || modOptions.length === 0) { message.warning('该项目 BOM 无模块，无法自动分析卖点'); return; }
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）'); return; }
    setBusy(true);
    setStatus('AI 正在分析卖点与对应模块…');
    try {
      const { system, user } = buildAiUnifiedPrompt({ tier: proj.tier, category: proj.category }, modOptions, specs.map((s: any) => ({ name: s.spec_name, value: s.spec_value })));
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
          t => { full += t; }, () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', think: false, json: false, num_predict: 16384 });
      });
      const parsed = parseAiUnified(full);
      await logLocalAICall({ request_type: 'voice_analyze', system_prompt: system, user_prompt: user, response_summary: full.slice(0, 200), success: parsed.length > 0, error_message: parsed.length ? '' : full.slice(0, 200), model_name: model });
      if (parsed.length === 0) {
        message.warning('AI 未识别出卖点（模型输出：' + full.trim().replace(/\s+/g, ' ').slice(0, 120) + '），请手动添加');
        return;
      }
      if (replace) {
        const existing = await getSellingPoints(projectId!);
        for (const sp of existing) await deleteSellingPoint(sp.id);
      }
      let added = 0;
      for (const p of parsed) {
        const id = await addSellingPoint(projectId!, product, p.name, p.description);
        const mods = p.modules.filter(m => modOptions.includes(m));
        await setSellingPointModules(id, mods);
        added++;
      }
      await refreshMaps(projectId!);
      message.success('AI 已按「' + (proj.tier || '') + ' ' + (proj.category || '') + '」生成 ' + added + ' 个卖点并关联模块，可继续编辑');
    } catch (e: any) { message.error('智能分析失败：' + (e?.message || e)); }
    finally { setBusy(false); setStatus(''); }
  };

  // 选项目后：加载卖点/BOM；若没有卖点 → 自动跑一次 AI 分析（用户可改）
  useEffect(() => {
    if (!projectId) { setSellingPoints([]); setSpModules({}); setModuleOptions([]); setModuleCosts({}); return; }
    (async () => {
      try {
        const sps = await getSellingPoints(projectId);
        setSellingPoints(sps);
        const maps = await getSellingPointMaps(projectId);
        setSpModules(maps.modules);
        const boms = await getProjectBOMs(projectId);
        const mods = new Set<string>(); const costs: Record<string, number> = {};
        boms.forEach((b: any) => { const m = b.module_name || '未归类'; mods.add(m); costs[m] = (costs[m] || 0) + (Number(b.part_cost) || 0) * (Number(b.quantity) || 1); });
        const modList = [...mods];
        setModuleOptions(modList); setModuleCosts(costs);
        try { setSpecs(await getProjectSpecTemplates(projectId)); } catch { setSpecs([]); }
        if (sps.length === 0 && analyzedRef.current !== projectId && modList.length > 0) {
          analyzedRef.current = projectId;
          runUnifiedAnalyze(modList);
        }
      } catch { }
    })();
  }, [projectId]);

  const rows: SellingPointRow[] = useMemo(() => computeSellingPointRows({
    sps: sellingPoints.map((s: any) => ({ id: s.id, name: s.name, positive: s.positive, negative: s.negative })),
    modules: spModules, moduleCosts,
  }), [sellingPoints, spModules, moduleCosts]);
  const moduleRows: ModuleValueRow[] = useMemo(() => computeModuleValueRows(rows, moduleCosts), [rows, moduleCosts]);

  const saveSellingPoint = async () => {
    if (!editing || !projectId) return;
    const name = editing.name.trim();
    if (!name) { message.warning('卖点名不能为空'); return; }
    let id = editing.id;
    if (id) await updateSellingPoint(id, name, editing.description);
    else id = await addSellingPoint(projectId, product, name, editing.description);
    await setSellingPointModules(id, editing.modules);
    setEditing(null);
    await refreshMaps(projectId);
    message.success('已保存卖点「' + name + '」');
  };

  const removeSellingPoint = async (id: number) => {
    await deleteSellingPoint(id);
    if (projectId) await refreshMaps(projectId);
  };

  const saveSpec = async () => {
    if (!specModal || !projectId) return;
    const name = specModal.name.trim();
    if (!name) { message.warning('规格分类名不能为空'); return; }
    await saveProjectSpecTemplate(projectId, name, specModal.value, specModal.id);
    setSpecModal(null);
    try { setSpecs(await getProjectSpecTemplates(projectId)); } catch { }
  };
  const removeSpec = async (id: number) => {
    await deleteProjectSpecTemplate(id);
    setSpecModal(null);
    try { setSpecs(await getProjectSpecTemplates(projectId!)); } catch { }
  };

  const runAggregate = async () => {
    if (!projectId || sellingPoints.length === 0) { message.warning('先选项目并添加卖点'); return; }
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）'); return; }
    const items = (await getAllVoiceItems(product)).map((i: any) => i.content);
    if (items.length === 0) { message.warning('该产品暂无原声，请先在上方导入'); return; }
    setBusy(true);
    try {
      const blocks = chunkVoiceItems(items, 3000);
      const spNames = sellingPoints.map((s: any) => s.name);
      const agg: Record<string, { positive: number; negative: number }> = {};
      for (let i = 0; i < blocks.length; i++) {
        setStatus('正在归纳第 ' + (i + 1) + '/' + blocks.length + ' 块原声…');
        const { system, user } = buildAiAggregatePrompt(spNames, blocks[i].items);
        let full = '';
        await new Promise<void>((resolve, reject) => {
          startOllamaStream(base, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
            t => { full += t; }, () => {}, () => resolve(), e => reject(new Error(e)),
            { endpoint: 'native', think: false, json: false, num_predict: 16384 });
        });
        const parsed = parseAiAggregate(full);
        for (const it of parsed) {
          for (const sp of it.selling_points) {
            if (sp === '其他' || sp === '其它') continue;
            const a = agg[sp] = agg[sp] || { positive: 0, negative: 0 };
            if (it.sentiment === 'negative') a.negative++; else a.positive++;
          }
        }
        await logLocalAICall({ request_type: 'voice_analyze', system_prompt: system, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model });
      }
      setStatus('');
      let updated = 0;
      for (const [name, v] of Object.entries(agg)) {
        let sp = sellingPoints.find((s: any) => s.name === name);
        if (!sp) sp = sellingPoints.find((s: any) => s.name.includes(name) || name.includes(s.name));
        if (!sp) continue;
        await setSellingPointVoice(sp.id, v.positive, v.negative);
        updated++;
      }
      setSellingPoints(await getSellingPoints(projectId));
      message.success('已归纳 ' + items.length + ' 条原声到 ' + updated + ' 个卖点（声量=提及人数）');
    } catch (e: any) { message.error('归纳失败：' + (e?.message || e)); }
    finally { setBusy(false); setStatus(''); }
  };

  const runAiAnalysis = async () => {
    if (moduleRows.length === 0) { message.warning('请先完成 AI 智能分析、关联模块并归纳原声'); return; }
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）'); return; }
    setBusy(true);
    setAiAnalysis('');
    try {
      const { system, user } = buildSellingPointAnalysisPrompt(rows, moduleRows);
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

  const maxRatio = Math.max(...rows.map(r => r.costRatio), 1);

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}><LinkOutlined /> 卖点价值分析（上一代原声 × 成本 → 下一代产品定义指导）</div>
      <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10, lineHeight: 1.6 }}>
        已上市的上代产品无法改变，但它的用户原声（声量/好评）和 BOM 成本是下一代定义的最好参考：选项目后 AI 自动分析主要卖点与对应模块，你可修改；再归纳原声，看哪个模块好又便宜、差又贵、花得不值，AI 给出下一代表保留/降本/减配的建议。
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <Select style={{ width: 240 }} placeholder="选择项目（上代产品，品类+档位）" value={projectId} allowClear
          options={projects.map((p: any) => ({ value: p.id, label: (p.code || '') + ' ' + (p.name || '') + (p.tier ? ' · ' + p.tier : '') }))}
          onChange={(v: number | undefined) => setProjectId(v)} showSearch optionFilterProp="label" />
        <Button className="tappable" icon={<SyncOutlined />} loading={busy} onClick={() => runUnifiedAnalyze(moduleOptions, true)} disabled={!projectId}>重新智能分析</Button>
        <Button className="tappable" icon={<ThunderboltOutlined />} loading={busy} onClick={runAggregate} disabled={!projectId || sellingPoints.length === 0 || voiceCount === 0}>归纳原声（{voiceCount} 条）</Button>
        <Button className="tappable" icon={<RobotOutlined />} loading={busy} onClick={runAiAnalysis} disabled={moduleRows.length === 0}>AI 下一代定义建议</Button>
      </div>
      {status && <div style={{ fontSize: 11.5, color: '#0A84FF', marginBottom: 8 }}>⏳ {status}</div>}

      {projectId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>⚙ 规格分类（AI 分析靠齐目标）：</span>
          {specs.length === 0 && <span style={{ fontSize: 10.5, color: '#94A3B8' }}>还没有——加几个（如 分辨率/刷新率/色域），AI 智能分析会严格按这些分类生成卖点，原声也归到这些类</span>}
          {specs.map((s: any) => (
            <Tag key={s.id} color="geekblue" style={{ margin: 0, cursor: 'pointer', fontSize: 11 }} onClick={() => setSpecModal({ id: s.id, name: s.spec_name, value: s.spec_value })}>
              {s.spec_name}{s.spec_value ? '：' + s.spec_value : ''}
            </Tag>
          ))}
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setSpecModal({ name: '', value: '' })}>加规格</Button>
        </div>
      )}

      {!projectId ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选一个上代产品项目，AI 会自动分析它的卖点和对应模块" style={{ margin: '12px 0' }} />
      ) : (
        <>
          {moduleRows.length > 0 && (
            <div className="pop-in" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>🧩 模块价值分析（声量 × 成本 × 好评）</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button className="tappable" onClick={() => setViewMode('chart')} style={{ padding: '2px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: viewMode === 'chart' ? '1px solid #181713' : '1px solid #E6E4DC', background: viewMode === 'chart' ? '#181713' : '#fff', color: viewMode === 'chart' ? '#fff' : '#5F5D54' }}>图表</button>
                  <button className="tappable" onClick={() => setViewMode('table')} style={{ padding: '2px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: viewMode === 'table' ? '1px solid #181713' : '1px solid #E6E4DC', background: viewMode === 'table' ? '#181713' : '#fff', color: viewMode === 'table' ? '#fff' : '#5F5D54' }}>表格</button>
                </span>
              </div>
              {viewMode === 'table' && (<Table size="small" dataSource={moduleRows} rowKey="module" pagination={false}
                columns={[
                  { title: '模块', dataIndex: 'module', render: (v: string) => <b>{v}</b> },
                  { title: '💰成本', dataIndex: 'cost', width: 80, align: 'right', render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{v.toFixed(0)}</span> },
                  { title: '🔥声量', dataIndex: 'count', width: 70, align: 'center', render: (v: number) => <b style={{ color: '#0A84FF', fontSize: 14 }}>{v}</b> },
                  { title: '💬好评率', key: 'q', width: 84, align: 'center', render: (_: any, r: ModuleValueRow) => { const q = Math.round(r.quality * 100); return <Tag color={q >= 60 ? 'green' : q >= 30 ? 'orange' : 'red'}>{q}%</Tag>; } },
                  { title: '类型', key: 'kind', width: 122, align: 'center', render: (_: any, r: ModuleValueRow) => <Tag color={MOD_KIND_TAG[r.kind].color}>{MOD_KIND_TAG[r.kind].text}</Tag> },
                  { title: '支撑卖点', key: 'sps', render: (_: any, r: ModuleValueRow) => <span style={{ fontSize: 11, color: '#64748B' }}>{r.sellingPoints.join('、') || '—'}</span> },
                ]} />)}
              {viewMode === 'chart' && <ModuleValueMatrix rows={moduleRows} />}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Button className="tappable" size="small" icon={<PlusOutlined />} onClick={() => setEditing({ name: '', description: '', modules: [] })}>手动添加/编辑卖点</Button>
            <span style={{ fontSize: 11, color: '#94A3B8' }}>
              {moduleRows.filter(x => x.kind === 'cheap_good').length > 0 && <Tag color="green" style={{ marginRight: 4 }}>✅ {moduleRows.filter(x => x.kind === 'cheap_good').length} 好又便宜</Tag>}
              {moduleRows.filter(x => x.kind === 'waste').length > 0 && <Tag color="red" style={{ marginRight: 4 }}>❌ {moduleRows.filter(x => x.kind === 'waste').length} 花得不值</Tag>}
              {moduleRows.filter(x => x.kind === 'bad').length > 0 && <Tag color="orange" style={{ marginRight: 4 }}>⚠️ {moduleRows.filter(x => x.kind === 'bad').length} 做得差</Tag>}
              {moduleRows.filter(x => x.kind === 'good_expensive').length > 0 && <Tag color="blue">💰 {moduleRows.filter(x => x.kind === 'good_expensive').length} 好但贵</Tag>}
            </span>
          </div>
          {sellingPoints.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="AI 正在分析卖点，或点击「重新智能分析」/「手动添加卖点」" style={{ margin: '8px 0' }} />
          ) : (
            <Table size="small" dataSource={rows} rowKey="id" pagination={false} style={{ marginBottom: 10 }}
              columns={[
                { title: '卖点', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
                { title: '🔥声量', dataIndex: 'count', width: 70, align: 'center', render: (v: number) => <b style={{ color: '#0A84FF', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{v}</b> },
                { title: '💬好评率', key: 'q', width: 84, align: 'center', render: (_: any, r: SellingPointRow) => { const q = Math.round(r.quality * 100); return <Tag color={q >= 60 ? 'green' : q >= 30 ? 'orange' : 'red'}>{q}%</Tag>; } },
                { title: '👍/👎', key: 'pn', width: 70, align: 'center', render: (_: any, r: SellingPointRow) => <span style={{ fontSize: 11 }}><span style={{ color: '#10B981' }}>{r.positive}</span>/<span style={{ color: '#DC2626' }}>{r.negative}</span></span> },
                { title: '💰成本(分摊)', dataIndex: 'cost', width: 96, align: 'right', render: (v: number) => <Tooltip title="声量加权分摊（同模块多卖点时按声量占比分）"><span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{v.toFixed(0)}</span></Tooltip> },
                { title: '声量成本比', key: 'ratio', width: 100, align: 'center', render: (_: any, r: SellingPointRow) => {
                  const pct = r.cost > 0 ? Math.min(100, Math.round((r.costRatio / maxRatio) * 100)) : 0;
                  return <Tooltip title="每千元成本带来的声量（越大越划算）"><div style={{ width: 72, margin: '0 auto' }}>
                    <div className="sp-ratio-bar"><div style={{ width: pct + '%' }} /></div>
                    <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 2 }}>{r.cost > 0 ? r.costRatio : '—'}</div>
                  </div></Tooltip>;
                } },
                { title: '关联模块', key: 'maps', render: (_: any, r: SellingPointRow) => (
                  <div style={{ fontSize: 11, color: '#64748B', lineHeight: 1.5 }}>
                    {r.modules.length > 0 ? r.modules.map(m => <Tag key={m} style={{ margin: 1 }} color="blue">{m}{r.sharedModules.includes(m) ? '·分摊' : ''}</Tag>) : <span style={{ color: '#94A3B8' }}>未关联</span>}
                  </div>
                ) },
                { title: '', key: 'ops', width: 100, render: (_: any, r: SellingPointRow) => {
                  const sp = sellingPoints.find((s: any) => s.id === r.id);
                  return <Space size={4} className="sp-row-ops">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ id: r.id, name: r.name, description: sp?.description || '', modules: r.modules })} />
                    <Popconfirm title="删除这个卖点？" onConfirm={() => removeSellingPoint(r.id)}><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Popconfirm>
                  </Space>;
                } },
              ]} />
          )}
        </>
      )}

      {aiAnalysis && (
        <div className="pop-in" style={{ marginTop: 8, background: '#FAFBFC', border: '1px solid #EEF1F4', borderRadius: 8, padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 12, color: '#334155', lineHeight: 1.7 }}>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 4 }}>🤖 AI 下一代产品定义建议（基于上表数据）：</div>
          {aiAnalysis}
        </div>
      )}

      <Modal open={!!editing} title={editing?.id ? '编辑卖点' : '添加卖点'} onOk={saveSellingPoint} onCancel={() => setEditing(null)} okText="保存" cancelText="取消" width={540}>
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>卖点名（归纳大类，别太细）</div>
              <Input value={editing.name} placeholder="如：2K高刷屏 / 广色域 / Type-C直连" onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>描述（可选）</div>
              <Input value={editing.description} placeholder="一句话说明这个卖点" onChange={e => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>关联 BOM 模块（成本来源，可多选；同模块被多个卖点引用时按声量加权分摊）</div>
              <Select mode="multiple" style={{ width: '100%' }} value={editing.modules} options={moduleOptions.map(m => ({ value: m, label: m }))} onChange={(v: string[]) => setEditing({ ...editing, modules: v })} placeholder="选择模块" />
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!specModal} title="规格分类（每项目）" onCancel={() => setSpecModal(null)} width={420}
        footer={[
          <Button key="d" danger style={{ float: 'left' }} disabled={!specModal?.id} onClick={() => specModal?.id && removeSpec(specModal.id)}>删除</Button>,
          <Button key="c" onClick={() => setSpecModal(null)}>取消</Button>,
          <Button key="o" type="primary" onClick={saveSpec}>保存</Button>,
        ]}>
        {specModal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><div style={{ fontSize: 12, marginBottom: 4 }}>规格分类名（如 分辨率 / 刷新率 / 色域）</div><Input value={specModal.name} onChange={e => setSpecModal({ ...specModal, name: e.target.value })} placeholder="如 分辨率" /></div>
            <div><div style={{ fontSize: 12, marginBottom: 4 }}>该项目的参考规格值（可选，如 2K 2560×1440）</div><Input value={specModal.value} onChange={e => setSpecModal({ ...specModal, value: e.target.value })} placeholder="如 2K 2560×1440" /></div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
