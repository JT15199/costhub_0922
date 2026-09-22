import { useEffect, useState, lazy, Suspense } from 'react';
import { Tabs, Typography } from 'antd';
import { BarChartOutlined, BranchesOutlined } from '@ant-design/icons';

const MaterialInsight = lazy(() => import('./Decomposition'));
const AnalysisResults = lazy(() => import('./AnalysisResults'));

type IntelligenceTab = 'material' | 'results';

export default function Intelligence() {
  const [tab, setTab] = useState<IntelligenceTab>(() => (
    localStorage.getItem('costhub-intelligence-tab') === 'results' ? 'results' : 'material'
  ));

  useEffect(() => {
    localStorage.setItem('costhub-intelligence-tab', tab);
    window.dispatchEvent(new CustomEvent('app-page-active', {
      detail: { page: tab === 'material' ? 'decomposition' : 'analysisResults' },
    }));
  }, [tab]);

  useEffect(() => {
    const handlePageActive = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.page !== 'intelligence' || !detail.tab) return;
      setTab(detail.tab === 'results' ? 'results' : 'material');
    };
    window.addEventListener('app-page-active', handlePageActive);
    return () => window.removeEventListener('app-page-active', handlePageActive);
  }, []);

  return (
    <div className="hub-page">
      <header className="hub-page-header">
        <div>
          <span className="eyebrow">COSTHUB · INTELLIGENCE</span>
          <Typography.Title level={1}><BranchesOutlined /> 情报</Typography.Title>
        </div>
      </header>
      <Tabs
        activeKey={tab}
        onChange={value => setTab(value as IntelligenceTab)}
        items={[
          {
            key: 'material',
            label: <span><BranchesOutlined /> 物料行情</span>,
            children: <Suspense fallback={<div className="hub-page-loading">正在加载物料行情…</div>}><MaterialInsight /></Suspense>,
          },
          {
            key: 'results',
            label: <span><BarChartOutlined /> 分析成果</span>,
            children: <Suspense fallback={<div className="hub-page-loading">正在加载分析成果…</div>}><AnalysisResults /></Suspense>,
          },
        ]}
      />
    </div>
  );
}
