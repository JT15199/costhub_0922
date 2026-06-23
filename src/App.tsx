import { useState, useEffect } from 'react';
import { Modal, Input, Spin, Tooltip } from 'antd';
import Dashboard from './pages/Dashboard';
import PartsLibrary from './pages/PartsLibrary';
import ModuleLibrary from './pages/ModuleLibrary';
import Projects from './pages/Projects';
import Competitors from './pages/Competitors';
import Compare from './pages/Compare';
import Reports from './pages/Reports';
import { getParts, getProjects, getCompetitors, ensureSchema } from './db';
import { getCategoryColor, PALETTES, type PaletteId } from './constants';

const NAV = [
  { key: 'dashboard', label: '仪表盘', icon: '📊' },
  { key: 'parts', label: '器件库', icon: '🔧' },
  { key: 'modules', label: '模块库', icon: '📦' },
  { key: 'projects', label: '项目管理', icon: '📋' },
  { key: 'competitors', label: '竞品管理', icon: '🏭' },
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
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('app-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [palette, setPalette] = useState<PaletteId>(() => {
    const saved = localStorage.getItem('app-palette');
    return (PALETTES.find(p => p.id === saved)?.id) ?? 'apple';
  });
  const [motion, setMotion] = useState<'on' | 'off'>(() => {
    const saved = localStorage.getItem('app-motion');
    return saved === 'off' ? 'off' : 'on';
  });
  const [colorTemp, setColorTemp] = useState<'default' | 'warm' | 'cool' | 'sepia'>(() => {
    const saved = localStorage.getItem('app-color-temp');
    return (['default', 'warm', 'cool', 'sepia'].includes(saved as any) ? saved : 'default') as 'default' | 'warm' | 'cool' | 'sepia';
  });
  const [recentOpen, setRecentOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem('app-recent-open');
    return saved === null ? true : saved === '1';
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    parts: any[];
    projects: any[];
    competitors: any[];
  }>({ parts: [], projects: [], competitors: [] });
  const [searchLoading, setSearchLoading] = useState(false);

  const [recentParts, setRecentParts] = useState<any[]>([]);
  const [highlightId, setHighlightId] = useState<{ type: string; id: number } | null>(null);

  // 清除高亮状态
  const clearHighlight = () => {
    setHighlightId(null);
  };

  // 切换页面时清除高亮
  useEffect(() => {
    if (highlightId) {
      clearHighlight();
    }
  }, [active]);

  // 加载最近更新器件
  // 启动时自动补齐缺失的数据库列/表，不依赖迁移历史
  useEffect(() => { ensureSchema().catch(() => {}); }, []);

  useEffect(() => {
    (async () => {
      try {
        const parts = await getParts('', '', '');
        // 按更新时间排序，取最近5个
        const sorted = parts.sort((a: any, b: any) => {
          const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          return tb - ta;
        }).slice(0, 5);
        setRecentParts(sorted);
      } catch (e) { console.error(e); }
    })();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('app-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-palette', palette);
    localStorage.setItem('app-palette', palette);
  }, [palette]);

  useEffect(() => {
    document.documentElement.setAttribute('data-motion', motion);
    localStorage.setItem('app-motion', motion);
  }, [motion]);

  useEffect(() => {
    document.documentElement.setAttribute('data-color-temp', colorTemp);
    localStorage.setItem('app-color-temp', colorTemp);
  }, [colorTemp]);

  useEffect(() => {
    localStorage.setItem('app-recent-open', recentOpen ? '1' : '0');
  }, [recentOpen]);

  useEffect(() => { setPageKey(p => p + 1); }, [active]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen]);

  const handleSearch = async (query: string) => {
    if (!query.trim()) {
      setSearchResults({ parts: [], projects: [], competitors: [] });
      return;
    }
    setSearchLoading(true);
    try {
      const parts = await getParts(query, '', '');
      const projects = await getProjects('', '');
      const competitors = await getCompetitors();
      setSearchResults({
        parts: parts.filter(p => p.name?.includes(query) || p.model?.includes(query)).slice(0, 5),
        projects: projects.filter(p => p.name?.includes(query) || p.code?.includes(query)).slice(0, 5),
        competitors: competitors.filter(c => c.brand?.includes(query) || c.model?.includes(query)).slice(0, 5),
      });
    } catch (e) {
      console.error(e);
    }
    setSearchLoading(false);
  };

  useEffect(() => {
    if (searchOpen && searchQuery) {
      handleSearch(searchQuery);
    }
  }, [searchQuery, searchOpen]);

  const setZoomLevel = (level: number) => {
    setZoom(level);
    localStorage.setItem('app-zoom', String(level));
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  const navigateToResult = (type: string, key: string, id?: number) => {
    setActive(key);
    if (id) {
      setHighlightId({ type, id });
    }
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults({ parts: [], projects: [], competitors: [] });
  };

  const render = () => {
    const p = { key: pageKey, highlightId, clearHighlight };
    switch (active) {
      case 'dashboard': return <Dashboard {...p} />;
      case 'parts': return <PartsLibrary {...p} />;
      case 'modules': return <ModuleLibrary {...p} />;
      case 'projects': return <Projects {...p} />;
      case 'competitors': return <Competitors {...p} />;
      case 'compare': return <Compare {...p} />;
      case 'reports': return <Reports {...p} />;
      default: return <Dashboard {...p} />;
    }
  };

  const totalResults = searchResults.parts.length + searchResults.projects.length + searchResults.competitors.length;

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-img">MC</div>
          <div><h1>显示器成本管理</h1><span>Monitor Cost Manager</span></div>
        </div>

        {/* 全局搜索框 */}
        <div className="global-search-box">
          <input
            className="global-search-input"
            placeholder="🔍 搜索器件、项目、竞品..."
            onClick={() => setSearchOpen(true)}
            readOnly
          />
        </div>

        <nav className="sidebar-nav">
          {NAV.map(item => (
            <div key={item.key} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => setActive(item.key)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
            </div>
          ))}
        </nav>

        {/* 最近更新器件 - 侧边栏底部，可折叠 */}
        <div className={`sidebar-recent${recentOpen ? '' : ' collapsed'}`}>
          <div
            className="sidebar-recent-title"
            onClick={() => setRecentOpen(o => !o)}
            role="button"
            aria-expanded={recentOpen}
          >
            <span className="sidebar-recent-title-text"><span className="emoji">🕐</span> 最近更新</span>
            <span className="sidebar-recent-toggle" title={recentOpen ? '折叠' : '展开'}>
              {recentOpen ? '▾' : '▸'}
            </span>
          </div>
          {recentOpen && (recentParts.length === 0 ? (
            <div style={{ padding: 8, color: 'var(--text-muted)', fontSize: 12 }}>暂无数据</div>
          ) : (
            recentParts.map((p: any) => (
              <Tooltip key={p.id} title={`${p.name} - ${p.model || ''} | ¥${p.cost?.toFixed(2) || '0'}`}>
                <div className="sidebar-recent-item" onClick={() => setActive('parts')}>
                  <span className="sidebar-recent-cat" style={{ background: getCategoryColor(p.main_category) }}>{p.main_category?.slice(0,2) || '其他'}</span>
                  <span className="sidebar-recent-name">{p.name}</span>
                </div>
              </Tooltip>
            ))
          ))}
        </div>

        <div className="sidebar-footer">
          {/* 主题色板 + 深浅切换 - 同一行，色卡 + 月亮/太阳 */}
          <div className="sidebar-palette-row">
            <span className="sidebar-palette-label">Theme</span>
            {PALETTES.map(p => (
              <Tooltip key={p.id} title={p.name}>
                <button
                  className={`palette-swatch${palette === p.id ? ' active' : ''}`}
                  style={{ background: p.swatch }}
                  onClick={() => setPalette(p.id)}
                  aria-label={`切换 ${p.name} 主题`}
                />
              </Tooltip>
            ))}
            <Tooltip title={theme === 'light' ? '切换深色' : '切换浅色'}>
              <button
                className={`palette-swatch theme-toggle-swatch${theme === 'dark' ? ' active-dark' : ''}`}
                onClick={toggleTheme}
                aria-label="切换深浅"
              >
                {theme === 'light' ? '🌙' : '☀️'}
              </button>
            </Tooltip>
          </div>

          {/* 缩放 - 另一行，独立一排 */}
          <div className="sidebar-zoom-row">
            <span className="sidebar-zoom-label">缩放</span>
            <div className="sidebar-zoom-group">
              {ZOOM_LEVELS.map(level => (
                <button
                  key={level}
                  onClick={() => setZoomLevel(level)}
                  className={zoom === level ? 'zoom-btn active' : 'zoom-btn'}
                >
                  {level}%
                </button>
              ))}
            </div>
          </div>

          {/* 色温 - 独立一行 */}
          <div className="sidebar-temp-row">
            <span className="sidebar-temp-label">色温</span>
            {([
              { id: 'default', label: '默认', color: 'linear-gradient(135deg, #E2E8F0 0%, #94A3B8 100%)' },
              { id: 'warm',    label: '暖光', color: 'linear-gradient(135deg, #FCD9A8 0%, #F59E0B 100%)' },
              { id: 'cool',    label: '冷调', color: 'linear-gradient(135deg, #BAE6FD 0%, #0EA5E9 100%)' },
              { id: 'sepia',   label: '护眼', color: 'linear-gradient(135deg, #F5E0B3 0%, #B88A4A 100%)' },
            ] as const).map(t => (
              <Tooltip key={t.id} title={t.label}>
                <button
                  className={`palette-swatch${colorTemp === t.id ? ' active' : ''}`}
                  style={{ background: t.color }}
                  onClick={() => setColorTemp(t.id)}
                  aria-label={`色温 ${t.label}`}
                />
              </Tooltip>
            ))}
            <Tooltip title={motion === 'on' ? '关闭动效（性能模式）' : '开启动效'}>
              <button
                className={`palette-swatch motion-toggle-swatch${motion === 'off' ? ' active-dark' : ''}`}
                onClick={() => setMotion(m => m === 'on' ? 'off' : 'on')}
                aria-label="切换动效"
              >
                {motion === 'on' ? '✨' : '💤'}
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="sidebar-ver" style={{ borderTop: 'none', paddingTop: 0 }}>v2.2</div>
      </aside>
      <main className="main-content" style={{ zoom: `${zoom}%` }}>
        <div className="fade-in-up">{render()}</div>
      </main>

      {/* 全局搜索弹窗 */}
      <Modal
        open={searchOpen}
        onCancel={() => { setSearchOpen(false); setSearchQuery(''); }}
        footer={null}
        width={520}
        className="global-search-modal"
        styles={{ body: { padding: 0 } }}
      >
        <div style={{ padding: '12px 16px' }}>
          <Input
            placeholder="🔍 搜索器件、项目、竞品..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            autoFocus
            size="large"
            style={{ borderRadius: 12 }}
          />
        </div>
        {searchLoading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
        {!searchLoading && searchQuery && totalResults === 0 && (
          <div className="search-empty">未找到匹配结果</div>
        )}
        {!searchLoading && searchResults.parts.length > 0 && (
          <div className="search-result-section">
            <div className="search-result-title">🔧 器件 ({searchResults.parts.length})</div>
            {searchResults.parts.map(p => (
              <div key={p.id} className="search-result-item" onClick={() => navigateToResult('part', 'parts', p.id)}>
                <div className="search-result-item-icon" style={{ background: '#3B82F6', color: '#FFF' }}>🔧</div>
                <div className="search-result-item-text">
                  <div className="search-result-item-name">{p.name}</div>
                  <div className="search-result-item-meta">{p.model} · ¥{p.cost?.toFixed(2)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!searchLoading && searchResults.projects.length > 0 && (
          <div className="search-result-section">
            <div className="search-result-title">📋 项目 ({searchResults.projects.length})</div>
            {searchResults.projects.map(p => (
              <div key={p.id} className="search-result-item" onClick={() => navigateToResult('project', 'projects', p.id)}>
                <div className="search-result-item-icon" style={{ background: '#34C759', color: '#FFF' }}>📋</div>
                <div className="search-result-item-text">
                  <div className="search-result-item-name">{p.code} - {p.name}</div>
                  <div className="search-result-item-meta">{p.status} · {p.tier}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!searchLoading && searchResults.competitors.length > 0 && (
          <div className="search-result-section">
            <div className="search-result-title">🏭 竞品 ({searchResults.competitors.length})</div>
            {searchResults.competitors.map(c => (
              <div key={c.id} className="search-result-item" onClick={() => navigateToResult('competitor', 'competitors', c.id)}>
                <div className="search-result-item-icon" style={{ background: '#8B5CF6', color: '#FFF' }}>🏭</div>
                <div className="search-result-item-text">
                  <div className="search-result-item-name">{c.brand} {c.model}</div>
                  <div className="search-result-item-meta">{c.tier} · ¥{c.market_price?.toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!searchQuery && (
          <div style={{ padding: '16px', textAlign: 'center', color: '#64748B', fontSize: 13 }}>
            输入关键词搜索，支持器件名称/型号、项目代号/名称、竞品品牌/型号
          </div>
        )}
      </Modal>
    </>
  );
}
