import { useEffect, useState, useMemo, useRef } from 'react';
import { Table, Button, Input, Select, Space, Modal, Form, InputNumber, Tag, message, Popconfirm, Tabs, Row, Col, Tooltip, Card, Statistic, Upload, Alert, DatePicker, Checkbox, AutoComplete, Radio, Tree, Badge } from 'antd';
import { PlusOutlined, PlusCircleOutlined, EditOutlined, DeleteOutlined, CopyOutlined, UploadOutlined, DownloadOutlined, FileTextOutlined, InboxOutlined, DollarOutlined, TagOutlined, LineChartOutlined, BarChartOutlined, ToolOutlined, CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined, AimOutlined, BuildOutlined, HistoryOutlined, EyeOutlined, CheckOutlined, CloseOutlined, RobotOutlined, BulbOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { getProjects, saveProject, deleteProject, copyProject, getProjectBOMs, addBOMItem, updateBOMItem, deleteBOMItem, getParts, getCostReviews, saveCostReview, deleteCostReview, getMeasures, saveMeasure, deleteMeasure, savePart, getModules, getModuleItems, saveModule, saveModuleItem, syncProjectModulesToLibrary, getTargets, saveTarget, deleteTarget, updateBOMRefProject, getProjectCostSnapshots, recordProjectCostSnapshot, deleteProjectCostSnapshot, getSnapshotBOMDetail, getProjectSuppliers, saveProjectSupplier, deleteProjectSupplier, getProjectSupplierPriceHistory, saveProjectSupplierPriceHistory, getSkus, saveSku, deleteSku, saveSkuDiff, deleteSkuDiff, getAllSkuDiffs, getAllSkus, getPartAliases, savePartAlias, getCompareCache, saveCompareCache, upsertInsight, normalizePartName, getInsights, markInsightRead } from '../db';
import { TIERS, PROJECT_STATUSES, PROJECT_TYPES, SCREEN_SIZES, RESOLUTIONS, REFRESH_RATES, PANEL_TYPES, MAIN_CATEGORIES, SUB_CATEGORIES, MEASURE_STATUSES, getCategoryColor } from '../constants';
import { getMainCategories, getSetting } from '../db';
import { startOllamaStream } from '../ollama';
import { calcSkuCost as calcSkuCostFn, buildSkuBom as buildSkuBomFn } from '../skuCalc';
import { estimateProjectCost } from '../specEstimate';
import { computeProjectHealth, type HealthIssue } from '../projectHealth';
import { computeProjectStatuses, statusPointMeta } from '../projectStatus';

/** 往 parts.projects 追加项目代号（去重，避免重复拼接） */
function appendProjectCode(existing: string | undefined, code: string): string {
  if (!code) return existing || '';
  const arr = (existing || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!arr.includes(code)) arr.push(code);
  return arr.join(',');
}

import DataTable, { ColumnSettingsButton } from '../components/DataTable';
import { chartTooltip, chartAxisStyle, chartTextMuted, chartSplitLine, barGradient } from '../chartTheme';
import { runAiIdentifyOnce, buildRuleGroups, moduleFingerprint, partKey, buildInsights } from '../autoCompare';

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  // 品类管理
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  // ====== 规格级项目预估（拿最像的历史项目估成本） ======
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [specForm] = Form.useForm();
  const [specResult, setSpecResult] = useState<any>(null);
  const [specLoading, setSpecLoading] = useState(false);
  const [histCosts, setHistCosts] = useState<Record<number, number>>({});
  const runSpecEstimate = async () => {
    const v = await specForm.validateFields();
    setSpecLoading(true);
    try {
      // 历史项目 BOM 成本（缓存，避免每次弹窗重复拉取）
      if (Object.keys(histCosts).length === 0) {
        const entries = await Promise.all(projects.map(async (p: any) => {
          const boms = await getProjectBOMs(p.id);
          return [p.id, Math.round(boms.reduce((s: number, b: any) => s + (b.part_cost || 0) * (b.quantity || 1), 0) * 100) / 100] as const;
        }));
        setHistCosts(Object.fromEntries(entries));
      }
      const history = projects.filter((p: any) => !p.is_deleted && (histCosts[p.id] || 0) > 0)
        .map((p: any) => ({ id: p.id, code: p.code, name: p.name, screen_size: p.screen_size, resolution: p.resolution, refresh_rate: p.refresh_rate, panel_type: p.panel_type, bomCost: histCosts[p.id] || 0 }));
      setSpecResult(estimateProjectCost(v, history));
    } catch (e: any) { message.error('估算失败：' + (e?.message || e)); }
    setSpecLoading(false);
  };
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
  const [navExpanded, setNavExpanded] = useState(false);

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

  const loadProjects = async () => { setLoading(true); try { setProjects(await getProjects('', typeFilter, categoryFilter)); } catch (e) { console.error(e); } setLoading(false); };
  useEffect(() => { loadProjects(); }, [typeFilter, categoryFilter]);
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
  // 品类→项目→SKU 树：全部 SKU（一次拉齐，与品类/项目组装成树）
  const [allSkus, setAllSkus] = useState<any[]>([]);
  const [skuTreeOpen, setSkuTreeOpen] = useState(false);
  useEffect(() => { getAllSkus().then(setAllSkus); }, []);
  const skuTreeData = useMemo(() => {
    const cats = [...new Set(projects.map(p => p.category || '未分类'))].sort();
    return cats.map(cat => {
      const projs = projects.filter(p => (p.category || '未分类') === cat);
      return {
        key: `cat-${cat}`, title: cat, type: 'category',
        children: projs.map(p => ({
          key: `proj-${p.id}`, title: `${p.code} ${p.name}`, type: 'project', projectId: p.id,
          children: allSkus.filter(s => s.project_id === p.id).map(s => ({
            key: `sku-${s.id}`, title: `${s.sku_code}${s.sku_name ? '  ' + s.sku_name : ''}`, type: 'sku', projectId: p.id, skuId: s.id, skuCode: s.sku_code,
          })),
        })),
      };
    });
  }, [projects, allSkus]);
  // 加载品类列表
  useEffect(() => {
    import('../db').then(async (m) => {
      await m.ensureDefaultCategories();
      setCategories(await m.getProductCategories());
    });
  }, []);

  const loadBOM = async (pid: number) => setBoms(await getProjectBOMs(pid));
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
  // 添加中的临时行：module → 名称/型号（未保存）
  const [addingRows, setAddingRows] = useState<Record<string, { name: string; model: string }>>({});
  const [addPartModal, setAddPartModal] = useState(false);
  const [addPartForm] = Form.useForm();
  const refreshSkus = async () => {
    const l = await getSkus(selectedPid!); setSkus(l);
    setSkuDiffsMap(await getAllSkuDiffs(l.map(s => s.id)));
  };
  // 行内保存：qty<=0 → 移除（基座行）/ 删除（新增行）；恢复基座值 → 自动还原
  const applyCell = async (skuId: number, row: any, qty: number, cost: number) => {
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
    } else if (qty === row.baseQty && cost === row.baseCost) {
      await clearBase(); // 改回基座值 → 还原
    } else {
      await clearBase();
      await saveSkuDiff({ sku_id: skuId, diff_type: 'replace', module_name: row.module, part_name: row.name, part_model: row.model, quantity: qty, unit_cost: cost });
    }
    await refreshSkus();
  };
  // 开始编辑某单元格（新增行还需先填名称/型号）
  const startEdit = (sku: any, row: any) => {
    const skuIdx = skus.findIndex(s => s.id === sku.id);
    const cell = row.skus[skuIdx];
    setEditingCell({ skuId: sku.id, rowKey: row.key });
    setEdQty(cell && cell.qty != null ? cell.qty : (row.baseQty ?? 1));
    setEdCost(cell && cell.cost != null ? cell.cost : (row.baseCost ?? 0));
  };
  const cancelEdit = () => setEditingCell(null);
  const saveEdit = async () => {
    if (!editingCell) return;
    const row = skuCompareRows.find(r => r.key === editingCell.rowKey);
    if (!row) { cancelEdit(); return; }
    if (row._isAdd && (!row.name || !row.model)) { message.warning('请先填写器件名称和型号'); return; }
    await applyCell(editingCell.skuId, row, edQty, edCost);
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
        rows.push({ project: p.code || p.name, projectId: p.id, name: b.part_name, model: b.part_model || '', cost: b.part_cost || 0, quantity: b.quantity || 1 });
      });
    }
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
  const [insights, setInsights] = useState<any[]>([]);
  const [unreadMods, setUnreadMods] = useState<Set<string>>(new Set());
  const loadInsights = async () => {
    const list = await getInsights();
    setInsights(list);
    setUnreadMods(new Set(list.filter(i => i.status === 'unread').map(i => i.module_name)));
  };
  // 变更后触发全局识别（App 监听 costhub-compare-request 立即执行；空闲时也会自动扫描）
  const scheduleAutoCompare = () => window.dispatchEvent(new CustomEvent('costhub-compare-request'));
  useEffect(() => {
    loadInsights();
    scheduleAutoCompare(); // 打开项目页立即触发一次（App 空闲监听会继续兜底）
    const onDone = () => loadInsights(); // 识别完成刷新情报红点
    window.addEventListener('costhub-compare-done', onDone);
    // 侧边栏「报价情报」入口点击 → 打开弹窗
    const onOpen = () => { loadInsights(); setInsightModal(true); };
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
      await upsertInsight(ins.category, ins.module_name, JSON.stringify(buildInsights(groups, rows, aliases)));
    } catch (e) {
      console.error('重算情报失败', e);
    }
    await loadInsights();
  };
  // 情报操作：确认同一 / 标记不同（沉淀别名，作用域=情报所属模块；处理后该组从情报消失）
  const confirmInsightGroup = async (ins: any, g: any) => {
    try {
      for (const r of g.rows) {
        await savePartAlias({ module_name: ins.module_name, alias_name: r.name, alias_model: r.model, canonical_name: g.name, canonical_model: '', source: 'user_confirmed' });
      }
      await rebuildModuleInsight(ins);
      await markInsightRead(ins.category, ins.module_name); // 保持已读，红点不闪
      window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
      message.success('已确认「' + g.name + '」，此后相同写法自动归组，该情报已消除');
    } catch (e: any) {
      console.error('确认同一失败:', e);
      message.error('确认失败：' + (e?.message || e));
    }
  };
  const rejectInsightGroup = async (ins: any, g: any) => {
    const keys = g.rows.map((r: any) => partKey(r)).sort().join(';');
    await savePartAlias({ module_name: ins.module_name, alias_name: `#NEG#${keys}`, alias_model: '', canonical_name: '', canonical_model: '', source: 'marked_different' });
    await rebuildModuleInsight(ins);
    await markInsightRead(ins.category, ins.module_name); // 保持已读，红点不闪
    window.dispatchEvent(new CustomEvent('costhub-insights-changed'));
    message.success('已标记不同，AI 不再建议该组合');
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
          if (rp) return { status: 'replaced' as const, cost: rp.unit_cost || 0, qty: rp.quantity ?? (b.quantity || 1) };
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
          { endpoint: 'native', json: false, think: false, num_predict: 200, temperature: 0.3 },
        );
      });
    } catch (e: any) {
      setHealthAiSummary(''); // 本地模型不可用时静默（规则条已足够）
    }
    setHealthAiLoading(false);
  };

  const selectProject = (pid: number) => {
    setSelectedPid(pid); loadBOM(pid); loadReviews(pid); loadCostSnapshots(pid); loadMeasures(pid); loadTargets(pid); loadProjectSuppliers(pid); loadSkus(pid);
    // 全局 AI 问询上下文（当前选中项目）
    localStorage.setItem('costhub-ctx', JSON.stringify({ page: 'projects', projectId: pid, code: projects.find((p: any) => p.id === pid)?.code || '' }));
    // 切换项目时自动退出参照对比模式（要对比再重新选择参照项目）
    setRefProjPid(null); setRefProjBoms([]); setModRefMap({});
  };
  const loadTargets = async (pid: number) => setTargets(await getTargets(pid));
  const loadModRef = async (modName: string, pid: number) => {
    if (!pid) { setModRefMap(prev => { const n = { ...prev }; delete n[modName]; return n; }); return; }
    const refBoms = await getProjectBOMs(pid);
    const modItems = refBoms.filter((b: any) => b.module_name === modName);
    setModRefMap(prev => ({ ...prev, [modName]: { pid, items: modItems } }));
    // Update all items in this module to reference this project
    if (selectedPid) await updateBOMRefProject(modName, selectedPid!, pid);
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
      await saveProject({ ...editing, ...vals });
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
  // Module grouping
  const moduleSummary: Record<string, number> = {};
  const groupedBOMs: Record<string, any[]> = {};
  boms.forEach(b => { const m = b.module_name || '未归类'; moduleSummary[m] = (moduleSummary[m] || 0) + (b.part_cost || 0) * b.quantity; if (!groupedBOMs[m]) groupedBOMs[m] = []; groupedBOMs[m].push(b); });
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

  const projectCols = [
    {
      title: '状态点',
      key: 'sp',
      width: 60,
      render: (_: any, r: any) => {
        const sp = projectStatuses[r.id];
        if (!sp || sp.level === 'none') return <span style={{ color: '#C0C8D0', fontSize: 16 }}>●</span>;
        const meta = statusPointMeta(sp.level);
        return (
          <Tooltip title={<div style={{ fontSize: 12 }}>{sp.reasons.map((x: string, i: number) => <div key={i}>• {x}</div>)}</div>}>
            <span style={{ color: meta.color, fontSize: 16, cursor: 'help' }}>●</span>
          </Tooltip>
        );
      }
    },
    { title: '代号', dataIndex: 'code', width: 95, render: (v: string) => <b>{v}</b> },
    { title: '名称', dataIndex: 'name', width: 180, ellipsis: true },
    { title: '品类', dataIndex: 'category', width: 75, render: (v: string) => <Tag color={v && v !== '显示器' ? 'purple' : 'default'}>{v || '显示器'}</Tag> },
    { title: '类型', dataIndex: 'project_type', width: 75, render: (v: string) => <Tag color={v === '已完成' ? 'green' : 'blue'}>{v || '在研'}</Tag> },
    { title: '状态', dataIndex: 'status', width: 75, render: (v: string) => <Tag color={v === '进行中' ? 'blue' : v === '已完成' ? 'green' : 'default'}>{v}</Tag> },
    { title: '规格', key: 's', width: 190, ellipsis: true, render: (_: any, r: any) => {
        const specs = [r.screen_size, r.resolution, r.refresh_rate, r.panel_type].filter(Boolean).join(' / ');
        return specs || (r.category && r.category !== '显示器' ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : '');
      } },
    { title: '费率', key: 'f', width: 95, render: (_: any, r: any) => `平台${r.platform_fee_rate}% / 利${r.profit_rate}%` },
    {
      title: '操作', width: 180, render: (_: any, r: any) => (
        <Space size="small">
          <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); form.setFieldsValue(r); setModalOpen(true); }} /></Tooltip>
          <Tooltip title="复制"><Button type="link" size="small" icon={<CopyOutlined />} onClick={() => { selectProject(r.id); setCopyModal(true); copyForm.setFieldsValue({ code: `${r.code}-CP`, name: `${r.name}(副本)` }); }} /></Tooltip>
          {r.project_type !== '已完成' && (
            <Popconfirm title="确定定型转为已完成？将自动入库新器件和模块。" onConfirm={async () => {
              await saveProject({ ...r, project_type: '已完成', status: '已完成' });
              // Sync all BOM parts to parts library
              const b = await getProjectBOMs(r.id);
              for (const item of b) {
                await savePart({ id: item.part_id, main_category: item.main_category, sub_category: item.sub_category, category: item.main_category, name: item.part_name, model: item.part_model, cost: item.part_cost, specs: item.part_specs || '', projects: appendProjectCode(item.projects, r.code), remark: '' }, false);
              }
              // 同步模块到模块库（modules/module_items）
              await syncProjectModulesToLibrary();
              message.success(`项目 [${r.code}] 已定型为已完成`);
              loadProjects();
            }}><Button type="link" size="small" style={{ color: '#10B981' }}>定型</Button></Popconfirm>
          )}
          <Popconfirm title="删除？" onConfirm={async () => { await deleteProject(r.id); loadProjects(); setSelectedPid(null); }}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
        </Space>
      ),
    },
  ];

  const bomCols = [
    { title: '模块', dataIndex: 'module_name', width: 85, render: (v: string) => v ? <Tag>{v}</Tag> : <Tag color="#ddd">未归类</Tag> },
    { title: '大类', dataIndex: 'main_category', width: 70, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
    { title: '子类', dataIndex: 'sub_category', width: 80 },
    { title: '名称', dataIndex: 'part_name', width: 180, ellipsis: true, render: (v: string, r: any) => r.is_module_item ? <span><Tag color="orange" style={{ marginRight: 4, fontSize: 10 }}>虚</Tag>{v}</span> : v },
    { title: '型号', dataIndex: 'part_model', width: 150, ellipsis: true },
    { title: '单价', dataIndex: 'part_cost', width: 85, align: 'right' as const, render: (v: number) => v?.toFixed(4) },
    { title: '数量', dataIndex: 'quantity', width: 60, align: 'center' as const, render: (v: number) => v != null ? (Number.isInteger(v) ? v : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')) : '-' },
    { title: '小计', key: 'sub', width: 90, align: 'right' as const, render: (_: any, r: any) => <b>{((r.part_cost || 0) * r.quantity).toFixed(4)}</b> },
    { title: '操作', width: 120, fixed: 'right' as const, render: (_: any, r: any) => (
      <Space size="small">
        <Button type="link" size="small" onClick={() => { setBomEdit(r); bomForm.setFieldsValue({ ...r, _part_name: r.part_name, _part_model: r.part_model, _main_category: r.main_category, _sub_category: r.sub_category, _cost: r.part_cost }); setBomModal(true); }}>编辑</Button>
        <Popconfirm title="移除？" onConfirm={async () => { await deleteBOMItem(r.id); loadBOM(selectedPid!); loadCostSnapshots(selectedPid!); scheduleAutoCompare(); }}><Button type="link" size="small" danger>删除</Button></Popconfirm>
      </Space>
    )},
  ];

  return (
    <div>
      <div className="page-title"><FileTextOutlined /> 项目管理</div>
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <Select placeholder="类型筛选" value={typeFilter || undefined} onChange={v => setTypeFilter(v || '')} allowClear style={{ width: 120 }} options={PROJECT_TYPES.map(s => ({ label: s, value: s }))} />
            <Select placeholder="品类筛选" value={categoryFilter || undefined} onChange={v => setCategoryFilter(v || '')} allowClear style={{ width: 130 }} options={categories.map((c: any) => ({ label: c.name, value: c.name }))} />
            <Button size="small" icon={<TagOutlined />} onClick={() => { setCatModalOpen(true); setNewCatName(''); }}>品类管理</Button>
          </Space>
          <Space>
            <Button icon={<AimOutlined />} onClick={() => { setSpecModalOpen(true); setSpecResult(null); specForm.resetFields(); }}>规格预估</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalOpen(true); }}>新建项目</Button>
          </Space>
        </div>
        {/* 品类→项目→SKU 树（SKU 变体导航） */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setSkuTreeOpen(o => !o)}>
            <TagOutlined style={{ color: '#0A84FF' }} />
            <b style={{ fontSize: 13 }}>品类 → 项目 → SKU 树</b>
            <span style={{ fontSize: 11, color: '#94A3B8' }}>{skuTreeOpen ? '收起 ▲' : '展开 ▼'}{allSkus.length > 0 ? `（${projects.length} 项目 / ${allSkus.length} SKU）` : '（暂无 SKU）'}</span>
          </div>
          {skuTreeOpen && (
            <div style={{ border: '1px solid #E8ECF1', borderRadius: 8, padding: '8px 10px', marginTop: 8, maxHeight: 300, overflow: 'auto', background: '#FAFBFC' }}>
              <Tree
                treeData={skuTreeData}
                defaultExpandAll
                onSelect={(_keys: any, e: any) => {
                  const n = e.node;
                  if (n.type === 'category') { setCategoryFilter(n.title); }
                  else if (n.type === 'project') { selectProject(n.projectId); }
                  else if (n.type === 'sku') {
                    selectProject(n.projectId);
                    setActiveTab('sku');
                    const sku = allSkus.find(s => s.id === n.skuId);
                    if (sku) setSkuDetail(sku);
                  }
                }}
                titleRender={(node: any) => (
                  <span style={{ fontSize: 12.5, color: node.type === 'category' ? '#0A84FF' : node.type === 'project' ? '#334155' : '#64748B', fontWeight: node.type === 'project' ? 600 : undefined }}>
                    {node.type === 'sku' && <Tag color="blue" style={{ fontSize: 10, marginRight: 4 }}>SKU</Tag>}{node.title}
                  </span>
                )}
              />
            </div>
          )}
        </div>
        <DataTable tableId="proj_list" dataSource={projects} columns={projectCols} rowKey="id" size="middle" loading={loading}
          onRow={(r) => ({ onClick: () => selectProject(r.id), style: { cursor: 'pointer', background: selectedPid === r.id ? '#FFF1F0' : undefined } })}
          pagination={{ pageSize: 15, showTotal: t => `共 ${t} 个项目` }} />
      </div>

      {selectedPid && (
        <div className="content-card" style={{ marginTop: 14 }}>
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
          <Row gutter={14} style={{ marginBottom: 14 }}>
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
              key: 'bom', label: <span><InboxOutlined /> BOM清单 ({boms.length}件)</span>, children: (
                <div style={{ position: 'relative', display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <Space>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={async () => { setAllParts(await getParts('', '', '')); setBomEdit(null); setPreviewModItems([]); bomForm.resetFields(); bomForm.setFieldsValue({ _addMode: 'module', quantity: 1, _quantity: 1, _cost: 0 }); setBomModal(true); }}>添加器件</Button>
                      <Upload beforeUpload={handleImportFile} showUploadList={false} accept=".xlsx,.xls"><Button size="small" icon={<UploadOutlined />}>导入</Button></Upload>
                      <Button size="small" icon={<DownloadOutlined />} onClick={() => { const data = boms.map(b => ({ 模块: b.module_name, 大类: b.main_category, 子类: b.sub_category, 器件名称: b.part_name, 型号: b.part_model, 单价: b.part_cost, 数量: b.quantity, 小计: (b.part_cost || 0) * b.quantity, 备注: b.remark })); const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'BOM'); XLSX.writeFile(wb, `BOM_${projects.find(p => p.id === selectedPid)?.code || 'export'}.xlsx`); message.success('已导出'); }}>导出</Button>
                    </Space>
                    {bomSelKeys.length > 0 && (
                      <Space>
                        <Tag color="blue">{bomSelKeys.length} 项选中</Tag>
                        <Tag color="red">合计: ¥{boms.filter(b => bomSelKeys.includes(b.id)).reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0).toFixed(2)}</Tag>
                        <Popconfirm title={`删除选中 ${bomSelKeys.length} 项？`} onConfirm={async () => { for (const id of bomSelKeys) await deleteBOMItem(Number(id), false); await recordProjectCostSnapshot(selectedPid!, 'parts_deleted', `批量删除 ${bomSelKeys.length} 个BOM项`); setBomSelKeys([]); loadBOM(selectedPid!); loadCostSnapshots(selectedPid!); scheduleAutoCompare(); message.success('已删除'); }}>
                          <Button size="small" danger icon={<DeleteOutlined />}>批量删除</Button>
                        </Popconfirm>
                      </Space>
                    )}
                    <ColumnSettingsButton tableId="bom_module_detail" columns={bomCols} />
                    {/* 参照项目：所有项目都可选参照对比（在研测算/已完成复核），排除当前项目自身 */}
                    <Select
                      size="small"
                      allowClear
                      placeholder="参照项目"
                      style={{ width: 170 }}
                      value={refProjPid || undefined}
                      onChange={v => loadRefProj(v || null)}
                      options={projects.filter((p: any) => p.id !== selectedPid).map((p: any) => ({ label: `[${p.code}] ${p.name}${p.project_type === '已完成' ? ' ✓' : ''}`, value: p.id }))}
                      />
                  </div>
                  {/* Module-grouped BOM with per-module reference */}
                  {sortedModNames.map((modName: string) => {
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
                    const extCols = hasRef ? [
                      ...bomCols.slice(0, -1),
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
                      bomCols[bomCols.length - 1],
                    ] : bomCols;
                    return (
                      <div key={modName} id={`module-${modName}`} style={{ marginBottom: 12, border: '1px solid #E8ECF1', borderRadius: 8, overflow: 'hidden', scrollMarginTop: 80 }}>
                        <div style={{ background: '#F8FAFC', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #E8ECF1' }}>
                          <Space>
                            <b style={{ fontSize: 13 }}>{modName}</b>
                            <Tag>{items.length} 件</Tag>
                            <Tag color="red">¥{modTotal.toFixed(4)}</Tag>
                            {hasRef && <Tag color="blue">参考: ¥{refTotal.toFixed(4)}</Tag>}
                            {hasRef && <Tag color={modTotal > refTotal ? 'red' : 'green'}>{modTotal > refTotal ? '+' : ''}¥{(modTotal - refTotal).toFixed(4)}</Tag>}
                          </Space>
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
                            <Select size="small" allowClear style={{ width: 200 }} placeholder="选项目参考此模块"
                              value={ref?.pid || undefined}
                              onChange={v => loadModRef(modName, v || 0)}
                              options={projects.filter((p: any) => p.id !== selectedPid).map((p: any) => ({ label: `[${p.code}] ${p.name}${p.project_type === '已完成' ? ' ✓' : ''}`, value: p.id }))} />
                          </Space>
                        </div>
                        <DataTable tableId="bom_module_detail" hideToolbar dataSource={items} columns={extCols} rowKey="id" size="small" pagination={false} scroll={{ x: 1100 }}
                          rowSelection={{ selectedRowKeys: bomSelKeys.filter(k => items.some(i => i.id === k)), onChange: (keys) => { const others = bomSelKeys.filter(k => !items.some(i => i.id === k)); setBomSelKeys([...others, ...keys]); } }}
                          summary={() => (
                            <Table.Summary.Row>
                              <Table.Summary.Cell index={0} colSpan={5}><b style={{ fontSize: 12 }}>{modName} 合计</b></Table.Summary.Cell>
                              <Table.Summary.Cell index={5} align="right"><b style={{ color: '#CF0A2C', fontSize: 13 }}>¥{modTotal.toFixed(4)}</b></Table.Summary.Cell>
                              {hasRef && <Table.Summary.Cell index={6} colSpan={3} align="right"><span style={{ color: '#64748B', fontSize: 12.5 }}>参考: ¥{refTotal.toFixed(4)} | 差异: {modTotal > refTotal ? '+' : ''}¥{(modTotal - refTotal).toFixed(4)}</span></Table.Summary.Cell>}
                            </Table.Summary.Row>
                          )} />
                      </div>
                    );
                  })}
                  {boms.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无BOM数据</div>}
                  </div>

                  {/* 模块快速导航侧边栏 */}
                  {Object.keys(groupedBOMs).length > 1 && (
                    <div
                      onMouseEnter={() => setNavExpanded(true)}
                      onMouseLeave={() => setNavExpanded(false)}
                      style={{
                        width: navExpanded ? 160 : 40,
                        flexShrink: 0,
                        background: '#F8FAFC',
                        border: '1px solid #E2E8F0',
                        borderRadius: 8,
                        transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                        overflowX: 'hidden',
                        overflowY: 'auto',
                        maxHeight: 600,
                        position: 'sticky',
                        top: 20,
                      }}>
                      <div style={{
                        width: 160,
                        padding: '12px',
                        opacity: navExpanded ? 1 : 0,
                        transition: 'opacity 0.2s ease',
                        pointerEvents: navExpanded ? 'auto' : 'none',
                      }}>
                        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12, fontWeight: 600, textAlign: 'center' }}>
                          模块导航
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {Object.keys(groupedBOMs).map(modName => (
                            <Button
                              key={modName}
                              size="small"
                              type="text"
                              onClick={() => {
                                const element = document.getElementById(`module-${modName}`);
                                if (element) {
                                  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                }
                              }}
                              style={{
                                textAlign: 'left',
                                height: 'auto',
                                padding: '8px 10px',
                                fontSize: 11,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                lineHeight: 1.4,
                                borderRadius: 6,
                              }}
                            >
                              <div style={{ fontWeight: 600, color: '#1E293B', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{modName}</div>
                              <div style={{ color: '#64748B', fontSize: 10 }}>{groupedBOMs[modName].length} 件</div>
                            </Button>
                          ))}
                        </div>
                      </div>
                      {!navExpanded && (
                        <div style={{
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%, -50%)',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 8,
                          cursor: 'pointer',
                        }}>
                          <div style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: '#64748B',
                            writingMode: 'vertical-rl',
                            textOrientation: 'mixed',
                          }}>
                            模块
                          </div>
                          <div style={{
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: '#E2E8F0',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 14,
                            color: '#64748B',
                          }}>
                            ›
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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
                                            { endpoint: 'native', json: false, think: false, num_predict: 300, temperature: 0.3 },
                                          );
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
                    💡 ODM 供应商报价在「供应商管理 → 整机供应商（ODM）」中自动汇总展示；修改报价会记录变动原因与历史
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
                          表格里改哪个 SKU 的哪一行，就是它的差异（黄色 = 与基座不同）；改回基座的值自动还原；基座降价自动联动所有 SKU
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
                                                <InputNumber size="small" autoFocus value={edQty} onChange={v => setEdQty(v ?? 0)} min={0} step={0.000001} style={{ width: 62 }} onPressEnter={saveEdit} />
                                                <InputNumber size="small" value={edCost} onChange={v => setEdCost(v ?? 0)} min={0} precision={4} style={{ width: 76 }} onPressEnter={saveEdit} />
                                                <Button size="small" type="link" icon={<CheckOutlined />} onClick={saveEdit} />
                                                <Button size="small" type="link" icon={<CloseOutlined />} onClick={cancelEdit} />
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
                                        return (
                                          <td key={s.id} style={{ ...tdBase, textAlign: 'right' }}>
                                            <div onClick={() => startEdit(s, r)} title="点击编辑（数量改 0 = 移除）" style={{ cursor: 'pointer', background: isDiff ? '#FEF3C7' : 'transparent', borderRadius: 4, padding: '2px 6px' }}>
                                              <div style={{ fontVariantNumeric: 'tabular-nums' }}>¥{(c.cost ?? 0).toFixed(2)} × {c.qty ?? 1}</div>
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
      )}

      {/* Project edit modal */}
      {/* ====== 规格级项目预估（拿最像的历史项目估成本） ====== */}
      <Modal
        title={<span><AimOutlined style={{ color: '#0A84FF', marginRight: 8 }} />规格级项目预估</span>}
        open={specModalOpen}
        onCancel={() => setSpecModalOpen(false)}
        footer={null}
        width={680}
      >
        <Form form={specForm} layout="inline" style={{ marginBottom: 14, rowGap: 10 }}>
          <Form.Item label="尺寸" name="screen_size" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder={'如 27英寸 / 23.8"'} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item label="分辨率" name="resolution">
            <Select allowClear style={{ width: 170 }} options={['1920×1080', '2560×1440', '3840×2160'].map(r => ({ label: r, value: r }))} />
          </Form.Item>
          <Form.Item label="刷新率" name="refresh_rate">
            <Select allowClear style={{ width: 100 }} options={['60Hz', '75Hz', '144Hz', '165Hz', '170Hz'].map(r => ({ label: r, value: r }))} />
          </Form.Item>
          <Form.Item label="面板" name="panel_type">
            <Select allowClear style={{ width: 90 }} options={['IPS', 'VA', 'TN', 'OLED'].map(r => ({ label: r, value: r }))} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<AimOutlined />} loading={specLoading} onClick={runSpecEstimate}>估算</Button>
          </Form.Item>
        </Form>
        <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: 10 }}>
          基于历史项目的 BOM 实际成本按规格相似度加权估算（尺寸 40% / 分辨率 30% / 刷新率 20% / 面板 10%）；无历史数据的项目自动排除。
        </div>
        {specResult && (
          <div>
            <div style={{ padding: '10px 14px', background: '#F0F7FF', border: '1px solid #BFDBFE', borderRadius: 10, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <b style={{ fontSize: 15 }}>预估 BOM 成本</b>
              <span style={{ fontSize: 20, fontWeight: 700, color: '#CF0A2C', fontFamily: 'monospace' }}>¥{specResult.estimate.toFixed(2)}</span>
              <span style={{ fontSize: 11.5, color: '#64748B' }}>（{specResult.matchedCount} 个相似项目加权）</span>
            </div>
            <div style={{ fontSize: 12.5, color: '#334155', marginBottom: 6 }}><b>最相似的 {specResult.candidates.length} 个历史项目：</b></div>
            {specResult.candidates.map((c: any) => (
              <div key={c.project.id} onClick={() => { selectProject(c.project.id); setSpecModalOpen(false); }}
                style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 12px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', background: '#FAFBFC' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#F0F7FF'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#FAFBFC'; }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 13 }}>{c.project.code}</b>
                  <span style={{ fontSize: 11.5, color: '#94A3B8', marginLeft: 8 }}>
                    {c.project.screen_size || '?'} · {c.project.resolution || '?'} · {c.project.refresh_rate || '?'} · {c.project.panel_type || '?'}
                  </span>
                </div>
                <Tag color={c.similarity >= 90 ? 'green' : c.similarity >= 70 ? 'blue' : 'orange'}>相似 {c.similarity}%</Tag>
                <b style={{ fontFamily: 'monospace', color: '#1F2937' }}>¥{c.project.bomCost.toFixed(2)}</b>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal title={editing?.id ? '编辑项目' : '新建项目'} open={modalOpen} onOk={handleSaveProject} onCancel={() => { setModalOpen(false); setEditing(null); }} width={640} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={editing || { project_type: '在研', tier: '主流级', status: '进行中', category: '未分类', platform_fee_rate: 0, profit_rate: 0 }}>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="项目代号*" name="code" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="项目名称*" name="name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item label="类型" name="project_type"><Select options={PROJECT_TYPES.map(t => ({ label: t, value: t }))} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}><Form.Item label="品类" name="category" extra="如：显示器、手写笔、鼠标"><AutoComplete options={categories.map((c: any) => ({ label: c.name, value: c.name }))} placeholder="选择或输入品类" allowClear /></Form.Item></Col>
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
                      ⚠️ {issueCount} 条数据异常（见下方红色标注），建议核对后再导入
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
                    {issues.map((s: string, i: number) => <div key={`e${i}`} style={{ color: '#DC2626' }}>⚠️ {s}</div>)}
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
                      <b style={{ fontSize: 12 }}>📦 {mod}</b>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#CF0A2C', fontVariantNumeric: 'tabular-nums' }}>¥{m.subtotal.toFixed(4)}</span>
                    </div>
                    <Table size="small" pagination={false} rowKey={(r: any) => String(r.id)} dataSource={m.items} columns={[
                      { title: '名称', dataIndex: 'part_name', width: 170, ellipsis: true, render: (v: string, r: any) => <span style={{ textDecoration: r._skuStatus === 'removed' ? 'line-through' : 'none', color: r._skuStatus === 'removed' ? '#94A3B8' : undefined }}>{v}</span> },
                      { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
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
                  { title: '型号', dataIndex: 'part_model', width: 140, ellipsis: true },
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
      <Modal title={<span><BulbOutlined /> 报价情报（AI 后台自动识别）</span>} open={insightModal} onCancel={() => setInsightModal(false)} footer={null} width={820}
        styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}>
        <div style={{ marginBottom: 10, fontSize: 12, color: '#94A3B8' }}>
          导入 BOM 或报价变动后自动后台识别；发现"疑似同物料但报价差异明显"时在此提醒。确认后沉淀别名，下次自动归组。
        </div>
        {insights.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#94A3B8', fontSize: 12 }}>暂无情报——导入 BOM 或修改报价后会自动后台识别</div>}
        {insights.map((ins, idx) => {
          let data: any[] = [];
          try { data = JSON.parse(ins.insight_json); } catch { data = []; }
          return (
            <div key={idx} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
                📦 {ins.module_name}
                {ins.status === 'unread' && <Tag color="red" style={{ marginLeft: 8 }}>未读</Tag>}
              </div>
              {data.length === 0 && <div style={{ fontSize: 12, color: '#CBD5E1', padding: '4px 8px' }}>无异常（报价均在正常范围）</div>}
              {data.map((g: any, gi: number) => (
                <div key={gi} style={{ border: g.type === 'ai' ? '1px dashed #C7D2FE' : '1px solid #E8ECF1', borderRadius: 8, marginBottom: 6, padding: '8px 12px', background: g.type === 'ai' ? '#F5F7FF' : '#FAFBFC' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 12.5, color: g.type === 'ai' ? '#4F46E5' : '#334155' }}>{g.type === 'ai' ? '❓' : '📌'} {g.name}</b>
                    <Tag color={g.type === 'ai' ? 'purple' : 'orange'} style={{ margin: 0 }}>{g.type === 'ai' ? '疑似同一物料' : '报价差异明显'}</Tag>
                    <Tag color="red" style={{ margin: 0 }}>价差 ¥{(g.diff || 0).toFixed(2)}</Tag>
                  </div>
                  {g.reason && <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 4 }}>{g.reason}</div>}
                  {g.rows.map((r: any, ri: number) => (
                    <div key={ri} style={{ fontSize: 12, display: 'flex', gap: 10, padding: '1px 0' }}>
                      <b style={{ width: 70 }}>{r.project}</b>
                      <span style={{ width: 180, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} {r.model}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>¥{r.cost.toFixed(2)} × {r.quantity}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                    <Button size="small" type="primary" onClick={() => confirmInsightGroup(ins, g)}>✓ 确认同一器件</Button>
                    <Button size="small" onClick={() => rejectInsightGroup(ins, g)}>标记不同</Button>
                    <Button size="small" onClick={async () => { await markInsightRead(ins.category, ins.module_name); await loadInsights(); }}>知道了（已读）</Button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </Modal>

    </div>
  );
}
