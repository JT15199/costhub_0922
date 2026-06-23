import { useEffect, useState } from 'react';
import { Table, Button, Input, Select, Space, Modal, Form, InputNumber, Tag, message, Popconfirm, Tabs, Row, Col, Tooltip, Card, Statistic, Upload, Alert, DatePicker, AutoComplete, Checkbox, Dropdown } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, UploadOutlined, DownloadOutlined, ArrowUpOutlined, ArrowDownOutlined, CheckOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import ReactECharts from 'echarts-for-react';
import { getProjects, saveProject, deleteProject, copyProject, getProjectBOMs, addBOMItem, updateBOMItem, deleteBOMItem, deleteBOMItemsByModule, getParts, getCostReviews, saveCostReview, deleteCostReview, getMeasures, saveMeasure, deleteMeasure, savePart, getModules, getModuleItems, saveModule, saveModuleItem, deleteModule, deleteModuleItemByPartId, getModuleByProjectAndName, cleanupEmptyModules, getTargets, saveTarget, deleteTarget, updateBOMRefProject, syncBOMToModuleItem, updateProjectOrder, getProjectGroups, saveProjectGroup, deleteProjectGroup, addProjectToGroup, removeProjectFromGroup, getProjectGroupMembers, updateBOMReferenceRemark, deleteReferenceBOMsByModule, softDeleteBOMItem, restoreBOMItem } from '../db';
import { TIERS, PROJECT_STATUSES, PROJECT_TYPES, SCREEN_SIZES, RESOLUTIONS, REFRESH_RATES, PANEL_TYPES, MAIN_CATEGORIES, SUB_CATEGORIES, MEASURE_STATUSES, getCategoryColor } from '../constants';
import { getMainCategories } from '../db';

