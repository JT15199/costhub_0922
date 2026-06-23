import { useEffect, useState } from 'react';
import { Table, Select, Button, Space, Row, Col, message, Card, Statistic, Tag, Dropdown } from 'antd';
import { DownloadOutlined, FileExcelOutlined, FileTextOutlined, FilePdfOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import ReactECharts from 'echarts-for-react';
import * as XLSX from 'xlsx';
import { getProjects, getProject, getProjectBOMs } from '../db';
import { getCategoryColor } from '../constants';

// 导出工具函数
const exportToCSV = (data: any[], filename: string) => {
  const headers = Object.keys(data[0] || {});
  const csvContent = [
    headers.join(','),
    ...data.map(row => headers.map(h => `"${row[h] ?? ''}"`).join(','))
  ].join('\n');
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.csv`;
  link.click();
  message.success('已导出CSV');
};

const exportToJSON = (data: any[], filename: string) => {
  const jsonContent = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.json`;
  link.click();
  message.success('已导出JSON');
};

const exportToPDF = () => {
  window.print();
  message.info('已调用打印功能，请选择保存为PDF');
};

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

  // 成本结构饼图
  const pieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
    series: [{
      type: 'pie', radius: ['45%', '75%'], center: ['50%', '55%'], padAngle: 2,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data: Object.entries(byCat).map(([k, v]) => ({ name: k, value: v, itemStyle: { color: getCategoryColor(k) } })),
    }],
  };

  // 玫瑰图
  const roseOption = {
    tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
    legend: { bottom: 10, textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: ['20%', '65%'],
      center: ['50%', '45%'],
      roseType: 'area',
      itemStyle: { borderRadius: 6 },
      label: { show: true, formatter: '{b}\n{d}%', fontSize: 11 },
      data: Object.entries(byCat).map(([k, v]) => ({ name: k, value: v, itemStyle: { color: getCategoryColor(k) } })),
    }],
  };

  // 瀑布图
  const waterfallOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].name}<br/>成本: <b>¥${p[0].value.toFixed(2)}</b>` },
    xAxis: { type: 'category', data: Object.keys(byCat), axisLabel: { rotate: 30, fontSize: 11 } },
    yAxis: { type: 'value', name: '成本 (¥)' },
    series: [{
      type: 'bar',
      data: Object.entries(byCat).map(([k, v]) => ({ value: v, itemStyle: { color: getCategoryColor(k), borderRadius: [6, 6, 0, 0] } })),
      label: { show: true, position: 'top', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 10 },
    }],
    grid: { top: 20, right: 20, bottom: 60, left: 60 },
  };

  // 对比柱状图
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

  // 导出菜单项
  const exportMenuItems: MenuProps['items'] = [
    { key: 'excel', icon: <FileExcelOutlined />, label: '导出 Excel (.xlsx)', onClick: () => exportSingle('excel') },
    { key: 'csv', icon: <FileTextOutlined />, label: '导出 CSV', onClick: () => exportSingle('csv') },
    { key: 'json', icon: <FileTextOutlined />, label: '导出 JSON', onClick: () => exportSingle('json') },
    { key: 'pdf', icon: <FilePdfOutlined />, label: '打印/保存PDF', onClick: exportToPDF },
  ];

  const exportSingle = (format: string) => {
    const data = boms.map(b => ({
      大类: b.main_category, 类型: b.category, 名称: b.part_name, 型号: b.part_model,
      单价: b.part_cost, 数量: b.quantity, 小计: (b.part_cost || 0) * b.quantity, 备注: b.remark,
    }));
    const filename = `${project?.code || 'report'}_成本报告`;
    switch (format) {
      case 'excel':
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'BOM明细');
        XLSX.writeFile(wb, `${filename}.xlsx`);
        message.success('已导出Excel');
        break;
      case 'csv':
        exportToCSV(data, filename);
        break;
      case 'json':
        exportToJSON(data, filename);
        break;
    }
  };

  const bomCols = [
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { title: '类型', dataIndex: 'category', width: 90 },
    { title: '名称', dataIndex: 'part_name' },
    { title: '型号', dataIndex: 'part_model' },
    { title: '单价(¥)', dataIndex: 'part_cost', width: 100, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
    { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const },
    { title: '小计(¥)', key: 'sub', width: 100, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost || 0) * r.quantity).toFixed(2)}</b> },
  ];

  return (
    <div>
      <div className="page-title"><span className="emoji">📄</span> 成本报告</div>
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
              <Col span={6}><Card size="small"><Statistic title="BOM总成本" value={total} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="器件数" value={boms.length} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="大类数" value={Object.keys(byCat).length} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="平均单价" value={total / boms.length || 0} precision={2} prefix="¥" /></Card></Col>
            </Row>
          </div>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}><div className="content-card"><div className="card-header"><h3>成本结构饼图</h3></div><ReactECharts option={pieOption} style={{ height: 280 }} /></div></Col>
            <Col span={8}><div className="content-card"><div className="card-header"><h3>成本玫瑰图</h3></div><ReactECharts option={roseOption} style={{ height: 280 }} /></div></Col>
            <Col span={8}><div className="content-card"><div className="card-header"><h3>成本瀑布图</h3></div><ReactECharts option={waterfallOption} style={{ height: 280 }} /></div></Col>
          </Row>

          <div className="content-card">
            <div className="card-header">
              <h3>BOM 明细</h3>
              <Dropdown menu={{ items: exportMenuItems }} placement="bottomRight">
                <Button icon={<DownloadOutlined />}>导出报告</Button>
              </Dropdown>
            </div>
            <Table dataSource={boms} columns={bomCols} rowKey="id" size="small" pagination={{ pageSize: 20 }} />
          </div>
        </>
      )}

      {project && project2 && reportType === 'compare' && (
        <>
          <div className="content-card" style={{ marginBottom: 16 }}>
            <h2 style={{ color: '#CF0A2C' }}>项目对比: {project.code} vs {project2.code}</h2>
            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={6}><Card size="small"><Statistic title={`${project.code} BOM成本`} value={total} precision={2} prefix="¥" /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title={`${project2.code} BOM成本`} value={total2} precision={2} prefix="¥" /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="差异" value={total - total2} precision={2} prefix="¥" valueStyle={{ color: total > total2 ? '#CF0A2C' : '#10B981' }} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="差异比例" value={Math.abs(total - total2) / total * 100 || 0} precision={1} suffix="%" valueStyle={{ color: '#FF9500' }} /></Card></Col>
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