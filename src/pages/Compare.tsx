import { useEffect, useState } from 'react';
import { Table, Select, Space, Button, Row, Col, Modal, Form, Input, InputNumber, Tag, Slider, message, Popconfirm, Tabs } from 'antd';
import { EditOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs, getFeatures, saveFeature, deleteFeature, getScores, saveScore } from '../db';

export default function Compare() {
  const [projects, setProjects] = useState<any[]>([]);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [features, setFeatures] = useState<any[]>([]);
  const [mode, setMode] = useState<'pp' | 'pc'>('pp');
  const [aId, setAId] = useState<number | null>(null);
  const [bId, setBId] = useState<number | null>(null);
  const [aName, setAName] = useState(''); const [bName, setBName] = useState('');
  const [aBoms, setABoms] = useState<any[]>([]); const [bBoms, setBBoms] = useState<any[]>([]);
  // Radar scores: { refId: { featureId: score } }
  const [aScoreMap, setAScoreMap] = useState<Record<number, number>>({});
  const [bScoreMap, setBScoreMap] = useState<Record<number, number>>({});
  const [featModal, setFeatModal] = useState(false);
  const [editFeat, setEditFeat] = useState<any>(null);
  const [scoreModal, setScoreModal] = useState(false);
  const [scoreTarget, setScoreTarget] = useState<'a' | 'b'>('a');
  const [featForm] = Form.useForm();

  useEffect(() => { (async () => { setProjects(await getProjects()); setCompetitors(await getCompetitors()); setFeatures(await getFeatures()); })(); }, []);

  const doCompare = async () => {
    if (!aId || !bId) return;
    // Load names & BOMs
    if (mode === 'pp') {
      const p1 = projects.find(p => p.id === aId); const p2 = projects.find(p => p.id === bId);
      setAName(p1 ? `${p1.code} ${p1.name}` : 'A'); setBName(p2 ? `${p2.code} ${p2.name}` : 'B');
      setABoms(await getProjectBOMs(aId)); setBBoms(await getProjectBOMs(bId));
    } else {
      const p = projects.find(p => p.id === aId); const c = competitors.find(c => c.id === bId);
      setAName(p ? `${p.code} ${p.name}` : '项目'); setBName(c ? `${c.brand} ${c.model}` : '竞品');
      setABoms(await getProjectBOMs(aId));
      const cb = await getCompetitorBOMs(bId);
      setBBoms(cb.map((b: any) => ({ ...b, part_cost: b.estimated_cost, category: b.category || '' })));
    }
    // Load scores
    setAScoreMap(await getScores(mode === 'pp' ? 'project' : 'project', aId));
    setBScoreMap(await getScores(mode === 'pp' ? 'project' : 'competitor', bId));
  };

  // BOM comparison
  const aByCat: Record<string, number> = {}; aBoms.forEach(b => { const c = b.main_category || '其他'; aByCat[c] = (aByCat[c] || 0) + (b.part_cost || 0) * b.quantity; });
  const bByCat: Record<string, number> = {}; bBoms.forEach(b => { const c = b.main_category || '其他'; bByCat[c] = (bByCat[c] || 0) + (b.part_cost || 0) * b.quantity; });
  const allCats = [...new Set([...Object.keys(aByCat), ...Object.keys(bByCat)])].sort();
  const aTotal = Object.values(aByCat).reduce((s, v) => s + v, 0);
  const bTotal = Object.values(bByCat).reduce((s, v) => s + v, 0);

  const handleSaveFeat = async () => {
    const v = await featForm.validateFields();
    await saveFeature({ ...editFeat, ...v });
    setFeatModal(false); setEditFeat(null); setFeatures(await getFeatures());
    message.success('特性已保存');
  };

  const handleScore = async (featureId: number, score: number) => {
    const refType = scoreTarget === 'a' ? (mode === 'pp' ? 'project' : 'project') : (mode === 'pp' ? 'project' : 'competitor');
    const refId = scoreTarget === 'a' ? aId : bId;
    if (!refId) return;
    await saveScore(refType, refId, featureId, score);
    if (scoreTarget === 'a') setAScoreMap({ ...aScoreMap, [featureId]: score });
    else setBScoreMap({ ...bScoreMap, [featureId]: score });
  };

  // Radar chart options
  const radarOption = {
    tooltip: {},
    legend: { data: [aName || 'A', bName || 'B'], bottom: 0 },
    radar: {
      center: ['50%', '50%'], radius: '65%',
      indicator: features.map(f => ({ name: f.name, max: 100 })),
    },
    series: [{
      type: 'radar',
      data: [
        { name: aName || 'A', value: features.map(f => aScoreMap[f.id] || 0), itemStyle: { color: '#CF0A2C' }, areaStyle: { color: 'rgba(207,10,44,0.15)' }, lineStyle: { width: 2 } },
        { name: bName || 'B', value: features.map(f => bScoreMap[f.id] || 0), itemStyle: { color: '#2563EB' }, areaStyle: { color: 'rgba(37,99,235,0.15)' }, lineStyle: { width: 2 } },
      ],
    }],
  };

  const barOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: [aName, bName], bottom: 0 },
    xAxis: { type: 'category', data: allCats, axisLabel: { rotate: 25, fontSize: 11 } },
    yAxis: { type: 'value', name: '成本 (¥)' },
    series: [
      { name: aName, type: 'bar', barGap: '10%', data: allCats.map(c => aByCat[c] || 0), itemStyle: { color: '#CF0A2C', borderRadius: [6,6,0,0] } },
      { name: bName, type: 'bar', data: allCats.map(c => bByCat[c] || 0), itemStyle: { color: '#2563EB', borderRadius: [6,6,0,0] } },
    ],
    grid: { top: 10, right: 20, bottom: 40, left: 60 },
  };

  const featCols = [
    { title: '特性名称', dataIndex: 'name' }, { title: '权重', dataIndex: 'weight' },
    { title: '操作', width: 100, render: (_: any, r: any) => (
      <Space size="small">
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditFeat(r); featForm.setFieldsValue(r); setFeatModal(true); }} />
        <Popconfirm title="删除？" onConfirm={async () => { await deleteFeature(r.id); setFeatures(await getFeatures()); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
      </Space>
    )},
  ];

  return (
    <div>
      <div className="page-title">📈 对比分析</div>

      <div className="content-card" style={{ marginBottom: 14 }}>
        <Space wrap>
          <Select value={mode} onChange={v => { setMode(v); setBId(null); }} style={{ width: 160 }} options={[{ label: '项目 vs 项目', value: 'pp' }, { label: '项目 vs 竞品', value: 'pc' }]} />
          <Select placeholder="项目A" value={aId} onChange={v => setAId(v)} style={{ width: 260 }} options={projects.map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
          {mode === 'pp' ? (
            <Select placeholder="项目B" value={bId} onChange={v => setBId(v)} style={{ width: 260 }} options={projects.filter(p => p.id !== aId).map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
          ) : (
            <Select placeholder="竞品" value={bId} onChange={v => setBId(v)} style={{ width: 260 }} options={competitors.map(c => ({ label: `${c.brand} ${c.model}`, value: c.id }))} />
          )}
          <Button type="primary" onClick={doCompare} disabled={!aId || !bId}>🔍 开始对比</Button>
        </Space>
      </div>

      {aBoms.length > 0 && bBoms.length > 0 && (
        <Tabs defaultActiveKey="radar" items={[
          {
            key: 'radar', label: '🎯 雷达图对比', children: (
              <div>
                <div className="content-card" style={{ marginBottom: 12 }}>
                  <div className="card-header">
                    <h3>产品特性评分对比</h3>
                    <Space>
                      <Button size="small" icon={<SettingOutlined />} onClick={() => { setEditFeat(null); featForm.resetFields(); setFeatModal(true); }}>添加特性</Button>
                      <Button size="small" onClick={() => { setScoreTarget('a'); setScoreModal(true); }}>编辑 {aName} 评分</Button>
                      <Button size="small" onClick={() => { setScoreTarget('b'); setScoreModal(true); }}>编辑 {bName} 评分</Button>
                    </Space>
                  </div>
                  <Row gutter={14}>
                    <Col span={16}>
                      {features.length > 0 ? <ReactECharts option={radarOption} style={{ height: 420 }} /> : (
                        <div style={{ textAlign: 'center', padding: 80, color: '#999' }}>请先添加产品特性（点击"添加特性"按钮）</div>
                      )}
                    </Col>
                    <Col span={8}>
                      <Table dataSource={features} columns={featCols} rowKey="id" size="small" pagination={false} title={() => <b>产品特性列表</b>} />
                    </Col>
                  </Row>
                </div>
                {/* Score editing table when modal open */}
                <Modal title={`编辑 ${scoreTarget === 'a' ? aName : bName} 评分`} open={scoreModal} onCancel={() => setScoreModal(false)} footer={null} width={500}>
                  {features.map(f => (
                    <div key={f.id} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span>{f.name} (权重: {f.weight})</span>
                        <Tag color="#CF0A2C">{scoreTarget === 'a' ? (aScoreMap[f.id] || 0) : (bScoreMap[f.id] || 0)} 分</Tag>
                      </div>
                      <Slider min={0} max={100} step={1}
                        value={scoreTarget === 'a' ? (aScoreMap[f.id] || 0) : (bScoreMap[f.id] || 0)}
                        onChange={(v) => handleScore(f.id, v)} />
                    </div>
                  ))}
                </Modal>
              </div>
            ),
          },
          {
            key: 'cost', label: '💰 成本对比', children: (
              <div>
                <Row gutter={14}>
                  <Col span={14}><div className="content-card"><ReactECharts option={barOption} style={{ height: 380 }} /></div></Col>
                  <Col span={10}>
                    <div className="content-card">
                      <Table dataSource={[
                        ...allCats.map(c => ({ key: c, cat: c, a: aByCat[c] || 0, b: bByCat[c] || 0, diff: (aByCat[c] || 0) - (bByCat[c] || 0) })),
                        { key: '_t', cat: '合计', a: aTotal, b: bTotal, diff: aTotal - bTotal }
                      ]} columns={[
                        { title: '大类', dataIndex: 'cat', render: (v: string) => <b>{v}</b> },
                        { title: aName, dataIndex: 'a', align: 'right' as const, render: (v: number) => `¥${v.toFixed(2)}` },
                        { title: bName, dataIndex: 'b', align: 'right' as const, render: (v: number) => `¥${v.toFixed(2)}` },
                        { title: '差异', dataIndex: 'diff', align: 'right' as const, render: (v: number) => <span style={{ color: v > 0 ? '#CF0A2C' : v < 0 ? '#10B981' : '#64748B', fontWeight: 600 }}>¥{v.toFixed(2)}</span> },
                      ]} rowKey="key" size="small" pagination={false}
                        onRow={(r) => r.key === '_t' ? { style: { fontWeight: 700, background: '#F8FAFC' } } : {}} />
                    </div>
                  </Col>
                </Row>
              </div>
            ),
          },
        ]} />
      )}

      {/* Feature edit modal */}
      <Modal title={editFeat ? '编辑特性' : '添加产品特性'} open={featModal} onOk={handleSaveFeat} onCancel={() => { setFeatModal(false); setEditFeat(null); }}>
        <Form form={featForm} layout="vertical" initialValues={{ weight: 1 }}>
          <Form.Item label="特性名称" name="name" rules={[{ required: true }]}><Input placeholder="如: 色域覆盖率、响应时间、亮度均匀性..." /></Form.Item>
          <Form.Item label="权重" name="weight"><InputNumber min={0.1} max={10} step={0.1} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
