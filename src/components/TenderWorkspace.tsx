import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Drawer, Empty, Input, Modal, Progress, Radio, Segmented, Space, Spin, Statistic, Steps, Table, Tag, Tooltip, Upload, message } from 'antd';
import { AimOutlined, CheckCircleOutlined, ClockCircleOutlined, DownloadOutlined, FileExcelOutlined, HistoryOutlined, InboxOutlined, ReloadOutlined, UploadOutlined, WarningOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { getTenderMatrix, getTenderOverview, importTenderQuoteBatch, type TenderMatrixRow, type TenderOverview } from '../db';
import { parseTenderQuoteFile, type ParsedTenderQuote } from '../tenderImport';

interface TenderWorkspaceProps { projectId: number; project?: any; }
type MatrixFilter = 'all' | 'opportunity' | 'pending';

const STAGES = ['规格预估', '摸底报价', '比价', '谈价', '定点', '复盘'];
const relationLabel: Record<string, string> = { exact: '可比', equivalent: '等价', reference: '参考', incomparable: '不可比', unmatched: '待确认' };
const relationColor: Record<string, string> = { exact: 'green', equivalent: 'cyan', reference: 'blue', incomparable: 'default', unmatched: 'orange' };

function money(value: number) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function pct(value: number) { return `${Math.round((value || 0) * 100)}%`; }

export default function TenderWorkspace({ projectId, project }: TenderWorkspaceProps) {
  const [overview, setOverview] = useState<TenderOverview | null>(null);
  const [matrix, setMatrix] = useState<TenderMatrixRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const [preview, setPreview] = useState<ParsedTenderQuote | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [stage, setStage] = useState('摸底报价');
  const [importing, setImporting] = useState(false);
  const [selectedRow, setSelectedRow] = useState<TenderMatrixRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOverview, nextMatrix] = await Promise.all([getTenderOverview(projectId), getTenderMatrix(projectId)]);
      setOverview(nextOverview); setMatrix(nextMatrix);
    } catch (error: any) {
      message.error(`招标数据加载失败：${String(error?.message || error).slice(0, 120)}`);
    } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const handleFile = async (file: any) => {
    try {
      const parsed = await parseTenderQuoteFile((file?.originFileObj || file) as File);
      setPreview(parsed); setSupplierName(parsed.supplierName); setStage('摸底报价');
    } catch (error: any) { message.error(`报价文件解析失败：${String(error?.message || error).slice(0, 160)}`); }
    return false;
  };
  const confirmImport = async () => {
    if (!preview) return;
    if (!supplierName.trim()) { message.warning('请补充供应商名称'); return; }
    setImporting(true);
    try {
      const result = await importTenderQuoteBatch({ project_id: projectId, supplier_name: supplierName.trim(), source_file_name: preview.sourceFileName, source_file_hash: preview.sourceFileHash, stage, total_amount: preview.totalAmount, currency: 'CNY', tax_mode: 'exclusive', pricing_mode: 'one_time', lines: preview.lines });
      if (result.duplicate) message.warning('这份报价文件已经导入过，未重复创建批次');
      else message.success(`已导入 ${result.importedLines} 行，${result.roundLabel}`);
      setPreview(null); await load();
    } catch (error: any) { message.error(`报价导入失败：${String(error?.message || error).slice(0, 160)}`); }
    finally { setImporting(false); }
  };

  const suppliers = useMemo(() => {
    const names = new Set<string>();
    matrix.forEach(row => Object.keys(row.offers).forEach(name => names.add(name)));
    return Array.from(names);
  }, [matrix]);
  const visibleRows = useMemo(() => matrix.filter(row => filter === 'all' || (filter === 'opportunity' ? row.opportunity > 0 : Object.values(row.offers).some(offer => offer.relationType === 'unmatched'))), [filter, matrix]);
  const currentStageIndex = Math.max(0, STAGES.findIndex(item => item === overview?.currentRound?.stage));
  const summary = overview?.summary || { supplierCount: 0, lineCount: 0, comparableCount: 0, referenceCount: 0, unmatchedCount: 0, comparableCoverage: 0, theoreticalLow: 0, bestFullQuote: 0, opportunity: 0 };

  const exportNegotiation = () => {
    const rows = matrix.filter(row => row.opportunity > 0).map(row => ({ 模块: row.moduleName, 器件名称: row.materialName, 型号: row.model, 规格: row.specs, 数量: row.quantity, 可比最低: row.comparableLow ? row.comparableLow.lineTotal : '', 最低供应商: row.comparableLow?.supplierName || '', 议价机会: row.opportunity, 说明: '理论组合底价，仅作谈判锚点' }));
    if (!rows.length) { message.info('当前没有已确认的可比价差'); return; }
    const sheet = XLSX.utils.json_to_sheet(rows); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '议价清单'); XLSX.writeFile(book, `议价清单_${project?.code || projectId}.xlsx`); message.success(`已导出 ${rows.length} 条议价线索`);
  };

  const columns: any[] = [
    { title: '模块', dataIndex: 'moduleName', key: 'module', width: 110, fixed: 'left', render: (value: string) => <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{value || '未归类'}</span> },
    { title: '器件 / 规格', key: 'material', width: 260, fixed: 'left', render: (_: any, row: TenderMatrixRow) => <div><div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{row.materialName || '未命名器件'}</div><div style={{ color: 'var(--color-text-secondary)', fontSize: 11, marginTop: 2 }}>{row.model || '型号待补'} · {row.specs || '规格待补'}</div></div> },
    { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 70, align: 'right' as const },
    ...suppliers.map(supplier => ({ title: supplier, key: supplier, width: 140, render: (_: any, row: TenderMatrixRow) => { const offer = row.offers[supplier]; if (!offer) return <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>; return <Tooltip title={`${offer.sourceFileName} · ${offer.quotedAt || '时间待补'}`}><div style={{ cursor: 'pointer' }} onClick={() => setSelectedRow(row)}><div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontWeight: 600 }}>{money(offer.lineTotal)}</div><Tag color={relationColor[offer.relationType] || 'default'} style={{ margin: '3px 0 0', fontSize: 10 }}>{relationLabel[offer.relationType] || offer.relationType}</Tag></div></Tooltip>; } })),
    { title: <span><AimOutlined /> 可比最低</span>, key: 'low', width: 150, render: (_: any, row: TenderMatrixRow) => row.comparableLow ? <div><div style={{ color: '#1677ff', fontWeight: 700 }}>{money(row.comparableLow.lineTotal)}</div><div style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>{row.comparableLow.supplierName}</div></div> : <Tag color="orange">待确认</Tag> },
    { title: '机会金额', key: 'opportunity', width: 110, align: 'right' as const, render: (_: any, row: TenderMatrixRow) => row.opportunity > 0 ? <span style={{ color: '#cf1322', fontWeight: 700 }}>+{money(row.opportunity)}</span> : <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> },
  ];

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card size="small" styles={{ body: { padding: '14px 16px' } }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div><div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>招标工作台</div><div style={{ color: 'var(--color-text-secondary)', fontSize: 12, marginTop: 3 }}>{project?.code ? `[${project.code}] ` : ''}{project?.name || '当前项目'} · 报价原文与过程版本独立留痕</div></div>
        <Space wrap>
          <Upload beforeUpload={handleFile} showUploadList={false} accept=".xlsx,.xls"><Button type="primary" icon={<UploadOutlined />}>导入报价</Button></Upload>
          <Button icon={<HistoryOutlined />} onClick={() => setFilter('all')}>查看比价</Button>
          <Button icon={<DownloadOutlined />} onClick={exportNegotiation}>生成议价清单</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
        </Space>
      </div>
      <Divider style={{ margin: '13px 0 10px' }} />
      <Steps size="small" current={overview?.currentRound ? currentStageIndex : 0} items={STAGES.map((title, index) => ({ title, icon: index === currentStageIndex && overview?.currentRound ? <ClockCircleOutlined /> : undefined }))} />
    </Card>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
      <Card size="small"><Statistic title="供应商" value={summary.supplierCount} suffix="家" /></Card>
      <Card size="small"><Statistic title="报价明细" value={summary.lineCount} suffix="行" /></Card>
      <Card size="small"><Statistic title="可比覆盖率" value={pct(summary.comparableCoverage)} valueStyle={{ color: summary.comparableCoverage >= 0.7 ? '#389e0d' : '#d48806' }} /></Card>
      <Card size="small"><Statistic title="理论组合底价" value={summary.theoreticalLow} precision={2} prefix="¥" valueStyle={{ color: '#1677ff' }} /></Card>
      <Card size="small"><Statistic title="可谈机会" value={summary.opportunity} precision={2} prefix="¥" valueStyle={{ color: summary.opportunity > 0 ? '#cf1322' : '#389e0d' }} /></Card>
    </div>

    {overview?.currentSpec && <Alert type="info" showIcon icon={<CheckCircleOutlined />} message={<span>当前规格基线 v{overview.currentSpec.versionNo} · {overview.currentSpec.changedFields.length ? `本次变化：${overview.currentSpec.changedFields.join('、')}` : '规格未检测到变化'} · 第{overview.currentRound?.roundNo || 1}轮报价</span>} description="理论组合底价仅用于谈判锚点；参考价和待确认物料不会计入。" />}

    <Card size="small" title={<Space><FileExcelOutlined />报价比价矩阵<Tooltip title="默认取当前轮次每家供应商的最新批次；原始文件可在历史批次中追溯"><span style={{ color: 'var(--color-text-tertiary)', cursor: 'help' }}>ⓘ</span></Tooltip></Space>} extra={<Space><Segmented size="small" value={filter} onChange={value => setFilter(value as MatrixFilter)} options={[{ label: `全部 ${matrix.length}`, value: 'all' }, { label: `有机会 ${matrix.filter(row => row.opportunity > 0).length}`, value: 'opportunity' }, { label: `待确认 ${summary.unmatchedCount}`, value: 'pending' }]} /><Tag color="blue">人民币 · 未税 · 一口价</Tag></Space>}>
      {loading ? <div style={{ textAlign: 'center', padding: 50 }}><Spin /></div> : visibleRows.length ? <Table size="small" rowKey="key" columns={columns} dataSource={visibleRows} scroll={{ x: 1080 }} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: total => `共 ${total} 行` }} onRow={row => ({ onDoubleClick: () => setSelectedRow(row) })} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={matrix.length ? '当前筛选没有匹配项' : '还没有报价批次'}><Upload beforeUpload={handleFile} showUploadList={false} accept=".xlsx,.xls"><Button type="primary" icon={<InboxOutlined />}>导入第一份报价</Button></Upload></Empty>}
    </Card>

    {(overview?.batches?.length || overview?.events?.length) ? <Card size="small" title="过程留痕" extra={<span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>报价原文不覆盖，历史批次按时间倒序</span>}><Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} items={[{ key: 'round', label: '当前轮次', children: overview.currentRound ? `第${overview.currentRound.roundNo}轮 · ${overview.currentRound.name}` : '尚未开始' }, { key: 'batches', label: '报价批次', children: `${overview.batches.length} 份` }, { key: 'events', label: '过程事件', children: `${overview.events.length} 条` }]} /></Card> : null}

    <Modal title="导入报价预览" open={!!preview} onCancel={() => !importing && setPreview(null)} onOk={() => void confirmImport()} okText="确认导入" confirmLoading={importing} width={820} destroyOnHidden>
      {preview && <div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}><div><div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>文件</div><div style={{ fontWeight: 600 }}>{preview.sourceFileName}</div></div><div><div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>供应商</div><Input size="small" value={supplierName} onChange={event => setSupplierName(event.target.value)} placeholder="例如：A供应商" /></div><div><div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>所属阶段</div><Radio.Group size="small" value={stage} onChange={event => setStage(event.target.value)} options={['摸底报价', '谈价', '定点'].map(value => ({ label: value, value }))} /></div></div><Alert type="info" showIcon message={`识别到 ${preview.lines.length} 行，合计 ${money(preview.totalAmount)}；表头第 ${preview.headerRow + 1} 行`} description={preview.warnings.length ? preview.warnings.join('；') : '将按人民币、未税、一口价保存；原始单元格会保留在批次中。'} style={{ marginBottom: 12 }} /><Table size="small" rowKey="source_row" dataSource={preview.lines.slice(0, 8)} pagination={false} columns={[{ title: '来源行', dataIndex: 'source_row', width: 65 }, { title: '模块', dataIndex: 'module_name' }, { title: '器件名称', dataIndex: 'raw_name' }, { title: '规格', dataIndex: 'raw_specs', ellipsis: true }, { title: '数量', dataIndex: 'quantity', width: 60 }, { title: '单价', dataIndex: 'unit_price', width: 90, render: money }, { title: '小计', dataIndex: 'line_total', width: 90, render: money }]} /></div>}
    </Modal>

    <Drawer title="报价行详情" open={!!selectedRow} onClose={() => setSelectedRow(null)} width={480}>
      {selectedRow && <div><div style={{ fontSize: 17, fontWeight: 700 }}>{selectedRow.materialName}</div><div style={{ color: 'var(--color-text-secondary)', margin: '4px 0 14px' }}>{selectedRow.model || '型号待补'} · {selectedRow.specs || '规格待补'}</div><Alert type="warning" showIcon icon={<WarningOutlined />} message="可比判断需基于名称+规格核实" description="当前工作台只把标准化键一致的报价计入底价；等价/参考关系请在后续确认流程中标记。" style={{ marginBottom: 14 }} /><Table size="small" rowKey="supplierName" pagination={false} dataSource={Object.values(selectedRow.offers)} columns={[{ title: '供应商', dataIndex: 'supplierName' }, { title: '报价', dataIndex: 'lineTotal', render: money }, { title: '关系', dataIndex: 'relationType', render: value => <Tag color={relationColor[value] || 'default'}>{relationLabel[value] || value}</Tag> }, { title: '来源', dataIndex: 'sourceFileName', ellipsis: true }]} /><Divider /><Progress percent={selectedRow.comparableLow ? 100 : 0} size="small" status={selectedRow.comparableLow ? 'success' : 'exception'} format={() => selectedRow.comparableLow ? `最低：${selectedRow.comparableLow.supplierName}` : '待确认可比关系'} /></div>}
    </Drawer>
  </div>;
}
