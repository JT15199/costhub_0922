import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Progress, Space, Tag, message } from 'antd';
import { BarChartOutlined, BranchesOutlined, DeleteOutlined, MessageOutlined, ReloadOutlined, SearchOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getAnalysisLibraryItems, getMaterialInsightSubjects, getTrendInsightDimensions, getTrendKeyEvents, getTrendSnapshots, getTrendSources, updateAnalysisItemMeta, updateMaterialInsightSubjectMeta, type AnalysisDomain, type AnalysisLibraryItem, type MaterialInsightSubject } from '../db';
import MaterialInsightResultView from '../components/MaterialInsightResultView';
import { safeHttpUrl } from '../materialInsight';

type Tab = 'overview' | AnalysisDomain | 'favorites';
const DOMAIN_LABEL: Record<AnalysisDomain, string> = { material: '物料洞察', project: '项目成本', quote: '报价与供应商', product: '产品与用户', unclassified: '待归类' };
const DOMAIN_PURPOSE: Record<string, string> = { project: '用于回看项目 BOM、目标成本与健康度结论，保存项目决策依据。', quote: '用于比较供应商报价、记录审价与议价依据，保存可复核的报价证据。', product: '用于沉淀用户声音、产品特性与卖点判断，保存后续定义产品的线索。', favorites: '用于集中查看已收藏的业务成果，保存需要持续跟进的判断。' };
const domainLabel = (value: string) => DOMAIN_LABEL[value as AnalysisDomain] || value;
const statusMeta: Record<string, { label: string; color: string }> = {
  draft: { label: '待编辑', color: 'default' }, ready: { label: '待选择', color: 'gold' }, pending: { label: '待洞察', color: 'gold' },
  queued: { label: '排队中', color: 'blue' }, running: { label: '执行中', color: 'processing' }, paused: { label: '已暂停', color: 'orange' },
  partial: { label: '部分完成', color: 'warning' }, completed: { label: '已完成', color: 'success' }, failed: { label: '失败', color: 'error' },
};
const directionColor: Record<string, string> = { 上涨: 'red', 下降: 'green', 震荡: 'gold', 分化: 'purple', 信号不明确: 'default' };
const formatTime = (value: unknown) => String(value || '').slice(0, 16).replace('T', ' ') || '未知时间';
const numberOrNull = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
const openMaterialEntry = () => window.dispatchEvent(new Event('costhub-open-material-insight'));
const RESULT_CONTENT: Record<string, string> = {
  project_cost: '当前 BOM、目标成本、成本差距、降本措施与阶段健康度',
  quote_review: '供应商报价对比、逐项合理价、偏高项与议价筹码',
  product_voice: '用户原声主题、声量与反馈、卖点价值及产品取舍',
  material_overview: '物料趋势、证据、项目影响与下一步动作',
};
const parseJson = (value: unknown) => { try { return JSON.parse(String(value || '{}')); } catch { return {}; } };
export const buildContinuePrompt = (item: AnalysisLibraryItem) => {
  const data = parseJson(item.data_json);
  const source = parseJson(item.source_json);
  const context = JSON.stringify({ domain: domainLabel(item.domain), resultForm: item.result_form, objectType: item.object_type, objectId: item.object_id, objectName: item.object_name, title: item.title, summary: item.summary, savedData: data, savedSources: source }).slice(0, 9000);
  return `请继续分析这条已保存的 CostHub 成果，保留并使用上下文，不要从零开始。\n业务域：${domainLabel(item.domain)}\n对象：${item.object_name || item.title}\n本页呈现：${RESULT_CONTENT[item.result_form] || '结构化分析结论与依据'}\n已保存结论：${item.summary || '暂无'}\n结构化上下文：${context}\n请基于已有对象继续追问：先识别需要补充的数据并调用对应工具，再输出新的结论、依据、机会/风险、项目影响估算和下一步动作；如果证据不足必须明确说明。`;
};

