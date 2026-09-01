import { useEffect, useState, useMemo, useRef } from 'react';
import { EmojiIcon } from '../iconMap';
import { Table, Button, Input, Select, Space, Modal, Form, InputNumber, Segmented, Tag, message, notification, Popconfirm, Tabs, Row, Col, Tooltip, Card, Statistic, Upload, Alert, DatePicker, Checkbox, AutoComplete, Radio, Badge, Drawer, Dropdown } from 'antd';
import { PlusOutlined, PlusCircleOutlined, EditOutlined, DeleteOutlined, CopyOutlined, UploadOutlined, DownloadOutlined, FileTextOutlined, InboxOutlined, DollarOutlined, TagOutlined, LineChartOutlined, BarChartOutlined, ToolOutlined, CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined, AimOutlined, BuildOutlined, HistoryOutlined, EyeOutlined, CheckOutlined, CloseOutlined, RobotOutlined, BulbOutlined, MinusCircleOutlined, FullscreenOutlined, FullscreenExitOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { getProjects, saveProject, copyProject, getProjectBOMs, addBOMItem, updateBOMItem, deleteBOMItem, getParts, getCostReviews, saveCostReview, deleteCostReview, getMeasures, saveMeasure, deleteMeasure, savePart, getModules, getModuleItems, saveModule, saveModuleItem, getTargets, saveTarget, deleteTarget, updateBOMRefProject, getProjectCostSnapshots, recordProjectCostSnapshot, deleteProjectCostSnapshot, getSnapshotBOMDetail, getProjectSuppliers, saveProjectSupplier, deleteProjectSupplier, getProjectSupplierPriceHistory, saveProjectSupplierPriceHistory, getSkus, saveSku, saveSkuDiff, deleteSku, deleteSkuDiff, getAllSkuDiffs, getPartAliases, savePartAlias, getCompareCache, saveCompareCache, upsertInsight, normalizePartName, getInsights, markInsightRead, markInsightUnread, appendHandledInsight, removeHandledInsight, deletePartAliasExact, cleanupInsightStatus, getProjectBOMCustomColumns, saveProjectBOMCustomColumn, deleteProjectBOMCustomColumn, updateBOMCustomData, getDataChangeHistory } from '../db';
import { TIERS, PROJECT_STATUSES, PROJECT_TYPES, SCREEN_SIZES, RESOLUTIONS, REFRESH_RATES, PANEL_TYPES, MAIN_CATEGORIES, SUB_CATEGORIES, MEASURE_STATUSES, getCategoryColor } from '../constants';
import { getMainCategories, getSetting } from '../db';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { calcSkuCost as calcSkuCostFn, buildSkuBom as buildSkuBomFn } from '../skuCalc';
import { computeProjectHealth, type HealthIssue } from '../projectHealth';
import { computeProjectStatuses } from '../projectStatus';

/** 往 parts.projects 追加项目代号（去重，避免重复拼接） */
function appendProjectCode(existing: string | undefined, code: string): string {
  if (!code) return existing || '';
  const arr = (existing || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!arr.includes(code)) arr.push(code);
  return arr.join(',');
}

import DataTable, { ColumnSettingsButton } from '../components/DataTable';
import TargetAllocationPanel from '../components/TargetAllocationPanel';
import { chartTooltip, chartAxisStyle, chartTextMuted, chartSplitLine, barGradient } from '../chartTheme';
import { runAiIdentifyOnce, buildRuleGroups, moduleFingerprint, partKey, buildInsights } from '../autoCompare';
import { getAdvisorInsights, updateAdvisorStatus } from '../db/advisor';
import { getAuditFindings, markAuditRead, dismissAuditFinding } from '../auditStore';
import TenderWorkspace from '../components/TenderWorkspace';

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  // 品类管理
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const watchCategory = Form.useWatch('category', form);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [boms, setBoms] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [costSnapshots, setCostSnapshots] = useState<any[]>([]);
  const [snapshotSelKeys, setSnapshotSelKeys] = useState<React.Key[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [targetModal, setTargetModal] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [targetForm] = Form.useForm();
  const [mainCats, setMainCats] = useState(MAIN_CATEGORIES);
  useEffect(() => { (async () => { try { setMainCats(await getMainCategories()); } catch(e) {} })(); }, []);
  const [modRefMap, setModRefMap] = useState<Record<string, { pid: number; items: any[] }>>({});
  // 参照项目（在研测算：整个项目作为参照，按模块名自动关联参考）
  const [refProjPid, setRefProjPid] = useState<number | null>(null);
  const [refProjBoms, setRefProjBoms] = useState<any[]>([]);
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
  const [modList, setModList] = useState<any[]>([]);
  const [previewModItems, setPreviewModItems] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState('bom');
  // 方案三：领域目标钻取；项目列表由 App 原有左侧栏承载，不再占用页面宽度。
  const [domainFocus, setDomainFocus] = useState<string | null>(null);
  const [negotiationOpen, setNegotiationOpen] = useState(false);
  const [bomSearch, setBomSearch] = useState('');
  const [bomTableMode, setBomTableMode] = useState<'module' | 'flat'>('flat');
  const [inlineBomCell, setInlineBomCell] = useState<{ id: number; field: string; value: number | string } | null>(null);
  const [bomCustomColumns, setBomCustomColumns] = useState<any[]>([]);
  const [customColumnModal, setCustomColumnModal] = useState(false);
  const [customColumnTitle, setCustomColumnTitle] = useState('');
  const [customColumnType, setCustomColumnType] = useState<'text' | 'number'>('text');
  const [spreadsheetCell, setSpreadsheetCell] = useState<{ id: number; field: string } | null>(null);
  const [bomFullscreen, setBomFullscreen] = useState(false);
  const [bomHistoryOpen, setBomHistoryOpen] = useState(false);
  const [bomHistoryRows, setBomHistoryRows] = useState<any[]>([]);
  const [bomHistoryTitle, setBomHistoryTitle] = useState('');

  // ====== SKU 变体（基座项目 + 差异规则） ======
  const [skus, setSkus] = useState<any[]>([]);
  const [skuDiffsMap, setSkuDiffsMap] = useState<Record<number, any[]>>({});
  const [skuModal, setSkuModal] = useState(false);       // SKU 添加/编辑
  const [skuEdit, setSkuEdit] = useState<any>(null);
  const [skuDetail, setSkuDetail] = useState<any>(null); // SKU 详情弹窗（合并 BOM + 差异管理）
  const [diffModal, setDiffModal] = useState(false);     // 差异添加/编辑
  const [diffSkuId, setDiffSkuId] = useState<number | null>(null);
  const [diffEdit, setDiffEdit] = useState<any>(null);
  const [skuForm] = Form.useForm();
  const [diffForm] = Form.useForm();

  const loadProjects = async () => { try { setProjects(await getProjects('', '', categoryFilter)); } catch (e) { console.error(e); } };
  useEffect(() => { loadProjects(); }, [categoryFilter]);
  // AI 数据工程联动：切回页面自动刷新（BOM/报价/原声等写库后可见）
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.page === 'projects') { loadProjects; } else if (d?.page) { setBomFullscreen(false); } };
    window.addEventListener('app-page-active', h);
    return () => window.removeEventListener('app-page-active', h);
  }, [loadProjects]);
  useEffect(() => {
    if (!bomFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setBomFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bomFullscreen]);
  useEffect(() => {
    if (!selectedPid || activeTab !== 'bom') setBomFullscreen(false);
  }, [selectedPid, activeTab]);
  useEffect(() => {
    document.body.classList.toggle('bom-fullscreen-mode', bomFullscreen && !!selectedPid && activeTab === 'bom');
    return () => document.body.classList.remove('bom-fullscreen-mode');
  }, [bomFullscreen, selectedPid, activeTab]);
  // ====== 项目状态点（目标超支/报价情报/成本异动 → 列表圆点，点击选中项目） ======
  const [projectStatuses, setProjectStatuses] = useState<Record<number, any>>({});
  useEffect(() => {
    (async () => {
      try {
        const list = await getProjects('', '', '');
        const [targetsByP, bomsByP, snapsByP, insights] = await Promise.all([
          Promise.all(list.map((p: any) => getTargets(p.id))),
          Promise.all(list.map((p: any) => getProjectBOMs(p.id))),
          Promise.all(list.map((p: any) => getProjectCostSnapshots(p.id))),
          getInsights(),
        ]);
        const tByP: Record<number, any[]> = {}; const bByP: Record<number, any[]> = {}; const sByP: Record<number, any[]> = {};
        list.forEach((p: any, i: number) => { tByP[p.id] = targetsByP[i]; bByP[p.id] = bomsByP[i]; sByP[p.id] = snapsByP[i]; });
        setProjectStatuses(computeProjectStatuses(list, tByP, bByP, insights, sByP));
      } catch (e) { console.warn('状态点计算失败:', e); }
    })();
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('costhub-project-nav-data', {
      detail: { projects, statuses: projectStatuses, selectedPid },
    }));
  }, [projects, projectStatuses, selectedPid]);
  // 加载品类列表
  useEffect(() => {
    import('../db').then(async (m) => {
      await m.ensureDefaultCategories();
      setCategories(await m.getProductCategories());
    });
  }, []);

  const loadBOM = async (pid: number) => setBoms(await getProjectBOMs(pid));
  const loadBOMCustomColumns = async (pid: number) => {
    try { setBomCustomColumns(await getProjectBOMCustomColumns(pid)); } catch { setBomCustomColumns([]); }
  };
  useEffect(() => { if (selectedPid) loadBOMCustomColumns(selectedPid); else setBomCustomColumns([]); }, [selectedPid]);
  const loadReviews = async (pid: number) => setReviews(await getCostReviews(pid));
  const loadCostSnapshots = async (pid: number) => setCostSnapshots(await getProjectCostSnapshots(pid));
  const loadMeasures = async (pid: number) => setMeasures(await getMeasures(pid));
  // ====== SKU 变体 ======
  const loadSkus = async (pid: number) => {
    const list = await getSkus(pid);
    setSkus(list);
    setSkuDiffsMap(await getAllSkuDiffs(list.map(s => s.id)));
  };
  // SKU 成本：基座 BOM 成本 + Σ差异（add 加 / remove 减基座小计 / replace 新旧差额），原始值计算
  // 纯逻辑在 src/skuCalc.ts（可单测）
  const calcSku = (sku: any): { cost: number; delta: number; issues: string[] } =>
    calcSkuCostFn(boms, skuDiffsMap[sku.id] || [], bomTotal);
  // SKU 合并 BOM（基座 + 差异合成，含新增模块）：供详情展示——只展示不落库
  // 纯逻辑在 src/skuCalc.ts（可单测）
  const buildSkuBom = (sku: any) => buildSkuBomFn(boms, skuDiffsMap[sku.id] || []);
  // SKU 差异的器件来源选项（remove/replace 从基座 BOM 选）
  const skuBasePartOptions = boms.map((b: any) => ({ label: `${b.module_name || ''} / ${b.part_name} ${b.part_model}`, value: `${b.part_name}|${b.part_model}|${b.module_name || ''}` }));
  // 差异匹配基座行信息（选器件后自动带出）
  const skuPickBase = (val: string) => {
    const [name, model, mod] = val.split('|');
    const m = boms.find((b: any) => b.part_name === name && b.part_model === model && b.module_name === (mod || undefined));
    return m || null;
  };
  // ====== SKU 对比表（Excel 式：点格子直接改，数量清0=移除，分组内直接加行） ======
  const [editingCell, setEditingCell] = useState<{ skuId: number; rowKey: string } | null>(null);
  const [edQty, setEdQty] = useState<number>(1);
  const [edCost, setEdCost] = useState<number>(0);
  const [edModel, setEdModel] = useState<string>(''); // 编辑态型号（输入不同值 = 替换型号，如 8GB→16GB）
  // 添加中的临时行：module → 名称/型号（未保存）
  const [addingRows, setAddingRows] = useState<Record<string, { name: string; model: string }>>({});
  const [addPartModal, setAddPartModal] = useState(false);
  const [addPartForm] = Form.useForm();
  const refreshSkus = async () => {
    const l = await getSkus(selectedPid!); setSkus(l);
    setSkuDiffsMap(await getAllSkuDiffs(l.map(s => s.id)));
  };
  // 行内保存：qty<=0 → 移除（基座行）/ 删除（新增行）；恢复基座值 → 自动还原；model ≠ 基座型号 → 替换型号（8GB→16GB）
  const applyCell = async (skuId: number, row: any, qty: number, cost: number, model?: string) => {
    const diffs = skuDiffsMap[skuId] || [];
    const matchBase = (d: any) => d.part_name === row.name && d.part_model === row.model && (!d.module_name || d.module_name === row.module);
    const clearBase = async () => { for (const d of diffs.filter((d: any) => d.diff_type !== 'add' && matchBase(d))) await deleteSkuDiff(d.id); };
    if (row._isAdd) {
      const ex = diffs.find((d: any) => d.diff_type === 'add' && d.part_name === row.name && d.part_model === row.model && d.module_name === row.module);
      if (qty <= 0) { if (ex) await deleteSkuDiff(ex.id); }
      else if (ex) await saveSkuDiff({ ...ex, quantity: qty, unit_cost: cost });
      else await saveSkuDiff({ sku_id: skuId, diff_type: 'add', module_name: row.module, part_name: row.name, part_model: row.model, quantity: qty, unit_cost: cost });
    } else if (qty <= 0) {
      await clearBase();
      await saveSkuDiff({ sku_id: skuId, diff_type: 'remove', module_name: row.module, part_name: row.name, part_model: row.model });
    } else if (qty === row.baseQty && cost === row.baseCost && (!model || model === row.model)) {
      await clearBase(); // 改回基座值 → 还原
    } else {
      await clearBase();
      await saveSkuDiff({ sku_id: skuId, diff_type: 'replace', module_name: row.module, part_name: row.name, part_model: row.model, new_model: model && model !== row.model ? model : '', quantity: qty, unit_cost: cost });
    }
    await refreshSkus();
  };
  // 从某 SKU 明确移除该器件（基座行 → remove；新增行 → 删除 add 差异）
  const removeCell = async () => {
    if (!editingCell) return;
    const row = skuCompareRows.find(r => r.key === editingCell.rowKey);
    if (!row) { cancelEdit(); return; }
    const skuId = editingCell.skuId;
    const diffs = skuDiffsMap[skuId] || [];
    if (row._isAdd) {
      for (const d of diffs.filter((x: any) => x.diff_type === 'add' && x.part_name === row.name && x.part_model === row.model && x.module_name === row.module)) {
        await deleteSkuDiff(d.id);
      }
    } else {
      for (const d of diffs.filter((x: any) => x.diff_type !== 'add' && x.part_name === row.name && x.part_model === row.model && (!x.module_name || x.module_name === row.module))) {
        await deleteSkuDiff(d.id);
      }
      await saveSkuDiff({ sku_id: skuId, diff_type: 'remove', module_name: row.module, part_name: row.name, part_model: row.model });
    }
    await refreshSkus();
    cancelEdit();
  };
  // 开始编辑某单元格（新增行还需先填名称/型号）
  const startEdit = (sku: any, row: any) => {
    const skuIdx = skus.findIndex(s => s.id === sku.id);
    const cell = row.skus[skuIdx];
    setEditingCell({ skuId: sku.id, rowKey: row.key });
    setEdQty(cell && cell.qty != null ? cell.qty : (row.baseQty ?? 1));
    setEdCost(cell && cell.cost != null ? cell.cost : (row.baseCost ?? 0));
    setEdModel((cell && cell.newModel) || row.model || '');
  };
  const cancelEdit = () => setEditingCell(null);
  const saveEdit = async () => {
    if (!editingCell) return;
    const row = skuCompareRows.find(r => r.key === editingCell.rowKey);
    if (!row) { cancelEdit(); return; }
    if (row._isAdd && (!row.name || !row.model)) { message.warning('请先填写器件名称和型号'); return; }
    await applyCell(editingCell.skuId, row, edQty, edCost, edModel.trim());
    cancelEdit();
  };
  // 保存模块内新增器件（点某 SKU 列的 ＋ 后编辑数量/单价）
  const saveNewAdd = async (s: any, mod: string) => {
    const a = addingRows[mod];
    if (!a || !a.name) { message.warning('请先填写器件名称'); return; }
    await applyCell(s.id, { _isAdd: true, module: mod, name: a.name, model: a.model || '', baseCost: null, baseQty: null }, edQty, edCost);
    setAddingRows(prev => { const n = { ...prev }; delete n[mod]; return n; });
    cancelEdit();
  };
  // ====== 器件报价比对（跨项目同模块，AI 疑似识别 + 人工确认沉淀） ======
  const [cmpModal, setCmpModal] = useState(false);
  const [cmpModule, setCmpModule] = useState('');
  const [cmpRows, setCmpRows] = useState<any[]>([]);
  const [cmpRuleGroups, setCmpRuleGroups] = useState<any[]>([]);
  const [cmpAiGroups, setCmpAiGroups] = useState<any[]>([]);
  const [cmpAiBusy, setCmpAiBusy] = useState(false);
  const [cmpAiError, setCmpAiError] = useState('');
  const [cmpLastAt, setCmpLastAt] = useState('');
  const cmpModuleRef = useRef(''); // 防竞态：识别回调只更新当前模块的状态
  // 归一化/分组/指纹/解析/单次识别 已抽至 ../autoCompare（runAiIdentifyOnce, buildRuleGroups, moduleFingerprint, partKey, buildInsights）
  // AI 疑似识别（手动弹窗；后台自动识别由 App 级空闲/变更事件驱动 runAutoCompare）
  const runAiIdentify = async (modName: string, rows: any[], fp: string, aliases: any[]) => {
    setCmpAiBusy(true); setCmpAiError('');
    const stillCurrent = () => cmpModuleRef.current === modName;
    try {
      let groups: any[];
      try {
        groups = await runAiIdentifyOnce(rows, aliases);
      } catch (e) {
        // 自动重试一次（本地模型偶发输出异常）
        groups = await runAiIdentifyOnce(rows, aliases);
      }
      if (stillCurrent()) setCmpAiGroups(groups);
      await saveCompareCache(selectedProject?.category || '', modName, fp, JSON.stringify(groups));
      if (stillCurrent()) setCmpLastAt('刚刚');
    } catch (e: any) {
      if (stillCurrent()) setCmpAiError('AI 识别失败：' + String(e?.message || e).slice(0, 150));
    }
    if (stillCurrent()) setCmpAiBusy(false);
  };
  // 打开比对弹窗：指纹相同直接用缓存，变化才自动重识别
  const openModuleCompare = async (modName: string) => {
    setCmpModal(true); setCmpModule(modName); cmpModuleRef.current = modName; setCmpAiBusy(false); setCmpAiError(''); setCmpAiGroups([]); setCmpLastAt('');
    const cat = selectedProject?.category || '';
    const sameCat = projects.filter(p => (p.category || '') === cat && p.id !== selectedPid);
    const rows: any[] = [];
    for (const p of [selectedProject, ...sameCat]) {
      if (!p) continue;
      const boms = await getProjectBOMs(p.id);
      boms.filter((b: any) => b.module_name === modName).forEach((b: any) => {
        rows.push({ project: p.code || p.name, projectId: p.id, name: b.part_name, model: b.part_model || '', sub_category: b.sub_category || '', cost: b.part_cost || 0, quantity: b.quantity || 1, partId: b.part_id || 0 });
      });
    }
    try {
      const { getPartsSpecsMap } = await import('../db');
      const specsMap = await getPartsSpecsMap(rows.map((r: any) => r.partId));
      rows.forEach((r: any) => { r.specs = specsMap[r.partId] || ''; });
    } catch { /* 规格缺失不阻断 */ }
    setCmpRows(rows);
    const aliases = await getPartAliases(modName);
    setCmpRuleGroups(buildRuleGroups(rows, aliases));
    const fp = moduleFingerprint(rows);
    const cache = await getCompareCache(cat, modName);
    if (cache && cache.fingerprint === fp && cache.result_json) {
      try {
        const cached = JSON.parse(cache.result_json);
        // 已确认的行不再显示为疑似组（别名已沉淀，由规则层归组）
        const aliasSet = new Set<string>();
        aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => aliasSet.add(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`));
        setCmpAiGroups(cached.filter((g: any) => (g.rows || []).some((r: any) => !aliasSet.has(partKey(r)))));
      } catch { setCmpAiGroups([]); }
      setCmpLastAt(cache.identified_at);
    } else {
      runAiIdentify(modName, rows, fp, aliases);
    }
  };
  const confirmAiGroup = async (g: any) => {
    for (const r of g.rows) {
      await savePartAlias({ module_name: cmpModule, alias_name: r.name, alias_model: r.model, canonical_name: g.name, canonical_model: '', source: 'user_confirmed' });
    }
    const aliases = await getPartAliases(cmpModule);
    setCmpRuleGroups(buildRuleGroups(cmpRows, aliases));
    setCmpAiGroups(prev => prev.filter(x => x !== g));
    message.success(`已确认「${g.name}」，此后相同写法自动归组`);
  };
  const rejectAiGroup = async (g: any) => {
    const keys = g.rows.map((r: any) => partKey(r)).sort().join(';');
    await savePartAlias({ module_name: cmpModule, alias_name: `#NEG#${keys}`, alias_model: '', canonical_name: '', canonical_model: '', source: 'marked_different' });
    setCmpAiGroups(prev => prev.filter(x => x !== g));
    message.success('已标记不同，AI 不再建议该组合');
  };
  const rerunAiIdentify = async () => {
    const aliases = await getPartAliases(cmpModule);
    runAiIdentify(cmpModule, cmpRows, moduleFingerprint(cmpRows), aliases);
  };
  // ====== 报价情报（后台识别由 App 级驱动：空闲/导入/改价自动扫描，发现问题在此提醒） ======
  const [insightModal, setInsightModal] = useState(false);
  // AI 情报中心（2026-08-17 用户要求统一）：报价差异 / 自主建议 / 巡检发现 三个 tab
  const [aiTab, setAiTab] = useState<'diff' | 'advice' | 'audit'>('diff');
  const [adviceList, setAdviceList] = useState<any[]>([]);
  const [adviceShowDone, setAdviceShowDone] = useState(false);
  const [auditList, setAuditList] = useState<any[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [insightView, setInsightView] = useState<'pending' | 'all' | 'done'>('pending'); // 待处理/全部/已处理
  const [insightSelected, setInsightSelected] = useState<Set<number>>(new Set()); // 批量选择（模块 id）
  const [insightBusyKey, setInsightBusyKey] = useState<string | null>(null); // 正在处理的 模块id|组index
  const [unreadMods, setUnreadMods] = useState<Set<string>>(new Set());
  // 2026-08-18 重写：逐行「不是同一器件」乐观排除集（标记后行保留原位变灰+可撤销，而不是立即消失无反馈）
  const [rowExcluded, setRowExcluded] = useState<Set<string>>(new Set());
  const loadInsights = async () => {
    try { await cleanupInsightStatus(); } catch { /* 清理失败不影响加载 */ } // 历史脏数据：已核对/已处理完的模块不再停在待处理
    const list = await getInsights();
    setInsights(list);
    setUnreadMods(new Set(list.filter(i => i.status === 'unread').map(i => i.module_name)));
    setRowExcluded(new Set()); // 每次重载清空乐观排除标记（库中数据已是最新）
  };
  // 变更后触发全局识别（App 监听 costhub-compare-request 立即执行；空闲时也会自动扫描）
  const scheduleAutoCompare = () => window.dispatchEvent(new CustomEvent('costhub-compare-request'));
  useEffect(() => {
    loadInsights();
    // 侧边栏「报价情报」入口：App 先写待处理标志再切页（组件未挂载时 costhub-open-insights 事件会丢失）→ 挂载后消费标志打开弹窗
    if (localStorage.getItem('costhub-open-insights-pending')) {
      localStorage.removeItem('costhub-open-insights-pending');
      loadInsights();
      setInsightModal(true);
    }
    scheduleAutoCompare(); // 打开项目页立即触发一次（App 空闲监听会继续兜底）
    const onDone = () => loadInsights(); // 识别完成刷新情报红点
    window.addEventListener('costhub-compare-done', onDone);
    // 侧边栏「报价情报」入口点击 → 打开弹窗（同时加载自主建议/巡检，2026-08-17 AI 情报中心）
    const loadAiCenter = async () => {
      try { setAdviceList(await getAdvisorInsights()); } catch { setAdviceList([]); }
      try { setAuditList(await getAuditFindings()); } catch { setAuditList([]); }
    };
    const onOpen = () => { loadInsights(); loadAiCenter(); setInsightModal(true); };
    window.addEventListener('costhub-open-insights', onOpen);
    // 仪表盘驾驶舱「直达」→ 自动选中项目（costhub-open-project，detail: { pid }）
    const onOpenProject = (e: Event) => {
      const pid = (e as CustomEvent).detail?.pid;
      if (pid) { selectProject(pid); setSelectedPid(pid); }
    };
    window.addEventListener('costhub-open-project', onOpenProject);
    return () => {
      window.removeEventListener('costhub-compare-done', onDone);
      window.removeEventListener('costhub-open-insights', onOpen);
      window.removeEventListener('costhub-open-project', onOpenProject);
    };
  }, []);
  // 情报操作后重算该模块情报（已确认/否定的组被规则层吸收，不再算疑似；内容变化即刷新）
  const rebuildModuleInsight = async (ins: any) => {
    try {
      const projs = await getProjects('', '', '');
      const sameCat = projs.filter((p: any) => (p.category || '未分类') === (ins.category || '未分类'));
      const rows: any[] = [];
      for (const p of sameCat) {
        const boms = await getProjectBOMs(p.id);
        boms.filter((b: any) => b.module_name === ins.module_name).forEach((b: any) => {
          rows.push({ project: p.code || p.name, projectId: p.id, name: b.part_name, model: b.part_model || '', cost: b.part_cost || 0, quantity: b.quantity || 1 });
        });
      }
      const aliases = await getPartAliases(ins.module_name);
      const cache = await getCompareCache(ins.category, ins.module_name);
      let groups: any[] = [];
      if (cache && cache.result_json) { try { groups = JSON.parse(cache.result_json); } catch { groups = []; } }
      // 已确认别名集合：组内所有行都已被用户确认归组 → 该组已处理，不再提醒（新行/数据变化会自然重新出现）
      const confirmedSet = new Set<string>();
      aliases.filter((a: any) => a.source === 'user_confirmed').forEach((a: any) => confirmedSet.add(`${normalizePartName(a.alias_name)}|${normalizePartName(a.alias_model)}`));
      const rebuilt = buildInsights(groups, rows, aliases).filter((g: any) => (g.rows || []).some((r: any) => !confirmedSet.has(partKey(r))));
      await upsertInsight(ins.category, ins.module_name, JSON.stringify(rebuilt));
      return rebuilt.length === 0; // true = 该模块已全部处理完
    } catch (e) {
      console.error('重算情报失败', e);
      return false;
    }
  };
  // 情报操作：确认同一 / 标记不同（沉淀别名，作用域=情报所属模块；处理后该组从情报消失）
  // 乐观移除指定模块的指定组（立即反馈，不等后台）
  const optimisticRemoveGroup = (insId: number, gi: number) => {
    setInsights(prev => prev.map(x => {
      if (x.id !== insId) return x;
      let d: any[] = [];
      try { d = JSON.parse(x.insight_json); } catch { d = []; }
      d = d.filter((_: any, idx: number) => idx !== gi);
      return { ...x, insight_json: JSON.stringify(d) };
    }));
  };
  // 确认同一：乐观移除（立即消失）→ 后台沉淀别名/重算 → 校正
  const confirmInsightGroup = async (ins: any, g: any, gi: number) => {
    const key = ins.id + '|' + gi;
    setInsightBusyKey(key);
    optimisticRemoveGroup(ins.id, gi);
    try {
      for (const r of g.rows) {
        await savePartAlias({ module_name: ins.module_name, alias_name: r.name, alias_model: r.model, canonical_name: g.name, canonical_model: '', source: 'user_confirmed' });
      }
      const allDone = await rebuildModuleInsight(ins);
      if (allDone) await markInsightRead(ins.category, ins.module_name); // 全部处理完才归档已读；还有其他组则保持待处理
      const handledIdx = await appendHandledInsight(ins.category, ins.module_name, {
        name: g.name, type: g.type || 'rule', action: 'confirmed', rows: g.rows, diff: g.diff || 0,
        handled_at: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
      window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
      // 潜在节省 = 组内最高单价 - 最低单价（每台），提示下一步动作
      const prices = g.rows.map((r: any) => r.cost || 0);
      const maxP = Math.max(...prices), minP = Math.min(...prices);
      const save = (maxP - minP) * Math.max(...g.rows.map((r: any) => r.quantity || 1));
      await loadInsights(); // 后台校正
      const remGroups = (() => { try { const d = JSON.parse(ins.insight_json || '[]'); return d.length - 1; } catch { return 0; } })();
      notification.success({
        message: '已确认「' + g.name + '」为同一物料',
        description: (save > 0.01 ? '若按最低价 ¥' + minP.toFixed(2) + ' 谈，每台最多可省 ¥' + save.toFixed(2) + '；' : '别名已沉淀，下次自动归组；') + (remGroups > 0 ? '本模块还剩 ' + remGroups + ' 组待处理，处理完自动归档' : '本模块情报已处理完，自动归档'),
        placement: 'bottomRight', duration: 5,
        btn: <Button size="small" type="link" onClick={() => undoHandledInsight(ins, handledIdx)}>撤销</Button>,
      });
    } catch (e: any) {
      console.error('确认同一失败:', e);
      message.error('确认失败：' + (e?.message || e));
      await loadInsights(); // 失败恢复真实状态
    }
    setInsightBusyKey(null);
  };
  const rejectInsightGroup = async (ins: any, g: any, gi: number) => {
    const key = ins.id + '|' + gi;
    setInsightBusyKey(key);
    optimisticRemoveGroup(ins.id, gi); // 立即消失
    try {
      const keys = g.rows.map((r: any) => partKey(r)).sort().join(';');
      await savePartAlias({ module_name: ins.module_name, alias_name: `#NEG#${keys}`, alias_model: '', canonical_name: '', canonical_model: '', source: 'marked_different' });
      const allDone = await rebuildModuleInsight(ins);
      if (allDone) await markInsightRead(ins.category, ins.module_name); // 全部处理完才归档；还有其他组则保持待处理
      const handledIdx = await appendHandledInsight(ins.category, ins.module_name, {
        name: g.name, type: g.type || 'rule', action: 'rejected', rows: g.rows, diff: g.diff || 0,
        handled_at: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
      window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
      await loadInsights(); // 后台校正
      const remGroups2 = (() => { try { const d = JSON.parse(ins.insight_json || '[]'); return d.length - 1; } catch { return 0; } })();
      notification.success({
        message: '已标记不同，AI 不再建议该组合',
        description: remGroups2 > 0 ? '本模块还剩 ' + remGroups2 + ' 组待处理（误标记可在「已处理」撤销恢复）' : '本模块情报已处理完，自动归档（误标记可在「已处理」撤销恢复）',
        placement: 'bottomRight', duration: 5,
        btn: <Button size="small" type="link" onClick={() => undoHandledInsight(ins, handledIdx)}>撤销</Button>,
      });
    } catch (e: any) {
      console.error('标记不同失败:', e);
      message.error('操作失败：' + (e?.message || e));
      await loadInsights();
    }
    setInsightBusyKey(null);
  };
  // 逐行标记「不是同一器件」（2026-08-18 重写）：#ROWDIFF# 别名沉淀 + 乐观行级反馈——
  // 行不消失，原位变灰+「已排除」Tag（可立即撤销），剩余行继续可操作；后台照常重建识别
  const markRowDifferent = async (ins: any, g: any, gi: number, ri: number) => {
    const r = (g.rows || [])[ri];
    if (!r) return;
    const key = ins.id + '|' + gi + '|' + ri;
    setInsightBusyKey(key);
    setRowExcluded(prev => new Set(prev).add(key)); // ① 立即行级反馈
    try {
      await savePartAlias({ module_name: ins.module_name, alias_name: '#ROWDIFF#' + partKey(r), alias_model: '', canonical_name: '', canonical_model: '', source: 'marked_different' });
      await rebuildModuleInsight(ins); // 后台照常重建（下次识别/重开不再建议该行）
      const handledIdx = await appendHandledInsight(ins.category, ins.module_name, {
        name: r.name, type: 'row', action: 'row_different', rows: [r], diff: 0,
        handled_at: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
      window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
      const remain = (g.rows || []).length - 1;
      notification.success({
        message: '已排除「' + r.name + '」',
        description: remain > 0
          ? '该行不参与识别与价差；本组剩余 ' + remain + ' 行可继续确认/标记'
          : '该行不参与识别与价差；本组已无对比行，将不再提醒（已处理可撤销）',
        placement: 'bottomRight', duration: 5,
        btn: <Button size="small" type="link" onClick={() => undoRowExclude(ins, handledIdx, key, r)}>撤销</Button>,
      });
    } catch (e: any) {
      console.error('标记行不同失败:', e);
      setRowExcluded(prev => { const n = new Set(prev); n.delete(key); return n; }); // 失败回滚行级标记
      message.error('操作失败：' + (e?.message || e));
    }
    setInsightBusyKey(null);
  };
  // 撤销行排除：删别名 → 删已处理记录 → 重建 → 重载（行恢复参与识别）
  const undoRowExclude = async (ins: any, hi: number, key: string, r: any) => {
    try {
      await deletePartAliasExact(ins.module_name, '#ROWDIFF#' + partKey(r), '', 'marked_different');
      await removeHandledInsight(ins.category, ins.module_name, hi);
      await rebuildModuleInsight(ins);
      setRowExcluded(prev => { const n = new Set(prev); n.delete(key); return n; });
      await loadInsights();
      message.success('已撤销，该行恢复参与识别');
    } catch (e: any) {
      console.error('撤销行标记失败:', e);
      message.error('撤销失败：' + (e?.message || e));
    }
  };
  // 知道了 = 归档（已读）：从「待处理」消失，留在「全部」可查看可恢复；不重算，数据变化后新情报自动重新出现
  const markKnownInsight = async (ins: any) => {
    setInsights(prev => prev.map(x => x.id === ins.id ? { ...x, status: 'read' } : x));
    try {
      await markInsightRead(ins.category, ins.module_name);
      window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
      notification.success({
        message: '已归档（已读）',
        placement: 'bottomRight', duration: 4,
        btn: <Button size="small" type="link" onClick={() => restoreInsight(ins)}>撤销</Button>,
      });
    } catch (e: any) {
      console.error('标记已读失败:', e);
      await loadInsights();
    }
  };

  // ===== 批量操作（ui-ux-pro-max 准则：多选 + 操作条） =====
  const toggleInsightSelect = (id: number) => {
    setInsightSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const clearInsightSelect = () => setInsightSelected(new Set());
  // 批量归档（已读）：选中模块全部标记已读（带撤销）
  const batchArchiveInsights = async () => {
    const ids = [...insightSelected];
    if (ids.length === 0) return;
    const targets = insights.filter(i => ids.includes(i.id));
    for (const ins of targets) {
      try {
        await markInsightRead(ins.category, ins.module_name);
      } catch { /* 单项失败继续 */ }
    }
    setInsightSelected(new Set());
    await loadInsights();
    notification.success({
      message: `已归档 ${ids.length} 个模块（已读）`,
      placement: 'bottomRight', duration: 4,
      btn: <Button size="small" type="link" onClick={async () => {
        for (const ins of targets) {
          try { await markInsightUnread(ins.category, ins.module_name); } catch { /* 忽略 */ }
        }
        await loadInsights();
        notification.success({ message: '已恢复 ${ids.length} 个模块为待处理', placement: 'bottomRight', duration: 3 });
      }}>撤销</Button>,
    });
  };
  // 批量确认同一：选中模块内所有待处理组逐组确认（汇总结果）
  const batchConfirmInsights = async () => {
    const ids = [...insightSelected];
    if (ids.length === 0) return;
    const targets = insights.filter(i => ids.includes(i.id));
    let confirmed = 0, groups = 0;
    for (const ins of targets) {
      let data: any[] = [];
      try { data = JSON.parse(ins.insight_json || '[]'); } catch { data = []; }
      for (const g of data) {
        try {
          for (const r of g.rows || []) {
            await savePartAlias({ module_name: ins.module_name, alias_name: r.name, alias_model: r.model, canonical_name: g.name, canonical_model: '', source: 'user_confirmed' });
          }
          await appendHandledInsight(ins.category, ins.module_name, {
            name: g.name, type: g.type || 'rule', action: 'confirmed', rows: g.rows, diff: g.diff || 0,
            handled_at: new Date().toLocaleString('zh-CN', { hour12: false }),
          });
          groups++;
        } catch { /* 单项失败继续 */ }
      }
      try {
        const rebuildDone = await rebuildModuleInsight(ins);
        if (rebuildDone) await markInsightRead(ins.category, ins.module_name);
      } catch { /* 忽略 */ }
      confirmed++;
    }
    setInsightSelected(new Set());
    await loadInsights();
    message.success(`批量确认完成：${confirmed} 个模块、${groups} 组已沉淀别名并消除情报（如需撤销可在「已处理」中逐组恢复）`);
  };
  // 撤销已处理：删别名 → 重算 → 组回到待处理
  const undoHandledInsight = async (ins: any, hi: number) => {
    let item: any = null;
    try {
      const arr = JSON.parse(ins.handled_json || '[]');
      item = arr[hi];
      if (!item) return;
      if (item.action === 'confirmed') {
        for (const r of item.rows || []) {
          await deletePartAliasExact(ins.module_name, r.name, r.model || '', 'user_confirmed');
        }
      } else if (item.action === 'row_different') {
        const r = (item.rows || [])[0];
        if (r) await deletePartAliasExact(ins.module_name, '#ROWDIFF#' + partKey(r), '', 'marked_different');
      } else {
        const keys = (item.rows || []).map((r: any) => partKey(r)).sort().join(';');
        await deletePartAliasExact(ins.module_name, '#NEG#' + keys, '', 'marked_different');
      }
      await removeHandledInsight(ins.category, ins.module_name, hi);
      await rebuildModuleInsight(ins);
      await loadInsights();
      message.success(item.action === 'confirmed' ? '已撤销确认，该组已恢复（回到待处理重新识别）' : item.action === 'row_different' ? '已撤销行标记，该行恢复参与识别' : '已撤销标记，该组已恢复（AI 可重新建议）');
    } catch (e: any) {
      console.error('撤销失败:', e);
      message.error('撤销失败：' + (e?.message || e));
    }
  };
  // 恢复待处理：从「全部」拉回「待处理」
  const restoreInsight = async (ins: any) => {
    setInsights(prev => prev.map(x => x.id === ins.id ? { ...x, status: 'unread' } : x));
    try {
      await markInsightUnread(ins.category, ins.module_name);
      window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
      message.success('已恢复为待处理');
    } catch (e: any) {
      console.error('恢复失败:', e);
      await loadInsights();
    }
  };
  // 新增差异器件（add 到指定 SKU，弹窗保留作批量/复杂场景）
  const saveAddPart = async () => {
    const v = await addPartForm.validateFields();
    await saveSkuDiff({ sku_id: v.target_sku, diff_type: 'add', module_name: v.module_name, part_name: v.part_name, part_model: v.part_model || '', quantity: v.quantity ?? 1, unit_cost: v.unit_cost || 0 });
    setAddPartModal(false);
    addPartForm.resetFields();
    await refreshSkus();
    message.success('已添加差异器件');
  };
  // 合并对比行：基座器件 + 所有 SKU 新增器件并集，每行带每个 SKU 的状态
  const skuCompareRows = useMemo(() => {
    const matchBase = (d: any, b: any) => d.part_name === b.part_name && d.part_model === b.part_model && (!d.module_name || d.module_name === b.module_name);
    const rows: any[] = [];
    boms.forEach((b: any) => {
      rows.push({
        key: `b-${b.id}`, _isAdd: false, module: b.module_name || '未分模块', name: b.part_name, model: b.part_model,
        baseCost: b.part_cost || 0, baseQty: b.quantity || 1,
        skus: skus.map(s => {
          const diffs = skuDiffsMap[s.id] || [];
          const rm = diffs.find(d => d.diff_type === 'remove' && matchBase(d, b));
          if (rm) return { status: 'removed' as const };
          const rp = diffs.find(d => d.diff_type === 'replace' && matchBase(d, b));
          if (rp) return { status: 'replaced' as const, cost: rp.unit_cost || 0, qty: rp.quantity ?? (b.quantity || 1), newModel: rp.new_model || '' };
          return { status: 'base' as const, cost: b.part_cost || 0, qty: b.quantity || 1 };
        }),
      });
    });
    const seen = new Set<string>();
    skus.forEach(s => {
      (skuDiffsMap[s.id] || []).filter((d: any) => d.diff_type === 'add').forEach((d: any) => {
        const key = `${d.module_name}|${d.part_name}|${d.part_model}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({
          key: `a-${key}`, _isAdd: true, module: d.module_name || '新增模块', name: d.part_name, model: d.part_model, baseCost: null, baseQty: null,
          skus: skus.map(ss => {
            const dd = (skuDiffsMap[ss.id] || []).find((x: any) => x.diff_type === 'add' && x.module_name === d.module_name && x.part_name === d.part_name && x.part_model === d.part_model);
            return dd ? { status: 'added' as const, cost: dd.unit_cost || 0, qty: dd.quantity ?? 1 } : { status: 'none' as const };
          }),
        });
      });
    });
    // 按模块分组排序（基座模块顺序在前，新增模块追加）
    const modOrder = [...new Set(boms.map((b: any) => b.module_name || '未分模块'))];
    const addMods = [...new Set(rows.filter(r => r._isAdd).map(r => r.module))].filter(m => !modOrder.includes(m));
    rows.sort((a, b) => {
      const oa = modOrder.indexOf(a.module) >= 0 ? modOrder.indexOf(a.module) : modOrder.length + addMods.indexOf(a.module);
      const ob = modOrder.indexOf(b.module) >= 0 ? modOrder.indexOf(b.module) : modOrder.length + addMods.indexOf(b.module);
      return oa - ob;
    });
    return rows;
  }, [boms, skus, skuDiffsMap]);
  // ====== SKU 差异 Excel 导入（与项目 BOM 导入同逻辑） ======
  const [skuImportModal, setSkuImportModal] = useState(false);
  const [skuImportRows, setSkuImportRows] = useState<any[]>([]);
  const [skuImportTarget, setSkuImportTarget] = useState<number | null>(null);
  const handleSkuImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target?.result, { type: 'binary' });
      const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);
      const nameKeys = ['器件名称', 'name', '名称', 'part_name', 'Description'];
      const modelKeys = ['型号', 'model', 'part_model', 'MPN', '料号'];
      const moduleKeys = ['模块', 'module', '模块名', 'module_name', '功能模块'];
      const costKeys = ['单价', 'cost', '价格', 'price', '成本'];
      const qtyKeys = ['数量', 'quantity', 'qty', '用量'];
      const getVal = (r: any, keys: string[]) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return String(r[k]).trim(); } return ''; };
      const parsed = rows.map(r => {
        const name = getVal(r, nameKeys);
        const costRaw = getVal(r, costKeys);
        const qtyRaw = getVal(r, qtyKeys);
        const cost = parseFloat(costRaw) || 0;
        const quantity = qtyRaw ? parseFloat(qtyRaw) : 1;
        const issues: string[] = [];
        if (!name) issues.push('缺少器件名称');
        if (costRaw && isNaN(parseFloat(costRaw))) issues.push(`单价"${costRaw}"非数字`);
        if (qtyRaw && isNaN(parseFloat(qtyRaw))) issues.push(`数量"${qtyRaw}"非数字`);
        if (cost <= 0 && name) issues.push('单价为0或缺失');
        return { module_name: getVal(r, moduleKeys) || '未归类', name, model: getVal(r, modelKeys), cost, quantity, _issues: issues };
      }).filter(r => r.name);
      setSkuImportRows(parsed);
      setSkuImportTarget(skus[0]?.id ?? null);
      setSkuImportModal(true);
    };
    reader.readAsBinaryString(file);
    return false;
  };
  // 判定导入动作：基座有同名同型号 → 替换（值同基座则还原/跳过）；否则新增；已有差异则更新
  const skuImportAction = (row: any, skuId: number): { action: string; label: string } => {
    const base = boms.find((b: any) => b.part_name === row.name && b.part_model === row.model && (row.module_name === '未归类' || b.module_name === row.module_name));
    const existing = (skuDiffsMap[skuId] || []).filter((d: any) => d.part_name === row.name && d.part_model === row.model && (row.module_name === '未归类' || d.module_name === row.module_name));
    const sameAsBase = base && base.part_cost === row.cost && (base.quantity || 1) === row.quantity;
    if (base) {
      if (sameAsBase && existing.length > 0) return { action: 'restore', label: '还原为基座（清除已有差异）' };
      if (sameAsBase) return { action: 'skip', label: '与基座一致（跳过）' };
      return { action: 'replace', label: `替换（基座 ¥${(base.part_cost || 0).toFixed(2)}×${base.quantity || 1} → ¥${row.cost.toFixed(2)}×${row.quantity}）` };
    }
    if (existing.some((d: any) => d.diff_type === 'add')) return { action: 'add', label: '更新已有新增器件' };
    return { action: 'add', label: '新增器件' };
  };
  const doSkuImport = async () => {
    if (!skuImportTarget) { message.warning('请选择目标 SKU'); return; }
    let added = 0, replaced = 0, restored = 0, skipped = 0;
    for (const row of skuImportRows) {
      if ((row._issues || []).length > 0) continue;
      const { action } = skuImportAction(row, skuImportTarget);
      if (action === 'skip') { skipped++; continue; }
      // 先清除该 SKU 中该器件的已有差异（保证幂等，避免重复行）
      for (const d of (skuDiffsMap[skuImportTarget] || []).filter((x: any) => x.part_name === row.name && x.part_model === row.model && (row.module_name === '未归类' || x.module_name === row.module_name))) {
        await deleteSkuDiff(d.id);
      }
      if (action === 'restore') { restored++; continue; }
      await saveSkuDiff({ sku_id: skuImportTarget, diff_type: action === 'replace' ? 'replace' : 'add', module_name: row.module_name, part_name: row.name, part_model: row.model, quantity: row.quantity, unit_cost: row.cost });
      if (action === 'replace') replaced++; else added++;
    }
    setSkuImportModal(false); setSkuImportRows([]);
    const l = await getSkus(selectedPid!); setSkus(l);
    setSkuDiffsMap(await getAllSkuDiffs(l.map(s => s.id)));
    message.success(`导入完成：新增 ${added}，替换 ${replaced}，还原 ${restored}，跳过 ${skipped}`);
  };
  // ====== 整机供应商（ODM） ======
  const [projectSuppliers, setProjectSuppliers] = useState<any[]>([]);
  const [psModalOpen, setPsModalOpen] = useState(false);
  const [psEditing, setPsEditing] = useState<any>(null);
  const [psForm] = Form.useForm();
  const loadProjectSuppliers = async (pid: number) => setProjectSuppliers(await getProjectSuppliers(pid));
  // ODM 加权报价：Σ(启用供应商报价 × 份额) / Σ(份额)
  const odmWeightedPrice = projectSuppliers.filter(s => s.is_active).reduce((sum, s) => sum + (s.quoted_price || 0) * (s.share_ratio || 0) / 100, 0);
  const odmActiveCount = projectSuppliers.filter(s => s.is_active).length;

  // AI 小结（本地模型可选增强：一句话概括最需关注的问题；失败静默降级）
  const [healthAiSummary, setHealthAiSummary] = useState('');
  const [healthAiLoading, setHealthAiLoading] = useState(false);
  const runHealthSummary = async () => {
    if (healthAiLoading || healthIssues.length === 0) return;
    setHealthAiLoading(true);
    setHealthAiSummary('');
    try {
      const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
      const model = await getSetting('local_ai_model', '');
      if (!model) throw new Error('未配置本地模型');
      const list = healthIssues.map(i => `- ${i.level === 'danger' ? '严重' : i.level === 'warn' ? '注意' : '提示'}：${i.title}（${i.detail}）`).join('\n');
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(url, model,
          [{ role: 'system', content: '你是成本管理助手。根据项目体检结果，用一句话（不超过60字）概括最需要关注的问题和优先级，直接给结论，不要列举条目。' },
           { role: 'user', content: `项目 ${selectedProject?.code || ''} 体检结果：\n${list}` }],
          t => { full += t; setHealthAiSummary(full); },
          () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', json: false, think: false, num_predict: 4096, temperature: 0.3 },
        );
      });
      logLocalAICall({
        request_type: 'project_health',
        material_name: selectedProject?.code || '',
        system_prompt: '你是成本管理助手。根据项目体检结果，用一句话（不超过60字）概括最需要关注的问题和优先级，直接给结论，不要列举条目。',
        user_prompt: '项目 ' + (selectedProject?.code || '') + ' 体检结果',
        response_summary: full.slice(0, 200),
        success: true,
        model_name: model,
      });
    } catch (e: any) {
      setHealthAiSummary('AI 小结不可用：' + String(e?.message || e).slice(0, 120) + '（规则检查结果仍准确）');
    }
    setHealthAiLoading(false);
  };

  const selectProject = (pid: number) => {
    setSelectedPid(pid); setDomainFocus(null); setActiveTab('bom');
    loadBOM(pid); loadReviews(pid); loadCostSnapshots(pid); loadMeasures(pid); loadTargets(pid); loadProjectSuppliers(pid); loadSkus(pid);
    // 切换项目时自动退出参照对比模式（要对比再重新选择参照项目）
    setRefProjPid(null); setRefProjBoms([]); setModRefMap({});
  };
  const loadTargets = async (pid: number) => setTargets(await getTargets(pid));
  // 模块级参照保留为高级入口：默认跟随顶部全局参照，也可对单个模块指定其他项目。
  const loadModRef = async (modName: string, pid: number) => {
    if (!pid) {
      setModRefMap(prev => { const next = { ...prev }; delete next[modName]; return next; });
      if (selectedPid) await updateBOMRefProject(modName, selectedPid, 0);
      return;
    }
    const refBoms = await getProjectBOMs(pid);
    const modItems = refBoms.filter((b: any) => b.module_name === modName);
    setModRefMap(prev => ({ ...prev, [modName]: { pid, items: modItems } }));
    if (selectedPid) await updateBOMRefProject(modName, selectedPid, pid);
  };
  // 参照项目：整个项目作为参照，自动按模块名关联各模块的参考
  const loadRefProj = async (pid: number | null) => {
    setRefProjPid(pid);
    if (!pid) {
      setRefProjBoms([]);
      setModRefMap({});
      return;
    }
    const refBoms = await getProjectBOMs(pid);
    setRefProjBoms(refBoms);
    // 按模块名自动关联参考（每个模块匹配参照项目同名模块）
    const mods = [...new Set(refBoms.map((b: any) => b.module_name))];
    const map: Record<string, { pid: number; items: any[] }> = {};
    mods.forEach(m => { map[m] = { pid, items: refBoms.filter((b: any) => b.module_name === m) }; });
    setModRefMap(map);
    // 记录参照关系到 BOM 行（is_reference 标记）
    if (selectedPid) {
      for (const m of mods) await updateBOMRefProject(m, selectedPid!, pid);
    }
  };

  // 把参照项目的某模块器件复制进当前项目（做加减法：加模块）
  const importRefModule = async (modName: string) => {
    if (!selectedPid || !refProjPid) return;
    const refItems = refProjBoms.filter((b: any) => b.module_name === modName);
    if (refItems.length === 0) { message.info(`参照项目没有「${modName}」模块`); return; }
    // 已有同名模块则跳过已存在的器件（按名称+型号），只补缺失的
    const existing = (groupedBOMs[modName] || []).map((b: any) => `${b.part_name}|${b.part_model}`);
    let added = 0;
    for (const item of refItems) {
      const key = `${item.part_name || ''}|${item.part_model || ''}`;
      if (existing.includes(key)) continue;
      let partId = item.part_id;
      if (!partId) {
        const allParts = await getParts(item.part_name || '', '', '');
        const match = allParts.find((p: any) => p.name === item.part_name && (p.model || '') === (item.part_model || ''));
        partId = match?.id || await savePart({ main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.part_cost, specs: '', projects: '', remark: '' }, false);
      }
      // 传入参照项目的快照值（不用 parts 实时价），保证导入后与参照项目完全一致
      await addBOMItem(selectedPid!, partId!, item.quantity, modName, item.remark || '', refProjPid!, false, {
        name: item.part_name, model: item.part_model, cost: item.part_cost,
        mainCategory: item.main_category, subCategory: item.sub_category,
      });
      added++;
    }
    await recordProjectCostSnapshot(selectedPid!, 'module_imported', `从参照项目导入模块「${modName}」 ${added} 件`);
    setModRefMap(prev => ({ ...prev, [modName]: { pid: refProjPid, items: refItems } }));
    loadBOM(selectedPid!); loadCostSnapshots(selectedPid!);
    scheduleAutoCompare(); // 参照导入也触发后台识别
    message.success(`已从参照项目导入「${modName}」${added} 个器件`);
  };

  const handleSaveProject = async () => {
    try {
      const vals = await form.validateFields();
      // 品类联动规格：显示器存 4 规格字段，其他品类只存关键规格，避免脏数据
      const clean = vals.category === '显示器'
        ? { ...vals, specs: '' }
        : { ...vals, screen_size: '', resolution: '', refresh_rate: '', panel_type: '' };
      const saved = await saveProject({ ...editing, ...clean });
      // ⚠️ 新项目驱动 AI 分析（2026-08-18 用户方向：成本数据不常变，新项目才是分析动力）——保存后通知 App 调度
      if (!editing?.id) window.dispatchEvent(new CustomEvent('costhub-project-saved', { detail: { projectId: saved, code: vals.code || '' } }));
      // 新品类自动入库（保证品类筛选下拉能选到）
      if (vals.category && vals.category !== '未分类') {
        try {
          const m = await import('../db');
          const cats = await m.getProductCategories();
          if (!cats.some((c: any) => c.name === vals.category)) {
            await m.saveProductCategory({ name: vals.category });
            setCategories(await m.getProductCategories());
          }
        } catch { /* 品类入库失败不阻塞保存 */ }
      }
      if (editing?.id && selectedPid === editing.id) {
        await recordProjectCostSnapshot(editing.id, 'rate_changed', '项目费率或基础信息调整');
        await loadCostSnapshots(editing.id);
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await loadProjects();
      message.success('保存成功');
    } catch (e) {
      console.error('保存项目失败:', e);
      message.error('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
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
      const moduleCategoryKeys = ['模块分类', '模块类别', 'module_category', 'moduleCategory', '分类'];
      const mainKeys = ['大类', 'main_category', '主类'];
      const subKeys = ['子类', 'sub_category', '小类', '类型'];
      const costKeys = ['单价', 'cost', '价格', 'price', '成本'];
      const qtyKeys = ['数量', 'quantity', 'qty', '用量'];
      const remarkKeys = ['备注', 'remark', 'note'];

      const getVal = (r: any, keys: string[]) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return String(r[k]).trim(); } return ''; };

      const parsed = rows.map(r => {
        const name = getVal(r, nameKeys);
        const costRaw = getVal(r, costKeys);
        const qtyRaw = getVal(r, qtyKeys);
        const cost = parseFloat(costRaw) || 0;
        // 数量允许小数（分摊用量常见，如 0.000123），用 parseFloat 不截断
        const quantity = qtyRaw ? parseFloat(qtyRaw) : 1;
        // ===== 异常数据检测 =====
        const issues: string[] = [];
        const warns: string[] = [];
        if (!name) issues.push('缺少器件名称');
        if (costRaw && isNaN(parseFloat(costRaw))) issues.push(`单价"${costRaw}"非数字`);
        if (qtyRaw && isNaN(parseFloat(qtyRaw))) issues.push(`数量"${qtyRaw}"非数字`);
        if (cost <= 0 && name) issues.push('单价为0或缺失');
        // 数量为0：允许导入（作为占位/待定项），但黄色提示
        if (quantity <= 0 && name) warns.push('数量为0，小计为0，请确认是否占位');
        if (cost > 100000) issues.push('单价异常偏高(>10万)');
        if (quantity > 10000) issues.push('数量异常偏高(>1万)');
        if (quantity > 0 && quantity < 0.000001 && name) warns.push('数量异常偏小(<0.000001)');
        return {
          project_code: getVal(r, ['项目代号', 'project_code', 'code']),
          project_name: getVal(r, ['项目名称', 'project_name']),
          module_name: getVal(r, moduleKeys) || '未归类',
          module_category: getVal(r, moduleCategoryKeys),
          main_category: getVal(r, mainKeys) || '硬件类',
          sub_category: getVal(r, subKeys) || getVal(r, subKeys.includes('类型') ? subKeys : []),
          name,
          model: getVal(r, modelKeys),
          cost,
          quantity,
          remark: getVal(r, remarkKeys),
          // 行内异常提示
          _issues: issues,
          _warns: warns,
        };
      }).filter(r => r.name);
      setImportData(parsed);
      setImportPreview(parsed);
      setImportModal(true);
    };
    reader.readAsBinaryString(file);
    return false;
  };

  const doImport = async () => {
    const total = importData.length;
    const msgKey = 'bom_importing';
    // 实时进度提示：性能慢时用户明确知道"还在导入中"（每 10 条刷新一次）
    message.open({ key: msgKey, type: 'loading', content: `正在导入 0/${total} 条…`, duration: 0 });
    try {
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
      if (!targetPid) { message.destroy(msgKey); message.warning('请先选择一个项目'); return; }

      // Auto-create modules that don't exist yet
      const modNames = [...new Set(importData.map(r => r.module_name).filter(Boolean))].filter(m => m !== '未归类');
      const existingMods = await getModules(targetPid!);
      const allExistingModules = (await Promise.all(projects.map(async (p: any) => getModules(p.id)))).flat();
      const categoryByModuleName: Record<string, string> = {};
      for (const m of allExistingModules) {
        if (m.name && m.module_category && m.module_category !== '未分类') categoryByModuleName[m.name] = m.module_category;
      }
      for (const row of importData) {
        if (row.module_name && row.module_category) categoryByModuleName[row.module_name] = row.module_category;
      }
    const modIdMap: Record<string, number> = {};
    for (const mn of modNames) {
      const exists = existingMods.find((m: any) => m.name === mn);
      const moduleCategory = categoryByModuleName[mn] || exists?.module_category || '未分类';
      if (exists) {
        modIdMap[mn] = exists.id;
        if ((exists.module_category || '未分类') !== moduleCategory) {
          await saveModule({ ...exists, module_category: moduleCategory });
        }
        continue;
      }
      const mid = await saveModule({ project_id: targetPid!, name: mn, module_category: moduleCategory, description: `从BOM导入自动创建` });
      modIdMap[mn] = mid;
    }
    // For each row: save to parts library, then add to BOM with module_name
    const targetProjCode = projects.find(p => p.id === targetPid)?.code || '';
    // 器件匹配缓存：同名同型号只查一次库（行数多时避免 N 次串行查询卡住）
    const partCache = new Map<string, any>();
    let done = 0;
    for (const row of importData) {
      if (!row.name) continue;
      done++;
      if (done % 10 === 0 || done === total) {
        message.open({ key: msgKey, type: 'loading', content: `正在导入 ${done}/${total} 条…`, duration: 0 });
      }
      // 器件匹配：名称 + 型号必须完全一致才复用已有器件
      // （getParts 是 LIKE %name% 模糊搜索，若只按型号匹配会把"说明书"误命中"说明书 中文"等
      //   其他模块的器件，导致同一模块内一个物料取代另一个物料、金额错位）
      const cacheKey = `${row.name}|${row.model || ''}`;
      let match = partCache.get(cacheKey);
      if (match === undefined) {
        const existing = await getParts(row.name, '', '');
        match = existing.find((p: any) => p.name === row.name && (p.model || '') === (row.model || ''));
        partCache.set(cacheKey, match);
      }
      let partId: number;
      if (match) {
        partId = match.id!;
        if (Math.abs(match.cost - row.cost) > 0.0001) {
          await savePart({ ...match, cost: row.cost, main_category: row.main_category, sub_category: row.sub_category, projects: appendProjectCode(match.projects, targetProjCode) }, false);
        }
      } else {
        partId = await savePart({ main_category: row.main_category, sub_category: row.sub_category, category: row.main_category, name: row.name, model: row.model, cost: row.cost, specs: '', projects: targetProjCode, remark: row.remark }, false);
      }
      await addBOMItem(targetPid!, partId, row.quantity, row.module_name, row.remark, 0, false);
      // Also add to module_items
      if (row.module_name && row.module_name !== '未归类' && modIdMap[row.module_name]) {
        await saveModuleItem({ module_id: modIdMap[row.module_name], part_id: partId, part_name: row.name, part_model: row.model, main_category: row.main_category, sub_category: row.sub_category, cost: row.cost, quantity: row.quantity, remark: row.remark });
      }
    }
    await recordProjectCostSnapshot(targetPid!, 'bom_import', `BOM批量导入 ${total} 条`);
    await loadCostSnapshots(targetPid!);
    setImportModal(false); loadBOM(targetPid!); loadProjects();
    message.destroy(msgKey);
    message.success(`导入完成: ${total} 条`);
    scheduleAutoCompare(); // 后台自动识别物料差异（发现问题会提示）
    } catch (e: any) {
      message.destroy(msgKey);
      console.error('BOM 导入失败', e);
      message.error(`导入失败：${String(e?.message || e).slice(0, 200)}`);
    }
  };

  const bomTotal = boms.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
  const selectedProject = projects.find(p => p.id === selectedPid);
  const wholeMachineCost = bomTotal * (1 + (((selectedProject?.platform_fee_rate || 0) + (selectedProject?.profit_rate || 0)) / 100));

  // ====== AI 体检（规则驱动：BOM 完整性/目标/快照/同品类价差） ======
  const [healthIssues, setHealthIssues] = useState<HealthIssue[]>([]);
  const [peerBomsCache, setPeerBomsCache] = useState<Record<number, any[]>>({});
  useEffect(() => {
    if (!selectedPid) return;
    (async () => {
      try {
        // 同品类其他项目 BOM（按 project.category 分组，缓存避免重复拉取）
        const cat = selectedProject?.category || '未分类';
        const peers = projects.filter((p: any) => p.id !== selectedPid && (p.category || '未分类') === cat);
        const need = peers.filter((p: any) => !peerBomsCache[p.id]);
        if (need.length > 0) {
          const loaded = await Promise.all(need.map((p: any) => getProjectBOMs(p.id)));
          setPeerBomsCache(prev => {
            const n = { ...prev };
            need.forEach((p: any, i: number) => { n[p.id] = loaded[i]; });
            return n;
          });
        }
        const peerBoms = peers.map((p: any) => ({ projectId: p.id, code: p.code, boms: peerBomsCache[p.id] || [] }));
        setHealthIssues(computeProjectHealth({
          projectId: selectedPid,
          code: selectedProject?.code || '',
          boms,
          targets,
          snapshots: costSnapshots,
          peerBoms,
        }));
      } catch (e) { console.warn('体检计算失败:', e); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPid, boms, targets, costSnapshots, projects, selectedProject?.category]);
  // 领域聚合用于顶部目标达成；模块聚合继续用于 BOM 分组和成本分析。
  const moduleSummary: Record<string, number> = {};
  const domainSummary: Record<string, number> = {};
  const groupedBOMs: Record<string, any[]> = {};
  boms.forEach(b => {
    const module = b.module_name || '未归类';
    const domain = b.main_category || '其他';
    moduleSummary[module] = (moduleSummary[module] || 0) + (b.part_cost || 0) * b.quantity;
    domainSummary[domain] = (domainSummary[domain] || 0) + (b.part_cost || 0) * b.quantity;
  });
  const visibleBoms = boms.filter(b => {
    const matchesDomain = !domainFocus || (b.main_category || '其他') === domainFocus;
    const q = bomSearch.trim().toLowerCase();
    const matchesSearch = !q || `${b.module_name || ''} ${b.part_name || ''} ${b.part_model || ''} ${b.part_specs || ''}`.toLowerCase().includes(q);
    return matchesDomain && matchesSearch;
  });
  visibleBoms.forEach(b => { const m = b.module_name || '未归类'; if (!groupedBOMs[m]) groupedBOMs[m] = []; groupedBOMs[m].push(b); });
  // BOM 模块排序：与模块库一致（分类顺序优先 + 分类内按名称）
  // 模块分类从 modules 表取，分类顺序从 settings 取（模块库排序同一套）
  const [modCatMap, setModCatMap] = useState<Record<string, string>>({});
  const [bomCatOrder, setBomCatOrder] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const m = await import('../db');
        setBomCatOrder(await m.getModuleCategoryOrder());
        if (selectedPid) {
          const mods = await m.getModules(selectedPid);
          const map: Record<string, string> = {};
          mods.forEach((x: any) => { map[x.name] = x.module_category || '未分类'; });
          setModCatMap(map);
        }
      } catch { /* 失败不阻塞 */ }
    })();
  }, [selectedPid]);
  // 排序后的模块名列表（渲染用）
  const sortedModNames = useMemo(() => {
    const mods = Object.keys(groupedBOMs);
    if (mods.length <= 1) return mods;
    const orderIdx: Record<string, number> = {};
    bomCatOrder.forEach((c, i) => { orderIdx[c] = i; });
    return [...mods].sort((a, b) => {
      const ca = modCatMap[a] || '未分类';
      const cb = modCatMap[b] || '未分类';
      const ai = orderIdx[ca] ?? 999;
      const bi = orderIdx[cb] ?? 999;
      if (ai !== bi) return ai - bi;
      if (ca !== cb) return ca.localeCompare(cb);
      return a.localeCompare(b);
    });
  }, [groupedBOMs, modCatMap, bomCatOrder]);

  const showBOMHistory = async (row: any) => {
    if (!row?.id) return;
    try {
      setBomHistoryRows(await getDataChangeHistory('bom', row.id));
      setBomHistoryTitle(`${row.part_name || 'BOM器件'} · ${row.part_model || '无型号'}`);
      setBomHistoryOpen(true);
    } catch (e: any) {
      message.error(`加载修改历史失败：${e?.message || '请重试'}`);
    }
  };

  const bomCols = [
    { title: '模块', dataIndex: 'module_name', width: 85, render: (v: string) => v ? <Tag>{v}</Tag> : <Tag color="#ddd">未归类</Tag> },
    { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 80 },
    { title: '名称', dataIndex: 'part_name', width: 180, ellipsis: true, render: (v: string, r: any) => r.is_module_item ? <span><Tag color="orange" style={{ marginRight: 4, fontSize: 10 }}>虚</Tag>{v}</span> : v },
    { title: '型号', dataIndex: 'part_model', width: 150, ellipsis: true },
    { title: '单价', dataIndex: 'part_cost', width: 85, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const, render: (v: number) => v != null ? (Number.isInteger(v) ? v : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')) : '-' },
    { title: '小计', key: 'sub', width: 90, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost || 0) * r.quantity).toFixed(4)}</b> },
    // 占整机 %：降本地图（迷你条 + 热力色 + 排序）——大头一眼可见
    { title: '占整机 %', key: 'pct', width: 96, align: 'right' as const, sorter: (a: any, b: any) => ((a.part_cost || 0) * a.quantity) - ((b.part_cost || 0) * b.quantity), render: (_: any, r: any) => {
      const sub = (r.part_cost || 0) * (r.quantity || 1);
      const pct = bomTotal > 0 ? (sub / bomTotal) * 100 : 0;
      const color = pct >= 10 ? '#FF9500' : pct >= 5 ? '#FFD60A' : '#34C759';
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: '#F0F1F3', overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ width: Math.min(100, pct * 2.2) + '%', height: '100%', background: color, borderRadius: 2, transition: 'width 200ms cubic-bezier(.32,.72,0,1)' }} />
          </div>
          <b style={{ fontSize: 12, color: pct >= 10 ? '#B93400' : '#1D1D1F', fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(1)}%</b>
        </div>
      );
    } },
    { title: '操作', width: 120, render: (_: any, r: any) => (
      <Space size="small">
        <Tooltip title="修改历史"><Button type="link" size="small" icon={<HistoryOutlined />} aria-label="查看修改历史" onClick={() => showBOMHistory(r)} /></Tooltip>
        <Popconfirm title="移除？" onConfirm={async () => { await deleteBOMItem(r.id); loadBOM(selectedPid!); loadCostSnapshots(selectedPid!); scheduleAutoCompare(); }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
      </Space>
    )},
  ];

  const bomInlineFields = ['module_name', 'main_category', 'sub_category', 'part_name', 'part_model', 'part_cost', 'quantity', 'remark'];
  const commitInlineBomCell = async (row: any, field: string, value: number | string | null) => {
    if (!selectedPid || value == null) { setInlineBomCell(null); return; }
    if (field.startsWith('custom:')) {
      const fieldKey = field.slice('custom:'.length);
      let customData: Record<string, unknown> = {};
      try { customData = JSON.parse(row.custom_data || '{}'); } catch { customData = {}; }
      const definition = bomCustomColumns.find((column: any) => column.field_key === fieldKey);
      if (definition?.data_type === 'number' && !Number.isFinite(Number(value))) { setInlineBomCell(null); return; }
      customData[fieldKey] = definition?.data_type === 'number' ? Number(value) : String(value);
      setInlineBomCell(null);
      await updateBOMCustomData(row.id, customData);
      await recordProjectCostSnapshot(selectedPid, 'bom_custom_field_changed', `调整BOM自定义列：${definition?.title || fieldKey}`);
      await Promise.all([loadBOM(selectedPid), loadCostSnapshots(selectedPid)]);
      return;
    }
    const numericField = field === 'part_cost' || field === 'quantity';
    if (numericField && !Number.isFinite(Number(value))) { setInlineBomCell(null); return; }
    const nextCost = field === 'part_cost' ? Number(value) : Number(row.part_cost || 0);
    const nextQuantity = field === 'quantity' ? Number(value) : Number(row.quantity || 0);
    const nextModule = field === 'module_name' ? String(value) : (row.module_name || '');
    const nextRemark = field === 'remark' ? String(value) : (row.remark || '');
    const nextName = field === 'part_name' ? String(value) : (row.part_name || '');
    const nextModel = field === 'part_model' ? String(value) : (row.part_model || '');
    const nextMainCategory = field === 'main_category' ? String(value) : (row.main_category || '');
    const nextSubCategory = field === 'sub_category' ? String(value) : (row.sub_category || '');
    if ((field === 'part_name' || field === 'part_model') && !String(value).trim()) { setInlineBomCell(null); message.warning(`${field === 'part_name' ? '器件名称' : '型号'}不能为空`); return; }
    setInlineBomCell(null);
    try {
      await updateBOMItem(row.id, nextQuantity, nextModule, nextRemark, true, {
        partName: nextName, partModel: nextModel, cost: nextCost,
        mainCategory: nextMainCategory, subCategory: nextSubCategory,
      });
      await Promise.all([loadBOM(selectedPid), loadCostSnapshots(selectedPid)]);
      scheduleAutoCompare();
      message.success('已自动保存');
    } catch (e: any) {
      message.error(`保存失败：${e?.message || '请重试'}`);
      await loadBOM(selectedPid);
    }
  };

  const spreadsheetEditableFields = [...bomInlineFields, ...bomCustomColumns.map((column: any) => `custom:${column.field_key}`)];
  const focusSpreadsheetCell = (row: any, field: string) => {
    setSpreadsheetCell({ id: row.id, field });
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-bom-cell="${row.id}:${CSS.escape(field)}"]`)?.focus(), 0);
  };
  const beginSpreadsheetEdit = (row: any, field: string) => {
    setSpreadsheetCell({ id: row.id, field });
    if (bomInlineFields.includes(field)) {
      setInlineBomCell({ id: row.id, field, value: Number(row[field] || 0) });
      if (field !== 'part_cost' && field !== 'quantity') setInlineBomCell({ id: row.id, field, value: String(row[field] || '') });
    } else if (field.startsWith('custom:')) {
      const key = field.slice('custom:'.length);
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.custom_data || '{}'); } catch { data = {}; }
      setInlineBomCell({ id: row.id, field, value: data[key] == null ? '' : String(data[key]) });
    }
  };
  const moveSpreadsheetCell = (row: any, field: string, direction: -1 | 0 | 1, rowDirection = 0) => {
    const fields = spreadsheetEditableFields;
    const currentField = fields.indexOf(field);
    if (currentField < 0 && rowDirection === 0) return;
    const currentRow = visibleBoms.findIndex((item: any) => item.id === row.id);
    let nextRowIndex = currentRow + rowDirection;
    let nextFieldIndex = currentField < 0 ? 0 : currentField;
    if (rowDirection === 0) {
      nextFieldIndex += direction;
      if (nextFieldIndex >= fields.length) { nextRowIndex += 1; nextFieldIndex = 0; }
      if (nextFieldIndex < 0) { nextRowIndex -= 1; nextFieldIndex = fields.length - 1; }
    }
    nextRowIndex = Math.max(0, Math.min(visibleBoms.length - 1, nextRowIndex));
    nextFieldIndex = Math.max(0, Math.min(fields.length - 1, nextFieldIndex));
    const nextRow = visibleBoms[nextRowIndex];
    const nextField = fields[nextFieldIndex];
    if (nextRow && nextField) focusSpreadsheetCell(nextRow, nextField);
  };
  const handleSpreadsheetCellKeyDown = (event: React.KeyboardEvent, row: any, field: string) => {
    if ((event.key === 'Enter' || event.key === 'F2') && event.target === event.currentTarget) { event.preventDefault(); beginSpreadsheetEdit(row, field); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSpreadsheetCell(row, field, 0, -1); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSpreadsheetCell(row, field, 0, 1); return; }
    if (event.key === 'Tab') { event.preventDefault(); moveSpreadsheetCell(row, field, event.shiftKey ? -1 : 1); }
  };
  const handleSpreadsheetPaste = async (event: React.ClipboardEvent, row: any, field: string) => {
    const raw = event.clipboardData.getData('text/plain');
    if (!raw || (!raw.includes('\t') && !raw.includes('\n'))) return;
    event.preventDefault();
    if (!selectedPid) return;
    const fields = spreadsheetEditableFields;
    const startField = fields.indexOf(field);
    if (startField < 0) return;
    const rowStart = visibleBoms.findIndex((item: any) => item.id === row.id);
    const lines = raw.replace(/\r/g, '').split('\n').filter((line: string) => line.length > 0).map((line: string) => line.split('\t'));
    let touched = 0;
    for (let rowOffset = 0; rowOffset < lines.length; rowOffset++) {
      const target = visibleBoms[rowStart + rowOffset];
      if (!target) break;
      let customData: Record<string, unknown> | null = null;
      try { customData = JSON.parse(target.custom_data || '{}'); } catch { customData = {}; }
      let changed = false;
      let bomChanged = false;
      let customChanged = false;
      let nextCost = Number(target.part_cost || 0);
      let nextQuantity = Number(target.quantity || 0);
      let nextModule = target.module_name || '';
      let nextRemark = target.remark || '';
      let nextName = target.part_name || '';
      let nextModel = target.part_model || '';
      let nextMainCategory = target.main_category || '';
      let nextSubCategory = target.sub_category || '';
      for (let columnOffset = 0; columnOffset < lines[rowOffset].length; columnOffset++) {
        const targetField = fields[startField + columnOffset];
        if (!targetField) break;
        const text = lines[rowOffset][columnOffset].trim();
        if (targetField === 'part_cost' || targetField === 'quantity') {
          const numeric = Number(text.replace(/,/g, ''));
          if (!Number.isFinite(numeric)) continue;
          if (targetField === 'quantity') nextQuantity = numeric;
          else nextCost = numeric;
          bomChanged = true;
          changed = true;
        } else if (bomInlineFields.includes(targetField)) {
          if (targetField === 'module_name') nextModule = text;
          else if (targetField === 'remark') nextRemark = text;
          else if (targetField === 'part_name') nextName = text;
          else if (targetField === 'part_model') nextModel = text;
          else if (targetField === 'main_category') nextMainCategory = text;
          else if (targetField === 'sub_category') nextSubCategory = text;
          bomChanged = true;
          changed = true;
        } else if (targetField.startsWith('custom:') && customData) {
          const key = targetField.slice('custom:'.length);
          const definition = bomCustomColumns.find((column: any) => column.field_key === key);
          if (definition?.data_type === 'number') {
            const numeric = Number(text.replace(/,/g, ''));
            if (!Number.isFinite(numeric)) continue;
            customData[key] = numeric;
          } else customData[key] = text;
          customChanged = true;
          changed = true;
        }
      }
      if (bomChanged) await updateBOMItem(target.id, nextQuantity, nextModule, nextRemark, false, {
        partName: nextName, partModel: nextModel, cost: nextCost,
        mainCategory: nextMainCategory, subCategory: nextSubCategory,
      });
      if (customData && customChanged) await updateBOMCustomData(target.id, customData);
      if (changed) touched++;
    }
    if (touched > 0) {
      await recordProjectCostSnapshot(selectedPid, 'bom_paste', `从剪贴板粘贴 ${touched} 行 BOM`);
      await Promise.all([loadBOM(selectedPid), loadCostSnapshots(selectedPid)]);
      message.success(`已粘贴 ${touched} 行`);
    }
  };

  const getSpreadsheetCellProps = (row: any, field: string, editable = false) => {
    const active = spreadsheetCell?.id === row.id && spreadsheetCell?.field === field;
    return {
      className: `bom-grid-cell${editable ? ' bom-editable-cell' : ''}${active ? ' bom-cell-active' : ''}`,
      tabIndex: editable ? 0 : -1,
      'data-bom-cell': `${row.id}:${field}`,
      onClick: () => setSpreadsheetCell({ id: row.id, field }),
      ...(editable ? {
        onDoubleClick: () => beginSpreadsheetEdit(row, field),
        onKeyDown: (event: React.KeyboardEvent) => handleSpreadsheetCellKeyDown(event, row, field),
        onPaste: (event: React.ClipboardEvent) => handleSpreadsheetPaste(event, row, field),
      } : {}),
    };
  };

  // 模块分组和全量表格共用同一套行内编辑器：双击即可编辑，失焦自动写库。
  const renderInlineBomEditor = (row: any, field: string, value: unknown, fallback?: React.ReactNode) => {
    const editor = inlineBomCell;
    if (!editor || editor.id !== row.id || editor.field !== field) return fallback ?? (value == null || value === '' ? <span className="bom-inline-empty">—</span> : String(value));
    const numeric = field === 'part_cost' || field === 'quantity';
    if (numeric) {
      return <InputNumber autoFocus size="small" min={0} precision={field === 'part_cost' ? 4 : 6} controls={false} value={Number(editor.value || 0)}
        onChange={next => setInlineBomCell(cell => cell ? { ...cell, value: Number(next ?? 0) } : cell)}
        onPressEnter={event => event.currentTarget.blur()}
        onKeyDown={event => { if (event.key === 'Escape') setInlineBomCell(null); }}
        onBlur={() => commitInlineBomCell(row, field, editor.value)} />;
    }
    return <Input autoFocus size="small" value={String(editor.value ?? '')}
      onChange={event => setInlineBomCell(cell => cell ? { ...cell, value: event.target.value } : cell)}
      onPressEnter={event => event.currentTarget.blur()}
      onKeyDown={event => { if (event.key === 'Escape') setInlineBomCell(null); }}
      onBlur={() => commitInlineBomCell(row, field, editor.value)} />;
  };
  const editableBomCols: any[] = bomCols.map((column: any) => {
    const field = String(column.dataIndex || '');
    if (!bomInlineFields.includes(field)) return column;
    const originalRender = column.render;
    return {
      ...column,
      onCell: (row: any) => getSpreadsheetCellProps(row, field, true),
      render: (value: unknown, row: any, index: number) => renderInlineBomEditor(row, field, value, originalRender ? originalRender(value, row, index) : undefined),
    };
  });

  const spreadsheetBaseCols: any[] = [
    { title: '#', key: 'row_no', width: 46, align: 'center' as const, render: (_: any, __: any, index: number) => <span className="bom-row-number">{index + 1}</span> },
    ...editableBomCols,
  ];
  const spreadsheetCustomCols: any[] = bomCustomColumns.map((column: any) => {
    const field = `custom:${column.field_key}`;
    return {
      title: column.title,
      key: `custom_${column.id}`,
      width: 150,
      ellipsis: true,
      onCell: (row: any) => getSpreadsheetCellProps(row, field, true),
      render: (_value: unknown, row: any) => {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(row.custom_data || '{}'); } catch { data = {}; }
        const current = data[column.field_key] == null ? '' : String(data[column.field_key]);
        if (inlineBomCell?.id === row.id && inlineBomCell?.field === field) {
          return column.data_type === 'number'
            ? <InputNumber autoFocus size="small" controls={false} min={0} precision={4} value={Number(inlineBomCell?.value || 0)} onChange={next => setInlineBomCell(cell => cell ? { ...cell, value: Number(next || 0) } : cell)} onPressEnter={event => event.currentTarget.blur()} onBlur={() => commitInlineBomCell(row, field, inlineBomCell?.value ?? current)} />
            : <Input autoFocus size="small" value={String(inlineBomCell?.value ?? '')} onChange={event => setInlineBomCell(cell => cell ? { ...cell, value: event.target.value } : cell)} onPressEnter={event => event.currentTarget.blur()} onBlur={() => commitInlineBomCell(row, field, inlineBomCell?.value ?? current)} />;
        }
        return current || <span className="bom-custom-empty">—</span>;
      },
    };
  });
  const spreadsheetBomCols: any[] = [...spreadsheetBaseCols.slice(0, -1), ...spreadsheetCustomCols, spreadsheetBaseCols[spreadsheetBaseCols.length - 1]];
  // 领域列是全量表格的核心上下文，不能被旧版列设置隐藏，否则表头会出现“模块/子类”错位感。
  const spreadsheetLockedColumns = ['main_category'];
  const selectedReferenceProject = refProjPid ? projects.find((p: any) => p.id === refProjPid) : null;
  const referenceBomTotal = refProjBoms.reduce((sum: number, row: any) => sum + (row.part_cost || 0) * (row.quantity || 0), 0);
  const referenceDelta = bomTotal - referenceBomTotal;

  const negotiationRows = boms.map((row: any) => {
    const refs = modRefMap[row.module_name || '未归类']?.items || [];
    const ref = refs.find((item: any) => item.part_name === row.part_name && (item.part_model || '') === (row.part_model || ''));
    const saving = ref ? Math.max(0, (row.part_cost || 0) - (ref.part_cost || 0)) * (row.quantity || 1) : 0;
    return { row, ref, saving };
  }).sort((a: any, b: any) => b.saving - a.saving || ((b.row.part_cost || 0) * (b.row.quantity || 1)) - ((a.row.part_cost || 0) * (a.row.quantity || 1))).slice(0, 8);

  const copySelectedBomRows = async () => {
    const rows = visibleBoms.filter((row: any) => bomSelKeys.includes(row.id));
    if (rows.length === 0) { message.info('请先选择要复制的行'); return; }
    const header = ['模块', '大类', '子类', '名称', '型号', '单价', '数量', '小计', ...bomCustomColumns.map((column: any) => column.title), '备注'];
    const body = rows.map((row: any) => [
      row.module_name || '未归类', row.main_category || '', row.sub_category || '', row.part_name || '', row.part_model || '',
      Number(row.part_cost || 0).toFixed(4), row.quantity ?? '', ((row.part_cost || 0) * (row.quantity || 0)).toFixed(4),
      ...bomCustomColumns.map((column: any) => { try { return JSON.parse(row.custom_data || '{}')[column.field_key] ?? ''; } catch { return ''; } }), row.remark || '',
    ]);
    try {
      await navigator.clipboard.writeText([header, ...body].map(line => line.join('\t')).join('\n'));
      message.success(`已复制 ${rows.length} 行，可直接粘贴到 Excel`);
    } catch { message.warning('当前环境不允许访问剪贴板，请使用导出 Excel'); }
  };

  const duplicateSelectedBomRows = async () => {
    if (!selectedPid) return;
    const rows = visibleBoms.filter((row: any) => bomSelKeys.includes(row.id) && row.part_id);
    if (rows.length === 0) { message.info('请选择已有器件行（虚拟器件请用“添加器件”新增）'); return; }
    for (const row of rows) {
      await addBOMItem(selectedPid, row.part_id, row.quantity || 1, row.module_name || '', row.remark || '', 0, false, {
        name: row.part_name, model: row.part_model, cost: row.part_cost, mainCategory: row.main_category, subCategory: row.sub_category,
        customData: (() => { try { return JSON.parse(row.custom_data || '{}'); } catch { return {}; } })(),
      });
    }
    await recordProjectCostSnapshot(selectedPid, 'parts_duplicated', `复制 ${rows.length} 行 BOM`);
    setBomSelKeys([]);
    await loadBOM(selectedPid);
    await loadCostSnapshots(selectedPid);
    message.success(`已复制 ${rows.length} 行`);
  };

  const createCustomBomColumn = async () => {
    if (!selectedPid) return;
    const title = customColumnTitle.trim();
    if (!title) { message.warning('请输入列名称'); return; }
    const baseKey = title.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\u4e00-\u9fff-]/g, '_').slice(0, 40) || 'custom';
    const fieldKey = `${baseKey}_${Date.now().toString(36)}`;
    try {
      await saveProjectBOMCustomColumn(selectedPid, { title, fieldKey, dataType: customColumnType, sortOrder: bomCustomColumns.length });
      await loadBOMCustomColumns(selectedPid);
      setCustomColumnTitle(''); setCustomColumnType('text'); setCustomColumnModal(false);
      message.success(`已添加列「${title}」`);
    } catch (e: any) { message.error(String(e?.message || e)); }
  };

  const removeCustomBomColumn = async (column: any) => {
    await deleteProjectBOMCustomColumn(column.id);
    await loadBOMCustomColumns(selectedPid!);
    message.success(`已删除列「${column.title}」`);
  };

  return (
    <div className="projects-page">
      <div className="page-title projects-page-title"><FileTextOutlined /> 项目管理 <span className="projects-page-actions"><Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalOpen(true); }}>新建项目</Button><Button size="small" icon={<TagOutlined />} onClick={() => { setCatModalOpen(true); setNewCatName(''); }}>品类管理</Button></span></div>
        <main className="projects-main projects-main-full">
          {!selectedPid && (
            <div className="project-empty-state content-card"><FileTextOutlined /><h2>选择一个项目开始</h2><p>从左侧项目导航进入 BOM、目标成本、报价和复盘工作区。</p></div>
          )}
          {selectedPid && (
        <div className="content-card projects-detail-card">
          <div className="project-detail-scroll">
          <div className="project-sticky-header">
            <div className="project-detail-title"><span className="eyebrow">当前项目</span><h1>{selectedProject?.code} {selectedProject?.name}</h1><span className="project-detail-spec">{selectedProject?.category || '显示器'} · {selectedProject?.screen_size || '—'} · {selectedProject?.resolution || '—'} · {selectedProject?.refresh_rate || '—'}</span></div>
            <div className="project-detail-actions"><Button size="small" icon={<UploadOutlined />} onClick={() => setActiveTab('tender')}>导入报价</Button><Button size="small" onClick={() => { setEditing(selectedProject); form.setFieldsValue(selectedProject); setModalOpen(true); }}>编辑项目</Button><Button type="primary" size="small" icon={<PlusOutlined />} onClick={async () => { setAllParts(await getParts('', '', '')); setBomEdit(null); bomForm.resetFields(); bomForm.setFieldsValue({ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }); setBomModal(true); }}>新增器件</Button></div>
          </div>
          <div className="project-summary-strip"><span><small>BOM成本</small><b>¥{bomTotal.toFixed(2)}</b></span><span><small>整机成本</small><b>¥{wholeMachineCost.toFixed(2)}</b></span><span><small>平台 + 利润</small><b>{selectedProject?.platform_fee_rate || 0}% + {selectedProject?.profit_rate || 0}%</b></span><span><small>器件</small><b>{boms.length} 项</b></span></div>
          <div className="module-target-section"><div className="section-heading"><div><span className="eyebrow">成本控制</span><h2>领域目标达成</h2><small className="section-caption">按 BOM 大类汇总实际成本，与领域目标逐项核对</small></div><Button size="small" type="link" onClick={() => setDomainFocus(null)}>清除筛选</Button></div><div className="module-target-grid">{Object.entries(domainSummary).map(([name, cost]) => { const target = targets.find((t: any) => t.domain === name)?.target_cost || 0; const diff = target ? cost - target : 0; const pct = target ? Math.min(100, (cost / target) * 100) : 0; const good = target > 0 && diff <= 0; return <button key={name} className={`module-target-card ${domainFocus === name ? 'is-selected' : ''}`} onClick={() => setDomainFocus(domainFocus === name ? null : name)}><div className="module-target-meta"><b>{name}</b><span>{target ? (good ? `达成，可降 ¥${Math.abs(diff).toFixed(2)}` : `超目标 ¥${diff.toFixed(2)}`) : '未设目标'}</span></div><div className="module-target-values"><strong>¥{cost.toFixed(2)}</strong><small>{target ? `目标 ¥${target.toFixed(2)}` : '目标 —'}</small></div><div className="module-target-track"><i style={{ width: `${pct}%`, background: target ? (good ? '#28A56A' : '#E45A5A') : '#94A3B8' }} /><em style={{ left: target ? '100%' : '0%' }} /></div></button>; })}</div></div>
          {/* AI 体检条（规则驱动，点击问题直达对应 tab） */}
          {healthIssues.length > 0 && (
            <div style={{ marginBottom: 14, border: healthIssues.some(i => i.level === 'danger') ? '1.5px solid #FECACA' : '1px solid #FDE68A', borderRadius: 10, padding: '10px 14px', background: healthIssues.some(i => i.level === 'danger') ? '#FFF9F9' : '#FFFBEB' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <RobotOutlined style={{ color: '#0A84FF' }} />
                <b style={{ fontSize: 13 }}>AI 体检</b>
                <Tag color={healthIssues.some(i => i.level === 'danger') ? 'red' : 'orange'}>{healthIssues.length} 项待关注</Tag>
                <span style={{ fontSize: 11.5, color: '#94A3B8', marginLeft: 4 }}>规则自动检查：BOM 完整性 · 目标达成 · 快照异动 · 同类报价</span>
                <Button size="small" style={{ marginLeft: 'auto' }} icon={<RobotOutlined />} loading={healthAiLoading} onClick={runHealthSummary}>AI 小结</Button>
              </div>
              {healthAiSummary && (
                <div style={{ marginBottom: 8, padding: '8px 12px', background: '#F0F7FF', border: '1px solid #BFDBFE', borderRadius: 8, fontSize: 12.5, color: '#1E40AF', lineHeight: 1.6 }}>
                  <RobotOutlined style={{ marginRight: 6 }} />{healthAiSummary}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {healthIssues.map((i, idx) => (
                  <div key={idx} onClick={() => i.actionTab && setActiveTab(i.actionTab)}
                    title={i.actionTab ? '点击定位' : ''}
                    style={{ border: i.level === 'danger' ? '1px solid #FECACA' : i.level === 'warn' ? '1px solid #FDE68A' : '1px solid #BFDBFE', background: i.level === 'danger' ? '#FFF5F5' : i.level === 'warn' ? '#FFFBEB' : '#F0F7FF', borderRadius: 8, padding: '6px 10px', cursor: i.actionTab ? 'pointer' : 'default', fontSize: 12.5, maxWidth: 380, transition: 'box-shadow 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
                    <b style={{ color: i.level === 'danger' ? '#DC2626' : i.level === 'warn' ? '#B45309' : '#1E40AF', fontSize: 12.5 }}>{i.title}</b>
                    <div style={{ color: '#6B7280', fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>{i.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Row className="project-legacy-summary" gutter={14} style={{ marginBottom: 14 }}>
            <Col span={5}><Card size="small"><Statistic title="BOM总成本" value={bomTotal} precision={2} prefix="¥" valueStyle={{ color: '#CF0A2C' }} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="整机成本" value={wholeMachineCost} precision={2} prefix="¥" valueStyle={{ color: '#2563EB' }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="费率" value={`${selectedProject?.platform_fee_rate || 0}% + ${selectedProject?.profit_rate || 0}%`} valueStyle={{ fontSize: 18 }} /></Card></Col>
            <Col span={10}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(moduleSummary).map(([name, cost]) => (
                  <Tag key={name} color="blue" style={{ fontSize: 12, padding: '4px 10px' }}>{name}: ¥{cost.toFixed(2)}</Tag>
                ))}
              </div>
            </Col>
          </Row>
          <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
            {
              key: 'tender', label: <span><AimOutlined /> 招标工作台</span>, children: <TenderWorkspace projectId={selectedPid!} project={selectedProject} />,
            },
            {
              key: 'bom', label: <span><InboxOutlined /> BOM清单 ({boms.length}件)</span>, children: (
                <div className="bom-tab-layout">
                  <div className="bom-workspace-main">
                  <div className="bom-command-bar" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <Space>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={async () => { setAllParts(await getParts('', '', '')); setBomEdit(null); setPreviewModItems([]); bomForm.resetFields(); bomForm.setFieldsValue({ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }); setBomModal(true); }}>添加器件</Button>
                      <Upload beforeUpload={handleImportFile} showUploadList={false} accept=".xlsx,.xls"><Button size="small" icon={<UploadOutlined />}>导入</Button></Upload>
                      <Button size="small" icon={<DownloadOutlined />} onClick={() => { const data = boms.map(b => ({ 模块: b.module_name, 大类: b.main_category, 子类: b.sub_category, 器件名称: b.part_name, 型号: b.part_model, 单价: b.part_cost, 数量: b.quantity, 小计: (b.part_cost || 0) * b.quantity, ...(() => { try { const d = JSON.parse(b.custom_data || '{}'); return Object.fromEntries(bomCustomColumns.map((column: any) => [column.title, d[column.field_key] ?? ''])); } catch { return {}; } })(), 备注: b.remark })); const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'BOM'); XLSX.writeFile(wb, `BOM_${projects.find(p => p.id === selectedPid)?.code || 'export'}.xlsx`); message.success('已导出'); }}>导出</Button>
                      <Input size="small" allowClear value={bomSearch} onChange={e => setBomSearch(e.target.value)} placeholder="搜索器件 / 型号 / 规格" style={{ width: 210 }} />
                      <Segmented size="small" value={bomTableMode} onChange={v => { const mode = v as 'module' | 'flat'; setBomTableMode(mode); if (mode !== 'flat') setBomFullscreen(false); }} options={[{ label: '模块分组', value: 'module' }, { label: '全量表格', value: 'flat' }]} />
                      {bomTableMode === 'flat' && <Tooltip title={bomFullscreen ? '退出 BOM 全屏（Esc）' : '将 BOM 表格铺满窗口（Esc 退出）'}><Button size="small" icon={bomFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => setBomFullscreen(value => !value)}>{bomFullscreen ? '退出全屏' : '全屏'}</Button></Tooltip>}
                      <Button size="small" icon={<BulbOutlined />} onClick={() => setNegotiationOpen(true)}>议价机会</Button>
                      {bomTableMode === 'flat' && <Tooltip title="复制选中的 BOM 行为制表符文本，可直接粘贴到 Excel"><Button size="small" icon={<CopyOutlined />} onClick={copySelectedBomRows}>复制选中</Button></Tooltip>}
                      {bomTableMode === 'flat' && <Button size="small" icon={<PlusOutlined />} onClick={() => setCustomColumnModal(true)}>添加列</Button>}
                    </Space>
                    {bomSelKeys.length > 0 && (
                      <Space>
                        <Tag color="blue">{bomSelKeys.length} 项选中</Tag>
                        <Tag color="red">合计: ¥{boms.filter(b => bomSelKeys.includes(b.id)).reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0).toFixed(2)}</Tag>
                        <Popconfirm title={`删除选中 ${bomSelKeys.length} 项？`} onConfirm={async () => { for (const id of bomSelKeys) await deleteBOMItem(Number(id), false); await recordProjectCostSnapshot(selectedPid!, 'parts_deleted', `批量删除 ${bomSelKeys.length} 个BOM项`); setBomSelKeys([]); loadBOM(selectedPid!); loadCostSnapshots(selectedPid!); scheduleAutoCompare(); message.success('已删除'); }}>
                          <Button size="small" danger icon={<DeleteOutlined />}>批量删除</Button>
                        </Popconfirm>
                        {bomTableMode === 'flat' && <Button size="small" icon={<CopyOutlined />} onClick={duplicateSelectedBomRows}>复制行</Button>}
                      </Space>
                    )}
                    <ColumnSettingsButton tableId={bomTableMode === 'flat' ? 'bom_spreadsheet_v2' : 'bom_module_detail'} columns={bomTableMode === 'flat' ? spreadsheetBomCols : bomCols} lockKeys={bomTableMode === 'flat' ? spreadsheetLockedColumns : undefined} />
                    {/* 参照项目：全局选择一次，模块卡内展示当前/参照/差异，避免每个模块重复放下拉框 */}
                    <div className={`bom-reference-picker ${refProjPid ? 'has-reference' : ''}`}>
                      <span className="bom-reference-picker-label">参照项目</span>
                      <Select
                        size="small"
                        allowClear
                        aria-label="选择参照项目"
                        placeholder="选择项目进行对比"
                        style={{ width: 190 }}
                        value={refProjPid || undefined}
                        onChange={v => loadRefProj(v || null)}
                        options={projects.filter((p: any) => p.id !== selectedPid).map((p: any) => ({ label: `[${p.code}] ${p.name}${p.project_type === '已完成' ? ' · 已完成' : ''}`, value: p.id }))}
                      />
                      {selectedReferenceProject && <div className="bom-reference-overview"><span>{selectedReferenceProject.code || selectedReferenceProject.name}</span><b>¥{referenceBomTotal.toFixed(2)}</b><em className={referenceDelta > 0 ? 'is-over' : referenceDelta < 0 ? 'is-under' : ''}>{referenceDelta > 0 ? '+' : ''}¥{referenceDelta.toFixed(2)}</em></div>}
                    </div>
                  </div>
                  {bomTableMode === 'flat' && <div className="bom-spreadsheet-hint">连续表格模式 · 双击或 Enter/F2 编辑 · Tab/方向键移动 · 可从 Excel 粘贴多行 · 横向滚动查看完整字段</div>}
                  {bomTableMode === 'flat' ? (
                    <>
                      <DataTable
                        tableId="bom_spreadsheet_v2"
                        hideToolbar
                        dataSource={visibleBoms}
                        columns={spreadsheetBomCols}
                        lockKeys={spreadsheetLockedColumns}
                        rowKey="id"
                        size="small"
                        pagination={false}
                        scroll={{ x: 1240, y: bomFullscreen ? 'calc(100vh - 160px)' : 560 }}
                        rowSelection={{ fixed: false, selectedRowKeys: bomSelKeys, onChange: keys => setBomSelKeys(keys) }}
                      />
                      <div className="bom-spreadsheet-statusbar"><span>显示 {visibleBoms.length} / {boms.length} 行</span><span>当前合计 <b>¥{visibleBoms.reduce((sum: number, row: any) => sum + (row.part_cost || 0) * (row.quantity || 0), 0).toFixed(4)}</b></span><span>已选 {bomSelKeys.filter(id => visibleBoms.some((row: any) => row.id === id)).length} 行</span><span className="bom-spreadsheet-status-note">双击或 Enter/F2 编辑 · Tab/方向键移动 · 可粘贴 Excel 数据</span></div>
                    </>
                  ) : sortedModNames.map((modName: string) => {
                    const items = groupedBOMs[modName];
                    const modTotal = items.reduce((s: number, b: any) => s + (b.part_cost || 0) * b.quantity, 0);
                    const ref = modRefMap[modName];
                    const refItems = ref?.items || [];
                    const refTotal = refItems.reduce((s: number, b: any) => s + (b.part_cost || 0) * b.quantity, 0);
                    // Compute extended columns
                    const hasRef = ref && refItems.length > 0;
                    // 参考匹配：同模块 + 名称完全相等 + 型号完全相等（避免跨模块/模糊匹配错位，
                    // 与导入复用的匹配口径一致，确保参考数据与参照项目页面显示完全同一套数）
                    const findRef = (r: any) => refItems.find((rb: any) =>
                      (rb.module_name || '未归类') === (r.module_name || '未归类')
                      && rb.part_name === r.part_name
                      && (rb.part_model || '') === (r.part_model || ''));
                    const refProject = ref?.pid ? projects.find((p: any) => p.id === ref.pid) : null;
                    const refDelta = modTotal - refTotal;
                    const extCols = hasRef ? [
                      ...editableBomCols.slice(0, -1),
                      { title: '参考单价', width: 85, align: 'right' as const, render: (_: any, r: any) => {
                        const rref = findRef(r);
                        return rref ? <span style={{ color: '#2563EB', fontSize: 12, fontFamily: 'monospace' }}>¥{Number(rref.part_cost).toFixed(4)}</span> : <span style={{ color: '#DDD', fontSize: 12 }}>—</span>;
                      }},
                      { title: '参考小计', width: 90, align: 'right' as const, render: (_: any, r: any) => {
                        const rref = findRef(r);
                        const refSub = rref ? (rref.part_cost || 0) * rref.quantity : 0;
                        const ourSub = (r.part_cost || 0) * r.quantity;
                        return rref ? <span style={{ color: refSub > ourSub ? '#EF4444' : '#10B981', fontSize: 12, fontWeight: 600 }}>¥{refSub.toFixed(4)}</span> : <span style={{ color: '#DDD', fontSize: 12 }}>—</span>;
                      }},
                      { title: '差异', width: 80, align: 'right' as const, render: (_: any, r: any) => {
                        const rref = findRef(r);
                        if (!rref) return <span style={{ color: '#DDD', fontSize: 12 }}>—</span>;
                        const diff = ((rref.part_cost || 0) * rref.quantity) - ((r.part_cost || 0) * r.quantity);
                        return <span style={{ color: diff > 0 ? '#EF4444' : diff < 0 ? '#10B981' : '#666', fontWeight: 600, fontSize: 12 }}>{diff >= 0 ? '+' : ''}¥{diff.toFixed(4)}</span>;
                      }},
                      editableBomCols[editableBomCols.length - 1],
                    ] : editableBomCols;
                    return (
                      <div key={modName} id={`module-${modName}`} className="bom-module-card" style={{ scrollMarginTop: 80 }}>
                        <div className="bom-module-header">
                          <div className="bom-module-heading">
                            <div className="bom-module-name"><b>{modName}</b><span>{items.length} 件</span></div>
                            <div className="bom-module-metrics">
                              <span><small>当前小计</small><strong>¥{modTotal.toFixed(4)}</strong></span>
                              {hasRef ? <>
                                <i />
                                <span><small>参照小计 · {refProject?.code || '参照项目'}</small><strong className="is-reference">¥{refTotal.toFixed(4)}</strong></span>
                                <span className={`bom-module-delta ${refDelta > 0 ? 'is-over' : 'is-under'}`}><small>{refDelta > 0 ? '高于参照' : refDelta < 0 ? '低于参照' : '与参照一致'}</small><strong>{refDelta > 0 ? '+' : ''}¥{refDelta.toFixed(4)}</strong></span>
                              </> : refProjPid ? <span className="bom-module-no-reference"><small>{projects.find((p: any) => p.id === refProjPid)?.code || '参照项目'}</small><strong>暂无此模块</strong></span> : null}
                            </div>
                          </div>
                          <Space size={4}>
                            {/* 跨项目报价比对（AI 疑似同物料识别 + 人工确认沉淀） */}
                            <Tooltip title="跨项目对比该模块报价（AI 识别疑似同物料，需配置本地模型）">
                              <Badge count={unreadMods.has(modName) ? 1 : 0} size="small" offset={[-4, 2]}>
                                <Button size="small" icon={<BarChartOutlined />} onClick={() => openModuleCompare(modName)}>跨项目比对</Button>
                              </Badge>
                            </Tooltip>
                            {/* 从参照项目导入该模块器件（做加减法：加模块） */}
                            {refProjPid && (
                              <Tooltip title={`从参照项目导入「${modName}」器件（已存在的不重复添加）`}>
                                <Button size="small" icon={<CopyOutlined />} onClick={() => importRefModule(modName)}>导入参考</Button>
                              </Tooltip>
                            )}
                            <Dropdown
                              trigger={['click']}
                              menu={{
                                items: [
                                  { key: 'global', label: refProjPid ? `跟随全局参照${selectedReferenceProject?.code ? ` · ${selectedReferenceProject.code}` : ''}` : '跟随全局参照（未选择）', disabled: !refProjPid },
                                  { key: 'clear', label: '清除本模块参照' },
                                  { type: 'divider' as const },
                                  ...projects.filter((p: any) => p.id !== selectedPid).map((p: any) => ({ key: `project:${p.id}`, label: `指定：${p.code || p.name}` })),
                                ],
                                onClick: ({ key }: { key: string }) => {
                                  if (key === 'global') loadModRef(modName, refProjPid || 0);
                                  else if (key === 'clear') loadModRef(modName, 0);
                                  else if (key.startsWith('project:')) loadModRef(modName, Number(key.slice('project:'.length)));
                                },
                              }}
                            >
                              <Button size="small" aria-label={`设置${modName}的参照项目`}>参照设置</Button>
                            </Dropdown>
                          </Space>
                        </div>
                        <DataTable tableId="bom_module_detail" hideToolbar dataSource={items} columns={extCols} rowKey="id" size="small" pagination={false} scroll={{ x: 1100 }}
                          rowSelection={{ selectedRowKeys: bomSelKeys.filter(k => items.some(i => i.id === k)), onChange: (keys) => { const others = bomSelKeys.filter(k => !items.some(i => i.id === k)); setBomSelKeys([...others, ...keys]); } }}
                          summary={() => (
                            <Table.Summary.Row>
                              <Table.Summary.Cell index={0} colSpan={extCols.length + 1}>
                                <div className="bom-module-summary">
                                  <b>{modName} 合计</b>
                                  <span>当前 <strong>¥{modTotal.toFixed(4)}</strong></span>
                                  {hasRef && <><span>参照 <strong className="is-reference">¥{refTotal.toFixed(4)}</strong></span><span className={refDelta > 0 ? 'is-over' : 'is-under'}>差异 <strong>{refDelta > 0 ? '+' : ''}¥{refDelta.toFixed(4)}</strong></span></>}
                                </div>
                              </Table.Summary.Cell>
                            </Table.Summary.Row>
                          )} />
                      </div>
                    );
                  })}
                  {boms.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无BOM数据</div>}
                  </div>
                </div>
              ),
            },
            {
              key: 'analysis', label: <span><DollarOutlined /> 成本分析</span>, children: (() => {
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
                  tooltip: chartTooltip('axis'),
                  grid: { left: 100, right: 40, top: 5, bottom: 5 },
                  xAxis: { type: 'value', name: '¥', axisLabel: { color: chartTextMuted(), fontSize: 11 }, splitLine: { lineStyle: { color: chartSplitLine() } } },
                  yAxis: { type: 'category', data: modData.map(d => d.name), axisLabel: { fontSize: 11, color: chartTextMuted() }, inverse: true, axisLine: { show: false }, axisTick: { show: false } },
                  series: [{ type: 'bar', barWidth: '55%', data: modData.map(d => ({ value: d.value, itemStyle: { color: barGradient('#0A84FF'), borderRadius: [0, 8, 8, 0] } })), label: { show: true, position: 'right', formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 10, color: chartTextMuted() } }],
                };

                const domainBarOption = {
                  tooltip: chartTooltip('axis'),
                  legend: { data: ['实际成本', '目标成本'], top: 0, right: 0, orient: 'horizontal', textStyle: { color: chartTextMuted() } },
                  grid: { left: 80, right: 40, top: 5, bottom: 30 },
                  xAxis: { type: 'category', data: [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort(), ...chartAxisStyle(10, { rotate: 25 }) },
                  yAxis: { type: 'value', name: '¥', ...chartAxisStyle() },
                  color: ['#0A84FF', '#94A3B8'],
                  series: [
                    { name: '实际成本', type: 'bar', barGap: '10%', data: [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort().map(c => byDomain[c] || 0), itemStyle: { borderRadius: [8, 8, 0, 0], color: (p: any) => {
                        // 超过目标 → 红色渐变，达标 → 蓝色渐变
                        const cat = [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort()[p.dataIndex];
                        const target = targetMap[cat];
                        const actual = p.value;
                        return target && actual > target ? barGradient('#FF375F') : barGradient('#0A84FF');
                      } } },
                    { name: '目标成本', type: 'bar', data: [...new Set([...Object.keys(byDomain), ...Object.keys(targetMap)])].sort().map(c => targetMap[c] || 0), itemStyle: { borderRadius: [8, 8, 0, 0], color: '#94A3B8' } },
                  ],
                };

                return (
                  <div>
                    <Row gutter={14} style={{ marginBottom: 14 }}>
                      <Col span={12}><div className="content-card" style={{ margin: 0, padding: 12 }}><div className="card-header"><h3>模块成本分布</h3></div><ReactECharts echarts={echarts} option={modBarOption} style={{ height: 280, maxHeight: 400 }} /></div></Col>
                      <Col span={12}><div className="content-card" style={{ margin: 0, padding: 12 }}><div className="card-header"><h3>领域成本 vs 目标</h3></div><ReactECharts echarts={echarts} option={domainBarOption} style={{ height: 280 }} /></div></Col>
                    </Row>
                    <TargetAllocationPanel projectId={selectedPid!} />
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
                          { title: '领域', dataIndex: 'domain', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                          { title: '实际成本(¥)', dataIndex: 'actual', width: 120, align: 'right' as const, render: (v: number) => <b>{v.toFixed(2)}</b> },
                          { title: '目标成本(¥)', dataIndex: 'target', width: 120, align: 'right' as const, render: (v: number) => v > 0 ? <span style={{ color: '#2563EB' }}>{v.toFixed(2)}</span> : <span style={{ color: '#CCC' }}>未设定</span> },
                          { title: '差异(¥)', dataIndex: 'diff', width: 110, align: 'right' as const, render: (v: number, r: any) => r.target > 0 ? <span style={{ color: v <= 0 ? '#10B981' : '#EF4444', fontWeight: 600 }}>{v.toFixed(2)}</span> : <span style={{ color: '#CCC' }}>—</span> },
                          { title: '达成率', dataIndex: 'rate', width: 90, align: 'center' as const, render: (v: number, r: any) => r.target > 0 ? <Tag color={v >= 100 ? 'green' : 'red'}>{v}%</Tag> : <span style={{ color: '#CCC' }}>—</span> },
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
              key: 'cost-history', label: <span><LineChartOutlined /> 整机成本历史 ({costSnapshots.length})</span>, children: (() => {
                const sortedSnapshots = [...costSnapshots].sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id || 0) - (a.id || 0));
                return (
                  <div>
                    <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Space>
                        <Tag color="red">当前BOM: ¥{bomTotal.toFixed(2)}</Tag>
                        <Tag color="blue">当前整机: ¥{wholeMachineCost.toFixed(2)}</Tag>
                        <Tag>公式: BOM × (1 + {selectedProject?.platform_fee_rate || 0}% + {selectedProject?.profit_rate || 0}%)</Tag>
                      </Space>
                      <Space>
                        {snapshotSelKeys.length > 0 && (
                          <>
                            <Tag color="blue">{snapshotSelKeys.length} 项选中</Tag>
                            {(snapshotSelKeys.length === 2 || snapshotSelKeys.length === 3) && (
                              <Button
                                size="small"
                                type="primary"
                                onClick={async () => {
                                  const selectedSnaps = costSnapshots.filter(s => snapshotSelKeys.includes(s.id))
                                    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

                                  if (selectedSnaps.length === 2) {
                                    // 详细BOM对比
                                    const [snap1, snap2] = selectedSnaps;
                                    const bom1 = await getSnapshotBOMDetail(selectedPid!, snap1.created_at);
                                    const bom2 = await getSnapshotBOMDetail(selectedPid!, snap2.created_at);

                                    // 建立器件映射
                                    const map1: Record<string, any> = {};
                                    const map2: Record<string, any> = {};
                                    bom1.forEach(item => {
                                      const key = `${item.part_name}_${item.part_model}`;
                                      map1[key] = item;
                                    });
                                    bom2.forEach(item => {
                                      const key = `${item.part_name}_${item.part_model}`;
                                      map2[key] = item;
                                    });

                                    const allKeys = new Set([...Object.keys(map1), ...Object.keys(map2)]);
                                    const changes: any[] = [];

                                    allKeys.forEach(key => {
                                      const item1 = map1[key];
                                      const item2 = map2[key];

                                      if (item1 && !item2) {
                                        // 新增的器件
                                        changes.push({
                                          type: 'added',
                                          name: item1.part_name,
                                          model: item1.part_model,
                                          module: item1.module_name || '未归类',
                                          cost1: item1.cost,
                                          qty1: item1.quantity,
                                          total1: item1.cost * item1.quantity,
                                        });
                                      } else if (!item1 && item2) {
                                        // 删除的器件
                                        changes.push({
                                          type: 'removed',
                                          name: item2.part_name,
                                          model: item2.part_model,
                                          module: item2.module_name || '未归类',
                                          cost2: item2.cost,
                                          qty2: item2.quantity,
                                          total2: item2.cost * item2.quantity,
                                        });
                                      } else if (item1 && item2) {
                                        const costDiff = item1.cost - item2.cost;
                                        const qtyDiff = item1.quantity - item2.quantity;
                                        const totalDiff = (item1.cost * item1.quantity) - (item2.cost * item2.quantity);

                                        if (Math.abs(costDiff) > 0.0001 || qtyDiff !== 0) {
                                          changes.push({
                                            type: 'changed',
                                            name: item1.part_name,
                                            model: item1.part_model,
                                            module: item1.module_name || '未归类',
                                            cost1: item1.cost,
                                            cost2: item2.cost,
                                            costDiff,
                                            qty1: item1.quantity,
                                            qty2: item2.quantity,
                                            qtyDiff,
                                            total1: item1.cost * item1.quantity,
                                            total2: item2.cost * item2.quantity,
                                            totalDiff,
                                          });
                                        }
                                      }
                                    });

                                    // 构建对比内容（含 AI 变化解释，本地模型可选）
                                    let aiText = '';
                                    let aiLoading = false;
                                    const renderContent = () => (
                                      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                                        {/* AI 变化解释 */}
                                        <div style={{ marginBottom: 14, padding: '10px 12px', background: '#F0F7FF', border: '1px solid #BFDBFE', borderRadius: 8 }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                            <RobotOutlined style={{ color: '#0A84FF' }} />
                                            <b style={{ fontSize: 12.5 }}>AI 变化解释</b>
                                            <Button size="small" loading={aiLoading} onClick={runExplain} style={{ marginLeft: 'auto' }}>{aiText ? '重新生成' : '生成解释'}</Button>
                                          </div>
                                          {aiText
                                            ? <div style={{ fontSize: 12.5, color: '#1E40AF', lineHeight: 1.7 }}>{aiText}</div>
                                            : <div style={{ fontSize: 11.5, color: '#94A3B8' }}>由本地模型分析下方 BOM 差异（全程本地无云端调用）；未配置 Ollama 可跳过，规则对比已完整展示</div>}
                                        </div>
                                        <div style={{ marginBottom: 16 }}>
                                          <div><b>快照1:</b> {snap1.created_at}</div>
                                          <div><b>快照2:</b> {snap2.created_at}</div>
                                          <div style={{ marginTop: 8 }}>
                                            <b>整体变化:</b>
                                            <div>BOM成本: ¥{Number(snap2.bom_cost || 0).toFixed(2)} → ¥{Number(snap1.bom_cost || 0).toFixed(2)}
                                              <span style={{ color: (Number(snap1.bom_cost || 0) - Number(snap2.bom_cost || 0)) > 0 ? '#EF4444' : '#10B981', marginLeft: 8 }}>
                                                {(Number(snap1.bom_cost || 0) - Number(snap2.bom_cost || 0)) > 0 ? '+' : ''}
                                                ¥{(Number(snap1.bom_cost || 0) - Number(snap2.bom_cost || 0)).toFixed(2)}
                                              </span>
                                            </div>
                                          </div>
                                        </div>

                                        {changes.length === 0 ? (
                                          <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>无BOM变化</div>
                                        ) : (
                                          <div>
                                            {changes.filter(c => c.type === 'added').length > 0 && (
                                              <div style={{ marginBottom: 16 }}>
                                                <h4 style={{ color: '#10B981' }}><CheckCircleOutlined /> 新增器件 ({changes.filter(c => c.type === 'added').length})</h4>
                                                {changes.filter(c => c.type === 'added').map((c, i) => (
                                                  <div key={i} style={{ padding: '8px', background: '#F0FDF4', borderLeft: '3px solid #10B981', marginBottom: 6, fontSize: 12 }}>
                                                    <div><b>{c.name}</b> ({c.model}) - {c.module}</div>
                                                    <div>单价: ¥{c.cost1.toFixed(2)} × 数量: {c.qty1} = <b>¥{c.total1.toFixed(2)}</b></div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}

                                            {changes.filter(c => c.type === 'removed').length > 0 && (
                                              <div style={{ marginBottom: 16 }}>
                                                <h4 style={{ color: '#EF4444' }}><CloseCircleOutlined /> 删除器件 ({changes.filter(c => c.type === 'removed').length})</h4>
                                                {changes.filter(c => c.type === 'removed').map((c, i) => (
                                                  <div key={i} style={{ padding: '8px', background: '#FEF2F2', borderLeft: '3px solid #EF4444', marginBottom: 6, fontSize: 12 }}>
                                                    <div><b>{c.name}</b> ({c.model}) - {c.module}</div>
                                                    <div>单价: ¥{c.cost2.toFixed(2)} × 数量: {c.qty2} = <b>¥{c.total2.toFixed(2)}</b></div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}

                                            {changes.filter(c => c.type === 'changed').length > 0 && (
                                              <div style={{ marginBottom: 16 }}>
                                                <h4 style={{ color: '#F59E0B' }}><ThunderboltOutlined /> 变化器件 ({changes.filter(c => c.type === 'changed').length})</h4>
                                                {changes.filter(c => c.type === 'changed').map((c, i) => (
                                                  <div key={i} style={{ padding: '8px', background: '#FFFBEB', borderLeft: '3px solid #F59E0B', marginBottom: 6, fontSize: 12 }}>
                                                    <div><b>{c.name}</b> ({c.model}) - {c.module}</div>
                                                    {Math.abs(c.costDiff) > 0.0001 && (
                                                      <div>
                                                        单价: ¥{c.cost2.toFixed(2)} → ¥{c.cost1.toFixed(2)}
                                                        <span style={{ color: c.costDiff > 0 ? '#EF4444' : '#10B981', marginLeft: 8 }}>
                                                          ({c.costDiff > 0 ? '+' : ''}¥{c.costDiff.toFixed(2)})
                                                        </span>
                                                      </div>
                                                    )}
                                                    {c.qtyDiff !== 0 && (
                                                      <div>
                                                        数量: {c.qty2} → {c.qty1}
                                                        <span style={{ color: c.qtyDiff > 0 ? '#EF4444' : '#10B981', marginLeft: 8 }}>
                                                          ({c.qtyDiff > 0 ? '+' : ''}{c.qtyDiff})
                                                        </span>
                                                      </div>
                                                    )}
                                                    <div>
                                                      小计: ¥{c.total2.toFixed(2)} → ¥{c.total1.toFixed(2)}
                                                      <span style={{ color: c.totalDiff > 0 ? '#EF4444' : '#10B981', marginLeft: 8, fontWeight: 'bold' }}>
                                                        ({c.totalDiff > 0 ? '+' : ''}¥{c.totalDiff.toFixed(2)})
                                                      </span>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );

                                    const modal = Modal.info({
                                      title: 'BOM详细对比',
                                      width: 700,
                                      content: renderContent(),
                                    });
                                    // AI 解释：把差异清单发给本地模型，流式更新弹窗
                                    const runExplain = async () => {
                                      if (aiLoading) return;
                                      aiLoading = true;
                                      aiText = '';
                                      modal.update({ content: renderContent() });
                                      try {
                                        const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
                                        const model = await getSetting('local_ai_model', '');
                                        if (!model) throw new Error('未配置本地模型');
                                        const lines: string[] = [];
                                        [...changes].sort((a: any, b: any) => Math.abs(b.totalDiff ?? b.total1 ?? -(b.total2 || 0)) - Math.abs(a.totalDiff ?? a.total1 ?? -(a.total2 || 0))).slice(0, 8).forEach((c: any) => {
                                          if (c.type === 'added') lines.push(`新增 ${c.name}(${c.model}) ${c.module}：¥${c.cost1}×${c.qty1}=¥${c.total1.toFixed(2)}`);
                                          else if (c.type === 'removed') lines.push(`删除 ${c.name}(${c.model}) ${c.module}：减少 ¥${c.total2.toFixed(2)}`);
                                          else lines.push(`变化 ${c.name}(${c.model}) ${c.module}：小计 ¥${c.total2.toFixed(2)}→¥${c.total1.toFixed(2)}（${c.totalDiff > 0 ? '+' : ''}¥${c.totalDiff.toFixed(2)}）`);
                                        });
                                        const userPrompt = `项目 ${selectedProject?.code || ''} 成本快照对比（${snap2.created_at} → ${snap1.created_at}）：BOM ¥${Number(snap2.bom_cost || 0).toFixed(2)} → ¥${Number(snap1.bom_cost || 0).toFixed(2)}\n主要变化清单：\n${lines.join('\n')}`;
                                        let full = '';
                                        await new Promise<void>((resolve, reject) => {
                                          startOllamaStream(url, model,
                                            [{ role: 'system', content: '你是成本管理助手。根据 BOM 快照对比的变化清单，用 2-3 句话说明这次成本变化的主要原因（哪些器件/模块驱动了变化、金额多少），语气客观，不要列举。' },
                                             { role: 'user', content: userPrompt }],
                                            t => { full += t; aiText = full; modal.update({ content: renderContent() }); },
                                            () => {}, () => resolve(), e => reject(new Error(e)),
                                            { endpoint: 'native', json: false, think: false, num_predict: 4096, temperature: 0.3 },
                                          );
                                        });
                                        logLocalAICall({
                                          request_type: 'snapshot_explain',
                                          material_name: selectedProject?.code || '',
                                          system_prompt: '你是成本管理助手。根据 BOM 快照对比的变化清单，用 2-3 句话说明这次成本变化的主要原因（哪些器件/模块驱动了变化、金额多少），语气客观，不要列举。',
                                          user_prompt: '项目 ' + (selectedProject?.code || '') + ' 成本快照对比',
                                          response_summary: full.slice(0, 200),
                                          success: true,
                                          model_name: model,
                                        });
                                      } catch (e: any) {
                                        aiText = '本地模型不可用，无法生成解释（规则对比已完整展示上方）。';
                                      }
                                      aiLoading = false;
                                      modal.update({ content: renderContent() });
                                    };
                                  } else {
                                    // 3个快照简单对比
                                    let compareText = '快照对比:\n\n';
                                    selectedSnaps.forEach((snap, idx) => {
                                      compareText += `【${idx + 1}】${snap.created_at || ''}\n`;
                                      compareText += `  BOM: ¥${Number(snap.bom_cost || 0).toFixed(2)}\n`;
                                      compareText += `  整机: ¥${Number(snap.total_cost || 0).toFixed(2)}\n`;
                                      compareText += `  费率: ${snap.platform_fee_rate || 0}% + ${snap.profit_rate || 0}%\n`;
                                      compareText += `  模块/器件: ${snap.module_count || 0} / ${snap.item_count || 0}\n\n`;
                                    });

                                    Modal.info({
                                      title: '快照对比',
                                      width: 600,
                                      content: <pre style={{ fontSize: 12, lineHeight: 1.6 }}>{compareText}</pre>,
                                    });
                                  }
                                }}
                              >
                                对比快照
                              </Button>
                            )}
                            <Popconfirm
                              title={`确定删除选中的 ${snapshotSelKeys.length} 条快照？`}
                              onConfirm={async () => {
                                for (const id of snapshotSelKeys) {
                                  await deleteProjectCostSnapshot(Number(id));
                                }
                                setSnapshotSelKeys([]);
                                await loadCostSnapshots(selectedPid!);
                                message.success('已删除');
                              }}
                            >
                              <Button size="small" danger icon={<DeleteOutlined />}>批量删除</Button>
                            </Popconfirm>
                          </>
                        )}
                        <Button size="small" onClick={async () => { await recordProjectCostSnapshot(selectedPid!, 'manual_snapshot', '手动记录当前整机成本'); await loadCostSnapshots(selectedPid!); message.success('已生成当前快照'); }}>生成当前快照</Button>
                      </Space>
                    </div>
                    {costSnapshots.length > 0 ? (
                      <div style={{ maxHeight: 560, overflowY: 'auto', paddingRight: 6 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          {sortedSnapshots.map((snap: any, index: number) => {
                            const prevSnap = sortedSnapshots[index + 1];
                            const bomDiff = prevSnap ? Number(snap.bom_cost || 0) - Number(prevSnap.bom_cost || 0) : 0;
                            const totalDiff = prevSnap ? Number(snap.total_cost || 0) - Number(prevSnap.total_cost || 0) : 0;
                            return (
                            <div key={snap.id} style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
                              <Checkbox
                                checked={snapshotSelKeys.includes(snap.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSnapshotSelKeys([...snapshotSelKeys, snap.id]);
                                  } else {
                                    setSnapshotSelKeys(snapshotSelKeys.filter(k => k !== snap.id));
                                  }
                                }}
                                style={{ marginTop: 10 }}
                              />
                              <div style={{ width: 90, flexShrink: 0, textAlign: 'right', paddingTop: 6 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: '#1E293B' }}>{(snap.created_at || '').slice(0, 10)}</div>
                                <div style={{ fontSize: 11, color: '#64748B' }}>{(snap.created_at || '').slice(11, 19)}</div>
                              </div>
                              <div style={{ position: 'relative', width: 16, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                                <div style={{ width: 2, background: '#CBD5E1', borderRadius: 999, flex: 1 }} />
                                <div style={{ position: 'absolute', top: 10, width: 10, height: 10, borderRadius: 999, background: '#CF0A2C', border: '2px solid #FFF', boxShadow: '0 0 0 2px rgba(207,10,44,0.18)' }} />
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ padding: 14, border: '1px solid #E2E8F0', borderRadius: 10, background: '#FFF' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                                    <Space size={6} wrap>
                                      <Tag color={snap.snapshot_type === 'manual_snapshot' ? 'blue' : 'red'}>{snap.snapshot_type}</Tag>
                                      <span style={{ fontWeight: 600 }}>{snap.change_reason || '自动记录'}</span>
                                    </Space>
                                    <Space>
                                      <Tag color="blue" style={{ margin: 0 }}>{index + 1}</Tag>
                                      <Popconfirm
                                        title="确定删除此快照？"
                                        onConfirm={async () => {
                                          await deleteProjectCostSnapshot(snap.id);
                                          setSnapshotSelKeys(snapshotSelKeys.filter(k => k !== snap.id));
                                          await loadCostSnapshots(selectedPid!);
                                          message.success('已删除');
                                        }}
                                      >
                                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                      </Popconfirm>
                                    </Space>
                                  </div>
                                  {snap.change_details && (
                                    <div style={{
                                      padding: '6px 10px',
                                      background: '#F1F5F9',
                                      borderRadius: 6,
                                      fontSize: 11,
                                      color: '#475569',
                                      marginBottom: 8,
                                      fontFamily: 'monospace'
                                    }}>
                                      {snap.change_details}
                                    </div>
                                  )}
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                                    <div>
                                      <div style={{ fontSize: 11, color: '#64748B' }}>BOM总成本</div>
                                      <div style={{ fontWeight: 700, color: '#CF0A2C' }}>¥{Number(snap.bom_cost || 0).toFixed(2)}</div>
                                      {prevSnap && bomDiff !== 0 && (
                                        <div style={{ fontSize: 10, color: bomDiff > 0 ? '#EF4444' : '#10B981', marginTop: 2 }}>
                                          {bomDiff > 0 ? '+' : ''}¥{bomDiff.toFixed(2)}
                                        </div>
                                      )}
                                    </div>
                                    <div>
                                      <div style={{ fontSize: 11, color: '#64748B' }}>整机成本</div>
                                      <div style={{ fontWeight: 700, color: '#2563EB' }}>¥{Number(snap.total_cost || 0).toFixed(2)}</div>
                                      {prevSnap && totalDiff !== 0 && (
                                        <div style={{ fontSize: 10, color: totalDiff > 0 ? '#EF4444' : '#10B981', marginTop: 2 }}>
                                          {totalDiff > 0 ? '+' : ''}¥{totalDiff.toFixed(2)}
                                        </div>
                                      )}
                                    </div>
                                    <div>
                                      <div style={{ fontSize: 11, color: '#64748B' }}>费率</div>
                                      <div style={{ fontWeight: 600 }}>{Number(snap.platform_fee_rate || 0)}% + {Number(snap.profit_rate || 0)}%</div>
                                    </div>
                                    <div>
                                      <div style={{ fontSize: 11, color: '#64748B' }}>模块 / 器件</div>
                                      <div style={{ fontWeight: 600 }}>{snap.module_count || 0} / {snap.item_count || 0}</div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                          })}
                        </div>
                      </div>
                    ) : (
                      <Alert
                        type="info"
                        showIcon
                        message="还没有自动快照"
                        description="后续添加、删除、编辑BOM项或导入模块时会自动记录。也可以先点击右侧按钮生成当前快照。"
                      />
                    )}
                  </div>
                );
              })(),
            },
            {
              key: 'reviews', label: <span><BarChartOutlined /> 成本测算</span>, children: (
                <div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setReviewModal(true); }} style={{ marginBottom: 12 }}>添加测算</Button>
                  {/* Trend chart */}
                  {reviews.length > 0 && (() => {
                    const sorted = [...reviews].sort((a: any, b: any) => {
                      const order = ['Charter','CDCP','PDCP','ADCP','量产后降本'];
                      return order.indexOf(a.stage) - order.indexOf(b.stage);
                    });
                    const trendOption = {
                      tooltip: chartTooltip('axis'),
                      grid: { left: 60, right: 30, top: 20, bottom: 30 },
                      xAxis: { type: 'category', data: sorted.map((r: any) => r.stage), ...chartAxisStyle(11) },
                      yAxis: { type: 'value', name: '¥', ...chartAxisStyle() },
                      series: [{ type: 'line', smooth: true, symbol: 'circle', symbolSize: 8, data: sorted.map((r: any) => r.reviewed_cost), itemStyle: { color: '#0A84FF' }, lineStyle: { width: 2.5 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(10,132,255,0.25)' }, { offset: 1, color: 'rgba(10,132,255,0)' }] } }, label: { show: true, formatter: (p: any) => `¥${p.value.toFixed(0)}`, fontSize: 11, color: chartTextMuted() } }],
                    };
                    return <div className="content-card" style={{ margin: '0 0 12px 0', padding: 12 }}><div className="card-header"><h3>成本趋势</h3></div><ReactECharts echarts={echarts} option={trendOption} style={{ height: 250 }} /></div>;
                  })()}
                  <DataTable tableId="proj_reviews" dataSource={reviews} rowKey="id" size="small" pagination={false}
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
              key: 'measures', label: <span><AimOutlined /> 降本措施</span>, children: (
                <div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setMeasureModal(true); }} style={{ marginBottom: 12 }}>添加措施</Button>
                  <DataTable tableId="proj_measures" dataSource={measures} rowKey="id" size="small" pagination={false}
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
            {
              key: 'odm', label: <span><BuildOutlined /> 整机供应商（ODM）</span>, children: (
                <div>
                  {/* ODM 说明 + 加权报价统计 */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                    <Card size="small" style={{ flex: 1, minWidth: 180, background: '#F0F9FF', borderColor: '#BAE6FD' }}>
                      <Statistic title="ODM 加权报价" value={odmWeightedPrice} precision={2} prefix="¥"
                        valueStyle={{ fontSize: 20, color: '#0C4A6E' }} />
                      <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                        {odmActiveCount > 0 ? `基于 ${odmActiveCount} 家启用供应商 · Σ(报价×份额)` : '无启用供应商'}
                      </div>
                    </Card>
                    <Card size="small" style={{ flex: 1, minWidth: 180 }}>
                      <Statistic title="启用/总 ODM" value={`${odmActiveCount}/${projectSuppliers.length}`} valueStyle={{ fontSize: 20 }} />
                      <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>ODM 提供部分或全部物料</div>
                    </Card>
                  </div>
                  <Button type="primary" size="small" icon={<PlusOutlined />} style={{ marginBottom: 12 }}
                    onClick={() => { setPsEditing(null); psForm.resetFields(); setPsModalOpen(true); }}>
                    添加 ODM 供应商
                  </Button>
                  <DataTable tableId="proj_odm_suppliers" dataSource={projectSuppliers} rowKey="id" size="small" pagination={false}
                    columns={[
                      { title: '供应商', dataIndex: 'supplier_name', render: (v: string) => <><BuildOutlined style={{ marginRight: 4, color: '#0369A1' }} />{v}</> },
                      { title: '整机报价(¥)', dataIndex: 'quoted_price', width: 110, align: 'right', render: (v: number) => <span style={{ fontFamily: 'monospace' }}>¥{Number(v || 0).toFixed(2)}</span> },
                      { title: '份额', dataIndex: 'share_ratio', width: 80, render: (v: number) => `${v || 0}%` },
                      { title: '状态', dataIndex: 'is_active', width: 80, render: (v: number) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
                      { title: '备注', dataIndex: 'remark', ellipsis: true },
                      { title: '操作', width: 140, render: (_: any, r: any) => (
                        <Space size="small">
                          <Tooltip title="报价历史">
                            <Button type="link" size="small" icon={<HistoryOutlined />} onClick={async () => {
                              const history = await getProjectSupplierPriceHistory(r.id);
                              Modal.info({
                                title: `「${r.supplier_name}」报价历史`,
                                width: 560,
                                content: history.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: '#94A3B8' }}>暂无报价变动记录</div> : (
                                  <DataTable tableId="odm_price_hist" dataSource={history} rowKey="id" size="small" pagination={false}
                                    columns={[
                                      { title: '时间', dataIndex: 'changed_at', width: 140, render: (v: string) => v?.slice(0, 16) || '-' },
                                      { title: '旧报价', dataIndex: 'old_price', width: 90, align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` },
                                      { title: '新报价', dataIndex: 'new_price', width: 90, align: 'right', render: (v: number) => <b>¥{Number(v || 0).toFixed(2)}</b> },
                                      { title: '变动原因', dataIndex: 'change_reason', ellipsis: true },
                                    ]} />
                                ),
                              });
                            }} />
                          </Tooltip>
                          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setPsEditing(r); psForm.setFieldsValue(r); setPsModalOpen(true); }} />
                          <Popconfirm title="删除该 ODM 供应商？" onConfirm={async () => { await deleteProjectSupplier(r.id); loadProjectSuppliers(selectedPid!); message.success('已删除'); }}>
                            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      )},
                    ]} />
                  <div style={{ marginTop: 8, fontSize: 11, color: '#94A3B8' }}>
                    <EmojiIcon e="💡" /> ODM 供应商报价在「供应商管理 → 整机供应商（ODM）」中自动汇总展示；修改报价会记录变动原因与历史
                  </div>
                </div>
              ),
            },
            {
              key: 'sku', label: <span><TagOutlined /> SKU 变体 ({skus.length})</span>, children: (() => {
                const skuChartData = [
                  { name: `基座 ${projects.find(p => p.id === selectedPid)?.code || ''}`, value: Math.round(bomTotal * 100) / 100 },
                  ...skus.map(s => ({ name: s.sku_code, value: Math.round(calcSku(s).cost * 100) / 100 })),
                ];
                const skuOption = skus.length === 0 ? null : {
                  tooltip: { ...chartTooltip('axis'), valueFormatter: (v: number) => `¥${Number(v).toFixed(2)}` },
                  grid: { left: 60, right: 20, top: 24, bottom: 5, containLabel: true },
                  xAxis: { type: 'category', data: skuChartData.map(d => d.name), axisLabel: { color: chartTextMuted(), fontSize: 11 }, axisTick: { show: false } },
                  yAxis: { type: 'value', name: '成本(¥)', axisLabel: { color: chartTextMuted(), fontSize: 10.5 }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
                  series: [{
                    name: '整机成本', type: 'bar', barWidth: '38%',
                    // 系列级颜色（图例铁律）：基座蓝、SKU 紫
                    itemStyle: { color: barGradient('#0A84FF'), borderRadius: [6, 6, 0, 0] },
                    data: skuChartData.map(d => ({
                      value: d.value,
                      itemStyle: { color: barGradient(d.name.startsWith('基座') ? '#0A84FF' : '#5E5CE6'), borderRadius: [6, 6, 0, 0] },
                    })),
                    label: { show: true, position: 'top', formatter: (p: any) => `¥${Number(p.value).toFixed(2)}`, fontSize: 10, color: chartTextMuted() },
                  }],
                };
                return (
                  <div>
                    <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <Space wrap>
                        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setSkuEdit(null); skuForm.resetFields(); setSkuModal(true); }}>添加 SKU</Button>
                        <Button size="small" icon={<PlusCircleOutlined />} onClick={() => { addPartForm.resetFields(); setAddPartModal(true); }}>＋ 新增差异器件</Button>
                        <Upload beforeUpload={handleSkuImportFile} showUploadList={false} accept=".xlsx,.xls"><Button size="small" icon={<UploadOutlined />}>导入差异（Excel）</Button></Upload>
                        {skus.length > 0 && <Button size="small" icon={<EyeOutlined />} onClick={() => setSkuDetail(skus[0])}>查看全量 BOM</Button>}
                        <span style={{ fontSize: 11.5, color: '#94A3B8' }}>
                          点某 SKU 的格子编辑：数量/单价直接改，填「换型号」= 替换（如 8GB→16GB），⊖ 移除（如 outbox→inbox 简包装）；改回基座值自动还原；基座降价自动联动所有 SKU
                        </span>
                      </Space>
                    </div>
                    {skuOption && <div style={{ marginBottom: 10 }}><ReactECharts echarts={echarts} option={skuOption} style={{ height: 180 }} /></div>}
                    {skus.length > 0 ? (
                      <div style={{ overflowX: 'auto', border: '1px solid #E8ECF1', borderRadius: 8 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ background: '#F8FAFC' }}>
                              <th style={{ padding: '6px 8px', borderBottom: '1px solid #E8ECF1', textAlign: 'left', whiteSpace: 'nowrap' }}>模块 / 器件</th>
                              <th style={{ padding: '6px 8px', borderBottom: '1px solid #E8ECF1', textAlign: 'left', whiteSpace: 'nowrap' }}>型号</th>
                              <th style={{ padding: '6px 8px', borderBottom: '1px solid #E8ECF1', textAlign: 'right', background: '#EEF2FF', whiteSpace: 'nowrap' }}>基座<br /><span style={{ fontWeight: 400 }}>¥{bomTotal.toFixed(2)}</span></th>
                              {skus.map(s => (
                                <th key={s.id} style={{ padding: '6px 8px', borderBottom: '1px solid #E8ECF1', textAlign: 'right', background: '#FAF5FF', whiteSpace: 'nowrap' }}>
                                  {s.sku_code}{s.sku_name ? ` ${s.sku_name}` : ''}<br />
                                  <span style={{ fontWeight: 400 }}>¥{calcSku(s).cost.toFixed(2)}</span>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              // 模块分组渲染：模块头行（含各列模块小计）+ 器件行 + 添加器件行
                              const tdBase = { padding: '4px 8px', borderBottom: '1px solid #F1F5F9' };
                              const mods = [...new Set(skuCompareRows.map(r => r.module))];
                              const rows: any[] = [];
                              mods.forEach(mod => {
                                const modRows = skuCompareRows.filter(r => r.module === mod);
                                const baseSub = modRows.filter(r => !r._isAdd).reduce((s, r) => s + (r.baseCost || 0) * (r.baseQty || 1), 0);
                                const skuSubs = skus.map(s => {
                                  const idx = skus.findIndex(x => x.id === s.id);
                                  return modRows.reduce((sum, r) => {
                                    const c = r.skus[idx];
                                    if (c.status === 'none' || c.status === 'removed') return sum;
                                    return sum + (c.cost ?? 0) * (c.qty ?? 1);
                                  }, 0);
                                });
                                rows.push(
                                  <tr key={`mod-${mod}`} style={{ background: '#FBFCFE' }}>
                                    <td colSpan={2} style={{ padding: '5px 8px', borderBottom: '1px solid #F1F5F9', fontWeight: 700, color: '#1E3A6E' }}>📦 {mod}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #F1F5F9', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>¥{baseSub.toFixed(2)}</td>
                                    {skuSubs.map((v, i) => (
                                      <td key={i} style={{ padding: '5px 8px', borderBottom: '1px solid #F1F5F9', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>¥{v.toFixed(2)}</td>
                                    ))}
                                  </tr>,
                                );
                                modRows.forEach(r => {
                                  const baseAmt = (r.baseCost ?? 0) * (r.baseQty ?? 1);
                                  rows.push(
                                    <tr key={r.key}>
                                      <td style={tdBase}>
                                        <span style={{ fontWeight: 500 }}>{r.name}</span>
                                        {r._isAdd && <Tag color="green" style={{ marginLeft: 6, fontSize: 10 }}>新增</Tag>}
                                      </td>
                                      <td style={{ ...tdBase, color: '#64748B' }}>{r.model}</td>
                                      <td style={{ ...tdBase, textAlign: 'right', color: r._isAdd ? '#CBD5E1' : undefined, fontVariantNumeric: 'tabular-nums' }}>
                                        {r._isAdd ? '—' : <><div>¥{(r.baseCost || 0).toFixed(2)} × {r.baseQty || 1}</div><div style={{ fontWeight: 600 }}>¥{baseAmt.toFixed(2)}</div></>}
                                      </td>
                                      {skus.map(s => {
                                        const idx = skus.findIndex(x => x.id === s.id);
                                        const c = r.skus[idx];
                                        const isEd = editingCell && editingCell.skuId === s.id && editingCell.rowKey === r.key;
                                        // 编辑态：内联数量/单价输入
                                        if (isEd) {
                                          return (
                                            <td key={s.id} style={{ ...tdBase, textAlign: 'right' }}>
                                              <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                                                <InputNumber size="small" autoFocus value={edQty} onChange={v => setEdQty(v ?? 0)} min={0} step={0.000001} style={{ width: 56 }} onPressEnter={saveEdit} />
                                                <InputNumber size="small" value={edCost} onChange={v => setEdCost(v ?? 0)} min={0} precision={4} style={{ width: 70 }} onPressEnter={saveEdit} />
                                                {!r._isAdd && (
                                                  <Input size="small" value={edModel} onChange={e => setEdModel(e.target.value)} placeholder="换型号(可选)" style={{ width: 108 }}
                                                    title="输入新型号 = 替换型号（如 8GB → 16GB）；留空 = 只改数量/单价" onPressEnter={saveEdit} />
                                                )}
                                                <Button size="small" type="link" icon={<CheckOutlined />} onClick={saveEdit} />
                                                <Button size="small" type="link" icon={<CloseOutlined />} onClick={cancelEdit} />
                                                {!r._isAdd && (
                                                  <Button size="small" type="text" danger icon={<MinusCircleOutlined />} title="从该 SKU 移除此器件" onClick={removeCell} />
                                                )}
                                              </span>
                                            </td>
                                          );
                                        }
                                        if (r._isAdd && c.status === 'none') {
                                          // 新增行：其他 SKU 列显示 ＋（点击给该 SKU 添加）
                                          return (
                                            <td key={s.id} style={{ ...tdBase, textAlign: 'center' }}>
                                              <span onClick={() => startEdit(s, r)} title="给该 SKU 添加此器件" style={{ cursor: 'pointer', color: '#0A84FF', fontSize: 15, fontWeight: 700 }}>＋</span>
                                            </td>
                                          );
                                        }
                                        if (c.status === 'removed') {
                                          return (
                                            <td key={s.id} style={{ ...tdBase, textAlign: 'center' }}>
                                              <span onClick={() => startEdit(s, r)} title="点击恢复" style={{ cursor: 'pointer', color: '#DC2626', textDecoration: 'line-through' }}>已移除</span>
                                            </td>
                                          );
                                        }
                                        const isDiff = c.status === 'replaced' || c.status === 'added';
                                        const amt = (c.cost ?? 0) * (c.qty ?? 1);
                                        const modelTip = c.newModel && c.newModel !== r.model
                                          ? '替换型号：' + r.model + ' → ' + c.newModel
                                          : (c.status === 'replaced' ? '已替换（单价/数量不同）' : '点击编辑：改数量/单价，或输入新型号=替换，点 ⊖ 移除');
                                        return (
                                          <td key={s.id} style={{ ...tdBase, textAlign: 'right' }}>
                                            <div onClick={() => startEdit(s, r)} title={modelTip} style={{ cursor: 'pointer', background: isDiff ? '#FEF3C7' : 'transparent', borderRadius: 4, padding: '2px 6px' }}>
                                              <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                {c.newModel && c.newModel !== r.model ? <b style={{ color: '#D97706' }}>{c.newModel} </b> : null}
                                                ¥{(c.cost ?? 0).toFixed(2)} × {c.qty ?? 1}
                                              </div>
                                              <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>¥{amt.toFixed(2)}</div>
                                            </div>
                                          </td>
                                        );
                                      })}
                                    </tr>,
                                  );
                                });
                                // 模块末行：添加器件（Excel 式：填名称/型号后点某 SKU 列的 ＋）
                                const adding = addingRows[mod];
                                rows.push(
                                  <tr key={`newrow-${mod}`}>
                                    <td colSpan={2} style={{ ...tdBase, color: '#94A3B8' }}>
                                      {adding ? (
                                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                          <Input size="small" autoFocus placeholder="器件名称" value={adding.name}
                                            onChange={e => setAddingRows({ ...addingRows, [mod]: { ...adding, name: e.target.value } })} style={{ width: 130 }} />
                                          <Input size="small" placeholder="型号" value={adding.model}
                                            onChange={e => setAddingRows({ ...addingRows, [mod]: { ...adding, model: e.target.value } })} style={{ width: 110 }} />
                                          <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setAddingRows(prev => { const n = { ...prev }; delete n[mod]; return n; })} />
                                        </span>
                                      ) : (
                                        <Button size="small" type="link" icon={<PlusOutlined />} style={{ padding: 0 }}
                                          onClick={() => setAddingRows({ ...addingRows, [mod]: { name: '', model: '' } })}>添加器件到此模块</Button>
                                      )}
                                    </td>
                                    <td style={{ ...tdBase, color: '#CBD5E1', textAlign: 'right' }}>—</td>
                                    {skus.map(s => {
                                      const isNewEd = editingCell && editingCell.skuId === s.id && editingCell.rowKey === `new-${mod}`;
                                      return (
                                        <td key={s.id} style={{ ...tdBase, textAlign: 'center' }}>
                                          {!adding ? null : isNewEd ? (
                                            <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                                              <InputNumber size="small" autoFocus value={edQty} onChange={v => setEdQty(v ?? 0)} min={0} step={0.000001} style={{ width: 62 }} onPressEnter={() => saveNewAdd(s, mod)} />
                                              <InputNumber size="small" value={edCost} onChange={v => setEdCost(v ?? 0)} min={0} precision={4} style={{ width: 76 }} onPressEnter={() => saveNewAdd(s, mod)} />
                                              <Button size="small" type="link" icon={<CheckOutlined />} onClick={() => saveNewAdd(s, mod)} />
                                              <Button size="small" type="link" icon={<CloseOutlined />} onClick={cancelEdit} />
                                            </span>
                                          ) : (
                                            <span onClick={() => { const a = addingRows[mod]; if (!a || !a.name) { message.warning('请先填写器件名称'); return; } setEditingCell({ skuId: s.id, rowKey: `new-${mod}` }); setEdQty(1); setEdCost(0); }}
                                              style={{ cursor: 'pointer', color: '#0A84FF', fontSize: 15, fontWeight: 700 }} title="添加到该 SKU">＋</span>
                                          )}
                                        </td>
                                      );
                                    })}
                                  </tr>,
                                );
                              });
                              return rows;
                            })()}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: 30, color: '#94A3B8', fontSize: 12 }}>
                        暂无 SKU——点击"添加 SKU"创建第一个变体（如：存储配置不同、规格微调），然后在表格里改它的差异
                      </div>
                    )}
                    {/* SKU 列表（编辑/删除/成本汇总） */}
                    {skus.length > 0 && (
                      <DataTable tableId="proj_skus" dataSource={skus} rowKey="id" size="small" pagination={false} style={{ marginTop: 10 }}
                        columns={[
                          { title: 'SKU 代号', dataIndex: 'sku_code', width: 110, render: (v: string) => <b style={{ fontSize: 12.5 }}>{v}</b> },
                          { title: '名称', dataIndex: 'sku_name', width: 130, ellipsis: true },
                          { title: '规格差异说明', dataIndex: 'spec_desc', width: 210, ellipsis: true },
                          { title: '整机成本', key: 'cost', width: 105, align: 'right' as const, render: (_: any, r: any) => { const c = calcSku(r); return <b style={{ color: '#CF0A2C', fontVariantNumeric: 'tabular-nums' }}>¥{c.cost.toFixed(2)}</b>; } },
                          { title: '较基座', key: 'delta', width: 95, align: 'right' as const, render: (_: any, r: any) => { const v = calcSku(r).delta; return <span style={{ color: v > 0 ? '#D97706' : v < 0 ? '#10B981' : '#94A3B8', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v > 0 ? '+' : ''}{v.toFixed(2)}</span>; } },
                          { title: '差异数', key: 'dc', width: 65, align: 'center' as const, render: (_: any, r: any) => (skuDiffsMap[r.id] || []).length },
                          {
                            title: '操作', width: 160,
                            render: (_: any, r: any) => (
                              <Space size={0}>
                                <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setSkuDetail(r)}>详情</Button>
                                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setSkuEdit(r); skuForm.setFieldsValue(r); setSkuModal(true); }}>编辑</Button>
                                <Popconfirm title="删除 SKU？（差异一并删除）" onConfirm={async () => { await deleteSku(r.id); await loadSkus(selectedPid!); }}><Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>
                              </Space>
                            ),
                          },
                        ]} />
                    )}
                  </div>
                );
              })(),
            },
          ]} />
          </div>
        </div>
      )}
        </main>

      <Drawer
        title="议价机会"
        open={negotiationOpen}
        onClose={() => setNegotiationOpen(false)}
        width={380}
        className="negotiation-drawer"
      >
        <div className="negotiation-summary">
          <span>当前已识别机会</span>
          <strong>¥{negotiationRows.reduce((sum: number, item: any) => sum + item.saving, 0).toFixed(2)}</strong>
          <small>{refProjPid ? '基于已选择的参照项目' : '选择参照项目后生成可核验机会'}</small>
        </div>
        <div className="negotiation-list">
          {negotiationRows.map(({ row, ref, saving }: any, index: number) => (
            <div className="negotiation-item" key={row.id || index}>
              <div className="negotiation-item-top"><b>{row.part_name || '未命名器件'}</b><span className={saving > 0 ? 'is-saving' : ''}>{saving > 0 ? `可降 ¥${saving.toFixed(2)}` : '待核价'}</span></div>
              <div className="negotiation-item-meta">{row.part_model || '无型号'} · {row.module_name || '未归类'}</div>
              <div className="negotiation-item-evidence">当前 ¥{Number(row.part_cost || 0).toFixed(2)} {ref ? `· 参考 ¥${Number(ref.part_cost || 0).toFixed(2)}` : '· 暂无参照证据'}</div>
            </div>
          ))}
          {negotiationRows.length === 0 && <div className="project-rail-empty">当前 BOM 暂无可分析器件。</div>}
        </div>
        <Button type="primary" block onClick={() => { setNegotiationOpen(false); setActiveTab('tender'); }}>进入招标工作台查看报价证据</Button>
      </Drawer>

      <Modal
        title="管理 BOM 自定义列"
        open={customColumnModal}
        onOk={createCustomBomColumn}
        onCancel={() => { setCustomColumnModal(false); setCustomColumnTitle(''); }}
        okText="添加列"
        cancelText="取消"
        width={460}
      >
        <div className="bom-custom-column-form">
          <div className="bom-custom-column-row"><label htmlFor="bom-custom-column-title">列名称</label><Input id="bom-custom-column-title" autoFocus value={customColumnTitle} onChange={event => setCustomColumnTitle(event.target.value)} placeholder="例如：A供应商报价、目标价、议价状态" maxLength={40} /></div>
          <div className="bom-custom-column-row"><span>数据类型</span><Segmented value={customColumnType} onChange={value => setCustomColumnType(value as 'text' | 'number')} options={[{ label: '文字', value: 'text' }, { label: '数字', value: 'number' }]} /></div>
          <div className="bom-custom-column-tip">自定义列会保存到当前项目的本地数据库；在全量表格中双击单元格即可填写，删除列不会删除 BOM 行。</div>
          {bomCustomColumns.length > 0 && <div className="bom-custom-column-existing"><b>当前自定义列</b>{bomCustomColumns.map((column: any) => <div key={column.id}><span>{column.title}</span><small>{column.data_type === 'number' ? '数字' : '文字'}</small><Popconfirm title={`删除「${column.title}」？`} description="只删除列定义及显示，不会删除 BOM 行。" onConfirm={() => removeCustomBomColumn(column)}><Button type="link" danger size="small">删除</Button></Popconfirm></div>)}</div>}
        </div>
      </Modal>

      {/* Project edit modal */}
      <Modal title={editing?.id ? '编辑项目' : '新建项目'} open={modalOpen} onOk={handleSaveProject} onCancel={() => { setModalOpen(false); setEditing(null); }} width={640} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={editing || { project_type: '在研', tier: '主流级', status: '进行中', category: '未分类', specs: '', platform_fee_rate: 0, profit_rate: 0 }}>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="项目代号*" name="code" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="项目名称*" name="name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="类型" name="project_type"><Select options={PROJECT_TYPES.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="品类" name="category" extra="如：显示器、手写笔、鼠标"><AutoComplete options={categories.map((c: any) => ({ label: c.name, value: c.name }))} placeholder="选择或输入品类" allowClear /></Form.Item></Col>
            <Col span={8}><Form.Item label="档位" name="tier"><Select options={TIERS.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
            <Col span={8}><Form.Item label="状态" name="status"><Select options={PROJECT_STATUSES.map(s => ({ label: s, value: s }))} /></Form.Item></Col>
          </Row>
          {watchCategory === '显示器' ? (
            <Row gutter={16}>
              <Col span={8}><Form.Item label="屏幕尺寸" name="screen_size"><Select options={SCREEN_SIZES.map(s => ({ label: s, value: s }))} allowClear /></Form.Item></Col>
              <Col span={8}><Form.Item label="分辨率" name="resolution"><Select options={RESOLUTIONS.map(r => ({ label: r, value: r }))} allowClear /></Form.Item></Col>
              <Col span={4}><Form.Item label="刷新率" name="refresh_rate"><Select options={REFRESH_RATES.map(r => ({ label: r, value: r }))} allowClear /></Form.Item></Col>
              <Col span={4}><Form.Item label="面板" name="panel_type"><Select options={PANEL_TYPES.map(p => ({ label: p, value: p }))} allowClear /></Form.Item></Col>
            </Row>
          ) : (
            <Form.Item label="关键规格" name="specs" extra="该品类的核心规格（如：DPI/传感器/连接方式，或 SoC/内存/存储），用于列表展示与后续成本参考">
              <Input placeholder="如：无线 / DPI 1600 / 重量 89g" />
            </Form.Item>
          )}
          <Row gutter={16}>
            <Col span={8}><Form.Item label="平台费率(%)" name="platform_fee_rate"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item label="利润/管销研费率(%)" name="profit_rate"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item></Col>
            {watchCategory === '显示器' && (
              <Col span={8}>
                <div style={{ fontSize: 11.5, color: '#94A3B8', paddingTop: 30 }}>显示器规格参与「规格级项目预估」成本估算</div>
              </Col>
            )}
          </Row>
        </Form>
      </Modal>

      {/* Import preview modal */}
      <Modal title={`BOM 导入预览 (${importPreview.length} 条)`} open={importModal} onOk={doImport} onCancel={() => setImportModal(false)} width={900} okText="确认导入">
        <Alert message="系统将自动：1) 按模块名归类 2) 匹配已有器件/创建新器件到器件库 3) 标记所属项目" type="info" style={{ marginBottom: 12 }} />
        {(() => {
          // ===== 总价统计（便于与原 Excel 核对） =====
          const total = importPreview.reduce((s, r) => s + (r.cost || 0) * (r.quantity || 1), 0);
          const issueCount = importPreview.filter((r: any) => (r._issues || []).length > 0).length;
          const warnCount = importPreview.filter((r: any) => (r._warns || []).length > 0).length;
          // 各模块小计
          const byModule: Record<string, number> = {};
          importPreview.forEach((r: any) => {
            const k = r.module_name || '未归类';
            byModule[k] = (byModule[k] || 0) + (r.cost || 0) * (r.quantity || 1);
          });
          return (
            <div style={{ marginBottom: 12 }}>
              {/* 总价 + 异常提示条 */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: '10px 14px',
                background: issueCount > 0 ? '#FFF7ED' : '#F0FDF4',
                border: '1px solid' + (issueCount > 0 ? '#FED7AA' : '#BBF7D0'),
                borderRadius: 8, marginBottom: 10, flexWrap: 'wrap',
              }}>
                <div>
                  <div style={{ fontSize: 11, color: '#6B7280' }}>BOM 总价</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: issueCount > 0 ? '#B45309' : '#047857' }}>
                    ¥{total.toFixed(4)}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.6 }}>
                  合计 {importPreview.length} 条 · {Object.keys(byModule).length} 个模块
                  {issueCount > 0 && (
                    <div style={{ color: '#B45309', fontWeight: 700, marginTop: 2 }}>
                      <EmojiIcon e="⚠" /> {issueCount} 条数据异常（见下方红色标注），建议核对后再导入
                    </div>
                  )}
                  {warnCount > 0 && (
                    <div style={{ color: '#B45309', fontWeight: 600, marginTop: 2 }}>
                      ℹ️ {warnCount} 条数量为0（黄色提示，可正常导入）
                    </div>
                  )}
                </div>
              </div>
              {/* 模块小计（便于与原 Excel 逐模块核对） */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(byModule).map(([m, v]) => (
                  <span key={m} style={{
                    fontSize: 11, background: '#F8FAFC', border: '1px solid #E5E7EB',
                    borderRadius: 6, padding: '3px 10px', color: '#374151',
                  }}>
                    {m}: <b style={{ color: '#1E3A6E' }}>¥{v.toFixed(4)}</b>
                  </span>
                ))}
              </div>
            </div>
          );
        })()}
        <DataTable tableId="bom_import_preview" dataSource={importPreview} rowKey={(_, i) => String(i)} size="small" scroll={{ y: 320 }}
          columns={[
            { title: '模块', dataIndex: 'module_name', width: 90 },
            { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag>{v}</Tag> },
            { title: '子类', dataIndex: 'sub_category', width: 80 },
            { title: '名称', dataIndex: 'name' }, { title: '型号', dataIndex: 'model' },
            { title: '单价', dataIndex: 'cost', width: 85, render: (v: number) => v?.toFixed(4) },
            { title: '数量', dataIndex: 'quantity', width: 75, render: (v: number) => v != null ? (Number.isInteger(v) ? v : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')) : '-' },
            { title: '小计', width: 95, align: 'right' as const, render: (_: any, r: any) => <b>¥{((r.cost || 0) * (r.quantity || 1)).toFixed(4)}</b> },
            {
              title: '异常', width: 160,
              render: (_: any, r: any) => {
                const issues: string[] = r._issues || [];
                const warns: string[] = r._warns || [];
                if (issues.length === 0 && warns.length === 0) return <span style={{ color: '#94A3B8', fontSize: 11 }}>正常</span>;
                return (
                  <span style={{ fontSize: 10.5, lineHeight: 1.5, display: 'block' }}>
                    {issues.map((s: string, i: number) => <div key={`e${i}`} style={{ color: '#DC2626', display: 'inline-flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="⚠" /> {s}</div>)}
                    {warns.map((s: string, i: number) => <div key={`w${i}`} style={{ color: '#D97706' }}>⚠️ {s}</div>)}
                  </span>
                );
              },
            },
          ]} pagination={false}
          rowClassName={(r: any) => (r._issues || []).length > 0 ? 'ant-table-row-danger' : ''}
        />
      </Modal>

      {/* BOM add modal — 3 ways: from module library, from parts, manual */}
      <Modal title={bomEdit ? '编辑BOM项' : '添加器件到BOM'} open={bomModal} onOk={async () => {
        try {
          const v = await bomForm.validateFields();
          const mode = v._addMode || 'manual';
          if (bomEdit) {
            // 同步更新 BOM 快照列（名称/型号/单价/分类），保证快照优先显示读到新值
            await updateBOMItem(bomEdit.id, v.quantity, v.module_name || '', v.remark || '', false, {
              partName: v._part_name ?? bomEdit.part_name,
              partModel: v._part_model ?? bomEdit.part_model,
              cost: v._cost ?? bomEdit.part_cost,
              mainCategory: v._main_category ?? bomEdit.main_category,
              subCategory: v._sub_category ?? bomEdit.sub_category,
            });
            // Sync to parts library
            if (bomEdit.part_id) {
              await savePart({ id: bomEdit.part_id, main_category: v._main_category || bomEdit.main_category, sub_category: v._sub_category || bomEdit.sub_category, category: v._main_category || bomEdit.main_category, name: v._part_name || bomEdit.part_name, model: v._part_model || bomEdit.part_model, cost: v._cost ?? bomEdit.part_cost, specs: bomEdit.part_specs || '', projects: bomEdit.projects || '', remark: v.remark || '' }, false);
            }
            await recordProjectCostSnapshot(selectedPid!, 'part_changed', `调整BOM项：${v._part_name || bomEdit.part_name || ''}`);
          } else if (mode === 'module') {
            // Import all items from selected module
            if (!v._moduleId) { message.warning('请选择模块'); return; }
            const items = await getModuleItems(v._moduleId);
            // Get the source project id from the module
            const srcMod = modList.find((m: any) => m.id === v._moduleId);
            const srcPid = srcMod?.project_id || 0;
            for (const item of items) {
              let partId = item.part_id;
              if (!partId) {
                // 名称 + 型号完全相等才复用（与 BOM 导入口径一致，避免跨器件错配）
                const existing = await getParts(item.part_name || '', '', '');
                const match = existing.find((p: any) => p.name === item.part_name && (p.model || '') === (item.part_model || ''));
                partId = match?.id || await savePart({ main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.cost, specs: '', projects: '', remark: '' }, false);
              }
              await addBOMItem(selectedPid!, partId, item.quantity, item._modName || v._moduleName || '', item.remark || '', srcPid, false);
            }
            await recordProjectCostSnapshot(selectedPid!, 'module_imported', `从模块库导入「${v._moduleName}」 ${items.length} 件`);
            message.success(`已导入模块 [${v._moduleName}]: ${items.length} 件`);
          } else if (mode === 'parts') {
            await addBOMItem(selectedPid!, v.part_id, v.quantity, v.module_name || '', v.remark || '');
          } else if (mode === 'virtual') {
            // 虚拟器件：不建 parts、仅成本占位
            const { addVirtualBOMItem } = await import('../db');
            await addVirtualBOMItem(selectedPid!, {
              name: v._part_name || '虚拟器件', model: v._part_model || '',
              cost: v._cost || 0, quantity: v._quantity || 1,
              moduleName: v._module_name || '', mainCategory: v._main_category || '硬件类',
              subCategory: v._sub_category || '', remark: v._remark || '',
            });
            message.success('已添加虚拟器件（成本占位）');
          } else {
            // Manual: create part first, then add to BOM
            const partId = await savePart({ main_category: v._main_category || '硬件类', sub_category: v._sub_category || '', category: v._main_category || '硬件类', name: v._part_name, model: v._part_model || '', cost: v._cost || 0, specs: '', projects: '', remark: '' }, false);
            await addBOMItem(selectedPid!, partId, v._quantity || 1, v._module_name || '', v._remark || '');
          }
          setBomModal(false); setBomEdit(null); loadBOM(selectedPid!); loadCostSnapshots(selectedPid!);
          scheduleAutoCompare(); // BOM 变化 → 后台自动识别物料差异
        } catch (e) {
          console.error('BOM保存失败:', e);
          message.error('保存失败: ' + (e instanceof Error ? e.message : String(e)));
        }
      }} onCancel={() => { setBomModal(false); setBomEdit(null); }} width={680} destroyOnClose>
        <Form form={bomForm} layout="vertical" initialValues={{ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }}>
          {!bomEdit && (
            <Form.Item label="添加方式" name="_addMode">
              <Select options={[
                { label: <span><InboxOutlined /> 从模块库导入（推荐）</span>, value: 'module' },
                { label: <span><ToolOutlined /> 从器件库选择已有器件</span>, value: 'parts' },
                { label: <span><EditOutlined /> 手动录入新器件</span>, value: 'manual' },
                { label: <span><PlusCircleOutlined /> 虚拟器件（成本占位）</span>, value: 'virtual' },
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
                      <Form.Item label="单价(¥)" name="_cost" initialValue={bomEdit.part_cost}><InputNumber min={0} precision={4} style={{ width: '100%' }} prefix="¥" /></Form.Item>
                    </div>
                    <Row gutter={16}>
                      <Col span={12}><Form.Item label="模块名" name="module_name"><Input placeholder="如: 主板模块" /></Form.Item></Col>
                      <Col span={12}><Form.Item label="数量" name="quantity"><InputNumber min={0} step={0.000001} style={{ width: '100%' }} /></Form.Item></Col>
                    </Row>
                    <Form.Item label="备注" name="remark"><Input /></Form.Item>
                    <Alert message="编辑后的名称/型号/大类/子类/单价将同步更新到器件库" type="info" showIcon style={{ marginTop: 8, fontSize: 12 }} />
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
                            label: `[${m.module_category || '未分类'}] ${m.name} — [${m.project_code}] ${m.project_name}${m.description ? ' | ' + m.description : ''}`,
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
                        <DataTable tableId="bom_preview_moditems" dataSource={previewModItems} rowKey="id" size="small" pagination={false} scroll={{ y: 200 }}
                          columns={[
                            { title: '名称', dataIndex: 'part_name', ellipsis: true },
                            { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
                            { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                            { title: '单价', dataIndex: 'cost', width: 80, align: 'right' as const, render: (v: number) => v?.toFixed(2) },
                            { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const, render: (v: number) => v != null ? (Number.isInteger(v) ? v : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')) : '-' },
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
                        onClick={async () => { if (allParts.length === 0) setAllParts(await getParts('', '', '')); }} />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={12}><Form.Item label="归类到模块" name="module_name"><Input placeholder="如: 主板模块" /></Form.Item></Col>
                      <Col span={12}><Form.Item label="数量" name="quantity"><InputNumber min={0} step={0.000001} style={{ width: '100%' }} /></Form.Item></Col>
                    </Row>
                    <Form.Item label="备注" name="remark"><Input /></Form.Item>
                  </>
                );
              }
              // Manual 或 Virtual：手动录入（虚拟器件不建 parts，仅成本占位）
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label="大类" name="_main_category" rules={[{ required: true }]}>
                      <Select options={mainCats.map(c => ({ label: c, value: c }))}
                        onChange={(v) => bomForm.setFieldValue('_sub_category', (SUB_CATEGORIES[v] || [])[0] || '')} />
                    </Form.Item>
                    <Form.Item label="子类" name="_sub_category"><Select options={(SUB_CATEGORIES[bomForm.getFieldValue('_main_category')] || []).map(c => ({ label: c, value: c }))} showSearch /></Form.Item>
                    <Form.Item label="数量" name="_quantity" extra="支持小数（分摊用量）"><InputNumber min={0} step={0.000001} style={{ width: '100%' }} /></Form.Item>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label={mode === 'virtual' ? '占位名称' : '器件名称'} name="_part_name" rules={[{ required: true }]}>
                      <Input placeholder={mode === 'virtual' ? '如: 预留电源IC' : '器件名称'} />
                    </Form.Item>
                    <Form.Item label="型号" name="_part_model"><Input placeholder="型号/料号" /></Form.Item>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                    <Form.Item label={mode === 'virtual' ? '预估成本' : '单价'} name="_cost"><InputNumber min={0} precision={4} style={{ width: '100%' }} prefix="¥" /></Form.Item>
                    <Form.Item label="模块" name="_module_name"><Input placeholder="归入模块" /></Form.Item>
                    <Form.Item label="备注" name="_remark"><Input placeholder="备注" /></Form.Item>
                  </div>
                  {mode === 'virtual' && (
                    <Alert message="虚拟器件仅作成本占位，不进入器件库；定型或确认选型后可在编辑中替换为真实器件" type="warning" showIcon style={{ marginTop: 4, fontSize: 12 }} />
                  )}
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`修改历史 - ${bomHistoryTitle}`}
        open={bomHistoryOpen}
        onCancel={() => setBomHistoryOpen(false)}
        footer={null}
        width={760}
      >
        {bomHistoryRows.length === 0 ? (
          <div className="history-empty-state">暂无字段级修改记录</div>
        ) : (
          <DataTable
            tableId="project_bom_change_history"
            dataSource={bomHistoryRows}
            rowKey="id"
            size="small"
            pagination={false}
            columns={[
              { title: '时间', dataIndex: 'changed_at', width: 150 },
              { title: '字段', dataIndex: 'field_label', width: 110 },
              { title: '原值', dataIndex: 'old_value', ellipsis: true },
              { title: '新值', dataIndex: 'new_value', ellipsis: true },
              { title: '来源', dataIndex: 'source', width: 140, render: (v: string) => v === 'project_bom_inline' ? '项目 BOM 双击' : v === 'module_library_edit' ? '模块库编辑' : v || '手动' },
            ]}
          />
        )}
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
      {/* ODM 整机供应商编辑弹窗 */}
      {(() => {
        const odmIsNew = !psEditing?.id;
        return (
      <Modal title={psEditing?.id ? '编辑 ODM 供应商' : '添加 ODM 供应商'} open={psModalOpen}
        onOk={async () => {
          const v = await psForm.validateFields();
          const oldPrice = psEditing?.quoted_price ?? 0;
          const newPrice = v.quoted_price ?? 0;
          // 报价变动强制输入原因
          if (!odmIsNew && Math.abs(Number(newPrice) - Number(oldPrice)) > 0.001) {
            if (!v.change_reason) { message.warning('报价有变动，请填写变动原因'); return; }
            await saveProjectSupplierPriceHistory({ supplier_id: psEditing.id, old_price: oldPrice, new_price: newPrice, change_reason: v.change_reason });
          }
          await saveProjectSupplier({ project_id: selectedPid, id: psEditing?.id, supplier_name: v.supplier_name, quoted_price: newPrice, share_ratio: v.share_ratio, is_active: v.is_active ?? 1, remark: v.remark });
          setPsModalOpen(false); setPsEditing(null); psForm.resetFields();
          loadProjectSuppliers(selectedPid!);
          message.success(odmIsNew ? '已添加 ODM 供应商' : '已保存');
        }}
        onCancel={() => { setPsModalOpen(false); setPsEditing(null); psForm.resetFields(); }} width={440}
      >
        <Form form={psForm} layout="vertical" initialValues={{ is_active: 1 }}>
          <Form.Item label="ODM 供应商名称" name="supplier_name" rules={[{ required: true, message: '请输入供应商名称' }]}>
            <Input placeholder="如：富士康、冠捷" />
          </Form.Item>
          <Form.Item label="整机报价(¥)" name="quoted_price" rules={[{ required: true, message: '请输入整机报价' }]}>
            <InputNumber min={0} style={{ width: '100%' }} prefix="¥" placeholder="整机含税报价" />
          </Form.Item>
          <Form.Item label="份额比例(%)" name="share_ratio" extra="0-100%，多家份额自动归一化">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="状态" name="is_active">
            <Select options={[{ label: '启用', value: 1 }, { label: '停用', value: 0 }]} />
          </Form.Item>
          {!odmIsNew && (
            <Form.Item label="报价变动原因（改价必填）" name="change_reason">
              <Input placeholder="如：面板降价传导、谈判让价 2%" />
            </Form.Item>
          )}
          <Form.Item label="备注" name="remark">
            <Input placeholder="如：提供部分物料（面板+结构件）" />
          </Form.Item>
        </Form>
      </Modal>
        );
      })()}
      {/* Target setting modal */}
      <Modal title={editTarget?.id ? '编辑目标' : '设定领域成本目标'} open={targetModal} onOk={async () => { const v = await targetForm.validateFields(); await saveTarget({ ...editTarget, project_id: selectedPid, ...v }); setTargetModal(false); setEditTarget(null); loadTargets(selectedPid!); message.success('已保存'); }} onCancel={() => { setTargetModal(false); setEditTarget(null); }} width={400} destroyOnClose>
        <Form form={targetForm} layout="vertical">
          <Form.Item label="领域" name="domain" rules={[{ required: true }]}><Select options={mainCats.map(c=>({label:c,value:c}))} /></Form.Item>
          <Form.Item label="目标成本(¥)" name="target_cost" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} prefix="¥" /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>

      {/* 品类管理 */}
      <Modal title="品类管理" open={catModalOpen} onCancel={() => setCatModalOpen(false)} footer={null} width={420}>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          品类用于区分不同类型的产品项目（如显示器、手写笔、鼠标）。新建项目时选择品类，项目管理按品类筛选。
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Input placeholder="新品类名称" value={newCatName} onChange={e => setNewCatName(e.target.value)}
            onPressEnter={async () => {
              if (!newCatName.trim()) return;
              const m = await import('../db');
              try {
                await m.saveProductCategory({ name: newCatName.trim(), sort_order: 0 });
                setNewCatName(''); setCategories(await m.getProductCategories()); message.success('已添加');
              } catch (e: any) { message.error(e?.message || '添加失败（可能已存在）'); }
            }} />
          <Button type="primary" onClick={async () => {
            if (!newCatName.trim()) return;
            const m = await import('../db');
            try {
              await m.saveProductCategory({ name: newCatName.trim(), sort_order: 0 });
              setNewCatName(''); setCategories(await m.getProductCategories()); message.success('已添加');
            } catch (e: any) { message.error(e?.message || '添加失败（可能已存在）'); }
          }}>添加</Button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {categories.map((c: any) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
              <span style={{ flex: 1, fontSize: 13 }}>{c.name}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {c.name === '未分类' ? '（兜底品类，删除其他品类时项目归入此处，不可删）' : ''}
              </span>
              {c.name !== '未分类' && (
                <Popconfirm title={`删除品类「${c.name}」？其项目/竞品将归入「未分类」`} onConfirm={async () => {
                  const m = await import('../db');
                  await m.deleteProductCategory(c.id);
                  setCategories(await m.getProductCategories());
                  setCategoryFilter(''); loadProjects();
                  message.success('已删除');
                }}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              )}
            </div>
          ))}
        </div>
      </Modal>

      {/* ====== SKU 添加/编辑弹窗 ====== */}
      <Modal title={skuEdit ? '编辑 SKU' : '添加 SKU'} open={skuModal}
        onOk={async () => {
          const v = await skuForm.validateFields();
          await saveSku({ ...skuEdit, ...v, project_id: selectedPid });
          setSkuModal(false);
          await loadSkus(selectedPid!);
          message.success('SKU 已保存');
        }} onCancel={() => setSkuModal(false)} width={540} destroyOnClose>
        <Form form={skuForm} layout="vertical">
          <Form.Item label="SKU 代号*" name="sku_code" rules={[{ required: true }]}><Input placeholder="如：M270-2K / M270-4K / M270-Pro" /></Form.Item>
          <Form.Item label="名称" name="sku_name"><Input placeholder="可选，如：27寸2K 标准版" /></Form.Item>
          <Form.Item label="规格差异说明" name="spec_desc"><Input.TextArea rows={2} placeholder="与基座的差异描述，如：存储 64G→128G / 面板换 4K / 加升降支架" /></Form.Item>
          <Form.Item label="备注" name="remark"><Input /></Form.Item>
        </Form>
      </Modal>

      {/* ====== SKU 详情弹窗：合并 BOM（基座+差异）+ 差异规则管理 ====== */}
      <Modal title={skuDetail ? `SKU 详情：${skuDetail.sku_code}${skuDetail.sku_name ? ' ' + skuDetail.sku_name : ''}` : 'SKU 详情'}
        open={!!skuDetail} onCancel={() => setSkuDetail(null)} footer={null} width={980}
        styles={{ body: { maxHeight: '75vh', overflow: 'auto' } }}>
        {skuDetail && (() => {
          const c = calcSku(skuDetail);
          const bom = buildSkuBom(skuDetail);
          const diffs = skuDiffsMap[skuDetail.id] || [];
          return (
            <div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
                <div><div style={{ fontSize: 10.5, color: '#94A3B8' }}>基座 BOM 成本</div><b style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>¥{bomTotal.toFixed(2)}</b></div>
                <div><div style={{ fontSize: 10.5, color: '#94A3B8' }}>差异合计</div><b style={{ fontSize: 16, color: c.delta > 0 ? '#D97706' : c.delta < 0 ? '#10B981' : '#64748B', fontVariantNumeric: 'tabular-nums' }}>{c.delta > 0 ? '+' : ''}{c.delta.toFixed(2)}</b></div>
                <div><div style={{ fontSize: 10.5, color: '#94A3B8' }}>SKU 整机成本</div><b style={{ fontSize: 22, color: '#CF0A2C', fontVariantNumeric: 'tabular-nums' }}>¥{c.cost.toFixed(2)}</b></div>
                {skuDetail.spec_desc && <div style={{ maxWidth: 320 }}><div style={{ fontSize: 10.5, color: '#94A3B8' }}>规格差异</div><span style={{ fontSize: 12 }}>{skuDetail.spec_desc}</span></div>}
              </div>
              {c.issues.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="差异引用问题（基座中找不到对应器件）" description={c.issues.join('；')} />}
              {/* 合并 BOM（按模块分组） */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>合并 BOM（基座 + 差异合成，仅展示不落库）——绿=新增 红=移除 黄=替换</div>
                {Object.entries(bom.byMod).map(([mod, m]: any) => (
                  <div key={mod} style={{ marginBottom: 8, border: '1px solid #E8ECF1', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ background: '#F8FAFC', padding: '5px 10px', display: 'flex', justifyContent: 'space-between' }}>
                      <b style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><EmojiIcon e="📦" /> {mod}</b>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#CF0A2C', fontVariantNumeric: 'tabular-nums' }}>¥{m.subtotal.toFixed(4)}</span>
                    </div>
                    <Table size="small" pagination={false} rowKey={(r: any) => String(r.id)} dataSource={m.items} columns={[
                      { title: '名称', dataIndex: 'part_name', width: 170, ellipsis: true, render: (v: string, r: any) => <span style={{ textDecoration: r._skuStatus === 'removed' ? 'line-through' : 'none', color: r._skuStatus === 'removed' ? '#94A3B8' : undefined }}>{v}</span> },
                      { title: '型号', dataIndex: 'part_model', width: 160, ellipsis: true, render: (v: string, r: any) => r._skuStatus === 'replaced' && r._newModel
                        ? <span><span style={{ textDecoration: 'line-through', color: '#94A3B8' }}>{v}</span> <b style={{ color: '#D97706' }}>→ {r._newModel}</b></span>
                        : v },
                      { title: '单价', key: 'cost', width: 140, align: 'right' as const, render: (_: any, r: any) => r._skuStatus === 'replaced'
                        ? <span><span style={{ textDecoration: 'line-through', color: '#94A3B8' }}>{(r.part_cost || 0).toFixed(4)}</span> <b style={{ color: '#D97706' }}>→ {(r._newCost || 0).toFixed(4)}</b></span>
                        : <span style={{ fontVariantNumeric: 'tabular-nums' }}>{(r.part_cost || 0).toFixed(4)}</span> },
                      { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const, render: (v: number, r: any) => r._skuStatus === 'replaced' ? <b style={{ color: '#D97706' }}>{r._newQty ?? v}</b> : v },
                      { title: '小计', key: 'sub', width: 110, align: 'right' as const, render: (_: any, r: any) => {
                        const amt = r._skuStatus === 'replaced' ? (r._newCost || 0) * (r._newQty ?? (r.quantity || 1)) : (r.part_cost || 0) * (r.quantity || 1);
                        return <b style={{ fontVariantNumeric: 'tabular-nums' }}>¥{amt.toFixed(4)}</b>;
                      } },
                      { title: '', key: 'tag', width: 62, render: (_: any, r: any) => r._skuStatus === 'added' ? <Tag color="green">新增</Tag> : r._skuStatus === 'removed' ? <Tag color="red">移除</Tag> : r._skuStatus === 'replaced' ? <Tag color="orange">替换</Tag> : null },
                    ]} />
                  </div>
                ))}
              </div>
              {/* 差异规则管理 */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: '#64748B' }}>差异规则（{diffs.length}）——基座成本变化自动联动</span>
                  <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setDiffSkuId(skuDetail.id); setDiffEdit(null); diffForm.resetFields(); setDiffModal(true); }}>添加差异</Button>
                </div>
                <Table size="small" pagination={false} rowKey="id" dataSource={diffs} columns={[
                  { title: '动作', dataIndex: 'diff_type', width: 70, render: (v: string) => v === 'add' ? <Tag color="green">加</Tag> : v === 'remove' ? <Tag color="red">减</Tag> : <Tag color="orange">换</Tag> },
                  { title: '模块', dataIndex: 'module_name', width: 120, ellipsis: true },
                  { title: '器件', dataIndex: 'part_name', width: 170, ellipsis: true },
                  { title: '型号', dataIndex: 'part_model', width: 160, ellipsis: true, render: (v: string, r: any) => r.diff_type === 'replace' && r.new_model
                    ? <span><span style={{ color: '#94A3B8' }}>{v}</span> <b style={{ color: '#D97706' }}>→ {r.new_model}</b></span>
                    : v },
                  { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const },
                  { title: '单价', dataIndex: 'unit_cost', width: 100, align: 'right' as const, render: (v: number, r: any) => r.diff_type === 'remove' ? <span style={{ color: '#94A3B8' }}>—</span> : <span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{Number(v || 0).toFixed(4)}</span> },
                  { title: '备注', dataIndex: 'remark', ellipsis: true },
                  { title: '操作', width: 80, render: (_: any, r: any) => (
                    <Space size={0}>
                      <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setDiffSkuId(skuDetail.id); setDiffEdit(r); diffForm.setFieldsValue(r); setDiffModal(true); }} />
                      <Popconfirm title="删除差异？" onConfirm={async () => {
                        await deleteSkuDiff(r.id);
                        const l = await getSkus(selectedPid!); setSkus(l);
                        setSkuDiffsMap(await getAllSkuDiffs(l.map(s => s.id)));
                        setSkuDetail({ ...skuDetail });
                      }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
                    </Space>
                  )},
                ]} />
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* ====== 差异添加/编辑弹窗 ====== */}
      <Modal title={diffEdit ? '编辑差异' : '添加差异'} open={diffModal}
        onOk={async () => {
          const v = await diffForm.validateFields();
          const data: any = { ...diffEdit, ...v, sku_id: diffSkuId };
          delete data._base;
          await saveSkuDiff(data);
          setDiffModal(false);
          const l = await getSkus(selectedPid!); setSkus(l);
          setSkuDiffsMap(await getAllSkuDiffs(l.map(s => s.id)));
          if (skuDetail) setSkuDetail({ ...skuDetail });
          message.success('差异已保存');
        }} onCancel={() => setDiffModal(false)} width={600} destroyOnClose>
        <Form form={diffForm} layout="vertical" initialValues={{ diff_type: 'add', quantity: 1 }}>
          <Form.Item label="动作" name="diff_type" rules={[{ required: true }]}>
            <Radio.Group optionType="button" buttonStyle="solid"
              options={[{ label: '加（新增器件/模块）', value: 'add' }, { label: '减（移除基座器件）', value: 'remove' }, { label: '换（替换单价/数量）', value: 'replace' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a: any, b: any) => a.diff_type !== b.diff_type}>
            {({ getFieldValue }) => {
              const t = getFieldValue('diff_type') || 'add';
              return (
                <>
                  {t !== 'add' && (
                    <Form.Item label="选择基座器件" name="_base" rules={[{ required: true, message: '请选择基座 BOM 中的器件' }]}>
                      <Select showSearch placeholder="搜索基座 BOM 器件（模块/名称/型号）" options={skuBasePartOptions}
                        onChange={(v: string) => {
                          const m = skuPickBase(v);
                          if (m) diffForm.setFieldsValue({ module_name: m.module_name, part_name: m.part_name, part_model: m.part_model, quantity: t === 'replace' ? m.quantity : undefined });
                        }} />
                    </Form.Item>
                  )}
                  {t === 'add' && (
                    <>
                      <Form.Item label="模块名" name="module_name" rules={[{ required: true }]}><Input placeholder="如：升降支架模块（可以是基座没有的新模块）" /></Form.Item>
                      <Row gutter={12}>
                        <Col span={12}><Form.Item label="器件名称" name="part_name" rules={[{ required: true }]}><Input /></Form.Item></Col>
                        <Col span={12}><Form.Item label="型号" name="part_model"><Input /></Form.Item></Col>
                      </Row>
                    </>
                  )}
                  <Row gutter={12}>
                    <Col span={8}><Form.Item label="数量" name="quantity" rules={[{ required: true }]}><InputNumber min={0} step={0.000001} style={{ width: '100%' }} /></Form.Item></Col>
                    {(t === 'add' || t === 'replace') && <Col span={8}><Form.Item label={t === 'replace' ? '新单价(¥)' : '单价(¥)'} name="unit_cost" rules={[{ required: true }]}><InputNumber min={0} precision={4} style={{ width: '100%' }} /></Form.Item></Col>}
                    <Col span={t === 'add' || t === 'replace' ? 8 : 16}><Form.Item label="备注" name="remark"><Input /></Form.Item></Col>
                  </Row>
                  {t === 'replace' && (
                    <Form.Item label="新型号（可选）" name="new_model" extra="留空 = 只换单价/数量；填写 = 替换型号（如 8GB → 16GB）">
                      <Input placeholder="如：16GB" />
                    </Form.Item>
                  )}
                  {(t === 'remove' || t === 'replace') && (
                    <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: -4 }}>
                      {t === 'remove' ? '移除后该器件从 SKU 中删除（成本扣除基座小计）' : '替换后按新单价/数量计成本，自动计算与基座的差额'}
                    </div>
                  )}
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      {/* ====== 新增差异器件弹窗（对比表加行） ====== */}
      <Modal title="新增差异器件" open={addPartModal}
        onOk={saveAddPart} onCancel={() => setAddPartModal(false)} width={560} destroyOnClose>
        <Form form={addPartForm} layout="vertical" initialValues={{ quantity: 1 }}>
          <Form.Item label="添加到 SKU*" name="target_sku" rules={[{ required: true, message: '请选择目标 SKU' }]}>
            <Select options={skus.map(s => ({ label: `${s.sku_code}${s.sku_name ? ' ' + s.sku_name : ''}`, value: s.id }))} placeholder="选择要添加器件的 SKU" />
          </Form.Item>
          <Form.Item label="模块名*" name="module_name" rules={[{ required: true }]}><Input placeholder="如：升降支架模块（可以是基座没有的新模块）" /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="器件名称*" name="part_name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="型号" name="part_model"><Input /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="数量" name="quantity" rules={[{ required: true }]}><InputNumber min={0} step={0.000001} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item label="单价(¥)" name="unit_cost" rules={[{ required: true }]}><InputNumber min={0} precision={4} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* ====== SKU 差异导入预览弹窗 ====== */}
      <Modal title={`SKU 差异导入预览 (${skuImportRows.length} 条)`} open={skuImportModal} onOk={doSkuImport} onCancel={() => { setSkuImportModal(false); setSkuImportRows([]); }} width={880} okText="确认导入" okButtonProps={{ disabled: skuImportRows.some((r: any) => (r._issues || []).length > 0) }}>
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5 }}>导入到 SKU：</span>
          <Select size="small" style={{ width: 260 }} value={skuImportTarget} onChange={v => setSkuImportTarget(v)}
            options={skus.map(s => ({ label: `${s.sku_code}${s.sku_name ? ' ' + s.sku_name : ''}`, value: s.id }))} />
          <span style={{ fontSize: 11.5, color: '#94A3B8' }}>
            列：模块 / 器件名称 / 型号 / 数量 / 单价；基座中已存在的器件自动识别为<b>替换</b>，否则为<b>新增</b>；与基座一致的行自动跳过
          </span>
        </div>
        <Table size="small" pagination={false} rowKey={(_: any, i: any) => String(i)} dataSource={skuImportRows}
          rowClassName={(r: any) => (r._issues || []).length > 0 ? 'ant-table-row-danger' : ''}
          columns={[
            { title: '模块', dataIndex: 'module_name', width: 110, ellipsis: true },
            { title: '器件名称', dataIndex: 'name', width: 170, ellipsis: true },
            { title: '型号', dataIndex: 'model', width: 140, ellipsis: true },
            { title: '数量', dataIndex: 'quantity', width: 70, align: 'center' as const },
            { title: '单价(¥)', dataIndex: 'cost', width: 100, align: 'right' as const, render: (v: number) => v.toFixed(4) },
            {
              title: '导入动作', key: 'action', width: 240,
              render: (_: any, r: any) => (r._issues || []).length > 0
                ? <span style={{ color: '#DC2626', fontSize: 12 }}>⚠️ {(r._issues || []).join('；')}</span>
                : (() => { const a = skuImportAction(r, skuImportTarget ?? 0); const color = a.action === 'replace' ? 'orange' : a.action === 'restore' ? 'blue' : a.action === 'skip' ? 'default' : 'green'; return <Tag color={color}>{a.label}</Tag>; })(),
            },
          ]} />
      </Modal>

      {/* ====== 跨项目报价比对弹窗（同模块；规则分组实时 + AI 疑似后台识别 + 人工确认沉淀） ====== */}
      <Modal title={<span><BarChartOutlined /> 跨项目报价比对 · {cmpModule}</span>} open={cmpModal} onCancel={() => setCmpModal(false)} footer={null} width={860}
        styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}>
        {/* 状态条：AI 识别中 → 机器人呼吸闪烁 */}
        <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 28 }}>
          {cmpAiBusy ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#0A84FF', fontSize: 12.5, fontWeight: 500 }}>
              <RobotOutlined className="ai-breathe" style={{ fontSize: 17 }} />
              AI 正在识别疑似物料…（{cmpRows.length} 行）
            </span>
          ) : (
            <>
              {cmpLastAt && <span style={{ fontSize: 11.5, color: '#94A3B8' }}>上次识别：{cmpLastAt}</span>}
              {cmpRows.length > 0 && <Button size="small" onClick={rerunAiIdentify}>重新识别</Button>}
            </>
          )}
          {cmpAiError && <span style={{ fontSize: 11.5, color: '#DC2626' }}>{cmpAiError}</span>}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>
            {cmpRows.length} 行 · {projects.filter(p => (p.category || '') === (selectedProject?.category || '')).length} 个项目（同品类）
          </span>
        </div>
        {/* 规则组：同名同型号 / 已确认别名，实时免费 */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>▍已归组（同名同型号 / 已确认别名）</div>
          {cmpRuleGroups.length === 0 && <div style={{ fontSize: 12, color: '#CBD5E1', padding: '8px 4px' }}>该模块暂无跨项目报价数据</div>}
          {cmpRuleGroups.map(g => {
            const prices = g.rows.map((r: any) => r.cost);
            const min = Math.min(...prices); const max = Math.max(...prices);
            const diff = max - min;
            return (
              <div key={g.key} style={{ border: '1px solid #E8ECF1', borderRadius: 8, marginBottom: 6, padding: '8px 12px', background: '#FAFBFC' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <b style={{ fontSize: 12.5 }}>{g.canonical}</b>
                  {g.rows.length > 1 && <Tag color={diff > 0 ? 'orange' : 'green'} style={{ margin: 0 }}>{diff > 0 ? `价差 ¥${diff.toFixed(2)}` : '价格一致'}</Tag>}
                  {g.rows.length > 1 && <Tag style={{ margin: 0 }}>{g.rows.length} 项目</Tag>}
                </div>
                {g.rows.map((r: any, i: number) => (
                  <div key={i} style={{ fontSize: 12, display: 'flex', gap: 10, alignItems: 'center', padding: '1px 0' }}>
                    <b style={{ width: 70 }}>{r.project}</b>
                    <span style={{ width: 180, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} {r.model}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{r.cost.toFixed(2)} × {r.quantity}</span>
                    {diff > 0 && r.cost === max && <Tag color="red" style={{ margin: 0, fontSize: 10 }}>最高</Tag>}
                    {diff > 0 && r.cost === min && <Tag color="green" style={{ margin: 0, fontSize: 10 }}>最低</Tag>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {/* AI 疑似组：人工确认后沉淀别名 */}
        <div>
          <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>▍AI 疑似同一物料（人工确认后永久归组）</div>
          {!cmpAiBusy && cmpAiGroups.length === 0 && !cmpAiError && <div style={{ fontSize: 12, color: '#CBD5E1', padding: '8px 4px' }}>暂无疑似组——已全部归组或无需识别</div>}
          {cmpAiGroups.map((g, gi) => {
            const prices = g.rows.map((r: any) => r.cost);
            const diff = Math.max(...prices) - Math.min(...prices);
            return (
              <div key={gi} style={{ border: '1px dashed #C7D2FE', borderRadius: 8, marginBottom: 6, padding: '8px 12px', background: '#F5F7FF' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <b style={{ fontSize: 12.5, color: '#4F46E5' }}>❓ {g.name}</b>
                  <Tag color="purple" style={{ margin: 0 }}>疑似同一物料</Tag>
                  {diff > 0 && <Tag color="orange" style={{ margin: 0 }}>价差 ¥{diff.toFixed(2)}</Tag>}
                </div>
                {g.reason && <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 4 }}>AI 判断：{g.reason}</div>}
                {g.rows.map((r: any, i: number) => (
                  <div key={i} style={{ fontSize: 12, display: 'flex', gap: 10, padding: '1px 0' }}>
                    <b style={{ width: 70 }}>{r.project}</b>
                    <span style={{ width: 180, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} {r.model}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{r.cost.toFixed(2)} × {r.quantity}</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                  <Button size="small" type="primary" onClick={() => confirmAiGroup(g)}>✓ 确认同一器件</Button>
                  <Button size="small" onClick={() => rejectAiGroup(g)}>标记不同</Button>
                </div>
              </div>
            );
          })}
        </div>
      </Modal>

      {/* ====== 报价情报弹窗（后台自动识别发现的问题） ====== */}
      <Modal title={<span><BulbOutlined /> AI 情报中心（报价差异 · 自主建议 · 巡检发现）</span>} open={insightModal} onCancel={() => setInsightModal(false)} footer={null} width={820}
        styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}>
        <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Segmented size="small" value={aiTab} onChange={(v: any) => setAiTab(v as any)}
            options={[{ label: '📊 报价差异', value: 'diff' }, { label: '💡 自主建议', value: 'advice' }, { label: '🔍 巡检发现', value: 'audit' }]} />
          <span style={{ fontSize: 11.5, color: '#94A3B8' }}>
            {aiTab === 'diff' ? '跨项目同物料报价差异（确认/标记/归档）' : aiTab === 'advice' ? '成本机会/风险点（后台规则发现 + AI 润色）' : '数据质量与风险检查（可标记已读/忽略）'}
          </span>
        </div>
        {aiTab === 'advice' && (
          <div>
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button size="small" type={adviceShowDone ? 'default' : 'primary'} onClick={() => setAdviceShowDone(!adviceShowDone)}>
                {adviceShowDone ? '显示全部' : '仅看待处理'}{(() => { const c = adviceList.filter((x: any) => x.status !== 'open').length; return c > 0 ? `（已处理 ${c}）` : ''; })()}
              </Button>
              <span style={{ fontSize: 11.5, color: '#94A3B8' }}>处理入口与完整详情见驾驶舱「待处理事项」</span>
            </div>
            {(() => {
              const list = adviceShowDone ? adviceList : adviceList.filter((x: any) => x.status === 'open');
              if (list.length === 0) return <div style={{ textAlign: 'center', padding: 30, color: '#94A3B8', fontSize: 12 }}>暂无建议——系统空闲时自动分析成本机会/风险点</div>;
              return list.map((a: any) => (
                <div key={a.id} style={{ border: '1px solid #E9D5FF', borderLeft: '3px solid #7C3AED', borderRadius: 8, padding: '8px 12px', marginBottom: 6, background: a.status === 'open' ? 'var(--color-surface, #fff)' : '#FAFAFA', opacity: a.status === 'open' ? 1 : 0.7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>{a.title}</b>
                    <Tag color="purple" style={{ margin: 0, fontSize: 10.5 }}>自主建议</Tag>
                    {a.status !== 'open' && <Tag style={{ margin: 0, fontSize: 10.5 }} color={a.status === 'done' ? 'green' : 'default'}>{a.status === 'done' ? '已处理' : '已忽略'}</Tag>}
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>{(a.created_at || '').slice(0, 16)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.6, marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.detail}</div>
                  {a.status === 'open' && (
                    <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                      <Button size="small" type="primary" onClick={async () => { try { await updateAdvisorStatus(a.id, 'done'); window.dispatchEvent(new CustomEvent('costhub-advisor-done')); const r = await getAdvisorInsights(); setAdviceList(r); } catch (e: any) { message.error('操作失败：' + String(e?.message || e)); } }}>✓ 已处理</Button>
                      <Button size="small" onClick={async () => { try { await updateAdvisorStatus(a.id, 'dismissed'); window.dispatchEvent(new CustomEvent('costhub-advisor-done')); const r = await getAdvisorInsights(); setAdviceList(r); } catch (e: any) { message.error('操作失败：' + String(e?.message || e)); } }}>忽略</Button>
                    </div>
                  )}
                </div>
              ));
            })()}
          </div>
        )}
        {aiTab === 'audit' && (
          <div>
            {(() => {
              const list = auditList;
              if (list.length === 0) return <div style={{ textAlign: 'center', padding: 30, color: '#94A3B8', fontSize: 12 }}>暂无巡检发现——数据无异常时保持安静</div>;
              return list.map((ft: any) => (
                <div key={ft.id} style={{ padding: '9px 12px', background: ft.level === 'warn' ? '#FFFBEB' : '#F0F7FF', border: ft.level === 'warn' ? '1px solid #FDE68A' : '1px solid #BFDBFE', borderRadius: 8, marginBottom: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                    <Tag color={ft.level === 'warn' ? 'orange' : 'blue'} style={{ margin: 0, flexShrink: 0, fontSize: 10.5 }}>{ft.source === 'ai' ? 'AI 洞察' : '规则发现'}</Tag>
                    <b style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>{ft.title}</b>
                    <a style={{ fontSize: 11.5, flexShrink: 0 }} onClick={async (e) => { e.stopPropagation(); if (ft.status === 'unread') { try { await markAuditRead(ft.id); } catch {} } else { try { await dismissAuditFinding(ft.id); } catch {} } try { setAuditList(await getAuditFindings()); } catch {} window.dispatchEvent(new CustomEvent('costhub-audit-changed')); window.dispatchEvent(new CustomEvent('costhub-insights-changed')); }}>{ft.status === 'unread' ? '标记已读' : '忽略'}</a>
                  </div>
                  <div style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.6 }}>{ft.detail}</div>
                  {ft.suggestion && <div style={{ marginTop: 4, fontSize: 11.5, color: '#3730A3' }}><b>💡 建议：</b>{ft.suggestion}</div>}
                </div>
              ));
            })()}
          </div>
        )}
        {aiTab === 'diff' && (
        <>
        <div style={{ marginBottom: 10, fontSize: 12, color: '#94A3B8' }}>
          导入 BOM 或报价变动后自动后台识别；发现"疑似同物料但报价差异明显"时在此提醒。
          确认同一 → 沉淀别名自动归组（组即消除，不再重现）；标记不同 → AI 永不再建议；归档（已读）→ 移出待处理，可在「全部」查看或恢复。
        </div>
        <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Segmented size="small" value={insightView} options={[{ label: '待处理', value: 'pending' }, { label: '全部', value: 'all' }, { label: '已处理', value: 'done' }]}
            onChange={(v: any) => { setInsightView(v); setInsightSelected(new Set()); }} />
          <span style={{ fontSize: 11.5, color: '#94A3B8' }}>待处理 = 未读；「已处理」保留确认/标记记录，可撤销恢复</span>
          {insightSelected.size > 0 && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#475569' }}>已选 <b>{insightSelected.size}</b> 个模块</span>
              <Button size="small" type="primary" onClick={batchConfirmInsights}>✓ 批量确认同一</Button>
              <Button size="small" onClick={batchArchiveInsights}>归档（已读）</Button>
              <Button size="small" type="text" onClick={clearInsightSelect}>取消</Button>
            </span>
          )}
        </div>
        {(() => {
          if (insightView === 'done') {
            const doneList = insights.filter(ins => {
              try { return (JSON.parse(ins.handled_json || '[]') || []).length > 0; } catch { return false; }
            });
            if (doneList.length === 0) {
              return <div style={{ textAlign: 'center', padding: 40, color: '#94A3B8', fontSize: 12 }}>暂无已处理记录——确认同一/标记不同后会记录在这里，可随时撤销</div>;
            }
            return doneList.map((ins: any, idx: number) => {
              let handled: any[] = [];
              try { handled = JSON.parse(ins.handled_json || '[]'); } catch { handled = []; }
              return (
                <div key={idx} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
                    📦 {ins.module_name} <Tag color="green" style={{ marginLeft: 8 }}>已处理 {handled.length} 组</Tag>
                  </div>
                  {handled.map((h: any, hi: number) => (
                    <div key={hi} style={{ border: '1px solid #E8ECF1', borderRadius: 8, marginBottom: 6, padding: '8px 12px', background: '#FAFBFC' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <b style={{ fontSize: 12.5, color: h.action === 'confirmed' ? '#16A34A' : '#DC2626' }}><EmojiIcon e={h.action === 'confirmed' ? '✓' : '✗'} /> {h.name}</b>
                        <Tag color={h.action === 'confirmed' ? 'green' : 'red'} style={{ margin: 0 }}>{h.action === 'confirmed' ? '已确认同一' : h.action === 'row_different' ? '已标记不是同一器件' : '已标记不同'}</Tag>
                        <span style={{ fontSize: 10.5, color: '#94A3B8' }}>{h.handled_at}</span>
                      </div>
                      {(h.rows || []).map((r: any, ri: number) => (
                        <div key={ri} style={{ fontSize: 12, display: 'flex', gap: 8, padding: '2px 0', alignItems: 'center' }}>
                          <b style={{ width: 60, flexShrink: 0 }}>{r.project}</b>
                          {r.sub_category && <Tag color="geekblue" style={{ margin: 0, fontSize: 10.5, flexShrink: 0 }}>{r.sub_category}</Tag>}
                          <span style={{ flex: 1, minWidth: 0, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}
                            title={`${r.name} ${r.model}${r.specs ? '\n规格：' + r.specs : ''}`}>{r.name} {r.model}</span>
                          <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>¥{r.cost.toFixed(4)} × {r.quantity}</span>
                        </div>
                      ))}
                      <div style={{ marginTop: 6 }}>
                        <Button size="small" onClick={() => undoHandledInsight(ins, hi)}>↩ 撤销（恢复该组重新识别）</Button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            });
          }
          const list = insights.filter(ins => insightView === 'pending' ? ins.status === 'unread' : true);
          return list.length === 0
            ? <div style={{ textAlign: 'center', padding: 40, color: '#94A3B8', fontSize: 12 }}>
                {insightView === 'pending' ? '没有待处理的情报（未读）——导入 BOM 或修改报价后会自动后台识别' : '暂无情报——导入 BOM 或修改报价后会自动后台识别'}
              </div>
            : list.map((ins, idx) => {
                let data: any[] = [];
                try { data = JSON.parse(ins.insight_json); } catch { data = []; }
                return (
                  <div key={idx} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Checkbox checked={insightSelected.has(ins.id)} onChange={() => toggleInsightSelect(ins.id)} />
                      <span>📦 {ins.module_name}</span>
                      {ins.status === 'unread' && <Tag color="red" style={{ margin: 0 }}>未读</Tag>}
                      {ins.status === 'read' && data.length > 0 && <Tag color="default" style={{ margin: 0 }}>已归档</Tag>}
                      {data.length === 0 && <Tag color="green" style={{ margin: 0 }}>已核对 ✓</Tag>}
                    </div>
                    {data.length === 0 && <div style={{ fontSize: 12, color: '#CBD5E1', padding: '4px 8px' }}>无异常（报价均在正常范围）</div>}
              {data.map((g: any, gi: number) => (
                <div key={gi} style={{ border: g.type === 'ai' ? '1px dashed #C7D2FE' : '1px solid #E8ECF1', borderRadius: 8, marginBottom: 6, padding: '8px 12px', background: g.type === 'ai' ? '#F5F7FF' : '#FAFBFC' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 12.5, color: g.type === 'ai' ? '#4F46E5' : '#334155' }}><EmojiIcon e={g.type === 'ai' ? '❓' : '📌'} /> {g.name}</b>
                    <Tag color={g.type === 'ai' ? 'purple' : 'orange'} style={{ margin: 0 }}>{g.type === 'ai' ? '疑似同一物料' : '报价差异明显'}</Tag>
                    <Tag color="red" style={{ margin: 0 }}>价差 ¥{(g.diff || 0).toFixed(2)}</Tag>
                    {(() => { let exCnt = 0; (g.rows || []).forEach((_: any, rri: number) => { if (rowExcluded.has(ins.id + '|' + gi + '|' + rri)) exCnt++; }); return exCnt > 0 ? <Tag color="volcano" style={{ margin: 0, fontSize: 10.5 }}>已排除 {exCnt} 行</Tag> : null; })()}
                  </div>
                  {g.reason && <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 4 }}>{g.reason}</div>}
                  {g.dimension && <div style={{ fontSize: 11.5, marginBottom: 4, color: '#1D4ED8', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 6, padding: '3px 8px', whiteSpace: 'pre-wrap' }}>{g.dimension}</div>}
                  {(() => {
                    const prices = g.rows.map((r: any) => r.cost || 0);
                    const maxP = Math.max(...prices), minP = Math.min(...prices);
                    const save = (maxP - minP) * Math.max(...g.rows.map((r: any) => r.quantity || 1));
                    return save > 0.01 ? (
                      <div style={{ fontSize: 11.5, marginBottom: 4, color: '#16A34A', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 6, padding: '3px 8px' }}>
                        <EmojiIcon e="💰" /> 若按最低价 ¥{minP.toFixed(2)} 谈，每台最多可省 <b>¥{save.toFixed(2)}</b>
                      </div>
                    ) : null;
                  })()}
                  {g.rows.map((r: any, ri: number) => {
                    const exKey = ins.id + '|' + gi + '|' + ri;
                    const isEx = rowExcluded.has(exKey);
                    return (
                      <div key={ri} style={{ fontSize: 12, display: 'flex', gap: 8, padding: '2px 0', alignItems: 'center', opacity: isEx ? 0.55 : 1 }}>
                        <b style={{ width: 60, flexShrink: 0, textDecoration: isEx ? 'line-through' : undefined }}>{r.project}</b>
                        {r.sub_category && <Tag color="geekblue" style={{ margin: 0, fontSize: 10.5, flexShrink: 0 }}>{r.sub_category}</Tag>}
                        <span style={{ flex: 1, minWidth: 0, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default', textDecoration: isEx ? 'line-through' : undefined }}
                          title={`${r.name} ${r.model}${r.specs ? '\n规格：' + r.specs : ''}`}>{r.name} {r.model}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>¥{r.cost.toFixed(4)} × {r.quantity}</span>
                        {isEx ? (
                          <Tag color="red" style={{ margin: 0, fontSize: 10.5, flexShrink: 0 }}>已排除</Tag>
                        ) : (
                          <Button size="small" type="text" danger style={{ fontSize: 11, padding: '0 4px', flexShrink: 0 }} loading={insightBusyKey === exKey} onClick={() => markRowDifferent(ins, g, gi, ri)}>✗ 不是同一器件</Button>
                        )}
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="small" type="primary" loading={insightBusyKey === (ins.id + '|' + gi)} onClick={() => confirmInsightGroup(ins, g, gi)}>✓ 确认同一器件</Button>
                    <Button size="small" loading={insightBusyKey === (ins.id + '|' + gi)} onClick={() => rejectInsightGroup(ins, g, gi)}>标记不同</Button>
                    <Button size="small" onClick={() => markKnownInsight(ins)}>{ins.status === 'read' ? '归档（已读）' : '知道了（归档）'}</Button>
                    {ins.status === 'read' && <Button size="small" onClick={() => restoreInsight(ins)}>↩ 恢复待处理</Button>}
                  </div>
                </div>
              ))}
                </div>
                );
              });
        })()}
        </>
        )}
      </Modal>

    </div>
  );
}
