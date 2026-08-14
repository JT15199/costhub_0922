import { useEffect, useState, useCallback, useMemo } from 'react';
import { Button, Input, Select, Space, Modal, Form, InputNumber, Tag, message, Popconfirm, Tooltip, Upload, Row, Col } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import { PlusOutlined, EditOutlined, DeleteOutlined, DownloadOutlined, UploadOutlined, HistoryOutlined, SearchOutlined, ShopOutlined, ToolOutlined, CheckOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { getParts, savePart, deletePart, getCategories, getPriceHistory, getMainCategories, getPartSuppliers, addPartSupplier, updatePartSupplier, deletePartSupplier, getSupplierPriceHistory } from '../db';
import { summarizeSupplierTrend, supplierTrendTag } from '../supplierTrend';
import { MAIN_CATEGORIES, SUB_CATEGORIES, getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';

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

  // 供应商管理状态
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [currentPart, setCurrentPart] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplierForm] = Form.useForm();
  const [editingSupplier, setEditingSupplier] = useState<any>(null);
  const [supplierLoading, setSupplierLoading] = useState(false);

  useEffect(() => { (async () => { try { setMainCats(await getMainCategories()); } catch(e) {} })(); }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await getParts(search, typeFilter, mainCat); setParts(d); setCategories(await getCategories()); } catch (e) { console.error(e); }
    setLoading(false);
  }, [search, typeFilter, mainCat]);
  useEffect(() => { load(); }, [load]);

  // ====== 项目筛选：选某项目只显示该项目 BOM 里使用的器件 ======
  const [projectFilter, setProjectFilter] = useState('');
  const [allProjects, setAllProjects] = useState<any[]>([]);
  // 该项目 BOM 关联的器件 ID 集合
  const [projectPartIds, setProjectPartIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    (async () => {
      try {
        const { getProjects } = await import('../db');
        setAllProjects(await getProjects());
      } catch { /* 忽略 */ }
    })();
  }, []);
  useEffect(() => {
    (async () => {
      if (!projectFilter) { setProjectPartIds(new Set()); return; }
      try {
        const proj = allProjects.find((p: any) => p.name === projectFilter);
        if (!proj) { setProjectPartIds(new Set()); return; }
        const db = await (await import('../db')).getDb();
        const rows = await db.select<any[]>(
          'SELECT DISTINCT part_id FROM project_boms WHERE project_id = ? AND COALESCE(is_deleted,0) = 0 AND part_id IS NOT NULL',
          [proj.id]
        );
        setProjectPartIds(new Set(rows.map((r: any) => r.part_id)));
      } catch { setProjectPartIds(new Set()); }
    })();
  }, [projectFilter, allProjects]);
  // 前端过滤：BOM 反查（最准确）+ projects 字段匹配（兼容旧数据）双保险
  const filteredParts = useMemo(() => {
    if (!projectFilter) return parts;
    const proj = allProjects.find((p: any) => p.name === projectFilter);
    const matchKeys = [projectFilter];
    if (proj) {
      if (proj.code) matchKeys.push(proj.code);
      if (proj.name) matchKeys.push(proj.name);
    }
    return parts.filter((p: any) => {
      if (projectPartIds.has(p.id)) return true; // BOM 反查命中
      const projText = `${p.projects || ''}`;
      return matchKeys.some(k => k && projText.includes(k)); // projects 字段匹配
    });
  }, [parts, projectFilter, allProjects, projectPartIds]);

  // 子类选项按大类联动：大类已选 → 只显示该大类下的子类（常量表 + 数据库实际值合并）
  const subCatOptions = useMemo(() => {
    if (!mainCat) return categories.map(c => ({ label: c, value: c }));
    // 常量表定义的子类 + 当前大类下 parts 里实际存在的子类（支持自定义子类）
    const fromConst = SUB_CATEGORIES[mainCat] || [];
    const fromParts = Array.from(new Set(parts.filter(p => p.main_category === mainCat).map(p => p.sub_category).filter(Boolean))) as string[];
    const merged = Array.from(new Set([...fromConst, ...fromParts]));
    return merged.map(c => ({ label: c, value: c }));
  }, [mainCat, categories, parts]);

  // 编辑弹窗用：任意大类的动态子类选项（常量 + 数据库实际值）
  const getSubOptionsFor = (mainCatValue: string) => {
    const fromConst = SUB_CATEGORIES[mainCatValue] || [];
    const fromParts = Array.from(new Set(parts.filter(p => p.main_category === mainCatValue).map(p => p.sub_category).filter(Boolean))) as string[];
    return Array.from(new Set([...fromConst, ...fromParts])).map(c => ({ label: c, value: c }));
  };
  // 切换大类时清空子类筛选，避免出现"硬件类 + 包材类子类"的无效组合
  const handleMainCatChange = (v: string) => {
    setMainCat(v || '');
    if (v !== mainCat) setTypeFilter('');
  };

  const handleImport = (file: File) => {
    const r = new FileReader();
    r.onload = async (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
        const data = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);
        let successCount = 0;
        const failures: string[] = [];
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          const name = d['名称'] || d['name'] || d['器件名称'];
          if (!name) continue;
          try {
            await savePart({
              main_category: d['大类'] || d['main_category'] || '硬件类',
              sub_category: d['子类'] || d['sub_category'] || '',
              category: d['大类'] || d['main_category'] || '硬件类',
              name: String(name).trim(),
              model: String(d['型号'] || d['model'] || '').trim(),
              cost: parseFloat(d['成本'] || d['cost'] || d['价格'] || '0') || 0,
              specs: d['规格'] || d['specs'] || '',
              projects: d['项目'] || d['projects'] || '',
              remark: d['备注'] || d['remark'] || '',
            });
            successCount++;
          } catch (err: any) {
            failures.push(`第${i + 2}行「${name}」: ${err?.message || '未知错误'}`);
          }
        }
        if (failures.length === 0) {
          message.success(`导入完成，共 ${successCount} 条`);
        } else {
          message.warning(`导入完成：成功 ${successCount} 条，失败 ${failures.length} 条`);
          Modal.warning({
            title: `${failures.length} 条记录导入失败`,
            content: (
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {failures.map((f, i) => <div key={i} style={{ fontSize: 12, marginBottom: 4, color: '#EF4444' }}>{f}</div>)}
              </div>
            ),
            okText: '知道了',
          });
        }
        load();
      } catch (err: any) {
        message.error(`文件解析失败: ${err?.message || '请检查文件格式'}`);
      }
    };
    r.readAsBinaryString(file);
    return false;
  };

  const handleExport = () => {
    const hasFilter = !!(search || typeFilter || mainCat);
    const doExport = () => {
      const ws = XLSX.utils.json_to_sheet(parts.map(p => ({
        ID: p.id, 大类: p.main_category, 子类: p.sub_category,
        名称: p.name, 型号: p.model, 成本: p.cost, 项目: p.projects, 备注: p.remark,
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '器件库');
      XLSX.writeFile(wb, `器件库${hasFilter ? '_筛选结果' : ''}.xlsx`);
      message.success(`已导出 ${parts.length} 条`);
    };
    if (hasFilter) {
      Modal.confirm({
        title: '导出筛选结果',
        content: `当前有过滤条件，将只导出筛选后的 ${parts.length} 条记录（非全量数据）。`,
        okText: '确认导出',
        cancelText: '取消',
        onOk: doExport,
      });
    } else {
      doExport();
    }
  };

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

  // 供应商管理函数
  // 供应商价格趋势（part_supplier_price_history → 一句话小结）
  const [supplierTrends, setSupplierTrends] = useState<Record<number, any>>({});
  const refreshSupplierTrends = async (list: any[], part?: any) => {
    try {
      const p = part || currentPart;
      const entries = await Promise.all(list.map(async (s: any) => [s.id, summarizeSupplierTrend(await getSupplierPriceHistory(p.id, s.supplier_name))] as const));
      setSupplierTrends(Object.fromEntries(entries));
    } catch { /* 趋势失败不影响主列表 */ }
  };
  const openSupplierModal = async (part: any) => {
    setCurrentPart(part);
    setSupplierLoading(true);
    try {
      const partSuppliers = await getPartSuppliers(part.id);
      setSuppliers(partSuppliers);
      refreshSupplierTrends(partSuppliers, part);
    } catch (e) {
      console.error('Failed to load suppliers:', e);
      message.error('加载供应商失败');
    } finally {
      setSupplierLoading(false);
    }
    setSupplierModalOpen(true);
  };

  const handleSupplierSave = async () => {
    try {
      const values = await supplierForm.validateFields();
      const data = {
        ...editingSupplier,
        ...values,
        part_id: currentPart.id,
      };

      if (editingSupplier?.id) {
        await updatePartSupplier(data);
        message.success('供应商已更新');
      } else {
        await addPartSupplier(data);
        message.success('供应商已添加');
      }

      // 刷新供应商列表和器件列表（因为成本可能变化）
      const partSuppliers = await getPartSuppliers(currentPart.id);
      setSuppliers(partSuppliers);
      refreshSupplierTrends(partSuppliers);
      load(); // 刷新器件列表以显示更新后的成本

      supplierForm.resetFields();
      setEditingSupplier(null);
    } catch (e) {
      console.error('Failed to save supplier:', e);
      message.error('保存失败');
    }
  };

  const handleSupplierDelete = async (supplierId: number) => {
    try {
      await deletePartSupplier(supplierId);
      message.success('供应商已删除');

      // 刷新供应商列表和器件列表
      const partSuppliers = await getPartSuppliers(currentPart.id);
      setSuppliers(partSuppliers);
      refreshSupplierTrends(partSuppliers);
      load();
    } catch (e) {
      console.error('Failed to delete supplier:', e);
      message.error('删除失败');
    }
  };

  const openSupplierEdit = (supplier?: any) => {
    setEditingSupplier(supplier || null);
    supplierForm.setFieldsValue(supplier ? { ...supplier } : {
      supplier_name: '',
      price: 0,
      share_ratio: 0,
      is_active: 1,
      remark: ''
    });
  };

  const setAsPrimarySupplier = async (supplier: any) => {
    try {
      // 将该供应商设为100%份额，其他设为0
      for (const s of suppliers) {
        await updatePartSupplier({
          id: s.id,
          part_id: currentPart.id,
          supplier_name: s.supplier_name,
          price: s.price,
          share_ratio: s.id === supplier.id ? 100 : 0,
          is_active: s.id === supplier.id ? 1 : s.is_active,
          remark: s.remark,
        });
      }

      message.success(`已设置 ${supplier.supplier_name} 为主供应商`);

      // 刷新
      const partSuppliers = await getPartSuppliers(currentPart.id);
      setSuppliers(partSuppliers);
      load();
    } catch (e) {
      console.error('Failed to set primary supplier:', e);
      message.error('设置失败');
    }
  };

  const cols = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 100 },
    { title: '名称', dataIndex: 'name', width: 200, ellipsis: true },
    { title: '型号', dataIndex: 'model', width: 150, ellipsis: true },
    { title: '成本(¥)', dataIndex: 'cost', width: 100, align: 'right' as const, render: (v: number) => <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{v?.toFixed(2)}</span> },
    { title: '项目', dataIndex: 'projects', width: 100, ellipsis: true },
    { title: '操作', width: 180, render: (_: any, r: any) => (
      <Space size="small">
        <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} /></Tooltip>
        <Tooltip title="供应商"><Button type="link" size="small" icon={<ShopOutlined />} onClick={() => openSupplierModal(r)} /></Tooltip>
        <Tooltip title="价格历史"><Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showHistory(r)} /></Tooltip>
        <Popconfirm title="删除？" onConfirm={() => handleDelete(r.id)}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
      </Space>
    )},
  ];

  return (
    <div>
      <div className="page-title"><ToolOutlined /> 器件库</div>
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Input prefix={<SearchOutlined />} placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} allowClear />
            <Select placeholder="大类" value={mainCat || undefined} onChange={handleMainCatChange} allowClear style={{ width: 110 }} options={mainCats.map(c => ({ label: c, value: c }))} />
            <Select placeholder="子类" value={typeFilter || undefined} onChange={v => setTypeFilter(v || '')} allowClear style={{ width: 130 }} options={subCatOptions} />
            {/* 项目筛选：选某项目只显示关联该项目的器件 */}
            <Select
              placeholder="项目" allowClear showSearch style={{ width: 180 }}
              value={projectFilter || undefined}
              onChange={v => { setProjectFilter(v || ''); setSelKeys([]); }}
              optionFilterProp="label"
              options={allProjects.map((p: any) => ({ label: `${p.code} · ${p.name}`, value: p.name }))}
            />
          </Space>
          <Space>
            <Upload beforeUpload={handleImport} showUploadList={false}><Button icon={<UploadOutlined />}>导入Excel</Button></Upload>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>导出Excel</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增器件</Button>
          </Space>
        </div>
        <div style={{ marginBottom: 8 }}>{selKeys.length > 0 && (
          <Popconfirm title={`批量删除 ${selKeys.length} 条？`} onConfirm={batchDelete}><Button size="small" danger icon={<DeleteOutlined />}>删除选中 ({selKeys.length})</Button></Popconfirm>
        )}</div>
        <DataTable tableId="parts_lib" dataSource={filteredParts} columns={cols} rowKey="id" size="middle" loading={loading} rowSelection={rowSel} pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }} scroll={{ x: 900 }} />
      </div>

      <Modal title={editing?.id ? '编辑器件' : '新增器件'} open={modalOpen} onOk={handleSave} onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields(); }} width={560} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ main_category: '硬件类', cost: 0 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="大类" name="main_category">
                <Select options={mainCats.map(c => ({ label: c, value: c }))} onChange={(v) => { const subs = getSubOptionsFor(v).map((x: any) => x.value); form.setFieldValue('sub_category', subs[0] || ''); form.setFieldValue('category', v); }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="子类" name="sub_category">
                <Select options={getSubOptionsFor(form.getFieldValue('main_category'))} />
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
        <DataTable tableId="parts_price_hist" dataSource={historyData} rowKey="id" size="small" pagination={false}
          columns={[{ title: '旧价', dataIndex: 'old_cost', render: (v: number) => v?.toFixed(2) }, { title: '新价', dataIndex: 'new_cost', render: (v: number) => v?.toFixed(2) }, { title: '变动', key: 'd', render: (_: any, r: any) => <span style={{ color: r.new_cost > r.old_cost ? '#EF4444' : '#10B981' }}>{(r.new_cost - r.old_cost).toFixed(2)}</span> }, { title: '时间', dataIndex: 'changed_at' }]} />
      </Modal>

      <Modal
        title={`供应商管理 - ${currentPart?.name} [${currentPart?.model}]`}
        open={supplierModalOpen}
        onCancel={() => {
          setSupplierModalOpen(false);
          setCurrentPart(null);
          setSuppliers([]);
          setEditingSupplier(null);
          supplierForm.resetFields();
        }}
        footer={null}
        width={800}
      >
        <div style={{ marginBottom: 16 }}>
          <Form form={supplierForm} layout="inline" onFinish={handleSupplierSave}>
            <Form.Item label="供应商" name="supplier_name" rules={[{ required: true, message: '请输入供应商名称' }]}>
              <Input placeholder="供应商名称" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item label="报价(¥)" name="price" rules={[{ required: true, message: '请输入报价' }]}>
              <InputNumber min={0} precision={4} style={{ width: 110 }} placeholder="0.0000" />
            </Form.Item>
            <Form.Item label="份额(%)" name="share_ratio" rules={[{ required: true, message: '请输入份额' }]}>
              <InputNumber min={0} max={100} precision={2} style={{ width: 90 }} placeholder="0" />
            </Form.Item>
            <Form.Item label="状态" name="is_active">
              <Select style={{ width: 80 }} options={[{ label: '启用', value: 1 }, { label: '停用', value: 0 }]} />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit">{editingSupplier ? '更新' : '添加'}</Button>
                {editingSupplier && (
                  <Button onClick={() => {
                    setEditingSupplier(null);
                    supplierForm.resetFields();
                  }}>取消</Button>
                )}
              </Space>
            </Form.Item>
          </Form>
        </div>

        <DataTable tableId="parts_suppliers"
          dataSource={suppliers}
          rowKey="id"
          size="small"
          loading={supplierLoading}
          pagination={false}
          columns={[
            {
              title: '供应商',
              dataIndex: 'supplier_name',
              width: 150,
              ellipsis: true,
              render: (text: string, record: any) => {
                const isLowest = suppliers.length > 1 && record.price === Math.min(...suppliers.map(s => s.price));
                return (
                  <Space>
                    <span>{text}</span>
                    {isLowest && <Tag color="green">最低价</Tag>}
                  </Space>
                );
              }
            },
            {
              title: '报价(¥)',
              dataIndex: 'price',
              width: 110,
              align: 'right' as const,
              render: (v: number) => {
                const isLowest = suppliers.length > 1 && v === Math.min(...suppliers.map(s => s.price));
                const isHighest = suppliers.length > 1 && v === Math.max(...suppliers.map(s => s.price));
                return (
                  <span style={{
                    fontFamily: 'monospace',
                    fontWeight: 500,
                    color: isLowest ? '#10B981' : isHighest ? '#EF4444' : undefined
                  }}>
                    ¥{v?.toFixed(2)}
                  </span>
                );
              }
            },
            {
              title: '份额',
              dataIndex: 'share_ratio',
              width: 90,
              align: 'right' as const,
              render: (v: number) => (
                <span style={{ fontWeight: 500, color: v > 0 ? '#10B981' : '#94A3B8' }}>
                  {v || 0}%
                </span>
              )
            },
            {
              title: '状态',
              dataIndex: 'is_active',
              width: 70,
              render: (v: number) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '停用'}</Tag>
            },
            {
              title: '价格趋势',
              key: 'trend',
              width: 130,
              render: (_: any, record: any) => {
                const t = supplierTrends[record.id];
                if (!t || t.direction === 'none') return <span style={{ color: '#C0C8D0', fontSize: 12 }}>暂无记录</span>;
                const tag = supplierTrendTag(t);
                return <Tag color={tag.color} style={{ fontSize: 11.5 }}>{tag.text}</Tag>;
              }
            },
            { title: '备注', dataIndex: 'remark', ellipsis: true, width: 120 },
            {
              title: '操作',
              width: 180,
              render: (_: any, record: any) => (
                <Space size="small">
                  <Button
                    type="link"
                    size="small"
                    onClick={() => openSupplierEdit(record)}
                  >
                    编辑
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setAsPrimarySupplier(record)}
                  >
                    设为主供应商
                  </Button>
                  <Popconfirm
                    title="确定删除？"
                    onConfirm={() => handleSupplierDelete(record.id)}
                  >
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          footer={() => {
            // 计算统计信息
            const activeSuppliers = suppliers.filter(s => s.is_active);
            const totalShare = activeSuppliers.reduce((sum, s) => sum + (Number(s.share_ratio) || 0), 0);

            let weightedPrice = 0;
            if (totalShare > 0) {
              weightedPrice = activeSuppliers.reduce((sum, s) => {
                const share = Number(s.share_ratio) || 0;
                const price = Number(s.price) || 0;
                return sum + (price * share / totalShare);
              }, 0);
            } else if (activeSuppliers.length > 0) {
              weightedPrice = Number(activeSuppliers[0]?.price) || 0;
            }

            const minPrice = suppliers.length > 0 ? Math.min(...suppliers.map(s => s.price)) : 0;
            const maxPrice = suppliers.length > 0 ? Math.max(...suppliers.map(s => s.price)) : 0;

            return (
              <div style={{ padding: '12px 0' }}>
                {/* 供应商价格趋势小结（规则驱动，自动生成） */}
                {suppliers.filter(s => supplierTrends[s.id] && supplierTrends[s.id].direction !== 'none').length > 0 && (
                  <div style={{ marginBottom: 12, padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
                    <b style={{ color: '#0A84FF', marginRight: 6 }}>📈 供应商价格趋势</b>
                    {suppliers.filter(s => supplierTrends[s.id] && supplierTrends[s.id].direction !== 'none').map(s => {
                      const t = supplierTrends[s.id];
                      const first = t.direction === 'up' ? '持续上涨' : t.direction === 'down' ? '持续下降' : t.direction === 'mixed' ? '价格波动' : t.direction === 'flat' ? '基本平稳' : '仅一次变动';
                      const pct = t.totalPct ?? 0;
                      const reason = t.lastReason ? '，最近原因：' + t.lastReason : '';
                      return (
                        <div key={s.id} style={{ marginTop: 2 }}>
                          <b>{s.supplier_name}</b>：{first}（累计 {pct > 0 ? '+' : ''}{pct.toFixed(1)}%）{reason}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div>
                    <span style={{ color: '#64748B', marginRight: 8 }}>供应商数量:</span>
                    <span style={{ fontSize: 16, fontWeight: 600 }}>{suppliers.length}</span>
                    <span style={{ color: '#64748B', marginLeft: 16, marginRight: 8 }}>启用:</span>
                    <span style={{ fontSize: 16, fontWeight: 600, color: '#10B981' }}>{activeSuppliers.length}</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748B', marginRight: 8 }}>价格区间:</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 500, color: '#10B981' }}>
                      ¥{minPrice.toFixed(2)}
                    </span>
                    <span style={{ margin: '0 8px', color: '#94A3B8' }}>~</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 500, color: '#EF4444' }}>
                      ¥{maxPrice.toFixed(2)}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, borderTop: '1px solid #E2E8F0' }}>
                  <div>
                    <span style={{ color: '#64748B', marginRight: 8 }}>份额总和:</span>
                    <span style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: Math.abs(totalShare - 100) < 0.01 ? '#10B981' : (totalShare > 100 ? '#EF4444' : '#F59E0B')
                    }}>
                      {totalShare.toFixed(2)}%
                    </span>
                    {Math.abs(totalShare - 100) < 0.01 && <CheckOutlined style={{ color: '#10B981', marginLeft: 8 }} />}
                    {totalShare > 100 && <span style={{ color: '#EF4444', marginLeft: 8, fontSize: 12 }}>超出100%</span>}
                    {totalShare < 100 && totalShare > 0 && <span style={{ color: '#F59E0B', marginLeft: 8, fontSize: 12 }}>未达100%</span>}
                  </div>
                  <div>
                    <span style={{ color: '#64748B', marginRight: 8 }}>加权成本:</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: '#CF0A2C', fontFamily: 'monospace' }}>
                      ¥{weightedPrice.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            );
          }}
        />
      </Modal>
    </div>
  );
}
