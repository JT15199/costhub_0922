import { useEffect, useState } from 'react';
import { Table, Button, Input, Select, Space, Modal, Form, InputNumber, Tag, message, Popconfirm, Tabs, Row, Col, Tooltip, Card, Statistic, Upload, Alert } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, UploadOutlined, DownloadOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { getProjects, saveProject, deleteProject, copyProject, getProjectBOMs, addBOMItem, updateBOMItem, deleteBOMItem, getParts, getCostReviews, saveCostReview, deleteCostReview, getMeasures, saveMeasure, deleteMeasure, savePart, getModules, getModuleItems } from '../db';
import { TIERS, PROJECT_STATUSES, PROJECT_TYPES, SCREEN_SIZES, RESOLUTIONS, REFRESH_RATES, PANEL_TYPES, MAIN_CATEGORIES, SUB_CATEGORIES, MEASURE_STATUSES, CATEGORY_COLORS } from '../constants';

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [boms, setBoms] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [bomModal, setBomModal] = useState(false);
  const [bomEdit, setBomEdit] = useState<any>(null);
  const [bomForm] = Form.useForm();
  const [allParts, setAllParts] = useState<any[]>([]);
  const [reviewModal, setReviewModal] = useState(false);
  const [measureModal, setMeasureModal] = useState(false);
  const [copyModal, setCopyModal] = useState(false);
  const [copyForm] = Form.useForm();
  const [importModal, setImportModal] = useState(false);
  const [importData, setImportData] = useState<any[]>([]);
  const [importPreview, setImportPreview] = useState<any[]>([]);
  // Module import states
  const [modList, setModList] = useState<any[]>([]);
  const [previewModItems, setPreviewModItems] = useState<any[]>([]);

  const loadProjects = async () => { setLoading(true); try { setProjects(await getProjects('', typeFilter)); } catch (e) { console.error(e); } setLoading(false); };
  useEffect(() => { loadProjects(); }, [typeFilter]);

  const loadBOM = async (pid: number) => setBoms(await getProjectBOMs(pid));
  const loadReviews = async (pid: number) => setReviews(await getCostReviews(pid));
  const loadMeasures = async (pid: number) => setMeasures(await getMeasures(pid));

  const selectProject = (pid: number) => { setSelectedPid(pid); loadBOM(pid); loadReviews(pid); loadMeasures(pid); };

  const handleSaveProject = async () => {
    const vals = await form.validateFields();
    await saveProject({ ...editing, ...vals });
    setModalOpen(false); setEditing(null); form.resetFields(); loadProjects(); message.success('保存成功');
  };

  // ===== BOM Import with module classification =====
  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target?.result, { type: 'binary' });
      const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);
      // Expected columns: 模块名, 大类, 子类, 器件名称, 型号, 单价, 数量, 备注
      const nameKeys = ['器件名称', 'name', '名称', 'part_name', 'Description'];
      const modelKeys = ['型号', 'model', 'part_model', 'MPN', '料号'];
      const moduleKeys = ['模块', 'module', '模块名', 'module_name', '功能模块'];
      const mainKeys = ['大类', 'main_category', '主类'];
      const subKeys = ['子类', 'sub_category', '小类', '类型'];
      const costKeys = ['单价', 'cost', '价格', 'price', '成本'];
      const qtyKeys = ['数量', 'quantity', 'qty', '用量'];
      const remarkKeys = ['备注', 'remark', 'note'];

      const getVal = (r: any, keys: string[]) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return String(r[k]).trim(); } return ''; };

      const parsed = rows.map(r => ({
        project_code: getVal(r, ['项目代号', 'project_code', 'code']),
        project_name: getVal(r, ['项目名称', 'project_name']),
        module_name: getVal(r, moduleKeys) || '未归类',
        main_category: getVal(r, mainKeys) || '硬件类',
        sub_category: getVal(r, subKeys) || getVal(r, subKeys.includes('类型') ? subKeys : []),
        name: getVal(r, nameKeys),
        model: getVal(r, modelKeys),
        cost: parseFloat(getVal(r, costKeys)) || 0,
        quantity: parseInt(getVal(r, qtyKeys)) || 1,
        remark: getVal(r, remarkKeys),
      })).filter(r => r.name);
      setImportData(parsed);
      setImportPreview(parsed);
      setImportModal(true);
    };
    reader.readAsBinaryString(file);
    return false;
  };

  const doImport = async () => {
    // Auto-create project if importing a new project code
    const projCode = importData[0]?.project_code;
    let targetPid = selectedPid;
    if (projCode && !targetPid) {
      const existing = projects.find(p => p.code === projCode);
      if (!existing) {
        const newId = await saveProject({ code: projCode, name: importData[0]?.project_name || projCode, project_type: '在研', tier: '主流级', status: '进行中', platform_fee_rate: 0, profit_rate: 0 });
        targetPid = newId;
        setSelectedPid(newId);
        loadProjects();
        message.success(`已自动创建项目: ${projCode}`);
      } else {
        targetPid = existing.id;
        setSelectedPid(existing.id);
      }
    }
    if (!targetPid) { message.warning('请先选择一个项目'); return; }
    // For each row: save to parts library, then add to BOM with module_name
    for (const row of importData) {
      if (!row.name) continue;
      // Check existing part
      const existing = await getParts(row.name, '', '');
      const match = existing.find((p: any) => p.model === row.model);
      let partId: number;
      if (match) {
        partId = match.id!;
        // Update cost if changed
        if (Math.abs(match.cost - row.cost) > 0.0001) {
          await savePart({ ...match, cost: row.cost, main_category: row.main_category, sub_category: row.sub_category, projects: match.projects ? `${match.projects},${projects.find(p => p.id === selectedPid)?.code || ''}` : (projects.find(p => p.id === selectedPid)?.code || '') });
        }
      } else {
        partId = await savePart({
          main_category: row.main_category, sub_category: row.sub_category,
          category: row.main_category, name: row.name, model: row.model,
          cost: row.cost, specs: '', projects: projects.find(p => p.id === selectedPid)?.code || '', remark: row.remark,
        });
      }
      await addBOMItem(targetPid!, partId, row.quantity, row.module_name, row.remark);
    }
    setImportModal(false); loadBOM(targetPid!); loadProjects();
    message.success(`导入完成: ${importData.length} 条`);
  };

  const bomTotal = boms.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
  // Module grouping
  const moduleSummary: Record<string, number> = {};
  boms.forEach(b => { const m = b.module_name || '未归类'; moduleSummary[m] = (moduleSummary[m] || 0) + (b.part_cost || 0) * b.quantity; });

  const projectCols = [
    { title: '代号', dataIndex: 'code', width: 95, render: (v: string) => <b>{v}</b> },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    { title: '类型', dataIndex: 'project_type', width: 75, render: (v: string) => <Tag color={v === '已完成' ? 'green' : 'blue'}>{v || '在研'}</Tag> },
    { title: '状态', dataIndex: 'status', width: 75, render: (v: string) => <Tag color={v === '进行中' ? 'blue' : v === '已完成' ? 'green' : 'default'}>{v}</Tag> },
    { title: '屏幕规格', key: 's', width: 190, ellipsis: true, render: (_: any, r: any) => [r.screen_size, r.resolution, r.refresh_rate, r.panel_type].filter(Boolean).join(' / ') },
    { title: '费率', key: 'f', width: 95, render: (_: any, r: any) => `平台${r.platform_fee_rate}% / 利${r.profit_rate}%` },
    {
      title: '操作', width: 130, render: (_: any, r: any) => (
        <Space size="small">
          <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); form.setFieldsValue(r); setModalOpen(true); }} /></Tooltip>
          <Tooltip title="复制"><Button type="link" size="small" icon={<CopyOutlined />} onClick={() => { selectProject(r.id); setCopyModal(true); copyForm.setFieldsValue({ code: `${r.code}-CP`, name: `${r.name}(副本)` }); }} /></Tooltip>
          <Popconfirm title="删除？" onConfirm={async () => { await deleteProject(r.id); loadProjects(); setSelectedPid(null); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
        </Space>
      ),
    },
  ];

  const bomCols = [
    { title: '模块', dataIndex: 'module_name', width: 90, render: (v: string) => v ? <Tag>{v}</Tag> : <Tag color="#ddd">未归类</Tag> },
    { title: '大类', dataIndex: 'main_category', width: 75, render: (v: string) => <Tag color={CATEGORY_COLORS[v]}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 90 },
    { title: '名称', dataIndex: 'part_name', ellipsis: true },
    { title: '型号', dataIndex: 'part_model', ellipsis: true },
    { title: '单价', dataIndex: 'part_cost', width: 85, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 55, align: 'center' as const },
    { title: '小计', key: 'sub', width: 85, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost || 0) * r.quantity).toFixed(2)}</b> },
    { title: '操作', width: 75, render: (_: any, r: any) => (
      <Space size="small">
        <Button type="link" size="small" onClick={() => { setBomEdit(r); bomForm.setFieldsValue(r); setBomModal(true); }}>编辑</Button>
        <Popconfirm title="移除？" onConfirm={async () => { await deleteBOMItem(r.id); loadBOM(selectedPid!); }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
      </Space>
    )},
  ];

  return (
    <div>
      <div className="page-title">📋 项目管理</div>
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <Select placeholder="类型筛选" value={typeFilter || undefined} onChange={v => setTypeFilter(v || '')} allowClear style={{ width: 120 }} options={PROJECT_TYPES.map(s => ({ label: s, value: s }))} />
          </Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalOpen(true); }}>新建项目</Button>
        </div>
        <Table dataSource={projects} columns={projectCols} rowKey="id" size="middle" loading={loading}
          onRow={(r) => ({ onClick: () => selectProject(r.id), style: { cursor: 'pointer', background: selectedPid === r.id ? '#FFF1F0' : undefined } })}
          pagination={{ pageSize: 15, showTotal: t => `共 ${t} 个项目` }} />
      </div>

      {selectedPid && (
        <div className="content-card" style={{ marginTop: 14 }}>
          <Row gutter={14} style={{ marginBottom: 14 }}>
            <Col span={6}><Card size="small"><Statistic title="BOM总成本" value={bomTotal} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
            <Col span={18}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(moduleSummary).map(([name, cost]) => (
                  <Tag key={name} color="blue" style={{ fontSize: 12, padding: '4px 10px' }}>{name}: ¥{cost.toFixed(2)}</Tag>
                ))}
              </div>
            </Col>
          </Row>
          <Tabs defaultActiveKey="bom" items={[
            {
              key: 'bom', label: `📦 BOM清单 (${boms.length}件)`, children: (
                <div>
                  <div style={{ marginBottom: 12 }}>
                    <Space>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={async () => { setAllParts(await getParts()); setBomEdit(null); setPreviewModItems([]); bomForm.resetFields(); bomForm.setFieldsValue({ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }); setBomModal(true); }}>添加器件</Button>
                      <Upload beforeUpload={handleImportFile} showUploadList={false} accept=".xlsx,.xls">
                        <Button size="small" icon={<UploadOutlined />}>导入</Button>
                      </Upload>
                      <Button size="small" icon={<DownloadOutlined />} onClick={() => {
                        const data = boms.map(b => ({
                          模块: b.module_name, 大类: b.main_category, 子类: b.sub_category,
                          器件名称: b.part_name, 型号: b.part_model, 单价: b.part_cost,
                          数量: b.quantity, 小计: (b.part_cost || 0) * b.quantity, 备注: b.remark,
                        }));
                        const ws = XLSX.utils.json_to_sheet(data);
                        const wb = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(wb, ws, 'BOM');
                        XLSX.writeFile(wb, `BOM_${projects.find(p => p.id === selectedPid)?.code || 'export'}.xlsx`);
                        message.success('已导出');
                      }}>导出</Button>
                    </Space>
                  </div>
                  <Table dataSource={boms} columns={bomCols} rowKey="id" size="small" pagination={{ pageSize: 30, showTotal: t => `${t} 条` }} scroll={{ x: 1000 }} />
                </div>
              ),
            },
            {
              key: 'reviews', label: '📊 成本测算', children: (
                <div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setReviewModal(true)} style={{ marginBottom: 12 }}>添加测算</Button>
                  <Table dataSource={reviews} rowKey="id" size="small" pagination={false}
                    columns={[
                      { title: '阶段', dataIndex: 'stage' }, { title: '成本(¥)', dataIndex: 'reviewed_cost', render: (v: number) => v?.toFixed(2) },
                      { title: '测算人', dataIndex: 'reviewer' }, { title: '时间', dataIndex: 'reviewed_at' }, { title: '备注', dataIndex: 'remark' },
                      { title: '', width: 60, render: (_: any, r: any) => <Popconfirm title="删除？" onConfirm={async () => { await deleteCostReview(r.id); loadReviews(selectedPid!); }}><Button type="link" size="small" danger>删除</Button></Popconfirm> },
                    ]} />
                </div>
              ),
            },
            {
              key: 'measures', label: '🎯 降本措施', children: (
                <div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setMeasureModal(true)} style={{ marginBottom: 12 }}>添加措施</Button>
                  <Table dataSource={measures} rowKey="id" size="small" pagination={false}
                    columns={[
                      { title: '大类', dataIndex: 'main_category', width: 80 }, { title: '措施', dataIndex: 'measure' },
                      { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === '已完成' ? 'green' : v === '执行中' ? 'blue' : 'default'}>{v}</Tag> },
                      { title: '负责人', dataIndex: 'owner', width: 70 }, { title: '截止', dataIndex: 'due_date', width: 100 },
                      { title: '', width: 60, render: (_: any, r: any) => <Popconfirm title="删除？" onConfirm={async () => { await deleteMeasure(r.id); loadMeasures(selectedPid!); }}><Button type="link" size="small" danger>删除</Button></Popconfirm> },
                    ]} />
                </div>
              ),
            },
          ]} />
        </div>
      )}

      {/* Project edit modal */}
      <Modal title={editing?.id ? '编辑项目' : '新建项目'} open={modalOpen} onOk={handleSaveProject} onCancel={() => { setModalOpen(false); setEditing(null); }} width={640} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={editing || { project_type: '在研', tier: '主流级', status: '进行中', platform_fee_rate: 0, profit_rate: 0 }}>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="项目代号*" name="code" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="项目名称*" name="name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="类型" name="project_type"><Select options={PROJECT_TYPES.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item label="档位" name="tier"><Select options={TIERS.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
            <Col span={6}><Form.Item label="状态" name="status"><Select options={PROJECT_STATUSES.map(s => ({ label: s, value: s }))} /></Form.Item></Col>
            <Col span={6}><Form.Item label="面板" name="panel_type"><Select options={PANEL_TYPES.map(p => ({ label: p, value: p }))} allowClear /></Form.Item></Col>
            <Col span={6}><Form.Item label="刷新率" name="refresh_rate"><Select options={REFRESH_RATES.map(r => ({ label: r, value: r }))} allowClear /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="屏幕尺寸" name="screen_size"><Select options={SCREEN_SIZES.map(s => ({ label: s, value: s }))} allowClear /></Form.Item></Col>
            <Col span={8}><Form.Item label="分辨率" name="resolution"><Select options={RESOLUTIONS.map(r => ({ label: r, value: r }))} allowClear /></Form.Item></Col>
            <Col span={8}><Form.Item label="平台费率(%)" name="platform_fee_rate"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Form.Item label="利润/管销研费率(%)" name="profit_rate"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      {/* Import preview modal */}
      <Modal title={`BOM 导入预览 (${importPreview.length} 条)`} open={importModal} onOk={doImport} onCancel={() => setImportModal(false)} width={800} okText="确认导入">
        <Alert message="系统将自动：1) 按模块名归类 2) 匹配已有器件/创建新器件到器件库 3) 标记所属项目" type="info" style={{ marginBottom: 12 }} />
        <Table dataSource={importPreview} rowKey={(_, i) => String(i)} size="small" scroll={{ y: 350 }}
          columns={[
            { title: '模块', dataIndex: 'module_name', width: 100 },
            { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag>{v}</Tag> },
            { title: '子类', dataIndex: 'sub_category', width: 100 },
            { title: '名称', dataIndex: 'name' }, { title: '型号', dataIndex: 'model' },
            { title: '单价', dataIndex: 'cost', width: 85, render: (v: number) => v?.toFixed(4) },
            { title: '数量', dataIndex: 'quantity', width: 60 },
          ]} pagination={false} />
      </Modal>

      {/* BOM add modal — 3 ways: from module library, from parts, manual */}
      <Modal title={bomEdit ? '编辑BOM项' : '添加器件到BOM'} open={bomModal} onOk={async () => {
        const v = await bomForm.validateFields();
        const mode = v._addMode || 'manual';
        if (bomEdit) {
          await updateBOMItem(bomEdit.id, v.quantity, v.module_name || '', v.remark || '');
        } else if (mode === 'module') {
          // Import all items from selected module
          if (!v._moduleId) { message.warning('请选择模块'); return; }
          const items = await getModuleItems(v._moduleId);
          for (const item of items) {
            let partId = item.part_id;
            if (!partId) {
              const existing = await getParts(item.part_name, '', '');
              const match = existing.find((p: any) => p.model === item.part_model);
              partId = match?.id || await savePart({ main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.cost, specs: '', projects: '', remark: '' });
            }
            await addBOMItem(selectedPid!, partId, item.quantity, item._modName || v._moduleName || '', item.remark || '');
          }
          message.success(`已导入模块 [${v._moduleName}]: ${items.length} 件`);
        } else if (mode === 'parts') {
          await addBOMItem(selectedPid!, v.part_id, v.quantity, v.module_name || '', v.remark || '');
        } else {
          // Manual: create part first, then add to BOM
          const partId = await savePart({ main_category: v._main_category || '硬件类', sub_category: v._sub_category || '', category: v._main_category || '硬件类', name: v._part_name, model: v._part_model || '', cost: v._cost || 0, specs: '', projects: '', remark: '' });
          await addBOMItem(selectedPid!, partId, v._quantity || 1, v._module_name || '', v._remark || '');
        }
        setBomModal(false); setBomEdit(null); loadBOM(selectedPid!);
      }} onCancel={() => { setBomModal(false); setBomEdit(null); }} width={680} destroyOnClose>
        <Form form={bomForm} layout="vertical" initialValues={{ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }}>
          {!bomEdit && (
            <Form.Item label="添加方式" name="_addMode">
              <Select options={[
                { label: '📦 从模块库导入（推荐）', value: 'module' },
                { label: '🔧 从器件库选择已有器件', value: 'parts' },
                { label: '✏️ 手动录入新器件', value: 'manual' },
              ]} />
            </Form.Item>
          )}

          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }: any) => {
              const mode = getFieldValue('_addMode') || 'module';
              if (bomEdit) {
                return (
                  <>
                    <Row gutter={16}>
                      <Col span={12}><Form.Item label="模块名" name="module_name"><Input placeholder="如: 主板模块" /></Form.Item></Col>
                      <Col span={12}><Form.Item label="数量" name="quantity"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
                    </Row>
                    <Form.Item label="备注" name="remark"><Input /></Form.Item>
                  </>
                );
              }
              if (mode === 'module') {
                return (
                  <>
                    <Form.Item label="选择模块" name="_moduleId" rules={[{ required: true, message: '请选择模块' }]}>
                      <Select
                        showSearch placeholder="搜索模块..."
                        filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
                        onChange={async (mid: number) => {
                          if (!mid) return;
                          const items = await getModuleItems(mid);
                          setPreviewModItems(items);
                          // Find module name and source project
                          const allMods = await Promise.all((await getProjects()).map(async (p: any) => {
                            const mods = await getModules(p.id);
                            return mods.map((m: any) => ({ ...m, project_code: p.code, project_name: p.name }));
                          }));
                          const flat = allMods.flat();
                          const mod = flat.find((m: any) => m.id === mid);
                          bomForm.setFieldsValue({ _moduleName: mod?.name || '', _modSource: mod ? `[${mod.project_code}] ${mod.project_name}` : '' });
                        }}
                        options={(() => {
                          // Load modules from all projects
                          return (modList || []).map((m: any) => ({
                            label: `${m.name} — [${m.project_code}] ${m.project_name}${m.description ? ' | ' + m.description : ''}`,
                            value: m.id,
                          }));
                        })()}
                        onDropdownVisibleChange={async (open) => {
                          if (open) {
                            const allMods = await Promise.all((await getProjects()).map(async (p: any) => {
                              const mods = await getModules(p.id);
                              return mods.map((m: any) => ({ ...m, project_code: p.code, project_name: p.name, project_type: p.project_type }));
                            }));
                            setModList(allMods.flat());
                          }
                        }}
                      />
                    </Form.Item>
                    <Form.Item name="_moduleName" hidden><Input /></Form.Item>
                    <Form.Item name="_modSource" hidden><Input /></Form.Item>
                    {previewModItems.length > 0 && (
                      <div style={{ background: '#F8FAFC', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontWeight: 600, marginBottom: 8 }}>
                          模块包含 <Tag color="blue">{previewModItems.length} 件</Tag> 器件，确认后将全部导入：
                        </div>
                        <Table dataSource={previewModItems} rowKey="id" size="small" pagination={false} scroll={{ y: 200 }}
                          columns={[
                            { title: '名称', dataIndex: 'part_name', ellipsis: true },
                            { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
                            { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={CATEGORY_COLORS[v]}>{v}</Tag> },
                            { title: '单价', dataIndex: 'cost', width: 80, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
                            { title: '数量', dataIndex: 'quantity', width: 50, align: 'center' as const },
                          ]} />
                      </div>
                    )}
                  </>
                );
              }
              if (mode === 'parts') {
                return (
                  <>
                    <Form.Item label="选择器件" name="part_id" rules={[{ required: true, message: '请选择器件' }]}>
                      <Select showSearch placeholder="搜索器件库..." filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
                        options={allParts.map((p: any) => ({ label: `[${p.main_category}/${p.sub_category}] ${p.name} - ${p.model} (¥${p.cost})`, value: p.id }))}
                        onClick={async () => { if (allParts.length === 0) setAllParts(await getParts()); }} />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={12}><Form.Item label="归类到模块" name="module_name"><Input placeholder="如: 主板模块" /></Form.Item></Col>
                      <Col span={12}><Form.Item label="数量" name="quantity"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
                    </Row>
                    <Form.Item label="备注" name="remark"><Input /></Form.Item>
                  </>
                );
              }
              // Manual
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label="大类" name="_main_category" rules={[{ required: true }]}>
                      <Select options={MAIN_CATEGORIES.map(c => ({ label: c, value: c }))}
                        onChange={(v) => bomForm.setFieldValue('_sub_category', (SUB_CATEGORIES[v] || [])[0] || '')} />
                    </Form.Item>
                    <Form.Item label="子类" name="_sub_category"><Select options={(SUB_CATEGORIES[bomForm.getFieldValue('_main_category')] || []).map(c => ({ label: c, value: c }))} showSearch /></Form.Item>
                    <Form.Item label="数量" name="_quantity"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label="器件名称" name="_part_name" rules={[{ required: true }]}><Input placeholder="器件名称" /></Form.Item>
                    <Form.Item label="型号" name="_part_model"><Input placeholder="型号/料号" /></Form.Item>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label="单价" name="_cost"><InputNumber min={0} precision={4} style={{ width: '100%' }} prefix="¥" /></Form.Item>
                    <Form.Item label="模块" name="_module_name"><Input placeholder="归入模块" /></Form.Item>
                    <Form.Item label="备注" name="_remark"><Input placeholder="备注" /></Form.Item>
                  </div>
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      {/* Copy/Review/Measure modals - same */}
      <Modal title="复制项目" open={copyModal} onOk={async () => {
        const v = await copyForm.validateFields();
        await copyProject(selectedPid!, v.code, v.name);
        setCopyModal(false); loadProjects(); message.success('已复制');
      }} onCancel={() => setCopyModal(false)}>
        <Form form={copyForm} layout="vertical">
          <Form.Item label="新代号" name="code" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="新名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal title="成本测算" open={reviewModal} onOk={async () => { const v = await form.validateFields(); await saveCostReview({ project_id: selectedPid, ...v }); setReviewModal(false); loadReviews(selectedPid!); }} onCancel={() => setReviewModal(false)}>
        <Form form={form} layout="vertical"><Form.Item label="阶段" name="stage" rules={[{ required: true }]}><Select options={['Charter','CDCP','PDCP','ADCP','量产后降本'].map(s=>({label:s,value:s}))} /></Form.Item><Form.Item label="成本" name="reviewed_cost" rules={[{ required: true }]}><InputNumber min={0} style={{ width:'100%' }} prefix="¥" /></Form.Item><Form.Item label="测算人" name="reviewer"><Input /></Form.Item><Form.Item label="备注" name="remark"><Input /></Form.Item></Form>
      </Modal>
      <Modal title="降本措施" open={measureModal} onOk={async () => { const v = await form.validateFields(); await saveMeasure({ project_id: selectedPid, ...v }); setMeasureModal(false); loadMeasures(selectedPid!); }} onCancel={() => setMeasureModal(false)}>
        <Form form={form} layout="vertical"><Form.Item label="大类" name="main_category" rules={[{ required: true }]}><Select options={MAIN_CATEGORIES.map(c=>({label:c,value:c}))} /></Form.Item><Form.Item label="措施" name="measure" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="状态" name="status"><Select options={MEASURE_STATUSES.map(s=>({label:s,value:s}))} /></Form.Item><Form.Item label="负责人" name="owner"><Input /></Form.Item><Form.Item label="截止" name="due_date"><Input /></Form.Item><Form.Item label="备注" name="remark"><Input /></Form.Item></Form>
      </Modal>
    </div>
  );
}
