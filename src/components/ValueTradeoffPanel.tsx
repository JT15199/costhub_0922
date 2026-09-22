import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Select, Space, Table, Tag, Upload, message } from 'antd';
import { CheckOutlined, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { getAllVoiceItems, getProjectBOMs, getVoiceDimensions, importVoiceItems, updateVoiceDimensionDecision } from '../db';
import { analyzeVoiceProduct } from '../voiceAnalysis';
import { detectVoiceSheet, type VoiceSheetDetection } from '../voiceImport';
import { bomExtendedCostStrict } from '../ai/contracts';

const KANO = ['基础', '性能', '惊喜', '无感', '反向'];
const DECISIONS = ['必须满足', '保留投入', '寻求等效降本', '不做'];
const VERIFICATION = [{ value: 'unverified', label: '待验证' }, { value: 'linked', label: '已关联规格' }, { value: 'verified', label: '已验证' }];
const specKeys = (value: unknown) => { if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean); try { const parsed = JSON.parse(String(value || '')); if (Array.isArray(parsed)) return parsed.map(String).map(v => v.trim()).filter(Boolean); } catch { } return String(value || '').split(/[,，]/).map(v => v.trim()).filter(Boolean); };

export default function ValueTradeoffPanel({ product, projectId }: { product?: string; projectId?: number }) {
  const [rows, setRows] = useState<any[]>([]);
  const [voiceItemCount, setVoiceItemCount] = useState(0);
  const [bomRows, setBomRows] = useState<any[]>([]);
  const [saving, setSaving] = useState<number | null>(null);
  const [sourcePlatform, setSourcePlatform] = useState('');
  const [sourceProduct, setSourceProduct] = useState(product || '');
  const [collectedAt, setCollectedAt] = useState('');
  const [voiceText, setVoiceText] = useState('');
  const [importing, setImporting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [voicePreview, setVoicePreview] = useState<VoiceSheetDetection | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);
  const load = useCallback(async () => { const seq = ++loadSeq.current; try { const [dimensions, boms, items] = await Promise.all([getVoiceDimensions(product || '', projectId), projectId ? getProjectBOMs(projectId) : Promise.resolve([]), getAllVoiceItems(product || '', projectId)]); if (seq !== loadSeq.current) return; setRows(dimensions); setBomRows(boms); setVoiceItemCount(items.length); } catch (error: any) { if (seq === loadSeq.current) message.error(`用户价值加载失败：${String(error?.message || error).slice(0, 100)}`); } }, [product, projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSourceProduct(product || ''); }, [product]);
  const moduleCostState = useMemo(() => { const costs: Record<string, number> = {}; const unknown = new Set<string>(); bomRows.forEach(row => { const name = String(row.module_name || '').trim(); if (!name) return; const value = bomExtendedCostStrict(row); if (value === null) { unknown.add(name); return; } costs[name] = (costs[name] || 0) + value; }); return { costs, unknown }; }, [bomRows]);
  const moduleCosts = moduleCostState.costs;
  const update = async (row: any, patch: any) => {
    const next = { ...row, ...patch }; setRows(items => items.map(item => item.id === row.id ? next : item));
    setSaving(row.id); try { await updateVoiceDimensionDecision(row.id, next.kano_category || '', next.decision || '', next.rationale || '', false, next.module_name || '', specKeys(next.spec_keys), next.verification_status || 'unverified'); } finally { setSaving(null); }
  };
  const confirmRow = async (row: any) => {
    const current = rows.find(item => item.id === row.id) || row;
    if (!current.kano_category || !current.decision || !String(current.rationale || '').trim() || !current.module_name || !specKeys(current.spec_keys).length || current.verification_status !== 'verified') { message.warning('请先补齐 Kano、价值决策、支撑模块、规格关联，并将验证状态设为“已验证”'); return; }
    setSaving(row.id);
    try { await updateVoiceDimensionDecision(row.id, current.kano_category, current.decision, String(current.rationale).trim(), true, current.module_name, specKeys(current.spec_keys), current.verification_status); await load(); message.success(`已确认“${current.name}”的价值取舍`); }
    finally { setSaving(null); }
  };
  const runAnalysis = async () => {
    if (!product || !projectId) { message.warning('请先在项目中选择有效项目'); return; }
    setAnalyzing(true); setAnalysisStatus('正在连接本地模型…'); analysisAbortRef.current = new AbortController();
    try { const result = await analyzeVoiceProduct(product, projectId, setAnalysisStatus, analysisAbortRef.current.signal); await load(); message.success(`原声分析完成：生成 ${result.length} 个主题`); }
    catch (error: any) { message.error(`原声分析失败：${String(error?.message || error).slice(0, 120)}`); }
    finally { analysisAbortRef.current = null; setAnalyzing(false); setAnalysisStatus(''); }
  };
  const importVoice = async (contents: string[], source = 'manual_import'): Promise<boolean> => {
    const clean = contents.map(value => String(value || '').trim()).filter(Boolean);
    if (!clean.length) { message.warning('没有可导入的原声文本'); return false; }
    if (!sourcePlatform.trim() || !sourceProduct.trim() || !collectedAt.trim()) { message.warning('请先补齐来源平台、来源产品和采集日期'); return false; }
    setImporting(true);
    try { const result = await importVoiceItems(product || '', clean, { projectId, source, sourcePlatform, sourceProduct: sourceProduct || product || '', collectedAt }); setVoiceText(''); await load(); message.success(`原声导入完成：新增 ${result.added} 条，重复 ${result.dup} 条`); return true; }
    catch (error: any) { message.error(`原声导入失败：${String(error?.message || error).slice(0, 120)}`); return false; }
    finally { setImporting(false); }
  };
  const importExcel = async (file: any) => { try { const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' }); const detected = detectVoiceSheet(workbook.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[name], { header: 1, defval: '' }) }))); if (!detected.contents.length) { message.warning('未识别到评论文本列，请检查表头或下载模板'); return false; } setVoicePreview(detected); } catch (error: any) { message.error(`原声文件读取失败：${String(error?.message || error).slice(0, 120)}`); } return false; };
  const confirmedCount = rows.filter(row => row.confirmed && row.module_name && specKeys(row.spec_keys).length && row.verification_status === 'verified').length;
  return <Card size="small" title="用户价值与取舍" extra={<Tag color={confirmedCount < rows.length ? 'orange' : 'green'}>{voiceItemCount ? `已导入 ${voiceItemCount} 条 · ${confirmedCount}/${rows.length} 已确认` : '无原声数据'}</Tag>}>
    {voicePreview && <Alert type="info" showIcon message={`已识别 ${voicePreview.sheetName} · ${voicePreview.contents.length} 条原声`} description={<><div>文本列：{voicePreview.headers[voicePreview.contentColumn] || `第 ${voicePreview.contentColumn + 1} 列`} · 识别置信度 ${Math.round(voicePreview.confidence * 100)}%</div><div>{voicePreview.preview.map((item, index) => <div key={index}>“{item.slice(0, 80)}”</div>)}</div><Button size="small" type="primary" onClick={async () => { if (await importVoice(voicePreview.contents, 'excel_import')) setVoicePreview(null); }}>确认导入这 {voicePreview.contents.length} 条</Button></>} style={{ marginTop: 8 }} />}
    <div className="value-voice-import"><Space wrap><Input size="small" value={sourcePlatform} onChange={event => setSourcePlatform(event.target.value)} placeholder="来源平台，如电商/论坛" /><Input size="small" value={sourceProduct} onChange={event => setSourceProduct(event.target.value)} placeholder="来源产品" /><Input size="small" value={collectedAt} onChange={event => setCollectedAt(event.target.value)} placeholder="采集日期 YYYY-MM-DD" /><Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={importExcel}><Button size="small" icon={<UploadOutlined />} loading={importing}>导入原声 Excel</Button></Upload><Button size="small" type="primary" icon={<PlayCircleOutlined />} loading={analyzing && !analysisAbortRef.current} onClick={() => { if (analyzing) analysisAbortRef.current?.abort(); else void runAnalysis(); }}>{analyzing ? '停止分析' : '生成主题'}</Button></Space><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={voiceText} onChange={event => setVoiceText(event.target.value)} placeholder="也可直接粘贴评论，每行一条" /><Button size="small" type="primary" loading={importing} onClick={() => void importVoice(voiceText.split(/\r?\n/))}>导入粘贴内容</Button>{analysisStatus && <span className="planning-note">{analysisStatus}</span>}</div>
    {rows.length ? <Table size="small" scroll={{ x: 1500 }} rowKey="id" pagination={{ pageSize: 6, hideOnSinglePage: true }} dataSource={rows} expandable={{ expandedRowRender: row => { let evidence: string[] = []; try { const parsed = JSON.parse(row.evidence || '[]'); if (Array.isArray(parsed)) evidence = parsed.map(String).filter(Boolean); } catch { } return evidence.length ? <div>{evidence.map((item, index) => <div key={index}>“{item}”</div>)}</div> : <span className="planning-note">暂无直接匹配原声，请回看导入样本</span>; } }} columns={[{ title: '主题', dataIndex: 'name', width: 150 }, { title: '样本', dataIndex: 'count', width: 55, align: 'right' }, { title: '正/负', render: (_: any, row: any) => `${row.positive || 0} / ${row.negative || 0}`, width: 70 }, { title: '原声证据', dataIndex: 'evidence', ellipsis: true }, { title: '支撑模块', dataIndex: 'module_name', width: 150, render: (v: string, row: any) => <Select size="small" allowClear value={v || undefined} placeholder="待关联" options={Object.keys(moduleCosts).map(value => ({ value, label: value }))} onChange={value => void update(row, { module_name: value || '' })} /> }, { title: '规格关联', width: 150, render: (_: any, row: any) => <Input size="small" value={specKeys(row.spec_keys).join('、')} placeholder="如 分辨率、刷新率" onChange={event => setRows(items => items.map(item => item.id === row.id ? { ...item, spec_keys: event.target.value, confirmed: 0 } : item))} onBlur={() => void update(row, { spec_keys: (rows.find(item => item.id === row.id)?.spec_keys || '') })} /> }, { title: '估算成本', width: 90, align: 'right', render: (_: any, row: any) => row.module_name ? (moduleCostState.unknown.has(row.module_name) ? '待补证据' : `¥${Number(moduleCosts[row.module_name]).toFixed(2)}`) : '待关联' }, { title: '验证状态', width: 110, render: (_: any, row: any) => <Select size="small" value={row.verification_status || 'unverified'} options={VERIFICATION} onChange={value => void update(row, { verification_status: value })} /> }, { title: 'Kano', dataIndex: 'kano_category', width: 115, render: (v: string, row: any) => <Select size="small" value={v || undefined} placeholder="待分类" options={KANO.map(value => ({ value, label: value }))} onChange={value => void update(row, { kano_category: value })} /> }, { title: '价值决策', dataIndex: 'decision', width: 150, render: (v: string, row: any) => <Select size="small" value={v || undefined} placeholder="待决策" options={DECISIONS.map(value => ({ value, label: value }))} onChange={value => void update(row, { decision: value })} /> }, { title: '理由', dataIndex: 'rationale', render: (v: string, row: any) => <Space.Compact block><Input size="small" value={v || ''} placeholder="填写确认理由" onChange={event => setRows(items => items.map(item => item.id === row.id ? { ...item, rationale: event.target.value, confirmed: 0 } : item))} onBlur={() => void update(row, { rationale: (rows.find(item => item.id === row.id)?.rationale || '') })} /><Button size="small" icon={<CheckOutlined />} loading={saving === row.id} onClick={() => void confirmRow(row)} aria-label={`确认${row.name}`} /></Space.Compact> }, { title: '状态', width: 90, render: (_: any, row: any) => row.confirmed && row.module_name && specKeys(row.spec_keys).length && row.verification_status === 'verified' ? <Tag color="green">已确认</Tag> : <Tag color="orange">待补齐</Tag> }]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="导入产品评论并点击“生成主题”后，在这里人工确认" />}
    <div className="planning-note">评论频次只代表被提及程度，不直接代表愿付价格；Kano 分类、模块关联和价值决策均需人工确认。</div>
  </Card>;
}
