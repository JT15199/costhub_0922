import { openInsightCenter } from './insightNavigation';
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Button,  message, Dropdown, Modal, Badge, Tooltip, Input, List, Empty, Tag } from 'antd';
import { runAutoCompare } from './autoCompare';
import { runAutoAdvisor } from './autoAdvisor';
import { getInsights } from './db';
import defaultLogo from './assets/costhub-logo.png';
// 页面级懒加载（v2.3.19 性能优化）：按页分包，首次进入才加载对应 chunk
const Dashboard = lazy(() => import('./pages/Dashboard'));
const PartsLibrary = lazy(() => import('./pages/PartsLibrary'));
const ModuleLibrary = lazy(() => import('./pages/ModuleLibrary'));
const Projects = lazy(() => import('./pages/Projects'));
const Competitors = lazy(() => import('./pages/Competitors'));
const Compare = lazy(() => import('./pages/Compare'));
const Reports = lazy(() => import('./pages/Reports'));
const Decomposition = lazy(() => import('./pages/Decomposition'));
const SupplierManagement = lazy(() => import('./pages/SupplierManagement'));
const Settings = lazy(() => import('./pages/Settings'));
const UserVoice = lazy(() => import('./pages/UserVoice'));
const QuoteReview = lazy(() => import('./pages/QuoteReview'));
const WorkLog = lazy(() => import('./pages/WorkLog'));
const AnalysisResults = lazy(() => import('./pages/AnalysisResults'));
const Intelligence = lazy(() => import('./pages/Intelligence'));
const Library = lazy(() => import('./pages/Library'));
const LoginScreen = lazy(() => import('./pages/LoginScreen'));
import { ThemeProvider } from './theme/ThemeContext';
import { ThemeSwitcher } from './theme/ThemeSwitcher';
import CloudConfirmBar from './components/CloudConfirmBar';
import AIUsageGuide from './components/AIUsageGuide';
import AiPanel from './components/AiPanel';
import ErrorBoundary from './components/ErrorBoundary';
import {
  BarChartOutlined, AppstoreOutlined, ProjectOutlined, SearchOutlined,
  SettingOutlined, RobotOutlined, BookOutlined, BulbOutlined, LockOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, BranchesOutlined
} from '@ant-design/icons';

// 一级导航只保留五个工作入口；AI 是全局能力，资料与情报页负责收拢各自的唯一维护入口。
const NAV: { key: string; label: string; icon: any; iconBg: string; iconColor: string }[] = [
  { key: 'dashboard',    label: '今日工作台', icon: <BarChartOutlined />, iconBg: '#EFF6FF', iconColor: '#3B82F6' },
  { key: 'projects',     label: '项目',       icon: <ProjectOutlined />,  iconBg: '#F0FDF4', iconColor: '#16A34A' },
  { key: 'intelligence', label: '情报',       icon: <BranchesOutlined />, iconBg: '#EFF6FF', iconColor: '#2F6FED' },
  { key: 'library',      label: '资料库',     icon: <AppstoreOutlined />, iconBg: '#F5F3FF', iconColor: '#8B5CF6' },
  { key: 'workLog',      label: '工作手账',   icon: <BookOutlined />,      iconBg: '#ECFDF5', iconColor: '#059669' },
];

const PRIMARY_NAV_KEYS = new Set(NAV.map(item => item.key));
const LEGACY_PAGE_ALIASES: Record<string, string> = {
  analysisResults: 'intelligence', decomposition: 'intelligence',
  parts: 'library', modules: 'library', supplierManagement: 'library', competitors: 'library',
  compare: 'projects', reports: 'projects', quoteReview: 'projects', userVoice: 'projects',
};
const getInitialPage = () => {
  const saved = localStorage.getItem('app-active') || 'dashboard';
  return PRIMARY_NAV_KEYS.has(saved) ? saved : LEGACY_PAGE_ALIASES[saved] || 'dashboard';
};

const ZOOM_LEVELS = [80, 100, 125, 150];

// 对话优先（2026-08-27 用户：指定任务时后台自主扫描是否冲突——Ollama 单实例串行，用户在 AI 协作窗对话时后台引擎让路，避免抢模型拖慢对话）
const dialogActive = () => { try { return !!(window as any).__costhub_ai_dialog; } catch { return false; } };

