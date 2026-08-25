import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { message, Dropdown, Modal, Badge } from 'antd';
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
const LocalAIAssistant = lazy(() => import('./pages/LocalAIAssistant'));
const UserVoice = lazy(() => import('./pages/UserVoice'));
const QuoteReview = lazy(() => import('./pages/QuoteReview'));
const WorkLog = lazy(() => import('./pages/WorkLog'));
const LoginScreen = lazy(() => import('./pages/LoginScreen'));
import { ThemeProvider } from './theme/ThemeContext';
import { ThemeSwitcher } from './theme/ThemeSwitcher';
import CloudConfirmBar from './components/CloudConfirmBar';
import AIUsageGuide from './components/AIUsageGuide';
import ErrorBoundary from './components/ErrorBoundary';
import {
  BarChartOutlined, ToolOutlined, AppstoreOutlined, ProjectOutlined,
  ShopOutlined, LineChartOutlined, FileTextOutlined, PartitionOutlined, CalendarOutlined,
  TeamOutlined, SettingOutlined, RobotOutlined, BookOutlined, BulbOutlined, LockOutlined, MessageOutlined, AuditOutlined
} from '@ant-design/icons';

// 导航分区（v2.3.19 界面轻量化第一步：12 项平铺 → 驾驶舱 + 三区收敛，页面零改动）
const NAV: { key: string; label: string; icon: any; iconBg: string; iconColor: string }[] = [
  { key: 'dashboard',          label: '驾驶舱',     icon: <BarChartOutlined />,  iconBg: '#EFF6FF', iconColor: '#3B82F6' },
];
const NAV_GROUPS: { title: string; items: typeof NAV }[] = [
  {
    title: '项目中心',
    items: [
      { key: 'projects',           label: '项目管理',   icon: <ProjectOutlined />,   iconBg: '#F0FDF4', iconColor: '#16A34A' },
      { key: 'competitors',        label: '竞品管理',   icon: <ShopOutlined />,      iconBg: '#FFF1F2', iconColor: '#F43F5E' },
      { key: 'compare',            label: '对比分析',   icon: <LineChartOutlined />, iconBg: '#ECFEFF', iconColor: '#0891B2' },
      { key: 'reports',            label: '成本报告',   icon: <FileTextOutlined />,  iconBg: '#FFFBEB', iconColor: '#D97706' },
      { key: 'workLog',            label: '工作手账',   icon: <CalendarOutlined />,  iconBg: '#F0FDF4', iconColor: '#059669' },
    ],
  },
  {
    title: '数据资产',
    items: [
      { key: 'parts',              label: '器件库',     icon: <ToolOutlined />,      iconBg: '#FFF7ED', iconColor: '#F97316' },
      { key: 'modules',            label: '模块库',     icon: <AppstoreOutlined />,  iconBg: '#F5F3FF', iconColor: '#8B5CF6' },
      { key: 'supplierManagement', label: '供应商管理', icon: <TeamOutlined />,      iconBg: '#F0FDFA', iconColor: '#0D9488' },
    ],
  },
  {
    title: 'AI 趋势',
    items: [
      { key: 'decomposition',      label: '物料趋势洞察', icon: <PartitionOutlined />, iconBg: '#EEF2FF', iconColor: '#6366F1' },
      { key: 'localAI',            label: '本地AI助手', icon: <RobotOutlined />,     iconBg: '#EEF2FF', iconColor: '#6366F1' },
      { key: 'userVoice',          label: '用户原声分析', icon: <MessageOutlined />, iconBg: '#FAF5FF', iconColor: '#8B5CF6' },
      { key: 'quoteReview',        label: 'AI 审价助手', icon: <AuditOutlined />,     iconBg: '#FFF7ED', iconColor: '#F97316' },
    ],
  },
];

const ZOOM_LEVELS = [80, 100, 125, 150];

