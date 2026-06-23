import { useEffect, useState } from 'react';
import { Table, Select, Button, Space, Row, Col, message, Card, Statistic, Tag } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import * as XLSX from 'xlsx';
import { getProjects, getProject, getProjectBOMs } from '../db';
import { CATEGORY_COLORS } from '../constants';

export default function Reports() {
  const [projects, setProjects] = useState<any[]>([]);
  const [reportType, setReportType] = useState<'single' | 'compare'>('single');
  const [pid1, setPid1] = useState<number | null>(null);
  const [pid2, setPid2] = useState<number | null>(null);
  const [project, setProject] = useState<any>(null);
  const [boms, setBoms] = useState<any[]>([]);
  const [boms2, setBoms2] = useState<any[]>([]);
  const [project2, setProject2] = useState<any>(null);

  useEffect(() => { (async () => { setProjects(await getProjects()); })(); }, []);

  const generateSingle = async () => {
    if (!pid1) return;
    const p = await getProject(pid1);
    const b = await getProjectBOMs(pid1);
    setProject(p); setBoms(b); setProject2(null); setBoms2([]);
  };

  const generateCompare = async () => {
    if (!pid1 || !pid2) return;
    const p1 = await getProject(pid1); const p2 = await getProject(pid2);
    const b1 = await getProjectBOMs(pid1); const b2 = await getProjectBOMs(pid2);
    setProject(p1); setProject2(p2); setBoms(b1); setBoms2(b2);
  };

  const total = boms.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
  const total2 = boms2.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);

  const byCat: Record<string, number> = {};
  boms.forEach(b => { byCat[b.main_category] = (byCat[b.main_category] || 0) + (b.part_cost || 0) * b.quantity; });

  const pieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
    series: [{
      type: 'pie', radius: ['45%', '75%'], center: ['50%', '55%'], padAngle: 2,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data: Object.entries(byCat).map(([k, v]) => ({ name: k, value: v, itemStyle: { color: CATEGORY_COLORS[k] || '#64748B' } })),
    }],
  };

  const barOption = {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: Object.keys(byCat), axisLabel: { rotate: 30, fontSize: 11 } },
    yAxis: { type: 'value', name: '成本 (¥)' },
    series: [{
      type: 'bar', barWidth: '55%',
      data: Object.entries(byCat).map(([k, v]) => ({ value: v, itemStyle: { color: CATEGORY_COLORS[k] || '#64748B', borderRadius: [6, 6, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 10 },
    }],
    grid: { top: 10, right: 20, bottom: 60, left: 60 },
  };

  const compareBarOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: [project?.code || '项目A', project2?.code || '项目B'], bottom: 0 },
    xAxis: { type: 'category', data: [...new Set([...Object.keys(byCat), ...Object.keys(boms2.reduce((m: any, b: any) => ({ ...m, [b.main_category]: 1 }), {}))])], axisLabel: { rotate: 30, fontSize: 11 } },
    yAxis: { type: 'value', name: '成本 (¥)' },
    series: [
      { name: project?.code || 'A', type: 'bar', barGap: '10%', data: Object.keys(byCat).map(k => byCat[k] || 0), itemStyle: { color: '#CF0A2C', borderRadius: [6, 6, 0, 0] } },
      { name: project2?.code || 'B', type: 'bar', data: Object.keys(byCat).map(k => (boms2.filter(b => b.main_category === k).reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0))), itemStyle: { color: '#2563EB', borderRadius: [6, 6, 0, 0] } },
    ],
    grid: { top: 10, right: 20, bottom: 40, left: 60 },
  };

  const exportSingle = () => {
    const ws = XLSX.utils.json_to_sheet(boms.map(b => ({
      大类: b.main_category, 类型: b.category, 名称: b.part_name, 型号: b.part_model,
      单价: b.part_cost, 数量: b.quantity, 小计: (b.part_cost || 0) * b.quantity, 备注: b.remark,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BOM明细');
    XLSX.writeFile(wb, `${project?.code || 'report'}_成本报告.xlsx`);
    message.success('已导出');
  };

  const bomCols = [
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={CATEGORY_COLORS[v]}>{v}</Tag> },
    { title: '类型', dataIndex: 'category', width: 90 },
    { title: '名称', dataIndex: 'part_name' },
    { title: '型号', dataIndex: 'part_model' },
    { title: '单价(¥)', dataIndex: 'part_cost', width: 100, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const },
    { title: '小计(¥)', key: 'sub', width: 100, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost || 0) * r.quantity).toFixed(2)}</b> },
  ];

  return (
    <div>
      <div className="page-title">📄 成本报告</div>
      <div className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select value={reportType} onChange={v => { setReportType(v); setProject(null); setProject2(null); }} style={{ width: 160 }}
            options={[{ label: '单项目报告', value: 'single' }, { label: '项目对比报告', value: 'compare' }]} />
          <Select placeholder="选择项目" value={pid1} onChange={v => setPid1(v)} style={{ width: 280 }}
            options={projects.map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
          {reportType === 'compare' && (
            <Select placeholder="选择对比项目" value={pid2} onChange={v => setPid2(v)} style={{ width: 280 }}
              options={projects.filter(p => p.id !== pid1).map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
          )}
          <Button type="primary" onClick={() => reportType === 'single' ? generateSingle() : generateCompare()}>🔍 生成报告</Button>
        </Space>
      </div>

      {project && reportType === 'single' && (
        <>
          <div className="content-card" style={{ marginBottom: 16 }}>
            <h2 style={{ color: '#CF0A2C', margin: 0 }}>{project.name} ({project.code})</h2>
            <p style={{ color: '#64748B', marginTop: 8 }}>
              档位: {project.tier} | 状态: {project.status} |
              屏幕: {[project.screen_size, project.resolution, project.refresh_rate, project.panel_type].filter(Boolean).join(' / ')}
            </p>
            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={8}><Card size="small"><Statistic title="BOM总成本" value={total} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title="器件数" value={boms.length} /></Card></Col>
            </Row>
          </div>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}><div className="content-card"><div className="card-header"><h3>成本结构</h3></div><ReactECharts option={pieOption} style={{ height: 320 }} /></div></Col>
            <Col span={12}><div className="content-card"><div className="card-header"><h3>大类成本</h3></div><ReactECharts option={barOption} style={{ height: 320 }} /></div></Col>
          </Row>

          <div className="content-card">
            <div className="card-header"><h3>BOM 明细</h3><Button icon={<DownloadOutlined />} onClick={exportSingle}>导出Excel</Button></div>
            <Table dataSource={boms} columns={bomCols} rowKey="id" size="small" pagination={{ pageSize: 20 }} />
          </div>
        </>
      )}

      {project && project2 && reportType === 'compare' && (
        <>
          <div className="content-card" style={{ marginBottom: 16 }}>
            <h2 style={{ color: '#CF0A2C' }}>项目对比: {project.code} vs {project2.code}</h2>
            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={8}><Card size="small"><Statistic title={`${project.code} BOM成本`} value={total} precision={2} prefix="¥" /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title={`${project2.code} BOM成本`} value={total2} precision={2} prefix="¥" /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title="差异" value={total - total2} precision={2} prefix="¥" valueStyle={{ color: total > total2 ? '#CF0A2C' : '#10B981' }} /></Card></Col>
            </Row>
          </div>
          <div className="content-card">
            <div className="card-header"><h3>成本对比</h3></div>
            <ReactECharts option={compareBarOption} style={{ height: 350 }} />
          </div>
        </>
      )}
    </div>
  );
}
