import { useEffect, useState } from 'react';
import { Table, Select, Space, Button, Row, Col, Modal, Form, Input, InputNumber, Tag, Slider, message, Popconfirm, Tabs, Dropdown, Card, Statistic } from 'antd';
import { EditOutlined, DeleteOutlined, SettingOutlined, DownloadOutlined, FileExcelOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import ReactECharts from 'echarts-for-react';
import * as XLSX from 'xlsx';
import { getProjects, getProjectBOMs, getCompetitors, getCompetitorBOMs, getFeatures, saveFeature, deleteFeature, getScores, saveScore } from '../db';
import { getCategoryColor } from '../constants';

// 导出对比报告
const exportCompareReport = (aName: string, bName: string, aBoms: any[], bBoms: any[], aByCat: Record<string, number>, bByCat: Record<string, number>, allCats: string[]) => {
  const summaryData = allCats.map(cat => ({
    大类: cat,
    [`${aName}成本`]: (aByCat[cat] || 0).toFixed(2),
    [`${bName}成本`]: (bByCat[cat] || 0).toFixed(2),
    差异: ((aByCat[cat] || 0) - (bByCat[cat] || 0)).toFixed(2),
    差异百分比: ((aByCat[cat] || 0) > 0 ? (((aByCat[cat] || 0) - (bByCat[cat] || 0)) / (aByCat[cat] || 0) * 100).toFixed(1) + '%' : '0%'),
  }));
  const detailData = aBoms.map(b => {
    const match = bBoms.find(b2 => b2.part_name === b.part_name || b2.part_model === b.part_model);
    return {
      模块: b.module_name,
      大类: b.main_category,
      名称: b.part_name,
      型号: b.part_model,
      [`${aName}单价`]: b.part_cost?.toFixed(2),
      [`${aName}数量`]: b.quantity,
      [`${aName}小计`]: ((b.part_cost || 0) * b.quantity).toFixed(2),
      [`${bName}单价`]: match?.part_cost?.toFixed(2) || '—',
      [`${bName}数量`]: match?.quantity || '—',
      [`${bName}小计`]: match ? ((match.part_cost || 0) * match.quantity).toFixed(2) : '—',
      单价差异: match ? (b.part_cost - match.part_cost).toFixed(2) : '—',
    };
  });
  const ws1 = XLSX.utils.json_to_sheet(summaryData);
  const ws2 = XLSX.utils.json_to_sheet(detailData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, '成本对比汇总');
  XLSX.utils.book_append_sheet(wb, ws2, '器件明细对比');
  XLSX.writeFile(wb, `${aName}_vs_${bName}_对比报告.xlsx`);
  message.success('对比报告已导出');
};

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
  const diffTotal = aTotal - bTotal;

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
    legend: { data: [aName || 'A', bName || 'B'], top: 10, right: 10 },
    radar: {
      center: ['50%', '55%'], radius: '60%',
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
    legend: { data: [aName, bName], top: 5, right: 5 },
    xAxis: { type: 'category', data: allCats, axisLabel: { rotate: 0, fontSize: 12, interval: 0 } },
    yAxis: { type: 'value', name: '成本 (¥)' },
    series: [
      { name: aName, type: 'bar', barGap: '10%', data: allCats.map(c => aByCat[c] || 0), itemStyle: { color: '#CF0A2C', borderRadius: [6,6,0,0] }, label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, color: '#1D1D1F' } },
      { name: bName, type: 'bar', data: allCats.map(c => bByCat[c] || 0), itemStyle: { color: '#2563EB', borderRadius: [6,6,0,0] }, label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, color: '#1D1D1F' } },
    ],
    grid: { top: 50, right: 20, bottom: 60, left: 60 },
  };

  // 差异瀑布图
  const waterfallOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].name}<br/>差异: <b>${p[0].value >= 0 ? '+' : ''}¥${p[0].value.toFixed(2)}</b>` },
    xAxis: { type: 'category', data: allCats, axisLabel: { rotate: 0, fontSize: 11, interval: 0 } },
    yAxis: { type: 'value', name: '差异 (¥)' },
    series: [{
      type: 'bar',
      data: allCats.map(c => ({
        value: (aByCat[c] || 0) - (bByCat[c] || 0),
        itemStyle: {
          color: (aByCat[c] || 0) > (bByCat[c] || 0) ? '#EF4444' : (aByCat[c] || 0) < (bByCat[c] || 0) ? '#10B981' : '#6E6E73',
          borderRadius: [6, 6, 0, 0],
        },
      })),
      label: { show: true, position: 'top', formatter: (p: any) => `${p.value >= 0 ? '+' : ''}¥${p.value.toFixed(0)}`, fontSize: 11, color: '#1D1D1F', fontWeight: 600 },
    }],
    grid: { top: 40, right: 20, bottom: 60, left: 60 },
  };

  // 器件明细对比
  const detailCompareCols = [
    { title: '模块', dataIndex: 'module_name', width: 90, render: (v: string) => <Tag>{v || '未归类'}</Tag> },
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { title: '名称', dataIndex: 'part_name', ellipsis: true },
    { title: '型号', dataIndex: 'part_model', width: 120, ellipsis: true },
    { title: `${aName}单价`, dataIndex: 'a_cost', width: 85, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
    { title: `${bName}单价`, dataIndex: 'b_cost', width: 85, align: 'right' as const, render: (v: number, r: any) => {
      if (!v) return <span style={{ color: '#CCC' }}>—</span>;
      const diff = r.a_cost - v;
      return <span style={{ color: diff > 0 ? '#EF4444' : diff < 0 ? '#10B981' : '#666' }}>{v.toFixed(2)}</span>;
    }},
    { title: '单价差异', dataIndex: 'cost_diff', width: 85, align: 'right' as const, render: (v: number) => {
      if (v === null) return <span style={{ color: '#CCC' }}>—</span>;
      return <span style={{ color: v > 0 ? '#EF4444' : v < 0 ? '#10B981' : '#666', fontWeight: 600 }}>
        {v > 0 ? '+' : ''}{v.toFixed(2)}
      </span>;
    }},
  ];

  // 匹配器件对比数据
  const detailCompareData = aBoms.map(a => {
    const match = bBoms.find(b => b.part_name === a.part_name || b.part_model === a.part_model);
    return {
      ...a,
      a_cost: a.part_cost,
      b_cost: match?.part_cost || null,
      cost_diff: match ? a.part_cost - match.part_cost : null,
    };
  });

  // 导出菜单
  const exportMenuItems: MenuProps['items'] = [
    { key: 'excel', icon: <FileExcelOutlined />, label: '导出对比报告 (Excel)', onClick: () => exportCompareReport(aName, bName, aBoms, bBoms, aByCat, bByCat, allCats) },
  ];

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
      <div className="page-title"><span className="emoji">📈</span> 对比分析</div>

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

      {/* 成本汇总统计 */}
      {aBoms.length > 0 && bBoms.length > 0 && (
        <div className="content-card" style={{ marginBottom: 14 }}>
          <Row gutter={16}>
            <Col span={4}><Card size="small"><Statistic title={aName + ' 总成本'} value={aTotal} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title={bName + ' 总成本'} value={bTotal} precision={2} prefix="¥" valueStyle={{ color: '#2563EB' }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="总差异" value={diffTotal} precision={2} prefix="¥" valueStyle={{ color: diffTotal > 0 ? '#EF4444' : '#10B981' }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="差异百分比" value={Math.abs(diffTotal) / aTotal * 100 || 0} precision={1} suffix="%" valueStyle={{ color: '#FF9500' }} /></Card></Col>
            <Col span={8}>
              <Dropdown menu={{ items: exportMenuItems }} placement="bottomRight">
                <Button icon={<DownloadOutlined />} style={{ marginTop: 16 }}>导出对比报告</Button>
              </Dropdown>
            </Col>
          </Row>
        </div>
      )}

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
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={12}>
                    <div className="content-card">
                      <div className="card-header"><h3>分类成本对比</h3></div>
                      <ReactECharts option={barOption} style={{ height: 400 }} />
                    </div>
                  </Col>
                  <Col span={12}>
                    <div className="content-card">
                      <div className="card-header"><h3>成本差异瀑布图</h3></div>
                      <ReactECharts option={waterfallOption} style={{ height: 400 }} />
                    </div>
                  </Col>
                </Row>
                {/* 大类成本对比表格 - 单独一行 */}
                <div className="content-card">
                  <div className="card-header"><h3><span className="emoji">📊</span> 大类成本对比明细</h3></div>
                  <Table dataSource={[
                    ...allCats.map(c => ({ key: c, cat: c, a: aByCat[c] || 0, b: bByCat[c] || 0, diff: (aByCat[c] || 0) - (bByCat[c] || 0), rate: (aByCat[c] || 0) > 0 ? Math.round(((aByCat[c] || 0) - (bByCat[c] || 0)) / (aByCat[c] || 0) * 100) : 0 })),
                    { key: '_t', cat: '合计', a: aTotal, b: bTotal, diff: aTotal - bTotal, rate: aTotal > 0 ? Math.round((aTotal - bTotal) / aTotal * 100) : 0 }
                  ]} columns={[
                    { title: '大类', dataIndex: 'cat', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                    { title: aName.slice(0, 10), dataIndex: 'a', width: 120, align: 'right' as const, render: (v: number) => <span style={{ fontWeight: 500 }}>¥{v.toFixed(2)}</span> },
                    { title: bName.slice(0, 10), dataIndex: 'b', width: 120, align: 'right' as const, render: (v: number) => <span style={{ fontWeight: 500 }}>¥{v.toFixed(2)}</span> },
                    { title: '差异', dataIndex: 'diff', width: 120, align: 'right' as const, render: (v: number) => <span style={{ color: v > 0 ? '#EF4444' : v < 0 ? '#10B981' : '#64748B', fontWeight: 600 }}>¥{v.toFixed(2)}</span> },
                    { title: '差异%', dataIndex: 'rate', width: 100, align: 'right' as const, render: (v: number) => <span style={{ color: v > 0 ? '#EF4444' : v < 0 ? '#10B981' : '#64748B' }}>{v > 0 ? '+' : ''}{v}%</span> },
                  ]} rowKey="key" size="middle" pagination={false}
                    onRow={(r) => r.key === '_t' ? { style: { fontWeight: 700, background: '#F8FAFC' } } : {}} />
                </div>
              </div>
            ),
          },
          {
            key: 'detail', label: '📋 器件明细对比', children: (
              <div className="content-card">
                <div className="card-header"><h3>同名/同型号器件价格对比</h3></div>
                <Table dataSource={detailCompareData} columns={detailCompareCols} rowKey="id" size="small" pagination={{ pageSize: 20 }} scroll={{ x: 1000 }} />
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
