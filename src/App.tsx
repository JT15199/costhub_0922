import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { message, Dropdown, Modal, Badge } from 'antd';
import { runAutoCompare } from './autoCompare';
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
const WorkLog = lazy(() => import('./pages/WorkLog'));
const LoginScreen = lazy(() => import('./pages/LoginScreen'));
import { ThemeProvider } from './theme/ThemeContext';
import { ThemeSwitcher } from './theme/ThemeSwitcher';
import GlobalAI from './components/GlobalAI';
import {
  BarChartOutlined, ToolOutlined, AppstoreOutlined, ProjectOutlined,
  ShopOutlined, LineChartOutlined, FileTextOutlined, PartitionOutlined, CalendarOutlined,
  TeamOutlined, SettingOutlined, RobotOutlined, BookOutlined, BulbOutlined
} from '@ant-design/icons';

const NAV = [
  { key: 'dashboard',          label: '仪表盘',     icon: <BarChartOutlined />,  iconBg: '#EFF6FF', iconColor: '#3B82F6' },
  { key: 'parts',              label: '器件库',     icon: <ToolOutlined />,      iconBg: '#FFF7ED', iconColor: '#F97316' },
  { key: 'modules',            label: '模块库',     icon: <AppstoreOutlined />,  iconBg: '#F5F3FF', iconColor: '#8B5CF6' },
  { key: 'projects',           label: '项目管理',   icon: <ProjectOutlined />,   iconBg: '#F0FDF4', iconColor: '#16A34A' },
  { key: 'competitors',        label: '竞品管理',   icon: <ShopOutlined />,      iconBg: '#FFF1F2', iconColor: '#F43F5E' },
  { key: 'compare',            label: '对比分析',   icon: <LineChartOutlined />, iconBg: '#ECFEFF', iconColor: '#0891B2' },
  { key: 'reports',            label: '成本报告',   icon: <FileTextOutlined />,  iconBg: '#FFFBEB', iconColor: '#D97706' },
  { key: 'decomposition',      label: '物料趋势洞察', icon: <PartitionOutlined />, iconBg: '#EEF2FF', iconColor: '#6366F1' },
  { key: 'supplierManagement', label: '供应商管理', icon: <TeamOutlined />,      iconBg: '#F0FDFA', iconColor: '#0D9488' },
  { key: 'localAI',            label: '本地AI助手', icon: <RobotOutlined />,     iconBg: '#EEF2FF', iconColor: '#6366F1' },
  { key: 'workLog',            label: '工作手账',   icon: <CalendarOutlined />,   iconBg: '#F0FDF4', iconColor: '#059669' },
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
  const [globalAiOpen, setGlobalAiOpen] = useState(false);
  // 使用说明弹窗
  const [guideOpen, setGuideOpen] = useState(false);
  const [customLogo] = useState(() => localStorage.getItem('costhub_custom_logo') || '');
  // 当前登录用户名（侧边栏底部显示）
  const [currentUser, setCurrentUser] = useState('');

  // ====== 报价比对：持续后台探查（只要 Ollama 空闲就扫；60 秒一轮，探查仔细不急；发现情报才提示） ======
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [insightCount, setInsightCount] = useState(0);
  const autoRunningRef = useRef(false);
  const refreshInsightCount = useCallback(async () => {
    try { setInsightCount((await getInsights()).filter(i => i.status === 'unread').length); } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { refreshInsightCount(); }, [refreshInsightCount]);
  const scheduleAppCompare = useCallback(() => {
    if (autoRunningRef.current) return;
    autoRunningRef.current = true;
    (async () => {
      const r = await runAutoCompare(p => setAutoProgress(p));
      setAutoProgress(null);
      autoRunningRef.current = false;
      window.dispatchEvent(new CustomEvent('costhub-compare-done'));
      refreshInsightCount();
      // 只在有情报或失败时提示，日常轮询静默不打扰
      if (r) {
        if (r.failed > 0) message.warning(`后台识别完成：${r.scanned} 个模块，${r.failed} 个识别失败（可打开模块「跨项目比对」手动重试）`);
        else if (r.scanned > 0 && r.insights > 0) message.success(`发现 ${r.insights} 条报价情报（见「报价情报」）`);
      }
    })();
  }, []);
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
    })();
  };

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
            {renderPage(key)}
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
      {autoProgress && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, background: '#EEF2FF', borderBottom: '1px solid #C7D2FE', padding: '3px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#334155' }}>
          <RobotOutlined className="ai-breathe" style={{ color: '#0A84FF' }} />
          <span>正在后台识别物料报价差异（{autoProgress.done}/{autoProgress.total}）· 当前：{autoProgress.current}…发现异常会通过「报价情报」提醒</span>
        </div>
      )}
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
        </nav>

        {/* 报价情报（后台自动识别的报价差异提醒）——全局入口，任何页面可见 */}
        <div onClick={() => { setActive('projects'); window.dispatchEvent(new CustomEvent('costhub-open-insights')); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 12.5, color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', userSelect: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <BulbOutlined style={{ color: insightCount > 0 ? '#D97706' : 'var(--color-text-tertiary)' }} />
          <span>报价情报</span>
          {insightCount > 0 && <Badge count={insightCount} size="small" style={{ marginLeft: 'auto' }} />}
        </div>

        {/* 全局 AI 问询（本地模型，读取当前上下文；回答可记入手账） */}
        <div onClick={() => setGlobalAiOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 12.5, color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', userSelect: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <RobotOutlined style={{ color: '#0A84FF' }} />
          <span>AI 问询</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary)' }}>本地模型</span>
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

      {/* 全局 AI 问询（上下文感知，本地模型） */}
      <GlobalAI open={globalAiOpen} onClose={() => setGlobalAiOpen(false)} />

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
