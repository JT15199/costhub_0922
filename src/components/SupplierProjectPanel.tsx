import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Space, Spin, Table, Tag } from 'antd';
import { EnvironmentOutlined, ProjectOutlined, ReloadOutlined } from '@ant-design/icons';
import { getSupplierCategoryMap, getSupplierProjectCoverage, type SupplierProjectCoverage } from '../db/suppliers';

const money = (value: number) => `¥${(Number(value) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * 供应商「供应项目情况」面板（2026-09-21）
 * 数据全部来自本地库：part_suppliers × project_boms × projects（器件供货）+ project_suppliers（整机承接）+ supplier_quote_batches（招标报价）。
 * 金额口径与项目页一致：快照优先（pb.part_cost > 0），份额按 share_ratio 百分比，未填视为 100%。
 */
export default function SupplierProjectPanel({ supplierName, onEditLocation }: { supplierName: string; onEditLocation?: (supplierName: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [coverage, setCoverage] = useState<SupplierProjectCoverage | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!supplierName) return;
    setLoading(true);
    setError('');
    try {
      const [data, categoryMap] = await Promise.all([getSupplierProjectCoverage(supplierName), getSupplierCategoryMap()]);
      setCoverage(data);
      setCategories(categoryMap[supplierName] || []);
    } catch (e: any) {
      setError(String(e?.message || e || '加载供应项目情况失败'));
      setCoverage(null);
    } finally {
      setLoading(false);
    }
  }, [supplierName]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const handler = () => { void load(); };
    window.addEventListener('costhub-suppliers-changed', handler);
    return () => window.removeEventListener('costhub-suppliers-changed', handler);
  }, [load]);

  if (loading && !coverage) return <div className="sup-cov-loading"><Spin size="small" /> 正在汇总该供应商的供应项目…</div>;
  if (error) return <Alert type="error" showIcon message="供应项目情况加载失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} />;

  const totals = coverage?.totals;
  const hasAny = Boolean(coverage && (coverage.parts.length || coverage.odm.length || coverage.batches.length));

  return <div className="sup-cov">
    <div className="sup-cov-head">
      <div className="sup-cov-title"><ProjectOutlined /> 供应项目情况</div>
      <Space size={8} wrap>
        {categories.map(category => <Tag key={category} color="blue">{category}</Tag>)}
        {!categories.length && <span className="sup-cov-hint">未标注供应品类（可在「供应商资源池 → 编辑档案」里选择）</span>}
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        {onEditLocation && <Button size="small" icon={<EnvironmentOutlined />} onClick={() => onEditLocation(supplierName)}>维护厂家地址</Button>}
      </Space>
    </div>

    {totals && <div className="sup-cov-stats">
      <div><span>涉及项目</span><strong>{totals.projectCount}</strong></div>
      <div><span>供货器件</span><strong>{totals.partCount}</strong></div>
      <div><span>供货金额（库内成本口径）</span><strong className="is-money">{money(totals.supplierAmount)}</strong></div>
      <div><span>占所供项目 BOM</span><strong className="is-money">{totals.sharePct}%</strong></div>
    </div>}

    {!hasAny && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该供应商暂无项目供货记录（可能只维护了档案，或报价/整机关系尚未关联到项目）" />}

    {coverage && coverage.parts.length > 0 && <>
      <div className="sup-cov-section">器件供货 · {coverage.parts.length} 个项目</div>
      <Table
        size="small"
        rowKey="projectId"
        dataSource={coverage.parts}
        pagination={false}
        scroll={{ x: 720 }}
        columns={[
          { title: '项目', dataIndex: 'projectCode', width: 110, render: (value: string, row) => <span title={row.projectName}>{value}</span> },
          { title: '项目名称', dataIndex: 'projectName', ellipsis: true },
          { title: '品类', dataIndex: 'projectCategory', width: 90, render: (value: string) => <Tag>{value}</Tag> },
          { title: '供货器件', dataIndex: 'partCount', width: 90, align: 'right' as const, render: (value: number) => <span className="sup-cov-num">{value}</span> },
          { title: '供货金额', dataIndex: 'supplierAmount', width: 130, align: 'right' as const, render: (value: number) => <span className="sup-cov-num">{money(value)}</span> },
          { title: '项目 BOM', dataIndex: 'projectBomAmount', width: 130, align: 'right' as const, render: (value: number) => <span className="sup-cov-num is-muted">{money(value)}</span> },
          {
            title: '占项目 BOM', dataIndex: 'sharePct', width: 150,
            render: (value: number) => <div className="sup-cov-ratio"><span className="sup-cov-ratio-bar" style={{ width: `${Math.min(100, Math.max(2, value))}%` }} /><small>{value}%</small></div>,
          },
        ]}
      />
    </>}

    {coverage && coverage.odm.length > 0 && <>
      <div className="sup-cov-section">整机 / ODM 承接 · {coverage.odm.length} 个项目</div>
      <Table
        size="small"
        rowKey="projectId"
        dataSource={coverage.odm}
        pagination={false}
        scroll={{ x: 560 }}
        columns={[
          { title: '项目', dataIndex: 'projectCode', width: 110 },
          { title: '项目名称', dataIndex: 'projectName', ellipsis: true },
          { title: '整机报价', dataIndex: 'quotedPrice', width: 130, align: 'right' as const, render: (value: number) => <span className="sup-cov-num">{money(value)}</span> },
          { title: '份额', dataIndex: 'shareRatio', width: 90, align: 'right' as const, render: (value: number) => `${value}%` },
          { title: '状态', dataIndex: 'isActive', width: 80, render: (value: number) => value ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
        ]}
      />
    </>}

    {coverage && coverage.batches.length > 0 && <>
      <div className="sup-cov-section">招标报价批次 · {coverage.batches.length} 个项目</div>
      <Table
        size="small"
        rowKey="projectId"
        dataSource={coverage.batches}
        pagination={false}
        scroll={{ x: 560 }}
        columns={[
          { title: '项目', dataIndex: 'projectCode', width: 110 },
          { title: '项目名称', dataIndex: 'projectName', ellipsis: true },
          { title: '批次数', dataIndex: 'batchCount', width: 90, align: 'right' as const },
          { title: '报价合计', dataIndex: 'quotedAmount', width: 140, align: 'right' as const, render: (value: number) => <span className="sup-cov-num">{money(value)}</span> },
          { title: '最近报价', dataIndex: 'lastQuotedAt', width: 130, render: (value: string) => value || '—' },
        ]}
      />
    </>}
  </div>;
}