export default function Projects(props: any) {
  const { highlightId, clearHighlight } = props;
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
  const [targets, setTargets] = useState<any[]>([]);
  const [targetModal, setTargetModal] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [targetForm] = Form.useForm();
  const [mainCats, setMainCats] = useState(MAIN_CATEGORIES);
  useEffect(() => { (async () => { try { setMainCats(await getMainCategories()); } catch(e) {} })(); }, []);
  const [modRefMap, setModRefMap] = useState<Record<string, { pid: number; items: any[] }>>({});
  const [bomSelKeys, setBomSelKeys] = useState<React.Key[]>([]);
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
  const [moduleProjectId, setModuleProjectId] = useState<number | null>(null);
  const [moduleListForProject, setModuleListForProject] = useState<any[]>([]);
  const [previewModItems, setPreviewModItems] = useState<any[]>([]);

  // Project grouping states
  const [groups, setGroups] = useState<any[]>([]);
  const [groupMap, setGroupMap] = useState<Record<number, number>>({});
  const [groupFilter, setGroupFilter] = useState<number | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<any>(null);

  // 处理全局搜索的高亮：自动选中项目并切换详情
  useEffect(() => {
    if (highlightId && highlightId.type === 'project' && highlightId.id) {
      (async () => {
        try {
          // 清空筛选条件
          setTypeFilter('');
          setGroupFilter(null);
          // 选中该项目
          setSelectedPid(highlightId.id);
          // 加载 BOM、评审、措施、目标
          const bomData = await getProjectBOMs(highlightId.id);
          setBoms(bomData);
          const revData = await getCostReviews(highlightId.id);
          setReviews(revData);
          const measureData = await getMeasures(highlightId.id);
          setMeasures(measureData);
          const targetData = await getTargets(highlightId.id);
          setTargets(targetData);
          // 清除高亮状态
          if (clearHighlight) {
            setTimeout(() => clearHighlight(), 500);
          }
        } catch(e) {
          console.error('Failed to load project:', e);
        }
      })();
    }
  }, [highlightId, clearHighlight]);
  const [groupForm] = Form.useForm();

  // 规划引用相关状态
  const [refImportModal, setRefImportModal] = useState(false);
  const [refSourcePid, setRefSourcePid] = useState<number | null>(null);
  const [refModules, setRefModules] = useState<any[]>([]);
  const [refSelectedModules, setRefSelectedModules] = useState<string[]>([]);

  // BOM 列隐藏控制
  const [hideCols, setHideCols] = useState<string[]>([]); // 隐藏的列名列表
  const toggleHideCol = (col: string) => {
    if (hideCols.includes(col)) setHideCols(hideCols.filter(c => c !== col));
    else setHideCols([...hideCols, col]);
  };
  const isColHidden = (col: string) => hideCols.includes(col);

  const loadGroups = async () => {
    const gs = await getProjectGroups();
    setGroups(gs);
    const map: Record<number, number> = {};
    for (const g of gs) {
      const members = await getProjectGroupMembers(g.id);
      for (const m of members) map[m.id] = g.id;
    }
    setGroupMap(map);
  };

  const handleModuleProjectChange = async (pid: number | null) => {
    setModuleProjectId(pid);
    bomForm.setFieldsValue({ _moduleId: undefined, _moduleName: undefined });
    setPreviewModItems([]);
    if (!pid) { setModuleListForProject([]); return; }
    const mods = await getModules(pid);
    const withInfo = await Promise.all(mods.map(async (m: any) => {
      const items = await getModuleItems(m.id);
      const total = items.reduce((s: number, i: any) => s + (i.cost || 0) * (i.quantity ?? 1), 0);
      return { ...m, totalCost: Math.round(total * 100) / 100, itemCount: items.length };
    }));
    setModuleListForProject(withInfo.sort((a, b) => a.name.localeCompare(b.name, 'zh')));
  };

  const loadProjects = async () => { setLoading(true); try { setProjects(await getProjects('', typeFilter)); } catch (e) { console.error(e); } setLoading(false); };
  useEffect(() => { loadProjects(); loadGroups(); }, [typeFilter]);

  const moveProject = async (index: number, direction: -1 | 1) => {
    const list = [...projects];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= list.length) return;
    [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
    // 先更新数据库
    await updateProjectOrder(list.map(p => p.id));
    // 再从数据库重新加载，确保状态一致
    await loadProjects();
    await loadGroups();
  };

  const loadBOM = async (pid: number) => setBoms(await getProjectBOMs(pid));
  const loadReviews = async (pid: number) => setReviews(await getCostReviews(pid));
  const loadMeasures = async (pid: number) => setMeasures(await getMeasures(pid));

  const selectProject = (pid: number) => { setSelectedPid(pid); loadBOM(pid); loadReviews(pid); loadMeasures(pid); loadTargets(pid); };
  const loadTargets = async (pid: number) => setTargets(await getTargets(pid));
  const loadModRef = async (modName: string, pid: number) => {
    if (!pid) { setModRefMap(prev => { const n = { ...prev }; delete n[modName]; return n; }); return; }
    const refBoms = await getProjectBOMs(pid);
    const modItems = refBoms.filter((b: any) => b.module_name === modName);
    setModRefMap(prev => ({ ...prev, [modName]: { pid, items: modItems } }));
    // Update all items in this module to reference this project
    if (selectedPid) await updateBOMRefProject(modName, selectedPid!, pid);
  };

  const handleSaveProject = async () => {
    const vals = await form.validateFields();
    // 检查项目代号是否已存在（新建和编辑改名时都要检查）
    if (!editing?.id || vals.code !== editing.code) {
      const dup = projects.find(p => p.code === vals.code && p.id !== editing?.id);
      if (dup) { message.error(`项目代号 [${vals.code}] 已存在，请更换`); throw new Error('DUPLICATE_CODE'); }
    }
    try {
      await saveProject({ ...editing, ...vals });
    } catch (e: any) {
      message.error('保存失败：' + (e?.message || e?.toString?.() || '未知错误'));
      throw e; // 保持 modal 打开
    }
    setEditing(null); form.resetFields(); setModalOpen(false); setGroupFilter(null); loadProjects(); loadGroups(); message.success('保存成功');
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

      // 支持小数数量，最小为0；数量保留两位小数，单价保留四位小数（视图层展示 2 位，导入按 4 位入库）
      const parsed: any[] = rows.map(r => {
        const qtyStr = getVal(r, qtyKeys);
        const qtyFloat = parseFloat(qtyStr);
        const quantity = Math.max(0, isNaN(qtyFloat) ? 1 : Math.round(qtyFloat * 100) / 100); // 数量保留两位小数
        const costStr = getVal(r, costKeys);
        const costFloat = parseFloat(costStr);
        const cost = Math.max(0, isNaN(costFloat) ? 0 : Math.round(costFloat * 10000) / 10000); // 单价保留四位小数
        return {
          project_code: getVal(r, ['项目代号', 'project_code', 'code']),
          project_name: getVal(r, ['项目名称', 'project_name']),
          module_name: getVal(r, moduleKeys) || '未归类',
          main_category: getVal(r, mainKeys) || '硬件类',
          sub_category: getVal(r, subKeys) || '',
          name: getVal(r, nameKeys),
          model: getVal(r, modelKeys),
          cost,
          quantity,
          remark: getVal(r, remarkKeys),
          // 验证标记
          _qtyWarning: qtyFloat < 0 ? '负数已修正为0' : (!qtyStr || isNaN(qtyFloat) ? '空值已设为1' : ''),
          _subtotal: Math.round(cost * quantity * 100) / 100, // 小计也保留两位小数
          _priceWarning: '',
        };
      }).filter(r => r.name);

      // 检查同一器件在不同模块中的价格一致性
      const partPriceMap: Record<string, { prices: number[], modules: string[], firstCost: number }> = {};
      parsed.forEach(r => {
        const key = `${r.name}|${r.model}`;
        if (!partPriceMap[key]) partPriceMap[key] = { prices: [], modules: [], firstCost: r.cost };
        partPriceMap[key].prices.push(r.cost);
        if (r.module_name && !partPriceMap[key].modules.includes(r.module_name)) partPriceMap[key].modules.push(r.module_name);
      });
      // 标记价格不一致的器件
      parsed.forEach(r => {
        const key = `${r.name}|${r.model}`;
        const info = partPriceMap[key];
        if (info && info.prices.some(p => Math.abs(p - info.firstCost) > 0.01)) {
          r._priceWarning = `同一器件在不同模块价格不一致: ${info.prices.map(p => p.toFixed(2)).join(', ')}`;
        }
      });

      setImportData(parsed);
      setImportPreview(parsed);
      setImportModal(true);
    };
    reader.readAsBinaryString(file);
    return false;
  };

  const importTotal = importPreview.reduce((s, r) => s + (r._subtotal || r.cost * r.quantity), 0);

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

    const currentProjectCode = projects.find(p => p.id === targetPid)?.code || '';

    // 模块：按项目隔离 —— 只在 B 项目下没有同名模块时才创建
    const modNames = [...new Set(importData.map(r => r.module_name).filter(Boolean))].filter(m => m !== '未归类');
    const existingMods = await getModules(targetPid!);
    const modIdMap: Record<string, number> = {};
    for (const mn of modNames) {
      // 如果该模块名下有参考条目，先删除参考条目（导入正式 OpenBOM 替换参考）
      await deleteReferenceBOMsByModule(targetPid!, mn);
      const exists = existingMods.find((m: any) => m.name === mn);
      if (exists) { modIdMap[mn] = exists.id; continue; }
      const mid = await saveModule({ project_id: targetPid!, name: mn, description: `从BOM导入自动创建` });
      modIdMap[mn] = mid;
    }
    // For each row: 合并到 parts 库（part.projects 累加项目代号），写入 project_boms，再在当前项目下补一份 module_items
    for (const row of importData) {
      if (!row.name) continue;
      const existing = await getParts(row.name, '', '');
      const match = existing.find((p: any) => p.model === row.model);
      let partId: number;
      if (match) {
        partId = match.id!;
        // 合并项目代号：把当前项目加到 projects 字段（逗号分隔，去重）
        const currentProjs = (match.projects || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const projectsField = currentProjs.includes(currentProjectCode)
          ? currentProjs.join(',')
          : [...currentProjs, currentProjectCode].filter(Boolean).join(',');
        // 只在新导入单价非零且与现有单价不同时才更新器件库单价，防止空单元格覆盖已有价格
        const hasNonZeroCost = row.cost > 0;
        const costChanged = hasNonZeroCost && Math.abs(match.cost - row.cost) > 0.0001;
        if (costChanged) {
          await savePart({ ...match, cost: row.cost, main_category: row.main_category, sub_category: row.sub_category, projects: projectsField });
        } else if (projectsField !== (match.projects || '')) {
          // 单价没变但需要把项目代号写进字段
          await savePart({ ...match, projects: projectsField });
        }
      } else {
        partId = await savePart({ main_category: row.main_category, sub_category: row.sub_category, category: row.main_category, name: row.name, model: row.model, cost: row.cost, specs: '', projects: currentProjectCode, remark: row.remark });
      }
      // 每个 BOM 条目携带自己的导入单价，避免多个模块共用同一器件的全局单价被覆盖
      await addBOMItem(targetPid!, partId, row.quantity, row.module_name, row.remark, 0, row.cost > 0 ? row.cost : null);
      // 在当前项目下补一份 module_items（模块本身只跟 project_id 绑定，所以每个项目都要有自己的 module + items）
      if (row.module_name && row.module_name !== '未归类' && modIdMap[row.module_name]) {
        await saveModuleItem({ module_id: modIdMap[row.module_name], part_id: partId, part_name: row.name, part_model: row.model, main_category: row.main_category, sub_category: row.sub_category, cost: row.cost, quantity: row.quantity, remark: row.remark });
      }
    }
    setImportModal(false); loadBOM(targetPid!); loadProjects();
    message.success(`导入完成: ${importData.length} 条`);
  };

  const bomTotal = boms.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
  const selProject = projects.find(p => p.id === selectedPid);
  const feeRate = selProject ? (selProject.platform_fee_rate || 0) + (selProject.profit_rate || 0) : 0;
  const totalWithFee = bomTotal * (1 + feeRate / 100);
  // Module grouping
  const moduleSummary: Record<string, number> = {};
  const groupedBOMs: Record<string, any[]> = {};
  boms.forEach(b => { const m = b.module_name || '未归类'; moduleSummary[m] = (moduleSummary[m] || 0) + (b.part_cost || 0) * b.quantity; if (!groupedBOMs[m]) groupedBOMs[m] = []; groupedBOMs[m].push(b); });

  // 按主项目分组排列：同组项目聚集，按 sort_order 排序；未分组排最后
  const sortedProjects = [...projects].sort((a, b) => {
    const ga = groupMap[a.id];
    const gb = groupMap[b.id];
    if (ga && gb && ga !== gb) return ga - gb;
    if (ga && !gb) return -1;
    if (!ga && gb) return 1;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
  const filteredProjects = groupFilter ? sortedProjects.filter(p => groupMap[p.id] === groupFilter) : sortedProjects;

  // 扁平列定义（无主项目分组，无列宽拖拽）
  const projectCols = [
    { title: '代号', dataIndex: 'code', width: 95, render: (v: string) => <b>{v}</b> },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    { title: '类型', dataIndex: 'project_type', width: 75, render: (v: string) => <Tag color={v === '已完成' ? 'green' : 'blue'}>{v || '在研'}</Tag> },
    { title: '状态', dataIndex: 'status', width: 75, render: (v: string) => <Tag color={v === '进行中' ? 'blue' : v === '已完成' ? 'green' : 'default'}>{v}</Tag> },
    { title: '屏幕规格', key: 's', width: 190, ellipsis: true, render: (_: any, r: any) => [r.screen_size, r.resolution, r.refresh_rate, r.panel_type].filter(Boolean).join(' / ') },
    { title: '费率', key: 'f', width: 95, render: (_: any, r: any) => `平台${r.platform_fee_rate}% / 利${r.profit_rate}%` },
    {
      title: '主项目', width: 130, render: (_: any, r: any) => {
        const gid = groupMap[r.id];
        if (gid) {
          const g = groups.find(gg => gg.id === gid);
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Tag color="purple" style={{ margin: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' }}>{g?.name || '...'}</Tag>
              <Popconfirm title="移出此主项目？" onConfirm={async () => {
                await removeProjectFromGroup(gid, r.id);
                loadGroups(); loadProjects();
              }}><Button type="link" size="small" danger style={{ padding: 0, fontSize: 10 }}>×</Button></Popconfirm>
            </div>
          );
        }
        return (
          <Select
            size="small" placeholder="加入主项目" style={{ width: 110 }} value={undefined}
            onChange={async (gid: number) => {
              await addProjectToGroup(gid, r.id);
              loadGroups(); loadProjects();
            }}
            options={groups.map(g => ({ label: g.name, value: g.id }))}
          />
        );
      },
    },
    {
      title: '操作', width: 230, render: (_: any, r: any, index: number) => (
        <Space size="small">
          <Tooltip title="上移"><Button type="link" size="small" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={(e) => { e.stopPropagation(); moveProject(index, -1); }} /></Tooltip>
          <Tooltip title="下移"><Button type="link" size="small" icon={<ArrowDownOutlined />} disabled={index === projects.length - 1} onClick={(e) => { e.stopPropagation(); moveProject(index, 1); }} /></Tooltip>
          <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); form.setFieldsValue(r); setModalOpen(true); }} /></Tooltip>
          <Tooltip title="复制"><Button type="link" size="small" icon={<CopyOutlined />} onClick={() => { selectProject(r.id); setCopyModal(true); copyForm.setFieldsValue({ code: `${r.code}-CP`, name: `${r.name}(副本)` }); }} /></Tooltip>
          {r.project_type !== '已完成' && (
            <Popconfirm title="确定定型转为已完成？将自动入库新器件和模块。" onConfirm={async () => {
              await saveProject({ ...r, project_type: '已完成', status: '已完成' });
              // Sync all BOM parts to parts library
              const b = await getProjectBOMs(r.id);
              for (const item of b) {
                await savePart({ id: item.part_id, main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.part_cost, specs: item.part_specs || '', projects: r.code, remark: '' });
              }
              message.success(`项目 [${r.code}] 已定型为已完成`);
              loadProjects();
            }}><Button type="link" size="small" style={{ color: '#10B981' }}>定型</Button></Popconfirm>
          )}
          <Popconfirm title="删除？" onConfirm={async () => { await deleteProject(r.id); loadProjects(); setSelectedPid(null); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
        </Space>
      ),
    },
  ];

  const bomColsBase: any[] = [
    { key: 'module_name', title: '模块', dataIndex: 'module_name', width: 90, render: (v: string) => v ? <Tag>{v}</Tag> : <Tag color="#ddd">未归类</Tag> },
    { key: 'main_category', title: '大类', dataIndex: 'main_category', width: 75, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { key: 'sub_category', title: '子类', dataIndex: 'sub_category', width: 90 },
    { key: 'part_name', title: '名称', dataIndex: 'part_name', ellipsis: true },
    { key: 'part_model', title: '型号', dataIndex: 'part_model', width: 120, ellipsis: true },
    { key: 'part_cost', title: '单价', dataIndex: 'part_cost', width: 85, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
    { key: 'quantity', title: '数量', dataIndex: 'quantity', width: 55, align: 'center' as const },
    { key: 'subtotal', title: '小计', width: 85, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost || 0) * r.quantity).toFixed(2)}</b> },
  ];
  const bomCols = bomColsBase.filter(c => !isColHidden(c.key));
  // 操作列始终显示
  bomCols.push({ key: 'action', title: '操作', width: 90, render: (_: any, r: any) => (
    <Space size="small">
      <Button type="link" size="small" onClick={() => { setBomEdit(r); bomForm.setFieldsValue({ ...r, _part_name: r.part_name, _part_model: r.part_model, _main_category: r.main_category, _sub_category: r.sub_category, _cost: r.part_cost }); setBomModal(true); }}>编辑</Button>
      {r.is_deleted === 1 ? (
        <Button type="link" size="small" style={{ color: '#10B981' }} onClick={async () => {
          await restoreBOMItem(r.id);
          loadBOM(selectedPid!);
          message.success('已恢复');
        }}>恢复</Button>
      ) : r.is_reference === 1 ? (
        <Popconfirm title="标记删除？不计入合计但保留痕迹" onConfirm={async () => {
          await softDeleteBOMItem(r.id);
          loadBOM(selectedPid!);
          message.success('已标记删除');
        }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
      ) : (
        <Popconfirm title="移除？将同步删除模块库中的对应器件" onConfirm={async () => {
          await deleteBOMItem(r.id);
          if (selectedPid && r.module_name && r.part_id) {
            const mod = await getModuleByProjectAndName(selectedPid, r.module_name);
            if (mod) await deleteModuleItemByPartId(mod.id, r.part_id);
          }
          await cleanupEmptyModules(selectedPid!);
          loadBOM(selectedPid!);
          message.success('已删除');
        }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
      )}
    </Space>
  )});

  return (
    <div>
      <div className="page-title"><span className="emoji">📋</span> 项目管理</div>
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Select placeholder="类型筛选" value={typeFilter || undefined} onChange={v => setTypeFilter(v || '')} allowClear style={{ width: 120 }} options={PROJECT_TYPES.map(s => ({ label: s, value: s }))} />
            <Select placeholder="主项目筛选" value={groupFilter} onChange={v => setGroupFilter(v || null)} allowClear style={{ width: 140 }} options={groups.map(g => ({ label: `${g.name} (${Object.values(groupMap).filter(v => v === g.id).length})`, value: g.id }))} />
            <Button size="small" onClick={() => { setEditingGroup(null); groupForm.resetFields(); setGroupModalOpen(true); }}>管理分组</Button>
          </Space>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalOpen(true); }}>新建项目</Button>
            <Button icon={<CopyOutlined />} onClick={() => setRefImportModal(true)}>规划引用</Button>
          </Space>
        </div>
        <Table
          dataSource={filteredProjects}
          columns={projectCols}
          rowKey="id"
          size="middle"
          loading={loading}
          onRow={(r) => ({ onClick: () => selectProject(r.id), style: { cursor: 'pointer', background: selectedPid === r.id ? '#FFF1F0' : undefined } })}
          pagination={{ pageSize: 15, showTotal: t => `共 ${t} 个项目` }}
        />
      </div>

      {selectedPid && (
        <div className="content-card" style={{ marginTop: 14 }}>
          <Row gutter={14} style={{ marginBottom: 14 }}>
            <Col span={6}><Card size="small"><Statistic title="BOM总成本" value={bomTotal} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title={`含费率总额 (${feeRate}%)`} value={totalWithFee} precision={2} prefix="¥" valueStyle={{ color: '#EF4444' }} /></Card></Col>
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
                  <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <Space>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={async () => { setAllParts(await getParts()); setBomEdit(null); setPreviewModItems([]); bomForm.resetFields(); bomForm.setFieldsValue({ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }); setBomModal(true); }}>添加器件</Button>
                      <Dropdown menu={{ items: [
                        { key: 'sub_category', label: '子类', onClick: () => toggleHideCol('sub_category'), icon: isColHidden('sub_category') ? <CheckOutlined style={{ color: '#10B981' }} /> : null },
                        { key: 'part_model', label: '型号', onClick: () => toggleHideCol('part_model'), icon: isColHidden('part_model') ? <CheckOutlined style={{ color: '#10B981' }} /> : null },
                        { key: 'main_category', label: '大类', onClick: () => toggleHideCol('main_category'), icon: isColHidden('main_category') ? <CheckOutlined style={{ color: '#10B981' }} /> : null },
                      ] }}><Button size="small">隐藏列 ▾</Button></Dropdown>
                      <Upload beforeUpload={handleImportFile} showUploadList={false} accept=".xlsx,.xls"><Button size="small" icon={<UploadOutlined />}>导入</Button></Upload>
                      <Button size="small" icon={<DownloadOutlined />} onClick={() => { const data = boms.map(b => ({ 模块: b.module_name, 大类: b.main_category, 子类: b.sub_category, 器件名称: b.part_name, 型号: b.part_model, 单价: b.part_cost, 数量: b.quantity, 小计: (b.part_cost || 0) * b.quantity, 备注: b.remark })); const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'BOM'); XLSX.writeFile(wb, `BOM_${projects.find(p => p.id === selectedPid)?.code || 'export'}.xlsx`); message.success('已导出'); }}>导出</Button>
                    </Space>
                    {bomSelKeys.length > 0 && (
                      <Space>
                        <Tag color="blue">{bomSelKeys.length} 项选中</Tag>
                        <Tag color="red">合计: ¥{boms.filter(b => bomSelKeys.includes(b.id)).reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0).toFixed(2)}</Tag>
                        <Popconfirm title={`删除选中 ${bomSelKeys.length} 项？将同步删除模块库中的对应器件`} onConfirm={async () => {
                          const selectedItems = boms.filter(b => bomSelKeys.includes(b.id));
                          for (const item of selectedItems) {
                            await deleteBOMItem(item.id);
                            // 同步删除模块库中的器件
                            if (selectedPid && item.module_name && item.part_id) {
                              const mod = await getModuleByProjectAndName(selectedPid, item.module_name);
                              if (mod) await deleteModuleItemByPartId(mod.id, item.part_id);
                            }
                          }
                          // 清理空模块（没有器件的模块）
                          await cleanupEmptyModules(selectedPid!);
                          setBomSelKeys([]);
                          loadBOM(selectedPid!);
                          message.success('已删除并清理空模块');
                        }}>
                          <Button size="small" danger icon={<DeleteOutlined />}>批量删除</Button>
                        </Popconfirm>
                      </Space>
                    )}
                  </div>
                  {/* Module-grouped BOM with per-module reference */}
                  {Object.entries(groupedBOMs).map(([modName, items]) => {
                    // 模块合计排除已删除条目
                    const activeItems = items.filter(b => b.is_deleted !== 1);
                    const modTotal = activeItems.reduce((s: number, b: any) => s + (b.part_cost || 0) * b.quantity, 0);
                    const deletedItems = items.filter(b => b.is_deleted === 1);
                    const ref = modRefMap[modName];
                    const refItems = ref?.items || [];
                    const refTotal = refItems.reduce((s: number, b: any) => s + (b.part_cost || 0) * b.quantity, 0);
                    const isInDev = (() => { const p = projects.find(pp => pp.id === selectedPid); return p && p.project_type !== '已完成'; })();
                    // 判断是否是参考模块（模块内有器件 is_reference=1）
                    const isReferenceModule = items.some(b => b.is_reference === 1);
                    const hasRef = ref && refItems.length > 0;
                    // 动态计算备注列宽度：基础 180 + 隐藏列释放的空间
                    const hiddenSpace = hideCols.reduce((sum: number, col: string) => {
                      if (col === 'sub_category') return sum + 90;
                      if (col === 'part_model') return sum + 120;
                      if (col === 'main_category') return sum + 75;
                      return sum;
                    }, 0);
                    const remarkWidth = 180 + hiddenSpace;
                    // 差异备注列（行内编辑）
                    const remarkCol = {
                      title: '差异备注', width: remarkWidth, render: (_: any, r: any) => (
                        <Input
                          size="small"
                          placeholder={r.is_reference === 1 ? '点击编辑...' : ''}
                          value={r.reference_remark || ''}
                          onChange={async (e) => {
                            await updateBOMReferenceRemark(r.id, e.target.value);
                            loadBOM(selectedPid!);
                          }}
                          style={{ fontSize: 12, background: r.is_reference === 1 ? '#FFF7E6' : undefined }}
                          disabled={r.is_reference !== 1}
                        />
                      ),
                    };
                    const extCols = hasRef ? [
                      ...bomCols.slice(0, -1),
                      { title: '参考单价', width: 80, align: 'right' as const, render: (_: any, r: any) => {
                        const rref = refItems.find((rb: any) => rb.sub_category === r.sub_category && (rb.part_name === r.part_name || rb.part_model === r.part_model));
                        return rref ? <span style={{ color: '#2563EB', fontSize: 10, fontFamily: 'monospace' }}>¥{Number(rref.part_cost).toFixed(2)}</span> : <span style={{ color: '#DDD', fontSize: 10 }}>—</span>;
                      }},
                      { title: '参考小计', width: 75, align: 'right' as const, render: (_: any, r: any) => {
                        const rref = refItems.find((rb: any) => rb.sub_category === r.sub_category && (rb.part_name === r.part_name || rb.part_model === r.part_model));
                        const refSub = rref ? (rref.part_cost || 0) * rref.quantity : 0;
                        const ourSub = (r.part_cost || 0) * r.quantity;
                        return rref ? <span style={{ color: refSub > ourSub ? '#EF4444' : '#10B981', fontSize: 10, fontWeight: 600 }}>¥{refSub.toFixed(2)}</span> : <span style={{ color: '#DDD', fontSize: 10 }}>—</span>;
                      }},
                      { title: '差异', width: 65, align: 'right' as const, render: (_: any, r: any) => {
                        const rref = refItems.find((rb: any) => rb.sub_category === r.sub_category && (rb.part_name === r.part_name || rb.part_model === r.part_model));
                        if (!rref) return <span style={{ color: '#DDD', fontSize: 10 }}>—</span>;
                        // 差异 = 当前小计 - 参考小计（当前比参考多了多少）
                        const diff = ((r.part_cost || 0) * r.quantity) - ((rref.part_cost || 0) * rref.quantity);
                        return <span style={{ color: diff > 0 ? '#EF4444' : diff < 0 ? '#10B981' : '#666', fontWeight: 600, fontSize: 10 }}>{diff >= 0 ? '+' : ''}¥{diff.toFixed(2)}</span>;
                      }},
                      remarkCol,
                      bomCols[bomCols.length - 1],
                    ] : [...bomCols.slice(0, -1), remarkCol, bomCols[bomCols.length - 1]];
                    return (
                      <div key={modName} style={{ marginBottom: 12, border: isReferenceModule ? '2px solid #F59E0B' : '1px solid #E8ECF1', borderRadius: 8, overflow: 'hidden', background: isReferenceModule ? '#FFF7E6' : undefined }}>
                        <div style={{ background: isReferenceModule ? '#FEF3C7' : '#F8FAFC', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #E8ECF1', flexWrap: 'wrap', gap: 8 }}>
                          <Space>
                            <b style={{ fontSize: 13 }}>{modName}</b>
                            {isReferenceModule && <Tag color="orange">参考</Tag>}
                            <Tag>{activeItems.length} 件</Tag>
                            {deletedItems.length > 0 && <Tag color="default" style={{ textDecoration: 'line-through' }}>{deletedItems.length} 已删</Tag>}
                            <Tag color="red">¥{modTotal.toFixed(2)}</Tag>
                            {hasRef && <Tag color="blue">参考: ¥{refTotal.toFixed(2)}</Tag>}
                            {hasRef && <Tag color={modTotal > refTotal ? 'red' : 'green'}>{modTotal > refTotal ? '+' : ''}¥{(modTotal - refTotal).toFixed(2)}</Tag>}
                            {/* 全选/取消全选按钮 */}
                            {(() => {
                              const itemIds = items.map(i => i.id);
                              const allSelected = itemIds.every(id => bomSelKeys.includes(id));
                              return allSelected ? (
                                <span className="select-all-btn selected" onClick={() => { const others = bomSelKeys.filter(k => !itemIds.includes(k)); setBomSelKeys(others); }}>✓ 已全选</span>
                              ) : (
                                <span className="select-all-btn" onClick={() => { const others = bomSelKeys.filter(k => !itemIds.includes(k)); setBomSelKeys([...others, ...itemIds]); }}>全选</span>
                              );
                            })()}
                            {/* 删除整个模块按钮 */}
                            <Popconfirm title={`删除模块 "${modName}" 的所有器件？此操作将同步删除模块库中的对应模块。`} onConfirm={async () => {
                              await deleteBOMItemsByModule(selectedPid!, modName);
                              // 同步删除模块库中的模块和器件
                              const mod = await getModuleByProjectAndName(selectedPid!, modName);
                              if (mod) {
                                // 删除模块会自动删除所有 module_items（CASCADE）
                                await deleteModule(mod.id);
                              }
                              // 清理所有空模块
                              await cleanupEmptyModules(selectedPid!);
                              setBomSelKeys(bomSelKeys.filter(k => !items.some(i => i.id === k)));
                              loadBOM(selectedPid!);
                              message.success(`已删除模块 [${modName}] 并同步模块库`);
                            }}>
                              <Button size="small" danger icon={<DeleteOutlined />}>删除模块</Button>
                            </Popconfirm>
                          </Space>
                          {isInDev && (
                            <Select size="small" allowClear style={{ width: 200 }} placeholder="选已完成项目参考此模块"
                              value={ref?.pid || undefined}
                              onChange={v => loadModRef(modName, v || 0)}
                              options={projects.filter((p: any) => p.id !== selectedPid && p.project_type === '已完成').map((p: any) => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
                          )}
                        </div>
                        <Table dataSource={items} columns={extCols} rowKey="id" size="small" pagination={false} scroll={{ x: hasRef ? 1250 : 950 }}
                          rowClassName={(r) => r.is_deleted === 1 ? 'bom-row-deleted' : ''}
                          rowSelection={{ selectedRowKeys: bomSelKeys.filter(k => items.some(i => i.id === k)), onChange: (keys) => { const others = bomSelKeys.filter(k => !items.some(i => i.id === k)); setBomSelKeys([...others, ...keys]); } }}
                          summary={() => (
                            <Table.Summary.Row>
                              <Table.Summary.Cell index={0} colSpan={5}><b style={{ fontSize: 12 }}>{modName} 合计</b></Table.Summary.Cell>
                              <Table.Summary.Cell index={5} align="right"><b style={{ color: '#CF0A2C', fontSize: 13 }}>¥{modTotal.toFixed(2)}</b></Table.Summary.Cell>
                              {hasRef && <Table.Summary.Cell index={6} colSpan={3} align="right"><span style={{ color: '#64748B', fontSize: 11 }}>参考: ¥{refTotal.toFixed(2)} | 差异: {modTotal > refTotal ? '+' : ''}¥{(modTotal - refTotal).toFixed(2)}</span></Table.Summary.Cell>}
                            </Table.Summary.Row>
                          )} />
                      </div>
                    );
                  })}
                  {boms.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无BOM数据</div>}
                </div>
              ),
            },
            {
              key: 'analysis', label: '💰 成本分析', children: (() => {
                // Module cost data
                const byModule: Record<string, number> = {};
                boms.forEach(b => { const m = b.module_name || '未归类'; byModule[m] = (byModule[m] || 0) + (b.part_cost || 0) * b.quantity; });
                const modData = Object.entries(byModule).map(([k, v]) => ({ name: k, value: Math.round(v * 100) / 100 })).sort((a, b) => b.value - a.value);
                // Domain cost data with targets
                const byDomain: Record<string, number> = {};
                boms.forEach(b => { const d = b.main_category || '其他'; byDomain[d] = (byDomain[d] || 0) + (b.part_cost || 0) * b.quantity; });
                const targetMap: Record<string, number> = {};
                targets.forEach(t => { targetMap[t.domain] = t.target_cost; });

                const modBarOption = {
                  tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}<br/><b>¥${p[0].value.toFixed(2)}</b>` },
                  grid: { left: 100, right: 40, top: 5, bottom: 5 },
                  xAxis: { type: 'value', name: '¥' },
                  yAxis: { type: 'category', data: modData.map(d => d.name), axisLabel: { fontSize: 11 }, inverse: true },
                  series: [{ type: 'bar', barWidth: '55%', data: modData.map(d => ({ value: d.value, itemStyle: { color: '#CF0A2C', borderRadius: [0, 6, 6, 0] } })), label: { show: true, position: 'right', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 10 } }],
                };

                const domainBarOption = {
                  tooltip: { trigger: 'axis', formatter: (p: any) => { const d = p[0].name; const t = targetMap[d]; return `${d}<br/>实际: <b>¥${p[0].value.toFixed(2)}</b>${t ? `<br/>目标: ¥${t.toFixed(2)}<br/>${p[0].value <= t ? '✅ 达成' : '❌ 超出'} ¥${Math.abs(p[0].value - t).toFixed(2)}` : ''}`; } },
                  legend: { data: ['实际成本', '目标成本'], top: 0, right: 10, orient: 'horizontal' },
                  grid: { left: 80, right: 40, top: 35, bottom: 30 },
                  xAxis: { type: 'category', data: [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort(), axisLabel: { rotate: 25, fontSize: 10 } },
                  yAxis: { type: 'value', name: '¥' },
                  color: ['#CF0A2C', '#94A3B8'],
                  series: [
                    { name: '实际成本', type: 'bar', barGap: '10%', data: [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort().map(c => byDomain[c] || 0), itemStyle: { borderRadius: [6, 6, 0, 0] } },
                    { name: '目标成本', type: 'bar', data: [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort().map(c => targetMap[c] || 0), itemStyle: { borderRadius: [6, 6, 0, 0] } },
                  ],
                };

                return (
                  <div>
                    <Row gutter={14} style={{ marginBottom: 14 }}>
                      <Col span={12}><div className="content-card" style={{ margin: 0, padding: 12 }}><div className="card-header"><h3>模块成本分布</h3></div><ReactECharts option={modBarOption} style={{ height: 280, maxHeight: 400 }} /></div></Col>
                      <Col span={12}><div className="content-card" style={{ margin: 0, padding: 12 }}><div className="card-header"><h3>领域成本 vs 目标</h3></div><ReactECharts option={domainBarOption} style={{ height: 280 }} /></div></Col>
                    </Row>
                    {/* Target setting table */}
                    <div className="content-card" style={{ margin: 0, padding: 12 }}>
                      <div className="card-header"><h3>领域成本目标设定</h3><Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditTarget(null); targetForm.resetFields(); setTargetModal(true); }}>设定目标</Button></div>
                      <Table dataSource={(Object.keys(byDomain).length > 0 ? Object.keys(byDomain) : targets.map((t: any) => t.domain).filter(Boolean)).concat(targets.map((t: any) => t.domain).filter((d: string) => !byDomain[d])).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => ((targets.find((t:any) => t.domain === b)?.target_cost || 0) - (targets.find((t:any) => t.domain === a)?.target_cost || 0))).map(c => {
                        const actual = byDomain[c] || 0;
                        const t = targets.find((x: any) => x.domain === c);
                        const target = t?.target_cost || 0;
                        const diff = target ? actual - target : 0;
                        const rate = target ? Math.round((2 - actual / target) * 100) : 0;
                        return { key: c, domain: c, actual, target, diff, rate, id: t?.id };
                      })} rowKey="key" size="small" pagination={false}
                        columns={[
                          { title: '领域', dataIndex: 'domain', width: 100, render: (v: string, r: any) => {
                            const isOverBudget = r.target > 0 && r.actual > r.target;
                            return <Tag color={isOverBudget ? 'error' : getCategoryColor(v)}>{v}</Tag>;
                          }},
                          { title: '实际成本(¥)', dataIndex: 'actual', width: 120, align: 'right' as const, render: (v: number, r: any) => {
                            const isOverBudget = r.target > 0 && v > r.target;
                            return <b style={{ color: isOverBudget ? '#EF4444' : undefined }}>{v.toFixed(2)}</b>;
                          }},
                          { title: '目标成本(¥)', dataIndex: 'target', width: 120, align: 'right' as const, render: (v: number) => v > 0 ? <span style={{ color: '#2563EB' }}>{v.toFixed(2)}</span> : <span style={{ color: '#CCC' }}>未设定</span> },
                          { title: '差异(¥)', dataIndex: 'diff', width: 110, align: 'right' as const, render: (v: number, r: any) => r.target > 0 ? (
                            <span style={{ color: v <= 0 ? '#10B981' : '#EF4444', fontWeight: 600 }}>
                              {v <= 0 ? '' : '+'}{v.toFixed(2)}
                              {v > 0 && <Tag color="error" style={{ marginLeft: 4, fontSize: 10 }}>超预算</Tag>}
                            </span>
                          ) : <span style={{ color: '#CCC' }}>—</span> },
                          { title: '达成率', dataIndex: 'rate', width: 90, align: 'center' as const, render: (v: number, r: any) => r.target > 0 ? (
                            <Tag color={v >= 100 ? 'success' : 'error'}>{v}% {v >= 100 ? '✓' : '✗'}</Tag>
                          ) : <span style={{ color: '#CCC' }}>—</span> },
                          { title: '操作', width: 100, render: (_: any, r: any) => r.id ? (
                            <Space size="small">
                              <Button type="link" size="small" onClick={() => { setEditTarget({ id: r.id, domain: r.domain, target_cost: r.target }); targetForm.setFieldsValue({ domain: r.domain, target_cost: r.target }); setTargetModal(true); }}>编辑</Button>
                              <Popconfirm title="删除？" onConfirm={async () => { await deleteTarget(r.id); loadTargets(selectedPid!); }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
                            </Space>
                          ) : (
                            <Button type="link" size="small" onClick={() => { setEditTarget(null); targetForm.setFieldsValue({ domain: r.domain, target_cost: 0 }); setTargetModal(true); }}>设定</Button>
                          )},
                        ]} />
                    </div>
                  </div>
                );
              })(),
            },
            {
              key: 'reviews', label: '📊 成本测算', children: (
                <div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setReviewModal(true); }} style={{ marginBottom: 12 }}>添加测算</Button>
                  {/* Trend chart */}
                  {reviews.length > 0 && (() => {
                    const sorted = [...reviews].sort((a: any, b: any) => {
                      const order = ['Charter','CDCP','PDCP','ADCP','量产后降本'];
                      return order.indexOf(a.stage) - order.indexOf(b.stage);
                    });
                    const trendOption = {
                      tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}<br/>成本: <b>¥${p[0].value.toFixed(2)}</b>` },
                      grid: { left: 60, right: 30, top: 20, bottom: 30 },
                      xAxis: { type: 'category', data: sorted.map((r: any) => r.stage), axisLabel: { fontSize: 11 } },
                      yAxis: { type: 'value', name: '¥' },
                      series: [{ type: 'line', smooth: true, symbol: 'circle', symbolSize: 10, data: sorted.map((r: any) => r.reviewed_cost), itemStyle: { color: '#CF0A2C' }, lineStyle: { width: 3 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(207,10,44,0.25)' }, { offset: 1, color: 'rgba(207,10,44,0)' }] } }, label: { show: true, formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11 } }],
                    };
                    return <div className="content-card" style={{ margin: '0 0 12px 0', padding: 12 }}><div className="card-header"><h3>成本趋势</h3></div><ReactECharts option={trendOption} style={{ height: 250 }} /></div>;
                  })()}
                  <Table dataSource={reviews} rowKey="id" size="small" pagination={false}
                    columns={[
                      { title: '阶段', dataIndex: 'stage', width: 100 },
                      { title: '成本(¥)', dataIndex: 'reviewed_cost', width: 110, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
                      { title: '测算人', dataIndex: 'reviewer', width: 80 },
                      { title: '时间', dataIndex: 'reviewed_at', width: 150 },
                      { title: '备注', dataIndex: 'remark', ellipsis: true },
                      { title: '', width: 60, render: (_: any, r: any) => <Popconfirm title="删除？" onConfirm={async () => { await deleteCostReview(r.id); loadReviews(selectedPid!); }}><Button type="link" size="small" danger>删除</Button></Popconfirm> },
                    ]} />
                </div>
              ),
            },
            {
              key: 'measures', label: '🎯 降本措施', children: (
                <div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setMeasureModal(true); }} style={{ marginBottom: 12 }}>添加措施</Button>
                  <Table dataSource={measures} rowKey="id" size="small" pagination={false}
                    columns={[
                      { title: '领域', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                      { title: '措施', dataIndex: 'measure' },
                      { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === '已完成' ? 'green' : v === '执行中' ? 'blue' : 'default'}>{v}</Tag> },
                      { title: '负责人', dataIndex: 'owner', width: 70 }, { title: '截止', dataIndex: 'due_date', width: 100 },
                      { title: '操作', width: 100, render: (_: any, r: any) => (
                        <Space size="small">
                          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); form.setFieldsValue(r); setMeasureModal(true); }} />
                          <Popconfirm title="删除？" onConfirm={async () => { await deleteMeasure(r.id); loadMeasures(selectedPid!); }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
                        </Space>
                      )},
                    ]} />
                </div>
              ),
            },
          ]} />
        </div>
      )}

      {/* Project edit modal */}
      <Modal title={editing?.id ? '编辑项目' : '新建项目'} open={modalOpen} onOk={handleSaveProject} onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields(); }} width={640} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={editing || { project_type: '在研', tier: '主流级', status: '进行中', platform_fee_rate: 0, profit_rate: 0 }}>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="项目代号*" name="code" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item></Col>
            <Col span={8}><Form.Item label="项目名称*" name="name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="类型" name="project_type"><Select options={PROJECT_TYPES.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item label="档位" name="tier"><Select options={TIERS.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
            <Col span={6}><Form.Item label="状态" name="status"><Select options={PROJECT_STATUSES.map(s => ({ label: s, value: s }))} /></Form.Item></Col>
            <Col span={6}><Form.Item label="面板" name="panel_type"><Select options={PANEL_TYPES.map(p => ({ label: p, value: p }))} allowClear /></Form.Item></Col>
            <Col span={6}><Form.Item label="刷新率" name="refresh_rate"><AutoComplete options={REFRESH_RATES.map(r => ({ value: r }))} placeholder="如: 144Hz" allowClear filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())} /></Form.Item></Col>
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
      <Modal title={`BOM 导入预览 (${importPreview.length} 条)`} open={importModal} onOk={doImport} onCancel={() => setImportModal(false)} width={900} okText="确认导入">
        <Alert message="系统将自动：1) 按模块名归类 2) 匹配已有器件/创建新器件到器件库 3) 标记所属项目 4) 支持小数数量（最小为0）" type="info" style={{ marginBottom: 12 }} />
        {/* 总价显示 */}
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Tag color="blue">导入表格总价</Tag>
            <b style={{ color: '#CF0A2C', fontSize: 16 }}>¥{importTotal.toFixed(2)}</b>
          </Space>
          {/* 显示价格不一致警告 */}
          {importPreview.some(r => r._priceWarning) && (
            <Alert message="存在同一器件在不同模块中价格不一致的情况，导入时将使用第一个模块的价格" type="warning" showIcon style={{ maxWidth: 500 }} />
          )}
        </div>
        <Table dataSource={importPreview} rowKey={(_, i) => String(i)} size="small" scroll={{ y: 350 }}
          columns={[
            { title: '模块', dataIndex: 'module_name', width: 100 },
            { title: '大类', dataIndex: 'main_category', width: 80, render: (v: string) => <Tag>{v}</Tag> },
            { title: '子类', dataIndex: 'sub_category', width: 100 },
            { title: '名称', dataIndex: 'name' },
            { title: '型号', dataIndex: 'model', width: 120 },
            { title: '单价', dataIndex: 'cost', width: 85, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
            { title: '数量', dataIndex: 'quantity', width: 65, align: 'center' as const, render: (v: number, r: any) => (
              <span>
                {v?.toFixed(2)}
                {r._qtyWarning && <Tooltip title={r._qtyWarning}><Tag color="orange" style={{ marginLeft: 4, fontSize: 10 }}>!</Tag></Tooltip>}
              </span>
            )},
            { title: '小计', dataIndex: '_subtotal', width: 85, align: 'right' as const, render: (v: number) => <b>¥{v?.toFixed(2)}</b> },
            { title: '警告', dataIndex: '_priceWarning', width: 80, render: (v: string) => v ? <Tooltip title={v}><Tag color="warning">价格</Tag></Tooltip> : null },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={7}><b>合计</b></Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right"><b style={{ color: '#CF0A2C', fontSize: 14 }}>¥{importTotal.toFixed(2)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={8} />
            </Table.Summary.Row>
          )}
          pagination={false} />
      </Modal>

      {/* BOM add modal — 3 ways: from module library, from parts, manual */}
      <Modal title={bomEdit ? '编辑BOM项' : '添加器件到BOM'} open={bomModal} onOk={async () => {
        const v = await bomForm.validateFields();
        const mode = v._addMode || 'manual';
        if (bomEdit) {
          const oldModuleName = bomEdit.module_name;
          const newModuleName = v.module_name || '';
          const newCost = v._cost ?? bomEdit.part_cost;
          await updateBOMItem(bomEdit.id, v.quantity, newModuleName, v.remark || '', newCost);
          // 参考条目不同步器件库和模块库（规划阶段只是临时调整）
          if (bomEdit.is_reference !== 1) {
            // Sync to parts library
            if (bomEdit.part_id) {
              await savePart({ id: bomEdit.part_id, main_category: v._main_category || bomEdit.main_category, sub_category: v._sub_category || bomEdit.sub_category, category: v._main_category || bomEdit.main_category, name: v._part_name || bomEdit.part_name, model: v._part_model || bomEdit.part_model, cost: v._cost ?? bomEdit.part_cost, specs: bomEdit.part_specs || '', projects: bomEdit.projects || '', remark: v.remark || '' });
            }
            // Sync to module library - 更新模块库中的器件
            if (selectedPid && bomEdit.part_id) {
              // 如果模块名改变了，需要处理模块库同步
              if (oldModuleName !== newModuleName) {
              // 从旧模块中删除
              if (oldModuleName) {
                const oldMod = await getModuleByProjectAndName(selectedPid, oldModuleName);
                if (oldMod) await deleteModuleItemByPartId(oldMod.id, bomEdit.part_id);
              }
              // 如果新模块存在，添加到新模块；不存在则创建
              if (newModuleName && newModuleName !== '未归类') {
                let newMod = await getModuleByProjectAndName(selectedPid, newModuleName);
                if (!newMod) {
                  const modId = await saveModule({ project_id: selectedPid, name: newModuleName, description: '从BOM编辑自动创建' });
                  newMod = { id: modId };
                }
                await saveModuleItem({ module_id: newMod.id, part_id: bomEdit.part_id, part_name: v._part_name || bomEdit.part_name, part_model: v._part_model || bomEdit.part_model, main_category: v._main_category || bomEdit.main_category, sub_category: v._sub_category || bomEdit.sub_category, cost: v._cost ?? bomEdit.part_cost, quantity: v.quantity, remark: v.remark || '' });
              }
            } else {
              // 模块名未变，直接更新
              await syncBOMToModuleItem(selectedPid, newModuleName, bomEdit.part_id, v.quantity, v._cost ?? bomEdit.part_cost);
            }
          }
          } // 参考条目同步块结束
        } else if (mode === 'module') {
          // Import all items from selected module
          if (!v._moduleId) { message.warning('请选择模块'); return; }
          const items = await getModuleItems(v._moduleId);
          const srcPid = v._moduleProjectId || moduleProjectId || 0;
          for (const item of items) {
            let partId = item.part_id;
            if (!partId) {
              const existing = await getParts(item.part_name, '', '');
              const match = existing.find((p: any) => p.model === item.part_model);
              partId = match?.id || await savePart({ main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.cost, specs: '', projects: '', remark: '' });
            }
            await addBOMItem(selectedPid!, partId, item.quantity, item._modName || v._moduleName || '', item.remark || '', srcPid, item.cost || null);
          }
          message.success(`已导入模块 [${v._moduleName}]: ${items.length} 件`);
        } else if (mode === 'parts') {
          // 从器件库选择添加 - 需要同步到模块库
          const moduleName = v.module_name || '';
          if (moduleName && moduleName !== '未归类') {
            // 检查或创建模块
            let mod = await getModuleByProjectAndName(selectedPid!, moduleName);
            if (!mod) {
              const modId = await saveModule({ project_id: selectedPid!, name: moduleName, description: '从BOM添加自动创建' });
              mod = { id: modId };
            }
            // 添加器件到模块库
            const partInfo = allParts.find(p => p.id === v.part_id);
            if (partInfo) {
              await saveModuleItem({ module_id: mod.id, part_id: v.part_id, part_name: partInfo.name, part_model: partInfo.model, main_category: partInfo.main_category, sub_category: partInfo.sub_category, cost: partInfo.cost, quantity: v.quantity, remark: v.remark || '' });
            }
          }
          await addBOMItem(selectedPid!, v.part_id, v.quantity, moduleName, v.remark || '');
        } else {
          // Manual: create part first, then add to BOM and sync to module library
          const partId = await savePart({ main_category: v._main_category || '硬件类', sub_category: v._sub_category || '', category: v._main_category || '硬件类', name: v._part_name, model: v._part_model || '', cost: v._cost || 0, specs: '', projects: '', remark: '' });
          const moduleName = v._module_name || '';
          // 同步到模块库
          if (moduleName && moduleName !== '未归类') {
            let mod = await getModuleByProjectAndName(selectedPid!, moduleName);
            if (!mod) {
              const modId = await saveModule({ project_id: selectedPid!, name: moduleName, description: '从BOM手动录入自动创建' });
              mod = { id: modId };
            }
            await saveModuleItem({ module_id: mod.id, part_id: partId, part_name: v._part_name, part_model: v._part_model || '', main_category: v._main_category || '硬件类', sub_category: v._sub_category || '', cost: v._cost || 0, quantity: v._quantity || 1, remark: v._remark || '' });
          }
          await addBOMItem(selectedPid!, partId, v._quantity || 1, moduleName, v._remark || '', 0, v._cost || null);
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
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                      <Form.Item label="器件名称" name="_part_name" initialValue={bomEdit.part_name}><Input placeholder="器件名称" /></Form.Item>
                      <Form.Item label="型号" name="_part_model" initialValue={bomEdit.part_model}><Input placeholder="型号" /></Form.Item>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                      <Form.Item label="大类" name="_main_category" initialValue={bomEdit.main_category}><Select options={mainCats.map(c=>({label:c,value:c}))} onChange={v => bomForm.setFieldValue('_sub_category', (SUB_CATEGORIES[v]||[])[0]||'')} /></Form.Item>
                      <Form.Item label="子类" name="_sub_category" initialValue={bomEdit.sub_category}><Select options={(SUB_CATEGORIES[bomForm.getFieldValue('_main_category')]||[]).map(c=>({label:c,value:c}))} showSearch /></Form.Item>
                      <Form.Item label="单价(¥)" name="_cost" initialValue={bomEdit.part_cost}><InputNumber min={0} precision={2} style={{ width: '100%' }} prefix="¥" /></Form.Item>
                    </div>
                    <Row gutter={16}>
                      <Col span={12}><Form.Item label="模块名" name="module_name"><Input placeholder="如: 主板模块" /></Form.Item></Col>
                      <Col span={12}><Form.Item label="数量" name="quantity"><InputNumber min={0} step={0.1} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
                    </Row>
                    <Form.Item label="备注" name="remark"><Input /></Form.Item>
                    <Alert message="编辑后的名称/型号/大类/子类/单价将同步更新到器件库" type="info" showIcon style={{ marginTop: 8, fontSize: 12 }} />
                  </>
                );
              }
              if (mode === 'module') {
                return (
                  <>
                    <Form.Item label="源项目" name="_moduleProjectId">
                      <Select
                        showSearch
                        allowClear
                        placeholder="选择已有项目..."
                        filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
                        onChange={handleModuleProjectChange}
                        options={projects.map((p: any) => ({ label: `[${p.code}] ${p.name}`, value: p.id }))}
                      />
                    </Form.Item>
                    <Form.Item label="选择模块" name="_moduleId" rules={[{ required: true, message: '请选择模块' }]}>
                      <Select
                        showSearch
                        placeholder={moduleProjectId ? '选择模块...' : '请先选项目'}
                        disabled={!moduleProjectId}
                        filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
                        onChange={async (mid: number) => {
                          if (!mid) return;
                          const mod = moduleListForProject.find((m: any) => m.id === mid);
                          const items = await getModuleItems(mid);
                          setPreviewModItems(items);
                          bomForm.setFieldsValue({ _moduleName: mod?.name || '' });
                        }}
                        options={moduleListForProject.map((m: any) => ({
                          label: `${m.name}  (${m.itemCount}件 · ¥${m.totalCost.toFixed(2)})`,
                          value: m.id,
                        }))}
                        notFoundContent={moduleProjectId ? '该项目下暂无模块' : '请先选择项目'}
                      />
                    </Form.Item>
                    <Form.Item name="_moduleName" hidden><Input /></Form.Item>
                    {previewModItems.length > 0 && (
                      <div style={{ background: '#F8FAFC', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontWeight: 600, marginBottom: 8 }}>
                          模块包含 <Tag color="blue">{previewModItems.length} 件</Tag> 器件，确认后将全部导入：
                        </div>
                        <Table dataSource={previewModItems} rowKey="id" size="small" pagination={false} scroll={{ y: 200 }}
                          columns={[
                            { title: '名称', dataIndex: 'part_name', ellipsis: true },
                            { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
                            { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                            { title: '单价', dataIndex: 'cost', width: 80, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
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
                      <Col span={12}><Form.Item label="数量" name="quantity"><InputNumber min={0} step={0.1} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
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
                      <Select options={mainCats.map(c => ({ label: c, value: c }))}
                        onChange={(v) => bomForm.setFieldValue('_sub_category', (SUB_CATEGORIES[v] || [])[0] || '')} />
                    </Form.Item>
                    <Form.Item label="子类" name="_sub_category"><Select options={(SUB_CATEGORIES[bomForm.getFieldValue('_main_category')] || []).map(c => ({ label: c, value: c }))} showSearch /></Form.Item>
                    <Form.Item label="数量" name="_quantity"><InputNumber min={0} step={0.1} precision={2} style={{ width: '100%' }} /></Form.Item>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label="器件名称" name="_part_name" rules={[{ required: true }]}><Input placeholder="器件名称" /></Form.Item>
                    <Form.Item label="型号" name="_part_model"><Input placeholder="型号/料号" /></Form.Item>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label="单价" name="_cost"><InputNumber min={0} precision={2} style={{ width: '100%' }} prefix="¥" /></Form.Item>
                    <Form.Item label="模块" name="_module_name"><Input placeholder="归入模块" /></Form.Item>
                    <Form.Item label="备注" name="_remark"><Input placeholder="备注" /></Form.Item>
                  </div>
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      {/* Project group management modal */}
      <Modal title="主项目分组管理" open={groupModalOpen} onCancel={() => setGroupModalOpen(false)} footer={null} width={520} destroyOnClose>
        <div style={{ marginBottom: 16 }}>
          <Form form={groupForm} layout="inline" onFinish={async (v) => {
            await saveProjectGroup({ ...editingGroup, ...v });
            setEditingGroup(null); groupForm.resetFields(); loadGroups(); loadProjects(); message.success('已保存');
          }}>
            <Form.Item label="分组名称" name="name" rules={[{ required: true }]}><Input placeholder="如: 27寸系列" style={{ width: 140 }} /></Form.Item>
            <Form.Item label="描述" name="description"><Input placeholder="可选" style={{ width: 160 }} /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit" icon={<PlusOutlined />}>{editingGroup ? '更新' : '新增分组'}</Button></Form.Item>
            {editingGroup && <Button onClick={() => { setEditingGroup(null); groupForm.resetFields(); }}>取消编辑</Button>}
          </Form>
        </div>
        <Table dataSource={groups} rowKey="id" size="small" pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
            { title: '描述', dataIndex: 'description', ellipsis: true },
            { title: '项目数', key: 'c', render: (_: any, r: any) => Object.values(groupMap).filter(v => v === r.id).length },
            { title: '操作', width: 120, render: (_: any, r: any) => (
              <Space size="small">
                <Button type="link" size="small" onClick={() => { setEditingGroup(r); groupForm.setFieldsValue(r); }}>编辑</Button>
                <Popconfirm title="删除此分组？项目不会被删除，仅解除关联。" onConfirm={async () => {
                  await deleteProjectGroup(r.id);
                  loadGroups(); loadProjects(); message.success('已删除');
                }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
              </Space>
            )},
          ]} />
      </Modal>

      {/* Copy/Review/Measure modals - same */}
      <Modal title="复制项目" open={copyModal} onOk={async () => {
        try {
          const v = await copyForm.validateFields();
          // 自动去重：如果代号已存在，追加数字后缀
          let newCode = v.code;
          let suffix = 1;
          while (projects.find(p => p.code === newCode)) {
            newCode = `${v.code}-${suffix}`;
            suffix++;
          }
          await copyProject(selectedPid!, newCode, v.name);
          setCopyModal(false); loadProjects(); message.success(`已复制为 [${newCode}]`);
        } catch (e: any) {
          console.error(e);
          message.error('复制失败：' + (e?.message || e?.toString?.() || '未知错误'));
        }
      }} onCancel={() => setCopyModal(false)}>
        <Form form={copyForm} layout="vertical">
          <Form.Item label="新代号" name="code" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="新名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal title="成本测算" open={reviewModal} onOk={async () => { const v = await form.validateFields(); const date = v._review_date; await saveCostReview({ project_id: selectedPid, stage: v.stage, reviewed_cost: v.reviewed_cost, reviewer: v.reviewer, remark: v.remark, reviewed_at: date ? date.format('YYYY-MM-DD HH:mm:ss') : undefined }); setReviewModal(false); loadReviews(selectedPid!); }} onCancel={() => setReviewModal(false)} width={420}>
        <Form form={form} layout="vertical">
          <Form.Item label="阶段" name="stage" rules={[{ required: true }]}><Select options={['Charter','CDCP','PDCP','ADCP','量产后降本'].map(s=>({label:s,value:s}))} /></Form.Item>
          <Form.Item label="成本(¥)" name="reviewed_cost" rules={[{ required: true }]}><InputNumber min={0} style={{ width:'100%' }} prefix="¥" /></Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
            <Form.Item label="测算人" name="reviewer"><Input /></Form.Item>
            <Form.Item label="日期（可补录）" name="_review_date"><DatePicker style={{ width: '100%' }} placeholder="选日期，默认今天" /></Form.Item>
          </div>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal title={editing?.id ? '编辑措施' : '添加降本措施'} open={measureModal} onOk={async () => { const v = await form.validateFields(); await saveMeasure({ project_id: selectedPid, ...editing, ...v }); setMeasureModal(false); setEditing(null); loadMeasures(selectedPid!); message.success('已保存'); }} onCancel={() => { setMeasureModal(false); setEditing(null); }}>
        <Form form={form} layout="vertical"><Form.Item label="领域" name="main_category" rules={[{ required: true }]}><Select options={mainCats.map(c=>({label:c,value:c}))} /></Form.Item><Form.Item label="措施" name="measure" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="状态" name="status"><Select options={MEASURE_STATUSES.map(s=>({label:s,value:s}))} /></Form.Item><Form.Item label="负责人" name="owner"><Input /></Form.Item><Form.Item label="截止" name="due_date"><Input /></Form.Item><Form.Item label="备注" name="remark"><Input /></Form.Item></Form>
      </Modal>
      {/* Target setting modal */}
      <Modal title={editTarget?.id ? '编辑目标' : '设定领域成本目标'} open={targetModal} onOk={async () => { const v = await targetForm.validateFields(); await saveTarget({ ...editTarget, project_id: selectedPid, ...v }); setTargetModal(false); setEditTarget(null); loadTargets(selectedPid!); message.success('已保存'); }} onCancel={() => { setTargetModal(false); setEditTarget(null); }} width={400} destroyOnClose>
        <Form form={targetForm} layout="vertical">
          <Form.Item label="领域" name="domain" rules={[{ required: true }]}><Select options={mainCats.map(c=>({label:c,value:c}))} /></Form.Item>
          <Form.Item label="目标成本(¥)" name="target_cost" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} prefix="¥" /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>

      {/* 规划引用弹窗 */}
      <Modal title="规划引用 - 从已有项目导入参考模块" open={refImportModal} onOk={async () => {
        if (!refSourcePid) { message.warning('请选择源项目'); return; }
        if (refSelectedModules.length === 0) { message.warning('请勾选要引用的模块'); return; }
        // 自动创建新项目
        const srcProj = projects.find(p => p.id === refSourcePid);
        const newCode = `${srcProj?.code || 'REF'}-PLAN`;
        const newName = `${srcProj?.name || '参考'}-规划`;
        const newPid = await saveProject({ code: newCode, name: newName, project_type: '在研', tier: srcProj?.tier || '主流级', status: '进行中', platform_fee_rate: 0, profit_rate: 0 });
        // 导入选中的模块作为参考
        for (const modName of refSelectedModules) {
          const srcBoms = await getProjectBOMs(refSourcePid);
          const modItems = srcBoms.filter(b => b.module_name === modName);
          for (const item of modItems) {
            await addBOMItem(newPid, item.part_id, item.quantity, modName, '', refSourcePid, item.part_cost, true, '待确认');
          }
        }
        setRefImportModal(false); setRefSourcePid(null); setRefModules([]); setRefSelectedModules([]);
        loadProjects(); loadGroups(); message.success(`已创建规划项目 [${newCode}]，含 ${refSelectedModules.length} 个参考模块`);
      }} onCancel={() => { setRefImportModal(false); setRefSourcePid(null); setRefModules([]); setRefSelectedModules([]); }} width={680} destroyOnClose>
        <Alert message="选择已有项目作为参考源，勾选要引用的模块。导入的器件会标记为参考状态，后续可替换为正式BOM。" type="info" style={{ marginBottom: 12 }} />
        <Form layout="vertical">
          <Form.Item label="源项目">
            <Select
              placeholder="选择参考源项目..."
              value={refSourcePid}
              onChange={async (pid: number) => {
                setRefSourcePid(pid);
                setRefSelectedModules([]);
                const mods = await getModules(pid);
                // 获取每个模块的器件数和成本
                const withInfo = await Promise.all(mods.map(async (m: any) => {
                  const boms = await getProjectBOMs(pid);
                  const items = boms.filter(b => b.module_name === m.name);
                  const total = items.reduce((s: number, b: any) => s + (b.part_cost || 0) * b.quantity, 0);
                  return { name: m.name, itemCount: items.length, totalCost: Math.round(total * 100) / 100 };
                }));
                setRefModules(withInfo);
              }}
              options={projects.filter(p => p.project_type !== '规划').map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))}
              style={{ width: '100%' }}
            />
          </Form.Item>
          {refSourcePid && refModules.length > 0 && (
            <Form.Item label="勾选参考模块">
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {refModules.map(m => (
                  <div key={m.name} style={{ padding: '8px 12px', borderBottom: '1px solid #F0F0F0', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Checkbox checked={refSelectedModules.includes(m.name)} onChange={e => {
                      if (e.target.checked) setRefSelectedModules([...refSelectedModules, m.name]);
                      else setRefSelectedModules(refSelectedModules.filter(n => n !== m.name));
                    }} />
                    <span style={{ fontWeight: 500 }}>{m.name}</span>
                    <Tag>{m.itemCount} 件</Tag>
                    <Tag color="blue">¥{m.totalCost.toFixed(2)}</Tag>
                  </div>
                ))}
              </div>
            </Form.Item>
          )}
          {refSourcePid && refModules.length === 0 && (
            <Alert message="该项目暂无模块" type="warning" />
          )}
        </Form>
      </Modal>
    </div>
  );
}
