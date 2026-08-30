import { useEffect, useState } from 'react';
import { Button, Space, Modal, Form, Input, InputNumber, Select, Tag, message, Popconfirm, Tabs, Row, Col, Collapse, Checkbox, Tooltip, Upload } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined, DownloadOutlined, UploadOutlined, ShopOutlined, InboxOutlined, ToolOutlined, FileTextOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { getCompetitors, saveCompetitor, deleteCompetitor, getCompetitorBOMs, addCompetitorBOMItem, updateCompetitorBOMItem, deleteCompetitorBOMItem, getCompetitorParts, saveCompetitorPart, deleteCompetitorPart, getProjects, getModules, getModuleItems, getMainCategories } from '../db';
import { TIERS, MAIN_CATEGORIES, SUB_CATEGORIES, getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';

export default function Competitors() {
  const [comps, setComps] = useState<any[]>([]);
  // 竞品品类筛选
  const [compCategoryFilter, setCompCategoryFilter] = useState('');
  const [productCategories, setProductCategories] = useState<any[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const watchCompCategory = Form.useWatch('category', form);
  const [selectedCid, setSelectedCid] = useState<number | null>(null);
  const [boms, setBoms] = useState<any[]>([]);
  const [cparts, setCparts] = useState<any[]>([]);
  const [bomModal, setBomModal] = useState(false);
  const [bomForm] = Form.useForm();
  const [cpartModal, setCpartModal] = useState(false);
  const [cpartEdit, setCpartEdit] = useState<any>(null);
  const [cpartForm] = Form.useForm();
  const [bomSel, setBomSel] = useState<React.Key[]>([]);
  const [cpartSel, setCpartSel] = useState<React.Key[]>([]);
  // Inline edit: each row stores its own edit state in a map
  const [editMap, setEditMap] = useState<Record<number, { name: string; model: string; qty: number; cost: number; mod: string }>>({});
  // Framework
  const [frameworkOpen, setFrameworkOpen] = useState(false);
  const [refProjectId, setRefProjectId] = useState<number | null>(null);
  const [refModules, setRefModules] = useState<any[]>([]);
  const [refModItems, setRefModItems] = useState<Record<number, any[]>>({});
  const [compEntries, setCompEntries] = useState<Record<string, { qty: number; cost: number; enabled: boolean }>>({});
  const [refProjectList, setRefProjectList] = useState<any[]>([]);
  const [mainCats, setMainCats] = useState(MAIN_CATEGORIES);
  useEffect(() => {
    (async () => {
      setComps(await getCompetitors());
      try { setMainCats(await getMainCategories()); } catch { /* 沿用内置分类 */ }
    })();
  }, []);
  // AI 数据工程联动：切回页面自动刷新（BOM/报价/原声等写库后可见）
  useEffect(() => {
    const h = async (e: Event) => { const d = (e as CustomEvent).detail; if (d?.page === 'competitors') { setComps(await getCompetitors()); } };
    window.addEventListener('app-page-active', h);
    return () => window.removeEventListener('app-page-active', h);
  }, []);
  // 加载品类列表 + 按品类筛选竞品
  useEffect(() => {
    import('../db').then(async (m) => {
      await m.ensureDefaultCategories();
      setProductCategories(await m.getProductCategories());
    });
  }, []);
  useEffect(() => { (async () => { setComps(await getCompetitors(compCategoryFilter)); })(); }, [compCategoryFilter]);
  const loadBOM = async (cid: number) => { setBoms(await getCompetitorBOMs(cid)); setBomSel([]); setEditMap({}); };
  const loadCParts = async () => { setCparts(await getCompetitorParts()); setCpartSel([]); };
  const selectComp = (cid: number) => { setSelectedCid(cid); loadBOM(cid); loadCParts(); };

  const batchDeleteBOM = async () => { for (const id of bomSel) await deleteCompetitorBOMItem(Number(id)); message.success(`已删除 ${bomSel.length} 项`); loadBOM(selectedCid!); };
  const batchDeleteCParts = async () => { for (const id of cpartSel) await deleteCompetitorPart(Number(id)); message.success(`已删除 ${cpartSel.length} 项`); loadCParts(); };

  // Start editing a row: copy current values into editMap
  const startEdit = (item: any) => {
    setEditMap(prev => ({ ...prev, [item.id]: { name: item.part_name, model: item.part_model || '', qty: item.quantity, cost: item.estimated_cost, mod: item.module_name || '' } }));
  };
  const cancelEdit = (id: number) => {
    setEditMap(prev => { const n = { ...prev }; delete n[id]; return n; });
  };
  const updateEdit = (id: number, field: string, value: any) => {
    setEditMap(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };
  const saveEdit = async (id: number) => {
    const e = editMap[id]; if (!e) return;
    await updateCompetitorBOMItem(id, e.name, e.model, e.cost, e.qty, e.mod);
    cancelEdit(id); loadBOM(selectedCid!); message.success('已保存');
  };

  // Framework
  const openFramework = async () => { setFrameworkOpen(true); setRefProjectId(null); setRefModules([]); setRefModItems({}); setCompEntries({}); };
  const loadRefProject = async (pid: number) => {
    setRefProjectId(pid); const mods = await getModules(pid); setRefModules(mods);
    const im: Record<number, any[]> = {}; const ent: Record<string, any> = {};
    for (const m of mods) { const items = await getModuleItems(m.id); im[m.id] = items; for (const item of items) ent[`${m.id}_${item.id}`] = { qty: item.quantity || 1, cost: item.cost || 0, enabled: true }; }
    setRefModItems(im); setCompEntries(ent);
  };
  const doFrameworkImport = async () => {
    if (!selectedCid || !refProjectId) return; let imported = 0;
    for (const mod of refModules) {
      for (const item of (refModItems[mod.id] || [])) {
        const key = `${mod.id}_${item.id}`; const entry = compEntries[key];
        if (!entry?.enabled || entry.qty <= 0) continue;
        await addCompetitorBOMItem(selectedCid, item.part_name, item.part_model, entry.cost, entry.qty,
          mod.name, item.part_name, item.part_model, item.cost || 0, item.quantity || 1);
        imported++;
      }
    }
    message.success(`导入 ${imported} 件`); setFrameworkOpen(false); loadBOM(selectedCid!);
  };

  const bomTotal = boms.reduce((s, b) => s + (b.estimated_cost || 0) * b.quantity, 0);
  const groupedBOMs: Record<string, any[]> = {};
  boms.forEach(b => { const m = b.module_name || '未归类'; if (!groupedBOMs[m]) groupedBOMs[m] = []; groupedBOMs[m].push(b); });
  const moduleNames = Object.keys(groupedBOMs);
  const cpartRowSel: TableRowSelection<any> = { selectedRowKeys: cpartSel, onChange: setCpartSel };

  const compCols = [
    { title: '品牌', dataIndex: 'brand', width: 100, render: (v: string) => <b>{v}</b> },
    { title: '型号', dataIndex: 'model' },
    { title: '品类', dataIndex: 'category', width: 80, render: (v: string) => <Tag color={v && v !== '未分类' ? 'purple' : 'default'}>{v || '未分类'}</Tag> },
    {
      title: '规格', key: 'cspec', width: 170, ellipsis: true,
      render: (_: any, r: any) => {
        const s = r.category === '显示器'
          ? [r.screen_size, r.resolution, r.refresh_rate, r.panel_type].filter(Boolean).join(' / ')
          : (r.specs || '');
        return s || <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
      }
    },
    { title: '档位', dataIndex: 'tier', width: 80, render: (v: string) => <Tag>{v}</Tag> },
    { title: '市场价(¥)', dataIndex: 'market_price', width: 110, align: 'right' as const, render: (v: number) => v?.toLocaleString() },
    { title: 'BOM成本(¥)', dataIndex: 'bom_cost', width: 110, align: 'right' as const, render: (v: number) => v?.toLocaleString() },
    { title: '平台费率', dataIndex: 'platform_fee_rate', width: 80, render: (v: number) => `${v}%` },
    { title: '操作', width: 120, render: (_: any, r: any) => (
      <Space size="small"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); form.setFieldsValue(r); setModalOpen(true); }} /><Popconfirm title="删除？" onConfirm={async () => { await deleteCompetitor(r.id); if (selectedCid === r.id) { setSelectedCid(null); setBoms([]); } setComps(await getCompetitors()); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm></Space>
    )},
  ];
  const cpartCols = [
    { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 100, ellipsis: true }, { title: '名称', dataIndex: 'name' }, { title: '型号', dataIndex: 'model', width: 140, ellipsis: true },
    { title: '成本', dataIndex: 'cost', width: 100, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
    { title: '操作', width: 90, render: (_: any, r: any) => (
      <Space size="small"><Button type="link" size="small" onClick={() => { setCpartEdit(r); cpartForm.setFieldsValue(r); setCpartModal(true); }}>编辑</Button><Popconfirm title="删除？" onConfirm={async () => { await deleteCompetitorPart(r.id); loadCParts(); }}><Button type="link" size="small" danger>删除</Button></Popconfirm></Space>
    )},
  ];

  return (
    <div>
      <div className="page-title"><ShopOutlined /> 竞品管理</div>
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, alignItems: 'center' }}>
          <Select
            size="small" allowClear placeholder="品类筛选" style={{ width: 140 }}
            value={compCategoryFilter || undefined}
            onChange={v => setCompCategoryFilter(v || '')}
            options={productCategories.map((c: any) => ({ label: c.name, value: c.name }))}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); form.setFieldsValue({ category: compCategoryFilter || '未分类' }); setModalOpen(true); }}>新增竞品</Button>
        </div>
        <DataTable tableId="comp_list" dataSource={comps} columns={compCols} rowKey="id" size="middle" onRow={(r) => ({ onClick: () => selectComp(r.id), style: { cursor: 'pointer', background: selectedCid === r.id ? '#FFF1F0' : undefined } })} pagination={{ pageSize: 10 }} />
      </div>

      {selectedCid && (
        <div className="content-card" style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 12, fontWeight: 600 }}>竞品BOM总计: <span style={{ color: '#CF0A2C', fontSize: 16 }}>¥{bomTotal.toFixed(2)}</span> / {boms.length} 件</div>
          <Tabs items={[{
            key: 'bom', label: <span><InboxOutlined /> 竞品BOM ({boms.length})</span>, children: (
              <div>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { bomForm.resetFields(); bomForm.setFieldsValue({ quantity: 1, estimated_cost: 0 }); setBomModal(true); }}>手动添加</Button>
                  <Button size="small" icon={<FileTextOutlined />} onClick={openFramework} style={{ borderColor: '#CF0A2C', color: '#CF0A2C' }}>从框架导入</Button>
                  <Upload beforeUpload={file => { const r = new FileReader(); r.onload = e => { const wb = XLSX.read(e.target?.result, { type: 'binary' }); const data = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]); (async () => { let n = 0; for (const d of data) { const name = d['器件名称'] || d['名称'] || d['name'] || d['part_name']; if (!name) continue; await addCompetitorBOMItem(selectedCid!, String(name).trim(), String(d['型号'] || d['model'] || d['part_model'] || '').trim(), parseFloat(d['单价'] || d['cost'] || d['estimated_cost'] || '0') || 0, parseInt(d['数量'] || d['quantity'] || '1') || 1, String(d['模块'] || d['module_name'] || '').trim(), String(d['我方名称'] || d['our_part_name'] || '').trim(), String(d['我方型号'] || d['our_part_model'] || '').trim(), parseFloat(d['我方成本'] || d['our_cost'] || '0') || 0, parseInt(d['我方数量'] || d['our_quantity'] || '0') || 0); n++; } message.success(`导入 ${n} 条`); loadBOM(selectedCid!); })(); }; r.readAsBinaryString(file); return false; }} showUploadList={false} accept=".xlsx,.xls">
                    <Button size="small" icon={<UploadOutlined />}>导入</Button>
                  </Upload>
                  <Button size="small" icon={<DownloadOutlined />} onClick={() => { const data = boms.map(b => ({ 模块: b.module_name, 器件名称: b.part_name, 型号: b.part_model, 我方名称: b.our_part_name, 我方型号: b.our_part_model, 我方成本: b.our_cost, 我方数量: b.our_quantity, 竞品数量: b.quantity, 竞品单价: b.estimated_cost, 竞品小计: (b.estimated_cost || 0) * b.quantity })); const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '竞品BOM'); XLSX.writeFile(wb, '竞品BOM_export.xlsx'); message.success('已导出'); }}>导出</Button>
                  {bomSel.length > 0 && <Popconfirm title={`批量删除 ${bomSel.length} 项？`} onConfirm={batchDeleteBOM}><Button size="small" danger icon={<DeleteOutlined />}>删除选中 ({bomSel.length})</Button></Popconfirm>}
                </Space>

                {moduleNames.map(modName => {
                  const items = groupedBOMs[modName];
                  const modTotal = items.reduce((s: number, b: any) => s + b.estimated_cost * b.quantity, 0);
                  return (
                    <div key={modName} style={{ marginBottom: 14, border: '1px solid #E8ECF1', borderRadius: 10, overflow: 'hidden' }}>
                      <div style={{ background: '#F8FAFC', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #E8ECF1' }}>
                        <Space><b style={{ fontSize: 13 }}>{modName}</b><Tag>{items.length} 件</Tag><Tag color="red">¥{modTotal.toFixed(2)}</Tag></Space>
                      </div>
                      <div style={{ padding: 6 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '30px 120px 50px 60px 1fr 60px 70px 70px', gap: 4, padding: '4px 6px', fontWeight: 600, fontSize: 10, color: '#999', borderBottom: '1px solid #F0F0F0' }}>
                          <div></div><div>我方器件</div><div style={{ textAlign: 'center' }}>量</div><div style={{ textAlign: 'right' }}>单价</div><div>竞品器件</div><div style={{ textAlign: 'center' }}>量</div><div style={{ textAlign: 'right' }}>单价</div><div style={{ textAlign: 'center' }}>操作</div>
                        </div>
                        {items.map((item: any) => {
                          const isEditing = editMap[item.id] !== undefined;
                          const ed = editMap[item.id];
                          return (
                            <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '30px 120px 50px 60px 1fr 60px 70px 70px', gap: 4, padding: '5px 6px', alignItems: 'center', borderBottom: '1px solid #F9FAFB', background: isEditing ? '#FFFBE6' : '#FFF' }}>
                              <Checkbox checked={bomSel.includes(item.id)} onChange={e => setBomSel(e.target.checked ? [...bomSel, item.id] : bomSel.filter(k => k !== item.id))} />
                              <div>
                                {item.our_part_name ? (
                                  <div><div style={{ fontSize: 10, fontWeight: 500, color: '#2563EB', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.our_part_name}>{item.our_part_name}</div><div style={{ fontSize: 8, color: '#93C5FD', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.our_part_model}>{item.our_part_model}</div></div>
                                ) : <span style={{ color: '#CCC', fontSize: 10 }}>—</span>}
                              </div>
                              <div style={{ textAlign: 'center', fontSize: 10, color: '#2563EB' }}>{item.our_quantity || '—'}</div>
                              <div style={{ textAlign: 'right', fontSize: 9, color: '#2563EB', fontFamily: 'monospace' }}>{item.our_cost ? `¥${Number(item.our_cost).toFixed(2)}` : '—'}</div>

                              {/* Competitor cells: inline editable when editMap has this id */}
                              {isEditing ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  <Input size="small" value={ed.name} onChange={e => updateEdit(item.id, 'name', e.target.value)} style={{ fontSize: 10, padding: '1px 4px', height: 20 }} />
                                  <Input size="small" value={ed.model} onChange={e => updateEdit(item.id, 'model', e.target.value)} style={{ fontSize: 9, padding: '1px 4px', height: 18 }} />
                                </div>
                              ) : (
                                <div onClick={() => startEdit(item)} style={{ cursor: 'pointer' }}>
                                  <div style={{ fontSize: 11, fontWeight: 500, color: '#CF0A2C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.part_name}</div>
                                  <div style={{ fontSize: 9, color: '#E88A95', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.part_model || '—'}</div>
                                </div>
                              )}
                              {isEditing ? (
                                <InputNumber size="small" value={ed.qty} min={1} onChange={v => updateEdit(item.id, 'qty', v || 1)} style={{ width: '100%' }} />
                              ) : (
                                <div style={{ textAlign: 'center', fontWeight: 600, fontSize: 11 }}>{item.quantity}</div>
                              )}
                              {isEditing ? (
                                <InputNumber size="small" value={ed.cost} min={0} precision={4} onChange={v => updateEdit(item.id, 'cost', v || 0)} style={{ width: '100%' }} prefix="¥" />
                              ) : (
                                <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#CF0A2C', fontSize: 10 }}>¥{Number(item.estimated_cost).toFixed(2)}</div>
                              )}
                              <div style={{ textAlign: 'center' }}>
                                {isEditing ? (
                                  <Space size={0}>
                                    <Tooltip title="保存"><Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#10B981' }} onClick={() => saveEdit(item.id)} /></Tooltip>
                                    <Tooltip title="取消"><Button type="link" size="small" icon={<CloseOutlined />} style={{ color: '#999' }} onClick={() => cancelEdit(item.id)} /></Tooltip>
                                    <Popconfirm title="删除？" onConfirm={async () => { await deleteCompetitorBOMItem(item.id); loadBOM(selectedCid!); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
                                  </Space>
                                ) : (
                                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => startEdit(item)} />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {boms.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无BOM数据，请点击"从框架导入"或"手动添加"</div>}
              </div>
            ),
          }, {
            key: 'cparts', label: <span><ToolOutlined /> 竞品器件库</span>, children: (
              <div>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setCpartEdit(null); cpartForm.resetFields(); setCpartModal(true); }}>新增器件</Button>
                  {cpartSel.length > 0 && <Popconfirm title={`批量删除 ${cpartSel.length} 项？`} onConfirm={batchDeleteCParts}><Button size="small" danger icon={<DeleteOutlined />}>删除选中 ({cpartSel.length})</Button></Popconfirm>}
                </Space>
                <DataTable tableId="comp_boms" rowKey="id" dataSource={cparts} columns={cpartCols} size="small" pagination={false} rowSelection={cpartRowSel} />
              </div>
            ),
          }]} />
        </div>
      )}

      {/* Framework modal */}
      <Modal title="从参考项目框架导入" open={frameworkOpen} onOk={doFrameworkImport} onCancel={() => setFrameworkOpen(false)} width={960} okText="确认导入" destroyOnClose>
        <div style={{ marginBottom: 14 }}><Space><span style={{ fontWeight: 600 }}>我方参考项目：</span>
          <Select style={{ width: 380 }} placeholder="选择一个项目作为框架模板" value={refProjectId} onChange={v => loadRefProject(v)}
            onDropdownVisibleChange={async (open) => { if (open) setRefProjectList(await getProjects()); }}
            options={refProjectList.map((p: any) => ({ label: `[${p.code}] ${p.name} (${p.project_type || '在研'}) — ${p.tier}`, value: p.id }))} />
        </Space></div>
        {refProjectId && refModules.length > 0 && (
          <>
            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: '#666' }}>按模块展开填写竞品数据。取消勾选跳过该项。</span>
            </div>
            <Collapse accordion style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              {refModules.map(mod => {
                const items = refModItems[mod.id] || [];
                return (
                  <Collapse.Panel key={mod.id} header={<b>{mod.name}</b>}>
                    <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr 60px 70px 60px 70px', gap: 6, padding: 4, fontWeight: 600, fontSize: 11, color: '#999' }}>
                      <div></div><div>器件 / 型号</div><div style={{ textAlign: 'center' }}>我方量</div><div style={{ textAlign: 'right' }}>我方单价</div><div style={{ textAlign: 'center' }}>竞品量</div><div style={{ textAlign: 'center' }}>竞品单价</div>
                    </div>
                    {items.map((item: any) => {
                      const key = `${mod.id}_${item.id}`; const entry = compEntries[key];
                      if (!entry) return null;
                      return (
                        <div key={key} style={{ display: 'grid', gridTemplateColumns: '30px 1fr 60px 70px 60px 70px', gap: 6, padding: '4px 0', alignItems: 'center', opacity: entry.enabled ? 1 : 0.4 }}>
                          <Checkbox checked={entry.enabled} onChange={e => setCompEntries(p => ({ ...p, [key]: { ...p[key], enabled: e.target.checked } }))} />
                          <div><div style={{ fontSize: 12 }}>{item.part_name}</div><div style={{ fontSize: 10, color: '#999' }}>{item.part_model}</div></div>
                          <div style={{ textAlign: 'center', fontSize: 12 }}>{item.quantity}</div>
                          <div style={{ textAlign: 'right', fontSize: 11, color: '#2563EB' }}>¥{Number(item.cost).toFixed(2)}</div>
                          <div><InputNumber size="small" min={0} value={entry.qty} onChange={v => setCompEntries(p => ({ ...p, [key]: { ...p[key], qty: v || 0 } }))} style={{ width: '100%' }} /></div>
                          <div><InputNumber size="small" min={0} precision={4} value={entry.cost} onChange={v => setCompEntries(p => ({ ...p, [key]: { ...p[key], cost: v || 0 } }))} prefix="¥" style={{ width: '100%' }} /></div>
                        </div>
                      );
                    })}
                  </Collapse.Panel>
                );
              })}
            </Collapse>
          </>
        )}
      </Modal>

      <Modal title={editing?.id ? '编辑竞品' : '新增竞品'} open={modalOpen} onOk={async () => { const v = await form.validateFields(); const clean = v.category === '显示器' ? { ...v, specs: '' } : { ...v, screen_size: '', resolution: '', refresh_rate: '', panel_type: '' }; await saveCompetitor({ ...editing, ...clean }); setModalOpen(false); setEditing(null); form.resetFields(); setComps(await getCompetitors(compCategoryFilter)); message.success('已保存'); }} onCancel={() => { setModalOpen(false); setEditing(null); }} width={500}>
        <Form form={form} layout="vertical" initialValues={{ tier: '主流级', market_price: 0, bom_cost: 0, platform_fee_rate: 0 }}>
          <Row gutter={16}><Col span={12}><Form.Item label="品牌 *" name="brand" rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={12}><Form.Item label="型号 *" name="model" rules={[{ required: true }]}><Input /></Form.Item></Col></Row>
          <Row gutter={16}><Col span={8}><Form.Item label="档位" name="tier"><Select options={TIERS.map(t => ({ label: t, value: t }))} /></Form.Item></Col><Col span={8}><Form.Item label="品类" name="category"><Select options={productCategories.map((c: any) => ({ label: c.name, value: c.name }))} /></Form.Item></Col><Col span={8}><Form.Item label="市场价(¥)" name="market_price"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col></Row>
          {watchCompCategory === '显示器' ? (
            <Row gutter={16}>
              <Col span={6}><Form.Item label="屏幕尺寸" name="screen_size"><Input placeholder="如 27英寸" /></Form.Item></Col>
              <Col span={6}><Form.Item label="分辨率" name="resolution"><Input placeholder="如 2560×1440" /></Form.Item></Col>
              <Col span={6}><Form.Item label="刷新率" name="refresh_rate"><Input placeholder="如 144Hz" /></Form.Item></Col>
              <Col span={6}><Form.Item label="面板" name="panel_type"><Input placeholder="如 IPS" /></Form.Item></Col>
            </Row>
          ) : (
            <Form.Item label="关键规格" name="specs" extra="该品类的核心规格（如：手写笔压感等级/鼠标 DPI/手机 SoC 内存）">
              <Input placeholder="如：压感 4096 级 / 无线" />
            </Form.Item>
          )}
          <Row gutter={16}><Col span={8}><Form.Item label="平台费率(%)" name="platform_fee_rate"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item></Col><Col span={16}><Form.Item label="BOM成本(¥)" name="bom_cost"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col></Row>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal title="手动添加" open={bomModal} onOk={async () => { const v = await bomForm.validateFields(); await addCompetitorBOMItem(selectedCid!, v.part_name, v.part_model || '', v.estimated_cost || 0, v.quantity || 1, v.module_name || ''); setBomModal(false); bomForm.resetFields(); loadBOM(selectedCid!); message.success('已添加'); }} onCancel={() => setBomModal(false)} width={450}>
        <Form form={bomForm} layout="vertical" initialValues={{ quantity: 1, estimated_cost: 0 }}>
          <Row gutter={16}><Col span={12}><Form.Item label="器件名称" name="part_name" rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={12}><Form.Item label="型号" name="part_model"><Input /></Form.Item></Col></Row>
          <Row gutter={16}><Col span={8}><Form.Item label="模块" name="module_name"><Input placeholder="如: LCM模块" /></Form.Item></Col><Col span={8}><Form.Item label="数量" name="quantity"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col><Col span={8}><Form.Item label="单价(¥)" name="estimated_cost"><InputNumber min={0} precision={4} style={{ width: '100%' }} prefix="¥" /></Form.Item></Col></Row>
        </Form>
      </Modal>

      <Modal title={cpartEdit?.id ? '编辑竞品器件' : '新增竞品器件'} open={cpartModal} onOk={async () => { const v = await cpartForm.validateFields(); await saveCompetitorPart({ ...cpartEdit, ...v, main_category: v.main_category || '硬件类' }); setCpartModal(false); setCpartEdit(null); cpartForm.resetFields(); loadCParts(); message.success('已保存'); }} onCancel={() => { setCpartModal(false); setCpartEdit(null); }} width={550} destroyOnClose>
        <Form form={cpartForm} layout="vertical" initialValues={{ main_category: '硬件类', cost: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}><Form.Item label="大类" name="main_category"><Select options={mainCats.map(c => ({ label: c, value: c }))} onChange={(v) => cpartForm.setFieldValue('sub_category', (SUB_CATEGORIES[v] || [])[0] || '')} /></Form.Item><Form.Item label="子类" name="sub_category"><Select options={(SUB_CATEGORIES[cpartForm.getFieldValue('main_category')] || []).map(c => ({ label: c, value: c }))} showSearch /></Form.Item></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}><Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="型号" name="model" rules={[{ required: true }]}><Input /></Form.Item></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}><Form.Item label="成本(¥)" name="cost"><InputNumber min={0} precision={4} style={{ width: '100%' }} prefix="¥" /></Form.Item><Form.Item label="规格" name="specs"><Input /></Form.Item></div>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
