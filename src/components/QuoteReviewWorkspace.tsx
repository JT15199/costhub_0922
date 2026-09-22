import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Collapse, Empty, Form, Input, InputNumber, Modal, Select, Spin, Table, Tag, message } from 'antd';
import { freezeProjectBOMVersion, getCostLayerSummary, getMeasures, getProjectBOMVersionLines, getProjectBOMVersions, saveMeasure } from '../db';
import { MEASURE_STATUSES } from '../constants';
import { buildQuoteReviewRows } from '../quoteComparison';
import './QuoteReviewWorkspace.css';

const money = (value: number | null | undefined) => value == null ? '—' : `¥${Number(value).toFixed(2)}`;
const statusLabels: Record<string, string> = { '待执行':'待跟进', '执行中':'跟进中' };
export default function QuoteReviewWorkspace({ projectId, project, projects = [], children }: { projectId: number; project?: any; projects?: any[]; children: ReactNode }) {
  const [summary, setSummary] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const requestedRound = useRef<number | undefined>(undefined);
  const [referenceProject, setReferenceProject] = useState(projectId);
  const [referenceVersions, setReferenceVersions] = useState<any[]>([]);
  const [referenceVersion, setReferenceVersion] = useState<number>();
  const [referenceLines, setReferenceLines] = useState<any[] | null>(null);
  const [referenceError, setReferenceError] = useState('');
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [roundName, setRoundName] = useState<string | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const [advanced, setAdvanced] = useState<string[]>([]);
  const load = useCallback(async () => {
    const request = ++seq.current; setLoading(true); setError('');
    try {
      const [cost, rounds, actions] = await Promise.all([getCostLayerSummary(projectId), getProjectBOMVersions(projectId), getMeasures(projectId)]);
      if (request !== seq.current) return;
      setSummary(cost); setVersions(rounds.filter(row => row.status === 'frozen')); setMeasures(actions);
    } catch (e) { if (request === seq.current) setError(String(e)); }
    finally { if (request === seq.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); return () => { seq.current++; }; }, [load]);
  useEffect(() => {
    let active = true;
    setReferenceLines(null); setReferenceError(''); setReferenceLoading(true); setReferenceVersions([]); setReferenceVersion(undefined);
    const rounds = referenceProject === projectId ? Promise.resolve(versions) : getProjectBOMVersions(referenceProject);
    rounds.then(rows => { if (!active) return; const frozen = rows.filter(row => row.status === 'frozen'); setReferenceVersions(frozen); setReferenceVersion(frozen.find(row => row.id === requestedRound.current)?.id ?? frozen[0]?.id); requestedRound.current = undefined; setReferenceLoading(false); })
      .catch(e => { if (active) { setReferenceError(String(e)); setReferenceLoading(false); } });
    return () => { active = false; };
  }, [referenceProject, projectId, versions]);
  useEffect(() => {
    let active = true; setReferenceLines(null);
    if (!referenceVersion) return;
    setReferenceLoading(true); setReferenceError('');
    getProjectBOMVersionLines(referenceVersion).then(rows => { if (active) { setReferenceLines(rows); setReferenceLoading(false); } })
      .catch(e => { if (active) { setReferenceError(String(e)); setReferenceLoading(false); } });
    return () => { active = false; };
  }, [referenceVersion]);
  const reference = referenceVersions.find(row => row.id === referenceVersion);
  const referenceName = projects.find(row => row.id === referenceProject)?.name || project?.name || '本项目';
  const source = reference ? `${referenceName} / ${reference.version_name || `v${reference.version_no}`} / ${reference.frozen_at || reference.created_at || ''}` : '';
  const rows = buildQuoteReviewRows(summary?.rows || [], referenceLines);
  const openMeasure = (value: any) => { setEditing(value); form.resetFields(); form.setFieldsValue({ status:'待执行', ...value }); };
  const follow = (row: ReturnType<typeof buildQuoteReviewRows>[number]) => openMeasure({
    project_id:projectId, main_category:row.module, measure:row.reference == null ? `补充 ${row.module} 可比报价` : `核对 ${row.module} 报价差异`,
    remark:row.reference == null ? '补充同规格供应商报价或历史报价。' : `参考：${source}\n本轮 ${money(row.current)}；参考 ${money(row.reference)}；差额 ${money(row.difference)}。需核对规格、数量和税运条件。`,
  });
  const saveFollowUp = async () => {
    try {
      const values = await form.validateFields();
      if (Number(values.realized_saving) > 0 && !String(values.realized_evidence || '').trim()) { message.warning('请补充确认价格的报价单或版本依据'); return; }
      setSaving(true); await saveMeasure({ ...editing, ...values, project_id:projectId }); setEditing(null); await load(); message.success('跟进已保存');
    } catch (e: any) { if (!e?.errorFields) message.error(`保存失败：${String(e?.message || e)}`); }
    finally { setSaving(false); }
  };
  if (loading && !summary) return <div className="quote-review-loading"><Spin /></div>;
  if (error) return <Alert type="error" showIcon message="报价信息加载失败" description={error} action={<Button onClick={() => void load()}>重试</Button>} />;
  return <div className="quote-review-workspace" aria-label="报价审核工作区">
    <Card size="small" title="本轮报价" extra={<Button type="primary" loading={saving} disabled={!summary?.rows?.length || !!summary?.missingCostRows?.length} onClick={() => setRoundName(`报价 R${Math.max(0, ...versions.map(row => Number(row.version_no) || 0)) + 1}`)}>保存本轮报价</Button>}>
      <div className="quote-review-total"><div><span>当前 BOM 核算成本（含平台费）</span><strong>{money(summary?.standardCost)}</strong></div><p>{summary?.missingCostRows?.length ? '分项金额待补齐' : <>物料 {money(summary?.layers.material)} · 包装 {money(summary?.layers.packaging)} · ODM 加工 {money(summary?.layers.odm_processing)} · 平台费 {money(summary?.platformFee)}</>}</p></div>
      {summary?.missingCostRows?.length > 0 ? <Alert showIcon type="warning" message={`${summary.missingCostRows.length} 行价格或数量待补齐，暂不能保存本轮报价`} /> : <p className="quote-review-note">先在 BOM 中更新供应商报价，再保存这一轮。历史轮次会保留，供应商含税整机报价仍以报价单为准。</p>}
      <div className="quote-review-rounds">{versions.slice(0, 5).map(round => <Button size="small" key={round.id} onClick={() => { if (referenceProject !== projectId) requestedRound.current = round.id; setReferenceProject(projectId); setReferenceVersion(round.id); setReferenceLines(null); }}>{round.version_name || `v${round.version_no}`} · {money(round.total_cost)}</Button>)}{!versions.length && <span>尚未保存报价轮次</span>}</div>
    </Card>
    <Card size="small" title="报价审核">
      <div className="quote-review-reference"><span>对照报价</span><Select aria-label="参考项目" value={referenceProject} onChange={value => { setReferenceProject(value); setReferenceVersion(undefined); setReferenceLines(null); }} options={[{ value:projectId, label:'本项目历史报价' }, ...projects.filter(row => row.id !== projectId).map(row => ({ value:row.id, label:`${row.code || ''} ${row.name}` }))]} /><Select aria-label="参考报价轮次" placeholder="选择已保存轮次" value={referenceVersion} loading={referenceLoading} onChange={value => { setReferenceVersion(value); setReferenceLines(null); }} options={referenceVersions.map(row => ({ value:row.id, label:row.version_name || `v${row.version_no}` }))} allowClear /></div>
      <p className="quote-review-note">{source ? `来源：${source}。按模块名称对齐；规格、数量、税费和运费条件需另行核对，差额不直接等于可降金额。` : '没有可比报价时先补询价，不预设“合理价格”。可选择本项目历史轮次，或其他供应商对应项目的已保存报价。'}</p>
      {referenceError && <Alert type="error" message="参考报价读取失败，请重新选择" description={referenceError} />}
      <Table size="small" rowKey="module" loading={referenceLoading || loading} dataSource={rows} pagination={{ pageSize:8, hideOnSinglePage:true }} scroll={{ x:750 }} locale={{ emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先导入或填写本项目 BOM" /> }} columns={[
        { title:'模块', dataIndex:'module', width:150 }, { title:'本轮', dataIndex:'current', align:'right', render:money }, { title:'参考', dataIndex:'reference', align:'right', render:money },
        { title:'差额', dataIndex:'difference', align:'right', render:(value: number | null) => value == null ? '—' : `${value > 0 ? '+' : ''}${money(value)}` },
        { title:'核对提示', dataIndex:'status', render:(value: string) => <Tag color={value === '高于参考' ? 'orange' : 'default'}>{value}</Tag> },
        { title:'下一步', width:105, render:(_: unknown, row: ReturnType<typeof buildQuoteReviewRows>[number]) => <Button type="link" size="small" disabled={!!referenceError || referenceLoading} onClick={() => follow(row)}>记入跟进</Button> },
      ]} />
    </Card>
    <Card size="small" title="谈价跟进" extra={<Button onClick={() => openMeasure({ project_id:projectId })}>添加跟进</Button>}>
      <Table size="small" rowKey="id" dataSource={measures} pagination={{ pageSize:5, hideOnSinglePage:true }} scroll={{ x:720 }} locale={{ emptyText:'暂无跟进事项，从上面的报价差异开始。' }} columns={[
        { title:'事项', dataIndex:'measure', render:(value: string, row: any) => <div><strong>{value}</strong><small className="quote-review-feedback">{row.main_category}{row.owner ? ` · ${row.owner}` : ''}{row.due_date ? ` · ${row.due_date}` : ''}</small><small className="quote-review-feedback">{row.remark || '待补供应商反馈'}</small></div> },
        { title:'预计争取', dataIndex:'forecast_saving', width:110, align:'right', render:(value: number) => Number(value) > 0 ? money(value) : '待评估' },
        { title:'已实现', dataIndex:'realized_saving', width:110, align:'right', render:(value: number, row: any) => Number(value) > 0 ? (row.realized_evidence ? money(value) : '待补依据') : '—' },
        { title:'状态', dataIndex:'status', width:90, render:(value: string) => statusLabels[value] || value },
        { title:'', width:105, render:(_: unknown, row: any) => <Button size="small" type="link" onClick={() => openMeasure(row)}>更新跟进</Button> },
      ]} />
    </Card>
    <Collapse activeKey={advanced} onChange={keys => { const next = Array.isArray(keys) ? keys.map(String) : [String(keys)]; setAdvanced(next); if (!next.length) void load(); }} items={[{ key:'advanced', label:'高级策划 · 产品规格、费用参数与目标成本', children }]} />
    <Modal open={roundName !== null} title="保存本轮报价" okText="保存报价" cancelText="取消" confirmLoading={saving} onCancel={() => { if (!saving) setRoundName(null); }} onOk={async () => {
      if (!roundName?.trim()) { message.warning('请填写供应商和轮次名称'); return; }
      setSaving(true);
      try { await freezeProjectBOMVersion(projectId, { versionName:roundName.trim(), sourceType:'supplier_quote', stage:project?.stage || '报价审核' }); setRoundName(null); await load(); message.success('本轮报价已保存'); }
      catch (e) { message.error(`保存失败：${String(e)}`); }
      finally { setSaving(false); }
    }}><p className="quote-review-note">保存当前 BOM 和价格，后续修改不会覆盖本轮。</p><Input aria-label="报价轮次名称" placeholder="如：A供应商 · R3 · 9月10日" value={roundName || ''} onChange={e => setRoundName(e.target.value)} maxLength={120} /></Modal>
    <Modal open={!!editing} title={editing?.id ? '更新谈价跟进' : '添加谈价跟进'} okText="保存跟进" cancelText="取消" confirmLoading={saving} onCancel={() => { if (!saving) setEditing(null); }} onOk={() => void saveFollowUp()} width={620}>
      <Form form={form} layout="vertical"><div className="quote-follow-grid"><Form.Item label="模块 / 范围" name="main_category" rules={[{ required:true, whitespace:true, message:'请填写模块' }]}><Input /></Form.Item><Form.Item label="状态" name="status"><Select options={MEASURE_STATUSES.map(value => ({ value, label:statusLabels[value] || value }))} /></Form.Item></div>
        <Form.Item label="要跟进什么" name="measure" rules={[{ required:true, whitespace:true, message:'请填写事项' }]}><Input /></Form.Item>
        <Form.Item label="报价依据 / 供应商反馈" name="remark"><Input.TextArea rows={3} placeholder="记录参考来源、已核对的条件，以及供应商回复" /></Form.Item>
        <div className="quote-follow-grid"><Form.Item label="预计争取（¥，可留空）" name="forecast_saving"><InputNumber min={0} precision={2} /></Form.Item><Form.Item label="已实现降本（¥，可留空）" name="realized_saving"><InputNumber min={0} precision={2} /></Form.Item></div>
        <Form.Item label="实现依据（有已实现金额时必填）" name="realized_evidence"><Input placeholder="如：A供应商 R3 报价单，BOM v4" /></Form.Item>
        <div className="quote-follow-grid"><Form.Item label="负责人（可选）" name="owner"><Input /></Form.Item><Form.Item label="下次跟进日期（可选）" name="due_date"><Input placeholder="YYYY-MM-DD" /></Form.Item></div>
      </Form>
    </Modal>
  </div>;
}


