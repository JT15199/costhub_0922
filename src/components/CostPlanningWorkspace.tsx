import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Input, InputNumber, Select, Space, Table, Tag, message } from 'antd';
import { CheckCircleOutlined, HistoryOutlined, PlusOutlined, SaveOutlined, TagsOutlined } from '@ant-design/icons';
import { createBaselineDecision, createChangePackage, createProjectTargetVersion, freezeProjectBOMVersion, freezeProjectSpecBaseline, getBaselineDecisions, getChangePackageLines, getChangePackages, getCostLayerSummary, getProjectBOMVersionLines, getProjectBOMVersions, getProjectSpecProfile, getProjectTargetRows, getProjectTargetVersions, markChangePackageImplemented, previewProjectTargetVersion, saveProject, saveProjectSpecValues, setBaselineDecisionStatus, setChangePackageStatus, setProjectReference, updateBaselineDecision, updateChangePackageLine, type CostLayer } from '../db';
import ValueTradeoffPanel from './ValueTradeoffPanel';
import CostWallPanel from './CostWallPanel';
import QuoteReviewWorkspace from './QuoteReviewWorkspace';

interface CostPlanningWorkspaceProps { projectId: number; project?: any; projects?: any[]; onTargetsChanged?: () => void; onProjectChanged?: () => void | Promise<void>; }

const layerLabels: Record<CostLayer, string> = { material: '物料', packaging: '包装', odm_processing: 'ODM加工' };
const statusLabels: Record<string, string> = { candidate: '候选', confirmed: '已确认', feasibility_confirmed: '可行性已确认', selected: '已选中', implemented: '已实施', expired: '已过期', rejected: '已驳回', draft: '草稿', frozen: '已冻结', superseded: '已替代' };

export default function CostPlanningWorkspace(props: CostPlanningWorkspaceProps) {
  return <QuoteReviewWorkspace key={props.projectId} {...props}><AdvancedCostPlanningWorkspace {...props} /></QuoteReviewWorkspace>;
}

