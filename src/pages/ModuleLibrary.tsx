import { useEffect, useState, useMemo } from 'react';
import { EmojiIcon } from '../iconMap';
import { Table, Button, Select, Space, Modal, AutoComplete, Tag, message, Tooltip, Checkbox } from 'antd';
import { EyeOutlined, AppstoreOutlined, TagOutlined, InboxOutlined, BarChartOutlined, SortAscendingOutlined, ArrowUpOutlined, ArrowDownOutlined, FileAddOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { createChangePackage, getProjectBOMVersionLines, getProjectBOMVersions, getProjects, getLibraryModules, getLibraryModuleItems, getModuleCategories } from '../db';
import { getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';
import { chartTooltip, chartTextMuted, barGradient } from '../chartTheme';

export default function ModuleLibrary() {
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
  const [activeModName, setActiveModName] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<any>(null);
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [expandedItems, setExpandedItems] = useState<any[]>([]);
  const [expandedModName, setExpandedModName] = useState<string | null>(null);
  // 对比视图：参与对比的项目筛选（默认全部）——useMemo 保持引用稳定，避免筛选时 Select 重挂载导致下拉频闪
  const [cmpProjFilter, setCmpProjFilter] = useState<number[]>([]);
  const [selectedModuleKeys, setSelectedModuleKeys] = useState<string[]>([]);

  // 参与器件级对比的项目（勾选列：勾选 = 参与对比，默认不勾 = 不对比，点哪个比哪个）
  const cmpProjects = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.projects.filter((p: any) => cmpProjFilter.includes(p.project_id));
  }, [activeGroup, cmpProjFilter]);

  const [categoryModal, setCategoryModal] = useState(false);
  const [categoryTarget, setCategoryTarget] = useState<any>(null);
  const [categoryValue, setCategoryValue] = useState('');
  const [targetPid, setTargetPid] = useState<number | null>(null);
  const [projects, setProjects] = useState<any[]>([]);

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

  async function loadAll() {
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
  }

  const selectModGroup = async (group: any) => {
    setActiveModName(group.name); setActiveGroup(group);
    setExpandedPid(null); setExpandedItems([]);
  };

  const expandProject = async (pid: number, modName: string) => {
    setExpandedPid(pid);
    setExpandedModName(modName);
    setExpandedItems(await getLibraryModuleItems(pid, modName));
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

  const openProjectBOM = (pid: number) => window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid, tab: 'bom' } }));

  const createReferenceChangePackage = async () => {
    if (!expandedPid || !expandedModName || !targetPid) { message.warning('请先选择目标项目'); return; }
    const sourceVersion = (await getProjectBOMVersions(expandedPid)).find(row => row.status === 'frozen');
    if (!sourceVersion) { message.warning('源项目还没有冻结 BOM，先在项目页冻结后再创建参考变更包'); return; }
    const lines = await getProjectBOMVersionLines(sourceVersion.id);
    const sourceItems = await getLibraryModuleItems(expandedPid, expandedModName);
    const packageId = await createChangePackage({
      projectId: targetPid,
      title: `参考模块：${expandedModName}`,
      triggerType: 'architecture',
      sourceVersionId: sourceVersion.id,
      rationale: `来源于模块基准 ${sourceVersion.version_name || `BOM v${sourceVersion.version_no}`}；仅创建变更包草稿，不直接写入目标项目 BOM。`,
      lines: sourceItems.map(item => {
        const sourceLine = lines.find(line => line.source_bom_id === item.id || (line.part_name === item.part_name && line.part_model === item.part_model && line.module_name === expandedModName));
        return { action: 'add', afterPartId: item.part_id, moduleName: expandedModName, quantityAfter: item.quantity, costAfter: item.part_cost ?? item.cost ?? 0, dependencyRole: 'required', evidence: { sourceVersionId: sourceVersion.id, sourceLineId: sourceLine?.id || 0 } };
      }),
    });
    message.success(`已创建变更包草稿 #${packageId}`);
    setTargetPid(null);
    window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid: targetPid, tab: 'analysis' } }));
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
    // ⚠️ 品类筛选（2026-08-18 修复）：选了品类后组内只保留该品类的项目实例——
    // 之前用 .some() 只要组里有一个该品类项目就保留整组，导致其他品类的模块实例混在一起对比
    .filter(group => !prodCategoryFilter || group.projects.some((p: any) => p.prod_category === prodCategoryFilter))
    // 项目筛选：只保留属于该项目的模块实例；同名模块在其他项目的实例不混入
    .filter(group => !projectFilter || group.projects.some((p: any) => p.project_id === projectFilter))
    .map(group => {
      if (!prodCategoryFilter && !projectFilter) return group;
      // 选品类/项目后：组内只保留符合的实例（跨品类模块不再混在一起对比）
      const keep = group.projects.filter((p: any) =>
        (!prodCategoryFilter || p.prod_category === prodCategoryFilter) &&
        (!projectFilter || p.project_id === projectFilter));
      if (keep.length === 0) return null;
      const proj = keep[0];
      return {
        ...group,
        _projCode: projectFilter ? proj.project_code : group._projCode,
        projects: keep,
      };
    })
    .filter(Boolean);
  const selectedModuleRows = useMemo(() => filteredGroups.flatMap((group: any) => group.projects.filter((project: any) => selectedModuleKeys.includes(`${project.project_id}:${project.module_id}`))), [filteredGroups, selectedModuleKeys]);
  const selectedModuleTotal = selectedModuleRows.reduce((sum: number, project: any) => sum + Number(project.cost || 0), 0);
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
    { title: '单价', dataIndex: 'part_cost', width: 90, align: 'right' as const, render: (v: number) => (v ?? 0)?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 55, align: 'center' as const },
    { title: '小计', key: 'sub', width: 95, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost ?? r.cost ?? 0) * (r.quantity ?? 0)).toFixed(4)}</b> },
    { title: '备注', dataIndex: 'remark', width: 100, ellipsis: true },
    {
      title: '入口', width: 110,
      render: () => <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => openProjectBOM(expandedPid!)}>打开项目 BOM</Button>,
    },
  ];

  return (
    <div>
      <div className="page-title"><InboxOutlined /> 模块基准</div>

      {/* Module cards - all modules grouped by name */}
      <div className="content-card" style={{ marginBottom: 14, padding: '14px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
          <Space wrap>
            <AppstoreOutlined style={{ color: '#CF0A2C', fontSize: 16 }} />
            <b style={{ fontSize: 14 }}>模块基准（由项目 BOM 派生）</b>
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
              onChange={v => { setProjectFilter(v || null); setSelectedModuleKeys([]); }}
              style={{ width: 180 }}
              optionFilterProp="label"
              options={projects.map((p: any) => ({ label: `${p.code} · ${p.name}`, value: p.id }))}
            />
          </Space>
          {projectFilter && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: selectedModuleRows.length ? 'rgba(207,10,44,0.06)' : '#F8FAFC', color: selectedModuleRows.length ? '#9F1239' : '#64748B', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b>模块多选汇总</b><span>已选 {selectedModuleRows.length} 个模块</span><strong style={{ fontSize: 15 }}>¥{selectedModuleTotal.toFixed(4)}</strong><span style={{ color: '#94A3B8' }}>勾选下方模块卡片即可加入合计</span>
              {selectedModuleRows.length > 0 && <Button type="link" size="small" onClick={() => setSelectedModuleKeys([])}>清空选择</Button>}
            </div>
          )}
          <Space>
            {/* 分类排序：自定义分类显示顺序 */}
            <Button size="small" icon={<SortAscendingOutlined />} onClick={() => setCatOrderModal(true)}>分类排序</Button>
          </Space>
          <Tag color="blue">项目 BOM 派生，只读对标</Tag>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
          {filteredGroups.map(group => {
            const costs = group.projects.map((p: any) => p.cost);
            const minC = Math.min(...costs), maxC = Math.max(...costs);
            const active = activeModName === group.name;
            const project = group.projects[0];
            const moduleKey = projectFilter && project ? `${project.project_id}:${project.module_id}` : '';
            const selected = Boolean(moduleKey && selectedModuleKeys.includes(moduleKey));
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
                {projectFilter && project && <Checkbox aria-label={`选择模块 ${group.name}`} checked={selected} onClick={e => e.stopPropagation()} onChange={e => setSelectedModuleKeys(prev => e.target.checked ? [...prev, moduleKey] : prev.filter(key => key !== moduleKey))} style={{ position: 'absolute', top: 8, left: 8 }} />}
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
                    <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => openProjectBOM(r.project_id)}>打开 BOM</Button>
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
                <div style={{ marginBottom: 8 }}><b style={{ fontSize: 13, color: '#1E3A6E' }}><EmojiIcon e="📋" /> 器件级对比（{cmpProjects.map((p: any) => p.project_code).join(' vs ')}）</b>
                  <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>上方表格勾选列选择参与对比的项目（勾选 = 参与）</span>
                </div>
                {/* 子类成本分布对比图 */}
                {subNames.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ textAlign: 'center', marginBottom: 4 }}><b style={{ fontSize: 12, color: '#64748B' }}>子类成本分布对比</b></div>
                    <ReactECharts echarts={echarts} option={cmpBarOption} style={{ height: Math.max(180, subNames.length * 40 + 40) }} />
                  </div>
                )}
                <DataTable tableId="mod_item_cmp" dataSource={rows} rowKey="key" size="small" pagination={false} virtual scroll={{ x: 1200, y: 520 }}
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
                <Space wrap>
                  <Select placeholder="目标项目" value={targetPid || undefined} onChange={v => setTargetPid(v)} style={{ width: 200 }} size="small"
                    options={projects.filter(p => p.id !== expandedPid).map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
                  <Button size="small" type="primary" icon={<FileAddOutlined />} onClick={() => void createReferenceChangePackage()}>创建参考变更包</Button>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => openProjectBOM(expandedPid)}>打开项目 BOM</Button>
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

    </div>
  );
}
