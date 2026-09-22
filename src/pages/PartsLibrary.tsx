import { SupplierNameInput } from '../components/SupplierResourcePool';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { EmojiIcon } from '../iconMap';
import { Button, Input, Select, Space, Modal, Form, InputNumber, Tag, message, Popconfirm, Tooltip, Upload, Row, Col } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import { PlusOutlined, DeleteOutlined, DownloadOutlined, UploadOutlined, HistoryOutlined, SearchOutlined, ShopOutlined, ToolOutlined, CheckOutlined, UndoOutlined, BulbOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { confirmPartPriceBaseline, getParts, savePart, deletePart, getCategories, getPriceHistory, getPartPriceEvidence, getMainCategories, getPartSuppliers, addPartSupplier, updatePartSupplier, deletePartSupplier, getSupplierPriceHistory, getPartCostChangeLogs, getDataChangeHistory } from '../db';
import { summarizeSupplierTrend, supplierTrendTag } from '../supplierTrend';
import { MAIN_CATEGORIES, SUB_CATEGORIES, getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';
import { openMaterialInsightDraft } from '../materialInsight';
import { downloadPartsTemplate } from '../excelTemplates';

export default function PartsLibrary() {
  const [parts, setParts] = useState<any[]>([]);
  const [priceEvidence, setPriceEvidence] = useState<Record<number, any>>({});
  const [loading, setLoading] = useState(false);
  const [selKeys, setSelKeys] = useState<React.Key[]>([]);
  const [search, setSearch] = useState(() => localStorage.getItem('costhub-part-search') || '');
  const [mainCat, setMainCat] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [historyName, setHistoryName] = useState('');
  const [inlinePartCell, setInlinePartCell] = useState<{ id: number; field: string; value: string | number } | null>(null);
  const [mainCats, setMainCats] = useState(MAIN_CATEGORIES);
  const [form] = Form.useForm();

  // 供应商管理状态
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [currentPart, setCurrentPart] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplierForm] = Form.useForm();
  const [editingSupplier, setEditingSupplier] = useState<any>(null);
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [partChangeLogs, setPartChangeLogs] = useState<any[]>([]);

  useEffect(() => { (async () => { try { setMainCats(await getMainCategories()); } catch(e) {} })(); }, []);
  // 驾驶舱 AI 洞察直达：搜索指定物料（costhub-open-part，detail: { search }）
  useEffect(() => {
    const onOpenPart = (e: Event) => {
      const search = (e as CustomEvent).detail?.search;
      if (search) { setSearch(String(search)); localStorage.removeItem('costhub-part-search'); }
    };
    window.addEventListener('costhub-open-part', onOpenPart);
    return () => window.removeEventListener('costhub-open-part', onOpenPart);
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await getParts(search, typeFilter, mainCat); setParts(d); setPriceEvidence(await getPartPriceEvidence(d.map((row: any) => row.id))); setCategories(await getCategories()); } catch (e) { console.error(e); }
    setLoading(false);
  }, [search, typeFilter, mainCat]);
  useEffect(() => { load(); }, [load]);
  // AI 数据工程联动：切回页面自动刷新（BOM/报价/原声等写库后可见）
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.page === 'parts') { load(); } };
    window.addEventListener('app-page-active', h);
    return () => window.removeEventListener('app-page-active', h);
  }, [load]);

  // ====== 项目筛选：选某项目只显示该项目 BOM 里使用的器件 ======
  const [projectFilter, setProjectFilter] = useState<number | ''>('');
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
        const db = await (await import('../db')).getDb();
        const rows = await db.select<any[]>(
          'SELECT DISTINCT part_id FROM project_boms WHERE project_id = ? AND COALESCE(is_deleted,0) = 0 AND part_id IS NOT NULL',
          [projectFilter]
        );
        setProjectPartIds(new Set(rows.map((r: any) => r.part_id)));
      } catch { setProjectPartIds(new Set()); }
    })();
  }, [projectFilter, allProjects]);
  // 前端过滤：BOM 反查（最准确）+ projects 字段匹配（兼容旧数据）双保险
  const filteredParts = useMemo(() => {
    if (!projectFilter) return parts;
    return parts.filter((p: any) => {
      if (projectPartIds.has(p.id)) return true; // BOM 反查命中
      const project = allProjects.find((row: any) => row.id === projectFilter);
      return Boolean(project && `${p.projects || ''}`.includes(project.code || '')); // 兼容旧数据中的项目标签
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
              category: d['分类'] || d['category'] || d['大类'] || d['main_category'] || '硬件类',
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
    await savePart({ ...editing, ...v, main_category: v.main_category || '硬件类', sub_category: v.sub_category || '' }, true, true, 'parts_form');
    setModalOpen(false); setEditing(null); form.resetFields(); load(); message.success('已保存');
  };
  const handleDelete = async (id: number) => { await deletePart(id); load(); message.success('已删除'); };
  const confirmBaseline = async (row: any) => { const evidence = priceEvidence[Number(row.id)]; if (!evidence?.low) { message.info('暂无有效价格证据，不能确认基线'); return; } await confirmPartPriceBaseline(Number(row.id), evidence.low); await load(); message.success(`已确认 ${row.name} 的物料基线价`); };
  const batchDelete = async () => { for (const id of selKeys) await deletePart(Number(id)); message.success(`已删除 ${selKeys.length} 条`); setSelKeys([]); load(); };
  const rowSel: TableRowSelection<any> = { selectedRowKeys: selKeys, onChange: setSelKeys };
  const showHistory = async (r: any) => {
    const [changes, legacyPrices] = await Promise.all([getDataChangeHistory('part', r.id), getPriceHistory(r.id)]);
    // 兼容改版前已经存在的成本历史，和字段级历史一起展示，避免历史记录断层。
    // 新版成本变更仍会保留旧价格历史表用于统计，因此同一秒、同一旧值/新值的旧记录只展示一次。
    const genericCostKeys = new Set(changes
      .filter((item: any) => item.field_key === 'cost')
      .map((item: any) => `${item.changed_at || ''}|${item.old_value}|${item.new_value}`));
    const legacyRows = legacyPrices.filter((item: any) => {
      const key = `${item.changed_at || ''}|${item.old_cost}|${item.new_cost}`;
      return !genericCostKeys.has(key);
    }).map((item: any) => ({
      id: `price-${item.id}`,
      changed_at: item.changed_at,
      field_label: '成本',
      old_value: item.old_cost,
      new_value: item.new_cost,
      source: '价格历史',
    }));
    setHistoryData([...changes, ...legacyRows].sort((a: any, b: any) => String(b.changed_at || '').localeCompare(String(a.changed_at || ''))));
    setHistoryName(`${r.name} [${r.model}]`);
    setHistoryOpen(true);
  };

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
      try { setPartChangeLogs(await getPartCostChangeLogs(part.id, 8)); } catch { setPartChangeLogs([]); }
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

  // 规范化还原（2026-08-27：人眼核对规范化结果，错了行内还原——原名不受影响，记审计）
  const handleResetCanonical = async (r: any) => {
    try {
      const { resetPartCanonical } = await import('../canonicalize');
      const { logWriteAudit } = await import('../db');
      const ok = await resetPartCanonical(r.id);
      if (ok) { try { await logWriteAudit('reset_canonical', '器件库还原:' + String(r.name || '').slice(0, 60), '已清空规范结果（可重新规范）', ''); } catch { } load(); }
    } catch { }
  };

  const beginPartInlineEdit = (row: any, field: string) => {
    setInlinePartCell({ id: row.id, field, value: field === 'cost' ? Number(row.cost || 0) : String(row[field] || '') });
  };
  const commitPartInlineCell = async (row: any, field: string, value: string | number) => {
    setInlinePartCell(null);
    const nextValue = field === 'cost' ? Number(value) : String(value ?? '').trim();
    if (field === 'name' || field === 'model') {
      if (!nextValue) { message.warning(`${field === 'name' ? '名称' : '型号'}不能为空`); return; }
    }
    if (field === 'cost' && !Number.isFinite(Number(nextValue))) { message.warning('成本必须是数字'); return; }
    try {
      await savePart({
        ...row,
        [field]: nextValue,
        category: field === 'main_category' ? nextValue : (row.category || row.main_category || '硬件类'),
      }, true, true, 'parts_inline');
      await load();
      message.success('已自动保存');
    } catch (e: any) {
      message.error(`保存失败：${e?.message || '请重试'}`);
      await load();
    }
  };
  const partCellProps = (row: any, field: string) => ({
    className: `parts-inline-cell${inlinePartCell?.id === row.id && inlinePartCell?.field === field ? ' is-editing' : ''}`,
    tabIndex: 0,
    onDoubleClick: () => beginPartInlineEdit(row, field),
    onKeyDown: (event: React.KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === 'F2') && event.target === event.currentTarget) {
        event.preventDefault(); beginPartInlineEdit(row, field);
      }
    },
  });
  const renderPartInline = (row: any, field: string, value: unknown, fallback?: React.ReactNode) => {
    const editor = inlinePartCell;
    if (!editor || editor.id !== row.id || editor.field !== field) return fallback ?? (value == null || value === '' ? <span className="parts-inline-empty">—</span> : String(value));
    if (field === 'cost') {
      return <InputNumber autoFocus size="small" min={0} precision={4} controls={false} value={Number(editor.value || 0)}
        onChange={v => setInlinePartCell(cell => cell ? { ...cell, value: Number(v ?? 0) } : cell)}
        onPressEnter={e => e.currentTarget.blur()}
        onKeyDown={e => { if (e.key === 'Escape') setInlinePartCell(null); }}
        onBlur={() => commitPartInlineCell(row, field, editor.value)} />;
    }
    return <Input autoFocus size="small" value={String(editor.value ?? '')}
      onChange={e => setInlinePartCell(cell => cell ? { ...cell, value: e.target.value } : cell)}
      onPressEnter={e => e.currentTarget.blur()}
      onKeyDown={e => { if (e.key === 'Escape') setInlinePartCell(null); }}
      onBlur={() => commitPartInlineCell(row, field, editor.value)} />;
  };

  const cols = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '大类', dataIndex: 'main_category', width: 100, onCell: (r: any) => partCellProps(r, 'main_category'), render: (v: string, r: any) => renderPartInline(r, 'main_category', v, <Tag color={getCategoryColor(v)}>{v}</Tag>) },
    { title: '子类', dataIndex: 'sub_category', width: 110, onCell: (r: any) => partCellProps(r, 'sub_category'), render: (v: string, r: any) => renderPartInline(r, 'sub_category', v) },
    { title: '名称', dataIndex: 'name', width: 200, ellipsis: true, onCell: (r: any) => partCellProps(r, 'name'), render: (v: string, r: any) => renderPartInline(r, 'name', v) },
    { title: '型号', dataIndex: 'model', width: 160, ellipsis: true, onCell: (r: any) => partCellProps(r, 'model'), render: (v: string, r: any) => renderPartInline(r, 'model', v) },
    { title: '最近参考价(¥)', dataIndex: 'cost', width: 120, align: 'right' as const, onCell: (r: any) => partCellProps(r, 'cost'), render: (v: number, r: any) => <Tooltip title="兼容显示值，不作为正式基线；正式基线需确认价格证据">{renderPartInline(r, 'cost', v, <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{Number(v || 0).toFixed(4)}</span>)}</Tooltip> },
    { title: '有效报价区间', width: 140, align: 'right' as const, render: (_: any, r: any) => { const e = priceEvidence[Number(r.id)]; return e ? `¥${e.low.toFixed(4)} ~ ¥${e.high.toFixed(4)}` : '暂无报价证据'; } },
    { title: '最新价', width: 90, align: 'right' as const, render: (_: any, r: any) => priceEvidence[Number(r.id)] ? `¥${priceEvidence[Number(r.id)].latest.toFixed(4)}` : '—' },
    { title: '基线价', width: 130, align: 'right' as const, render: (_: any, r: any) => { const e = priceEvidence[Number(r.id)]; return e?.baseline != null ? <span style={{ color: '#15803D' }}>¥{e.baseline.toFixed(4)}</span> : e?.low ? <Button type="link" size="small" onClick={() => void confirmBaseline(r)}>确认最低 ¥{e.low.toFixed(4)}</Button> : '未确认'; } },
    { title: '来源数', width: 70, align: 'center' as const, render: (_: any, r: any) => priceEvidence[Number(r.id)]?.sourceCount || 0 },
    { title: '规格', dataIndex: 'specs', width: 220, ellipsis: true, onCell: (r: any) => partCellProps(r, 'specs'), render: (v: string, r: any) => renderPartInline(r, 'specs', v) },
    { title: '规范化', width: 200, render: (_: any, r: any) => {
      const cn = r.canonical_name || '';
      if (!cn) return <Tag style={{ margin: 0 }}>未规范</Tag>;
      let specs: any[] = []; try { specs = JSON.parse(r.canonical_specs || '[]'); } catch { }
      const cat = r.canonical_category || '';
      const isGeneric = specs.length === 0;
      return (
        <Tooltip title={'品类: ' + (cat || '—') + (specs.length ? ' | 规格: ' + specs.join(' / ') : ' | 笼统（无规格）')}>
          <span style={{ fontSize: 11.5, cursor: 'help' }}>{cn}</span>
          {isGeneric && <Tag color="gold" style={{ marginLeft: 4, fontSize: 10 }}>笼统</Tag>}
          {cat === '其他' && <Tag color="orange" style={{ marginLeft: 4, fontSize: 10 }}>存疑</Tag>}
        </Tooltip>
      );
    } },
    { title: '项目', dataIndex: 'projects', width: 140, ellipsis: true, onCell: (r: any) => partCellProps(r, 'projects'), render: (v: string, r: any) => renderPartInline(r, 'projects', v) },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true, onCell: (r: any) => partCellProps(r, 'remark'), render: (v: string, r: any) => renderPartInline(r, 'remark', v) },
    { title: '操作', width: 180, render: (_: any, r: any) => (
      <Space size="small">
        <Tooltip title="供应商"><Button type="link" size="small" icon={<ShopOutlined />} onClick={() => openSupplierModal(r)} /></Tooltip>
        <Tooltip title="修改历史"><Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showHistory(r)} /></Tooltip>
        <Tooltip title="物料洞察"><Button type="link" size="small" icon={<BulbOutlined />} onClick={() => openMaterialInsightDraft({ material: r.name, partId: r.id })} /></Tooltip>
        {r.canonical_name ? (
          <Popconfirm title="还原规范化？" description="清空该器件规范结果（原名不受影响），之后可重新规范" onConfirm={() => handleResetCanonical(r)}>
            <Tooltip title="还原规范化"><Button type="link" size="small" icon={<UndoOutlined />} /></Tooltip>
          </Popconfirm>
        ) : null}
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
              options={allProjects.map((p: any) => ({ label: `${p.code} · ${p.name}`, value: p.id }))}
            />
          </Space>
          <Space>
            <Upload beforeUpload={handleImport} showUploadList={false}><Button icon={<UploadOutlined />}>导入Excel</Button></Upload>
            <Button icon={<DownloadOutlined />} onClick={downloadPartsTemplate}>模板</Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>导出Excel</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增器件</Button>
          </Space>
        </div>
        <div style={{ marginBottom: 8 }}>{selKeys.length > 0 && (
          <Popconfirm title={`批量删除 ${selKeys.length} 条？`} onConfirm={batchDelete}><Button size="small" danger icon={<DeleteOutlined />}>删除选中 ({selKeys.length})</Button></Popconfirm>
        )}</div>
        <div className="parts-inline-hint">双击单元格或按 Enter / F2 编辑，离开单元格自动保存；修改历史可查看字段级变更。</div>
        <DataTable tableId="parts_lib" dataSource={filteredParts} columns={cols} rowKey="id" size="middle" loading={loading} rowSelection={rowSel} pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }} scroll={{ x: 1380 }} />
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

      <Modal title={`修改历史 - ${historyName}`} open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={760}>
        <DataTable tableId="parts_price_hist" dataSource={historyData} rowKey="id" size="small" pagination={false}
          columns={[{ title: '时间', dataIndex: 'changed_at', width: 150 }, { title: '字段', dataIndex: 'field_label', width: 110 }, { title: '原值', dataIndex: 'old_value', ellipsis: true }, { title: '新值', dataIndex: 'new_value', ellipsis: true }, { title: '来源', dataIndex: 'source', width: 130, render: (v: string) => v === 'parts_inline' ? '器件库行内' : v === 'project_bom_inline' ? '项目 BOM' : v === 'module_library_edit' ? '模块库' : v === 'parts_form' ? '器件表单' : v || '手动' }]} />
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
              <SupplierNameInput style={{ width: 220 }} />
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
                    <b style={{ color: '#0A84FF', marginRight: 6 }}><EmojiIcon e="📈" /> 供应商价格趋势</b>
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
              {partChangeLogs.length > 0 && (
          <div style={{ marginTop: 14, borderTop: '1px solid #EEF0F3', paddingTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6, color: '#1D1D1F' }}>成本变动追溯</div>
            <DataTable tableId="parts_change_trace" dataSource={partChangeLogs} rowKey="id" size="small" pagination={false}
              columns={[
                { title: '时间', dataIndex: 'changed_at', width: 140, render: (v: string) => <span style={{ fontSize: 11.5 }}>{v?.slice(0, 16)}</span> },
                { title: '类型', dataIndex: 'change_type', width: 120, render: (v: string) => <Tag color={v === 'part_supplier_price' ? 'blue' : 'purple'} style={{ margin: 0, fontSize: 10.5 }}>{v === 'part_supplier_price' ? '供应商报价变动' : '加权成本变化'}</Tag> },
                { title: '变动', key: 'chg', width: 150, align: 'right' as const, render: (_: any, r: any) => <span style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>¥{Number(r.old_value || 0).toFixed(4)} → <b style={{ color: Number(r.new_value) > Number(r.old_value) ? '#DC2626' : '#16A34A' }}>¥{Number(r.new_value || 0).toFixed(4)}</b></span> },
                { title: '原因', dataIndex: 'change_reason', ellipsis: true, render: (v: string) => <span style={{ fontSize: 11.5 }}>{v || '-'}</span> },
                { title: '影响项目', dataIndex: 'impact_scope', width: 130, render: (v: string) => {
                  let arr: string[] = [];
                  try { arr = JSON.parse(v || '[]'); } catch { arr = []; }
                  return arr.length ? <span style={{ fontSize: 11.5 }}>{arr.join('、')}</span> : <span style={{ fontSize: 11.5, color: '#94A3B8' }}>-</span>;
                } },
              ]}
            />
          </div>
        )}
</Modal>
    </div>
  );
}
