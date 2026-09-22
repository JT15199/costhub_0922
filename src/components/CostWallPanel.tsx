import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Empty, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import {
  createProjectCompetitiveDimension,
  getCompetitorBOMs,
  getCompetitors,
  getProjectCompetitiveDimensions,
  getProjectModuleFeatureLinks,
  getScores,
  saveScore,
  setProjectModuleFeatureLinks,
  updateProjectCompetitiveDimension,
} from '../db';
import { bomPriceState, bomQuantityState } from '../ai/contracts';

function money(value: unknown) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '待补证据' : `¥${Number(value).toFixed(2)}`;
}

function scoreValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function CostWallPanel({ projectId, project, boms }: { projectId: number; project?: any; boms: any[] }) {
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [competitorId, setCompetitorId] = useState<number>();
  const [competitorBOM, setCompetitorBOM] = useState<any[]>([]);
  const [features, setFeatures] = useState<any[]>([]);
  const [links, setLinks] = useState<Record<string, number[]>>({});
  const [ourScores, setOurScores] = useState<Record<number, number | null>>({});
  const [theirScores, setTheirScores] = useState<Record<number, number | null>>({});
  const [loading, setLoading] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [draftDimensions, setDraftDimensions] = useState<any[]>([]);
  const [draftLinks, setDraftLinks] = useState<Record<string, number[]>>({});
  const [newDimension, setNewDimension] = useState('');
  const loadSeq = useRef(0);

  useEffect(() => {
    const seq = ++loadSeq.current;
    (async () => {
      try {
        const [cs, dimensions, projectLinks] = await Promise.all([
          getCompetitors(project?.category || ''),
          getProjectCompetitiveDimensions(projectId),
          getProjectModuleFeatureLinks(projectId),
        ]);
        if (seq !== loadSeq.current) return;
        setCompetitors(cs);
        setFeatures(dimensions.filter((row: any) => Number(row.enabled) !== 0));
        setLinks(projectLinks);
        setCompetitorId(cs[0]?.id);
      } catch (error: any) {
        if (seq !== loadSeq.current) return;
        message.error(`成本长城加载失败：${String(error?.message || error).slice(0, 100)}`);
      }
    })();
  }, [project?.category, projectId]);

  useEffect(() => {
    if (!competitorId) return;
    const seq = ++loadSeq.current;
    (async () => {
      setLoading(true);
      try {
        const [cb, os, ts] = await Promise.all([
          getCompetitorBOMs(competitorId),
          getScores('project', projectId),
          getScores('competitor', competitorId),
        ]);
        if (seq !== loadSeq.current) return;
        setCompetitorBOM(cb); setOurScores(os); setTheirScores(ts);
      } finally { setLoading(false); }
    })();
  }, [competitorId, projectId]);

  const ownTotal = useMemo(() => boms.length && boms.every(row => bomPriceState(row) === 'confirmed' && bomQuantityState(row) === 'confirmed') ? boms.reduce((sum, row) => sum + Number(row.part_cost) * Number(row.quantity), 0) : null, [boms]);
  const theirTotal = useMemo(() => competitorBOM.length && competitorBOM.every(row => row.estimated_cost != null && Number.isFinite(Number(row.estimated_cost)) && row.quantity != null && Number.isFinite(Number(row.quantity)) && Number(row.quantity) >= 0) ? competitorBOM.reduce((sum, row) => sum + Number(row.estimated_cost) * Number(row.quantity), 0) : null, [competitorBOM]);
  const moduleOptions = useMemo(() => Array.from(new Set([
    ...boms.map(row => row.module_name),
    ...competitorBOM.map(row => row.module_name),
    ...Object.keys(links),
  ].filter(Boolean))) as string[], [boms, competitorBOM, links]);
  const rows = useMemo(() => features.map(feature => {
    const featureId = Number(feature.feature_id || feature.id);
    const modules = Object.entries(links).filter(([, ids]) => ids.includes(featureId)).map(([name]) => name);
    const ownRows = boms.filter(row => modules.includes(row.module_name));
    const theirRows = competitorBOM.filter(row => modules.includes(row.module_name));
    const own = modules.length && ownRows.length && ownRows.every(row => bomPriceState(row) === 'confirmed' && bomQuantityState(row) === 'confirmed') ? ownRows.reduce((sum, row) => sum + Number(row.part_cost) * Number(row.quantity), 0) : null;
    const theirs = modules.length && theirRows.length && theirRows.every(row => row.estimated_cost != null && Number.isFinite(Number(row.estimated_cost)) && row.quantity != null && Number.isFinite(Number(row.quantity)) && Number(row.quantity) >= 0) ? theirRows.reduce((sum, row) => sum + Number(row.estimated_cost) * Number(row.quantity), 0) : null;
    const ourScore = scoreValue(ourScores[featureId]);
    const theirScore = scoreValue(theirScores[featureId]);
    const specDiff = ourScore === null || theirScore === null ? null : ourScore - theirScore;
    return { key: featureId, feature: feature.name, ourScore, theirScore, specDiff, costDiff: own === null || theirs === null ? null : own - theirs, mapped: modules.length ? modules.join('、') : '未配置模块映射' };
  }), [features, links, boms, competitorBOM, ourScores, theirScores, ownTotal, theirTotal]);
  const costAxis = Math.max(1, ...rows.filter(row => row.costDiff !== null).map(row => Math.abs(Number(row.costDiff!.toFixed(2)))));
  const scoreAxis = Math.max(2, ...rows.map(row => row.specDiff === null ? 0 : Math.abs(Number(row.specDiff.toFixed(1)))));

  const openConfig = async () => {
    try {
      const [dimensions, projectLinks] = await Promise.all([getProjectCompetitiveDimensions(projectId), getProjectModuleFeatureLinks(projectId)]);
      setDraftDimensions(dimensions.map(row => ({ ...row })));
      setDraftLinks(projectLinks);
      setNewDimension('');
      setConfigOpen(true);
    } catch (error: any) { message.error(`配置读取失败：${String(error?.message || error).slice(0, 100)}`); }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const ids = new Map<number, number>();
      const names = new Set<string>();
      for (const row of draftDimensions) {
        const name = String(row.name || '').trim();
        if (!name) throw new Error('维度名称不能为空');
        if (names.has(name)) throw new Error(`维度“${name}”重复`);
        names.add(name);
        const id = Number(row.feature_id);
        const savedId = id > 0 ? id : Number(await createProjectCompetitiveDimension(projectId, name));
        if (id > 0) await updateProjectCompetitiveDimension(projectId, id, name, Number(row.enabled) !== 0 ? 1 : 0);
        ids.set(id, savedId);
      }
      const modules = new Set([...moduleOptions, ...Object.keys(draftLinks)]);
      await Promise.all([...modules].map(module => setProjectModuleFeatureLinks(projectId, module, (draftLinks[module] || []).map(id => ids.get(id) || id).filter(id => id > 0))));
      const dimensions = await getProjectCompetitiveDimensions(projectId);
      setFeatures(dimensions.filter((row: any) => Number(row.enabled) !== 0));
      setLinks(await getProjectModuleFeatureLinks(projectId));
      setConfigOpen(false);
      message.success('已保存当前项目的成本长城配置');
    } catch (error: any) { message.error(String(error?.message || error)); }
    finally { setSavingConfig(false); }
  };

  const addDraftDimension = () => {
    const name = newDimension.trim();
    if (!name) return;
    setDraftDimensions(list => [...list, { feature_id: -Date.now(), name, sort_order: list.length + 1, enabled: 1 }]);
    setNewDimension('');
  };

  const chart = {
    tooltip: {
      trigger: 'axis',
      formatter: (params: any[]) => {
        const items = Array.isArray(params) ? params : [params];
          return items.length ? [`${items[0]?.axisValue || ''}`, ...items.filter(item => item.value !== null).map(item => {
          const value = Number(item.value || 0);
          return `${item.marker || ''}${item.seriesName}：${item.seriesName.includes('成本') ? money(value) : `${value > 0 ? '+' : ''}${value.toFixed(1)} 分`}`;
        })].join('<br/>') : '';
      },
    },
    legend: { type: 'scroll', top: 0, left: 'center', itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 10, color: '#718198' }, data: ['规格差异（我方−竞品）', '成本差异（我方−竞品）'] },
    grid: { left: 50, right: 68, top: 44, bottom: rows.length > 5 ? 70 : 52 },
    xAxis: { type: 'category', data: rows.map(row => row.feature), axisLabel: { interval: 0, rotate: rows.length > 5 ? 24 : 0, width: 58, overflow: 'truncate', fontSize: 10, color: '#718198' }, axisTick: { alignWithLabel: true } },
    yAxis: [{ type: 'value', name: '规格分', min: -scoreAxis, max: scoreAxis, nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10, formatter: (value: number) => Number(value).toFixed(0) } }, { type: 'value', name: '成本差额', min: -costAxis, max: costAxis, nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10, formatter: (value: number) => money(value) } }],
    series: [{ name: '规格差异（我方−竞品）', type: 'bar', data: rows.map(row => row.specDiff === null ? null : Number(row.specDiff.toFixed(1))), barMaxWidth: 22, label: { show: true, position: 'top', formatter: (p: any) => p.value === null ? '' : `${Number(p.value) > 0 ? '+' : ''}${Number(p.value).toFixed(1)}`, fontSize: 10 }, itemStyle: { color: (params: any) => Number(params.value) >= 0 ? '#5B8FF9' : '#2A9D8F' } }, { name: '成本差异（我方−竞品）', type: 'line', yAxisIndex: 1, data: rows.map(row => row.costDiff === null ? null : Number(row.costDiff.toFixed(2))), showSymbol: true, symbolSize: 6, label: { show: false }, itemStyle: { color: (params: any) => Number(params.value) >= 0 ? '#E76F51' : '#2A9D8F' }, lineStyle: { width: 2 } }],
  };

  return <>
    <Card size="small" title="成本长城" extra={<Space size={6} wrap><Select size="small" value={competitorId} loading={loading} placeholder="选择一个竞品" onChange={setCompetitorId} options={competitors.map(row => ({ value: row.id, label: `${row.brand} ${row.model}` }))} style={{ width: 210 }} /><Button size="small" icon={<SettingOutlined />} onClick={() => void openConfig()}>编辑维度与支撑模块</Button></Space>}>
      {competitorId && rows.length ? <>
        <div className="cost-wall-howto"><strong>怎么用</strong><span>① 选择同档竞品</span><span>② 给双方各维度按 0–10 分评分</span><span>③ 点右上角编辑本项目维度和支撑模块</span></div>
        <div className="planning-note">规格差异 = 我方分 − 竞品分；成本差异 = 我方成本 − 竞品成本。当前竞品整机 BOM {money(theirTotal)}，我方 {money(ownTotal)}；未配置支撑模块时成本差异留空，避免把整机差额误归因到单一维度。</div>
        <ReactECharts echarts={echarts} option={chart} style={{ height: 300 }} />
        <Table size="small" pagination={false} dataSource={rows} columns={[
          { title: '维度', dataIndex: 'feature' },
          { title: '我方分', dataIndex: 'ourScore', render: (v: number | null, row: any) => <InputNumber size="small" min={0} max={10} step={0.5} placeholder="待评分" value={v ?? undefined} onChange={value => { const next = scoreValue(value); setOurScores(scores => ({ ...scores, [row.key]: next })); void saveScore('project', projectId, row.key, next); }} /> },
          { title: '竞品分', dataIndex: 'theirScore', render: (v: number | null, row: any) => <InputNumber size="small" min={0} max={10} step={0.5} placeholder="待评分" value={v ?? undefined} onChange={value => { const next = scoreValue(value); setTheirScores(scores => ({ ...scores, [row.key]: next })); if (competitorId) void saveScore('competitor', competitorId, row.key, next); }} /> },
          { title: '规格差异', dataIndex: 'specDiff', render: (v: number | null) => v === null ? <Tag>待评分</Tag> : <Tag color={v > 0 ? 'green' : v < 0 ? 'red' : 'default'}>{v > 0 ? '+' : ''}{v.toFixed(1)}</Tag> },
          { title: '成本差异', dataIndex: 'costDiff', render: (v: number | null) => v === null ? <Tag>待映射</Tag> : money(v) },
          { title: '支撑模块', dataIndex: 'mapped', ellipsis: true },
        ]} />
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选择竞品并配置竞争力维度" />}
    </Card>
    <Modal title={`编辑成本长城 · ${project?.name || '当前项目'}`} open={configOpen} width={820} confirmLoading={savingConfig} okText="保存本项目配置" cancelText="取消" onCancel={() => setConfigOpen(false)} onOk={() => void saveConfig()}>
      <div className="cost-wall-config-help">维度名称、启用状态和支撑模块只保存到当前项目。支撑模块用于把该维度的成本差异下钻到对应模块；不配置时按整机成本比较。</div>
      <div className="cost-wall-config-list">
        {draftDimensions.map(row => {
          const featureId = Number(row.feature_id);
          const selected = moduleOptions.filter(module => (draftLinks[module] || []).includes(featureId));
          return <div className="cost-wall-config-row" key={`${featureId}-${row.sort_order}`}>
            <Input size="small" value={row.name} onChange={event => setDraftDimensions(list => list.map(item => item.feature_id === row.feature_id ? { ...item, name: event.target.value } : item))} aria-label="维度名称" />
            <Select size="small" mode="multiple" showSearch maxTagCount="responsive" value={selected} placeholder="选择支撑模块" options={moduleOptions.map(module => ({ value: module, label: module }))} onChange={modules => setDraftLinks(current => { const next = { ...current }; moduleOptions.forEach(module => { const ids = (next[module] || []).filter(id => id !== featureId); if (modules.includes(module)) ids.push(featureId); next[module] = ids; }); return next; })} />
            <Button size="small" type="text" danger={Number(row.enabled) !== 0} onClick={() => setDraftDimensions(list => list.map(item => item.feature_id === row.feature_id ? { ...item, enabled: Number(item.enabled) === 0 ? 1 : 0 } : item))}>{Number(row.enabled) !== 0 ? '停用' : '启用'}</Button>
          </div>;
        })}
      </div>
      <Space.Compact block className="cost-wall-config-add"><Input size="small" value={newDimension} onChange={event => setNewDimension(event.target.value)} placeholder="新增维度，例如：接口稳定性" onPressEnter={addDraftDimension} /><Button size="small" icon={<PlusOutlined />} onClick={addDraftDimension}>新增维度</Button></Space.Compact>
    </Modal>
  </>;
}
