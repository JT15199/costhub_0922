import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { message } from 'antd';
import Dashboard from './pages/Dashboard';
import PartsLibrary from './pages/PartsLibrary';
import ModuleLibrary from './pages/ModuleLibrary';
import Projects from './pages/Projects';
import Competitors from './pages/Competitors';
import Compare from './pages/Compare';
import Reports from './pages/Reports';
import Decomposition from './pages/Decomposition';
import SupplierManagement from './pages/SupplierManagement';
import Settings from './pages/Settings';
import { ThemeProvider } from './theme/ThemeContext';
import { ThemeSwitcher } from './theme/ThemeSwitcher';
import {
  BarChartOutlined, ToolOutlined, AppstoreOutlined, ProjectOutlined,
  ShopOutlined, LineChartOutlined, FileTextOutlined, PartitionOutlined,
  TeamOutlined, SettingOutlined
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
  { key: 'settings',           label: '系统设置',   icon: <SettingOutlined />,   iconBg: '#F8FAFC', iconColor: '#64748B' },
];

const ZOOM_LEVELS = [80, 100, 125, 150];

export default function App() {
  const [active, setActive] = useState(() => localStorage.getItem('app-active') || 'dashboard');
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([localStorage.getItem('app-active') || 'dashboard']));
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('app-zoom');
    return saved ? parseInt(saved) : 100;
  });
  const [customLogo] = useState(() => localStorage.getItem('costhub_custom_logo') || '');

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
    setActive(key);
    localStorage.setItem('app-active', key);
    setMounted(prev => { const next = new Set(prev); next.add(key); return next; });
  }, []);

  const setZoomLevel = (level: number) => {
    setZoom(level);
    localStorage.setItem('app-zoom', String(level));
  };

  const render = () => {
    const pageMap: Record<string, ReactNode> = {
      dashboard: <Dashboard onNavigate={navigate} />,
      parts: <PartsLibrary />,
      modules: <ModuleLibrary />,
      projects: <Projects />,
      competitors: <Competitors />,
      compare: <Compare />,
      reports: <Reports />,
      decomposition: <Decomposition />,
      supplierManagement: <SupplierManagement />,
      settings: <Settings />,
    };
    return (
      <>
        {Array.from(mounted).map(key => (
          <div key={key} style={{ display: active === key ? 'block' : 'none', height: '100%' }}>
            {pageMap[key]}
          </div>
        ))}
      </>
    );
  };

  return (
    <ThemeProvider>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-img">
            {customLogo
              ? <img src={customLogo} alt="CostHub Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : 'CH'}
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

        {/* 主题切换器 */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--color-border)' }}>
          <ThemeSwitcher />
        </div>

        {/* 缩放控制 */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: 'var(--color-text-secondary)', fontSize: 10, marginRight: 4 }}>缩放</span>
            {ZOOM_LEVELS.map(level => (
              <button
                key={level}
                onClick={() => setZoomLevel(level)}
                style={{
                  border: zoom === level ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                  background: zoom === level ? 'var(--color-primary)' : 'transparent',
                  color: zoom === level ? '#FFF' : 'var(--color-text-secondary)',
                  borderRadius: 4, padding: '2px 6px', fontSize: 10, cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {level}%
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-ver" style={{ borderTop: 'none', paddingTop: 0 }}>v2.3.17</div>
      </aside>
      <main className="main-content" style={{ zoom: `${zoom}%` }}>
        {render()}
      </main>
    </ThemeProvider>
  );
}