function FlowNode({ data, selected }: any) {
  return <div className={`analysis-flow-node ${selected ? 'is-selected' : ''}`} role="button" tabIndex={0} onClick={() => data.select(data.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') data.select(data.id); }}><span className="analysis-flow-node-dot" /> <b>{data.label}</b><small>{data.ratio == null ? '占比未估算' : `成本占比 ${data.ratio}%`}</small></div>;
}
const nodeTypes = { analysisNode: FlowNode };

function MaterialTree({ nodes, selectedId, onSelect }: { nodes: any[]; selectedId: number | null; onSelect: (id: number) => void }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const children = new Map<number | null, any[]>();
  nodes.forEach(node => { const parent = node.parent_id == null ? null : Number(node.parent_id); children.set(parent, [...(children.get(parent) || []), node]); });
  const render = (node: any, depth: number): React.ReactNode => { const childRows = children.get(Number(node.id)) || []; const isCollapsed = collapsed.has(Number(node.id)); return <div key={node.id} role="treeitem" aria-level={depth + 1}><div className="material-result-tree-line"><button type="button" className="material-result-tree-toggle" aria-label={isCollapsed ? '展开' : '折叠'} disabled={!childRows.length} onClick={() => setCollapsed(previous => { const next = new Set(previous); isCollapsed ? next.delete(Number(node.id)) : next.add(Number(node.id)); return next; })}>{childRows.length ? (isCollapsed ? '›' : '⌄') : '·'}</button><button type="button" className={`material-result-tree-row ${Number(node.id) === selectedId ? 'is-selected' : ''}`} style={{ paddingLeft: 8 + depth * 18 }} onClick={() => onSelect(Number(node.id))}><span className={`material-result-tree-dot ${node.node_type === 'terminal' ? 'is-terminal' : ''}`} /><span>{node.component_name || '未命名节点'}</span><small>{node.cost_ratio_estimate == null ? '占比待估算' : `${node.cost_ratio_estimate}%`}</small><Tag color={node.insight_status === 'queried' ? 'green' : 'gold'}>{node.insight_status === 'queried' ? '已洞察' : '待处理'}</Tag></button></div>{!isCollapsed && childRows.map(child => render(child, depth + 1))}</div>; };
  const roots = children.get(null) || nodes.filter(node => node.parent_id == null);
  return <div className="material-result-tree" role="tree">{roots.map(node => render(node, 0))}</div>;
}

function Overview({ subjects, items, onSelect }: { subjects: MaterialInsightSubject[]; items: AnalysisLibraryItem[]; onSelect: (tab: Tab) => void }) {
  const count = (domain: AnalysisDomain) => items.filter(item => item.domain === domain).length;
  const recent = [...subjects.map(subject => ({ key: subject.key, title: subject.title, domain: 'material' as AnalysisDomain, time: subject.updatedAt })), ...items.map(item => ({ key: item.item_key, title: item.title, domain: item.domain, time: item.created_at }))].sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return <div className="analysis-overview"><div className="analysis-domain-grid">{(['material', 'project', 'quote', 'product'] as AnalysisDomain[]).map(domain => <button type="button" key={domain} onClick={() => onSelect(domain)}><span>{DOMAIN_LABEL[domain]}</span><b>{domain === 'material' ? subjects.length : count(domain)}</b><small>{domain === 'material' ? '父级任务与分解树' : domain === 'project' ? '项目成本结论' : domain === 'quote' ? '报价与议价依据' : '用户声音与卖点'}</small></button>)}</div><div className="analysis-overview-columns"><section className="content-card"><div className="section-heading"><h2>最近更新</h2><span>{recent.length} 条成果</span></div>{recent.slice(0, 8).map(item => <div className="analysis-list-row" key={item.key}><Tag color={item.domain === 'material' ? 'blue' : 'default'}>{DOMAIN_LABEL[item.domain]}</Tag><div><b>{item.title}</b><small>{formatTime(item.time)}</small></div></div>)}{!recent.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="AI 保存结果会出现在这里" />}</section><section className="content-card"><div className="section-heading"><h2>使用提示</h2><BranchesOutlined /></div><p className="analysis-overview-tip">物料洞察的父级任务集中在「物料洞察」页；进入任务后可在树中查看每个叶子节点的历史趋势快照。</p><Button type="link" onClick={() => onSelect('material')}>打开物料任务 →</Button></section></div></div>;
}

function DomainList({ items, domain, onFavorite, onArchive, onContinue }: { items: AnalysisLibraryItem[]; domain: Tab; onFavorite: (item: AnalysisLibraryItem, value: boolean) => void; onArchive: (item: AnalysisLibraryItem) => void; onContinue: (item: AnalysisLibraryItem) => void }) {
  const groups = useMemo(() => { const map = new Map<string, AnalysisLibraryItem[]>(); items.forEach(item => { const key = `${item.domain}:${item.object_id || item.object_name || item.item_key}`; map.set(key, [...(map.get(key) || []), item]); }); return [...map.values()]; }, [items]);
  return <div className="analysis-domain-results"><section className="content-card analysis-domain-purpose"><div><h2>{domain === 'favorites' ? '收藏成果' : domainLabel(domain)}</h2><p>{DOMAIN_PURPOSE[domain] || '用于保存可回看的分析结论与证据。'}</p><small className="analysis-domain-fields">本页呈现：{RESULT_CONTENT[domain === 'favorites' ? 'generic_ai' : domain === 'project' ? 'project_cost' : domain === 'quote' ? 'quote_review' : domain === 'product' ? 'product_voice' : 'material_overview'] || '结构化分析结论与依据'}</small></div><Tag>{groups.length} 个对象 · {items.length} 条成果</Tag></section><div className="analysis-object-list">{groups.map(group => { const item = group[0]; return <article className="analysis-object-card" key={item.item_key}><div className="analysis-object-card-head"><div><Space size={4} wrap><Tag color={item.domain === 'quote' ? 'gold' : 'blue'}>{domainLabel(item.domain)}</Tag>{item.freshness === 'stale' && <Tag color="orange">数据已过期</Tag>}{item.freshness === 'draft' && <Tag color="gold">引用草稿</Tag>}{item.data_fingerprint && <Tag>有数据指纹</Tag>}</Space><h2>{item.object_name || item.title}</h2><small>{group.length} 条相关成果 · 最近更新 {formatTime(item.created_at)}</small></div><Button aria-label={item.favorite ? '取消收藏' : '收藏'} type="text" icon={item.favorite ? <StarFilled style={{ color: '#F59E0B' }} /> : <StarOutlined />} onClick={() => onFavorite(item, !item.favorite)} /></div><div className="analysis-object-card-content"><small className="analysis-object-card-context">本条成果包含：{RESULT_CONTENT[item.result_form] || '分析结论、数据上下文与依据'}</small><p>{item.summary || '暂无结论摘要'}</p></div><div className="analysis-object-card-footer"><span>{item.result_form === 'quote_review' ? '专用审价结果' : item.result_form === 'project_cost' ? '成本结论' : item.result_form === 'product_voice' ? '产品洞察' : '结构化成果'}</span><div><Button size="small" icon={<MessageOutlined />} onClick={() => onContinue(item)}>继续问 AI</Button><Button size="small" danger type="text" icon={<DeleteOutlined />} aria-label="归档成果" onClick={() => onArchive(item)}>归档</Button></div></div></article>; })}{!groups.length && <div className="content-card analysis-empty"><Empty description={domain === 'favorites' ? '还没有收藏成果' : `还没有${domainLabel(domain)}成果`} /></div>}</div></div>;
}

function MaterialSubjects({ subjects, selected, selectedNode, snapshots, sources, view, setView, onSelect, onSelectNode, onFavorite, onArchive, onReload }: { subjects: MaterialInsightSubject[]; selected: MaterialInsightSubject | null; selectedNode: any; snapshots: any[]; sources: any[]; view: 'tree' | 'graph'; setView: (value: 'tree' | 'graph') => void; onSelect: (subject: MaterialInsightSubject) => void; onSelectNode: (id: number) => void; onFavorite: (subject: MaterialInsightSubject) => void; onArchive: (subject: MaterialInsightSubject) => void; onReload: () => void }) {
  const latest = snapshots.find(snapshot => Number(snapshot.trend_item_id) === Number(selectedNode?.trend_item_id)) || snapshots[0] || selected?.latestSnapshot || {};
  const nodes = selected?.nodes || [];
  const flow = useMemo(() => {
    const byId = new Map(nodes.map(node => [Number(node.id), node]));
    const depth = (node: any, seen = new Set<number>()): number => {
      const id = Number(node?.id);
      const parentId = Number(node?.parent_id);
      if (!node || node.parent_id == null || seen.has(id)) return 0;
      seen.add(id);
      return 1 + depth(byId.get(parentId), seen);
    };
    const rows: Record<number, number> = {};
    const flowNodes: Node[] = nodes.map(node => {
      const level = depth(node);
      const row = rows[level] || 0;
      rows[level] = row + 1;
      return { id: String(node.id), type: 'analysisNode', position: { x: level * 220, y: row * 86 }, selected: Number(node.id) === Number(selectedNode?.id), data: { id: Number(node.id), label: node.component_name || '未命名节点', ratio: numberOrNull(node.cost_ratio_estimate), select: onSelectNode } };
    });
    const flowEdges: Edge[] = nodes.filter(node => node.parent_id != null).map(node => ({ id: `e-${node.parent_id}-${node.id}`, source: String(node.parent_id), target: String(node.id), type: 'smoothstep' }));
    return { flowNodes, flowEdges };
  }, [nodes, selectedNode, onSelectNode]);

  return (
    <div className="material-insight-layout">
      <section className="material-object-rail content-card">
        <div className="section-heading material-object-rail-heading"><div><h2>物料任务</h2><span>{subjects.length} 个父级 · 子节点不单独铺开</span></div></div>
        <div className="material-object-grid">
          {subjects.map(subject => {
            const meta = statusMeta[subject.status] || statusMeta.pending;
            const latestSubject = subject.latestSnapshot || subject.trendItem || {};
            const direction = latestSubject.direction || latestSubject.trend_direction || '未判断';
            const confidence = latestSubject.confidence_level || latestSubject.confidence || '未评估';
            return <button type="button" key={subject.key} className={`material-object-card ${selected?.key === subject.key ? 'is-active' : ''}`} onClick={() => onSelect(subject)}>
              <div className="material-object-card-title"><b>{subject.title}</b><Tag color={subject.kind === 'decomposition' ? 'blue' : 'cyan'}>{subject.kind === 'decomposition' ? '分解型' : '直接型'}</Tag></div>
              <div className="material-object-card-tags"><Tag color={directionColor[direction] || 'default'}>{direction}</Tag><Tag>{confidence}置信</Tag><Tag color={meta.color}>{meta.label}</Tag></div>
              <p>{latestSubject.summary || '本次未形成结论'}</p>
              <small>最后洞察：{formatTime(subject.updatedAt)} · 历史 {subject.historyCount} 次</small>
              {subject.kind === 'decomposition' && <div className="material-object-progress"><Progress percent={subject.totalNodes ? Math.round(subject.completedNodes / subject.totalNodes * 100) : 0} size="small" status={subject.failedNodes ? 'exception' : undefined} /><span>{subject.completedNodes}/{subject.totalNodes} 个终端完成</span></div>}
            </button>;
          })}
        </div>
        {!subjects.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无父级物料任务" />}
      </section>
      {!selected ? <div className="content-card analysis-empty"><Empty description="选择一个物料任务查看结果" /></div> : <main className="material-insight-main">
        <div className="material-detail-head"><div><span className="eyebrow">MATERIAL PARENT RESULT</span><h2>{selected.title}</h2><small>{selected.kind === 'decomposition' ? '分解洞察 · 子节点结果保留在下方树中' : '直接查询 · 历史查询已归并'} · 更新于 {formatTime(selected.updatedAt)}</small></div><Space wrap><Button size="small" icon={<ReloadOutlined />} onClick={onReload}>刷新</Button><Button size="small" icon={selected.favorite ? <StarFilled style={{ color: '#F59E0B' }} /> : <StarOutlined />} onClick={() => onFavorite(selected)}>{selected.favorite ? '已收藏' : '收藏'}</Button><Button size="small" danger icon={<DeleteOutlined />} onClick={() => onArchive(selected)}>归档</Button><Button size="small" type="primary" onClick={openMaterialEntry}>进入物料洞察</Button></Space></div>
        {selected.kind === 'decomposition' && <section className="content-card material-result-structure"><div className="section-heading"><div><h3>分解树</h3><span>子节点不会出现在上一级任务列表</span></div><Space><Button size="small" type={view === 'tree' ? 'primary' : 'default'} onClick={() => setView('tree')}>树清单</Button><Button size="small" type={view === 'graph' ? 'primary' : 'default'} onClick={() => setView('graph')}>结构图</Button><Button size="small" onClick={openMaterialEntry}>进入物料洞察</Button></Space></div>{view === 'tree' ? <MaterialTree nodes={nodes} selectedId={selectedNode?.id ? Number(selectedNode.id) : null} onSelect={onSelectNode} /> : <div className="analysis-flow-wrap"><ReactFlow nodes={flow.flowNodes} edges={flow.flowEdges} nodeTypes={nodeTypes} fitView><Background color="#dbe5f0" /><Controls showInteractive={false} /></ReactFlow></div>}</section>}
        <MaterialInsightResultView snapshot={latest} snapshots={snapshots} nodes={nodes} subjectKind={selected.kind} sources={sources} onSelectNode={onSelectNode} />
      </main>}
    </div>
  );
}

export default function AnalysisResults() {
  const [tab, setTab] = useState<Tab>('overview');
  const [items, setItems] = useState<AnalysisLibraryItem[]>([]);
  const [subjects, setSubjects] = useState<MaterialInsightSubject[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedSubjectKey, setSelectedSubjectKey] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [materialView, setMaterialView] = useState<'tree' | 'graph'>('tree');

  const load = useCallback(async () => {
    setLoading(true);
    try { const [library, materialSubjects] = await Promise.all([getAnalysisLibraryItems(180), getMaterialInsightSubjects()]); setItems(library); setSubjects(materialSubjects); }
    catch (error: any) { message.error(`分析成果加载失败：${String(error?.message || error).slice(0, 100)}`); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const events = ['costhub-analysis-artifact-saved', 'costhub-project-analysis-updated', 'costhub-quote-review-updated', 'costhub-selling-updated', 'costhub-insight-done', 'costhub-trend-updated']; events.forEach(event => window.addEventListener(event, load)); return () => events.forEach(event => window.removeEventListener(event, load)); }, [load]);

  const filteredSubjects = useMemo(() => { const query = keyword.trim().toLocaleLowerCase(); return subjects.filter(subject => !query || `${subject.title} ${subject.categoryType}`.toLocaleLowerCase().includes(query)); }, [subjects, keyword]);
  const nonMaterialItems = useMemo(() => items.filter(item => item.domain !== 'material'), [items]);
  const filteredItems = useMemo(() => { const query = keyword.trim().toLocaleLowerCase(); return nonMaterialItems.filter(item => (!query || `${item.title} ${item.summary} ${item.object_name}`.toLocaleLowerCase().includes(query)) && (tab === 'favorites' ? item.favorite : item.domain === tab)); }, [nonMaterialItems, keyword, tab]);
  const selectedSubject = subjects.find(subject => subject.key === selectedSubjectKey) || filteredSubjects[0] || null;
  const selectedNode = selectedSubject?.kind === 'decomposition' ? selectedSubject.nodes.find(node => Number(node.id) === Number(selectedNodeId)) || selectedSubject.nodes.find(node => Number(node.id) === Number(selectedSubject.rootNodeId)) || selectedSubject.nodes[0] : null;

  useEffect(() => { if (!selectedSubjectKey || !subjects.some(subject => subject.key === selectedSubjectKey)) setSelectedSubjectKey(subjects[0]?.key || null); }, [subjects, selectedSubjectKey]);
  useEffect(() => { if (!selectedSubject) { setSelectedNodeId(null); return; } const first = selectedSubject.kind === 'decomposition' ? selectedSubject.nodes.find(node => Number(node.id) === Number(selectedSubject.rootNodeId)) || selectedSubject.nodes[0] : null; setSelectedNodeId(first?.id ? Number(first.id) : null); }, [selectedSubject?.key]);
  useEffect(() => {
    if (!selectedSubject) { setSnapshots([]); setSources([]); return; }
    const trendIds = selectedSubject.kind === 'decomposition'
      ? [...new Set(selectedSubject.nodes.map(node => Number(node.trend_item_id)).filter(Number.isFinite))]
      : [Number(selectedNode?.trend_item_id || selectedSubject.trendItemId || 0)].filter(Boolean);
    const trendId = trendIds[0] || 0;
    if (!trendId) { setSnapshots([]); setSources([]); return; }
    let cancelled = false;
    Promise.all([Promise.all(trendIds.map(id => getTrendSnapshots(id).catch(() => []))), Promise.all(trendIds.map(id => getTrendSources(id).catch(() => [])))]).then(async ([snapshotGroups, sourceGroups]) => { const nextSources = sourceGroups.flat(); const sourceCountByTrend = new Map(trendIds.map((id, index) => [id, sourceGroups[index].filter((source: any) => Boolean(safeHttpUrl(source.source_url))).length])); const rows = snapshotGroups.flat().sort((a, b) => Number(b.id || 0) - Number(a.id || 0)); const enriched = await Promise.all(rows.map(async row => ({ ...row, source_count: sourceCountByTrend.get(Number(row.trend_item_id)) || 0, dimensions: await getTrendInsightDimensions(Number(row.id)).catch(() => []), key_events: await getTrendKeyEvents(Number(row.id)).catch(() => []) }))); if (!cancelled) { setSnapshots(enriched); setSources(nextSources); } });
    return () => { cancelled = true; };
  }, [selectedSubject?.key, selectedSubject?.trendItemId, selectedNode?.id, selectedNode?.trend_item_id]);

  const updateMaterialMeta = async (subject: MaterialInsightSubject, patch: { favorite?: boolean; archived?: boolean }) => { await updateMaterialInsightSubjectMeta(subject.key, patch); await load(); };
  const action = async (item: AnalysisLibraryItem, patch: any) => { await updateAnalysisItemMeta(item.item_key, patch); await load(); };
  const continueAI = (item: AnalysisLibraryItem) => { localStorage.setItem('costhub-ai-prompt-pending', JSON.stringify({ prompt: buildContinuePrompt(item), auto: true })); window.dispatchEvent(new CustomEvent('costhub-ai-ctx', { detail: { label: `分析成果 · ${domainLabel(item.domain)} · ${item.object_name || item.title}` } })); window.dispatchEvent(new Event('costhub-ai-focus')); window.dispatchEvent(new Event('costhub-open-ai-prompt')); };

  const materialSubjectsForTab = tab === 'favorites' ? subjects.filter(subject => subject.favorite) : filteredSubjects;
  return <div className="analysis-library-page"><header className="analysis-library-header"><div><span className="eyebrow">COSTHUB · EVIDENCE LIBRARY</span><h1><BarChartOutlined /> 分析成果</h1><p>按业务领域和对象沉淀可回看的洞察、证据与行动线索。</p></div></header><nav className="analysis-library-tabs" aria-label="分析成果领域">{[['overview', '概览'], ['material', '物料洞察'], ['project', '项目成本'], ['quote', '报价与供应商'], ['product', '产品与用户'], ['favorites', '收藏']].map(([key, label]) => <button type="button" className={tab === key ? 'is-active' : ''} key={key} onClick={() => setTab(key as Tab)}>{label}{key === 'material' ? <small>{subjects.length}</small> : key !== 'overview' && key !== 'favorites' ? <small>{items.filter(item => item.domain === key).length}</small> : ''}</button>)}</nav><div className="analysis-library-toolbar"><Input allowClear prefix={<SearchOutlined />} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索物料、项目或分析成果" /><span>{loading ? '读取中…' : tab === 'material' || tab === 'favorites' ? `${materialSubjectsForTab.length} 个物料任务` : `${filteredItems.length} 条成果`}</span></div>{tab === 'overview' ? <Overview subjects={subjects} items={nonMaterialItems} onSelect={setTab} /> : tab === 'material' || (tab === 'favorites' && materialSubjectsForTab.length > 0) ? <MaterialSubjects subjects={materialSubjectsForTab} selected={selectedSubject && materialSubjectsForTab.some(subject => subject.key === selectedSubject.key) ? selectedSubject : materialSubjectsForTab[0] || null} selectedNode={selectedNode} snapshots={snapshots} sources={sources} view={materialView} setView={setMaterialView} onSelect={subject => setSelectedSubjectKey(subject.key)} onSelectNode={setSelectedNodeId} onFavorite={subject => updateMaterialMeta(subject, { favorite: !subject.favorite })} onArchive={subject => updateMaterialMeta(subject, { archived: true })} onReload={load} /> : <DomainList items={filteredItems} domain={tab} onFavorite={(item, value) => action(item, { favorite: value })} onArchive={item => action(item, { archived: true })} onContinue={continueAI} />}{tab === 'favorites' && materialSubjectsForTab.length > 0 && filteredItems.length > 0 && <div className="analysis-library-favorites-secondary"><h2>其他收藏成果</h2><DomainList items={filteredItems} domain={tab} onFavorite={(item, value) => action(item, { favorite: value })} onArchive={item => action(item, { archived: true })} onContinue={continueAI} /></div>}</div>;
}