export default function App() {
  const [active, setActive] = useState(getInitialPage);
  // 登录门禁：null=未登录(显示登录页) false=受限模式(不显示数据) true=已解锁
  const [authed, setAuthed] = useState<boolean | null>(null);
  // 已挂载的页面集合：初始包含当前页，切走的页面保持挂载，切回时不重新加载
  const [mountedPages, setMountedPages] = useState<Set<string>>(() => new Set([getInitialPage()]));
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('app-zoom');
    return saved ? parseInt(saved) : 100;
  });
  // 系统设置弹窗
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 全局 AI 问询
  // 首次 AI 能力引导
  const [aiGuideOpen, setAiGuideOpen] = useState(false);
  // 使用说明弹窗
  const [guideOpen, setGuideOpen] = useState(false);
  const [customLogo] = useState(() => localStorage.getItem('costhub_custom_logo') || '');
  // 侧边栏折叠（借鉴 DSH：收进去只显示常用 3 个功能）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  const toggleSidebar = () => { const v = !sidebarCollapsed; setSidebarCollapsed(v); localStorage.setItem('sidebar-collapsed', v ? '1' : '0'); };
  // 项目管理上下文直接复用应用左侧栏，避免页面内部再占一列、挤压 BOM 工作区。
  const [sidebarProjects, setSidebarProjects] = useState<any[]>([]);
  const [sidebarProjectStatuses, setSidebarProjectStatuses] = useState<Record<number, any>>({});
  const [sidebarSelectedProject, setSidebarSelectedProject] = useState<number | null>(null);
  const [sidebarProjectQuery, setSidebarProjectQuery] = useState('');
  // 驾驶舱直达项目的延迟转发：只允许转发一次，避免 App 自己再次接收后形成循环跳转。
  const projectRouteTimerRef = useRef<number | null>(null);
  // 当前登录用户名（侧边栏底部显示）
  const [currentUser, setCurrentUser] = useState('');
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchKeyword, setGlobalSearchKeyword] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<any[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const globalSearchRequest = useRef(0);

  const runGlobalSearch = useCallback(async (value: string) => {
    const query = value.trim().toLocaleLowerCase();
    const request = ++globalSearchRequest.current;
    if (!query) { setGlobalSearchResults([]); return; }
    setGlobalSearchLoading(true);
    try {
      const db = await import('./db');
      const [projects, parts, competitors, artifacts] = await Promise.all([db.getProjects('', '', ''), db.getParts('', '', ''), db.getCompetitors(''), db.getAnalysisArtifacts(120)]);
      const measures = (await Promise.all(projects.map((project: any) => db.getMeasures(project.id).catch(() => [])))).flat().map((row: any) => ({ ...row, _project: projects.find((project: any) => project.id === row.project_id) }));
      const batches = (await Promise.all(projects.map((project: any) => db.getTenderQuoteBatches(project.id).catch(() => [])))).flat().map((row: any) => ({ ...row, _project: projects.find((project: any) => project.id === row.projectId) }));
      const match = (values: unknown[]) => values.some(value => String(value ?? '').toLocaleLowerCase().includes(query));
      const next = [
        ...projects.filter(row => match([row.code, row.name, row.category])).map(row => ({ type: 'project', title: `${row.code} · ${row.name}`, meta: `${row.category || '未分类'} · ${row.status || '进行中'}`, projectId: row.id, tab: 'overview' })),
        ...parts.filter(row => match([row.name, row.model, row.specs, row.category])).map(row => ({ type: 'part', title: `${row.name} · ${row.model}`, meta: `${row.category || '未分类'} · 最新参考价 ¥${Number(row.cost || 0).toFixed(4)}`, partId: row.id })),
        ...competitors.filter(row => match([row.brand, row.model, row.tier])).map(row => ({ type: 'competitor', title: `${row.brand} · ${row.model}`, meta: `竞品 · ${row.tier || '未分类'}`, competitorId: row.id })),
        ...batches.filter(row => match([row.supplierName, row.batchNo, row.sourceFileName, row.roundName])).map(row => ({ type: 'quote', title: `${row.supplierName || '未命名供应商'} · ${row.batchNo || '报价批次'}`, meta: `${row._project?.code || '未关联项目'} · ¥${Number(row.totalAmount || 0).toFixed(2)}`, projectId: row.projectId, tab: 'tender' })),
        ...measures.filter(row => match([row.measure, row.main_category, row.owner, row.status])).map(row => ({ type: 'measure', title: row.measure || '未命名措施', meta: `${row._project?.code || '未关联项目'} · ${row.status || '待执行'}`, projectId: row.project_id, tab: 'measures' })),
        ...artifacts.filter(row => match([row.title, row.summary])).map(row => ({ type: 'artifact', title: row.title, meta: `分析成果 · ${String(row.created_at || '').slice(0, 16)}`, artifactId: row.id })),
      ].slice(0, 40);
      if (request === globalSearchRequest.current) setGlobalSearchResults(next);
    } catch (error) {
      if (request === globalSearchRequest.current) setGlobalSearchResults([]);
      console.warn('全局搜索失败:', error);
    } finally {
      if (request === globalSearchRequest.current) setGlobalSearchLoading(false);
    }
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setGlobalSearchOpen(true); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => runGlobalSearch(globalSearchKeyword), 160);
    return () => window.clearTimeout(timer);
  }, [globalSearchKeyword, runGlobalSearch]);

  // ====== 报价比对：持续后台探查（只要 Ollama 空闲就扫；60 秒一轮，探查仔细不急；发现情报才提示） ======
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number; current: string; remaining?: number } | null>(null);
  const [insightCount, setInsightCount] = useState(0);
  const autoRunningRef = useRef(false);
  const refreshInsightCount = useCallback(async () => {
    try {
      // AI 情报中心 badge 三合一（2026-08-17）：报价差异未读 + 自主建议待处理 + 巡检发现未读
      const ins = (await getInsights()).filter((i: any) => i.status === 'unread').length;
      const { getAdvisorInsights } = await import('./db/advisor');
      const adv = (await getAdvisorInsights('open')).length;
      const { getAuditFindings } = await import('./auditStore');
      const aud = (await getAuditFindings()).filter((x: any) => x.status === 'unread').length;
      setInsightCount(ins + adv + aud);
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { refreshInsightCount(); }, [refreshInsightCount]);
  const scheduleAppCompare = useCallback(() => {
    if (autoRunningRef.current) return;
    if (dialogActive()) return; // 对话优先让路
    autoRunningRef.current = true;
    (async () => {
      let didWork = false;
      const r = await runAutoCompare(p => { didWork = true; setAutoProgress(p); window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: '报价识别：' + p.current } })); });
      setAutoProgress(null);
      autoRunningRef.current = false;
      window.dispatchEvent(new CustomEvent('costhub-compare-done'));
      // ⚠️ 只有真实识别了模块才广播"完成"（2026-08-17 修复：缓存全命中时不再每 60 秒闪现"刚刚完成 报价识别"）
      if (didWork) window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: '报价识别', done: true } }));
      refreshInsightCount();
            // 分批提示：一轮只识别 3 个模块（60 秒后自动续下一批）；⚠️ 2026-08-18 失败静默（超时/失败模块下一轮自动续试，不再弹"模型太慢"打扰），只有发现情报才提示
      if (r) {
        if (r.remaining > 0) {
          if (r.insights > 0) {
            message.info(`本批识别发现 ${r.insights} 条报价情报（见「AI 情报」）；剩余 ${r.remaining} 个模块自动继续`);
          }
        } else if (r.scanned > 0 && r.insights > 0) {
          message.success(`识别完成：发现 ${r.insights} 条报价情报（见「AI 情报」）`);
        }
      }
    })();
  }, []);
  // ====== 自主分析（AI 助理后台建议）：事件优先，空闲时轮换补扫 ======
  const advisorRunningRef = useRef(false);
  const lastAdvisorAtRef = useRef(0);
  const scheduleAppAdvisor = useCallback((force = false) => {
    if (advisorRunningRef.current) return;
    if (dialogActive()) return; // 对话优先让路
    const now = Date.now();
    if (!force && now - lastAdvisorAtRef.current < 5 * 60 * 1000) return;
    advisorRunningRef.current = true;
    lastAdvisorAtRef.current = now;
    (async () => {
      try {
        const r = await runAutoAdvisor(msg => window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: msg } })));
        // ⚠️ 只有真实产出才广播"完成"（2026-08-17 修复：规则无新发现时不再每 60 秒闪现"刚刚完成 自主巡检"）
        if (r && (r.found > 0 || r.aiEnhanced > 0)) {
          window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: '自主巡检', done: true } }));
        }
        // 只在新建议出现时提醒（日常轮询静默）
        if (r && r.found > 0) {
          message.success({ content: <span>发现 {r.found} 条成本机会/风险点 <Button type="link" size="small" onClick={() => openInsightCenter(navigate, 'advice')}>查看自主建议 →</Button></span>, duration: 8 });
        }
      } catch (e) { console.warn('自主分析失败:', e); }
      advisorRunningRef.current = false;
    })();
  }, []);
  useEffect(() => {
    // ponytail: 先用共享事件做范围触发；15 分钟补扫一次，避免每 60 秒全库扫描。
    const iv = setInterval(() => scheduleAppAdvisor(), 15 * 60 * 1000);
    const events = ['costhub-project-bom-updated', 'costhub-targets-updated', 'costhub-quote-review-updated', 'costhub-trend-updated', 'costhub-supplier-updated', 'costhub-project-saved'];
    const onDataChanged = () => scheduleAppAdvisor();
    events.forEach(event => window.addEventListener(event, onDataChanged));
    scheduleAppAdvisor(true); // 打开应用立即探查一轮
    return () => { clearInterval(iv); events.forEach(event => window.removeEventListener(event, onDataChanged)); };
  }, [scheduleAppAdvisor]);
  // ====== 关键物料自动洞察：60 秒轮询，闸门节流（30 天周期 + 7 天复用 + 每日预算），启动立即一轮 ======
  const insightRunningRef = useRef(false);
  const scheduleAppInsight = useCallback(() => {
    if (insightRunningRef.current) return;
    if (dialogActive()) return; // 对话优先让路
    insightRunningRef.current = true;
    (async () => {
      try {
        const { runAutoInsight } = await import('./autoInsight');
        const r = await runAutoInsight({
          onProgress: msg => window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: msg } })),
        });
        // ⚠️ 只有真正产出洞察才广播"完成"（2026-08-17 修复：闸门等待/复用轮次不再每 60 秒闪现"刚刚完成 关键物料洞察"）
        if (r && r.insights > 0) {
          window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: '关键物料洞察', done: true } }));
          window.dispatchEvent(new CustomEvent('costhub-insight-done'));
          message.success(`关键物料洞察完成：本轮洞察 ${r.insights} 类物料行情（共 ${r.planned} 个关键子类，见驾驶舱「关键物料洞察」）`);
        }
      } catch { /* 静默：识别/洞察失败不打扰 */ }
      insightRunningRef.current = false;
    })();
  }, []);
  useEffect(() => {
    const iv = setInterval(() => scheduleAppInsight(), 60 * 1000);
    scheduleAppInsight(); // 打开应用立即识别一轮（闸门免费判断，未到周期/预算不烧调用）
    // 云端确认队列放行后（CloudConfirmBar 确认 → costhub-insight-request）立即继续自动洞察
    const onInsightRequest = () => scheduleAppInsight();
    window.addEventListener('costhub-insight-request', onInsightRequest);
    return () => {
      clearInterval(iv);
      window.removeEventListener('costhub-insight-request', onInsightRequest);
    };
  }, [scheduleAppInsight]);
  useEffect(() => {
    // 持续轮询：每 60 秒探查一轮（Ollama 未运行/未配置自动跳过；指纹命中不调模型，只有变化才识别——探查仔细，不快）
    const iv = setInterval(() => scheduleAppCompare(), 60 * 1000);
    scheduleAppCompare(); // 打开应用立即探查一轮
    // 导入/改价等变更事件（Projects 触发）→ 强制立即扫描
    const onRequest = () => scheduleAppCompare();
    const onInsightsChanged = () => refreshInsightCount();
    window.addEventListener('costhub-compare-request', onRequest);
    window.addEventListener('costhub-insights-changed', onInsightsChanged);
    return () => {
      clearInterval(iv);
      window.removeEventListener('costhub-compare-request', onRequest);
      window.removeEventListener('costhub-insights-changed', onInsightsChanged);
    };
  }, [scheduleAppCompare, refreshInsightCount]);

  // ====== 后台自主分析（AI 自发思考，2026-08-17 用户核心需求）：启动 + 每 15 分钟一轮 + 数据变更后 5 分钟节流 ======
  const thinkRunningRef = useRef(false);
  const lastThinkAtRef = useRef(0);
  const scheduleAppThink = useCallback((force = false) => {
    if (thinkRunningRef.current) return;
    if (dialogActive()) return; // 对话优先让路（2026-08-27：用户在 AI 窗对话时后台自主分析跳过本轮）
    const now = Date.now();
    if (!force && now - lastThinkAtRef.current < 5 * 60 * 1000) return; // 数据变更触发节流 5 分钟
    thinkRunningRef.current = true;
    lastThinkAtRef.current = now;
    (async () => {
      try {
        const { runAutoThink } = await import('./autoThink');
        await runAutoThink({
          onEvent: (ev) => window.dispatchEvent(new CustomEvent('costhub-think-event', { detail: ev })),
        });
      } catch { /* 静默：自主分析失败不打扰 */ }
      thinkRunningRef.current = false;
    })();
  }, []);
  useEffect(() => {
    const iv = setInterval(() => scheduleAppThink(), 15 * 60 * 1000);
    scheduleAppThink(); // 打开应用立即自发分析一轮
    // 数据变化（导入/改价/BOM 变更）后节流触发
    const onDataChanged = () => scheduleAppThink();
    window.addEventListener('costhub-compare-request', onDataChanged);
    // ⚠️ 新项目驱动（2026-08-18 用户方向）：成本不常变，新项目才是分析动力——保存新项目立即强制一轮自主分析
    const onProjectSaved = () => scheduleAppThink(true);
    window.addEventListener('costhub-project-saved', onProjectSaved);
    return () => { clearInterval(iv); window.removeEventListener('costhub-compare-request', onDataChanged); window.removeEventListener('costhub-project-saved', onProjectSaved); };
  }, [scheduleAppThink]);

  // 启动时初始化默认密码（仅首次）
  useEffect(() => {
    (async () => {
      try {
        const { ensureAuthPassword, getUsername } = await import('./db');
        await ensureAuthPassword();
        setCurrentUser(await getUsername());
      } catch (e) { console.error('初始化密码失败:', e); }
    })();
  }, []);

  const handleUnlock = () => {
    (async () => {
      const { setDataLocked, syncPartsProjectsField } = await import('./db');
      setDataLocked(false);
      setAuthed(true);
      // 修复 parts.projects 字段（历史数据未更新项目关联）
      try { await syncPartsProjectsField(); } catch (e) { console.warn('projects 字段修复失败:', e); }
      // 首次使用 AI 能力引导（只看一次）
      if (!localStorage.getItem('costhub-ai-guide-seen')) {
        localStorage.setItem('costhub-ai-guide-seen', '1');
        setAiGuideOpen(true);
      }
    })();
  };

  // AI 使用指南：任何页面可 dispatch costhub-open-ai-guide 打开（右侧 AI 协作窗/设置页按钮）
  useEffect(() => {
    const h = () => setAiGuideOpen(true);
    window.addEventListener('costhub-open-ai-guide', h);
    return () => window.removeEventListener('costhub-open-ai-guide', h);
  }, []);

  const handleEnterRestricted = () => {
    (async () => {
      const { setDataLocked } = await import('./db');
      setDataLocked(true); // 保持锁定：查询返回空
      setAuthed(false);
    })();
  };

  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon && customLogo) icon.href = customLogo;
  }, [customLogo]);

  // 添加开发者工具快捷键（Tauri 2.x）
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // F12 或 Ctrl+Shift+I 打开开发者工具
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        e.preventDefault();
        try {
          // @ts-ignore - Tauri 2.x API
          if (window.__TAURI__?.invoke) {
            // @ts-ignore
            await window.__TAURI__.invoke('plugin:devtools|open');
          }
        } catch (err) {
          console.error('无法打开开发者工具:', err);
          message.error('开发者工具打开失败，请右键选择"检查元素"打开控制台');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const navigate = useCallback((key: string) => {
    const target = LEGACY_PAGE_ALIASES[key] || key;
    const intelligenceTab = target === 'intelligence'
      ? key === 'analysisResults' ? 'results' : key === 'decomposition' ? 'material' : undefined
      : undefined;
    if (intelligenceTab) localStorage.setItem('costhub-intelligence-tab', intelligenceTab);
    if (target === 'library' && ['parts', 'modules', 'supplierManagement', 'competitors'].includes(key)) {
      localStorage.setItem('costhub-library-tab', key === 'supplierManagement' ? 'suppliers' : key);
    }
    // 用户主动离开项目页时，取消尚未执行的直达项目转发，避免切页后又被旧事件拉回。
    if (target !== 'projects' && projectRouteTimerRef.current !== null) {
      window.clearTimeout(projectRouteTimerRef.current);
      projectRouteTimerRef.current = null;
    }
    // 保持目标页面挂载（页面切走不卸载，切回不重连）
    setMountedPages(prev => {
      const next = new Set(prev);
      next.add(target);
      return next;
    });
    setActive(target);
    localStorage.setItem('app-active', target);
    // 通知目标页面刷新（模块库等页面在其它页面改动数据后需要重新加载）
    window.dispatchEvent(new CustomEvent('app-page-active', { detail: { page: target, ...(intelligenceTab ? { tab: intelligenceTab } : {}) } }));
  }, []);

  // 侧边栏「报价情报」入口：任何页面可点 → 跳项目管理页并打开情报弹窗
  // ⚠️ 2026-08-17 修复：原来直接 setActive('projects') 不走 navigate → mountedPages 没有 projects 时白屏；
  // 且事件在 Projects 组件挂载前发出 → 没反应。现在 navigate 挂载页面 + localStorage 标志兜底（组件挂载后消费）+ 延迟事件双保险
  // 结果可视化跳转（2026-08-19）：costhub-open-project → 切项目页 + 延迟重发选中（Projects 懒加载需挂载后接收）
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const pid = detail.pid;
      if (!pid) return;
      try { sessionStorage.setItem('costhub-open-project-pending', JSON.stringify(detail)); } catch { }
      navigate('projects');
      // 转发事件由 Projects 消费，但 App 不应再次安排下一次转发。
      if (detail.__costhubForwarded) return;
      if (projectRouteTimerRef.current !== null) window.clearTimeout(projectRouteTimerRef.current);
      projectRouteTimerRef.current = window.setTimeout(() => {
        projectRouteTimerRef.current = null;
        window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { ...detail, __costhubForwarded: true } }));
      }, 300);
    };
    window.addEventListener('costhub-open-project', h);
    return () => {
      window.removeEventListener('costhub-open-project', h);
      if (projectRouteTimerRef.current !== null) window.clearTimeout(projectRouteTimerRef.current);
      projectRouteTimerRef.current = null;
    };
  }, [navigate]);

  useEffect(() => {
    const h = () => navigate('decomposition');
    window.addEventListener('costhub-open-material-insight', h);
    return () => window.removeEventListener('costhub-open-material-insight', h);
  }, [navigate]);

  useEffect(() => {
    const onProjectNavData = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      setSidebarProjects(Array.isArray(detail.projects) ? detail.projects : []);
      setSidebarProjectStatuses(detail.statuses || {});
      setSidebarSelectedProject(detail.selectedPid ?? null);
    };
    window.addEventListener('costhub-project-nav-data', onProjectNavData);
    return () => window.removeEventListener('costhub-project-nav-data', onProjectNavData);
  }, []);

  const openSidebarProject = useCallback((pid: number) => {
    setSidebarSelectedProject(pid);
    window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid, __costhubForwarded: true } }));
  }, []);

  const openInsightsEntry = useCallback(() => {
    openInsightCenter(navigate);
  }, [navigate]);

  const openGlobalSearchResult = useCallback((result: any) => {
    setGlobalSearchOpen(false);
    if (result.projectId) {
      window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid: result.projectId, tab: result.tab || 'overview' } }));
    } else if (result.type === 'part') {
      localStorage.setItem('costhub-part-search', result.title.split(' · ')[0]);
      navigate('parts');
      window.dispatchEvent(new CustomEvent('costhub-open-part', { detail: { search: result.title.split(' · ')[0] } }));
    } else if (result.type === 'competitor') {
      navigate('competitors');
    } else if (result.type === 'artifact') {
      navigate('analysisResults');
    }
  }, [navigate]);


  const setZoomLevel = (level: number) => {
    setZoom(level);
    localStorage.setItem('app-zoom', String(level));
  };

  const renderPage = (key: string) => {
    switch (key) {
      case 'dashboard': return <Dashboard onNavigate={navigate} />;
      case 'intelligence': return <Intelligence />;
      case 'library': return <Library />;
      case 'parts': return <PartsLibrary />;
      case 'modules': return <ModuleLibrary />;
      case 'projects': return <Projects />;
      case 'competitors': return <Competitors />;
      case 'compare': return <Compare />;
      case 'reports': return <Reports />;
      case 'decomposition': return <Decomposition />;
      case 'supplierManagement': return <SupplierManagement />;
      case 'userVoice': return <UserVoice />;
      case 'quoteReview': return <QuoteReview />;
      case 'workLog': return <WorkLog />;
      case 'analysisResults': return <AnalysisResults />;
      default: return <Dashboard onNavigate={navigate} />;
    }
  };

  // 所有已挂载页面共存，当前页显示且淡入，其余隐藏（保持状态，切回不卡顿）
  const render = () => (
    <>
      {Array.from(mountedPages).map(key => (
        <div
          key={key}
          className={key === active ? 'page-enter' : ''}
          style={{ display: key === active ? 'block' : 'none', height: '100%' }}
        >
          <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>加载中…</div>}>
            <ErrorBoundary label={key}>
              {renderPage(key)}
            </ErrorBoundary>
          </Suspense>
        </div>
      ))}
    </>
  );

  return (
    <ThemeProvider>
      {authed === null ? (
        // ===== 登录门禁 =====
        <LoginScreen onUnlock={handleUnlock} onEnterRestricted={handleEnterRestricted} />
      ) : (
        <>
      {authed === false && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1200, background: '#FFF7E6', borderBottom: '1px solid #FFD591', padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#874D00' }}>
          <LockOutlined style={{ color: '#D46B08' }} />
          <span><b>受限模式</b>：当前未解锁，所有数据不可见、写入已跳过。</span>
          <a style={{ marginLeft: 'auto', color: '#D46B08', fontWeight: 600, cursor: 'pointer' }} onClick={() => setAuthed(null)}>返回登录页解锁 →</a>
        </div>
      )}
      {autoProgress && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, background: '#EEF2FF', borderBottom: '1px solid #C7D2FE', padding: '3px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#334155' }}>
          <RobotOutlined className="ai-breathe" style={{ color: '#0A84FF' }} />
          <span>正在后台识别物料报价差异（{autoProgress.done}/{autoProgress.total}）· 当前：{autoProgress.current}{autoProgress.remaining ? `· 剩余 ${autoProgress.remaining} 个模块分批自动继续` : ''}…发现异常会通过「报价情报」提醒</span>
        </div>
      )}
      {/* 受控云端研究：仅显示已通过敏感审查、等待条件审批的公开主题 */}
      <CloudConfirmBar />
      <aside className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'}`} style={{ width: sidebarCollapsed ? 52 : 204, minWidth: sidebarCollapsed ? 52 : 204, overflow: 'hidden' }}>
        {sidebarCollapsed ? (
          <div className="sidebar-collapsed-content" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0', gap: 6 }}>
            <div className="sidebar-collapsed-logo"><img src={customLogo || defaultLogo} alt="CostHub" /></div>
            <Tooltip title="全局搜索（Ctrl+K）" placement="right"><button type="button" aria-label="全局搜索" onClick={() => setGlobalSearchOpen(true)} style={{ width: 34, height: 34, border: 0, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5F5D54', background: 'transparent' }}><SearchOutlined /></button></Tooltip>
            {NAV.map(item => (
              <Tooltip title={item.label} placement="right" key={item.key}>
                <button type="button" aria-label={item.label} onClick={() => navigate(item.key)} style={{ width: 34, height: 34, border: 0, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: active === item.key ? '#181713' : '#5F5D54', background: active === item.key ? '#F4F3EE' : 'transparent' }}>
                  {item.icon}
                </button>
              </Tooltip>
            ))}
            <Tooltip title="AI 协作窗" placement="right"><div onClick={() => window.dispatchEvent(new Event('costhub-ai-toggle'))} style={{ width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5F5D54' }}><RobotOutlined style={{ fontSize: 16 }} /></div></Tooltip>
            <div style={{ flex: 1 }} />
            <Tooltip title="展开侧边栏" placement="right"><div onClick={toggleSidebar} style={{ width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9A978B' }}><MenuUnfoldOutlined /></div></Tooltip>
          </div>
        ) : (
          <div className="sidebar-expanded-content">
        <div className="sidebar-logo">
          <div className="logo-img">
            {customLogo
              ? <img src={customLogo} alt="CostHub Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : <img src={defaultLogo} alt="CostHub Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
          </div>
          <div><h1>CostHub</h1><span>成本管理平台</span></div>
        </div>
        <button type="button" className="global-search-trigger" onClick={() => setGlobalSearchOpen(true)}><SearchOutlined /><span>搜索项目、器件、报价</span><kbd>Ctrl K</kbd></button>
        <nav className={`sidebar-nav ${active === 'projects' ? 'has-project-context' : ''}`}>
          {NAV.map(item => (
            <div key={item.key} data-testid={`nav-${item.key}`} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => navigate(item.key)}>
              <span className="nav-icon" style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: item.iconBg,
                color: item.iconColor,
                fontSize: 14,
                transition: 'transform 0.15s',
                boxShadow: active === item.key ? `0 2px 6px ${item.iconColor}30` : 'none',
              }}>
                {item.icon}
              </span>
              {item.label}
            </div>
          ))}
</nav>

        {active === 'projects' && (
          <section className="app-project-navigator" aria-label="项目列表">
            <div className="app-project-navigator-head">
              <b>项目</b><span>{sidebarProjects.length}</span>
            </div>
            <input
              className="app-project-search"
              value={sidebarProjectQuery}
              onChange={e => setSidebarProjectQuery(e.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
            />
            <div className="app-project-list">
              {sidebarProjects
                .filter((project: any) => `${project.code || ''} ${project.name || ''}`.toLowerCase().includes(sidebarProjectQuery.trim().toLowerCase()))
                .sort((a: any, b: any) => Number(a.project_type === '已完成') - Number(b.project_type === '已完成'))
                .map((project: any) => {
                  const status = sidebarProjectStatuses[project.id];
                  const color = project.project_type === '已完成' ? '#34C759' : status?.level === 'danger' ? '#EF4444' : status?.level === 'warn' ? '#F59E0B' : '#3B82F6';
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className={`app-project-item ${sidebarSelectedProject === project.id ? 'is-active' : ''}`}
                      onClick={() => openSidebarProject(project.id)}
                      title={`${project.code || ''} ${project.name || ''}`}
                    >
                      <i style={{ background: color }} />
                      <span><b>{project.code || '未编号'}</b><small>{project.name || '未命名项目'}</small></span>
                      <em>{project.project_type === '已完成' ? '完成' : (project.status || '在研')}</em>
                    </button>
                  );
                })}
              {sidebarProjects.length === 0 && <div className="app-project-list-empty">项目载入后会显示在这里</div>}
            </div>
          </section>
        )}

        {/* AI 情报中心（报价差异/自主建议/巡检发现 统一处理）——全局入口，任何页面可见 */}
        <div role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInsightsEntry(); } }} onClick={openInsightsEntry}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 12.5, color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', userSelect: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <BulbOutlined style={{ color: insightCount > 0 ? '#D97706' : 'var(--color-text-tertiary)' }} />
          <span>AI 情报</span>
          {insightCount > 0 && <Badge count={insightCount} size="small" style={{ marginLeft: 'auto' }} />}
        </div>


        {/* 底部：用户信息 + 设置（收纳主题/缩放/版本/使用说明） */}
        <div className="sidebar-footer" style={{
          display: 'flex', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--color-border)',
        }}>
          <Dropdown
            menu={{
              items: [
                { key: 'settings', label: (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                      <SettingOutlined /> 系统设置
                    </span>
                  ), onClick: () => setSettingsOpen(true) },
                { type: 'divider' },
                { key: 'guide', label: (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <BookOutlined /> 功能介绍 / 使用说明
                    </span>
                  ), onClick: () => { setGuideOpen(true); } },
                { type: 'divider' },
                { key: 'theme', label: (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 180 }}>
                      <span>主题</span><ThemeSwitcher />
                    </div>
                  ) },
                { type: 'divider' },
                { key: 'zoom', label: (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0' }}>
                      <span style={{ fontSize: 12, marginRight: 6 }}>缩放</span>
                      {ZOOM_LEVELS.map(level => (
                        <button
                          key={level}
                          onClick={() => setZoomLevel(level)}
                          style={{
                            border: zoom === level ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                            background: zoom === level ? 'var(--color-primary)' : 'transparent',
                            color: zoom === level ? '#FFF' : 'var(--color-text-secondary)',
                            borderRadius: 4, padding: '2px 6px', fontSize: 10, cursor: 'pointer',
                          }}
                        >{level}%</button>
                      ))}
                    </div>
                  ) },
                { type: 'divider' },
                { key: 'version', label: <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>CostHub v2.3.19</span> },
              ],
            }}
            placement="topRight"
            trigger={['click']}
          >
            <div
              data-testid="nav-settings-trigger"
              style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0,
                padding: '6px 8px', borderRadius: 8, transition: 'background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                background: 'var(--color-primary)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700,
              }}>
                {(currentUser || 'U').slice(0, 1).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{currentUser || '未登录'}</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>设置 · 使用说明</div>
              </div>
              <SettingOutlined style={{ color: 'var(--color-text-tertiary)', fontSize: 13, flexShrink: 0 }} />
            </div>
          </Dropdown>
        </div>
          <Tooltip title="收起侧边栏" placement="right">
            <div onClick={toggleSidebar} style={{ padding: '6px 16px', cursor: 'pointer', color: '#9A978B', fontSize: 13, borderTop: '1px solid var(--color-border)', textAlign: 'center' }}><MenuFoldOutlined /></div>
          </Tooltip>
          </div>
        )}
      </aside>
      <main className={`main-content${active === 'projects' ? ' main-content-projects' : ''}`} style={{ zoom: `${zoom}%` }}>
        {render()}
      </main>
      <AiPanel activePage={active} />

      <Modal
        title="全局搜索"
        open={globalSearchOpen}
        onCancel={() => setGlobalSearchOpen(false)}
        footer={null}
        destroyOnClose
        width={620}
      >
        <Input autoFocus allowClear prefix={<SearchOutlined />} value={globalSearchKeyword} onChange={event => setGlobalSearchKeyword(event.target.value)} placeholder="搜索项目、器件、竞品、报价批次、措施或分析成果" suffix={<kbd>Ctrl K</kbd>} />
        <div style={{ marginTop: 12, minHeight: 80 }}>
          {globalSearchLoading ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>搜索中…</div> : !globalSearchKeyword.trim() ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词开始本地搜索" /> : <List size="small" dataSource={globalSearchResults} locale={{ emptyText: '没有匹配结果' }} renderItem={(result: any) => <List.Item style={{ cursor: 'pointer' }} onClick={() => openGlobalSearchResult(result)}><List.Item.Meta title={<span><Tag style={{ marginRight: 8 }}>{result.type === 'project' ? '项目' : result.type === 'part' ? '器件' : result.type === 'competitor' ? '竞品' : result.type === 'quote' ? '报价批次' : result.type === 'measure' ? '措施' : '分析成果'}</Tag>{result.title}</span>} description={result.meta} /></List.Item>} />}
        </div>
      </Modal>

      {/* 系统设置弹窗 */}
      <Modal
        title={<span><SettingOutlined style={{ marginRight: 8 }} />系统设置</span>}
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
        width={1100}
        destroyOnClose
        styles={{ body: { padding: '16px 8px', maxHeight: '78vh', overflowY: 'auto' } }}
      >
        <Settings embedded />
      </Modal>


      {/* 首次 AI 能力引导 */}
      <AIUsageGuide open={aiGuideOpen} onClose={() => setAiGuideOpen(false)} onOpenSettings={() => setSettingsOpen(true)} />

      {/* 使用说明弹窗（HTML 页面） */}
      <Modal
        title={<span><BookOutlined style={{ marginRight: 8 }} />功能介绍 / 使用说明</span>}
        open={guideOpen}
        onCancel={() => setGuideOpen(false)}
        footer={null}
        width={900}
        destroyOnClose
        styles={{ body: { padding: 0, height: '76vh' } }}
      >
        <iframe
          src="guide.html"
          style={{ width: '100%', height: '100%', border: 'none', borderRadius: '0 0 8px 8px' }}
          title="CostHub 使用说明"
        />
      </Modal>
        </>
      )}
    </ThemeProvider>
  );
}
