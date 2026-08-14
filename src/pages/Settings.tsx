import { useEffect, useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Button, Space, Alert, message, Spin, Descriptions, Modal, Tag, Empty, Select, Input, Tooltip,
  Card, Row, Col, Switch, Tabs, Form, Popconfirm, Table, Checkbox, InputNumber, Radio,
} from 'antd';
import {
  ApiOutlined, CheckCircleOutlined, DeleteOutlined, EditOutlined,
  LinkOutlined, SafetyCertificateOutlined, CloudServerOutlined, ThunderboltOutlined,
  PlusOutlined, DragOutlined, CheckOutlined, CloseOutlined, KeyOutlined,
  StopOutlined, HistoryOutlined, SettingOutlined, SearchOutlined, RobotOutlined,
  BulbOutlined, BookOutlined, CloseCircleOutlined, RadarChartOutlined, LockOutlined, UserOutlined, DatabaseOutlined, DownloadOutlined, FileTextOutlined, FolderOpenOutlined,
} from '@ant-design/icons';
import { testSearchConnection, testLLMConnection, BUILTIN_SKILLS, loadSkillConfig, saveSkillConfig, getSkill } from '../trendService';
import { useTheme } from '../theme/ThemeContext';
import type { SkillTemplate } from '../trendService';
import {
  getApiProviders, saveApiProvider, deleteApiProvider, setActiveProvider,
  PRESET_PROVIDERS, updateProviderPriorities, ensurePresetProviders,
  getAllChecklistWithLogs, updateChecklistActive, deleteAnalysisChecklistItem,
} from '../db';
import { encryptText } from '../apiConfig';

const STRENGTH_COLORS: Record<string, string> = {
  'observing': '#94A3B8',
  'active': '#3B82F6',
  'stable': '#8B5CF6',
};
const STRENGTH_LABELS: Record<string, string> = {
  'observing': '观察中',
  'active': '已生效',
  'stable': '稳定记忆',
};

