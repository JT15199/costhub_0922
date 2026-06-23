import { useEffect, useState, useCallback } from 'react';
import { Table, Button, Input, Select, Space, Modal, Form, InputNumber, Tag, message, Popconfirm, Tooltip, Upload, Row, Col } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import { PlusOutlined, EditOutlined, DeleteOutlined, DownloadOutlined, UploadOutlined, HistoryOutlined, SearchOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { getParts, savePart, deletePart, getCategories, getPriceHistory, getMainCategories } from '../db';
import { MAIN_CATEGORIES, SUB_CATEGORIES, CATEGORY_COLORS } from '../constants';

export default function PartsLibrary() {
  const [parts, setParts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selKeys, setSelKeys] = useState<React.Key[]>([]);
  const [search, setSearch] = useState('');
  const [mainCat, setMainCat] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [historyName, setHistoryName] = useState('');
  const [mainCats, setMainCats] = useState(MAIN_CATEGORIES);
  const [form] = Form.useForm();

  useEffect(() => { (async () => { try { setMainCats(await getMainCategories()); } catch(e) {} })(); }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await getParts(search, typeFilter, mainCat); setParts(d); setCategories(await getCategories()); } catch (e) { console.error(e); }
    setLoading(false);
  }, [search, typeFilter, mainCat]);
  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const v = await form.validateFields();
    await savePart({ ...editing, ...v, main_category: v.main_category || '硬件类', sub_category: v.sub_category || '' });
    setModalOpen(false); setEditing(null); form.resetFields(); load(); message.success('已保存');
  };
  const handleDelete = async (id: number) => { await deletePart(id); load(); message.success('已删除'); };
  const batchDelete = async () => { for (const id of selKeys) await deletePart(Number(id)); message.success(`已删除 ${selKeys.length} 条`); setSelKeys([]); load(); };
  const rowSel: TableRowSelection<any> = { selectedRowKeys: selKeys, onChange: setSelKeys };
  const showHistory = async (r: any) => { setHistoryData(await getPriceHistory(r.id)); setHistoryName(`${r.name} [${r.model}]`); setHistoryOpen(true); };

  const openEdit = (record?: any) => {
    setEditing(record || null);
    form.setFieldsValue(record ? { ...record } : { main_category: '硬件类', sub_category: '', category: '', cost: 0 });
    setModalOpen(true);
  };

  const cols = [
    { title: 'ID', dataIndex: 'id', width: 55 },
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={CATEGORY_COLORS[v]}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 100 },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    { title: '型号', dataIndex: 'model', ellipsis: true },
    { title: '成本(¥)', dataIndex: 'cost', width: 100, align: 'right' as const, render: (v: number) => <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{v?.toFixed(4)}</span> },
    { title: '项目', dataIndex: 'projects', width: 100, ellipsis: true },
    { title: '操作', width: 130, render: (_: any, r: any) => (
      <Space size="small">
        <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} /></Tooltip>
        <Tooltip title="价格历史"><Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showHistory(r)} /></Tooltip>
        <Popconfirm title="删除？" onConfirm={() => handleDelete(r.id)}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
      </Space>
    )},
  ];

  return (
    <div>
      <div className="page-title">🔧 器件库</div>
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Input prefix={<SearchOutlined />} placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} allowClear />
            <Select placeholder="大类" value={mainCat || undefined} onChange={v => setMainCat(v || '')} allowClear style={{ width: 110 }} options={mainCats.map(c => ({ label: c, value: c }))} />
            <Select placeholder="子类" value={typeFilter || undefined} onChange={v => setTypeFilter(v || '')} allowClear style={{ width: 130 }} options={categories.map(c => ({ label: c, value: c }))} />
          </Space>
          <Space>
            <Upload beforeUpload={(f) => { const r = new FileReader(); r.onload = (e) => { const wb = XLSX.read(e.target?.result, { type: 'binary' }); const data = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]); (async () => { let n = 0; for (const d of data) { const name = d['名称'] || d['name'] || d['器件名称']; if (!name) continue; await savePart({ main_category: d['大类'] || d['main_category'] || '硬件类', sub_category: d['子类'] || d['sub_category'] || '', category: d['大类'] || d['main_category'] || '硬件类', name: String(name).trim(), model: String(d['型号'] || d['model'] || '').trim(), cost: parseFloat(d['成本'] || d['cost'] || d['价格'] || '0') || 0, specs: d['规格'] || d['specs'] || '', projects: d['项目'] || d['projects'] || '', remark: d['备注'] || d['remark'] || '' }); n++; } message.success(`导入 ${n} 条`); load(); })(); }; r.readAsBinaryString(f); return false; }} showUploadList={false}><Button icon={<UploadOutlined />}>导入Excel</Button></Upload>
            <Button icon={<DownloadOutlined />} onClick={() => { const ws = XLSX.utils.json_to_sheet(parts.map(p => ({ ID: p.id, 大类: p.main_category, 子类: p.sub_category, 名称: p.name, 型号: p.model, 成本: p.cost, 项目: p.projects, 备注: p.remark }))); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '器件库'); XLSX.writeFile(wb, '器件库.xlsx'); message.success('已导出'); }}>导出Excel</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增器件</Button>
          </Space>
        </div>
        <div style={{ marginBottom: 8 }}>{selKeys.length > 0 && (
          <Popconfirm title={`批量删除 ${selKeys.length} 条？`} onConfirm={batchDelete}><Button size="small" danger icon={<DeleteOutlined />}>删除选中 ({selKeys.length})</Button></Popconfirm>
        )}</div>
        <Table dataSource={parts} columns={cols} rowKey="id" size="middle" loading={loading} rowSelection={rowSel} pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }} scroll={{ x: 900 }} />
      </div>

      <Modal title={editing?.id ? '编辑器件' : '新增器件'} open={modalOpen} onOk={handleSave} onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields(); }} width={560} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ main_category: '硬件类', cost: 0 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="大类" name="main_category">
                <Select options={mainCats.map(c => ({ label: c, value: c }))} onChange={(v) => { const subs = SUB_CATEGORIES[v] || []; form.setFieldValue('sub_category', subs[0] || ''); form.setFieldValue('category', v); }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="子类" name="sub_category">
                <Select options={(SUB_CATEGORIES[form.getFieldValue('main_category')] || []).map(c => ({ label: c, value: c }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}><Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="型号" name="model" rules={[{ required: true }]}><Input /></Form.Item></Col>
          </Row>
          <Form.Item label="成本" name="cost"><InputNumber style={{ width: '100%' }} min={0} precision={4} prefix="¥" /></Form.Item>
          <Form.Item label="规格参数" name="specs"><Input.TextArea rows={2} /></Form.Item>
          <Row gutter={16}>
            <Col span={12}><Form.Item label="使用项目" name="projects"><Input placeholder="逗号分隔" /></Form.Item></Col>
            <Col span={12}><Form.Item label="备注" name="remark"><Input /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal title={`价格历史 - ${historyName}`} open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={600}>
        <Table dataSource={historyData} rowKey="id" size="small" pagination={false}
          columns={[{ title: '旧价', dataIndex: 'old_cost', render: (v: number) => v?.toFixed(4) }, { title: '新价', dataIndex: 'new_cost', render: (v: number) => v?.toFixed(4) }, { title: '变动', key: 'd', render: (_: any, r: any) => <span style={{ color: r.new_cost > r.old_cost ? '#EF4444' : '#10B981' }}>{(r.new_cost - r.old_cost).toFixed(4)}</span> }, { title: '时间', dataIndex: 'changed_at' }]} />
      </Modal>
    </div>
  );
}