function AdvancedCostPlanningWorkspace({ projectId, project, projects = [], onTargetsChanged, onProjectChanged }: CostPlanningWorkspaceProps) {
  const [specRows, setSpecRows] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [baselines, setBaselines] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [packageLines, setPackageLines] = useState<Record<number, any[]>>({});
  const [targetVersions, setTargetVersions] = useState<any[]>([]);
  const [referenceProjectId, setReferenceProjectId] = useState<number | undefined>();
  const [referenceSummary, setReferenceSummary] = useState<any>(null);
  const [referenceVersions, setReferenceVersions] = useState<any[]>([]);
  const [referenceLines, setReferenceLines] = useState<any[]>([]);
  const [targetCost, setTargetCost] = useState<number | null>(null);
  const [targetResult, setTargetResult] = useState<any>(null);
  const [targetPreview, setTargetPreview] = useState<any>(null);
  const [packageDraft, setPackageDraft] = useState({ title: '', triggerType: 'spec', beforeValue: '', afterValue: '', rationale: '' });
  const [platformFeeRate, setPlatformFeeRate] = useState(0);
  const [profitRate, setProfitRate] = useState(0);
  const [busy, setBusy] = useState('');
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [spec, cost, bomVersions, baselineRows, packageRows, targetRows] = await Promise.all([
        getProjectSpecProfile(projectId, project?.category || '显示器'), getCostLayerSummary(projectId), getProjectBOMVersions(projectId), getBaselineDecisions(projectId), getChangePackages(projectId), getProjectTargetVersions(projectId),
      ]);
      if (seq !== loadSeq.current) return;
      setSpecRows(spec); setSummary(cost); setVersions(bomVersions); setBaselines(baselineRows); setPackages(packageRows); setTargetVersions(targetRows);
    } catch (error: any) { message.error(`成本策划加载失败：${String(error?.message || error).slice(0, 120)}`); }
  }, [projectId, project]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const value = Number(project?.financial_target_cost || 0); setTargetCost(value > 0 ? value : null); }, [project?.id, project?.financial_target_cost]);
  useEffect(() => { setPlatformFeeRate(Number(project?.platform_fee_rate || 0)); setProfitRate(Number(project?.profit_rate || 0)); }, [project?.id, project?.platform_fee_rate, project?.profit_rate]);
  useEffect(() => {
    setReferenceProjectId(Number(project?.reference_project_id || 0) || undefined);
    setTargetPreview(null);
    setTargetResult(null);
  }, [project?.id, project?.reference_project_id]);
  useEffect(() => {
    let active = true;
    const loadedProjectId = projectId;
    const latest = targetVersions[0];
    if (!latest?.id) { setTargetResult(null); return () => { active = false; }; }
    void getProjectTargetRows(Number(latest.id)).then(rows => {
      if (!active || loadedProjectId !== projectId) return;
      const confirmedOpportunity = rows.reduce((sum, row) => sum + Number(row.opportunity_amount || 0), 0);
      setTargetResult({ id: latest.id, versionNo: latest.version_no, baselineCost: Number(latest.baseline_cost || 0), decomposableTarget: Number(latest.target_cost || 0) / (1 + Number(platformFeeRate || 0) / 100), challengeGap: Number(latest.challenge_gap || 0), confirmedOpportunity, uncoveredGap: Math.max(0, Number(latest.challenge_gap || 0) - confirmedOpportunity), missingCostRows: [], rows: rows.map(row => ({ ...row, current: Number(row.baseline_cost || 0) + Number(row.opportunity_amount || 0), baseline: Number(row.baseline_cost || 0), opportunity: Number(row.opportunity_amount || 0), allocated: Number(row.allocated_challenge || 0), target: Number(row.target_cost || 0) })) });
    }).catch(() => { if (active && loadedProjectId === projectId) setTargetResult(null); });
    return () => { active = false; };
  }, [projectId, targetVersions, platformFeeRate]);
  useEffect(() => {
    if (!referenceProjectId) { setReferenceSummary(null); setReferenceVersions([]); setReferenceLines([]); return; }
    Promise.all([getCostLayerSummary(referenceProjectId).catch(() => null), getProjectBOMVersions(referenceProjectId).catch(() => [])]).then(async ([cost, bomVersions]) => {
      const frozen = bomVersions.find(row => row.status === 'frozen');
      if (!frozen || !cost) { setReferenceSummary(null); setReferenceVersions(bomVersions); setReferenceLines([]); return; }
      const lines = await getProjectBOMVersionLines(frozen.id).catch(() => []);
      const decomposable = lines.reduce((sum, row) => sum + Number(row.line_total || 0), 0);
      const missingCostRows = lines.filter(row => Number(row.quantity || 1) > 0 && Number(row.unit_cost || 0) <= 0);
      const platformFeeRate = Number(projects.find(row => row.id === referenceProjectId)?.platform_fee_rate || 0);
      const platformFee = decomposable * platformFeeRate / 100;
      setReferenceSummary({ ...cost, decomposable, platformFee, standardCost: decomposable + platformFee, missingCostRows });
      setReferenceVersions(bomVersions);
      setReferenceLines(lines);
    });
  }, [referenceProjectId, projects]);

  const saveSpecs = async () => {
    const missing = specRows.filter(row => Number(row.required) === 1 && !String(row.value_text || '').trim());
    if (missing.length) { message.warning(`请先补齐必填规格：${missing.map(row => row.field_label).join('、')}`); return; }
    setBusy('spec');
    try {
      await saveProjectSpecValues(projectId, specRows.map(row => ({ fieldId: row.id, value: row.value_text })));
      const id = await freezeProjectSpecBaseline(projectId, project?.category || '显示器', 'manual');
      message.success(`产品规格已保存，版本 #${id} 已留痕`); await load();
    } catch (error: any) { message.error(`规格保存失败：${String(error?.message || error).slice(0, 120)}`); }
    finally { setBusy(''); }
  };

  const saveCostParams = async () => {
    setBusy('rates');
    try {
      await saveProject({ ...project, id: projectId, platform_fee_rate: platformFeeRate, profit_rate: profitRate });
      await onProjectChanged?.();
      await load();
      message.success('成本参数已保存');
    } catch (error: any) { message.error(`成本参数保存失败：${String(error?.message || error).slice(0, 120)}`); }
    finally { setBusy(''); }
  };

  const freezeBOM = async (sourceType = 'manual') => {
    setBusy('bom');
    try { const referenceVersion = referenceVersions.find(row => row.status === 'frozen'); const id = await freezeProjectBOMVersion(projectId, { sourceType, sourceRefId: sourceType === 'charter_estimate' ? (referenceVersion?.id || 0) : 0, stage: sourceType === 'charter_estimate' ? 'Charter' : '项目工作区' }); message.success(`已冻结 BOM 版本 #${id}`); await load(); }
    catch (error: any) { message.error(`BOM冻结失败：${String(error?.message || error).slice(0, 120)}`); }
    finally { setBusy(''); }
  };

  const addBaselineCandidates = async () => {
    if (!summary?.rows?.length) { message.info('当前 BOM 还没有可生成基线的行'); return; }
    const groups = new Map<string, { category: string; value: number }>();
    summary.rows.filter((row: any) => row.price_state === 'confirmed' && row.quantity_state !== 'invalid').forEach((row: any) => { const key = row.main_category || '其他'; const item = groups.get(key) || { category: key, value: 0 }; item.value += row.line_total; groups.set(key, item); });
    for (const row of groups.values()) await createBaselineDecision({ projectId, baselineType: 'module', category: row.category, scopeKey: `${projectId}:${row.category}`, sourceType: 'project_bom', value: row.value, rationale: '由当前可编辑 BOM 生成候选，待人工确认' });
    message.success(`已生成 ${groups.size} 条基线候选`); await load();
  };

  const addPackage = async () => {
    if (!packageDraft.title.trim()) { message.warning('请填写变更包标题'); return; }
    await createChangePackage({ projectId, title: packageDraft.title, triggerType: packageDraft.triggerType, beforeValue: packageDraft.beforeValue, afterValue: packageDraft.afterValue, rationale: packageDraft.rationale });
    setPackageDraft({ title: '', triggerType: 'spec', beforeValue: '', afterValue: '', rationale: '' }); message.success('变更包已保存为草稿'); await load();
  };
  const loadPackageLines = async (packageId: number) => { try { const lines = await getChangePackageLines(packageId); setPackageLines(current => ({ ...current, [packageId]: lines })); } catch (error: any) { message.error(`变更包明细加载失败：${String(error?.message || error).slice(0, 100)}`); } };
  const savePackageLine = async (line: any, patch: any) => { try { await updateChangePackageLine(line.id, patch); await loadPackageLines(line.package_id); message.success('变更包明细已保存'); } catch (error: any) { message.error(`变更包明细保存失败：${String(error?.message || error).slice(0, 100)}`); } };

  const previewTarget = async () => {
    if (!targetCost || targetCost <= 0) { message.warning('请输入财务整机标准成本目标'); return; }
    setBusy('target');
    try { setTargetPreview(await previewProjectTargetVersion(projectId, targetCost, platformFeeRate)); message.success('目标分解已生成预览，尚未写入数据库'); }
    catch (error: any) { message.error(`目标预览失败：${String(error?.message || error).slice(0, 120)}`); }
    finally { setBusy(''); }
  };
  const createTarget = async () => {
    if (!targetPreview) { message.warning('请先预览目标分解，确认领域分配和缺口后再冻结'); return; }
    if (targetPreview.missingCostRows?.length) { message.warning('当前 BOM 仍有价格/数量证据缺口，补齐后才能冻结目标版本'); return; }
    setBusy('target');
    try { const result = await createProjectTargetVersion(projectId, targetCost!, platformFeeRate, { bom: versions.find(row => row.status === 'frozen')?.id || 0, spec: 0 }); setTargetResult(result); setTargetPreview(null); message.success(`目标版本 v${result.versionNo} 已冻结`); onTargetsChanged?.(); await load(); }
    catch (error: any) { message.error(`目标分解失败：${String(error?.message || error).slice(0, 120)}`); }
    finally { setBusy(''); }
  };

  const layerRows = summary ? (Object.keys(layerLabels) as CostLayer[]).map(layer => ({ key: layer, layer, value: summary.layers[layer], incomplete: summary.missingCostRows?.some((row: any) => row.layer === layer) })) : [];
  const referenceProject = projects.find(row => row.id === referenceProjectId);
  const similarityFields = ['category', 'tier', 'screen_size', 'resolution', 'panel_type'];
  const similarity = referenceProject ? similarityFields.filter(field => String(referenceProject[field] || '') && String(referenceProject[field] || '') === String(project?.[field] || '')).length : 0;
  const charterRange = referenceSummary && summary ? (() => {
    const referenceCost = Number(referenceSummary.standardCost || 0);
    const currentCost = Number(summary.standardCost || 0);
    return { low: Math.min(referenceCost, currentCost), current: currentCost, high: referenceSummary.missingCostRows?.length || summary.missingCostRows?.length ? null : Math.max(referenceCost, currentCost) };
  })() : null;
  const charterDiffRows = referenceLines.length && summary?.rows?.length ? (() => {
    const totals = (rows: any[]) => rows.reduce((result: Record<string, { count: number; cost: number }>, row: any) => {
      const module = String(row.module_name || '未归类');
      const item = result[module] || { count: 0, cost: 0 };
      item.count += Number(row.quantity || 1);
      item.cost += Number(row.line_total || 0);
      result[module] = item;
      return result;
    }, {});
    const before = totals(referenceLines);
    const after = totals(summary.rows);
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].map(module => ({ module, referenceCount: before[module]?.count || 0, currentCount: after[module]?.count || 0, referenceCost: before[module]?.cost || 0, currentCost: after[module]?.cost || 0 })).filter(row => row.referenceCount !== row.currentCount || Math.abs(row.referenceCost - row.currentCost) > 0.0001);
  })() : [];
  const createCharterDiffPackage = async () => {
    const sourceVersion = referenceVersions.find(row => row.status === 'frozen');
    if (!sourceVersion || !charterDiffRows.length) { message.info('需要先选择含冻结 BOM 的参考项目，并存在可计算的模块差异'); return; }
    await createChangePackage({ projectId, title: `Charter 与参考 BOM 差异 · ${referenceProject?.name || ''}`, triggerType: 'architecture', sourceVersionId: sourceVersion.id, rationale: '由参考冻结 BOM 与当前可编辑 BOM 按模块规则生成；当前 BOM 已体现这组差异，不作为新的降本机会重复扣减。', lines: charterDiffRows.map(row => ({ action: 'change', moduleName: row.module, quantityBefore: row.referenceCount, quantityAfter: row.currentCount, costBefore: row.referenceCost, costAfter: row.currentCost, dependencyRole: 'required', evidence: { referenceVersionId: sourceVersion.id, baseline_included: true, opportunity_status: 'implemented' } })) });
    message.success('已按模块差异创建 Charter 变更包草稿');
    await load();
  };
  const targetData = targetPreview || targetResult;
  const askAIForCharter = () => {
    try { localStorage.setItem('costhub-ai-prompt-pending', JSON.stringify({ prompt: `请基于当前项目「${project?.name || ''}」和已选择的参考冻结 BOM，提出可核验的 Charter 依赖变更包建议。只建议模块/器件替换、增删及其依据，不直接写入 BOM；请标明缺失价格和需要我确认的地方。` })); } catch { }
    window.dispatchEvent(new Event('costhub-open-ai-prompt'));
  };
  return <div className="cost-planning-workspace">
      <div className="planning-flow-guide">
      <div><span className="eyebrow">成本策划工作流</span><h3>先锁定口径，再做目标与谈价</h3><p>产品规格用于可比，成本基线用于核算，机会用于假设，变更包记录改动，目标版本记录承诺。</p></div>
      <div className="planning-flow-steps"><Tag color="blue">1 产品规格</Tag><span>→</span><Tag color="cyan">2 成本基线</Tag><span>→</span><Tag color="gold">3 参考机会</Tag><span>→</span><Tag color="orange">4 变更包</Tag><span>→</span><Tag color="green">5 目标版本</Tag></div>
    </div>
    <Card size="small" title="① 产品规格" extra={<Button size="small" type="primary" icon={<SaveOutlined />} loading={busy === 'spec'} onClick={() => void saveSpecs()}>保存并冻结规格版本</Button>}>
      <div className="planning-spec-context"><strong>{project?.category || '未分类'}规格</strong><span>{project?.category === '手写笔' ? '填写笔尖尺寸、压感级别、延迟，不需要屏幕尺寸。' : project?.category === '鼠标' ? '填写传感器 DPI、重量、连接方式，不需要屏幕尺寸。' : project?.category === '显示器' ? '填写屏幕尺寸、分辨率、刷新率、面板类型和亮度。' : '按该品类维护可比较的关键规格；没有模板时可在“编辑项目”中填写关键规格。'}</span></div>
      {specRows.length ? <div className="planning-spec-grid">{specRows.map(row => <label key={row.id}><span>{row.field_label}{row.unit ? `（${row.unit}）` : ''}</span>{row.data_type === 'number' ? <InputNumber min={0} style={{ width: '100%' }} value={row.value_text === '' ? null : Number(row.value_text)} onChange={value => setSpecRows(rows => rows.map(item => item.id === row.id ? { ...item, value_text: value == null ? '' : String(value) } : item))} /> : <Input value={row.value_text} onChange={event => setSpecRows(rows => rows.map(item => item.id === row.id ? { ...item, value_text: event.target.value } : item))} />}</label>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该品类暂无规格模板" />}
      <div className="planning-note">保存后形成产品规格版本，用于报价轮次、项目参照和变化追溯。</div>
    </Card>

    <Card size="small" className="planning-parameters-card" title="成本参数（在此编辑）" extra={<Button size="small" type="primary" icon={<SaveOutlined />} loading={busy === 'rates'} onClick={() => void saveCostParams()}>保存成本参数</Button>}>
      <div className="planning-parameter-grid"><label><span>平台费率（%）</span><InputNumber min={0} max={100} precision={2} value={platformFeeRate} onChange={value => setPlatformFeeRate(Number(value || 0))} /></label><label><span>利润 / 管销研费率（%）</span><InputNumber min={0} max={100} precision={2} value={profitRate} onChange={value => setProfitRate(Number(value || 0))} /></label><div className="planning-parameter-help"><strong>怎么影响成本？</strong><span>平台费率计入标准成本；利润 / 管销研费率只保存为项目财务参数，不计入标准成本。</span></div></div>
    </Card>

    <div className="planning-two-col">
      <Card size="small" title="② 标准成本基线" extra={<Button size="small" icon={<HistoryOutlined />} loading={busy === 'bom'} onClick={() => void freezeBOM()}>冻结为成本基线</Button>}>
        <div className="planning-card-help"><strong>回答：这台产品现在按哪一版 BOM、哪套价格计算？</strong> 当前可编辑 BOM 先核对完整，再冻结成可追溯版本；以后改 BOM 只产生新版本，不覆盖旧口径。</div>
        <Table size="small" pagination={false} dataSource={layerRows} columns={[{ title: '成本层', dataIndex: 'layer', render: (v: CostLayer) => layerLabels[v] }, { title: '金额', dataIndex: 'value', align: 'right', render: (v: number, row: any) => row.incomplete ? '待补证据' : `¥${v.toFixed(2)}` }]} summary={() => <Table.Summary.Row><Table.Summary.Cell index={0}>可分解成本</Table.Summary.Cell><Table.Summary.Cell index={1} align="right">{summary?.standardCost == null ? '待补证据' : `¥${Number(summary.decomposable).toFixed(2)}`}</Table.Summary.Cell></Table.Summary.Row>} />
        <div className="planning-kpi-row"><span>平台费 {platformFeeRate.toFixed(2)}% × {summary?.standardCost == null ? '待补证据' : `¥${Number(summary.decomposable).toFixed(2)} = ¥${Number(summary.platformFee).toFixed(2)}`}</span><strong>标准成本 {summary?.standardCost == null ? '待补证据' : `¥${Number(summary.standardCost).toFixed(2)}`}</strong></div>
        {summary?.missingCostRows?.length > 0 && <Alert type="warning" showIcon message={`有 ${summary.missingCostRows.length} 行未定价，当前标准成本是不完整口径`} description={summary.missingCostRows.slice(0, 4).map((row: any) => `${row.module || '未归类'} / ${row.name || '未命名'} ${row.model || ''}`).join('；')} style={{ marginTop: 10 }} />}
        {versions.length ? <div className="planning-version-list">{versions.slice(0, 4).map(version => <Tag key={version.id} color={version.status === 'frozen' ? 'blue' : 'default'}>v{version.version_no} · {version.version_name || 'BOM'} · {statusLabels[version.status] || version.status}</Tag>)}</div> : <div className="planning-note">尚未冻结版本；编辑当前 BOM 不会改写历史版本。</div>}
      </Card>
      <Card size="small" title="③ 参考基线与降本机会" extra={<Button size="small" icon={<PlusOutlined />} onClick={() => void addBaselineCandidates()}>从当前 BOM 生成候选</Button>}>
        <div className="planning-card-help"><strong>回答：每个模块合理应该是多少？</strong> 候选值先改成有历史报价或供应商依据的合理低位，再确认；确认后才会进入目标成本分解，未确认不会影响当前 BOM。</div>
        {baselines.length ? <Table size="small" pagination={{ pageSize: 5, hideOnSinglePage: true }} dataSource={baselines} rowKey="id" columns={[{ title: '范围', dataIndex: 'category', ellipsis: true }, { title: '合理基线', dataIndex: 'value', align: 'right', render: (v: number, row: any) => <InputNumber size="small" min={0} precision={2} defaultValue={Number(v || 0)} onBlur={async event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0 && value !== Number(v || 0)) { await updateBaselineDecision(row.id, value, '用户调整合理基线'); await load(); } }} /> }, { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'confirmed' ? 'green' : 'orange'}>{statusLabels[v] || v}</Tag> }, { title: '操作', render: (_: any, row: any) => row.status === 'candidate' ? <Button type="link" size="small" icon={<CheckCircleOutlined />} onClick={async () => { await setBaselineDecisionStatus(row.id, 'confirmed', '用户在成本策划中确认合理基线'); await load(); }}>确认并进入目标</Button> : null }]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无候选基线" />}
        <div className="planning-note">机会金额 = 当前成本 − 已确认合理基线；它是目标分解的可用空间，不等于已经实现的节省。</div>
      </Card>
    </div>

    <Card className="planning-charter-card" size="small" title="④ 变更包与 Charter 参考" extra={<Space><Select allowClear placeholder="选择已冻结参考项目" value={referenceProjectId} onChange={async value => { const next = Number(value || 0) || undefined; setReferenceProjectId(next); try { await setProjectReference(projectId, next || 0); await onProjectChanged?.(); } catch (error: any) { message.error(`参考项目保存失败：${String(error?.message || error).slice(0, 100)}`); } }} options={projects.filter(row => row.id !== projectId).map(row => ({ value: row.id, label: `[${row.code}] ${row.name}` }))} style={{ width: 190 }} /><Button size="small" onClick={askAIForCharter}>AI 建议（只读）</Button><Button size="small" onClick={() => void createCharterDiffPackage()} disabled={!charterDiffRows.length}>生成参考差异</Button><Button size="small" onClick={() => void freezeBOM('charter_estimate')}>冻结当前 Charter 方案</Button></Space>}>
      <div className="planning-card-help"><strong>变更包不是直接改 BOM。</strong> 它把规格、架构或供应商变化的前后值、依赖和依据打包留痕；“确认”只改变状态。执行后由工程/供应链更新当前 BOM，再冻结新的 BOM 版本。</div>
      {referenceProject && <Alert type="info" showIcon message={<Space size={6}><span>参考项目：{referenceProject.code} {referenceProject.name}</span><Tag color={similarity >= 3 ? 'green' : 'gold'}>规格相似度 {similarity}/{similarityFields.length}</Tag>{referenceSummary && <span>可分解成本 ¥{Number(referenceSummary.decomposable || 0).toFixed(2)}</span>}</Space>} description={<span>{referenceVersions.length ? `最近冻结版本 v${referenceVersions[0].version_no}；` : '该项目尚未冻结 BOM 版本；'}当前项目相对参考的规则成本桥 {referenceSummary && summary ? `${Number(summary.decomposable - referenceSummary.decomposable) >= 0 ? '+' : ''}¥${Number(summary.decomposable - referenceSummary.decomposable).toFixed(2)}` : '待补齐'}；仅作 Charter 估算依据，不会覆盖当前项目价格。</span>} style={{ marginBottom: 12 }} />}
      {charterRange ? <div className="planning-charter-brief"><div className="planning-charter-range"><div><span>低位</span><strong>¥{charterRange.low.toFixed(2)}</strong></div><div><span>当前判断</span><strong>¥{charterRange.current.toFixed(2)}</strong></div><div><span>高位</span><strong>{charterRange.high == null ? '待补证据' : `¥${charterRange.high.toFixed(2)}`}</strong></div></div><div className="planning-note">区间由参考项目冻结 BOM 与当前标准成本两个可追溯锚点生成；存在未定价行时不填 0。</div></div> : referenceProject && <Alert type="warning" showIcon message="Charter 区间暂不可生成" description="请先选择含冻结 BOM 的参考项目，并补齐参考或当前 BOM 的价格证据。" style={{ marginBottom: 12 }} />}
      {project?.charter_assumptions && <div className="planning-note planning-charter-assumptions">主要假设：{project.charter_assumptions}</div>}
      {referenceLines.length > 0 && <><div className="planning-note">参考冻结 BOM（{referenceVersions.find(row => row.status === 'frozen')?.version_name || '最近冻结版本'}）</div><Table size="small" pagination={{ pageSize: 5, hideOnSinglePage: true }} dataSource={referenceLines} rowKey="id" columns={[{ title: '模块', dataIndex: 'module_name' }, { title: '器件', dataIndex: 'part_name' }, { title: '型号', dataIndex: 'part_model' }, { title: '数量', dataIndex: 'quantity', align: 'right' }, { title: '金额', dataIndex: 'line_total', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }]} style={{ marginBottom: 12 }} /></>}
      {charterDiffRows.length > 0 && <><div className="planning-note">模块差异（规则依据，不直接改价）</div><Table size="small" pagination={false} dataSource={charterDiffRows} rowKey="module" columns={[{ title: '模块', dataIndex: 'module' }, { title: '参考数量', dataIndex: 'referenceCount', align: 'right' }, { title: '当前数量', dataIndex: 'currentCount', align: 'right' }, { title: '参考金额', dataIndex: 'referenceCost', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }, { title: '当前金额', dataIndex: 'currentCost', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }, { title: '成本桥', render: (_: any, row: any) => `¥${(row.currentCost - row.referenceCost).toFixed(2)}` }]} style={{ marginBottom: 12 }} /></>}
      <div className="planning-change-form"><Input placeholder="标题：如替换显示面板" value={packageDraft.title} onChange={e => setPackageDraft({ ...packageDraft, title: e.target.value })} /><Select value={packageDraft.triggerType} onChange={triggerType => setPackageDraft({ ...packageDraft, triggerType })} options={[['spec', '规格变化'], ['architecture', '架构变化'], ['supplier', '供应商变化'], ['cost_down', '降本变化'], ['other', '其他']].map(([value, label]) => ({ value, label }))} /><Input placeholder="变更前：当前方案" value={packageDraft.beforeValue} onChange={e => setPackageDraft({ ...packageDraft, beforeValue: e.target.value })} /><Input placeholder="变更后：目标方案" value={packageDraft.afterValue} onChange={e => setPackageDraft({ ...packageDraft, afterValue: e.target.value })} /><Input placeholder="依据：报价/规格/评审结论" value={packageDraft.rationale} onChange={e => setPackageDraft({ ...packageDraft, rationale: e.target.value })} /><Button type="primary" icon={<PlusOutlined />} onClick={() => void addPackage()}>保存草稿</Button></div>
      {packages.length ? <Table size="small" pagination={false} dataSource={packages} rowKey="id" expandable={{ onExpand: (expanded, row) => { if (expanded) void loadPackageLines(row.id); }, expandedRowRender: row => <Table size="small" pagination={false} rowKey="id" dataSource={packageLines[row.id] || []} locale={{ emptyText: '暂无变更行；可从参考差异生成，或先保存草稿后补行' }} columns={[{ title: '模块', dataIndex: 'module_name' }, { title: '动作', dataIndex: 'action' }, { title: '数量前', dataIndex: 'quantity_before', render: (v: number, line: any) => row.status === 'draft' ? <InputNumber size="small" min={0} value={Number(v || 0)} onChange={value => void savePackageLine(line, { quantityBefore: Number(value || 0) })} /> : v }, { title: '数量后', dataIndex: 'quantity_after', render: (v: number, line: any) => row.status === 'draft' ? <InputNumber size="small" min={0} value={Number(v || 0)} onChange={value => void savePackageLine(line, { quantityAfter: Number(value || 0) })} /> : v }, { title: '金额前', dataIndex: 'cost_before', render: (v: number, line: any) => row.status === 'draft' ? <InputNumber size="small" min={0} precision={4} value={Number(v || 0)} onChange={value => void savePackageLine(line, { costBefore: Number(value || 0) })} /> : `¥${Number(v || 0).toFixed(2)}` }, { title: '金额后', dataIndex: 'cost_after', render: (v: number, line: any) => row.status === 'draft' ? <InputNumber size="small" min={0} precision={4} value={Number(v || 0)} onChange={value => void savePackageLine(line, { costAfter: Number(value || 0) })} /> : `¥${Number(v || 0).toFixed(2)}` }, { title: '依赖', dataIndex: 'dependency_role', render: (v: string, line: any) => row.status === 'draft' ? <Select size="small" value={v || 'optional'} options={['required', 'optional', 'conditional'].map(value => ({ value, label: value }))} onChange={value => void savePackageLine(line, { dependencyRole: value })} /> : v }, { title: '依据', render: (_: any, line: any) => { let hasEvidence = false; try { hasEvidence = Object.keys(JSON.parse(line.evidence_json || '{}') || {}).length > 0; } catch { } return <Tag color={hasEvidence ? 'green' : 'orange'}>{hasEvidence ? '有依据' : '待补依据'}</Tag>; } }]} /> }} columns={[{ title: '变更包', dataIndex: 'title' }, { title: '触发', dataIndex: 'trigger_type' }, { title: '变化', render: (_: any, row: any) => `${row.before_value || '—'} → ${row.after_value || '—'}` }, { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'confirmed' ? 'green' : 'orange'}>{statusLabels[v] || v}</Tag> }, { title: '操作', render: (_: any, row: any) => row.status === 'draft' ? <Button type="link" size="small" onClick={async () => { await setChangePackageStatus(row.id, 'confirmed'); await load(); }}>确认记录</Button> : ['confirmed', 'feasibility_confirmed', 'selected'].includes(row.status) ? <Button type="link" size="small" disabled={!versions.some(v => v.status === 'frozen')} onClick={async () => { try { const frozen = versions.find(v => v.status === 'frozen'); if (!frozen) return; await markChangePackageImplemented(row.id, frozen.id, { source: '成本策划' }); message.success('变更包已关联冻结 BOM 并标记实施'); await load(); } catch (error: any) { message.error('实施登记失败：' + String(error?.message || error).slice(0, 100)); } }}>标记实施</Button> : null }]} /> : <div className="planning-note">变更包记录事实与依赖；确认后仍需人工执行 BOM 变更，再冻结新版本。</div>}
    </Card>

    <Card size="small" title="⑤ 目标成本版本" extra={<Space><InputNumber min={0} precision={2} placeholder="财务整机目标" value={targetCost} onChange={value => { setTargetCost(value); setTargetPreview(null); }} /><Button loading={busy === 'target'} onClick={() => void previewTarget()}>预览分解</Button><Button type="primary" disabled={!targetPreview} loading={busy === 'target'} onClick={() => void createTarget()}>确认并冻结</Button></Space>}>
      <div className="planning-card-help"><strong>输入财务允许的整机目标，再分解并冻结。</strong> 系统会按领域分配目标、扣除已确认机会并显示挑战缺口；目标版本是管理记录，不是报价价，也不会自动改写 BOM。</div>
      {targetData && <Alert type={targetData.uncoveredGap > 0 || targetData.missingCostRows?.length ? 'warning' : 'success'} showIcon message={targetPreview ? '目标分解预览（尚未写入）' : targetData.uncoveredGap > 0 ? `目标不可行，仍缺 ¥${targetData.uncoveredGap.toFixed(2)} 依据` : targetData.missingCostRows?.length ? '目标已冻结，但仍有未定价行需补证据' : '目标已由确认机会覆盖'} description={`可分解目标 ¥${targetData.decomposableTarget.toFixed(2)} · 调整后基线 ¥${targetData.baselineCost.toFixed(2)} · 挑战缺口 ¥${targetData.challengeGap.toFixed(2)} · 已确认机会 ¥${targetData.confirmedOpportunity.toFixed(2)}${targetData.missingCostRows?.length ? ` · 未定价 ${targetData.missingCostRows.length} 行` : ''}`} />}
      {targetData?.rows?.length ? <Table size="small" pagination={false} rowKey="domain" dataSource={targetData.rows} columns={[{ title: '领域', dataIndex: 'domain' }, { title: '当前成本', dataIndex: 'current', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }, { title: '调整后基线', dataIndex: 'baseline', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }, { title: '已确认机会', dataIndex: 'opportunity', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }, { title: '分配挑战', dataIndex: 'allocated', align: 'right', render: (v: number) => `¥${Number(v || 0).toFixed(2)}` }, { title: '领域目标', dataIndex: 'target', align: 'right', render: (v: number) => <strong>¥{Number(v || 0).toFixed(2)}</strong> }]} style={{ marginTop: 12 }} /> : null}
      {targetVersions.length ? <div className="planning-note"><TagsOutlined /> 最近冻结目标版本 v{targetVersions[0].version_no}：整机 ¥{Number(targetVersions[0].target_cost || 0).toFixed(2)}，基线 ¥{Number(targetVersions[0].baseline_cost || 0).toFixed(2)}，缺口 ¥{Number(targetVersions[0].challenge_gap || 0).toFixed(2)}</div> : <div className="planning-note">目标版本会保留历史，不静默覆盖旧分解；当前确认机会不足时明确显示未覆盖缺口。</div>}
    </Card>
    <Collapse className="planning-advanced-sections" defaultActiveKey={['cost-wall']} items={[
      { key: 'tradeoff', label: '可选工具 · 价值权衡（用户价值 × 成本）', children: <ValueTradeoffPanel product={project?.name || ''} projectId={projectId} /> },
      { key: 'cost-wall', label: '成本长城 · 维度与支撑模块', children: <CostWallPanel projectId={projectId} project={project} boms={summary?.rows || []} /> },
    ]} />
  </div>;
}