export default function Settings({ embedded }: { embedded?: boolean }) {
  const { lowFx, setLowFx } = useTheme();
  const [loading, setLoading] = useState(true);
  const [testingSearch, setTestingSearch] = useState(false);
  const [testingLLM, setTestingLLM] = useState(false);
  const [llmTestResult, setLLMTestResult] = useState<any>(null);
  const [searchTestResult, setSearchTestResult] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('search');
  // ====== 左侧导航分类（Claude 风格设置页） ======
  const [activeSection, setActiveSection] = useState('ai');
  const SECTIONS = [
    { key: 'ai', label: 'AI 服务', icon: <RobotOutlined />, desc: '搜索 / 大模型 / 分析记忆' },
    { key: 'skills', label: '分析框架', icon: <RadarChartOutlined />, desc: 'Skill 方法论配置' },
    { key: 'security', label: '安全设置', icon: <LockOutlined />, desc: '用户名 / 密码' },
    { key: 'appearance', label: '个性化', icon: <SafetyCertificateOutlined />, desc: 'Logo 自定义' },
    { key: 'data', label: '数据管理', icon: <DatabaseOutlined />, desc: '备份 / 恢复 / 导入导出' },
    { key: 'audit', label: '审计日志', icon: <HistoryOutlined />, desc: '外部请求 / AI 请求记录' },
    { key: 'about', label: '关于', icon: <BookOutlined />, desc: '存储与费用说明' },
  ];
  // ====== 安全设置：修改密码 ======
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [changingPwd, setChangingPwd] = useState(false);
  // ====== 用户名设置 ======
  const [usernameSetting, setUsernameSetting] = useState('');
  const [changingUsername, setChangingUsername] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { getUsername } = await import('../db');
        setUsernameSetting(await getUsername());
      } catch { }
    })();
  }, []);

  const handleChangeUsername = async () => {
    if (!usernameSetting.trim()) { message.warning('用户名不能为空'); return; }
    setChangingUsername(true);
    try {
      const { changeUsername } = await import('../db');
      const res = await changeUsername(usernameSetting);
      if (res.ok) { message.success(res.msg); } else { message.error(res.msg); }
    } catch (e: any) {
      message.error(`修改失败：${e?.message || e}`);
    } finally {
      setChangingUsername(false);
    }
  };
  // ====== Token 用量统计 ======
  const [tokenStats, setTokenStats] = useState<any>(null);
  // 模型原生搜索开关（DeepSeek 官方 web_search）
  const [nativeSearchEnabled, setNativeSearchEnabled] = useState(true);
  // ====== 数据管理（备份/恢复） ======
  const [backups, setBackups] = useState<any[]>([]);
  const [backingUp, setBackingUp] = useState(false);
  // ====== Excel 导出 ======
  const [exportTypes, setExportTypes] = useState<string[]>(['parts']);
  const [exporting, setExporting] = useState(false);
  const [exports, setExports] = useState<any[]>([]);
  // 项目导出范围：'' = 全部项目，否则为指定项目 id
  const [exportProjectId, setExportProjectId] = useState<number | ''>('');
  const [allProjects, setAllProjects] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const { getProjects } = await import('../db');
        setAllProjects(await getProjects());
      } catch { /* 忽略 */ }
    })();
  }, []);

  const EXPORT_TYPES = [
    { key: 'parts', label: '器件库', desc: '器件信息 + 多供应商报价' },
    { key: 'projects', label: '项目', desc: '项目信息 + BOM 清单' },
    { key: 'competitors', label: '竞品', desc: '竞品信息 + BOM 估算' },
    { key: 'suppliers', label: '供应商', desc: '器件/整机供应商汇总' },
    { key: 'worklogs', label: '工作手账', desc: '便签 + 待办（含项目标签）' },
    { key: 'insights', label: '洞察记录', desc: '物料洞察快照与结论' },
  ];

  const loadExports = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setExports(await invoke<any[]>('list_exports'));
    } catch { /* 忽略 */ }
  };

  const handleExcelExport = async () => {
    if (exportTypes.length === 0) { message.warning('请至少选择一种导出内容'); return; }
    setExporting(true);
    try {
      const { getDb } = await import('../db');
      const db = await getDb();
      const wb = XLSX.utils.book_new();

      // ===== 器件库 =====
      if (exportTypes.includes('parts')) {
        const parts = await db.select<any[]>('SELECT * FROM parts ORDER BY main_category, sub_category, name');
        const suppliers = await db.select<any[]>('SELECT * FROM part_suppliers ORDER BY part_id');
        const supByPart: Record<number, string> = {};
        suppliers.forEach((s: any) => {
          supByPart[s.part_id] = (supByPart[s.part_id] || '') + `${s.supplier_name}(${s.price}元/${s.share_ratio}%) `;
        });
        const rows = parts.map((p: any) => ({
          '大类': p.main_category, '子类': p.sub_category, '详细分类': p.category,
          '器件名称': p.name, '型号': p.model, '加权成本(¥)': p.cost,
          '规格': p.specs, '关联项目': p.projects, '供应商报价': supByPart[p.id] || '',
          '备注': p.remark,
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 18 }, { wch: 12 }, { wch: 20 }, { wch: 16 }, { wch: 40 }, { wch: 16 }];
        XLSX.utils.book_append_sheet(wb, ws, '器件库');
      }

      // ===== 项目（按项目拆分：每项目一个 sheet，BOM 一行一条） =====
      if (exportTypes.includes('projects')) {
        const projects = await db.select<any[]>(
          exportProjectId
            ? 'SELECT * FROM projects WHERE id=? AND COALESCE(is_deleted,0)=0 ORDER BY code'
            : 'SELECT * FROM projects WHERE COALESCE(is_deleted,0)=0 ORDER BY code',
          exportProjectId ? [exportProjectId] : []
        );
        const boms = await db.select<any[]>(
          'SELECT pb.*, p.name as part_name, p.model as part_model, p.cost as part_cost, p.main_category, p.sub_category FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE COALESCE(pb.is_deleted,0)=0 ORDER BY pb.project_id, pb.module_name, pb.id'
        );
        const odm = await db.select<any[]>('SELECT * FROM project_suppliers ORDER BY project_id, id');
        const bomByProject: Record<number, any[]> = {};
        boms.forEach((b: any) => {
          if (!bomByProject[b.project_id]) bomByProject[b.project_id] = [];
          bomByProject[b.project_id].push(b);
        });
        const odmByProject: Record<number, any[]> = {};
        odm.forEach((s: any) => {
          if (!odmByProject[s.project_id]) odmByProject[s.project_id] = [];
          odmByProject[s.project_id].push(s);
        });

        // 生成单个项目的 sheet：项目信息 + BOM 明细 + ODM 报价
        const buildProjectSheet = (p: any) => {
          const infoRows = [
            { '项目信息': '代号', '': p.code },
            { '项目信息': '名称', '': p.name },
            { '项目信息': '类型 / 档位', '': `${p.project_type || ''} / ${p.tier || ''}` },
            { '项目信息': '状态 / 品类', '': `${p.status || ''} / ${p.category || ''}` },
            { '项目信息': '规格', '': `${p.screen_size || ''} ${p.resolution || ''} ${p.refresh_rate || ''} ${p.panel_type || ''}`.trim() },
            { '项目信息': '平台费率 / 利润率', '': `${p.platform_fee_rate || 0}% / ${p.profit_rate || 0}%` },
          ];
          const ws = XLSX.utils.json_to_sheet([]);
          // 项目信息区
          XLSX.utils.sheet_add_aoa(ws, [['项目信息', '']], { origin: 'A1' });
          infoRows.forEach((r, i) => XLSX.utils.sheet_add_aoa(ws, [[r['项目信息'], r['']]], { origin: `A${i + 2}` }));
          // BOM 明细表（规范表格：一行一个器件）
          const bomRows = (bomByProject[p.id] || []).map(b => ({
            '模块': b.module_name || '', '大类': b.main_category || '', '子类': b.sub_category || '',
            '器件名称': b.part_name || '', '型号': b.part_model || '', '数量': b.quantity || 1,
            '单价(¥)': Number(b.part_cost || 0), '小计(¥)': Number((b.part_cost || 0) * (b.quantity || 1)),
            '备注': b.remark || '',
          }));
          const bomTotal = bomRows.reduce((s, r) => s + r['小计(¥)'], 0);
          const bomStart = infoRows.length + 3;
          XLSX.utils.sheet_add_aoa(ws, [['BOM 明细', '']], { origin: `A${bomStart}` });
          if (bomRows.length > 0) {
            XLSX.utils.sheet_add_json(ws, bomRows, { origin: `A${bomStart + 1}`, skipHeader: false });
            // 复制列宽
            const cols = [
              { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 24 }, { wch: 16 },
              { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 16 },
            ];
            ws['!cols'] = cols;
          }
          // 合计行
          XLSX.utils.sheet_add_aoa(ws, [['BOM 合计(¥)', '', '', '', '', '', '', bomTotal.toFixed(2), '']], { origin: `A${bomStart + 1 + bomRows.length}` });
          // ODM 整机报价
          const odmRows = (odmByProject[p.id] || []).map(s => ({
            'ODM 供应商': s.supplier_name, '整机报价(¥)': Number(s.quoted_price || 0),
            '份额(%)': s.share_ratio || 0, '状态': s.is_active ? '启用' : '停用', '备注': s.remark || '',
          }));
          const odmStart = bomStart + 2 + bomRows.length + 1;
          if (odmRows.length > 0) {
            XLSX.utils.sheet_add_aoa(ws, [['ODM 整机供应商报价', '']], { origin: `A${odmStart}` });
            XLSX.utils.sheet_add_json(ws, odmRows, { origin: `A${odmStart + 1}`, skipHeader: false });
          }
          return ws;
        };

        if (exportProjectId) {
          // 单项目导出：一个 sheet
          const p = projects[0];
          if (!p) { message.warning('未找到该项目'); return; }
          const ws = buildProjectSheet(p);
          XLSX.utils.book_append_sheet(wb, ws, p.code.slice(0, 28) || '项目');
        } else {
          // 全部项目：每项目一个 sheet（sheet 名 = 项目代号，超长截断）
          projects.forEach((p: any, idx: number) => {
            const ws = buildProjectSheet(p);
            const name = (p.code || `项目${idx + 1}`).slice(0, 28);
            XLSX.utils.book_append_sheet(wb, ws, name);
          });
        }
      }

      // ===== 竞品 =====
      if (exportTypes.includes('competitors')) {
        const comps = await db.select<any[]>('SELECT * FROM competitors ORDER BY brand, model');
        const rows = comps.map((c: any) => ({
          '品牌': c.brand, '型号': c.model, '档位': c.tier, '品类': c.category,
          '市场价格(¥)': c.market_price, 'BOM成本(¥)': c.bom_cost,
          '平台费率(%)': c.platform_fee_rate, '备注': c.remark,
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 24 }];
        XLSX.utils.book_append_sheet(wb, ws, '竞品');
      }

      // ===== 供应商 =====
      if (exportTypes.includes('suppliers')) {
        const partSups = await db.select<any[]>('SELECT ps.*, p.name as part_name, p.main_category FROM part_suppliers ps JOIN parts p ON ps.part_id = p.id ORDER BY ps.supplier_name');
        const projSups = await db.select<any[]>('SELECT psu.*, p.code as project_code, p.name as project_name FROM project_suppliers psu JOIN projects p ON psu.project_id = p.id ORDER BY psu.supplier_name');
        const ws1 = XLSX.utils.json_to_sheet(partSups.map((s: any) => ({
          '供应商': s.supplier_name, '器件': s.part_name, '大类': s.main_category,
          '报价(¥)': s.price, '份额(%)': s.share_ratio, '状态': s.is_active ? '启用' : '停用', '备注': s.remark,
        })));
        ws1['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws1, '器件供应商');
        const ws2 = XLSX.utils.json_to_sheet(projSups.map((s: any) => ({
          '供应商(ODM)': s.supplier_name, '项目代号': s.project_code, '项目名称': s.project_name,
          '整机报价(¥)': s.quoted_price, '份额(%)': s.share_ratio, '状态': s.is_active ? '启用' : '停用', '备注': s.remark,
        })));
        ws2['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws2, '整机供应商ODM');
      }

      // ===== 工作手账 =====
      if (exportTypes.includes('worklogs')) {
        const logs = await db.select<any[]>('SELECT * FROM work_logs ORDER BY log_date');
        const ws = XLSX.utils.json_to_sheet(logs.map((l: any) => ({
          '时间': l.log_date, '标题': l.title, '内容': l.content, '分类': l.category,
          '项目标签': l.work_project || '公共/其他', '类型': l.is_todo ? '待办' : '便签',
          '完成': l.is_todo ? (l.done ? '已完成' : '未完成') : '',
        })));
        ws['!cols'] = [{ wch: 18 }, { wch: 20 }, { wch: 50 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 }];
        XLSX.utils.book_append_sheet(wb, ws, '工作手账');
      }

      // ===== 洞察记录 =====
      if (exportTypes.includes('insights')) {
        const items = await db.select<any[]>('SELECT * FROM trend_items ORDER BY id DESC');
        const snaps = await db.select<any[]>('SELECT * FROM trend_snapshots ORDER BY id DESC');
        const snapByItem: Record<number, string[]> = {};
        snaps.forEach((s: any) => {
          if (!snapByItem[s.trend_item_id]) snapByItem[s.trend_item_id] = [];
          snapByItem[s.trend_item_id].push(`${s.skill_used || '分析'} | ${s.direction || ''} | 置信${s.confidence_level || ''} | ${s.summary || ''}`);
        });
        const rows = items.map((it: any) => ({
          '物料名称': it.query_category, '类型': it.category_type, '来源': it.source_type === 'quick' ? '快捷洞察' : '分解树',
          '洞察记录': (snapByItem[it.id] || []).join('\n') || '未洞察',
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 80 }];
        XLSX.utils.book_append_sheet(wb, ws, '洞察记录');
      }

      // 生成文件并保存
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const fname = `costhub-export-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.xlsx`;
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_export_file', { fileName: fname, base64Data: b64 });
      message.success(`已导出 ${fname}（${exportTypes.length} 类内容）`);
      loadExports();
    } catch (e: any) {
      message.error('导出失败: ' + (e?.message || '未知错误'));
    } finally {
      setExporting(false);
    }
  };

  const loadBackups = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setBackups(await invoke<any[]>('list_backups'));
    } catch { /* 命令不可用时静默 */ }
  };
  const handleBackup = async () => {
    setBackingUp(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const name = await invoke<string>('backup_database');
      message.success(`备份成功：${name}`);
      loadBackups();
    } catch (e: any) {
      message.error('备份失败: ' + (e?.message || '未知错误'));
    } finally {
      setBackingUp(false);
    }
  };
  const handleRestore = async (name: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const msg = await invoke<string>('restore_database', { backupName: name });
      message.success(msg);
      setTimeout(() => window.location.reload(), 1500);
    } catch (e: any) {
      message.error('恢复失败: ' + (e?.message || '未知错误'));
    }
  };
  const handleDeleteBackup = async (name: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_backup', { backupName: name });
      message.success('已删除备份');
      loadBackups();
    } catch (e: any) {
      message.error('删除失败: ' + (e?.message || '未知错误'));
    }
  };
  useEffect(() => { loadBackups(); }, []);

  useEffect(() => {
    (async () => {
      try {
        const db = await (await import('../db')).getDb();
        const rows = await db.select<any[]>('SELECT value FROM settings WHERE key=?', ['ai_native_search']);
        setNativeSearchEnabled(rows.length === 0 || rows[0].value !== '0');
      } catch { }
    })();
  }, []);

  const loadTokenStats = async () => {
    try {
      const { getTokenUsageStats } = await import('../db');
      setTokenStats(await getTokenUsageStats());
    } catch { }
  };
  useEffect(() => { loadTokenStats(); }, []);

  const handleChangePwd = async () => {
    if (!oldPwd) { message.warning('请输入当前密码'); return; }
    if (!newPwd || newPwd.length < 4) { message.warning('新密码至少 4 位'); return; }
    if (newPwd !== confirmPwd) { message.warning('两次输入的新密码不一致'); return; }
    setChangingPwd(true);
    try {
      const { changePassword } = await import('../db');
      const res = await changePassword(oldPwd, newPwd);
      if (res.ok) {
        message.success(res.msg);
        setOldPwd(''); setNewPwd(''); setConfirmPwd('');
      } else {
        message.error(res.msg);
      }
    } catch (e: any) {
      message.error(`修改失败：${e?.message || e}`);
    } finally {
      setChangingPwd(false);
    }
  };
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [dragId, setDragId] = useState<number | null>(null);
  const dragOverId = useRef<number | null>(null);
  // 请求日志
  const [requestLogs, setRequestLogs] = useState<any[]>([]);
  const loadRequestLogs = async () => {
    try {
      const { getOutboundRequestLogs } = await import('../db');
      setRequestLogs(await getOutboundRequestLogs());
    } catch { }
  };
  useEffect(() => { loadRequestLogs(); }, []);

  // AI请求日志（审计用）
  const [aiLogs, setAiLogs] = useState<any[]>([]);
  const loadAILogs = async () => {
    try {
      const { getAllAIRequestLogs } = await import('../db');
      setAiLogs(await getAllAIRequestLogs(100));
    } catch (err) {
      console.error('加载AI日志失败:', err);
    }
  };
  const clearAILogs = async () => {
    try {
      const { clearAllAIRequestLogs } = await import('../db');
      await clearAllAIRequestLogs();
      message.success('已清空AI请求日志');
      loadAILogs();
    } catch (err: any) {
      message.error('清空失败: ' + err.message);
    }
  };
  useEffect(() => { loadAILogs(); }, []);

  // Skill config
  const [skillConfig, setSkillConfig] = useState(loadSkillConfig());
  const [skillEditOpen, setSkillEditOpen] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<SkillTemplate | null>(null);
  const [createCustomSkillOpen, setCreateCustomSkillOpen] = useState(false);
  const [newCustomSkill, setNewCustomSkill] = useState<SkillTemplate>({
    id: '',
    name: '',
    description: '',
    icon: '📊',
    systemPrompt: '',
    searchQueries: [],
    maxSearchRounds: 2,
    outputDimensions: []
  });

  // 分析记忆
  const [memoryItems, setMemoryItems] = useState<any[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logData, setLogData] = useState<any[]>([]);

  const loadMemoryItems = async () => {
    setMemoryLoading(true);
    try {
      const data = await getAllChecklistWithLogs();
      setMemoryItems(data.items);
    } catch { }
    setMemoryLoading(false);
  };

  const handleToggleMemory = async (id: number, current: boolean) => {
    await updateChecklistActive(id, !current);
    message.success(current ? '已暂停该记忆' : '已恢复该记忆');
    loadMemoryItems();
  };

  const handleDeleteMemory = async (id: number) => {
    await deleteAnalysisChecklistItem(id);
    message.success('已删除');
    loadMemoryItems();
  };

  const showMemoryLogs = (logs: any[]) => {
    setLogData(logs || []);
    setLogModalOpen(true);
  };

  const loadProviders = async () => {
    try { setProviders(await getApiProviders()); } catch (e) { console.error(e); }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await ensurePresetProviders();
      await loadProviders();
      await loadMemoryItems();
      setLoading(false);
    })();
  }, []);

  const searchProviders = providers.filter((p: any) => p.provider_type === 'search');
  const llmProviders = providers.filter((p: any) => p.provider_type === 'llm');

  // 拖拽排序
  const handleDragStart = (id: number) => { setDragId(id); };
  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    dragOverId.current = id;
  };
  const handleDragEnd = async (type: string) => {
    if (dragId === null || dragOverId.current === null || dragId === dragOverId.current) {
      setDragId(null); dragOverId.current = null; return;
    }
    const list = type === 'search' ? [...searchProviders] : [...llmProviders];
    const fromIdx = list.findIndex(p => p.id === dragId);
    const toIdx = list.findIndex(p => p.id === dragOverId.current);
    if (fromIdx === -1 || toIdx === -1) { setDragId(null); dragOverId.current = null; return; }
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    const orderedIds = list.map(p => p.id);
    await updateProviderPriorities(orderedIds);
    await loadProviders();
    setDragId(null); dragOverId.current = null;
    message.success('排序已更新');
  };

  // 激活/停用
  const handleToggleActive = async (provider: any) => {
    if (provider.is_active) {
      // 停用
      await saveApiProvider({ ...provider, is_active: 0 });
      message.info(`已停用「${provider.provider_name}」`);
    } else {
      await setActiveProvider(provider.provider_type, provider.id);
      message.success(`已启用「${provider.provider_name}」`);
    }
    loadProviders();
  };

  const handleDeleteProvider = async (id: number) => {
    await deleteApiProvider(id);
    message.success('已删除');
    loadProviders();
  };

  const handleSaveProvider = async () => {
    if (!editingProvider?.provider_name) { message.warning('请输入供应商名称'); return; }
    const data = { ...editingProvider };
    const looksEncrypted = data.api_key && data.api_key.startsWith('{') && data.api_key.includes('"salt"');
    if (data.api_key && data.api_key.length > 0 && !looksEncrypted) {
      try {
        data.api_key = await encryptText(data.api_key);
      } catch (e: any) {
        message.warning('Key 加密失败，将以明文存储（不推荐）');
      }
    }
    await saveApiProvider(data);
    message.success('已保存');
    setProviderModalOpen(false);
    setEditingProvider(null);
    loadProviders();
  };

  const openEditProvider = async (provider: any) => {
    if (provider.api_key && provider.api_key.startsWith('{')) {
      try {
        const { decryptText } = await import('../apiConfig');
        const decrypted = await decryptText(provider.api_key);
        setEditingProvider({ ...provider, api_key: decrypted });
      } catch { setEditingProvider({ ...provider, api_key: '' }); }
    } else {
      setEditingProvider({ ...provider });
    }
    setProviderModalOpen(true);
  };

  // 从预置模板添加
  const handleAddFromPreset = () => {
    if (!selectedPreset) { message.warning('请先选择一个供应商模板'); return; }
    const preset = PRESET_PROVIDERS.find(p => p.provider_name === selectedPreset) as any;
    if (!preset) { message.warning('未找到该模板'); return; }
    const alreadyAdded = providers.some(
      (p: any) => p.provider_name === preset.provider_name && p.provider_type === preset.provider_type
    );
    if (alreadyAdded) { message.warning(`「${preset.provider_name}」已在列表中`); return; }

    setEditingProvider({
      provider_type: preset.provider_type,
      provider_name: preset.provider_name,
      api_key: '',
      base_url: preset.base_url || '',
      model_name: preset.model_name || '',
      priority: preset.priority || 50,
      is_preset: 0,
      monthly_quota_note: preset.monthly_quota_note || '',
      registration_url: preset.registration_url || '',
    });
    setProviderModalOpen(true);
    setSelectedPreset('');
  };

  const handleTestSearch = async () => {
    setTestingSearch(true);
    const result = await testSearchConnection();
    setSearchTestResult(result);
    setTestingSearch(false);
  };

  const handleTestLLM = async () => {
    setTestingLLM(true);
    setLLMTestResult(null);
    const result = await testLLMConnection();
    setLLMTestResult(result);
    setTestingLLM(false);
  };

  const maskKey = (key: string) => {
    if (!key || key.length < 8) return '未配置';
    return key.slice(0, 4) + '••••••••' + key.slice(-4);
  };

  const renderProviderCard = (provider: any) => {
    const isDrag = dragId === provider.id;
    const hasKey = provider.api_key && provider.api_key.length > 10;
    return (
      <div
        key={provider.id}
        draggable
        onDragStart={() => handleDragStart(provider.id)}
        onDragOver={(e) => handleDragOver(e, provider.id)}
        onDragEnd={() => handleDragEnd(activeTab)}
        style={{ opacity: isDrag ? 0.4 : 1, cursor: 'grab' }}
      >
        <Card
          size="small"
          style={{
            marginBottom: 8,
            border: provider.is_active ? '2px solid var(--brand)' : '1px solid var(--card-border)',
            background: provider.is_active ? 'var(--brand-light)' : 'var(--card-bg)',
          }}
          actions={[
            <Tooltip title={provider.is_active ? '停用' : '启用'} key="toggle">
              <Switch
                size="small"
                checked={!!provider.is_active}
                onChange={() => handleToggleActive(provider)}
                checkedChildren={<CheckOutlined />}
                unCheckedChildren={<CloseOutlined />}
              />
            </Tooltip>,
            <Tooltip title="编辑" key="edit">
              <EditOutlined onClick={() => openEditProvider(provider)} />
            </Tooltip>,
            <Tooltip title="删除" key="del">
              <DeleteOutlined onClick={() => {
                Modal.confirm({
                  title: `删除供应商「${provider.provider_name}」？`,
                  content: '该操作不可恢复。',
                  okType: 'danger',
                  onOk: () => handleDeleteProvider(provider.id),
                });
              }} />
            </Tooltip>,
            <Tooltip title="拖拽排序" key="drag">
              <DragOutlined style={{ cursor: 'grab', color: 'var(--text-muted)' }} />
            </Tooltip>,
          ]}
        >
          <Card.Meta
            title={
              <Space>
                <span>{provider.provider_name}</span>
                {provider.is_active && <Tag color="green" style={{ fontSize: 10 }}>已启用</Tag>}
                {!provider.is_active && <Tag style={{ fontSize: 10 }}>未启用</Tag>}
                {provider.is_preset ? <Tag style={{ fontSize: 9 }}>预置</Tag> : null}
              </Space>
            }
            description={
              <div style={{ fontSize: 12, lineHeight: '1.8' }}>
                <div>
                  <KeyOutlined style={{ marginRight: 4 }} />
                  <Tag color={hasKey ? 'green' : 'red'} style={{ fontSize: 10 }}>
                    {hasKey ? '已加密' : '未填 Key'}
                  </Tag>
                </div>
                {provider.base_url && (
                  <div style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <ApiOutlined style={{ marginRight: 4 }} />
                    {provider.base_url}
                  </div>
                )}
                {provider.model_name && (
                  <div><ThunderboltOutlined style={{ marginRight: 4 }} />{provider.model_name}</div>
                )}
                {provider.monthly_quota_note && (
                  <div style={{ color: '#8B5CF6', fontSize: 11 }}>
                    <BulbOutlined style={{ marginRight: 4 }} /> {provider.monthly_quota_note}
                  </div>
                )}
                {provider.registration_url && (
                  <div>
                    <a href={provider.registration_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
                      <LinkOutlined /> 注册链接
                    </a>
                  </div>
                )}
                {hasKey && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Key: {maskKey(provider.api_key)}</div>
                )}
              </div>
            }
          />
        </Card>
      </div>
    );
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;

  const presetOptions = PRESET_PROVIDERS.map(p => ({
    value: p.provider_name,
    label: `${p.provider_name}  —  ${p.monthly_quota_note}`,
  }));

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: embedded ? '0' : '0 24px' }}>
      {/* 页面标题（弹窗嵌入时隐藏） */}
      {!embedded && (
      <div style={{
        marginBottom: 24,
        paddingBottom: 16,
        borderBottom: '2px solid #e5e7eb'
      }}>
        <h1 style={{
          fontSize: 28,
          fontWeight: 600,
          margin: 0,
          color: '#111827',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}>
          <SettingOutlined style={{ fontSize: 32 }} />
          系统设置
        </h1>
        <p style={{
          margin: '8px 0 0 44px',
          color: '#6b7280',
          fontSize: 14
        }}>
          配置API服务、分析框架和系统行为
        </p>
      </div>
      )}

      {/* ====== Claude 风格：左侧导航 + 右侧内容区 ====== */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* 左侧分类导航 */}
        <div style={{
          width: 208, flexShrink: 0,
          background: 'white', borderRadius: 14, padding: '10px 8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)', position: 'sticky', top: embedded ? 8 : 68,
        }}>
          {SECTIONS.map(s => (
            <div key={s.key} onClick={() => setActiveSection(s.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
                cursor: 'pointer', transition: 'all .15s',
                background: activeSection === s.key ? '#EEF2FF' : 'transparent',
                border: activeSection === s.key ? '1px solid #C7D2FE' : '1px solid transparent',
              }}>
              <span style={{
                fontSize: 15, color: activeSection === s.key ? '#4F46E5' : '#9AA7BD',
                display: 'inline-flex', width: 20, justifyContent: 'center',
              }}>{s.icon}</span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: activeSection === s.key ? 700 : 500, color: activeSection === s.key ? '#1E293B' : '#475569' }}>
                  {s.label}
                </div>
                <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 1 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 右侧内容区 */}
        <div style={{ flex: 1, minWidth: 0 }}>

      {/* ====== AI 服务区（搜索/LLM/记忆/安全） ====== */}
      {activeSection === 'ai' && (
      <>
      {/* 顶部提示卡片 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 16,
        marginBottom: 32
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: 12,
          padding: 20,
          color: 'white',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <CloudServerOutlined style={{ fontSize: 24 }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>工作模式</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.95 }}>
            按需手动触发查询，无自动定时任务
          </div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
          borderRadius: 12,
          padding: 20,
          color: 'white',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <SafetyCertificateOutlined style={{ fontSize: 24 }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>隐私保护</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.95 }}>
            仅发送物料名称，不上传价格、供应商等敏感数据
          </div>
        </div>
      </div>

      {/* ====== 供应商管理 ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{
              fontSize: 20,
              fontWeight: 600,
              margin: 0,
              color: '#111827',
              display: 'flex',
              alignItems: 'center',
              gap: 10
            }}>
              <ApiOutlined style={{ color: '#8b5cf6' }} />
              供应商管理
            </h2>
            <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
              配置搜索引擎和LLM服务，支持多供应商降级
            </p>
          </div>
          <Space size="middle">
            <Select
              showSearch
              placeholder="从预置模板添加..."
              value={selectedPreset || undefined}
              onChange={setSelectedPreset}
              style={{ width: 280 }}
              options={presetOptions}
              filterOption={(input, option) =>
                (option?.label as string || '').toLowerCase().includes(input.toLowerCase())
              }
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleAddFromPreset}
              style={{
                borderRadius: 8,
                height: 36
              }}
            >
              添加
            </Button>
          </Space>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'search',
              label: <span><SearchOutlined /> 搜索服务 ({searchProviders.length})</span>,
              children: (
                <div>
                  {searchProviders.length === 0 ? (
                    <Empty description="暂无搜索服务供应商，请从上方下拉选择模板添加" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <Row gutter={[12, 0]}>
                      {searchProviders.map(p => (
                        <Col key={p.id} xs={24} sm={12} lg={8}>
                          {renderProviderCard(p)}
                        </Col>
                      ))}
                    </Row>
                  )}
                </div>
              ),
            },
            {
              key: 'llm',
              label: <span><RobotOutlined /> 大模型服务 ({llmProviders.length})</span>,
              children: (
                <div>
                  {llmProviders.length === 0 ? (
                    <Empty description="暂无大模型服务供应商，请从上方下拉选择模板添加" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <Row gutter={[12, 0]}>
                      {llmProviders.map(p => (
                        <Col key={p.id} xs={24} sm={12} lg={8}>
                          {renderProviderCard(p)}
                        </Col>
                      ))}
                    </Row>
                  )}
                </div>
              ),
            },
            {
              key: 'memory',
              label: <span><RobotOutlined /> 分析记忆 ({memoryItems.length})</span>,
              children: (
                <div>
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
                    系统自动记录您在不同物料洞察分析中反复追问的角度。当某一类追问出现3次以上时，该角度自动纳入后续洞察查询的提示词。
                  </p>
                  {memoryLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spin /></div>
                  ) : memoryItems.length === 0 ? (
                    <Empty description="暂无分析记忆，使用洞察追问功能后会自动生成" style={{ marginTop: 60 }} />
                  ) : (
                    <>
                      <Row gutter={[12, 12]}>
                        {memoryItems.map((item: any) => (
                          <Col key={item.id} xs={24} sm={12} lg={8}>
                            <Card
                              size="small"
                              style={{
                                border: item.is_active ? `1px solid ${STRENGTH_COLORS[item.strength_level] || '#94A3B8'}` : '1px solid #E2E8F0',
                                opacity: item.is_active ? 1 : 0.5,
                              }}
                              actions={[
                                <Switch key="toggle" size="small" checked={!!item.is_active}
                                  onChange={() => handleToggleMemory(item.id, !!item.is_active)}
                                  checkedChildren={<CheckCircleOutlined />}
                                  unCheckedChildren={<StopOutlined />}
                                />,
                                <Button key="logs" type="link" size="small" icon={<HistoryOutlined />}
                                  onClick={() => showMemoryLogs(item.trigger_logs || [])} disabled={!(item.trigger_logs || []).length}>
                                  日志
                                </Button>,
                                <Popconfirm key="del" title="删除此记忆？" onConfirm={() => handleDeleteMemory(item.id)}>
                                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                                </Popconfirm>,
                              ]}
                            >
                              <Card.Meta
                                title={
                                  <Space>
                                    <span style={{ fontSize: 13 }}>{item.item_description}</span>
                                    <Tag color={STRENGTH_COLORS[item.strength_level]} style={{ fontSize: 9 }}>
                                      {STRENGTH_LABELS[item.strength_level] || item.strength_level}
                                    </Tag>
                                  </Space>
                                }
                                description={
                                  <div style={{ fontSize: 11, lineHeight: '1.8' }}>
                                    <div>触发次数：{item.trigger_count} 次</div>
                                    {item.first_triggered_at && <div>首次：{item.first_triggered_at.slice(0, 16)}</div>}
                                    {item.last_triggered_at && <div>最近：{item.last_triggered_at.slice(0, 16)}</div>}
                                    {!item.is_active && <Tag color="red" style={{ fontSize: 10 }}>已暂停</Tag>}
                                    {item.strength_level === 'stable' && <Tag color="purple" style={{ fontSize: 10 }}><ThunderboltOutlined /> 稳定记忆</Tag>}
                                  </div>
                                }
                              />
                            </Card>
                          </Col>
                        ))}
                      </Row>
                      <Card size="small" style={{ marginTop: 20 }}>
                        <Descriptions column={1} size="small" title={<span><BookOutlined /> 强度分级说明</span>} style={{ fontSize: 12 }}>
                          <Descriptions.Item label={<Tag color="#94A3B8">观察中</Tag>}>1-2次触发，记录但不影响分析</Descriptions.Item>
                          <Descriptions.Item label={<Tag color="#3B82F6">已生效</Tag>}>3-4次触发，已自动纳入分析提示</Descriptions.Item>
                          <Descriptions.Item label={<Tag color="#8B5CF6">稳定记忆</Tag>}>5次以上触发，权重较高的稳定模式</Descriptions.Item>
                        </Descriptions>
                      </Card>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Button size="small" onClick={handleTestLLM} loading={testingLLM} icon={<CheckCircleOutlined />}>
            测试 LLM 连接
          </Button>
          <Button size="small" onClick={handleTestSearch} loading={testingSearch} icon={<ApiOutlined />}>
            测试搜索连接
          </Button>
        </div>

        {/* 测试结果详情 */}
        {llmTestResult && (
          <Alert
            type={llmTestResult.success ? 'success' : 'error'}
            showIcon
            message={`LLM 测试：${llmTestResult.success ? '通过' : '失败'}`}
            description={llmTestResult.detail ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 150, overflow: 'auto' }}>
                {llmTestResult.detail}
              </div>
            ) : llmTestResult.message}
            style={{ marginTop: 12 }}
            closable
            onClose={() => setLLMTestResult(null)}
          />
        )}
        {searchTestResult && (
          <Alert
            type={searchTestResult.success ? 'success' : 'error'}
            showIcon
            message={`搜索测试：${searchTestResult.success ? '通过' : '失败'}`}
            description={searchTestResult.detail ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 150, overflow: 'auto' }}>
                {searchTestResult.detail}
              </div>
            ) : searchTestResult.message}
            style={{ marginTop: 12 }}
            closable
            onClose={() => setSearchTestResult(null)}
          />
        )}
        {/* 模型原生搜索开关（DeepSeek 官方 web_search，无需第三方搜索 key） */}
        <div style={{ marginTop: 16, padding: '12px 16px', background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0C4A6E' }}>
              <SearchOutlined style={{ marginRight: 6 }} />模型原生联网搜索
            </div>
            <div style={{ fontSize: 11.5, color: '#475569', marginTop: 2 }}>
              使用 DeepSeek 官方内置的 web_search 能力（无需第三方搜索 API key）。开启后洞察优先走原生搜索，一次调用完成搜索+分析；DeepSeek 官方已支持该能力（V4-Flash 起）。
            </div>
          </div>
          <Switch checked={nativeSearchEnabled} onChange={async (checked) => {
            try {
              const db = await (await import('../db')).getDb();
              await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', ['ai_native_search', checked ? '1' : '0']);
              setNativeSearchEnabled(checked);
              message.success(checked ? '已启用模型原生搜索' : '已切换为第三方搜索');
            } catch (e: any) {
              message.error('设置失败: ' + (e?.message || '未知错误'));
            }
          }} />
        </div>
      </div>

      {/* ====== 供应商编辑弹窗 ====== */}
      <Modal title={editingProvider?.id ? '编辑供应商' : '添加供应商'} open={providerModalOpen}
        onCancel={() => { setProviderModalOpen(false); setEditingProvider(null); }} onOk={handleSaveProvider} width={500}>
        {editingProvider && (
          <Form layout="vertical" size="small">
            <Form.Item label="供应商名称" required>
              <Input value={editingProvider.provider_name} onChange={e => setEditingProvider({ ...editingProvider, provider_name: e.target.value })} />
            </Form.Item>
            <Form.Item label="类型">
              <Select value={editingProvider.provider_type} onChange={v => setEditingProvider({ ...editingProvider, provider_type: v })}>
                <Select.Option value="search"><SearchOutlined /> 搜索</Select.Option>
                <Select.Option value="llm"><RobotOutlined /> 大模型</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item label="API Key（留空不变，新填则加密存储）">
              <Input.Password value={editingProvider.api_key || ''} onChange={e => setEditingProvider({ ...editingProvider, api_key: e.target.value })} placeholder="API Key" />
            </Form.Item>
            <Form.Item label="Base URL">
              <Input value={editingProvider.base_url || ''} onChange={e => setEditingProvider({ ...editingProvider, base_url: e.target.value })} placeholder="https://api.example.com/v1/chat/completions" />
            </Form.Item>
            {editingProvider.provider_type === 'llm' && (
              <Form.Item label="模型名称">
                <Input value={editingProvider.model_name || ''} onChange={e => setEditingProvider({ ...editingProvider, model_name: e.target.value })} placeholder="如：deepseek-chat" />
              </Form.Item>
            )}
            <Form.Item label="免费额度说明（选填）">
              <Input value={editingProvider.monthly_quota_note || ''} onChange={e => setEditingProvider({ ...editingProvider, monthly_quota_note: e.target.value })} />
            </Form.Item>
            <Form.Item label="注册链接（选填）">
              <Input value={editingProvider.registration_url || ''} onChange={e => setEditingProvider({ ...editingProvider, registration_url: e.target.value })} placeholder="https://..." />
            </Form.Item>
          </Form>
        )}
      </Modal>
      </>
      )}

      {/* ====== 分析框架（Skill）分区 ====== */}
      {activeSection === 'skills' && (
      <>
      {/* ====== 分析 Skill 配置 ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 600,
            margin: 0,
            color: '#111827',
            display: 'flex',
            alignItems: 'center',
            gap: 10
          }}>
            <ThunderboltOutlined style={{ color: '#f59e0b' }} />
            分析 Skill 配置
          </h2>
          <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
            选择洞察时使用的Skill框架（可多选）。不同Skill从不同维度搜索和分析
          </p>
        </div>

        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16
          }}>
            <div style={{
              fontWeight: 500,
              color: '#374151',
              fontSize: 15
            }}>
              激活的分析框架
            </div>
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => {
                setNewCustomSkill({
                  id: `custom_${Date.now()}`,
                  name: '',
                  description: '',
                  icon: '📊',
                  systemPrompt: '',
                  searchQueries: [],
                  maxSearchRounds: 2,
                  outputDimensions: []
                });
                setCreateCustomSkillOpen(true);
              }}
              style={{ borderRadius: 6 }}
            >
              创建自定义Skill
            </Button>
          </div>
          <Checkbox.Group
            value={skillConfig.activeSkillIds}
            onChange={ids => {
              const n = { ...skillConfig, activeSkillIds: ids as string[] };
              setSkillConfig(n);
              saveSkillConfig(n);
            }}
            style={{ width: '100%' }}
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
              gap: 12
            }}>
              {/* 内置Skill */}
              {BUILTIN_SKILLS.filter(s => s.id !== 'custom').map(s => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    padding: '16px 20px',
                    background: '#f9fafb',
                    borderRadius: 12,
                    border: '2px solid transparent',
                    transition: 'all 0.2s',
                    cursor: 'pointer'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#3b82f6';
                    e.currentTarget.style.background = '#eff6ff';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'transparent';
                    e.currentTarget.style.background = '#f9fafb';
                  }}
                >
                  <Checkbox value={s.id} style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{s.icon}</span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.description}</div>
                        {/* 方法论摘要 */}
                        {s.systemPrompt && (
                          <div style={{ marginTop: 8, fontSize: 11.5, color: '#9ca3af', lineHeight: 1.6, maxHeight: 48, overflow: 'hidden' }}>
                            {s.systemPrompt.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
                              .slice(0, 3).map(l => l.trim().replace(/^[#*>\d\.\-\s]+/, '')).filter(Boolean).slice(0, 2).join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>
                  </Checkbox>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditingSkillId(s.id);
                      setEditingSkill(getSkill(s.id));
                      setSkillEditOpen(true);
                    }}
                    style={{
                      borderRadius: 6,
                      marginLeft: 12,
                      marginTop: 2
                    }}
                  >
                    编辑
                  </Button>
                </div>
              ))}

              {/* 自定义Skill */}
              {skillConfig.customSkills.map(s => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '16px 20px',
                    background: '#fef3c7',
                    borderRadius: 12,
                    border: '2px solid #fbbf24',
                    transition: 'all 0.2s',
                    cursor: 'pointer'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#f59e0b';
                    e.currentTarget.style.background = '#fef08a';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = '#fbbf24';
                    e.currentTarget.style.background = '#fef3c7';
                  }}
                >
                  <Checkbox value={s.id} style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{s.icon}</span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {s.name}
                          <Tag color="orange" style={{ fontSize: 10, margin: 0 }}>自定义</Tag>
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.description}</div>
                      </div>
                    </div>
                  </Checkbox>
                  <Space size="small">
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingSkillId(s.id);
                        setEditingSkill(s);
                        setSkillEditOpen(true);
                      }}
                      style={{ borderRadius: 6 }}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="确定删除这个自定义Skill？"
                      onConfirm={() => {
                        const newCustomSkills = skillConfig.customSkills.filter(cs => cs.id !== s.id);
                        const newActiveIds = skillConfig.activeSkillIds.filter(id => id !== s.id);
                        const n = { ...skillConfig, customSkills: newCustomSkills, activeSkillIds: newActiveIds };
                        setSkillConfig(n);
                        saveSkillConfig(n);
                        message.success('已删除');
                      }}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} style={{ borderRadius: 6 }}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              ))}
            </div>
          </Checkbox.Group>
        </div>
      </div>

      {/* ====== 创建自定义Skill弹窗 ====== */}
      <Modal
        title="创建自定义Skill"
        open={createCustomSkillOpen}
        onCancel={() => setCreateCustomSkillOpen(false)}
        width={900}
        footer={[
          <Button key="cancel" onClick={() => setCreateCustomSkillOpen(false)}>
            取消
          </Button>,
          <Button key="save" type="primary" onClick={() => {
            if (!newCustomSkill.name || !newCustomSkill.description) {
              message.error('请填写名称和描述');
              return;
            }
            const n = {
              ...skillConfig,
              customSkills: [...skillConfig.customSkills, newCustomSkill]
            };
            setSkillConfig(n);
            saveSkillConfig(n);
            setCreateCustomSkillOpen(false);
            message.success('自定义Skill已创建');
          }}>
            创建
          </Button>,
        ]}
      >
        <Tabs
          defaultActiveKey="basic"
          items={[
            {
              key: 'basic',
              label: '基础信息',
              children: (
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>名称 *</label>
                    <Input
                      value={newCustomSkill.name}
                      onChange={e => setNewCustomSkill({ ...newCustomSkill, name: e.target.value })}
                      placeholder="Skill名称"
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>图标</label>
                    <Input
                      value={newCustomSkill.icon}
                      onChange={e => setNewCustomSkill({ ...newCustomSkill, icon: e.target.value })}
                      placeholder="输入emoji图标，如：📊"
                      maxLength={2}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>描述 *</label>
                    <Input.TextArea
                      rows={2}
                      value={newCustomSkill.description}
                      onChange={e => setNewCustomSkill({ ...newCustomSkill, description: e.target.value })}
                      placeholder="Skill描述"
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>搜索轮数</label>
                    <InputNumber
                      min={1}
                      max={3}
                      value={newCustomSkill.maxSearchRounds}
                      onChange={v => setNewCustomSkill({ ...newCustomSkill, maxSearchRounds: v || 1 })}
                      style={{ width: 120 }}
                    />
                  </div>
                </div>
              ),
            },
            {
              key: 'search',
              label: '搜索关键词',
              children: (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                    定义搜索时使用的关键词模板，每行一个
                  </div>
                  <Input.TextArea
                    rows={8}
                    value={newCustomSkill.searchQueries?.join('\n') || ''}
                    onChange={e => setNewCustomSkill({ ...newCustomSkill, searchQueries: e.target.value.split('\n').filter(q => q.trim()) })}
                    placeholder="价格 走势&#10;成本 分析&#10;供需 库存"
                  />
                </div>
              ),
            },
            {
              key: 'dimensions',
              label: '输出维度',
              children: (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                    定义洞察结果的输出维度，每行一个
                  </div>
                  <Input.TextArea
                    rows={8}
                    value={newCustomSkill.outputDimensions?.join('\n') || ''}
                    onChange={e => setNewCustomSkill({ ...newCustomSkill, outputDimensions: e.target.value.split('\n').filter(d => d.trim()) })}
                    placeholder="核心因子&#10;市场动态&#10;趋势预测"
                  />
                </div>
              ),
            },
            {
              key: 'advanced',
              label: '高级设置',
              children: (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                    自定义System Prompt（可选）。留空则使用系统默认模板
                  </div>
                  <Input.TextArea
                    rows={12}
                    value={newCustomSkill.systemPrompt || ''}
                    onChange={e => setNewCustomSkill({ ...newCustomSkill, systemPrompt: e.target.value })}
                    placeholder="留空使用默认模板..."
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>
              ),
            },
          ]}
        />
      </Modal>

      {/* ====== Skill编辑弹窗 ====== */}
      <Modal
        title={`编辑 Skill: ${editingSkill?.name || ''}`}
        open={skillEditOpen}
        onCancel={() => setSkillEditOpen(false)}
        width={900}
        footer={[
          // 只有内置Skill才显示"恢复默认"按钮
          editingSkillId && !editingSkillId.startsWith('custom_') ? (
            <Button key="reset" onClick={() => {
              if (!editingSkillId) return;
              const config = loadSkillConfig();
              const newOverrides = { ...config.skillOverrides };
              delete newOverrides[editingSkillId];
              const n = { ...config, skillOverrides: newOverrides };
              setSkillConfig(n);
              saveSkillConfig(n);
              setEditingSkill(BUILTIN_SKILLS.find(s => s.id === editingSkillId)!);
              message.success('已恢复默认配置');
            }}>
              恢复默认
            </Button>
          ) : null,
          <Button key="save" type="primary" onClick={() => {
            if (!editingSkillId || !editingSkill) return;

            // 判断是内置Skill还是自定义Skill
            if (editingSkillId.startsWith('custom_')) {
              // 更新自定义Skill
              const newCustomSkills = skillConfig.customSkills.map(s =>
                s.id === editingSkillId ? editingSkill : s
              );
              const n = { ...skillConfig, customSkills: newCustomSkills };
              setSkillConfig(n);
              saveSkillConfig(n);
            } else {
              // 更新内置Skill的覆盖配置
              const override: Partial<SkillTemplate> = {
                name: editingSkill.name,
                description: editingSkill.description,
                searchQueries: editingSkill.searchQueries,
                maxSearchRounds: editingSkill.maxSearchRounds,
                outputDimensions: editingSkill.outputDimensions,
                systemPrompt: editingSkill.systemPrompt,
              };
              const n = { ...skillConfig, skillOverrides: { ...skillConfig.skillOverrides, [editingSkillId]: override } };
              setSkillConfig(n);
              saveSkillConfig(n);
            }

            setSkillEditOpen(false);
            message.success('已保存');
          }}>
            保存
          </Button>,
        ]}
      >
        {editingSkill && (
          <Tabs
            defaultActiveKey="basic"
            items={[
              {
                key: 'basic',
                label: '基础信息',
                children: (
                  <div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>名称</label>
                      <Input
                        value={editingSkill.name}
                        onChange={e => setEditingSkill({ ...editingSkill, name: e.target.value })}
                        placeholder="Skill名称"
                      />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>描述</label>
                      <Input.TextArea
                        rows={2}
                        value={editingSkill.description}
                        onChange={e => setEditingSkill({ ...editingSkill, description: e.target.value })}
                        placeholder="Skill描述"
                      />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>搜索轮数</label>
                      <InputNumber
                        min={1}
                        max={3}
                        value={editingSkill.maxSearchRounds}
                        onChange={v => setEditingSkill({ ...editingSkill, maxSearchRounds: v || 1 })}
                        style={{ width: 120 }}
                      />
                      <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b' }}>
                        搜索轮数越多，信息越全面，但耗时和成本也更高
                      </span>
                    </div>
                  </div>
                ),
              },
              {
                key: 'search',
                label: '搜索关键词',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      定义搜索时使用的关键词模板，每行一个。支持占位符如：价格、趋势、供应商等
                    </div>
                    <Input.TextArea
                      rows={8}
                      value={editingSkill.searchQueries?.join('\n') || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, searchQueries: e.target.value.split('\n').filter(q => q.trim()) })}
                      placeholder="价格 走势 涨跌&#10;原材料 成本&#10;供需 库存&#10;政策 影响"
                    />
                  </div>
                ),
              },
              {
                key: 'dimensions',
                label: '输出维度',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      定义洞察结果的输出维度，每行一个。这些维度将按顺序出现在最终报告中
                    </div>
                    <Input.TextArea
                      rows={8}
                      value={editingSkill.outputDimensions?.join('\n') || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, outputDimensions: e.target.value.split('\n').filter(d => d.trim()) })}
                      placeholder="供给因子&#10;需求因子&#10;成本因子&#10;金融与政策因子&#10;展望"
                    />
                  </div>
                ),
              },
              {
                key: 'methodology',
                label: '分析方法论',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      该 Skill 的分析方法论（分析步骤 / 证据要求 / 判断规则）。此内容会作为系统提示词的一部分注入洞察请求，直接约束模型的分析方式
                    </div>
                    <Input.TextArea
                      rows={16}
                      value={editingSkill.systemPrompt || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, systemPrompt: e.target.value })}
                      placeholder="分析步骤...&#10;证据要求...&#10;判断规则..."
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <div style={{ marginTop: 8, padding: 8, background: '#f0f9ff', borderRadius: 4, fontSize: 12 }}>
                      <BulbOutlined style={{ marginRight: 4 }} /> 方法论越具体，洞察结果越专业。建议包含：分析步骤、证据要求（什么数据才算数）、判断规则（什么情况得出什么结论）
                    </div>
                  </div>
                ),
              },
              {
                key: 'advanced',
                label: '高级设置',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      自定义System Prompt（可选）。留空则使用系统默认的提示词模板
                    </div>
                    <Input.TextArea
                      rows={12}
                      value={editingSkill.systemPrompt || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, systemPrompt: e.target.value })}
                      placeholder="留空使用默认模板。如需自定义，可以在这里输入完整的System Prompt..."
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <div style={{ marginTop: 8, padding: 8, background: '#f0f9ff', borderRadius: 4, fontSize: 12 }}>
                      <BulbOutlined style={{ marginRight: 4 }} /> 提示：自定义System Prompt仅在需要完全控制提示词时使用。通常只需修改上面的"输出维度"和"搜索关键词"即可
                    </div>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Modal>
      </>
      )}

      {/* ====== 安全设置（用户名/密码）分区 ====== */}
      {activeSection === 'security' && (
      <>
      <div style={{ background: 'white', borderRadius: 14, padding: 28, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: '#111827', display: 'flex', alignItems: 'center', gap: 10 }}>
          <LockOutlined style={{ color: '#4F46E5' }} /> 安全设置
        </h2>
        <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
          应用访问密码与用户名管理（成本数据机密保护）
        </p>
        <div style={{ marginTop: 20 }}>
          {/* 用户名设置 */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12.5, marginBottom: 4 }}>用户名（登录时使用）</label>
              <Input value={usernameSetting} onChange={e => setUsernameSetting(e.target.value)} placeholder="输入用户名" style={{ maxWidth: 300, borderRadius: 6 }} />
            </div>
            <Button size="small" type="primary" loading={changingUsername} onClick={handleChangeUsername} icon={<UserOutlined />} style={{ borderRadius: 6 }}>
              保存用户名
            </Button>
          </Card>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Descriptions column={1} size="small" title={<span><LockOutlined /> 数据访问密码</span>} style={{ fontSize: 12 }}>
              <Descriptions.Item label="状态">应用启动时需输入用户名与密码解锁数据</Descriptions.Item>
              <Descriptions.Item label="受限模式">用户名或密码错误仍可进入，但所有数据将被隐藏</Descriptions.Item>
            </Descriptions>
          </Card>
          <Card size="small" title={<span><KeyOutlined /> 修改密码</span>} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12.5, marginBottom: 4 }}>当前密码</label>
              <Input.Password value={oldPwd} onChange={e => setOldPwd(e.target.value)} placeholder="输入当前密码" style={{ maxWidth: 300, borderRadius: 6 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12.5, marginBottom: 4 }}>新密码（至少 4 位）</label>
              <Input.Password value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="输入新密码" style={{ maxWidth: 300, borderRadius: 6 }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12.5, marginBottom: 4 }}>确认新密码</label>
              <Input.Password value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} placeholder="再次输入新密码" style={{ maxWidth: 300, borderRadius: 6 }} />
            </div>
            <Button type="primary" loading={changingPwd} onClick={handleChangePwd} icon={<KeyOutlined />} style={{ borderRadius: 6 }}>
              确认修改密码
            </Button>
          </Card>
        </div>
      </div>
      </>
      )}

      {/* ====== 个性化（Logo）分区 ====== */}
      {activeSection === 'appearance' && (
      <>
      {/* ====== 低特效模式（兼容模式） ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: '#111827', display: 'flex', alignItems: 'center', gap: 10 }}>
            <ThunderboltOutlined style={{ color: '#f59e0b' }} />
            低特效模式（兼容模式）
          </h2>
          <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
            关闭全部毛玻璃特效与动画，降低渲染负担——在远程桌面、虚拟机、低配电脑或旧版 WebView2 上出现"界面发灰卡住 / 弹窗打不开"时开启
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 480 }}>
          <div>
            <div style={{ fontWeight: 500, fontSize: 14 }}>启用低特效模式</div>
            <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>开启后界面无渐变毛玻璃与入场动画，立即可用</div>
          </div>
          <Switch checked={lowFx} onChange={v => { setLowFx(v); message.success(v ? '已开启低特效模式' : '已关闭低特效模式'); }} />
        </div>
      </div>
      {/* ====== Logo 自定义 ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 600,
            margin: 0,
            color: '#111827',
            display: 'flex',
            alignItems: 'center',
            gap: 10
          }}>
            <SafetyCertificateOutlined style={{ color: '#10b981' }} />
            Logo 自定义
          </h2>
          <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
            上传侧边栏 Logo，支持 PNG、SVG 等格式（不会修改 Windows exe 文件图标）
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{
            width: 80,
            height: 80,
            borderRadius: 12,
            background: '#f3f4f6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            border: '2px solid #e5e7eb'
          }}>
            {(() => {
              const savedLogo = localStorage.getItem('costhub_custom_logo');
              return savedLogo ? (
                <img src={savedLogo} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : (
                <div style={{ fontSize: 32, fontWeight: 600, color: '#6b7280' }}>CH</div>
              );
            })()}
          </div>

          <div>
            <input
              type="file"
              accept="image/*,.svg"
              id="logo-upload"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;

                if (file.size > 1024 * 1024) {
                  message.error('文件大小不能超过1MB');
                  return;
                }

                const reader = new FileReader();
                reader.onload = (event) => {
                  const dataUrl = event.target?.result as string;
                  localStorage.setItem('costhub_custom_logo', dataUrl);
                  message.success('Logo已更新，刷新页面生效');
                  setTimeout(() => window.location.reload(), 1000);
                };
                reader.readAsDataURL(file);
              }}
            />
            <Space>
              <Button
                icon={<PlusOutlined />}
                onClick={() => document.getElementById('logo-upload')?.click()}
              >
                上传Logo
              </Button>
              <Button
                onClick={() => {
                  localStorage.removeItem('costhub_custom_logo');
                  message.success('已恢复默认Logo，刷新页面生效');
                  setTimeout(() => window.location.reload(), 1000);
                }}
              >
                恢复默认
              </Button>
            </Space>
            <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
              支持 PNG、JPG、SVG 等格式，建议尺寸 256x256px，大小不超过 1MB
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      {/* ====== 数据管理（备份/恢复）分区 ====== */}
      {activeSection === 'data' && (
      <>
      <div style={{ background: 'white', borderRadius: 14, padding: 28, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: '#111827', display: 'flex', alignItems: 'center', gap: 10 }}>
          <DatabaseOutlined style={{ color: '#4F46E5' }} /> 数据管理
        </h2>
        <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
          数据库备份 / 恢复 · 备份保存在 exe 同目录 backups/ 文件夹
        </p>
        <div style={{ marginTop: 20 }}>
          {/* Excel 导出 */}
          <Card size="small" style={{ marginBottom: 16 }} title={<span><FileTextOutlined /> Excel 导出</span>}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
              选择要导出的内容类型（每种类型按各自格式生成 sheet），导出为 .xlsx 文件保存在 exe 同目录 exports/ 文件夹
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
              {EXPORT_TYPES.map(t => {
                const sel = exportTypes.includes(t.key);
                return (
                  <div key={t.key} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
                    background: sel ? '#EEF2FF' : '#F8FAFC',
                    border: '1px solid' + (sel ? '#C7D2FE' : '#E5E7EB'),
                    borderRadius: 8, cursor: 'pointer',
                  }} onClick={() => {
                    const next = sel ? exportTypes.filter(x => x !== t.key) : [...exportTypes, t.key];
                    setExportTypes(next);
                  }}>
                    {/* 纯视觉勾选（点击由卡片 onClick 控制，避开 Checkbox.Group 全选问题） */}
                    <span style={{
                      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                      border: '1.5px solid' + (sel ? '#6366F1' : '#D1D5DB'),
                      background: sel ? '#6366F1' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {sel && <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>}
                    </span>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.label}</div>
                      <div style={{ fontSize: 10, color: '#9CA3AF' }}>{t.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <Button type="primary" icon={<FileTextOutlined />} loading={exporting} onClick={handleExcelExport}>
                导出 Excel
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={async () => {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  await invoke('open_exports_dir');
                } catch { message.warning('无法打开文件夹'); }
              }}>打开导出文件夹</Button>
              {exports.length > 0 && (
                <span style={{ fontSize: 11, color: '#94A3B8' }}>已导出 {exports.length} 个文件</span>
              )}
            </div>
            {/* 项目导出范围（勾选"项目"时显示） */}
            {exportTypes.includes('projects') && (
              <div style={{ marginTop: 4, padding: '10px 12px', background: '#F8FAFC', border: '1px solid #E5E7EB', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>项目导出范围：</span>
                <Radio.Group
                  value={exportProjectId === '' ? 'all' : String(exportProjectId)}
                  onChange={(e) => setExportProjectId(e.target.value === 'all' ? '' : Number(e.target.value))}
                  size="small"
                >
                  <Radio.Button value="all">全部项目（每项目一个 sheet）</Radio.Button>
                  <Radio.Button value="single">单个项目</Radio.Button>
                </Radio.Group>
                {exportProjectId !== '' && (
                  <Select
                    size="small" style={{ width: 240 }} placeholder="选择项目"
                    value={exportProjectId || undefined}
                    onChange={(v) => setExportProjectId(Number(v))}
                    options={allProjects.map((p: any) => ({ label: `${p.code} · ${p.name}`, value: p.id }))}
                    showSearch optionFilterProp="label"
                  />
                )}
                {exportProjectId !== '' && allProjects.length === 0 && (
                  <span style={{ fontSize: 11, color: '#F59E0B' }}>暂无项目数据</span>
                )}
              </div>
            )}
          </Card>

          {/* 备份操作 */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Button type="primary" icon={<DownloadOutlined />} loading={backingUp} onClick={handleBackup}>
                立即备份数据库
              </Button>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                将当前全部数据（器件 / 项目 / BOM / 手账 / 洞察 / 设置）打包为快照
              </span>
            </div>
          </Card>

          {/* 备份列表 */}
          <Card size="small" title={<span><DatabaseOutlined /> 已有备份（{backups.length}）</span>}>
            {backups.length === 0 ? (
              <Empty description="暂无备份 — 建议定期备份以防数据丢失" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Table
                dataSource={backups}
                rowKey="name"
                size="small"
                pagination={false}
                columns={[
                  { title: '备份文件', dataIndex: 'name', render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> },
                  { title: '大小', dataIndex: 'size', width: 110, align: 'right', render: (v: number) => `${(v / 1024).toFixed(1)} KB` },
                  {
                    title: '操作', width: 180,
                    render: (_: any, r: any) => (
                      <Space size="small">
                        <Popconfirm title={`用「${r.name}」覆盖当前数据？恢复前会自动备份当前库`} onConfirm={() => handleRestore(r.name)}>
                          <Button size="small" type="primary" icon={<CheckCircleOutlined />}>恢复</Button>
                        </Popconfirm>
                        <Popconfirm title="删除该备份？" onConfirm={() => handleDeleteBackup(r.name)}>
                          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            )}
            <div style={{ marginTop: 12, fontSize: 11.5, color: '#94A3B8' }}>
              💡 恢复后需重启应用生效；恢复前会自动把当前库备份为 costhub-pre-restore-*.db（位于 exe 同目录）
            </div>
          </Card>
        </div>
      </div>
      </>
      )}

      {/* ====== 审计日志分区 ====== */}
      {activeSection === 'audit' && (
      <>
      {/* ====== Token 用量统计 ====== */}
      <div className="content-card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}><ThunderboltOutlined /> 外部模型 Token 用量统计</h3>
          <Space>
            <Button size="small" icon={<CheckCircleOutlined />} onClick={loadTokenStats}>刷新</Button>
          </Space>
        </div>
        {!tokenStats ? (
          <Empty description="暂无用量数据（完成一次 AI 洞察后自动记录）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            {/* 总量卡片 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
              <div style={{ background: '#EEF2FF', borderRadius: 10, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: '#6B7280' }}>总 Token</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#4F46E5' }}>{(tokenStats.total.total || 0).toLocaleString()}</div>
              </div>
              <div style={{ background: '#F0FDF4', borderRadius: 10, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: '#6B7280' }}>输入 Token</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#059669' }}>{(tokenStats.total.prompt || 0).toLocaleString()}</div>
              </div>
              <div style={{ background: '#FFF7ED', borderRadius: 10, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: '#6B7280' }}>输出 Token</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#D97706' }}>{(tokenStats.total.completion || 0).toLocaleString()}</div>
              </div>
              <div style={{ background: '#F8FAFC', borderRadius: 10, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: '#6B7280' }}>调用次数</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#334155' }}>{tokenStats.total.count || 0}</div>
              </div>
            </div>
            {/* 按供应商/模型 */}
            <Table
              dataSource={tokenStats.byProvider}
              rowKey={(r: any) => `${r.provider_name}-${r.model_name}`}
              size="small"
              pagination={false}
              columns={[
                { title: '供应商', dataIndex: 'provider_name', width: 140, render: (v: string) => v || '-' },
                { title: '模型', dataIndex: 'model_name', width: 160, render: (v: string) => v || '-' },
                { title: '输入 Token', dataIndex: 'prompt', render: (v: number) => (v || 0).toLocaleString() },
                { title: '输出 Token', dataIndex: 'completion', render: (v: number) => (v || 0).toLocaleString() },
                { title: '总 Token', dataIndex: 'total', render: (v: number) => <b>{(v || 0).toLocaleString()}</b> },
                { title: '调用次数', dataIndex: 'cnt', width: 90 },
              ]}
            />
            {/* 近30天趋势 */}
            {tokenStats.daily && tokenStats.daily.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 8 }}>近 30 天 Token 消耗趋势</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80 }}>
                  {tokenStats.daily.slice(0, 30).reverse().map((d: any) => {
                    const max = Math.max(...tokenStats.daily.map((x: any) => x.total || 0), 1);
                    const h = Math.max(4, Math.round(((d.total || 0) / max) * 76));
                    return (
                      <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <div style={{ width: '70%', background: '#6366F1', borderRadius: '3px 3px 0 0', height: h, minHeight: 4 }} title={`${d.day}: ${(d.total || 0).toLocaleString()} tokens`} />
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10.5, color: '#9CA3AF', marginTop: 4, textAlign: 'center' }}>
                  {tokenStats.daily[tokenStats.daily.length - 1]?.day} → {tokenStats.daily[0]?.day}（每日总 Token）
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 10 }}>
              💡 用量仅统计外部 LLM API 调用（趋势洞察等），本地 Ollama 不产生费用。Token 消耗 × 供应商单价 ≈ 费用，可在各供应商官网查看计费标准。
            </div>
          </>
        )}
      </div>
      {/* ====== 外部请求日志 ====== */}
      <div className="content-card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}><RadarChartOutlined /> 外部请求日志</h3>
          <Space>
            <Button size="small" icon={<ApiOutlined />} onClick={loadRequestLogs}>刷新</Button>
            <Popconfirm title="清空所有日志？" onConfirm={async () => {
              const { clearOutboundRequestLogs } = await import('../db');
              await clearOutboundRequestLogs();
              message.success('已清空');
              setRequestLogs([]);
            }}>
              <Button size="small" icon={<DeleteOutlined />}>清空</Button>
            </Popconfirm>
          </Space>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
          记录所有已发出的外部查询请求。仅发送物料通用名称，不包含价格/供应商等本地数据。用户可自行验证。
        </p>
        {requestLogs.length === 0 ? (
          <Empty description="暂无外部请求记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table dataSource={requestLogs} rowKey="id" size="small" pagination={{ pageSize: 10 }}
            columns={[
              { title: '时间', dataIndex: 'requested_at', width: 150, render: (v: string) => v?.slice(0, 16) || '-' },
              { title: '关键词', dataIndex: 'query_keyword', ellipsis: true, width: 160 },
              { title: '类型', dataIndex: 'provider_type', width: 70, render: (v: string) => <Tag color={v === 'search' ? 'blue' : 'purple'}>{v === 'search' ? '搜索' : 'LLM'}</Tag> },
              { title: '供应商', dataIndex: 'provider_name', width: 120 },
              { title: '关联物料', dataIndex: 'related_component_name', width: 120 },
              { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{v === 'success' ? <><CheckCircleOutlined /> 成功</> : <><CloseCircleOutlined /> 失败</>}</Tag> },
            ]} />
        )}
      </div>

      {/* ====== AI请求日志（审计用） ====== */}
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0 }}><SearchOutlined /> AI请求日志</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
              查看所有AI请求的详细记录，确保数据安全
            </p>
          </div>
          <Space>
            <Button size="small" onClick={loadAILogs}>刷新</Button>
            <Popconfirm title="确定清空所有AI日志？" onConfirm={clearAILogs} okText="确定" cancelText="取消">
              <Button size="small" danger>清空日志</Button>
            </Popconfirm>
          </Space>
        </div>

        {aiLogs.length === 0 ? (
          <Empty description="暂无AI请求记录" />
        ) : (
          <Table
            dataSource={aiLogs}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => v || '-' },
              { title: '类型', dataIndex: 'request_type', width: 100, render: (v: string) => {
                const typeMap: Record<string, string> = {
                  'general': '通用',
                  'trend_insight': '趋势洞察',
                  'decompose': 'AI拆解',
                  'local_ai_chat': '本地AI对话',
                };
                return typeMap[v] || v;
              }},
              { title: '物料名称', dataIndex: 'material_name', width: 130, ellipsis: true },
              { title: 'System Prompt', dataIndex: 'system_prompt', width: 180, ellipsis: true, render: (v: string) => (
                <Tooltip title={v}>
                  <span>{v ? `${v.slice(0, 40)}...` : '-'}</span>
                </Tooltip>
              )},
              { title: 'User Prompt', dataIndex: 'user_prompt', width: 180, ellipsis: true, render: (v: string) => (
                <Tooltip title={v}>
                  <span>{v ? `${v.slice(0, 40)}...` : '-'}</span>
                </Tooltip>
              )},
              { title: '响应摘要', dataIndex: 'response_summary', width: 200, ellipsis: true, render: (v: string) => (
                <Tooltip title={v}>
                  <span>{v ? `${v.slice(0, 50)}...` : '-'}</span>
                </Tooltip>
              )},
              { title: '供应商 / 模型', key: 'provider', width: 160, render: (_: any, r: any) => (
                <span style={{ fontSize: 12 }}>
                  {r.provider_name ? <Tag color="blue" style={{ margin: 0 }}>{r.provider_name}</Tag> : <span style={{ color: '#999' }}>本地</span>}
                  {r.model_name && <span style={{ marginLeft: 4, color: '#64748B' }}>{r.model_name}</span>}
                </span>
              )},
              { title: 'Token 用量', key: 'tokens', width: 110, align: 'right' as const, render: (_: any, r: any) => (
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                  {r.total_tokens ? `${r.total_tokens} (↑${r.prompt_tokens || 0} / ↓${r.completion_tokens || 0})` : '-'}
                </span>
              )},
              { title: '状态', dataIndex: 'success', width: 80, render: (v: number) => (
                <Tag color={v ? 'green' : 'red'}>{v ? <><CheckCircleOutlined /> 成功</> : <><CloseCircleOutlined /> 失败</>}</Tag>
              )},
              { title: '操作', key: 'action', width: 80, render: (_: any, record: any) => (
                <Button size="small" type="link" onClick={() => {
                  Modal.info({
                    title: 'AI请求详情',
                    width: 900,
                    content: (
                      <div style={{ maxHeight: 560, overflow: 'auto', paddingRight: 4 }}>
                        {/* 基础信息网格 */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 16px', marginBottom: 14 }}>
                          <div><div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 2 }}>时间</div><div style={{ fontSize: 13 }}>{record.created_at}</div></div>
                          <div><div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 2 }}>类型</div><div style={{ fontSize: 13 }}>{record.request_type}</div></div>
                          <div><div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 2 }}>物料名称</div><div style={{ fontSize: 13 }}>{record.material_name || '-'}</div></div>
                          <div><div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 2 }}>供应商 / 模型</div><div style={{ fontSize: 13 }}>{record.provider_name || '本地'}{record.model_name ? ` / ${record.model_name}` : ''}</div></div>
                          <div><div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 2 }}>Token 用量</div><div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                            {record.total_tokens ? `输入 ${record.prompt_tokens || 0} · 输出 ${record.completion_tokens || 0} · 合计 ${record.total_tokens}` : '-'}
                          </div></div>
                          <div><div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 2 }}>状态</div><div style={{ fontSize: 13 }}>{record.success ? <span style={{ color: '#16A34A' }}>✓ 成功</span> : <span style={{ color: '#DC2626' }}>✗ 失败</span>}</div></div>
                        </div>
                        {/* 提示词/响应：label 在上，内容独立成块可滚动 */}
                        {[
                          { label: 'System Prompt（发送给外部 AI 的系统提示词）', content: record.system_prompt },
                          { label: 'User Prompt（发送给外部 AI 的用户提示词）', content: record.user_prompt },
                          { label: '响应摘要', content: record.response_summary },
                          ...(!record.success && record.error_message ? [{ label: '错误信息', content: record.error_message }] : []),
                        ].map(section => (
                          <div key={section.label} style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 4 }}>{section.label}</div>
                            <pre style={{
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12,
                              margin: 0, padding: 10, background: '#F8FAFC', borderRadius: 8,
                              maxHeight: 180, overflow: 'auto', border: '1px solid #EEF0F4',
                              color: section.label.includes('错误') ? '#DC2626' : '#374151',
                            }}>{section.content || '-'}</pre>
                          </div>
                        ))}
                      </div>
                    ),
                  });
                }}>详情</Button>
              )},
            ]}
          />
        )}
      </div>
      </>
      )}

      {/* ====== 关于分区 ====== */}
      {activeSection === 'about' && (
      <>
      {/* ====== 配置说明 ====== */}
      <div className="content-card">
        <h3><BookOutlined /> 配置说明</h3>
        <Descriptions column={1} size="small" bordered style={{ marginTop: 12 }}>
          <Descriptions.Item label="存储安全">
            API Key 使用 AES-GCM 加密后存储于本地数据库中，同一设备可解密，不同设备无法解密。
          </Descriptions.Item>
          <Descriptions.Item label="数据发送范围">
            趋势查询时仅向外部 API 发送物料的通用名称，不发送采购价/供应商/BOM等内部数据。
          </Descriptions.Item>
          <Descriptions.Item label="费用说明">
            各供应商免费额度以官网为准。预置列表中已标注参考额度，实际可能有变动。
          </Descriptions.Item>
        </Descriptions>
      </div>
      </>
      )}
        </div>
      </div>
      {/* ====== 分析记忆触发日志模态框 ====== */}
      <Modal title="触发日志" open={logModalOpen} onCancel={() => setLogModalOpen(false)} footer={null} width={600}>
        {logData.length === 0 ? <Empty description="暂无日志" /> : (
          <Table dataSource={logData} rowKey="id" size="small" pagination={false}
            columns={[
              { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => v?.slice(0, 16) || '-' },
              { title: '追问原文', dataIndex: 'question_snippet', ellipsis: true },
            ]} />
        )}
      </Modal>
    </div>
  );
}
