import { useEffect, useState, useMemo } from 'react';
import { Table, Button, Select, Space, Modal, Form, Input, InputNumber, Tag, message, Popconfirm, Tooltip, AutoComplete, Checkbox } from 'antd';
import { PlusOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined, AppstoreOutlined, TagOutlined, InboxOutlined, BarChartOutlined, CheckSquareOutlined, SortAscendingOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../echartsSetup';
import { getProjects, getLibraryModules, getLibraryModuleItems, updateLibraryModuleItem, deleteLibraryModule, renameLibraryModule, saveModule, deleteBOMItem, addBOMItem, getParts, getMainCategories, getModuleCategories, recordProjectCostSnapshot } from '../db';
import { MAIN_CATEGORIES, SUB_CATEGORIES, getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';
import { chartTooltip, chartTextMuted, barGradient } from '../chartTheme';

export default function ModuleLibrary() {
  const [allMods, setAllMods] = useState<any[]>([]);
  const [mainCats, setMainCats] = useState(MAIN_CATEGORIES);
  useEffect(() => { (async () => { try { setMainCats(await getMainCategories()); } catch(e) {} })(); }, []);
  const [modGroups, setModGroups] = useState<any[]>([]);    // grouped by name: {name, projects: [{project, module, cost, count}]}
  const [moduleCategories, setModuleCategories] = useState<string[]>([]);
  // 分类顺序（用户可自定义，存 settings 表）
  const [catOrder, setCatOrder] = useState<string[]>([]);
  const [catOrderModal, setCatOrderModal] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  // 项目品类筛选（品类维度：显示器/手写笔/鼠标…）
  const [prodCategoryFilter, setProdCategoryFilter] = useState('');
  // 项目筛选（选某项目只显示该项目下的模块）
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  // 批量选择删除
  const [checkedModIds, setCheckedModIds] = useState<Set<number>>(new Set());
  const [activeModName, setActiveModName] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<any>(null);
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [expandedItems, setExpandedItems] = useState<any[]>([]);
  const [expandedModName, setExpandedModName] = useState<string | null>(null);
  // 对比视图：参与对比的项目筛选（默认全部）——useMemo 保持引用稳定，避免筛选时 Select 重挂载导致下拉频闪
  const [cmpProjFilter, setCmpProjFilter] = useState<number[]>([]);

  // 参与器件级对比的项目（勾选列：勾选 = 参与对比，默认不勾 = 不对比，点哪个比哪个）
  const cmpProjects = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.projects.filter((p: any) => cmpProjFilter.includes(p.project_id));
  }, [activeGroup, cmpProjFilter]);

  const [modModal, setModModal] = useState(false);
  const [editMod, setEditMod] = useState<any>(null);
  const [categoryModal, setCategoryModal] = useState(false);
  const [categoryTarget, setCategoryTarget] = useState<any>(null);
  const [categoryValue, setCategoryValue] = useState('');
  const [selProjectForNewMod, setSelProjectForNewMod] = useState<number | null>(null);
  const [itemModal, setItemModal] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [targetPid, setTargetPid] = useState<number | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [form] = Form.useForm();
  // 动态子类选项（从数据库实际数据生成，不硬编码）
  const [dynamicSubCats, setDynamicSubCats] = useState<Record<string, string[]>>({});

  useEffect(() => { loadAll(); }, []);

  // 页面激活时重新加载（项目管理等页面改了数据后切过来要同步）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.page !== 'modules') return;
      loadAll();
    };
    window.addEventListener('app-page-active', handler);
    return () => window.removeEventListener('app-page-active', handler);
  }, []);

  // 加载真实子类：按大类分组（来自器件库 parts + 模块库 module_items）
  const loadDynamicSubCats = async () => {
    try {
      const m = await import('../db');
      const db = await m.getDb();
      const map: Record<string, string[]> = {};
      const parts = await db.select<any[]>('SELECT DISTINCT main_category, sub_category FROM parts WHERE sub_category IS NOT NULL AND sub_category != \'\'');
      parts.forEach((p: any) => {
        if (!map[p.main_category]) map[p.main_category] = [];
        if (!map[p.main_category].includes(p.sub_category)) map[p.main_category].push(p.sub_category);
      });
      // 单一数据源：子类从 project_boms 快照列取（module_items 仅是兼容层，可能不完整）
      const items = await db.select<any[]>('SELECT DISTINCT main_category, sub_category FROM project_boms WHERE sub_category IS NOT NULL AND sub_category != \'\'');
      items.forEach((p: any) => {
        if (!map[p.main_category]) map[p.main_category] = [];
        if (!map[p.main_category].includes(p.sub_category)) map[p.main_category].push(p.sub_category);
      });
      // 常量表兜底（实际数据没有时仍可用）
      Object.keys(SUB_CATEGORIES).forEach(k => {
        if (!map[k]) map[k] = [];
        SUB_CATEGORIES[k].forEach((s: string) => { if (!map[k].includes(s)) map[k].push(s); });
      });
      setDynamicSubCats(map);
    } catch { /* 失败不阻塞 */ }
  };

  useEffect(() => { loadDynamicSubCats(); }, []);

  const loadAll = async () => {
    const projs = await getProjects(); setProjects(projs);
    try {
      // 分类筛选：只显示实际用到的模块分类（从数据库取，不硬编码默认值）
      const cats = await getModuleCategories();
      setModuleCategories(cats.filter(Boolean).length > 0 ? cats.filter(Boolean) : ['未分类']);
    } catch {}
    // 分类顺序（用户可自定义）——用局部变量，避免 setState 异步导致排序读到旧值
    let order: string[] = [];
    try {
      const { getModuleCategoryOrder } = await import('../db');
      order = await getModuleCategoryOrder();
      setCatOrder(order);
    } catch {}
    // 单一数据源：模块库直接读 project_boms（与项目管理页同一份数据，任何一边改动另一边自动反映）
    const all = await getLibraryModules();
    setAllMods(all);
    // Group by name
    const groups: Record<string, any> = {};
    for (const m of all) {
      const moduleCategory = m.module_category || '未分类';
      if (!groups[m.name]) groups[m.name] = { name: m.name, module_category: moduleCategory, projects: [] };
      if (groups[m.name].module_category === '未分类' && moduleCategory !== '未分类') groups[m.name].module_category = moduleCategory;
      groups[m.name].projects.push({ project_id: m.project_id, project_code: m.project_code, project_name: m.project_name, project_type: m.project_type, prod_category: m.prod_category, module_id: m.id, module_name: m.module_name || m.name, module_category: moduleCategory, cost: m.totalCost, count: m.itemCount, description: m.description, items: m.items || [] });
    }
    // 按分类顺序排序（用户自定义顺序优先，未设置的分类排后面按字母序）
    const groupsArr = Object.values(groups);
    const orderIdx: Record<string, number> = {};
    order.forEach((c, i) => { orderIdx[c] = i; });
    groupsArr.sort((a: any, b: any) => {
      const ai = orderIdx[a.module_category] ?? 999;
      const bi = orderIdx[b.module_category] ?? 999;
      if (ai !== bi) return ai - bi;
      if (a.module_category !== b.module_category) return a.module_category.localeCompare(b.module_category);
      return a.name.localeCompare(b.name);
    });
    setModGroups(groupsArr);
  };

  const selectModGroup = async (group: any) => {
    setActiveModName(group.name); setActiveGroup(group);
    setExpandedPid(null); setExpandedItems([]);
  };

  const expandProject = async (pid: number, modName: string) => {
    setExpandedPid(pid);
    setExpandedModName(modName);
    setExpandedItems(await getLibraryModuleItems(pid, modName));
  };

  const handleSaveMod = async () => {
    const v = await form.validateFields();
    const pid = editMod?.project_id ?? selProjectForNewMod;
    if (!pid) { message.warning('请选择所属项目'); return; }
    const oldName = editMod?.module_name || editMod?.name;
    // 单一数据源：模块名直接写 project_boms（改名同步所有 BOM 行）+ 分类/描述存 modules 表
    if (editMod && oldName && v.name && v.name !== oldName) {
      await renameLibraryModule(pid, oldName, v.name);
    }
    await saveModule({ project_id: pid, name: v.name, module_category: v.module_category || '未分类', description: v.description || '' });
    await recordProjectCostSnapshot(pid, editMod?.id ? 'module_changed' : 'module_added', `${editMod?.id ? '编辑' : '新建'}模块：${v.name}`);
    setModModal(false); setEditMod(null); loadAll(); message.success('已保存');
  };

  const handleSaveItem = async () => {
    const v = await form.validateFields();
    // 单一数据源：直接更新 project_boms 行（项目页 BOM 自动同步）
    if (editItem?.id) {
      await updateLibraryModuleItem(editItem.id, v);
    } else if (expandedPid && expandedModName) {
      // 添加器件：先建 parts，再插入 BOM 行
      let partId: number | undefined = v.part_id;
      if (!partId) {
        const allParts = await getParts(v.part_name || '', '', '');
        const match = allParts.find((p: any) => p.name === v.part_name && (p.model || '') === (v.part_model || ''));
        partId = match?.id || await (await import('../db')).savePart({ main_category: v.main_category || '硬件类', sub_category: v.sub_category || '', category: v.main_category || '硬件类', name: v.part_name, model: v.part_model || '', cost: v.cost ?? 0, specs: '', projects: '', remark: v.remark || '' }, false);
      }
      await addBOMItem(expandedPid, partId!, v.quantity ?? 1, expandedModName, v.remark || '', 0, false);
    }
    if (expandedPid) await recordProjectCostSnapshot(expandedPid, editItem?.id ? 'module_item_changed' : 'module_item_added', `${editItem?.id ? '编辑' : '新增'}模块器件：${v.part_name || ''}`);
    setItemModal(false); setEditItem(null);
    if (expandedPid && expandedModName) setExpandedItems(await getLibraryModuleItems(expandedPid, expandedModName));
    loadAll(); message.success('已保存');
  };

  const handleSaveCategory = async () => {
    if (!categoryTarget) return;
    const { updateModuleCategoryByName } = await import('../db');
    await updateModuleCategoryByName(categoryTarget.name, categoryValue);
    message.success('分类已更新');
    setCategoryModal(false);
    setCategoryTarget(null);
    loadAll();
  };

  const copyModuleToProject = async () => {
    if (!expandedPid || !expandedModName || !targetPid) { message.warning('请先选择目标项目'); return; }
    const srcMod = allMods.find(m => m.project_id === expandedPid && (m.module_name || m.name) === expandedModName); if (!srcMod) return;
    // 复制模块：把该模块的 BOM 行复制到目标项目（同一数据源 project_boms，两边自动一致）
    const items = await getLibraryModuleItems(expandedPid, expandedModName);
    for (const item of items) {
      let partId = item.part_id;
      if (!partId) {
        const allParts = await getParts(item.part_name || '', '', '');
        const match = allParts.find((p: any) => p.name === item.part_name && (p.model || '') === (item.part_model || ''));
        partId = match?.id || await (await import('../db')).savePart({ main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.part_cost, specs: '', projects: '', remark: '' }, false);
      }
      await addBOMItem(targetPid, partId!, item.quantity, srcMod.name, item.remark || '', 0, false);
    }
    await recordProjectCostSnapshot(targetPid, 'module_copied', `复制模块「${srcMod.name}」到项目`);
    message.success(`已复制到目标项目`); setTargetPid(null); loadAll();
  };

  const expTotal = expandedItems.reduce((s: number, i: any) => s + ((i.part_cost ?? i.cost) || 0) * (i.quantity || 1), 0);
  // 品类筛选选项：只显示实际模块用到的品类（动态统计，不用品类表全量）
  const usedProdCategories = useMemo(() => {
    const set = new Set<string>();
    modGroups.forEach((g: any) => g.projects.forEach((p: any) => { if (p.prod_category && p.prod_category !== '未分类') set.add(p.prod_category); }));
    return Array.from(set);
  }, [modGroups]);
  // 筛选：
  // - 未选项目：按模块名分组（组内列出各项目实例，便于跨项目对比）
  // - 选了项目：按"项目+模块名"精确过滤，只显示该项目专属的模块实例，同名模块也分开
  const filteredGroups = modGroups
    .filter(group => !categoryFilter || (group.module_category || '未分类') === categoryFilter)
    .filter(group => !prodCategoryFilter || group.projects.some((p: any) => p.prod_category === prodCategoryFilter))
    // 项目筛选：只保留属于该项目的模块实例；同名模块在其他项目的实例不混入
    .filter(group => !projectFilter || group.projects.some((p: any) => p.project_id === projectFilter))
    .map(group => {
      if (!projectFilter) return group;
      // 选项目后：只保留该项目的实例，分组名带上项目标识避免同名混淆
      const projInstances = group.projects.filter((p: any) => p.project_id === projectFilter);
      if (projInstances.length === 0) return null;
      const proj = projInstances[0];
      return {
        ...group,
        name: `${group.name}`, // 显示名保持原名
        _projCode: proj.project_code,
        projects: projInstances,
      };
    })
    .filter(Boolean);
  const bySubCat: Record<string, number> = {};
  expandedItems.forEach(i => { const k = i.sub_category || i.main_category || '其他'; bySubCat[k] = (bySubCat[k] || 0) + ((i.part_cost ?? i.cost) || 0) * (i.quantity || 1); });
  const barData = Object.entries(bySubCat).map(([k, v]) => ({ name: k, value: Math.round(v * 100) / 100 })).sort((a, b) => b.value - a.value);

  // 子类成本分布图（单模块展开）：单色渐变，简洁高级
  const barTotal = barData.reduce((s, d) => s + d.value, 0) || 1;
  const barOption = {
    tooltip: {
      ...chartTooltip('axis'),
      formatter: (ps: any) => {
        const p = Array.isArray(ps) ? ps[0] : ps;
        return `${p.name}<br/><b style="color:#4F46E5">¥${Number(p.value).toFixed(4)}</b> · ${(Number(p.value) / barTotal * 100).toFixed(1)}%`;
      },
    },
    grid: { left: 110, right: 70, top: 5, bottom: 5 },
    xAxis: { type: 'value', name: '¥', axisLabel: { color: chartTextMuted(), fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
    yAxis: { type: 'category', data: barData.map(d => d.name), axisLabel: { fontSize: 11, color: chartTextMuted() }, inverse: true, axisLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'bar', barWidth: '50%',
      data: barData.map(d => ({
        value: d.value,
        itemStyle: {
          // 单色渐变：按占比从深到浅（最大的最深，简洁不花哨）
          color: barGradient(`rgba(79, 70, 229, ${0.45 + 0.5 * (d.value / (barData[0].value || 1))})`),
          borderRadius: [0, 6, 6, 0],
        },
      })),
      label: {
        show: true, position: 'right',
        formatter: (p: any) => `¥${Number(p.value).toFixed(2)} · ${(Number(p.value) / barTotal * 100).toFixed(1)}%`,
        fontSize: 10.5, color: chartTextMuted(),
      },
    }],
  };

  const itemCols = [
    { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={getCategoryColor(v)} style={{ margin: 0 }}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 90, ellipsis: true },
    { title: '名称', dataIndex: 'part_name', width: 170, ellipsis: true },
    { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
    { title: '单价', dataIndex: 'part_cost', width: 90, align: 'right' as const, render: (v: number, r: any) => (v ?? r.cost ?? 0)?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 55, align: 'center' as const },
    { title: '小计', key: 'sub', width: 95, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost ?? r.cost ?? 0) * (r.quantity ?? 0)).toFixed(4)}</b> },
    { title: '备注', dataIndex: 'remark', width: 100, ellipsis: true },
    {
      title: '', width: 55,
      render: (_: any, r: any) => (
        <Space size={0}>
          <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); setEditItem(r); form.setFieldsValue(r); setItemModal(true); }} /></Tooltip>
          <Popconfirm title="删除？" onConfirm={async () => { await deleteBOMItem(r.id); if (expandedPid) await recordProjectCostSnapshot(expandedPid, 'module_item_deleted', `删除模块器件：${r.part_name || ''}`); if (expandedPid && expandedModName) setExpandedItems(await getLibraryModuleItems(expandedPid, expandedModName)); loadAll(); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="page-title"><InboxOutlined /> 模块库</div>

      {/* Module cards - all modules grouped by name */}
      <div className="content-card" style={{ marginBottom: 14, padding: '14px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Space wrap>
            <AppstoreOutlined style={{ color: '#CF0A2C', fontSize: 16 }} />
            <b style={{ fontSize: 14 }}>全部模块（跨项目）</b>
            <Select
              size="small"
              allowClear
              placeholder="分类"
              value={categoryFilter || undefined}
              onChange={v => setCategoryFilter(v || '')}
              style={{ width: 140 }}
              options={moduleCategories.map(c => ({ label: c, value: c }))}
            />
            {/* 项目品类筛选（只显示实际模块用到的品类） */}
            <Select
              size="small"
              allowClear
              placeholder="品类"
              value={prodCategoryFilter || undefined}
              onChange={v => setProdCategoryFilter(v || '')}
              style={{ width: 130 }}
              options={usedProdCategories.map(c => ({ label: c, value: c }))}
            />
            {/* 项目筛选：选某项目只显示该项目下的模块 */}
            <Select
              size="small"
              allowClear
              showSearch
              placeholder="项目"
              value={projectFilter || undefined}
              onChange={v => { setProjectFilter(v || null); setCheckedModIds(new Set()); }}
              style={{ width: 180 }}
              optionFilterProp="label"
              options={projects.map((p: any) => ({ label: `${p.code} · ${p.name}`, value: p.id }))}
            />
            {/* 全选 / 取消全选（作用于当前筛选结果） */}
            <Button
              size="small"
              icon={<CheckSquareOutlined />}
              onClick={() => {
                const allIds = filteredGroups.flatMap((g: any) => g.projects.map((p: any) => p.module_id));
                if (allIds.length === 0) { message.info('当前筛选下没有模块'); return; }
                // 全部已选则取消，否则全选
                const allSelected = allIds.length > 0 && allIds.every(id => checkedModIds.has(id));
                if (allSelected) setCheckedModIds(new Set());
                else setCheckedModIds(new Set(allIds));
              }}
            >
              {(() => {
                const allIds = filteredGroups.flatMap((g: any) => g.projects.map((p: any) => p.module_id));
                const allSelected = allIds.length > 0 && allIds.every(id => checkedModIds.has(id));
                return allSelected ? '取消全选' : `全选 (${allIds.length})`;
              })()}
            </Button>
            {/* 批量删除选中模块 */}
            {checkedModIds.size > 0 && (
              <Popconfirm
                title={`删除选中的 ${checkedModIds.size} 个模块？`}
                onConfirm={async () => {
                  for (const inst of filteredGroups.flatMap((g: any) => g.projects.filter((p: any) => checkedModIds.has(p.module_id)))) {
                    await deleteLibraryModule(inst.project_id, inst.module_name || inst.name);
                  }
                  message.success(`已删除 ${checkedModIds.size} 个模块`);
                  setCheckedModIds(new Set());
                  loadAll();
                }}
              >
                <Button size="small" danger icon={<DeleteOutlined />}>删除选中 ({checkedModIds.size})</Button>
              </Popconfirm>
            )}
          </Space>
          <Space>
            {/* 分类排序：自定义分类显示顺序 */}
            <Button size="small" icon={<SortAscendingOutlined />} onClick={() => setCatOrderModal(true)}>分类排序</Button>
          </Space>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => {
            setEditMod(null); setSelProjectForNewMod(null); form.resetFields(); form.setFieldsValue({ module_category: categoryFilter || '未分类' }); setModModal(true);
          }}>新建模块</Button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
          {filteredGroups.map(group => {
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
                  position: 'relative',
                }}
                onMouseEnter={e => { if (!active) { e.currentTarget.style.borderColor = '#CF0A2C'; e.currentTarget.style.transform = 'translateY(-2px)'; } }}
                onMouseLeave={e => { if (!active) { e.currentTarget.style.borderColor = '#E8ECF1'; e.currentTarget.style.transform = 'none'; } }}
              >
                <Tooltip title="设置分类">
                  <Button
                    type="text"
                    size="small"
                    icon={<TagOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCategoryTarget(group);
                      setCategoryValue(group.module_category || '未分类');
                      setCategoryModal(true);
                    }}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      color: '#8B5CF6',
                      opacity: 0.7,
                    }}
                  />
                </Tooltip>
                {/* 勾选（用于批量删除）——点击勾选该分组下所有模块 */}
                <Checkbox
                  checked={group.projects.every((p: any) => checkedModIds.has(p.module_id)) && group.projects.length > 0}
                  indeterminate={group.projects.some((p: any) => checkedModIds.has(p.module_id)) && !group.projects.every((p: any) => checkedModIds.has(p.module_id))}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => {
                    const allChecked = group.projects.every((p: any) => checkedModIds.has(p.module_id));
                    const next = new Set(checkedModIds);
                    group.projects.forEach((p: any) => {
                      if (allChecked) next.delete(p.module_id);
                      else next.add(p.module_id);
                    });
                    setCheckedModIds(next);
                  }}
                  style={{ position: 'absolute', top: 8, left: 8 }}
                />
                <div style={{ fontWeight: 600, fontSize: 14, color: active ? '#CF0A2C' : '#1E293B', marginBottom: 6, paddingLeft: 18 }}>
                  {group.name}
                  {group._projCode && <Tag color="blue" style={{ marginLeft: 6, fontSize: 10 }}>{group._projCode}</Tag>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Tag color={getCategoryColor(group.module_category || '未分类')} style={{ margin: 0, fontSize: 11 }}>{group.module_category || '未分类'}</Tag>
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
          <h3 style={{ margin: '0 0 14px 0', fontSize: 16, color: '#CF0A2C' }}>{activeGroup.name} — 各项目成本对比 <Tag color={getCategoryColor(activeGroup.module_category || '未分类')}>{activeGroup.module_category || '未分类'}</Tag></h3>
          {/* 项目成本对比表：始终显示全量项目，勾选列控制参与器件级对比的项目 */}
          <DataTable tableId="mod_group_compare"
            dataSource={activeGroup.projects}
            rowKey="module_id"
            size="small"
            pagination={false}
            columns={[
              {
                title: '对比', key: 'cmp', width: 56, align: 'center' as const,
                render: (_: any, r: any) => (
                  <Checkbox
                    checked={cmpProjFilter.includes(r.project_id)}
                    onChange={e => {
                      const checked = e.target.checked;
                      setCmpProjFilter(prev =>
                        checked
                          ? [...prev, r.project_id]
                          : prev.filter(id => id !== r.project_id)
                      );
                    }}
                  />
                ),
              },
              { title: '项目代号', dataIndex: 'project_code', width: 100, render: (v: string) => <b>{v}</b> },
              { title: '项目名称', dataIndex: 'project_name', ellipsis: true },
              { title: '分类', dataIndex: 'module_category', width: 95, render: (v: string) => <Tag color={getCategoryColor(v || '未分类')}>{v || '未分类'}</Tag> },
              { title: '类型', dataIndex: 'project_type', width: 75, render: (v: string) => <Tag color={v === '已完成' ? 'green' : 'blue'}>{v}</Tag> },
              { title: '模块成本', dataIndex: 'cost', width: 130, align: 'right' as const, render: (v: number) => (
                <b style={{ color: '#CF0A2C', fontSize: 15 }}>¥{v.toFixed(4)}</b>
              ) },
              { title: '器件数', dataIndex: 'count', width: 70, align: 'center' as const },
              {
                title: '操作', width: 120,
                render: (_: any, r: any) => (
                  <Space size={0}>
                    <Button type="link" size="small" icon={<EyeOutlined />}
                      onClick={() => expandProject(r.project_id, r.module_name || r.name)}
                      style={{ color: expandedPid === r.project_id ? '#CF0A2C' : undefined }}>
                      查看
                    </Button>
                    <Button type="link" size="small" icon={<EditOutlined />}
                      onClick={() => {
                        const mod = allMods.find(m => m.id === r.module_id);
                        setEditMod({ ...mod, module_name: r.module_name || r.name, project_id: r.project_id });
                        setSelProjectForNewMod(r.project_id);
                        form.setFieldsValue({ name: mod?.name || activeGroup.name, module_category: mod?.module_category || '未分类', description: mod?.description || '' });
                        setModModal(true);
                      }}
                    />
                  </Space>
                ),
              },
            ]}
          />
          {/* 器件级对比：同一模块在不同项目的器件明细并排对比（单价/数量/小计，绿色=该项目该器件最低价） */}
          {/* 参与对比的项目 = 上方表格勾选列勾中的（默认不勾不对比，点哪个比哪个） */}
          {cmpProjects.length >= 1 && (() => {
            // 器件并集：名称+型号匹配
            const itemKeys = new Set<string>();
            cmpProjects.forEach((p: any) => (p.items || []).forEach((i: any) => itemKeys.add(`${i.part_name || ''}|${i.part_model || ''}`)));
            const rows = Array.from(itemKeys).map(k => {
              const [name, model] = k.split('|');
              const row: any = { name, model, key: k, cells: {} as Record<number, { cost: number; qty: number; sub: number } | null> };
              cmpProjects.forEach((p: any) => {
                const item = (p.items || []).find((i: any) => `${i.part_name || ''}|${i.part_model || ''}` === k);
                row.cells[p.project_id] = item
                  ? { cost: +((item.part_cost ?? item.cost) || 0), qty: +(item.quantity ?? 0), sub: +((((item.part_cost ?? item.cost) || 0) * (item.quantity ?? 0)).toFixed(4)) }
                  : null;
              });
              return row;
            });
            const itemCmpCols: any[] = [
              { title: '器件', dataIndex: 'name', width: 140, ellipsis: true, render: (v: string) => <b style={{ fontSize: 12 }}>{v}</b> },
              { title: '型号', dataIndex: 'model', width: 110, ellipsis: true },
            ];
            cmpProjects.forEach((p: any) => {
              itemCmpCols.push({
                title: p.project_code, dataIndex: `${p.project_id}_cell`, width: 130, align: 'center' as const,
                render: (_: any, r: any) => {
                  const c = r.cells[p.project_id];
                  if (!c) return <span style={{ color: '#CBD5E1' }}>—</span>;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.35 }}>
                      <span style={{ fontSize: 11, color: '#64748B', fontVariantNumeric: 'tabular-nums' }}>¥{c.cost.toFixed(4)} × {c.qty}</span>
                      <span style={{ color: '#1E293B', fontWeight: 600, fontSize: 13 }}>
                        ¥{c.sub.toFixed(2)}
                      </span>
                    </div>
                  );
                },
              });
            });
            // 子类分布对比图：行=子类，每项目一组条形（统一色调，深浅区分项目）
            const subByProj: Record<string, Record<number, number>> = {};
            const projSubTotal: Record<number, number> = {};
            cmpProjects.forEach((p: any) => {
              projSubTotal[p.project_id] = 0;
              (p.items || []).forEach((i: any) => {
                const k = i.sub_category || i.main_category || '其他';
                if (!subByProj[k]) subByProj[k] = {};
                const sub = ((i.part_cost ?? i.cost) || 0) * (i.quantity || 1);
                subByProj[k][p.project_id] = (subByProj[k][p.project_id] || 0) + sub;
                projSubTotal[p.project_id] += sub;
              });
            });
            const subNames = Object.keys(subByProj).sort((a, b) => {
              const ta = Object.values(subByProj[a]).reduce((s, v) => s + v, 0);
              const tb = Object.values(subByProj[b]).reduce((s, v) => s + v, 0);
              return tb - ta;
            });
            // 颜色以图例为准：系列级设置颜色（图例自动匹配），图例 data 显式同色双保险
            const cmpSeriesColors = ['#5470C6', '#91CC75', '#FAC858', '#EE6666', '#73C0DE', '#3BA272', '#FC8452', '#9A60B4', '#EA7CCC'];
            const cmpBarOption = {
              tooltip: {
                ...chartTooltip('axis'),
                valueFormatter: (v: number) => `¥${Number(v).toFixed(4)}`,
              },
              legend: {
                data: cmpProjects.map((p: any, idx: number) => ({ name: p.project_code, itemStyle: { color: cmpSeriesColors[idx % cmpSeriesColors.length] } })),
                top: 0, right: 0, textStyle: { color: chartTextMuted(), fontSize: 11 },
              },
              grid: { left: 90, right: 50, top: 30, bottom: 5, containLabel: true },
              xAxis: { type: 'value', name: '¥', axisLabel: { color: chartTextMuted(), fontSize: 10.5 }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
              yAxis: { type: 'category', data: subNames, axisLabel: { fontSize: 11, color: chartTextMuted() }, inverse: true, axisLine: { show: false }, axisTick: { show: false } },
              series: cmpProjects.map((p: any, idx: number) => ({
                name: p.project_code, type: 'bar' as const, barGap: '8%',
                itemStyle: { color: barGradient(cmpSeriesColors[idx % cmpSeriesColors.length]), borderRadius: [0, 4, 4, 0] },
                data: subNames.map(k => ({
                  value: +(subByProj[k][p.project_id] || 0).toFixed(4),
                })),
              })),
            };
            return (
              <div style={{ marginTop: 16, border: '1px solid #E2E8F0', borderRadius: 10, padding: '12px 14px', background: '#FAFBFC' }}>
                <div style={{ marginBottom: 8 }}><b style={{ fontSize: 13, color: '#1E3A6E' }}>📋 器件级对比（{cmpProjects.map((p: any) => p.project_code).join(' vs ')}）</b>
                  <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>上方表格勾选列选择参与对比的项目（勾选 = 参与）</span>
                </div>
                {/* 子类成本分布对比图 */}
                {subNames.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ textAlign: 'center', marginBottom: 4 }}><b style={{ fontSize: 12, color: '#64748B' }}>子类成本分布对比</b></div>
                    <ReactECharts echarts={echarts} option={cmpBarOption} style={{ height: Math.max(180, subNames.length * 40 + 40) }} />
                  </div>
                )}
                <DataTable tableId="mod_item_cmp" dataSource={rows} rowKey="key" size="small" pagination={false} scroll={{ x: 1200 }}
                  columns={itemCmpCols}
                />
              </div>
            );
          })()}
          {expandedPid && expandedItems.length > 0 && (
            <div style={{ marginTop: 16, border: '1px solid #E8ECF1', borderRadius: 8, padding: 14, background: '#FAFBFC' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <Space>
                  <b>{activeGroup.name} 明细</b>
                  <Tag color="blue">{expandedItems.length} 件</Tag>
                  <Tag color="red">¥{expTotal.toFixed(4)}</Tag>
                  <span style={{ fontSize: 11, color: '#999' }}>
                    {projects.find(p => p.id === expandedPid)?.code} {projects.find(p => p.id === expandedPid)?.name}
                  </span>
                </Space>
                <Space>
                  <Select placeholder="复制到项目..." value={targetPid || undefined} onChange={v => setTargetPid(v)} style={{ width: 200 }} size="small"
                    options={projects.filter(p => p.id !== expandedPid).map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
                  <Button size="small" icon={<CopyOutlined />} onClick={copyModuleToProject}>复制</Button>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditItem(null); form.resetFields(); form.setFieldsValue({ main_category: '硬件类', sub_category: '', quantity: 1, cost: 0 }); setItemModal(true); }}>添加器件</Button>
                  <Popconfirm title="删除模块？" onConfirm={async () => { if (expandedPid && expandedModName) { await deleteLibraryModule(expandedPid, expandedModName); await recordProjectCostSnapshot(expandedPid, 'module_deleted', `删除模块：${activeGroup.name}`); } setExpandedPid(null); setExpandedModName(null); setExpandedItems([]); loadAll(); }}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </Space>
              </div>
              <DataTable tableId="mod_items_detail" dataSource={expandedItems} columns={itemCols} rowKey="id" size="small" pagination={false} scroll={{ x: 850 }}
                summary={() => (<Table.Summary.Row><Table.Summary.Cell index={0} colSpan={6}><b>合计</b></Table.Summary.Cell><Table.Summary.Cell index={6} align="right"><b style={{ color: '#CF0A2C', fontSize: 14 }}>¥{expTotal.toFixed(4)}</b></Table.Summary.Cell><Table.Summary.Cell index={7} colSpan={2} /></Table.Summary.Row>)}
              />
              {barData.length > 0 && (
                <div style={{ maxWidth: 600, margin: '16px auto 0' }}>
                  <div style={{ textAlign: 'center', marginBottom: 6 }}><b style={{ fontSize: 13 }}><BarChartOutlined /> 子类成本分布</b></div>
                  <ReactECharts echarts={echarts} option={barOption} style={{ height: Math.max(160, barData.length * 34 + 30) }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 分类排序弹窗：调整模块分类的显示顺序 */}
      <Modal title="模块分类排序" open={catOrderModal} onCancel={() => setCatOrderModal(false)} footer={null} width={420}>
        <div style={{ marginBottom: 12, fontSize: 13, color: '#6E6A64' }}>
          上下移动调整分类顺序，模块库按此顺序展示（未列出的分类排在最后）。
        </div>
        {(catOrder.length === 0 ? moduleCategories : catOrder).map((cat, idx) => (
          <div key={cat} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
            borderRadius: 8, marginBottom: 6, background: '#FAFAFA', border: '1px solid #EEE',
          }}>
            <span style={{ color: '#94A3B8', fontSize: 12, width: 24 }}>{idx + 1}</span>
            <Tag color={getCategoryColor(cat)} style={{ margin: 0 }}>{cat}</Tag>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={idx === 0}
                onClick={() => {
                  const arr = [...catOrder];
                  if (arr.length === 0) arr.push(...moduleCategories);
                  [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
                  setCatOrder(arr);
                }} />
              <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={idx === catOrder.length - 1 && catOrder.length > 0}
                onClick={() => {
                  const arr = [...catOrder];
                  if (arr.length === 0) arr.push(...moduleCategories);
                  [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
                  setCatOrder(arr);
                }} />
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button size="small" onClick={async () => {
            const { saveModuleCategoryOrder } = await import('../db');
            await saveModuleCategoryOrder([]);
            setCatOrder([]);
            loadAll();
            message.success('已恢复默认顺序');
          }}>恢复默认</Button>
          <Button type="primary" size="small" onClick={async () => {
            const { saveModuleCategoryOrder } = await import('../db');
            await saveModuleCategoryOrder(catOrder);
            setCatOrderModal(false);
            loadAll();
            message.success('分类顺序已保存');
          }}>保存顺序</Button>
        </div>
      </Modal>

      {/* Category modal */}
      <Modal
        title={`设置「${categoryTarget?.name}」的分类`}
        open={categoryModal}
        onOk={handleSaveCategory}
        onCancel={() => {
          setCategoryModal(false);
          setCategoryTarget(null);
        }}
        width={400}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8, color: '#64748B', fontSize: 13 }}>
            此操作将为所有同名模块设置分类
          </div>
          <AutoComplete
            value={categoryValue}
            onChange={setCategoryValue}
            placeholder="选择或输入分类"
            options={moduleCategories.map(c => ({ label: c, value: c }))}
            style={{ width: '100%' }}
          />
        </div>
      </Modal>

      {/* Module create/edit modal */}
      <Modal title={editMod?.id ? '编辑模块' : '新建模块'} open={modModal} onOk={handleSaveMod} onCancel={() => { setModModal(false); setEditMod(null); }} width={460}>
        <Form form={form} layout="vertical">
          <Form.Item label="所属项目" required={!editMod?.id}>
            <Select placeholder="选择项目" value={selProjectForNewMod} onChange={v => setSelProjectForNewMod(v)}
              disabled={!!editMod?.id}
              options={projects.map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
          </Form.Item>
          <Form.Item label="模块名称" name="name" rules={[{ required: true }]}><Input placeholder="如: LCM模块" /></Form.Item>
          <Form.Item label="模块分类" name="module_category" initialValue="未分类">
            <AutoComplete
              placeholder="选择或输入分类"
              options={moduleCategories.map(c => ({ label: c, value: c }))}
            />
          </Form.Item>
          <Form.Item label="描述" name="description"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      {/* Item edit modal */}
      <Modal title={editItem?.id ? '编辑器件' : '添加器件'} open={itemModal} onOk={handleSaveItem} onCancel={() => { setItemModal(false); setEditItem(null); }} width={600} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ main_category: '硬件类', sub_category: '', quantity: 1, cost: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
            <Form.Item label="大类" name="main_category" rules={[{ required: true }]}>
              <Select options={mainCats.map(c => ({ label: c, value: c }))} onChange={(v) => { const subs = dynamicSubCats[v] || SUB_CATEGORIES[v] || []; form.setFieldValue('sub_category', subs[0] || ''); }} />
            </Form.Item>
            <Form.Item label="子类" name="sub_category"><Select options={(dynamicSubCats[form.getFieldValue('main_category')] || SUB_CATEGORIES[form.getFieldValue('main_category')] || []).map(c => ({ label: c, value: c }))} showSearch /></Form.Item>
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
