import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import { Tabs, Typography } from 'antd';
import { AppstoreOutlined } from '@ant-design/icons';

const PartsLibrary = lazy(() => import('./PartsLibrary'));
const ModuleLibrary = lazy(() => import('./ModuleLibrary'));
const SupplierManagement = lazy(() => import('./SupplierManagement'));
const Competitors = lazy(() => import('./Competitors'));

type LibraryTab = 'parts' | 'modules' | 'suppliers' | 'competitors';

const LIBRARY_FOLDERS: Array<{ key: LibraryTab; label: string; copy: string; tone: string }> = [
  { key: 'parts', label: '器件资料', copy: '标准器件与价格证据', tone: 'blue' },
  { key: 'modules', label: '模块资料', copy: '模块基准与器件组合', tone: 'teal' },
  { key: 'suppliers', label: '供应商资料', copy: '供应商档案与报价关系', tone: 'violet' },
  { key: 'competitors', label: '竞品资料', copy: '竞品 BOM 与规格对比', tone: 'amber' },
];

export function resolveLibraryTab(value: unknown): LibraryTab | undefined {
  if (value === 'parts' || value === 'modules' || value === 'suppliers' || value === 'competitors') return value;
  if (value === 'supplierManagement') return 'suppliers';
  return undefined;
}

export default function Library() {
  const [tab, setTab] = useState<LibraryTab>(() => {
    return resolveLibraryTab(localStorage.getItem('costhub-library-tab')) || 'parts';
  });

  useEffect(() => {
    localStorage.setItem('costhub-library-tab', tab);
    window.dispatchEvent(new CustomEvent('app-page-active', { detail: { page: tab } }));
  }, [tab]);

  useEffect(() => {
    const syncTab = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const next = resolveLibraryTab(detail.page) || resolveLibraryTab(localStorage.getItem('costhub-library-tab'));
      if (next) setTab(next);
    };
    window.addEventListener('app-page-active', syncTab);
    return () => window.removeEventListener('app-page-active', syncTab);
  }, []);

  const page = (element: ReactNode) => <Suspense fallback={<div className="hub-page-loading">正在加载资料库…</div>}>{element}</Suspense>;

  return (
    <div className="hub-page">
      <header className="hub-page-header">
        <div>
          <span className="eyebrow">COSTHUB · KNOWLEDGE BASE</span>
          <Typography.Title level={1}><AppstoreOutlined /> 资料库</Typography.Title>
        </div>
      </header>
      <div className="library-folder-row" aria-label="资料库分类">
        {LIBRARY_FOLDERS.map(folder => (
          <button
            key={folder.key}
            type="button"
            className={`library-folder-card tone-${folder.tone} ${tab === folder.key ? 'is-active' : ''}`}
            aria-pressed={tab === folder.key}
            onClick={() => setTab(folder.key)}
          >
            <span className="library-folder-back" aria-hidden="true" />
            <span className="library-folder-paper" aria-hidden="true" />
            <span className="library-folder-front">
              <strong>{folder.label}</strong>
              <small>{folder.copy}</small>
            </span>
          </button>
        ))}
      </div>
      <Tabs
        activeKey={tab}
        onChange={value => setTab(value as LibraryTab)}
        renderTabBar={() => <></>}
        items={[
          { key: 'parts', label: '器件', children: page(<PartsLibrary />) },
          { key: 'modules', label: '模块', children: page(<ModuleLibrary />) },
          { key: 'suppliers', label: '供应商', children: page(<SupplierManagement />) },
          { key: 'competitors', label: '竞品', children: page(<Competitors />) },
        ]}
      />
    </div>
  );
}