export default function App() {
  const [active, setActive] = useState(() => localStorage.getItem('app-active') || 'dashboard');
  // 登录门禁：null=未登录(显示登录页) false=受限模式(不显示数据) true=已解锁
  const [authed, setAuthed] = useState<boolean | null>(null);
  // 已挂载的页面集合：初始包含当前页，切走的页面保持挂载，切回时不重新加载
  const [mountedPages, setMountedPages] = useState<Set<string>>(() => new Set([localStorage.getItem('app-active') || 'dashboard']));
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
  // 当前登录用户名（侧边栏底部显示）
  const [currentUser, setCurrentUser] = useState('');

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
  // ====== 自主分析（AI 助理后台建议）：60 秒轮询，规则+AI 润色，指纹去重 ======
  const advisorRunningRef = useRef(false);
  const scheduleAppAdvisor = useCallback(() => {
    if (advisorRunningRef.current) return;
    advisorRunningRef.current = true;
    (async () => {
      try {
        const r = await runAutoAdvisor(msg => window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: msg } })));
        // ⚠️ 只有真实产出才广播"完成"（2026-08-17 修复：规则无新发现时不再每 60 秒闪现"刚刚完成 自主巡检"）
        if (r && (r.found > 0 || r.aiEnhanced > 0)) {
          window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: '自主巡检', done: true } }));
        }
        // 只在新建议出现时提醒（日常轮询静默）
        if (r && r.found > 0) {
          message.success(`AI 助理发现 ${r.found} 条成本机会/风险点（见「本地 AI → 自主建议」）`);
        }
      } catch (e) { console.warn('自主分析失败:', e); }
      advisorRunningRef.current = false;
    })();
  }, []);
  useEffect(() => {
    // 自主分析轮询：每 60 秒探查一轮（规则层纯计算很快；AI 润色内置 30 分钟节流；指纹去重不重复提醒）
    const iv = setInterval(() => scheduleAppAdvisor(), 60 * 1000);
    scheduleAppAdvisor(); // 打开应用立即探查一轮
    return () => clearInterval(iv);
  }, [scheduleAppAdvisor]);
  // ====== 关键物料自动洞察：60 秒轮询，闸门节流（30 天周期 + 7 天复用 + 每日预算），启动立即一轮 ======
  const insightRunningRef = useRef(false);
  const scheduleAppInsight = useCallback(() => {
    if (insightRunningRef.current) return;
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
      const { setDataLocked, syncProjectModulesToLibrary, syncPartsProjectsField } = await import('./db');
      setDataLocked(false);
      setAuthed(true);
      // 从 project_boms 同步缺失模块到模块库（历史数据/定型项目补齐）
      try { await syncProjectModulesToLibrary(); } catch (e) { console.warn('模块库同步失败:', e); }
      // 修复 parts.projects 字段（历史数据未更新项目关联）
      try { await syncPartsProjectsField(); } catch (e) { console.warn('projects 字段修复失败:', e); }
      // 首次使用 AI 能力引导（只看一次）
      if (!localStorage.getItem('costhub-ai-guide-seen')) {
        localStorage.setItem('costhub-ai-guide-seen', '1');
        setAiGuideOpen(true);
      }
    })();
  };

  // AI 使用指南：任何页面可 dispatch costhub-open-ai-guide 打开（本地AI助手页/设置页按钮）
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
    // 保持目标页面挂载（本地AI助手切走不卸载，切回不重连）
    setMountedPages(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    setActive(key);
    localStorage.setItem('app-active', key);
    // 通知目标页面刷新（模块库等页面在其它页面改动数据后需要重新加载）
    window.dispatchEvent(new CustomEvent('app-page-active', { detail: { page: key } }));
  }, []);

  // 侧边栏「报价情报」入口：任何页面可点 → 跳项目管理页并打开情报弹窗
  // ⚠️ 2026-08-17 修复：原来直接 setActive('projects') 不走 navigate → mountedPages 没有 projects 时白屏；
  // 且事件在 Projects 组件挂载前发出 → 没反应。现在 navigate 挂载页面 + localStorage 标志兜底（组件挂载后消费）+ 延迟事件双保险
  const openInsightsEntry = useCallback(() => {
    localStorage.setItem('costhub-open-insights-pending', '1');
    navigate('projects');
    setTimeout(() => window.dispatchEvent(new CustomEvent('costhub-open-insights')), 300);
  }, [navigate]);

  // 数据就绪度引导：dispatch costhub-open-ai-prompt → 切到本地 AI 助手并预填提问（数据就绪度卡片「让 AI 引导我」）
  // ⚠️ 与 openInsightsEntry 同理：LocalAIAssistant 是懒加载，先 navigate 挂载 + 延迟重发事件双保险；提问内容在 localStorage（costhub-ai-prompt-pending）由助手消费
  useEffect(() => {
    const h = () => {
      navigate('localAI');
      setTimeout(() => window.dispatchEvent(new CustomEvent('costhub-open-ai-prompt')), 300);
    };
    window.addEventListener('costhub-open-ai-prompt', h);
    return () => window.removeEventListener('costhub-open-ai-prompt', h);
  }, [navigate]);

  const setZoomLevel = (level: number) => {
    setZoom(level);
    localStorage.setItem('app-zoom', String(level));
  };

  const renderPage = (key: string) => {
    switch (key) {
      case 'dashboard': return <Dashboard onNavigate={navigate} />;
      case 'parts': return <PartsLibrary />;
      case 'modules': return <ModuleLibrary />;
      case 'projects': return <Projects />;
      case 'competitors': return <Competitors />;
      case 'compare': return <Compare />;
      case 'reports': return <Reports />;
      case 'decomposition': return <Decomposition />;
      case 'supplierManagement': return <SupplierManagement />;
      case 'localAI': return <LocalAIAssistant />;
      case 'userVoice': return <UserVoice />;
      case 'quoteReview': return <QuoteReview />;
      case 'workLog': return <WorkLog />;
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
      {/* 云端洞察待确认横幅（非打断式，底部固定，任何页面可见） */}
      <CloudConfirmBar />
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-img">
            {customLogo
              ? <img src={customLogo} alt="CostHub Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : <img src={defaultLogo} alt="CostHub Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
          </div>
          <div><h1>CostHub</h1><span>成本管理平台</span></div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(item => (
            <div key={item.key} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => navigate(item.key)}>
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
          {NAV_GROUPS.map(group => (
            <div key={group.title}>
              <div style={{ padding: '10px 16px 4px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>{group.title}</div>
              {group.items.map(item => (
                <div key={item.key} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => navigate(item.key)}>
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
            </div>
          ))}
</nav>

        {/* AI 情报中心（报价差异/自主建议/巡检发现 统一处理）——全局入口，任何页面可见 */}
        <div onClick={openInsightsEntry}
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
      </aside>
      <main className="main-content" style={{ zoom: `${zoom}%` }}>
        {render()}
      </main>

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
