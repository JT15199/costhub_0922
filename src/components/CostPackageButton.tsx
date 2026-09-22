import { useState } from 'react';
import { Alert, Button, Modal, Select, Space, Tag, message } from 'antd';
import { FileTextOutlined, DownloadOutlined } from '@ant-design/icons';
import {
  getProjectBOMVersionLines, getProjectBOMVersions, getProjectBOMs, getProjectSpecProfile, getLatestProjectSpecBaseline,
  getProjectTargetVersions, getProjects, getTargets, getMeasures, getCostReviews, getProjectCostSnapshots, getTenderDecision, getTenderOverview,
  saveAnalysisArtifact, getSkus, getAllSkuDiffs, getChangePackages,
  getSetting,
} from '../db';
import { bomExtendedCostStrict, bomPriceState, bomQuantityState } from '../ai/contracts';

interface CostPackageButtonProps { project: any; boms: any[]; targets: any[]; measures: any[]; reviews: any[]; snapshots: any[]; }
type Format = 'html' | 'pptx';
type Snapshot = { slides: { heading: string; points: string[] }[]; bomCost: number | null; dataFingerprint: string; sourceVersionIds: Record<string, number>; source: Record<string, any>; warnings: string[] };

const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const text = (value: unknown) => String(value ?? '').trim();
const money = (value: unknown) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '待补证据' : `¥${Number(value).toFixed(2)}`;
export const lineTotal = (row: any): number | null => row?.__frozen && row.line_total !== null && row.line_total !== undefined && Number.isFinite(Number(row.line_total)) && Number(row.line_total) >= 0 ? num(row.line_total) : bomExtendedCostStrict(row);
const frozenLinePriceState = (row: any) => row?.__frozen && row.line_total !== null && row.line_total !== undefined && Number.isFinite(Number(row.line_total)) && Number(row.line_total) >= 0 ? 'confirmed' : 'unknown';
const valueMap = (rows: any[]) => new Map(rows.map(row => [text(row.field_key), text(row.value_text)]));
const fingerprint = (value: unknown) => { let hash = 2166136261; for (const ch of JSON.stringify(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); };
const bomFingerprint = (rows: any[]) => {
  let hash = 2166136261;
  const value = rows.map(row => ({ id: row.id, part: row.part_id, module: row.module_name, quantity: row.quantity, cost: row.part_cost ?? row.unit_cost ?? 0, priceState: row.price_state || 'unknown', layer: row.cost_layer || 'material' }));
  for (const ch of JSON.stringify(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

function bomRowsForDraft(rows: any[]) { return rows.map(row => ({ ...row, __frozen: false, line_total: lineTotal({ ...row, __frozen: false }), relation_key: `${text(row.part_name)}|${text(row.part_model)}|${text(row.part_specs || row.specs)}` })); }

export async function loadSnapshot(project: any, _fallbackBoms: any[], _fallbackTargets: any[], _measures: any[], _reviews: any[], _snapshots: any[] = []): Promise<Snapshot> {
  const projectId = num(project?.id);
  const read = async <T,>(reader: () => Promise<T>, fallback: T) => { try { return { ok: true, value: await reader() }; } catch { return { ok: false, value: fallback }; } };
  const skuReader = typeof getSkus === 'function' ? () => getSkus(projectId) : async () => [] as any[];
  const changePackageReader = typeof getChangePackages === 'function' ? () => getChangePackages(projectId) : async () => [] as any[];
  const [allProjectsRead, versionsRead, targetVersionsRead, currentBomsRead, targetRowsRead, freshMeasuresRead, freshReviewsRead, freshSnapshotsRead, tenderOverviewRead, tenderDecisionRead, liveSkusRead, changePackagesRead] = await Promise.all([
    read(() => getProjects(), []), read(() => getProjectBOMVersions(projectId), []), read(() => getProjectTargetVersions(projectId), []),
    read(() => getProjectBOMs(projectId), []), read(() => getTargets(projectId), []),
    read(() => getMeasures(projectId), []), read(() => getCostReviews(projectId), []), read(() => getProjectCostSnapshots(projectId), []),
    read(() => getTenderOverview(projectId), null), read(() => getTenderDecision(projectId), null), read(skuReader, []), read(changePackageReader, []),
  ]);
  const sourceWarnings: string[] = [];
  if (!allProjectsRead.ok) sourceWarnings.push('项目关系读取失败，未使用旧页面缓存。');
  if (!versionsRead.ok) sourceWarnings.push('BOM 版本读取失败。');
  if (!targetVersionsRead.ok) sourceWarnings.push('目标版本读取失败。');
  if (!currentBomsRead.ok) sourceWarnings.push('当前 BOM 读取失败，未使用旧页面缓存。');
  if (!targetRowsRead.ok) sourceWarnings.push('目标领域明细读取失败。');
  if (!freshMeasuresRead.ok) sourceWarnings.push('降本措施读取失败，未使用旧页面缓存。');
  if (!freshReviewsRead.ok) sourceWarnings.push('阶段评审读取失败，未使用旧页面缓存。');
  if (!freshSnapshotsRead.ok) sourceWarnings.push('成本快照读取失败，未使用旧页面缓存。');
  if (!liveSkusRead.ok) sourceWarnings.push('SKU 读取失败，未使用旧页面缓存。');
  if (!changePackagesRead.ok) sourceWarnings.push('变更包读取失败，未使用旧页面缓存。');
  const allProjects = allProjectsRead.value; const versions = versionsRead.value; const targetVersions = targetVersionsRead.value;
  const currentBoms = currentBomsRead.value; const targetRows = targetRowsRead.value;
  const freshMeasures = freshMeasuresRead.value; const freshReviews = freshReviewsRead.value; const freshSnapshots = freshSnapshotsRead.value;
  const tenderOverview = tenderOverviewRead.value; const tenderDecision = tenderDecisionRead.value;
  const liveSkus = liveSkusRead.value;
  const changePackages = changePackagesRead.value;
  const diffReader = typeof getAllSkuDiffs === 'function' ? () => getAllSkuDiffs(liveSkus.map((row: any) => num(row.id))) : async () => ({}) as Record<number, any[]>;
  const liveSkuDiffsRead = await read(diffReader, {} as Record<number, any[]>);
  if (!liveSkuDiffsRead.ok) sourceWarnings.push('SKU 差异读取失败，未使用旧页面缓存。');
  const liveSkuSnapshot = liveSkus.map((sku: any) => ({ ...sku, diffs: liveSkuDiffsRead.value[Number(sku.id)] || [] }));
  const currentDraft = bomRowsForDraft(currentBoms);
  const frozen = versions.find(row => row.status === 'frozen');
  const frozenMatchesDraft = Boolean(currentBomsRead.ok && frozen && text(frozen.data_fingerprint) === bomFingerprint(currentDraft));
  const frozenLinesRead = frozenMatchesDraft ? await read(() => getProjectBOMVersionLines(num(frozen.id)), []) : { ok: true, value: currentDraft };
  if (frozenMatchesDraft && !frozenLinesRead.ok) sourceWarnings.push('冻结 BOM 明细读取失败，正文改用当前草稿并明确标注。');
  const currentIsFrozen = Boolean(frozenMatchesDraft && frozenLinesRead.ok);
  const currentLines = currentIsFrozen ? frozenLinesRead.value.map(row => ({ ...row, __frozen: true })) : currentDraft;
  const frozenSkuSnapshot = (() => { try { const value = JSON.parse(String(frozen?.sku_snapshot_json || '')); return Array.isArray(value) ? value : null; } catch { return null; } })();
  const skuSnapshot = currentIsFrozen ? (frozenSkuSnapshot || []) : liveSkuSnapshot;
  if (currentIsFrozen && !frozenSkuSnapshot) sourceWarnings.push('冻结 BOM 没有 SKU 快照，历史包不使用当前 SKU 数据补造。');
  const sourceProject = allProjects.find(row => num(row.id) === projectId) || project;
  const reference = allProjects.find(row => num(row.id) === num(project?.reference_project_id));
  const referenceVersionsRead = reference ? await read(() => getProjectBOMVersions(num(reference.id)), []) : { ok: true, value: [] as any[] };
  if (reference && !referenceVersionsRead.ok) sourceWarnings.push('参考项目 BOM 版本读取失败。');
  const referenceVersions = referenceVersionsRead.value;
  const previous = reference ? referenceVersions.find(row => row.status === 'frozen') : versions.find(row => row.status === 'superseded');
  const previousLinesRead = previous ? await read(() => getProjectBOMVersionLines(num(previous.id)), []) : { ok: true, value: [] as any[] };
  if (previous && !previousLinesRead.ok) sourceWarnings.push('上代冻结 BOM 明细读取失败。');
  const previousLines = previousLinesRead.value.map(row => ({ ...row, __frozen: true }));
  const [currentSpecsRead, previousSpecsRead, currentSpecBaselineRead, previousSpecBaselineRead] = await Promise.all([
    read(() => getProjectSpecProfile(projectId, project?.category || '显示器'), []),
    reference ? read(() => getProjectSpecProfile(num(reference.id), reference.category || project?.category || '显示器'), []) : Promise.resolve({ ok: true, value: [] as any[] }),
    read(() => getLatestProjectSpecBaseline(projectId), null),
    reference ? read(() => getLatestProjectSpecBaseline(num(reference.id)), null) : Promise.resolve({ ok: true, value: null as any }),
  ]);
  if (!currentSpecsRead.ok) sourceWarnings.push('当前规格读取失败。');
  if (reference && !previousSpecsRead.ok) sourceWarnings.push('参考项目规格读取失败。');
  if (!currentSpecBaselineRead.ok) sourceWarnings.push('当前规格版本读取失败。');
  if (reference && !previousSpecBaselineRead.ok) sourceWarnings.push('参考项目规格版本读取失败。');
  const baselineValues = (row: any) => { try { const parsed = JSON.parse(String(row?.spec_json || '{}')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } };
  const applyBaseline = (profile: any[], baseline: any) => { const values = baselineValues(baseline); return profile.map(field => ({ ...field, value_text: Object.prototype.hasOwnProperty.call(values, field.field_key) ? text(values[field.field_key]) : '' })); };
  const frozenSpec = (version: any) => {
    try {
      const snapshot = JSON.parse(String(version?.project_snapshot_json || '{}'));
      const values = snapshot?.spec_json;
      return values && typeof values === 'object' && Object.keys(values).length
        ? { id: num(version?.spec_baseline_id || snapshot.spec_baseline_id), spec_json: JSON.stringify(values) }
        : null;
    } catch { return null; }
  };
  const currentFrozenSpec = currentIsFrozen ? frozenSpec(frozen) : null;
  const previousFrozenSpec = previous ? frozenSpec(previous) : null;
  const currentSpecs = currentIsFrozen
    ? (currentFrozenSpec ? applyBaseline(currentSpecsRead.value, currentFrozenSpec) : [])
    : (currentSpecBaselineRead.value ? applyBaseline(currentSpecsRead.value, currentSpecBaselineRead.value) : currentSpecsRead.value);
  const previousSpecs = previous
    ? (previousFrozenSpec ? applyBaseline(previousSpecsRead.value, previousFrozenSpec) : [])
    : [];
  if (currentIsFrozen && !currentFrozenSpec) sourceWarnings.push('冻结 BOM 没有规格快照，未使用当前最新规格补造。');
  if (previous && !previousFrozenSpec) sourceWarnings.push('上代冻结 BOM 没有规格快照，未使用当前最新规格补造。');
  const currentSpecMap = valueMap(currentSpecs); const previousSpecMap = valueMap(previousSpecs);
  const specChanges = reference && previousSpecs.length ? currentSpecs.map(field => ({ label: text(field.field_label || field.field_key), before: previousSpecMap.get(text(field.field_key)) || '—', after: currentSpecMap.get(text(field.field_key)) || '—' })).filter(row => row.before !== row.after) : [];
  const bridgeMap = new Map<string, { name: string; before: number; after: number }>();
  for (const row of previousLines) { const value = lineTotal(row); if (value === null) continue; const key = text(row.relation_key || `${row.part_name}|${row.part_model}|${row.specs}`); const item = bridgeMap.get(key) || { name: text(row.part_name) || '未命名器件', before: 0, after: 0 }; item.before += value; bridgeMap.set(key, item); }
  for (const row of currentLines) { const value = lineTotal(row); if (value === null) continue; const key = text(row.relation_key || `${row.part_name}|${row.part_model}|${row.specs}`); const item = bridgeMap.get(key) || { name: text(row.part_name) || '未命名器件', before: 0, after: 0 }; item.after += value; bridgeMap.set(key, item); }
  const bridge = [...bridgeMap.values()].map(row => ({ ...row, delta: row.after - row.before })).filter(row => Math.abs(row.delta) > 0.005).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const missingCurrent = currentLines.length === 0 ? [{ id: 0, name: '当前 BOM', reason: 'empty' }] : currentLines.filter(row => (row.__frozen ? frozenLinePriceState(row) : bomPriceState(row)) !== 'confirmed' || bomQuantityState(row) !== 'confirmed');
  const currentCost = missingCurrent.length ? null : currentLines.reduce((sum, row) => sum + (lineTotal(row) ?? 0), 0);
  const feeRate = currentIsFrozen ? num(frozen?.platform_fee_rate, num(sourceProject?.platform_fee_rate)) : num(sourceProject?.platform_fee_rate);
  const standardCost = currentCost == null ? null : currentCost * (1 + feeRate / 100);
  const warnings = [
    ...sourceWarnings,
    !currentIsFrozen && '当前 BOM 在冻结版本后发生变化，正文引用当前草稿，不标记为冻结版。',
    missingCurrent.length > 0 && `当前来源存在 ${missingCurrent.length} 行价格/数量证据缺口。`,
    !previous && '未找到上代冻结 BOM，成本桥仅显示当前方案。',
    !targetVersions[0] && '未找到冻结目标版本。',
  ].filter(Boolean) as string[];
  const sourceVersionIds = { bom: currentIsFrozen ? num(frozen.id) : 0, previousBom: num(previous?.id), target: num(targetVersions[0]?.id), spec: currentIsFrozen ? num(currentFrozenSpec?.id) : num(currentSpecBaselineRead.value?.id), previousSpec: num(previousFrozenSpec?.id) };
  const packageRefs = changePackages.map((row: any) => ({ id: num(row.id), status: text(row.status) || 'draft', sourceVersionId: num(row.source_version_id), implementedVersionId: num(row.implemented_version_id) }));
  const dataFingerprint = fingerprint({ projectId, boms: currentBomsRead.value, targets: targetRows, measures: freshMeasures, reviews: freshReviews, snapshots: freshSnapshots, specs: currentSpecs, skuSnapshot, packageRefs, feeRate, tenderOverview, tenderDecision });
  const source = { projectId, stage: text(sourceProject?.stage) || '未设置', bomVersionId: sourceVersionIds.bom, previousBomVersionId: sourceVersionIds.previousBom, targetVersionId: sourceVersionIds.target, specBaselineId: sourceVersionIds.spec, previousSpecBaselineId: sourceVersionIds.previousSpec, bomState: currentIsFrozen ? 'frozen' : 'draft', costStatus: missingCurrent.length ? 'unknown' : 'confirmed', feeRate, currentLineCount: currentLines.length, previousLineCount: previousLines.length, targetCount: targetRows.length, skuSnapshot, skuSnapshotMode: currentIsFrozen ? 'frozen' : 'draft', changePackageRefs: packageRefs };
  const slides = [
    { heading: '项目定位与本次结论', points: [`${text(sourceProject?.code) || '项目'} · ${text(sourceProject?.name) || '未命名项目'}`, `品类 ${text(sourceProject?.category) || '未分类'} · ${text(sourceProject?.tier) || '—'} · 阶段 ${text(sourceProject?.stage) || '未设置'}`, `当前可分解成本 ${money(currentCost)}，标准成本（含平台费 ${feeRate.toFixed(2)}%）${money(standardCost)}`, `本次正文来源：${currentIsFrozen ? `冻结 BOM v${frozen.version_no}` : '当前 BOM 草稿'}`] },
    { heading: '上代与当前方案', points: [reference ? `上代项目：${text(reference.code) || reference.name}` : '未设置上代/参考项目', `当前 BOM：${currentLines.length} 行；上代 BOM：${previousLines.length} 行`, currentSpecsRead.value.length && reference && !previousSpecs.length ? '规格对比：缺少与上代 BOM 同版的规格冻结记录，未判定变化' : specChanges.length ? `规格变化：${specChanges.slice(0, 8).map(row => `${row.label} ${row.before} → ${row.after}`).join('；')}` : '未发现已记录的规格变化', bridge.length ? `成本桥净变化：${money(bridge.reduce((sum, row) => sum + row.delta, 0))}` : '未发现可比成本变化'] },
    { heading: '成本桥（上代 → 当前）', points: bridge.length ? bridge.slice(0, 12).map(row => `${row.name}：${money(row.before)} → ${money(row.after)}（${row.delta >= 0 ? '+' : ''}${money(row.delta)}）`) : ['暂无上代冻结 BOM 或可比器件变化'] },
    { heading: '目标成本与领域达成', points: targetRows.length ? targetRows.map(row => { const actual = currentCost == null ? null : currentLines.filter(line => text(line.main_category) === text(row.domain)).reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0); return `${text(row.domain) || '其他'}：实际 ${money(actual)} · 基线 ${money(row.baseline_cost ?? 0)} · 目标 ${money(row.target_cost)} · 差额 ${actual == null ? '待补证据' : money(actual - num(row.target_cost))} · 已确认机会 ${money(row.opportunity_amount ?? 0)} · 分配挑战 ${money(row.allocated_challenge ?? 0)}`; }) : ['暂无目标成本版本数据'] },
    { heading: 'SKU 与阶段交付', points: skuSnapshot.length ? skuSnapshot.map((sku: any) => `${text(sku.sku_code) || '未命名 SKU'}：${text(sku.sku_name) || '—'} · 差异 ${Array.isArray(sku.diffs) ? sku.diffs.length : 0} 条 · ${currentIsFrozen ? '随冻结版本固定' : '当前草稿引用'}`) : ['未选择 SKU，成本包仅包含项目主 BOM。'] },
    { heading: '变更包引用', points: packageRefs.length ? packageRefs.slice(0, 12).map(row => `变更包 #${row.id} · ${row.status} · 来源 BOM v${row.sourceVersionId || '—'} · 实施结果 v${row.implementedVersionId || '—'}`) : ['暂无已记录变更包。'] },
    { heading: '供应商报价与定点', points: tenderOverview ? [`报价轮次 ${tenderOverview.rounds?.length || 0} 轮 · 当前第 ${tenderOverview.currentRound?.roundNo || '—'} 轮`, `供应商 ${tenderOverview.summary?.supplierCount || 0} 家 · 可比覆盖 ${Math.round(num(tenderOverview.summary?.comparableCoverage) * 100)}% · 理论组合底价 ${money(tenderOverview.summary?.theoreticalLow)}`, `定点：${text(tenderDecision?.selectedSupplier) || '待定'} · ${tenderDecision?.status === 'selected' ? '已定点' : '未定点'} · 最终报价 ${money(tenderDecision?.finalQuote)}`] : ['暂无报价批次'] },
    { heading: '后续措施与阶段复盘', points: [...(freshMeasures.length ? freshMeasures.slice(0, 8).map(row => `${text(row.measure) || text(row.title) || '措施'} · ${text(row.status) || '待执行'} · 负责人 ${text(row.owner) || '未指定'} · 预计节省 ${money(row.forecast_saving)}`) : ['暂无降本措施']), ...(freshReviews.length ? freshReviews.slice(0, 6).map(row => `${text(row.stage) || '阶段'}：${money(row.reviewed_cost)} · ${text(row.remark) || '无备注'}`) : [])] },
    { heading: '来源、假设与缺口', points: [`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, `来源版本：BOM ${sourceVersionIds.bom ? `v${frozen.version_no}` : '草稿'} · 上代 ${sourceVersionIds.previousBom ? `v${previous.version_no}` : '无'} · 目标 ${sourceVersionIds.target ? `v${targetVersions[0].version_no}` : '无'}`, ...(warnings.length ? warnings : ['未发现导出阻断项']), '导出前会重新读取数据库；成果库保存来源版本与指纹。'] },
  ];
  return { slides, bomCost: currentCost, dataFingerprint, sourceVersionIds, source: { ...source, bridgeCount: bridge.length, specChangeCount: specChanges.length, measureCount: freshMeasures.length, reviewCount: freshReviews.length }, warnings };
}

export default function CostPackageButton({ project, boms, targets, measures, reviews, snapshots: _snapshots }: CostPackageButtonProps) {
  const [open, setOpen] = useState(false); const [format, setFormat] = useState<Format>('html'); const [busy, setBusy] = useState(false); const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => { const fresh = await loadSnapshot(project, boms, targets, measures, reviews, _snapshots); setSnapshot(fresh); return fresh; };
  const generate = async () => { setBusy(true); try {
    const fresh = await refresh(); const { buildHtmlReportBase64, buildPptxBase64 } = await import('../aiReport'); const title = `${text(project?.code) || '项目'} 阶段成本包`; const subtitle = `${text(project?.name)} · ${text(project?.category) || '未分类'}`;
    const base64 = format === 'html' ? buildHtmlReportBase64(title, fresh.slides, subtitle) : await buildPptxBase64(title, fresh.slides, subtitle); const safe = title.replace(/[\\/:*?"<>|]/g, '_'); const fileName = `${safe}-${new Date().toISOString().slice(0, 10)}.${format}`;
    await (await import('@tauri-apps/api/core')).invoke('save_export_file', { fileName, base64Data: base64, targetDir: (await getSetting('ai_work_folder', '')).trim() || undefined });
    const artifactId = await saveAnalysisArtifact({ type: 'phase_cost_package', title, summary: `阶段成本包 · ${money(fresh.bomCost)}`, data: { projectId: project?.id || 0, slides: fresh.slides, generatedAt: new Date().toISOString() }, dataFingerprint: fresh.dataFingerprint, sourceVersionIds: fresh.sourceVersionIds, source: fresh.source });
    window.dispatchEvent(new Event('costhub-analysis-artifact-saved')); message.success(`成本包已生成：${fileName}（成果 #${artifactId}）`); setOpen(false);
  } catch (error: any) { message.error(`成本包生成失败：${String(error?.message || error).slice(0, 160)}`); } finally { setBusy(false); } };
  const show = async () => { setOpen(true); setBusy(true); try { await refresh(); } catch (error: any) { message.error(`成本包刷新失败：${String(error?.message || error).slice(0, 120)}`); } finally { setBusy(false); } };
  const current = snapshot || ({ slides: [], warnings: [] } as unknown as Snapshot);
  return <><Button size="small" icon={<FileTextOutlined />} onClick={() => void show()}>生成成本包</Button><Modal title="阶段成本包预览" open={open} onCancel={() => !busy && setOpen(false)} footer={<Space><Select value={format} onChange={setFormat} options={[{ value: 'html', label: 'HTML 可预览' }, { value: 'pptx', label: 'PPTX 演示' }]} /><Button type="primary" icon={<DownloadOutlined />} loading={busy} onClick={() => void generate()}>刷新并生成</Button></Space>} width={820}><Alert type="info" showIcon message="导出时重新读取项目、版本、报价、目标、措施和评审；草稿会明确标注，不会冒充冻结版。" style={{ marginBottom: 12 }} />{current.warnings?.length > 0 && <Alert type="warning" showIcon message="导出前需要注意" description={<ul>{current.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>} style={{ marginBottom: 12 }} />}<div className="cost-package-preview">{current.slides.map(slide => <section key={slide.heading}><Tag color="blue">{slide.heading}</Tag><ul>{slide.points.map(point => <li key={point}>{point}</li>)}</ul></section>)}</div></Modal></>;
}
