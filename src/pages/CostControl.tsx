import { useEffect, useState } from 'react';
import DataTable from '../components/DataTable';
import { Button, Select, Space, Modal, Form, Input, InputNumber, Tag, message, Popconfirm, Card, Statistic, Row, Col } from 'antd';
import { PlusOutlined, DollarOutlined, AimOutlined, BarChartOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { getProjects, getProjectBOMs, getCostReviews, saveCostReview, deleteCostReview, getMeasures, saveMeasure, deleteMeasure } from '../db';
import { MAIN_CATEGORIES, MEASURE_STATUSES, CATEGORY_COLORS } from '../constants';
import { chartTooltip, chartAxisStyle, chartGrid, chartBarSeries, chartLineSeries, chartTextMuted, barGradient } from '../chartTheme';

export default function CostControl() {
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [boms, setBoms] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [project, setProject] = useState<any>(null);
  const [reviewModal, setReviewModal] = useState(false);
  const [measureModal, setMeasureModal] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => { (async () => { setProjects(await getProjects()); })(); }, []);

  const selectProject = async (pid: number) => {
    setSelectedPid(pid);
    const projs = await getProjects();
    setProject(projs.find(p => p.id === pid));
    setBoms(await getProjectBOMs(pid));
    setReviews(await getCostReviews(pid));
    setMeasures(await getMeasures(pid));
  };

  const bomTotal = boms.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
  const byCategory: Record<string, number> = {};
  boms.forEach(b => { byCategory[b.main_category] = (byCategory[b.main_category] || 0) + (b.part_cost || 0) * b.quantity; });

  const barOption = {
    tooltip: chartTooltip('axis'),
    xAxis: { type: 'category', data: Object.keys(byCategory), ...chartAxisStyle(11, { rotate: 30 }) },
    yAxis: { type: 'value', name: '成本 (¥)', ...chartAxisStyle() },
    series: [chartBarSeries({
      data: Object.entries(byCategory).map(([k, v]) => ({ value: v, itemStyle: { color: barGradient(CATEGORY_COLORS[k] || '#64748B') } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${(p.value as number).toFixed(0)}`, fontSize: 10, color: chartTextMuted() },
    })],
    grid: chartGrid({ bottom: 60 }),
  };

  const trendOption = {
    tooltip: chartTooltip('axis'),
    xAxis: { type: 'category', data: [...reviews.map(r => r.reviewed_at?.slice(0, 10) || r.stage), '当前BOM'], ...chartAxisStyle() },
    yAxis: { type: 'value', name: '成本 (¥)', ...chartAxisStyle() },
    series: [chartLineSeries({
      data: [...reviews.map(r => r.reviewed_cost), bomTotal],
      itemStyle: { color: '#0A84FF' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(10,132,255,0.25)' }, { offset: 1, color: 'rgba(10,132,255,0)' }] } },
    })],
    grid: chartGrid({ bottom: 40 }),
  };

  return (
    <div>
      <div className="page-title"><DollarOutlined /> 成本管控</div>

      <div className="content-card" style={{ marginBottom: 16 }}>
        <Space>
          <span>选择项目:</span>
          <Select style={{ width: 300 }} placeholder="选择项目..." value={selectedPid} onChange={v => selectProject(v)}
            options={projects.map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
        </Space>
      </div>

      {project && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}><Card><Statistic title="BOM成本" value={bomTotal} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
            <Col span={8}><Card><Statistic title="平台费" value={bomTotal * (project.platform_fee_rate || 0) / 100} precision={2} prefix="¥" valueStyle={{ color: '#2563EB' }} /></Card></Col>
            <Col span={8}><Card><Statistic title="目标售价" value={bomTotal * (1 + (project.platform_fee_rate || 0) / 100 + (project.profit_rate || 0) / 100)} precision={2} prefix="¥" valueStyle={{ color: '#10B981' }} /></Card></Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <div className="content-card"><div className="card-header"><h3>成本结构</h3></div><ReactECharts option={barOption} style={{ height: 300 }} /></div>
            </Col>
            <Col span={12}>
              <div className="content-card"><div className="card-header"><h3>成本趋势</h3></div><ReactECharts option={trendOption} style={{ height: 300 }} /></div>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <div className="content-card">
                <div className="card-header"><h3><AimOutlined /> 降本措施</h3><Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setMeasureModal(true)}>添加</Button></div>
                <DataTable tableId="cc_measures" dataSource={measures} rowKey="id" size="small" pagination={false} columns={[
                  { title: '大类', dataIndex: 'main_category', width: 80 },
                  { title: '措施', dataIndex: 'measure' },
                  { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === '已完成' ? 'green' : v === '执行中' ? 'blue' : 'default'}>{v}</Tag> },
                  { title: '负责人', dataIndex: 'owner', width: 70 },
                  { title: '操作', width: 60, render: (_: any, r: any) => <Popconfirm title="删除？" onConfirm={async () => { await deleteMeasure(r.id); setMeasures(await getMeasures(selectedPid!)); }}><Button type="link" size="small" danger>删除</Button></Popconfirm> },
                ]} />
              </div>
            </Col>
            <Col span={12}>
              <div className="content-card">
                <div className="card-header"><h3><BarChartOutlined /> 成本测算</h3><Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setReviewModal(true)}>添加</Button></div>
                <DataTable tableId="cc_reviews" dataSource={reviews} rowKey="id" size="small" pagination={false} columns={[
                  { title: '阶段', dataIndex: 'stage' }, { title: '成本(¥)', dataIndex: 'reviewed_cost', render: (v: number) => v?.toFixed(2) },
                  { title: '测算人', dataIndex: 'reviewer' }, { title: '时间', dataIndex: 'reviewed_at', width: 140 },
                  { title: '操作', width: 60, render: (_: any, r: any) => <Popconfirm title="删除？" onConfirm={async () => { await deleteCostReview(r.id); setReviews(await getCostReviews(selectedPid!)); }}><Button type="link" size="small" danger>删除</Button></Popconfirm> },
                ]} />
              </div>
            </Col>
          </Row>
        </>
      )}

      {/* Modal for adding review */}
      <Modal title="添加成本测算" open={reviewModal} onOk={async () => { const v = await form.validateFields(); await saveCostReview({ project_id: selectedPid, ...v }); setReviewModal(false); setReviews(await getCostReviews(selectedPid!)); message.success('已添加'); }} onCancel={() => setReviewModal(false)}>
        <Form form={form} layout="vertical">
          <Form.Item label="阶段" name="stage" rules={[{ required: true }]}><Select options={['Charter', 'CDCP', 'PDCP', 'ADCP', '量产后降本'].map(s => ({ label: s, value: s }))} /></Form.Item>
          <Form.Item label="测算成本" name="reviewed_cost" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} prefix="¥" /></Form.Item>
          <Form.Item label="测算人" name="reviewer"><Input /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>

      {/* Modal for adding measure */}
      <Modal title="添加措施" open={measureModal} onOk={async () => { const v = await form.validateFields(); await saveMeasure({ project_id: selectedPid, ...v }); setMeasureModal(false); setMeasures(await getMeasures(selectedPid!)); message.success('已添加'); }} onCancel={() => setMeasureModal(false)}>
        <Form form={form} layout="vertical">
          <Form.Item label="大类" name="main_category" rules={[{ required: true }]}><Select options={MAIN_CATEGORIES.map(c => ({ label: c, value: c }))} /></Form.Item>
          <Form.Item label="措施" name="measure" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="状态" name="status"><Select options={MEASURE_STATUSES.map(s => ({ label: s, value: s }))} /></Form.Item>
          <Form.Item label="负责人" name="owner"><Input /></Form.Item>
          <Form.Item label="截止日期" name="due_date"><Input placeholder="如: 2026-06-30" /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
