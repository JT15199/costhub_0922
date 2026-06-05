import { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard';
import PartsLibrary from './pages/PartsLibrary';
import ModuleLibrary from './pages/ModuleLibrary';
import Projects from './pages/Projects';
import Competitors from './pages/Competitors';
import CostControl from './pages/CostControl';
import Compare from './pages/Compare';
import Reports from './pages/Reports';

const NAV = [
  { key: 'dashboard', label: '仪表盘', icon: '📊' },
  { key: 'parts', label: '器件库', icon: '🔧' },
  { key: 'modules', label: '模块库', icon: '📦' },
  { key: 'projects', label: '项目管理', icon: '📋' },
  { key: 'competitors', label: '竞品管理', icon: '🏭' },
  { key: 'cost', label: '成本管控', icon: '💰' },
  { key: 'compare', label: '对比分析', icon: '📈' },
  { key: 'reports', label: '成本报告', icon: '📄' },
];

const ZOOM_LEVELS = [80, 100, 125, 150];

export default function App() {
  const [active, setActive] = useState('dashboard');
  const [pageKey, setPageKey] = useState(0);
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('app-zoom');
    return saved ? parseInt(saved) : 100;
  });

  useEffect(() => { setPageKey(p => p + 1); }, [active]);

  const setZoomLevel = (level: number) => {
    setZoom(level);
    localStorage.setItem('app-zoom', String(level));
  };

  const render = () => {
    const p = { key: pageKey };
    switch (active) {
      case 'dashboard': return <Dashboard {...p} />;
      case 'parts': return <PartsLibrary {...p} />;
      case 'modules': return <ModuleLibrary {...p} />;
      case 'projects': return <Projects {...p} />;
      case 'competitors': return <Competitors {...p} />;
      case 'cost': return <CostControl {...p} />;
      case 'compare': return <Compare {...p} />;
      case 'reports': return <Reports {...p} />;
      default: return <Dashboard {...p} />;
    }
  };

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-logo"><h1>显示器成本管理</h1><span>Monitor Cost Manager</span></div>
        <nav className="sidebar-nav">
          {NAV.map(item => (
            <div key={item.key} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => setActive(item.key)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
            </div>
          ))}
        </nav>
        <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, marginRight: 4 }}>缩放</span>
            {ZOOM_LEVELS.map(level => (
              <button
                key={level}
                onClick={() => setZoomLevel(level)}
                style={{
                  border: zoom === level ? '1px solid rgba(207,10,44,0.6)' : '1px solid rgba(255,255,255,0.1)',
                  background: zoom === level ? 'rgba(207,10,44,0.25)' : 'transparent',
                  color: zoom === level ? '#FFF' : 'rgba(255,255,255,0.45)',
                  borderRadius: 4, padding: '2px 6px', fontSize: 10, cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {level}%
              </button>
            ))}
          </div>
        </div>
        <div className="sidebar-ver" style={{ borderTop: 'none', paddingTop: 0 }}>v2.0</div>
      </aside>
      <main className="main-content" style={{ zoom: `${zoom}%` }}>
        <div className="fade-in-up">{render()}</div>
      </main>
    </>
  );
}
