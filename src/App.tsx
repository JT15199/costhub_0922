import { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard';
import PartsLibrary from './pages/PartsLibrary';
import ModuleLibrary from './pages/ModuleLibrary';
import Projects from './pages/Projects';
import Competitors from './pages/Competitors';
import Compare from './pages/Compare';
import Reports from './pages/Reports';
import Decomposition from './pages/Decomposition';
import TrendInsight from './pages/TrendInsight';
import SupplierManagement from './pages/SupplierManagement';
import Settings from './pages/Settings';
import { PALETTES, COLOR_TEMPS } from './constants';

const NAV = [
  { key: 'dashboard', label: '仪表盘', icon: '📊' },
  { key: 'parts', label: '器件库', icon: '🔧' },
  { key: 'modules', label: '模块库', icon: '📦' },
  { key: 'projects', label: '项目管理', icon: '📋' },
  { key: 'competitors', label: '竞品管理', icon: '🏭' },
  { key: 'compare', label: '对比分析', icon: '📈' },
  { key: 'reports', label: '成本报告', icon: '📄' },
  { key: 'decomposition', label: '物料分解', icon: '🌳' },
  { key: 'trendInsight', label: '趋势洞察', icon: '📡' },
  { key: 'supplierManagement', label: '供应商管理', icon: '🏢' },
  { key: 'settings', label: '系统设置', icon: '⚙️' },
];

const ZOOM_LEVELS = [80, 100, 125, 150];

export default function App() {
  const [active, setActive] = useState('dashboard');
  const [pageKey, setPageKey] = useState(0);
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('app-zoom');
    return saved ? parseInt(saved) : 100;
  });
  const [palette, setPalette] = useState(() => localStorage.getItem('app-palette') || 'paper');
  const [colorTemp, setColorTemp] = useState(() => localStorage.getItem('app-color-temp') || 'default');

  useEffect(() => { setPageKey(p => p + 1); }, [active]);

  useEffect(() => {
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-color-temp', colorTemp);
  }, [palette, colorTemp]);

  const setZoomLevel = (level: number) => {
    setZoom(level);
    localStorage.setItem('app-zoom', String(level));
  };

  const setPaletteTheme = (id: string) => {
    setPalette(id);
    localStorage.setItem('app-palette', id);
  };

  const setColorTemperature = (temp: string) => {
    setColorTemp(temp);
    localStorage.setItem('app-color-temp', temp);
  };

  const render = () => {
    const p = { key: pageKey };
    switch (active) {
      case 'dashboard': return <Dashboard {...p} />;
      case 'parts': return <PartsLibrary {...p} />;
      case 'modules': return <ModuleLibrary {...p} />;
      case 'projects': return <Projects {...p} />;
      case 'competitors': return <Competitors {...p} />;
      case 'compare': return <Compare {...p} />;
      case 'reports': return <Reports {...p} />;
      case 'decomposition': return <Decomposition {...p} />;
      case 'trendInsight': return <TrendInsight {...p} />;
      case 'supplierManagement': return <SupplierManagement {...p} />;
      case 'settings': return <Settings {...p} />;
      default: return <Dashboard {...p} />;
    }
  };

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-img">CH</div>
          <div><h1>CostHub</h1><span>成本管理平台</span></div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(item => (
            <div key={item.key} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => setActive(item.key)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
            </div>
          ))}
        </nav>

        {/* 主题调色板 */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 10, marginRight: 2 }}>THEME</span>
            {PALETTES.map(p => (
              <div
                key={p.id}
                title={p.name}
                onClick={() => setPaletteTheme(p.id)}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  border: palette === p.id ? '2px solid var(--brand)' : '2px solid var(--border)',
                  background: `var(--palette-${p.id})`,
                  transition: 'all 0.2s',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        </div>

        {/* 缩放控制 */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 10, marginRight: 4 }}>缩放</span>
            {ZOOM_LEVELS.map(level => (
              <button
                key={level}
                onClick={() => setZoomLevel(level)}
                style={{
                  border: zoom === level ? '1px solid var(--brand)' : '1px solid var(--border)',
                  background: zoom === level ? 'var(--brand)' : 'transparent',
                  color: zoom === level ? '#FFF' : 'var(--text-secondary)',
                  borderRadius: 4, padding: '2px 6px', fontSize: 10, cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {level}%
              </button>
            ))}
          </div>
        </div>

        {/* 色温控制 */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 10, marginRight: 2 }}>色温</span>
            {COLOR_TEMPS.map(temp => (
              <div
                key={temp.id}
                title={temp.name}
                onClick={() => setColorTemperature(temp.id)}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  border: colorTemp === temp.id ? '2px solid var(--brand)' : '2px solid var(--border)',
                  background: `var(--temp-${temp.id})`,
                  transition: 'all 0.2s',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        </div>

        <div className="sidebar-ver" style={{ borderTop: 'none', paddingTop: 0 }}>v2.3.14</div>
      </aside>
      <main className="main-content" style={{ zoom: `${zoom}%` }}>
        <div className="fade-in-up">{render()}</div>
      </main>
    </>
  );
}
