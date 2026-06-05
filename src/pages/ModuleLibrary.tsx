import { useEffect, useState } from 'react';
import { Table, Button, Select, Space, Modal, Form, Input, InputNumber, Tag, message, Popconfirm, Tooltip } from 'antd';
import { PlusOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined, AppstoreOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { getProjects, getModules, getModuleItems, saveModule, deleteModule, saveModuleItem, deleteModuleItem, addBOMItem, getParts } from '../db';
import { MAIN_CATEGORIES, SUB_CATEGORIES, CATEGORY_COLORS } from '../constants';

export default function ModuleLibrary() {
  const [allMods, setAllMods] = useState<any[]>([]);       // all modules across all projects
  const [modGroups, setModGroups] = useState<any[]>([]);    // grouped by name: {name, projects: [{project, module, cost, count}]}
  const [activeModName, setActiveModName] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<any>(null);
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [expandedItems, setExpandedItems] = useState<any[]>([]);
  const [expandedModId, setExpandedModId] = useState<number | null>(null);

  const [modModal, setModModal] = useState(false);
  const [editMod, setEditMod] = useState<any>(null);
  const [selProjectForNewMod, setSelProjectForNewMod] = useState<number | null>(null);
  const [itemModal, setItemModal] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [targetPid, setTargetPid] = useState<number | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [form] = Form.useForm();

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    const projs = await getProjects(); setProjects(projs);
    const all: any[] = [];
    for (const p of projs) {
      const mods = await getModules(p.id);
      for (const m of mods) {
        const items = await getModuleItems(m.id);
        const total = items.reduce((s: number, i: any) => s + (i.cost || 0) * (i.quantity || 1), 0);
        all.push({ ...m, project_id: p.id, project_code: p.code, project_name: p.name, project_type: p.project_type, itemCount: items.length, totalCost: total });
      }
    }
    setAllMods(all);
    // Group by name
    const groups: Record<string, any> = {};
    for (const m of all) {
      if (!groups[m.name]) groups[m.name] = { name: m.name, projects: [] };
      groups[m.name].projects.push({ project_id: m.project_id, project_code: m.project_code, project_name: m.project_name, project_type: m.project_type, module_id: m.id, cost: m.totalCost, count: m.itemCount, description: m.description });
    }
    setModGroups(Object.values(groups));
  };

  const selectModGroup = async (group: any) => {
    setActiveModName(group.name); setActiveGroup(group);
    setExpandedPid(null); setExpandedItems([]);
  };

  const expandProject = async (pid: number, modId: number) => {
    setExpandedPid(pid); setExpandedModId(modId);
    setExpandedItems(await getModuleItems(modId));
  };

  const handleSaveMod = async () => {
    const v = await form.validateFields();
    await saveModule({ ...editMod, project_id: selProjectForNewMod, ...v });
    setModModal(false); setEditMod(null); loadAll(); message.success('已保存');
  };

  const handleSaveItem = async () => {
    const v = await form.validateFields();
    await saveModuleItem({ ...editItem, module_id: expandedModId, ...v });
    setItemModal(false); setEditItem(null);
    if (expandedModId) setExpandedItems(await getModuleItems(expandedModId));
    loadAll(); message.success('已保存');
  };

  const copyModuleToProject = async () => {
    if (!expandedModId || !targetPid) { message.warning('请先选择目标项目'); return; }
    const srcMod = allMods.find(m => m.id === expandedModId); if (!srcMod) return;
    const newModId = await saveModule({ project_id: targetPid, name: srcMod.name, description: srcMod.description });
    const items = await getModuleItems(expandedModId);
    for (const item of items) {
      let partId = item.part_id;
      if (!partId) {
        const allParts = await getParts(item.part_name, '', '');
        const match = allParts.find((p: any) => p.model === item.part_model);
        partId = match?.id || await (await import('../db')).savePart({ main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.cost, specs: '', projects: '', remark: '' });
      }
      await saveModuleItem({ module_id: newModId, part_id: partId, part_name: item.part_name, part_model: item.part_model, main_category: item.main_category, sub_category: item.sub_category, cost: item.cost, quantity: item.quantity, remark: item.remark });
      if (partId) { try { await addBOMItem(targetPid, partId, item.quantity, srcMod.name, ''); } catch (e) {} }
    }
    message.success(`已复制到目标项目`); setTargetPid(null); loadAll();
  };

  const expTotal = expandedItems.reduce((s: number, i: any) => s + (i.cost || 0) * (i.quantity || 1), 0);
  const bySubCat: Record<string, number> = {};
  expandedItems.forEach(i => { const k = i.sub_category || i.main_category || '其他'; bySubCat[k] = (bySubCat[k] || 0) + (i.cost || 0) * (i.quantity || 1); });
  const barData = Object.entries(bySubCat).map(([k, v]) => ({ name: k, value: Math.round(v * 100) / 100 })).sort((a, b) => b.value - a.value);

  const barOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].name}<br/>¥${p[0].value.toFixed(2)}` },
    grid: { left: 110, right: 60, top: 5, bottom: 5 },
    xAxis: { type: 'value', name: '¥' },
    yAxis: { type: 'category', data: barData.map(d => d.name), axisLabel: { fontSize: 11 }, inverse: true },
    series: [{ type: 'bar', barWidth: '55%', data: barData.map(d => ({ value: d.value, itemStyle: { color: CATEGORY_COLORS[expandedItems.find(i => i.sub_category === d.name)?.main_category || '其他'] || '#64748B', borderRadius: [0, 6, 6, 0] } })), label: { show: true, position: 'right', formatter: (p: any) => `¥${p.value.toFixed(2)}`, fontSize: 10 } }],
  };

  const itemCols = [
    { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={CATEGORY_COLORS[v]} style={{ margin: 0 }}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 90, ellipsis: true },
    { title: '名称', dataIndex: 'part_name', ellipsis: true },
    { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
    { title: '单价', dataIndex: 'cost', width: 80, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 55, align: 'center' as const },
    { title: '小计', key: 'sub', width: 85, align: 'right' as const, render: (_: any, r: any) => <b>{(r.cost * r.quantity).toFixed(2)}</b> },
    { title: '备注', dataIndex: 'remark', width: 100, ellipsis: true },
    {
      title: '', width: 55,
      render: (_: any, r: any) => (
        <Space size={0}>
          <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); setEditItem(r); form.setFieldsValue(r); setItemModal(true); }} /></Tooltip>
          <Popconfirm title="删除？" onConfirm={async () => { await deleteModuleItem(r.id); if (expandedModId) setExpandedItems(await getModuleItems(expandedModId)); loadAll(); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="page-title">📦 模块库</div>

      {/* Module cards - all modules grouped by name */}
      <div className="content-card" style={{ marginBottom: 14, padding: '14px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Space><AppstoreOutlined style={{ color: '#CF0A2C', fontSize: 16 }} /><b style={{ fontSize: 14 }}>全部模块（跨项目）</b></Space>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => {
            setEditMod(null); setSelProjectForNewMod(null); form.resetFields(); setModModal(true);
          }}>新建模块</Button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
          {modGroups.map(group => {
            const costs = group.projects.map((p: any) => p.cost);
            const minC = Math.min(...costs), maxC = Math.max(...costs);
            const active = activeModName === group.name;
            return (
              <div key={group.name}
                onClick={() => selectModGroup(group)}
                style={{
                  padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                  border: active ? '2px solid #CF0A2C' : '1px solid #E8ECF1',
                  background: active ? 'linear-gradient(135deg, #FFF1F0 0%, #FFF5F5 100%)' : '#FFF',
                  boxShadow: active ? '0 4px 16px rgba(207,10,44,0.12)' : '0 1px 3px rgba(0,0,0,0.04)',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={e => { if (!active) { e.currentTarget.style.borderColor = '#CF0A2C'; e.currentTarget.style.transform = 'translateY(-2px)'; } }}
                onMouseLeave={e => { if (!active) { e.currentTarget.style.borderColor = '#E8ECF1'; e.currentTarget.style.transform = 'none'; } }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, color: active ? '#CF0A2C' : '#1E293B', marginBottom: 6 }}>{group.name}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Tag style={{ margin: 0, fontSize: 11 }}>{group.projects.length} 个项目</Tag>
                  <span style={{ fontSize: 13, color: '#CF0A2C', fontWeight: 600 }}>
                    ¥{minC === maxC ? minC.toFixed(0) : `${minC.toFixed(0)}~${maxC.toFixed(0)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Module comparison view */}
      {activeGroup && (
        <div className="content-card" style={{ padding: '16px 20px', marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 14px 0', fontSize: 16, color: '#CF0A2C' }}>{activeGroup.name} — 各项目成本对比</h3>
          <Table
            dataSource={activeGroup.projects}
            rowKey="module_id"
            size="small"
            pagination={false}
            columns={[
              { title: '项目代号', dataIndex: 'project_code', width: 110, render: (v: string) => <b>{v}</b> },
              { title: '项目名称', dataIndex: 'project_name', ellipsis: true },
              { title: '类型', dataIndex: 'project_type', width: 75, render: (v: string) => <Tag color={v === '已完成' ? 'green' : 'blue'}>{v}</Tag> },
              { title: '模块成本', dataIndex: 'cost', width: 120, align: 'right' as const, render: (v: number) => <b style={{ color: '#CF0A2C', fontSize: 15 }}>¥{v.toFixed(2)}</b> },
              { title: '器件数', dataIndex: 'count', width: 70, align: 'center' as const },
              {
                title: '操作', width: 100,
                render: (_: any, r: any) => (
                  <Button type="link" size="small" icon={<EyeOutlined />}
                    onClick={() => expandProject(r.project_id, r.module_id)}
                    style={{ color: expandedPid === r.project_id ? '#CF0A2C' : undefined }}>
                    查看明细
                  </Button>
                ),
              },
            ]}
          />

          {/* Expanded detail */}
          {expandedPid && expandedItems.length > 0 && (
            <div style={{ marginTop: 16, border: '1px solid #E8ECF1', borderRadius: 8, padding: 14, background: '#FAFBFC' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <Space>
                  <b>{activeGroup.name} 明细</b>
                  <Tag color="blue">{expandedItems.length} 件</Tag>
                  <Tag color="red">¥{expTotal.toFixed(2)}</Tag>
                  <span style={{ fontSize: 11, color: '#999' }}>
                    {projects.find(p => p.id === expandedPid)?.code} {projects.find(p => p.id === expandedPid)?.name}
                  </span>
                </Space>
                <Space>
                  <Select placeholder="复制到项目..." value={targetPid || undefined} onChange={v => setTargetPid(v)} style={{ width: 200 }} size="small"
                    options={projects.filter(p => p.id !== expandedPid).map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
                  <Button size="small" icon={<CopyOutlined />} onClick={copyModuleToProject}>复制</Button>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditItem(null); form.resetFields(); form.setFieldsValue({ main_category: '硬件类', sub_category: '', quantity: 1, cost: 0 }); setItemModal(true); }}>添加器件</Button>
                  <Popconfirm title="删除模块？" onConfirm={async () => { await deleteModule(expandedModId!); setExpandedPid(null); setExpandedItems([]); loadAll(); }}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </Space>
              </div>
              <Table dataSource={expandedItems} columns={itemCols} rowKey="id" size="small" pagination={false} scroll={{ x: 850 }}
                summary={() => (<Table.Summary.Row><Table.Summary.Cell index={0} colSpan={6}><b>合计</b></Table.Summary.Cell><Table.Summary.Cell index={6} align="right"><b style={{ color: '#CF0A2C', fontSize: 14 }}>¥{expTotal.toFixed(2)}</b></Table.Summary.Cell><Table.Summary.Cell index={7} colSpan={2} /></Table.Summary.Row>)}
              />
              {barData.length > 0 && (
                <div style={{ maxWidth: 600, margin: '16px auto 0' }}>
                  <div style={{ textAlign: 'center', marginBottom: 6 }}><b style={{ fontSize: 13 }}>📊 子类成本分布</b></div>
                  <ReactECharts option={barOption} style={{ height: Math.max(160, barData.length * 34 + 30) }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Module create/edit modal */}
      <Modal title={editMod?.id ? '编辑模块' : '新建模块'} open={modModal} onOk={handleSaveMod} onCancel={() => { setModModal(false); setEditMod(null); }} width={460}>
        <Form form={form} layout="vertical">
          <Form.Item label="所属项目" required={!editMod?.id}>
            <Select placeholder="选择项目" value={selProjectForNewMod} onChange={v => setSelProjectForNewMod(v)}
              options={projects.map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
          </Form.Item>
          <Form.Item label="模块名称" name="name" rules={[{ required: true }]}><Input placeholder="如: LCM模块" /></Form.Item>
          <Form.Item label="描述" name="description"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      {/* Item edit modal */}
      <Modal title={editItem?.id ? '编辑器件' : '添加器件'} open={itemModal} onOk={handleSaveItem} onCancel={() => { setItemModal(false); setEditItem(null); }} width={600} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ main_category: '硬件类', sub_category: '', quantity: 1, cost: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
            <Form.Item label="大类" name="main_category" rules={[{ required: true }]}>
              <Select options={MAIN_CATEGORIES.map(c => ({ label: c, value: c }))} onChange={(v) => form.setFieldValue('sub_category', (SUB_CATEGORIES[v] || [])[0] || '')} />
            </Form.Item>
            <Form.Item label="子类" name="sub_category"><Select options={(SUB_CATEGORIES[form.getFieldValue('main_category')] || []).map(c => ({ label: c, value: c }))} showSearch /></Form.Item>
            <Form.Item label="数量" name="quantity"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
            <Form.Item label="器件名称" name="part_name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item label="型号" name="part_model"><Input /></Form.Item>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
            <Form.Item label="单价" name="cost"><InputNumber min={0} precision={4} style={{ width: '100%' }} prefix="¥" /></Form.Item>
            <Form.Item label="备注" name="remark"><Input /></Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
