import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Table, Button, Input, Select, Space, Modal, Form, Tag, message,
  Popconfirm, Spin, Empty, Descriptions, Tooltip, Progress, Radio, List, Card, Row, Col, Typography, Alert,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined,
  CheckOutlined, SearchOutlined, DownloadOutlined, SendOutlined, QuestionCircleOutlined,
  RadarChartOutlined, ApartmentOutlined, MergeCellsOutlined,
  ArrowLeftOutlined, BranchesOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  ReactFlow, MiniMap, Controls, Background, Panel, useNodesState, useEdgesState,
  Handle, Position,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  getDecompositionTree, getDecompositionNode, saveDecompositionNode,
  deleteDecompositionNode, searchDecompositionNodes, getDecompositionHistory,
  getTrendItemsWithDetails, getLatestTrendSnapshot, getTrendItemByCategory,
  saveTrendItem, saveTrendSnapshot, getTrendSnapshots,
  getTrendConversations,
  saveTrendSource, clearTrendSources,
  saveRollupContribution, getRollupContributions, saveRollupFeedback, getAllRollupFeedback,
  getTrendInsightDimensions, saveTrendInsightDimensions, saveTrendKeyEvent,
  getParts,
} from '../db';
import { hasLLMConfig } from '../apiConfig';
import { agentSearchLoop, askLLM, createStructuredInsight, BUILTIN_SKILLS } from '../trendService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCategoryColor } from '../constants';

const ROLLUP_SKILL = `# 层级趋势汇总（Rollup）Skill

## 任务
对一组子节点的趋势洞察结果进行综合，生成父节点的趋势汇总结论。

## 分析要点
1. **优先识别占比最高的子件**：成本占比越高的子件，对父节点整体趋势的决定性越大
2. **关注驱动因素关联性**：如果多个高占比子件的上涨驱动因素相同（如都是芯片成本传导），说明存在系统性因素，趋势确定性更高
3. **信号不明确子件的处理**：信号不明确的子件占总成本比超过40%时，下调父节点置信度
4. **异常信号识别**：某个子件方向与绝大多数子件显著不同时，分析其特殊性
5. **震荡+明确下跌组合**：震荡子件的趋势贡献视为中性，不改变整体方向

## 输出 JSON 格式
{"trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","summary":"综合叙述判断依据，需明确说明基于N个子节点的综合研判，列出各子节点贡献"}
`;

const TREND_COLORS: Record<string, string> = { '上涨': '#EF4444', '下降': '#10B981', '震荡': '#F59E0B', '信号不明确': '#94A3B8' };
const TREND_ICONS: Record<string, string> = { '上涨': '🔺', '下降': '🔻', '震荡': '▬', '信号不明确': '？' };
const DIRECTION_VALUES: Record<string, number> = { '上涨': 1, '下降': -1, '震荡': 0 };

// ====== 自定义 React Flow 节点 ======
// 通过 window 级回调让节点组件触发勾选，避免模块级组件无法访问 React state
let checkToggleFn: ((dbId: number, ctrlKey: boolean) => void) | null = null;
let nodeActionFn: ((dbId: number, action: 'decompose' | 'insight') => void) | null = null;

function DecompNode({ data, selected }: any) {
  const trendColor = data.trendColor || '#94A3B8';
  const isDraft = data.sourceType === 'ai_draft';
  const isChecked = data.isChecked;
  const isTerminal = data.nodeType === 'terminal';
  return (
    <div
      style={{
        background: isDraft ? 'linear-gradient(135deg, #F8FAFC, #F1F5F9)' : 'var(--card-bg, #FFF)',
        border: `2px solid ${selected ? 'var(--brand, #6366F1)' : trendColor}`,
        borderRadius: 12,
        padding: '9px 12px 8px 30px',
        minWidth: 164,
        maxWidth: 220,
        boxShadow: selected ? '0 10px 24px rgba(99,102,241,0.22)' : '0 4px 12px rgba(15,23,42,0.10)',
        opacity: isDraft ? 0.78 : 1,
        cursor: 'pointer',
        fontSize: 12,
        position: 'relative',
        transition: 'box-shadow 180ms ease, transform 180ms ease, border-color 180ms ease',
        transform: selected ? 'translateY(-2px)' : 'translateY(0)',
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.stopPropagation();
          if (checkToggleFn && data.dbId) checkToggleFn(data.dbId, true);
        }
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: trendColor, width: 8, height: 8, border: '2px solid #fff' }} />
      <span
        title="勾选后可批量操作；Ctrl/Cmd 点击可级联勾选"
        style={{ position: 'absolute', left: 7, top: 8, fontSize: 14, cursor: 'pointer', color: isChecked ? 'var(--brand, #6366F1)' : '#94A3B8', userSelect: 'none' }}
        onClick={(e) => { e.stopPropagation(); if (checkToggleFn && data.dbId) checkToggleFn(data.dbId, false); }}
      >
        {isChecked ? '☑' : '☐'}
      </span>
      <div style={{ fontWeight: 700, color: 'var(--text-primary, #1E293B)', marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.trendIcon && <span style={{ marginRight: 4 }}>{data.trendIcon}</span>}{data.label}
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, marginBottom: 7 }}>
        <Tag color={isTerminal ? 'orange' : 'blue'} style={{ fontSize: 9, margin: 0, padding: '0 5px', lineHeight: '16px' }}>{isTerminal ? '终端物料' : '结构节点'}</Tag>
        {data.costRatio != null && <span style={{ color: 'var(--text-muted, #64748B)' }}>占比 {data.costRatio}%</span>}
      </div>
      {!isDraft && (
        <Button
          size="small"
          type={isTerminal ? 'primary' : 'default'}
          icon={isTerminal ? <RadarChartOutlined /> : <ThunderboltOutlined />}
          style={{ width: '100%', fontSize: 11, height: 24 }}
          onClick={(e) => { e.stopPropagation(); if (nodeActionFn && data.dbId) nodeActionFn(data.dbId, isTerminal ? 'insight' : 'decompose'); }}
        >
          {isTerminal ? (data.insightStatus === 'queried' ? '重新洞察行情' : 'AI 洞察行情') : 'AI 拆解子件'}
        </Button>
      )}
      {isDraft && <div style={{ fontSize: 10, color: '#64748B' }}>AI 草稿 · 确认后可操作</div>}
      <Handle type="source" position={Position.Right} style={{ background: trendColor, width: 8, height: 8, border: '2px solid #fff' }} />
    </div>
  );
}

const nodeTypes = { decompNode: DecompNode };

// ====== 主组件 ======
export default function Decomposition(_props: any) {
  // ====== 视图状态 ======
  const [view, setView] = useState<'list' | 'tree'>('list');
  const [rootNodeId, setRootNodeId] = useState<number | null>(null);
  const [rootNodeName, setRootNodeName] = useState('');

  // ====== 数据状态 ======
  const [nodes, setNodesData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [trendItems, setTrendItems] = useState<any[]>([]);
  const [snapshotMap, setSnapshotMap] = useState<Record<number, any>>({});
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [convAsk, setConvAsk] = useState('');
  const [convLoading, setConvLoading] = useState(false);
  const [conversations, setConversations] = useState<any[]>([]);
  const [insightLoading, setInsightLoading] = useState(false);
  const [rollupLoading, setRollupLoading] = useState(false);
  const [insightDimensions, setInsightDimensions] = useState<any[]>([]);
  const [selectedHistoryTime, setSelectedHistoryTime] = useState<string | null>(null); // 选中的历史洞察时间
  const [availableHistoryTimes, setAvailableHistoryTimes] = useState<string[]>([]); // 可用的历史时间列表

  // AI 起草
  const [aiDraftOpen, setAiDraftOpen] = useState(false);
  const [aiDraftName, setAiDraftName] = useState('');
  const [aiDraftLoading, setAiDraftLoading] = useState(false);
  const [aiDraftResult, setAiDraftResult] = useState<any[]>([]);
  const [aiDraftParentId, setAiDraftParentId] = useState<number | null>(null);
  const [editingDraftIndex, setEditingDraftIndex] = useState<number | null>(null);

  // 批量操作
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [batchDecomposeOpen, setBatchDecomposeOpen] = useState(false);
  const [batchInsightOpen, setBatchInsightOpen] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });

  // Rollup
  const [rollupResult, setRollupResult] = useState<any>(null);
  const [, setRollupContributions] = useState<any[]>([]);

  // Rollup 反馈
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackData, setFeedbackData] = useState({ direction: '', confidence: '', summary: '', reason: '' });
  const [feedbackHistoryOpen, setFeedbackHistoryOpen] = useState(false);
  const [allFeedback, setAllFeedback] = useState<any[]>([]);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // 清单页 - 批量选中顶层
  const [listChecked, setListChecked] = useState<Set<number>>(new Set());
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // React Flow 状态
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([] as any);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [flowInstance, setFlowInstance] = useState<any>(null);
  const [canvasHintVisible, setCanvasHintVisible] = useState(true);

  // 关注物料列表
  const [watchedParts, setWatchedParts] = useState<any[]>([]);

  // 收集某个节点的所有子孙 ID（递归）
  const getDescendantIds = useCallback((nodeId: number): number[] => {
    const ids: number[] = [];
    const children = nodes.filter((n: any) => n.parent_id === nodeId);
    for (const child of children) {
      ids.push(child.id);
      ids.push(...getDescendantIds(child.id));
    }
    return ids;
  }, [nodes]);

  // 注册全局勾选回调（级联：勾选父节点→全选子孙）
  useEffect(() => {
    checkToggleFn = (dbId: number) => {
      setCheckedIds(prev => {
        const next = new Set(prev);
        if (next.has(dbId)) {
          // 取消：取消自己 + 所有子孙
          next.delete(dbId);
          getDescendantIds(dbId).forEach(did => next.delete(did));
        } else {
          // 勾选：勾上自己 + 所有子孙
          next.add(dbId);
          getDescendantIds(dbId).forEach(did => next.add(did));
          // 向上递归：如果所有兄弟都勾了，也勾父节点
          const node = nodes.find((n: any) => n.id === dbId);
          if (node?.parent_id) {
            const siblings = nodes.filter((n: any) => n.parent_id === node.parent_id);
            if (siblings.every((s: any) => next.has(s.id))) {
              next.add(node.parent_id);
              let pid: number | null = node.parent_id;
              while (pid) {
                const pn = nodes.find((n: any) => n.id === pid);
                if (!pn?.parent_id) break;
                const psibs = nodes.filter((n: any) => n.parent_id === pn.parent_id);
                if (psibs.every((s: any) => next.has(s.id))) { next.add(pn.parent_id); pid = pn.parent_id; }
                else break;
              }
            }
          }
        }
        return next;
      });
    };
    return () => { checkToggleFn = null; };
  }, [nodes, getDescendantIds]);

  useEffect(() => {
    nodeActionFn = (dbId: number, action: 'decompose' | 'insight') => {
      const node = nodes.find((item: any) => item.id === dbId);
      if (!node) return;
      if (action === 'decompose') {
        setAiDraftParentId(node.id);
        setAiDraftName(node.component_name);
        setAiDraftResult([]);
        setAiDraftOpen(true);
      } else {
        requestInsightWithPreview(node);
      }
    };
    return () => { nodeActionFn = null; };
  }, [nodes]);

  // 当 checkedIds 变化时，只更新已有 rfNodes 的 isChecked 状态，不重建布局
  useEffect(() => {
    if (rfNodes.length === 0) return;
    setRfNodes(
      rfNodes.map((n: any) => ({
        ...n,
        data: { ...n.data, isChecked: checkedIds.has(n.data.dbId) },
      }))
    );
  }, [checkedIds]);

  // ====== 数据加载 ======
  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getDecompositionTree();
      setNodesData(all);
      const items = await getTrendItemsWithDetails();
      setTrendItems(items);
      const map: Record<number, any> = {};
      for (const item of items) {
        const snap = await getLatestTrendSnapshot(item.id);
        if (snap) map[item.id] = snap;
      }
      setSnapshotMap(map);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  // 加载关注物料列表
  const loadWatchedParts = useCallback(async () => {
    try {
      const allParts = await getParts('', '', '');
      const watched = allParts.filter((p: any) => p.trend_enabled === 1);
      setWatchedParts(watched);
    } catch (e) {
      console.error('加载关注物料失败:', e);
    }
  }, []);

  useEffect(() => {
    loadTree();
    loadWatchedParts();
  }, [loadTree, loadWatchedParts]);

  // 进入树详情视图时构建 React Flow 节点。选中状态不参与布局，拖拽位置不会被点击重置。
  useEffect(() => {
    if (view === 'tree' && rootNodeId) buildFlowTree(rootNodeId);
  }, [view, rootNodeId, nodes, snapshotMap]);

  const buildFlowTree = (rootId: number) => {
    const nodeById = new Map<number, any>(nodes.map((node: any) => [node.id, node]));
    const childrenByParent = new Map<number, any[]>();
    nodes.forEach((node: any) => {
      if (node.parent_id == null) return;
      const children = childrenByParent.get(node.parent_id) || [];
      children.push(node);
      childrenByParent.set(node.parent_id, children);
    });
    const root = nodeById.get(rootId);
    if (!root) return;

    const levels = new Map<number, number>([[rootId, 0]]);
    const orderedIds: number[] = [];
    const queue = [rootId];
    const visited = new Set<number>();
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      orderedIds.push(id);
      const level = levels.get(id) || 0;
      for (const child of childrenByParent.get(id) || []) {
        if (!visited.has(child.id)) {
          levels.set(child.id, level + 1);
          queue.push(child.id);
        }
      }
    }

    const groups = new Map<number, number[]>();
    orderedIds.forEach((id) => {
      const level = levels.get(id) || 0;
      const group = groups.get(level) || [];
      group.push(id);
      groups.set(level, group);
    });
    const positions = new Map<number, { x: number; y: number }>();
    groups.forEach((ids, level) => {
      const spacing = 132;
      const startY = -((ids.length - 1) * spacing) / 2;
      ids.forEach((id, index) => positions.set(id, { x: level * 320 + 50, y: startY + index * spacing }));
    });

    const flowNodes: Node[] = orderedIds.map((id) => {
      const node = nodeById.get(id);
      const snapshot = snapshotMap[node.trend_item_id];
      const direction = snapshot?.direction || '';
      let color = TREND_COLORS[direction] || '#94A3B8';
      if (node.node_type === 'terminal' && node.insight_status === 'pending' && !direction) color = '#F59E0B';
      else if (node.source_type === 'ai_draft') color = '#94A3B8';
      else if (!direction && node.node_type !== 'terminal') color = '#3B82F6';
      return {
        id: String(node.id),
        type: 'decompNode',
        position: positions.get(node.id) || { x: 0, y: 0 },
        selected: selectedId === node.id,
        data: {
          label: node.component_name,
          trendColor: color,
          trendIcon: direction ? TREND_ICONS[direction] : (node.node_type === 'terminal' && node.insight_status === 'pending' ? '⏳' : ''),
          nodeType: node.node_type,
          costRatio: node.cost_ratio_estimate,
          sourceType: node.source_type,
          insightStatus: node.insight_status,
          dbId: node.id,
          isChecked: checkedIds.has(node.id),
        },
      };
    });
    const flowEdges = orderedIds
      .map((id) => nodeById.get(id))
      .filter((node) => node.parent_id != null && visited.has(node.parent_id))
      .map((node) => ({
        id: `e-${node.parent_id}-${node.id}`,
        source: String(node.parent_id),
        target: String(node.id),
        type: 'smoothstep',
        animated: false,
        style: { stroke: '#94A3B8', strokeWidth: 2 },
      }));

    setRfNodes(flowNodes);
    setRfEdges(flowEdges);
    setTimeout(() => flowInstance?.fitView({ padding: 0.22, duration: 360, maxZoom: 1.15 }), 0);
  };

  // ====== 节点选择 ======
  // ====== 加载指定时间的洞察维度 ======
  const loadInsightDimensionsByTime = async (directSnaps: any[], targetTime: string) => {
    const targetSnaps = directSnaps.filter((s: any) => s.query_time === targetTime);
    const allDimensions: any[] = [];
    for (const snap of targetSnaps) {
      try {
        const dims = await getTrendInsightDimensions(snap.id);
        dims.forEach((d: any) => {
          d._skill_used = snap.skill_used;
          d._snapshot_id = snap.id;
          d._query_time = snap.query_time;
        });
        allDimensions.push(...dims);
      } catch {}
    }
    setInsightDimensions(allDimensions);
  };

  const selectNode = useCallback(async (node: any) => {
    const full = await getDecompositionNode(node.id);
    setSelectedNode(full);
    setSelectedId(node.id);
    setHistory(await getDecompositionHistory(node.id));
    setInsightDimensions([]);
    setAvailableHistoryTimes([]);
    setSelectedHistoryTime(null);

    if (full?.trend_item_id) {
      const snaps = await getTrendSnapshots(full.trend_item_id);
      setSnapshots(snaps);
      setConversations(await getTrendConversations(full.trend_item_id));

      // 收集所有历史洞察时间（去重）
      const directSnaps = snaps.filter((s: any) => s.source_type !== 'aggregated');
      const uniqueTimes = [...new Set(directSnaps.map((s: any) => s.query_time))].filter(Boolean).sort().reverse();
      setAvailableHistoryTimes(uniqueTimes as string[]);

      // 只加载最新一批洞察的维度数据
      if (directSnaps.length > 0) {
        const latestTime = uniqueTimes[0] as string;
        setSelectedHistoryTime(latestTime);
        await loadInsightDimensionsByTime(directSnaps, latestTime);
      }

      const lastAgg = snaps.filter((s: any) => s.source_type === 'aggregated');
      if (lastAgg.length > 0) {
        const contribs = await getRollupContributions(lastAgg[lastAgg.length - 1].id);
        setRollupContributions(contribs);
        setRollupResult(lastAgg[lastAgg.length - 1]);
      } else { setRollupContributions([]); setRollupResult(null); }
    } else { setSnapshots([]); setConversations([]); setRollupContributions([]); setRollupResult(null); }
  }, [nodes, trendItems]);

  // React Flow 点击事件
  const onNodeClick = useCallback(async (_: any, node: Node) => {
    const dbId = node.data.dbId;
    if (dbId) {
      const n = nodes.find((x: any) => x.id === dbId);
      if (n) {
        setRfNodes((current: any[]) => current.map((item: any) => ({ ...item, selected: item.id === String(dbId) })));
        setCanvasHintVisible(false);
        selectNode(n);
      }
    }
  }, [nodes, selectNode, setRfNodes]);

  const ensureTrendItem = async (nodeName: string, categoryType = '直接查询'): Promise<number> => {
    let existing = await getTrendItemByCategory(nodeName, categoryType);
    if (existing) return existing.id;
    return await saveTrendItem({
      query_category: nodeName, category_type: categoryType,
      trend_direction: '', confidence_level: '', summary: '', suggested_action: '',
      raw_search_results: '', last_updated_at: '',
    });
  };

  // ====== 单节点洞察（带预览确认） ======
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewTargetNode, setPreviewTargetNode] = useState<any>(null);

  const requestInsightWithPreview = (node: any) => {
    setPreviewTargetNode(node);
    setPreviewModalOpen(true);
  };

  const confirmInsightRequest = async () => {
    setPreviewModalOpen(false);
    if (!previewTargetNode) return;
    // 记录请求日志
    try {
      const { logOutboundRequest } = await import('../db');
      await logOutboundRequest({
        queryKeyword: previewTargetNode.component_name || '',
        providerType: 'llm',
        providerName: '趋势分析',
        relatedComponentId: previewTargetNode.id,
        relatedComponentName: previewTargetNode.component_name,
        status: 'success',
      });
    } catch {}
    await handleNodeInsight(previewTargetNode);
  };

  // ====== 洞察 ======
  const handleNodeInsight = async (node: any) => {
    setInsightLoading(true);
    try {
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) { message.warning('未配置 LLM API Key，请先在「设置」中完成供应商配置'); return; }
      let workingNode = { ...node };
      if (!workingNode.trend_item_id) {
        const catType = workingNode.component_name?.includes('合金') || workingNode.component_name?.includes('树脂') || workingNode.component_name?.includes('钢') || workingNode.component_name?.includes('铝') ? '原材料映射' : '直接查询';
        workingNode.trend_item_id = await ensureTrendItem(workingNode.component_name, catType);
        await saveDecompositionNode({ ...workingNode, trend_item_id: workingNode.trend_item_id });
      }
      if (!workingNode.trend_item_id) { message.warning('无法创建趋势条目'); return; }

      // 获取激活的Skill列表（支持多选）
      const { getActiveSkills } = await import('../trendService');
      const skills = getActiveSkills();

      if (skills.length === 0) {
        message.warning('未选择任何Skill，请在设置中选择');
        return;
      }

      // 先搜索一次，然后用多个Skill分析
      message.loading({ content: `正在为「${workingNode.component_name}」搜索信息...`, key: 'insight', duration: 0 });
      const result = await agentSearchLoop(workingNode.component_name, '直接查询', undefined,
        (progress: string) => message.loading({ content: progress, key: 'insight', duration: 0 }));

      // 对每个激活的Skill生成洞察
      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        message.loading({ content: `正在按「${skill.name}」生成采购结论 (${i + 1}/${skills.length})...`, key: 'insight', duration: 0 });
        const structured = await createStructuredInsight(workingNode.component_name, skill, result.allSources, result.summary);
        const snapshotId = await saveTrendSnapshot({
          trend_item_id: workingNode.trend_item_id, source_type: 'direct_query', skill_used: skill.id,
          direction: structured.trend_direction, confidence_level: structured.confidence_level,
          magnitude_min: structured.magnitude_min, magnitude_max: structured.magnitude_max,
          magnitude_reference: structured.magnitude_reference, summary: structured.summary,
          suggested_action: structured.suggested_action, raw_search_results: JSON.stringify(result.allSources),
        });
        await saveTrendInsightDimensions(snapshotId, structured.dimensions || []);
        for (const event of structured.key_events || []) {
          if (event.event_description) await saveTrendKeyEvent({ ...event, trend_snapshot_id: snapshotId });
        }
      }

      await clearTrendSources(workingNode.trend_item_id);
      for (const source of result.allSources) {
        await saveTrendSource({ trend_item_id: workingNode.trend_item_id, source_title: source.title, source_url: source.url, excerpt: source.snippet });
      }
      await saveDecompositionNode({ ...workingNode, insight_status: 'queried' });
      message.destroy('insight');
      message.success(`「${workingNode.component_name}」洞察完成：使用了${skills.length}个Skill`);
      await loadTree();
      if (selectedId === workingNode.id) await selectNode(workingNode);
    } catch (e: any) {
      message.destroy('insight');
      message.error(`趋势查询失败：${e.message || '未知错误'}`);
    } finally {
      setInsightLoading(false);
    }
  };

  // ====== 节点追问 ======
  const handleNodeAsk = async () => {
    if (!convAsk.trim() || !selectedNode?.trend_item_id) return;
    const q = convAsk.trim(); setConvAsk(''); setConvLoading(true);
    try {
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) { message.warning('LLM 未配置'); setConvLoading(false); return; }
      const answer = await (await import('../trendService')).multiTurnAsk(
        snapshots.length > 0 ? snapshots[snapshots.length - 1]?.raw_search_results || '' : '',
        '', await getTrendConversations(selectedNode.trend_item_id), q
      );
      await (await import('../db')).saveTrendConversation({ trend_item_id: selectedNode.trend_item_id, question: q, answer });
      setConversations(await getTrendConversations(selectedNode.trend_item_id));
    } catch (e: any) { message.error(`追问失败：${e.message}`); setConvAsk(q); }
    setConvLoading(false);
  };

  // ====== Rollup ======
  const handleRollup = async (node: any) => {
    if (!node || !node.id) return;
    setRollupLoading(true);
    try {
      const children = nodes.filter((n: any) => n.parent_id === node.id && n.insight_status === 'queried' && n.trend_item_id);
      if (children.length === 0) { message.warning('没有已洞察的子节点可汇总'); setRollupLoading(false); return; }
      let totalWeight = 0, weightedScore = 0, uncertainWeight = 0;
      const childData: { name: string; cost: number; dir: string; conf: string; summary: string; magRef: string }[] = [];
      for (const child of children) {
        const snap = snapshotMap[child.trend_item_id];
        const costW = child.cost_ratio_estimate || 0;
        totalWeight += costW;
        if (snap?.direction === '信号不明确' || !snap?.direction) { uncertainWeight += costW; }
        else { weightedScore += (DIRECTION_VALUES[snap.direction] ?? 0) * costW; }
        childData.push({ name: child.component_name, cost: costW, dir: snap?.direction || '未查询', conf: snap?.confidence_level || '', summary: snap?.summary || '', magRef: snap?.magnitude_reference || '' });
      }
      const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
      const uncertainPct = totalWeight > 0 ? uncertainWeight / totalWeight : 0;
      const ruleDirection = avgScore > 0.15 ? '上涨' : avgScore < -0.15 ? '下降' : '震荡';
      let autoConfidence = Math.abs(avgScore) > 0.5 ? '高' : Math.abs(avgScore) > 0.2 ? '中' : '低';
      if (uncertainPct > 0.4) autoConfidence = '低';
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) { message.warning('未配置 LLM'); setRollupLoading(false); return; }
      const childSummary = childData.map(c => `- ${c.name}（成本占比${c.cost}%，趋势${c.dir}，置信度${c.conf}${c.magRef ? '，' + c.magRef : ''}）`).join('\n');
      const ruleSummary = `规则计算：加权方向得分${avgScore.toFixed(2)}，规则判断趋势${ruleDirection}，不确定子件占比${(uncertainPct * 100).toFixed(0)}%`;
      const response = await askLLM(`${ROLLUP_SKILL}\n\n## 本次输入\n父节点：${node.component_name}\n子节点数据：\n${childSummary}\n\n规则计算过程：${ruleSummary}\n\n请给出父节点的综合趋势判断。`, `请对「${node.component_name}」的子节点趋势进行汇总分析。`);
      let parsed: any;
      try {
        let jsonStr = response.trim();
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
        parsed = JSON.parse(jsonStr);
        if (!parsed.trend_direction) throw new Error('Missing direction');
      } catch { parsed = { trend_direction: ruleDirection, confidence_level: autoConfidence, summary: 'AI综合解析失败，使用规则计算结果。' + response.slice(0, 200) }; }
      const trendItemId = await ensureTrendItem(node.component_name + '（汇总）', '直接查询');
      const snapshotId = await saveTrendSnapshot({
        trend_item_id: trendItemId, source_type: 'aggregated',
        direction: parsed.trend_direction, confidence_level: parsed.confidence_level || autoConfidence,
        summary: `【基于${children.length}个子节点的综合研判】\n${ruleSummary}\n\n${parsed.summary || ''}`,
        suggested_action: parsed.suggested_action || '观望', magnitude_min: null, magnitude_max: null, magnitude_reference: '', raw_search_results: '',
      });
      for (const child of children) {
        const snap = snapshotMap[child.trend_item_id];
        await saveRollupContribution({ parent_snapshot_id: snapshotId, child_component_id: child.id, cost_ratio_used: child.cost_ratio_estimate ?? null, direction_used: snap?.direction || '' });
      }
      await saveDecompositionNode({ ...node, trend_item_id: trendItemId, insight_status: 'queried' });
      message.success(`「${node.component_name}」趋势汇总完成：${parsed.trend_direction}`);
      loadTree(); selectNode(node);
    } catch (e: any) { message.error(`汇总失败：${e.message || '未知错误'}`); }
    setRollupLoading(false);
  };

  // ====== Rollup 反馈 ======
  const handleRollupFeedback = () => {
    const snap = snapshots.filter(s => s.source_type === 'aggregated').pop();
    if (!snap) { message.warning('没有可修正的汇总结果'); return; }
    setFeedbackData({ direction: snap.direction, confidence: snap.confidence_level, summary: snap.summary, reason: '' });
    setFeedbackModalOpen(true);
  };
  const submitFeedback = async () => {
    if (!feedbackData.reason.trim()) { message.warning('请填写修正原因'); return; }
    const snap = snapshots.filter(s => s.source_type === 'aggregated').pop();
    if (!snap || !selectedNode) return;
    await saveRollupFeedback({
      component_id: selectedId, ai_direction: snap.direction, ai_summary: snap.summary, ai_confidence_level: snap.confidence_level,
      user_corrected_direction: feedbackData.direction, user_corrected_confidence_level: feedbackData.confidence,
      user_corrected_summary: feedbackData.summary, correction_reason: feedbackData.reason,
    });
    message.success('修正记录已保存'); setFeedbackModalOpen(false);
  };
  const openFeedbackHistory = async () => {
    setAllFeedback(await getAllRollupFeedback());
    setFeedbackHistoryOpen(true);
  };

  // ====== AI 起草 ======
  const handleAiDraft = async () => {
    if (!aiDraftName.trim()) return;
    setAiDraftLoading(true);
    try {
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) { message.warning('未配置 LLM'); setAiDraftLoading(false); return; }
      const parentInfo = aiDraftParentId ? await getDecompositionNode(aiDraftParentId) : null;
      const response = await askLLM(
        `你是物料结构专家。将"${aiDraftName}"分解为子组件。${parentInfo ? `这是「${parentInfo.component_name}」的子组件。` : ''}
输出 JSON 数组：[{"component_name":"名称","cost_ratio_estimate":数字,"node_type":"structural|terminal"}]
规则：3-8个，成本占比≤100。terminal表示末端物料，structural表示需继续拆解的。`,
        `请分解：${aiDraftName}`
      );
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error('非数组格式');
      setAiDraftResult(parsed.map((item: any) => ({ ...item, node_type: item.node_type || 'structural' })));
    } catch (e: any) { message.error(`AI 起草失败：${e.message}`); }
    setAiDraftLoading(false);
  };
  const confirmAiDraft = async () => {
    let count = 0;
    // 如果是顶层起草（parent_id == null），先创建根节点
    let rootId = aiDraftParentId;
    if (rootId === null && aiDraftName.trim()) {
      rootId = await saveDecompositionNode({
        parent_id: null,
        component_name: aiDraftName.trim(),
        cost_ratio_estimate: null,
        source_type: 'ai_draft',
        node_type: 'structural',
        insight_status: 'pending',
        trend_item_id: null,
      });
      count++;
    }
    for (const item of aiDraftResult) {
      if (!item.component_name) continue;
      await saveDecompositionNode({
        parent_id: rootId, component_name: item.component_name,
        cost_ratio_estimate: item.cost_ratio_estimate ?? null,
        source_type: 'ai_draft', node_type: item.node_type || 'structural',
        insight_status: 'pending', trend_item_id: null,
      });
      count++;
    }
    message.success(`已入库 ${count} 个节点`);
    setAiDraftOpen(false); setAiDraftName(''); setAiDraftResult([]); setAiDraftParentId(null);
    loadTree();
  };

  const confirmNode = async (node: any) => {
    // 如果是草稿节点，检查其父节点的所有子节点成本占比总和
    if (node.source_type === 'ai_draft' && node.parent_id) {
      const siblings = nodes.filter((n: any) => n.parent_id === node.parent_id);
      const draftSiblings = siblings.filter((n: any) => n.source_type === 'ai_draft');

      // 如果存在多个草稿子节点，检查成本占比总和
      if (draftSiblings.length > 1) {
        const totalRatio = draftSiblings.reduce((sum, n) => sum + (n.cost_ratio_estimate || 0), 0);

        // 允许99%-101%的误差范围
        if (totalRatio < 99 || totalRatio > 101) {
          const confirmed = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: '⚠️ 成本占比校验失败',
              content: (
                <div>
                  <p>当前父节点下的子节点成本占比总和为 <strong>{totalRatio.toFixed(1)}%</strong>，不在合理范围（99%-101%）内。</p>
                  <p>建议使用"按比例归一化"功能调整后再确认。</p>
                </div>
              ),
              okText: '仍然确认',
              cancelText: '取消',
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });

          if (!confirmed) return;
        }
      }
    }

    let tid = node.trend_item_id;
    if (node.node_type === 'terminal' && !tid) {
      const catType = node.component_name?.includes('合金') || node.component_name?.includes('树脂') || node.component_name?.includes('钢') ? '原材料映射' : '直接查询';
      tid = await ensureTrendItem(node.component_name, catType);
    }
    await saveDecompositionNode({ ...node, source_type: 'user_confirmed', trend_item_id: tid });
    message.success('已确认');
    selectNode(node); loadTree();
  };

  const handleSaveNode = async () => {
    if (!editingNode?.component_name) { message.warning('请输入名称'); return; }
    const nt = editingNode.node_type || 'structural';
    if (nt === 'terminal' && !editingNode.trend_item_id && editingNode.source_type === 'user_confirmed') {
      const catType = editingNode.component_name?.includes('合金') || editingNode.component_name?.includes('树脂') || editingNode.component_name?.includes('钢') ? '原材料映射' : '直接查询';
      editingNode.trend_item_id = await ensureTrendItem(editingNode.component_name, catType);
    }
    await saveDecompositionNode({ ...editingNode, node_type: nt });
    setEditModalOpen(false); setEditingNode(null); message.success('已保存');
    loadTree(); if (selectedId) selectNode(await getDecompositionNode(selectedId));
  };

  const handleLinkTrend = async (nodeId: number, tid: number | null) => {
    const node = await getDecompositionNode(nodeId);
    await saveDecompositionNode({ ...node, trend_item_id: tid, insight_status: tid ? (node.insight_status === 'pending' ? 'pending' : 'queried') : 'pending' });
    message.success(tid ? '已关联' : '已取消');
    selectNode(node); loadTree();
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    const results = await searchDecompositionNodes(searchQuery.trim());
    if (results.length === 0) { message.info('无匹配节点'); return; }
    const match = results[0];
    let root = match;
    const nodeById = new Map<number, any>(nodes.map((node: any) => [node.id, node]));
    const visited = new Set<number>();
    while (root?.parent_id && !visited.has(root.id)) {
      visited.add(root.id);
      root = nodeById.get(root.parent_id) || root;
    }
    if (view !== 'tree' || rootNodeId !== root.id) await enterTreeView(root.id);
    setSelectedId(match.id);
    await selectNode(match);
    setCanvasHintVisible(false);
    setTimeout(() => {
      const target = rfNodes.find((node: any) => node.id === String(match.id));
      if (target && flowInstance) flowInstance.setCenter(target.position.x + 100, target.position.y + 50, { zoom: 1.15, duration: 420 });
    }, 80);
    if (results.length > 1) message.success(`已定位「${match.component_name}」，另有 ${results.length - 1} 条匹配`);
  };

  // ====== 批量确认草稿 ======
  const handleBatchConfirmDrafts = async () => {
    const drafts = nodes.filter((n: any) => checkedIds.has(n.id) && n.source_type === 'ai_draft');
    if (drafts.length === 0) { message.warning('未选中任何草稿节点'); return; }
    let done = 0, fail = 0;
    for (const node of drafts) {
      try {
        await confirmNode(node);
        done++;
      } catch { fail++; }
    }
    message.success(`批量确认完成：${done} 成功${fail > 0 ? `，${fail} 失败` : ''}`);
    setCheckedIds(new Set());
    loadTree();
  };

  // ====== 批量拆解（先生成草稿预览，不自动入库） ======
  const [batchDecomposeResults, setBatchDecomposeResults] = useState<{ parentId: number; parentName: string; items: any[] }[]>([]);
  const [batchDecomposeLoading, setBatchDecomposeLoading] = useState(false);
  const [costRatioWarning, setCostRatioWarning] = useState<string | null>(null);

  const runBatchDecompose = () => setBatchDecomposeOpen(true);

  const confirmBatchDecompose = async () => {
    const selected = nodes.filter((n: any) => checkedIds.has(n.id) && n.node_type === 'structural');
    if (selected.length === 0) { message.warning('未选中 structural 节点'); return; }
    setBatchDecomposeOpen(false);
    setBatchDecomposeLoading(true);
    setBatchProgress({ done: 0, total: selected.length });
    const allResults: { parentId: number; parentName: string; items: any[] }[] = [];
    let done = 0;
    for (const node of selected) {
      try {
        const response = await askLLM(
          `将"${node.component_name}"分解为子组件。输出JSON数组：[{"component_name":"名称","cost_ratio_estimate":数字（占${node.component_name}的百分比，所有子项之和应为100）, "node_type":"structural|terminal"}]
规则：3-8个子项，cost_ratio_estimate之和应接近100；terminal表示不可再拆的终端物料，structural表示可继续拆解的结构节点。`,
          `分解：${node.component_name}`
        );
        let jsonStr = response.trim();
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          allResults.push({
            parentId: node.id,
            parentName: node.component_name,
            items: parsed.map((item: any) => ({
              component_name: item.component_name,
              cost_ratio_estimate: item.cost_ratio_estimate ?? null,
              node_type: item.node_type || 'structural',
            })),
          });
        }
        done++;
      } catch { done++; }
      setBatchProgress({ done, total: selected.length });
    }
    setBatchProgress({ done: 0, total: 0 });
    setBatchDecomposeLoading(false);

    if (allResults.length > 0) {
      // 校验成本占比
      let warning = '';
      for (const r of allResults) {
        const itemsWithCost = r.items.filter(i => i.cost_ratio_estimate != null);
        if (itemsWithCost.length > 1) {
          const sum = itemsWithCost.reduce((s, i) => s + i.cost_ratio_estimate, 0);
          if (sum < 90 || sum > 110) {
            warning += `「${r.parentName}」子节点成本占比总和为${sum.toFixed(0)}%，与100%不符。`;
          }
        }
      }
      setCostRatioWarning(warning || null);
      setBatchDecomposeResults(allResults);
      setBatchDecomposeOpen(true); // 重新打开弹窗预览
    }
  };

  // 批量归一化：将同一父节点下的子节点占比等比例缩放到100%
  const normalizeCostRatios = () => {
    setBatchDecomposeResults(prev =>
      prev.map(r => {
        const itemsWithCost = r.items.filter(i => i.cost_ratio_estimate != null);
        if (itemsWithCost.length > 1) {
          const sum = itemsWithCost.reduce((s, i) => s + i.cost_ratio_estimate, 0);
          if (Math.abs(sum - 100) > 0.5) {
            const ratio = 100 / sum;
            return {
              ...r,
              items: r.items.map(i => ({
                ...i,
                cost_ratio_estimate: i.cost_ratio_estimate != null ? Math.round(i.cost_ratio_estimate * ratio * 10) / 10 : null,
              })),
            };
          }
        }
        return r;
      })
    );
    setCostRatioWarning(null);
    message.success('已按比例归一化到100%');
  };

  // 确认批量拆解草稿入库（仅入库为草稿，不自动确认）
  const confirmBatchDecomposeDrafts = async () => {
    // 校验每个父节点下的子节点成本占比总和
    const warnings: string[] = [];
    for (const result of batchDecomposeResults) {
      const itemsWithRatio = result.items.filter(i => i.cost_ratio_estimate != null && i.component_name);
      if (itemsWithRatio.length > 1) {
        const totalRatio = itemsWithRatio.reduce((sum, i) => sum + i.cost_ratio_estimate, 0);
        if (totalRatio < 99 || totalRatio > 101) {
          warnings.push(`「${result.parentName}」的子节点占比总和为 ${totalRatio.toFixed(1)}%`);
        }
      }
    }

    if (warnings.length > 0) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '⚠️ 成本占比校验失败',
          content: (
            <div>
              <p>以下父节点的子节点成本占比总和不在合理范围（99%-101%）内：</p>
              <ul style={{ marginTop: 8 }}>
                {warnings.map((w, idx) => <li key={idx}>{w}</li>)}
              </ul>
              <p style={{ marginTop: 12 }}>建议先使用"自动归一化到100%"功能调整后再确认入库。</p>
            </div>
          ),
          okText: '仍然入库',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });

      if (!confirmed) return;
    }

    let count = 0;
    for (const result of batchDecomposeResults) {
      const parentId = result.parentId;
      for (const item of result.items) {
        if (!item.component_name) continue;
        await saveDecompositionNode({
          parent_id: parentId, component_name: item.component_name,
          cost_ratio_estimate: item.cost_ratio_estimate ?? null,
          source_type: 'ai_draft', node_type: item.node_type || 'structural',
          insight_status: 'pending', trend_item_id: null,
        });
        count++;
      }
    }
    message.success(`已入库 ${count} 个草稿节点，请勾选后使用「批量确认」完成确认`);
    setBatchDecomposeOpen(false);
    setBatchDecomposeResults([]);
    setCostRatioWarning(null);
    setCheckedIds(new Set());
    loadTree();
  };

  // ====== 批量洞察 ======

  // ====== 批量洞察 ======
  const runBatchInsight = () => setBatchInsightOpen(true);
  const confirmBatchInsight = async () => {
    const selected = nodes.filter((n: any) => checkedIds.has(n.id) && n.node_type === 'terminal');
    if (selected.length === 0) { message.warning('未选中 terminal 节点'); return; }
    setBatchInsightOpen(false);
    setBatchProgress({ done: 0, total: selected.length });
    let done = 0;
    for (const node of selected) {
      try { await handleNodeInsight(node); done++; } catch { done++; }
      setBatchProgress({ done, total: selected.length });
      if (done < selected.length) await new Promise(r => setTimeout(r, 1500));
    }
    setBatchProgress({ done: 0, total: 0 });
    message.success(`批量洞察完成：${done}/${selected.length}`);
    setCheckedIds(new Set());
  };

  // ====== 导出 ======
  const handleExport = () => {
    const monitored = nodes.filter((n: any) => n.trend_item_id && snapshotMap[n.trend_item_id]?.direction);
    if (monitored.length === 0) { message.warning('无数据'); return; }
    let text = `CostHub 物料谈判摘要\n${'='.repeat(40)}\n导出：${new Date().toLocaleString()}\n\n`;
    for (const n of monitored) {
      const snap = snapshotMap[n.trend_item_id]; if (!snap) continue;
      const src = snap.source_type === 'aggregated' ? '（汇总）' : '';
      text += `【${n.component_name}】${TREND_ICONS[snap.direction] || ''} ${snap.direction}${src}\n  ${n.cost_ratio_estimate != null ? `成本~${n.cost_ratio_estimate}%` : ''} 置信度${snap.confidence_level || '-'}\n  ${snap.summary ? snap.summary.slice(0, 200) + '\n' : ''}\n`;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = `CostHub_摘要_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click(); URL.revokeObjectURL(a.href); message.success('已导出');
  };

  // ====== 进入树视图 ======
  const enterTreeView = async (rootId: number) => {
    const root = nodes.find((n: any) => n.id === rootId);
    setRootNodeId(rootId);
    setRootNodeName(root?.component_name || '');
    setView('tree');
    setCheckedIds(new Set());
  };

  // ====== 返回清单视图 ======
  const backToList = () => {
    setView('list');
    setRootNodeId(null);
    setSelectedNode(null);
    setSelectedId(null);
  };

  // ====== 清单页：批量重命名 ======
  const handleBatchRename = () => {
    const selected = nodes.filter((n: any) => n.parent_id == null && listChecked.has(n.id));
    if (selected.length === 0) { message.warning('请先选择顶层物料'); return; }
    if (selected.length > 1) { message.warning('一次只能重命名一个顶层物料'); return; }
    setRenameValue(selected[0].component_name);
    setRenameModalOpen(true);
  };
  const confirmRename = async () => {
    const selected = nodes.filter((n: any) => n.parent_id == null && listChecked.has(n.id));
    if (selected.length !== 1 || !renameValue.trim()) return;
    await saveDecompositionNode({ ...selected[0], component_name: renameValue.trim() });
    message.success('已重命名');
    setRenameModalOpen(false); loadTree();
  };
  const handleBatchDelete = async () => {
    const selected = nodes.filter((n: any) => n.parent_id == null && listChecked.has(n.id));
    if (selected.length === 0) return;
    Modal.confirm({
      title: `删除 ${selected.length} 个顶层物料及其整棵树？`,
      content: '该操作不可恢复。',
      okType: 'danger',
      onOk: async () => {
        for (const n of selected) await deleteDecompositionNode(n.id);
        message.success(`已删除 ${selected.length} 个`);
        setListChecked(new Set()); loadTree();
      },
    });
  };

  // ====== 计算状态 ======
  const rootNodes = useMemo(() => nodes.filter((n: any) => n.parent_id == null), [nodes]);
  const topLevelNodes = rootNodes;
  const structuralSelected = nodes.filter((n: any) => n.node_type === 'structural' && checkedIds.has(n.id)).length;
  const terminalSelected = nodes.filter((n: any) => n.node_type === 'terminal' && checkedIds.has(n.id)).length;
  const draftSelected = nodes.filter((n: any) => n.source_type === 'ai_draft' && checkedIds.has(n.id)).length;
  const canRollup = selectedNode && selectedNode.id && !(selectedNode.node_type === 'terminal');
  const childrenQueried = selectedNode ? nodes.filter((n: any) => n.parent_id === selectedNode.id && n.insight_status === 'queried') : [];
  const childrenTotal = selectedNode ? nodes.filter((n: any) => n.parent_id === selectedNode.id) : [];

  // ====== 清单页统计 ======
  const getRootStats = (rootId: number) => {
    const children = nodes.filter((n: any) => {
      let p = n.parent_id;
      while (p) {
        if (p === rootId) return true;
        const parent = nodes.find((x: any) => x.id === p);
        p = parent?.parent_id;
      }
      return false;
    });
    const confirmed = children.filter((n: any) => n.source_type === 'user_confirmed').length;
    const pendingInsight = children.filter((n: any) => n.node_type === 'terminal' && n.insight_status === 'pending').length;
    return { total: children.length, confirmed, pendingInsight };
  };

  // ====== 渲染：清单页 ======
  if (view === 'list') {
    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;
    return (
      <div style={{ padding: '0 20px', maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="page-title" style={{ marginBottom: 0 }}>
            <span className="emoji">📡</span> 物料趋势洞察
          </div>
          <Space>
            <Button icon={<DownloadOutlined />} size="small" onClick={handleExport}>导出</Button>
            <Button icon={<MergeCellsOutlined />} size="small" onClick={openFeedbackHistory}>修正记录</Button>
          </Space>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          管理所有进行物料分解分析的顶层物料清单。点击物料名称进入该物料的分解树详情页。
        </p>

        {/* 操作栏 */}
        <Space style={{ marginBottom: 16 }}>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => { setAiDraftParentId(null); setAiDraftName(''); setAiDraftResult([]); setAiDraftOpen(true); }}>
            AI 起草顶层物料
          </Button>
          <Button icon={<PlusOutlined />} onClick={() => {
            setEditingNode({ parent_id: null, component_name: '', cost_ratio_estimate: null, source_type: 'user_confirmed', node_type: 'structural', insight_status: 'pending', trend_item_id: null });
            setEditModalOpen(true);
          }}>手动添加</Button>
          {listChecked.size > 0 && (
            <>
              <Button size="small" icon={<EditOutlined />} onClick={handleBatchRename}>重命名</Button>
              <Button size="small" danger icon={<DeleteOutlined />} onClick={handleBatchDelete}>删除 ({listChecked.size})</Button>
            </>
          )}
        </Space>

        {/* 关注物料区域 */}
        {watchedParts.length > 0 && (
          <Card
            size="small"
            title={
              <Space>
                <RadarChartOutlined style={{ color: '#8B5CF6' }} />
                <span>关注物料 ({watchedParts.length})</span>
              </Space>
            }
            style={{ marginBottom: 20, borderTop: '3px solid #8B5CF6' }}
          >
            <Row gutter={[12, 12]}>
              {watchedParts.map((part: any) => (
                <Col key={part.id} xs={24} sm={12} md={8} lg={6}>
                  <Card
                    size="small"
                    hoverable
                    style={{
                      borderLeft: `3px solid ${getCategoryColor(part.main_category)}`,
                    }}
                    bodyStyle={{ padding: '10px 12px' }}
                    actions={[
                      <Button
                        key="insight"
                        size="small"
                        type="primary"
                        icon={<RadarChartOutlined />}
                        onClick={async () => {
                          // 复用正式的洞察逻辑：创建/查找 trend_item，发起洞察，结果落库
                          try {
                            const { getTrendItemByCategory, saveTrendItem } = await import('../db');
                            let trendItem = await getTrendItemByCategory(part.name, part.main_category);

                            if (!trendItem) {
                              // 创建 trend_item
                              const newId = await saveTrendItem({
                                material_name: part.name,
                                category_type: part.main_category,
                                last_queried_at: new Date().toISOString(),
                              });
                              trendItem = { id: newId, material_name: part.name, category_type: part.main_category };
                            }

                            // 使用与树节点相同的洞察逻辑（会落库到 trend_snapshots）
                            // 模拟一个树节点结构
                            const mockNode = {
                              id: -1, // 临时ID，不影响实际逻辑
                              component_name: part.name,
                              node_type: 'terminal',
                              trend_item_id: trendItem.id,
                            };

                            // 调用正式的洞察预览确认流程
                            await requestInsightWithPreview(mockNode);
                          } catch (e: any) {
                            message.error('洞察失败: ' + (e.message || '未知错误'));
                          }
                        }}
                      >
                        洞察
                      </Button>,
                      <Popconfirm
                        key="remove"
                        title="取消关注此物料？"
                        onConfirm={async () => {
                          try {
                            const { savePart } = await import('../db');
                            await savePart({ ...part, trend_enabled: 0 });
                            message.success('已取消关注');
                            loadWatchedParts();
                          } catch {
                            message.error('操作失败');
                          }
                        }}
                      >
                        <Button key="delete" size="small" danger icon={<DeleteOutlined />}>
                          移除
                        </Button>
                      </Popconfirm>,
                    ]}
                  >
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                        {part.name}
                      </div>
                      {part.model && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          型号: {part.model}
                        </div>
                      )}
                      <Tag color={getCategoryColor(part.main_category)} style={{ fontSize: 10, marginTop: 4 }}>
                        {part.main_category}
                      </Tag>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              💡 在"器件库"中开启"关注趋势"可将物料添加到此列表
            </div>
          </Card>
        )}

        {/* 顶层物料标题 */}
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>
          🌳 顶层物料清单
        </h3>

        {topLevelNodes.length === 0 ? (
          <Empty description="暂无顶层物料数据" style={{ marginTop: 60 }}>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => { setAiDraftParentId(null); setAiDraftName(''); setAiDraftResult([]); setAiDraftOpen(true); }}>
              开始 AI 起草
            </Button>
          </Empty>
        ) : (
          <Row gutter={[16, 16]}>
            {topLevelNodes.map((node: any) => {
              const stats = getRootStats(node.id);
              const snap = snapshotMap[node.trend_item_id];
              const trendDir = snap?.direction || '';
              return (
                <Col key={node.id} xs={24} sm={12} lg={8}>
                  <Card
                    hoverable
                    size="small"
                    style={{ borderLeft: `4px solid ${TREND_COLORS[trendDir] || '#3B82F6'}` }}
                    actions={[
                      <Tooltip key="enter" title="进入分解树">
                        <BranchesOutlined onClick={() => enterTreeView(node.id)} />
                      </Tooltip>,
                      <Tooltip key="decompose" title="进入后 AI 拆解子件">
                        <ThunderboltOutlined onClick={() => { enterTreeView(node.id); setTimeout(() => { setAiDraftParentId(node.id); setAiDraftName(node.component_name); setAiDraftResult([]); setAiDraftOpen(true); }, 120); }} />
                      </Tooltip>,
                      <Tooltip key="insight" title="洞察顶层物料行情">
                        <RadarChartOutlined onClick={() => requestInsightWithPreview(node)} style={{ color: '#8B5CF6' }} />
                      </Tooltip>,
                      <Tooltip key="rename" title="重命名">
                        <EditOutlined onClick={() => { setListChecked(new Set([node.id])); setRenameValue(node.component_name); setRenameModalOpen(true); }} />
                      </Tooltip>,
                      <Tooltip key="del" title="删除">
                        <DeleteOutlined onClick={() => {
                          Modal.confirm({ title: '删除该顶层物料？', okType: 'danger', onOk: async () => { await deleteDecompositionNode(node.id); loadTree(); } });
                        }} />
                      </Tooltip>,
                    ]}
                  >
                    <Card.Meta
                      title={
                        <a onClick={() => enterTreeView(node.id)} style={{ fontWeight: 600 }}>
                          {node.component_name}
                        </a>
                      }
                      description={
                        <div style={{ fontSize: 12, lineHeight: '2' }}>
                          {snap && <Tag color={TREND_COLORS[trendDir]} style={{ fontSize: 10 }}>{TREND_ICONS[trendDir]} {trendDir}</Tag>}
                          <div>📦 {stats.total} 个节点 · {stats.confirmed} 已确认</div>
                          <Space size={6} style={{ marginTop: 4 }}>
                            <Button size="small" type="primary" icon={<BranchesOutlined />} onClick={() => enterTreeView(node.id)}>查看分解树</Button>
                            <Button size="small" icon={<RadarChartOutlined />} onClick={() => requestInsightWithPreview(node)}>AI 洞察</Button>
                          </Space>
                          {stats.pendingInsight > 0 && <div style={{ color: '#F59E0B' }}>⏳ {stats.pendingInsight} 个待洞察</div>}
                          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                            {node.updated_at ? `更新于 ${node.updated_at.slice(0, 10)}` : ''}
                          </div>
                        </div>
                      }
                    />
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}

        {/* 清单页共用弹窗 */}
        <Modal title="重命名顶层物料" open={renameModalOpen} onCancel={() => setRenameModalOpen(false)} onOk={confirmRename}>
          <Input value={renameValue} onChange={e => setRenameValue(e.target.value)} placeholder="输入新名称" />
        </Modal>
        {renderModals()}
      </div>
    );
  }

  // ====== 渲染：树详情页 ======
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: 'calc(100vh - 60px)', padding: '0 4px' }}>
      {/* 顶部导航 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
        <Space>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={backToList} size="small">
            返回清单
          </Button>
          <Typography.Text style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            物料趋势洞察 <span style={{ margin: '0 4px' }}>›</span>
          </Typography.Text>
          <Typography.Text strong style={{ fontSize: 14 }}>{rootNodeName}</Typography.Text>
        </Space>
        <Space size={4}>
          <Input prefix={<SearchOutlined />} placeholder="搜索节点..." value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)} onPressEnter={handleSearch} size="small" style={{ width: 140 }} />
          <Button size="small" icon={<SearchOutlined />} onClick={handleSearch} />
          <Tooltip title="导出"><Button size="small" icon={<DownloadOutlined />} onClick={handleExport} /></Tooltip>
          <Tooltip title="修正记录"><Button size="small" icon={<MergeCellsOutlined />} onClick={openFeedbackHistory} /></Tooltip>
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        {/* 左侧 React Flow */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 300 }}>
          {/* 操作栏 */}
          <Space style={{ flexWrap: 'wrap' }}>
            <Button icon={<ThunderboltOutlined />} size="small" type="primary"
              onClick={() => { setAiDraftParentId(selectedId || rootNodeId); setAiDraftName(''); setAiDraftResult([]); setAiDraftOpen(true); }}>
              AI 拆解子件
            </Button>
            <Button icon={<PlusOutlined />} size="small"
              onClick={() => {
                setEditingNode({ parent_id: selectedId || rootNodeId, component_name: '', cost_ratio_estimate: null, source_type: 'user_confirmed', node_type: 'structural', insight_status: 'pending', trend_item_id: null });
                setEditModalOpen(true);
              }}>手动加节点</Button>
            <div style={{ flex: 1 }} />
            {selectedNode?.source_type === 'ai_draft' && (
              <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => confirmNode(selectedNode)}>确认草稿</Button>
            )}
            <Tooltip title="批量确认草稿">
              <Button size="small" icon={<CheckOutlined />} disabled={draftSelected === 0} onClick={handleBatchConfirmDrafts}>
                批量确认 ({draftSelected})
              </Button>
            </Tooltip>
            <Tooltip title="批量拆解">
              <Button size="small" icon={<ThunderboltOutlined />} disabled={structuralSelected === 0} onClick={runBatchDecompose} />
            </Tooltip>
            <Tooltip title="批量洞察">
              <Button size="small" icon={<RadarChartOutlined />} disabled={terminalSelected === 0} onClick={runBatchInsight} />
            </Tooltip>
          </Space>

          {/* React Flow 画布 */}
          <div className="content-card" style={{ flex: 1, overflow: 'hidden', minHeight: 400, padding: 0 }}>
            {rfNodes.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <Empty description="暂无树节点数据" />
              </div>
            ) : (
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onPaneClick={() => { setSelectedId(null); setSelectedNode(null); setCanvasHintVisible(true); setRfNodes((current: any[]) => current.map((node: any) => ({ ...node, selected: false }))); }}
                onInit={setFlowInstance}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.22, maxZoom: 1.15 }}
                attributionPosition="bottom-left"
                minZoom={0.25}
                maxZoom={2.8}
                defaultEdgeOptions={{ type: 'smoothstep' }}
                nodesDraggable
                nodesConnectable={false}
                elementsSelectable
              >
                <Controls showInteractive={false} />
                <Background color="var(--card-border, #E2E8F0)" gap={22} size={1} />
                <MiniMap
                  nodeStrokeColor="var(--text-muted, #64748B)"
                  nodeColor={(node: any) => (node.data as any)?.trendColor || '#94A3B8'}
                  nodeBorderRadius={8}
                  pannable
                  zoomable
                  style={{ border: '1px solid var(--card-border, #E2E8F0)', borderRadius: 8, background: 'var(--card-bg, #fff)' } as any}
                />
                <Panel position="top-left">
                  <div style={{ padding: '8px 10px', borderRadius: 10, background: 'color-mix(in srgb, var(--card-bg, #fff) 92%, transparent)', border: '1px solid var(--card-border, #E2E8F0)', boxShadow: '0 4px 12px rgba(15,23,42,0.08)', fontSize: 11, color: 'var(--text-secondary, #475569)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 3 }}>🌳 智能分解画布</div>
                    {canvasHintVisible ? '点击节点查看详情；终端节点可直接洞察，结构节点可继续拆解。' : '拖拽调整布局 · 滚轮缩放 · 点击空白处取消选择'}
                  </div>
                </Panel>
                <Panel position="top-right">
                  <Space size={4}>
                    <Button size="small" onClick={() => flowInstance?.fitView({ padding: 0.22, duration: 360, maxZoom: 1.15 })}>适应画布</Button>
                    <Button size="small" onClick={() => flowInstance?.zoomIn({ duration: 180 })}>+</Button>
                    <Button size="small" onClick={() => flowInstance?.zoomOut({ duration: 180 })}>−</Button>
                  </Space>
                </Panel>
              </ReactFlow>
            )}
          </div>
        </div>

        {/* 右侧详情面板 */}
        <div style={{ width: 420, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {!selectedNode ? (
            <div className="content-card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Empty description="点击树节点查看详情" />
            </div>
          ) : (
            <div style={{ overflow: 'auto', flex: 1 }}>
              {/* 标题 + 操作 */}
              <div className="content-card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <h3 style={{ margin: 0, display: 'inline' }}>{selectedNode.component_name}</h3>
                    <Tag color={selectedNode.node_type === 'terminal' ? 'orange' : 'blue'} style={{ marginLeft: 8 }}>
                      {selectedNode.node_type === 'terminal' ? '终端' : '结构'}
                    </Tag>
                    {selectedNode.insight_status === 'pending' && selectedNode.node_type === 'terminal' && <Tag color="gold">⏳待洞察</Tag>}
                    {rollupResult?.source_type === 'aggregated' && <Tag color="purple">📊已汇总</Tag>}
                  </div>
                  <Space wrap>
                    {selectedNode.source_type === 'ai_draft' && (
                      <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => confirmNode(selectedNode)}>确认</Button>
                    )}
                    {selectedNode.source_type === 'user_confirmed' && selectedNode.node_type !== 'terminal' && (
                      <Button size="small" icon={<ThunderboltOutlined />} onClick={() => { setAiDraftParentId(selectedNode.id); setAiDraftName(selectedNode.component_name); setAiDraftResult([]); setAiDraftOpen(true); }}>⚡拆解</Button>
                    )}
                    {/* 终端节点：发起洞察 */}
                    {selectedNode.source_type === 'user_confirmed' && selectedNode.node_type === 'terminal' && (
                      <Tooltip title="只发送物料通用名称，不包含本地价格、供应商和 BOM 数据。">
                        <Button size="small" type="primary" icon={<RadarChartOutlined />}
                          onClick={() => requestInsightWithPreview(selectedNode)} loading={insightLoading}>
                          🔍 {selectedNode.insight_status === 'queried' ? '重新洞察行情' : 'AI 洞察行情'}
                        </Button>
                      </Tooltip>
                    )}
                    {/* 结构节点：既可以直接洞察，也可以汇总子节点 */}
                    {selectedNode.source_type === 'user_confirmed' && selectedNode.node_type !== 'terminal' && (
                      <Space size={8}>
                        <Tooltip title="直接对该结构节点发起市场行情洞察">
                          <Button size="small" icon={<RadarChartOutlined />} type="primary"
                            onClick={() => requestInsightWithPreview(selectedNode)} loading={insightLoading}>
                            🔍 洞察行情
                          </Button>
                        </Tooltip>
                        {canRollup && childrenTotal.length > 0 && childrenQueried.length > 0 && (
                          <Tooltip title="从已洞察的子节点汇总综合判断">
                            <Button size="small" icon={<ApartmentOutlined />} onClick={() => handleRollup(selectedNode)} loading={rollupLoading}>
                              汇总子节点 ({childrenQueried.length}/{childrenTotal.length})
                            </Button>
                          </Tooltip>
                        )}
                      </Space>
                    )}
                    {/* 旧的汇总按钮（已整合到上面） */}
                    {false && canRollup && childrenTotal.length > 0 && childrenQueried.length > 0 && (
                      <Button size="small" icon={<ApartmentOutlined />} onClick={() => handleRollup(selectedNode)} loading={rollupLoading}>
                        汇总 ({childrenQueried.length}/{childrenTotal.length})
                      </Button>
                    )}
                    {rollupResult?.source_type === 'aggregated' && (
                      <Button size="small" icon={<EditOutlined />} onClick={handleRollupFeedback}>修正</Button>
                    )}
                    <Button size="small" icon={<EditOutlined />} onClick={() => { setEditingNode({ ...selectedNode }); setEditModalOpen(true); }}>编辑</Button>
                    <Popconfirm title="删除？" onConfirm={async () => { await deleteDecompositionNode(selectedNode.id); setSelectedNode(null); setSelectedId(null); loadTree(); }}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>

                {selectedNode.node_type !== 'terminal' && childrenTotal.length > 0 && childrenQueried.length < childrenTotal.length && (
                  <div style={{ fontSize: 12, color: '#F59E0B', marginBottom: 8, padding: '4px 8px', background: '#FFF7ED', borderRadius: 6 }}>
                    ⚠️ {childrenQueried.length}/{childrenTotal.length} 个子节点已洞察，汇总可能不完整。
                  </div>
                )}

                {rollupResult?.source_type === 'aggregated' && (
                  <div style={{ marginBottom: 12, padding: 12, background: 'var(--main-bg)', borderRadius: 10, border: '1px solid #C4B5FD' }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>📊 趋势汇总</div>
                    <Space><Tag color={TREND_COLORS[rollupResult.direction]} style={{ fontSize: 13 }}>{TREND_ICONS[rollupResult.direction]} {rollupResult.direction}</Tag><Tag>{rollupResult.confidence_level}置信</Tag><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rollupResult.query_time?.slice(0, 10)}</span></Space>
                    <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{rollupResult.summary}</ReactMarkdown></div>
                  </div>
                )}

                {(() => {
                  const directSnaps = snapshots.filter(s => s.source_type !== 'aggregated');
                  if (directSnaps.length === 0) return null;
                  const s = directSnaps[directSnaps.length - 1];
                  if (!s) return null;
                  return (
                    <div style={{ marginBottom: 12, padding: 12, background: 'var(--main-bg)', borderRadius: 10, border: '1px solid var(--card-border)' }}>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>📡 最新洞察 {s.skill_used ? <Tag style={{ fontSize: 10 }}>框架：{s.skill_used}</Tag> : null}</div>
                      <Space><Tag color={TREND_COLORS[s.direction]} style={{ fontSize: 13 }}>{TREND_ICONS[s.direction]} {s.direction}</Tag><Tag>{s.confidence_level}置信</Tag>{s.magnitude_min != null && <Tag>幅度 {s.magnitude_min}%~{s.magnitude_max}%</Tag>}<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.query_time?.slice(0, 10)}</span></Space>
                      <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{s.summary}</ReactMarkdown></div>
                      {/* 维度展示 */}
                      {insightDimensions.length > 0 && (
                        <div style={{ marginTop: 12, borderTop: '1px solid var(--card-border)', paddingTop: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>📋 分维度分析</div>
                            {availableHistoryTimes.length > 1 && (
                              <Select
                                size="small"
                                value={selectedHistoryTime}
                                onChange={async (value) => {
                                  setSelectedHistoryTime(value);
                                  const directSnaps = snapshots.filter((s: any) => s.source_type !== 'aggregated');
                                  await loadInsightDimensionsByTime(directSnaps, value);
                                }}
                                style={{ width: 180, fontSize: 11 }}
                                options={availableHistoryTimes.map(time => ({
                                  value: time,
                                  label: time ? new Date(time).toLocaleString('zh-CN') : '未知时间'
                                }))}
                              />
                            )}
                          </div>
                          {/* 按skill分组显示 */}
                          {(() => {
                            const groupedBySkill: Record<string, any[]> = {};
                            insightDimensions.forEach(dim => {
                              const skillId = dim._skill_used || 'unknown';
                              if (!groupedBySkill[skillId]) groupedBySkill[skillId] = [];
                              groupedBySkill[skillId].push(dim);
                            });

                            const skillCount = Object.keys(groupedBySkill).length;

                            // 如果有多个Skill，显示综合建议
                            if (skillCount > 1) {
                              return (
                                <>
                                  {/* 综合建议 */}
                                  <div style={{
                                    marginBottom: 16,
                                    padding: 16,
                                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                    borderRadius: 12,
                                    color: 'white'
                                  }}>
                                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span>💡</span>
                                      <span>多维度综合洞察</span>
                                    </div>
                                    <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.95 }}>
                                      本次使用了 {skillCount} 个分析框架，从不同角度分析物料趋势。建议综合参考各框架的核心结论，重点关注<strong>证据强度为"强"</strong>的维度。
                                    </div>
                                  </div>

                                  {/* Skill对比视图 */}
                                  <div style={{ display: 'grid', gridTemplateColumns: skillCount === 2 ? '1fr 1fr' : '1fr', gap: 12 }}>
                                    {Object.entries(groupedBySkill).map(([skillId, dims]) => {
                                      const skill = BUILTIN_SKILLS.find((s: any) => s.id === skillId);
                                      const skillName = skill ? skill.name : skillId;
                                      const skillIcon = skill ? skill.icon : '📊';

                                      return (
                                        <div key={skillId} style={{
                                          padding: 12,
                                          background: '#ffffff',
                                          borderRadius: 12,
                                          border: '2px solid #e5e7eb',
                                          boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                                        }}>
                                          <div style={{
                                            fontWeight: 600,
                                            marginBottom: 12,
                                            fontSize: 14,
                                            color: '#111827',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            paddingBottom: 8,
                                            borderBottom: '2px solid #f3f4f6'
                                          }}>
                                            <span style={{ fontSize: 18 }}>{skillIcon}</span>
                                            <span>{skillName}</span>
                                          </div>
                                          {dims.map((dim: any, idx: number) => {
                            const evidenceColors: Record<string, string> = { '强': '#10B981', '中': '#3B82F6', '弱': '#F59E0B', '未验证': '#94A3B8' };
                            return (
                              <div key={idx} style={{ marginBottom: 10, padding: '8px 10px', background: '#FFF', borderRadius: 8, border: '1px solid #E2E8F0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600, fontSize: 13 }}>🔹 {dim.dimension_type}</span>
                                  <Tag color={evidenceColors[dim.evidence_strength] || '#94A3B8'} style={{ fontSize: 9, margin: 0 }}>{dim.evidence_strength}</Tag>
                                </div>
                                <div style={{ fontSize: 12, lineHeight: 1.6, color: '#334155' }}>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{dim.content}</ReactMarkdown>
                                </div>
                                {dim.source_url && (
                                  <div style={{ marginTop: 4 }}>
                                    <a
                                      href="#"
                                      onClick={async (e) => {
                                        e.preventDefault();
                                        try {
                                          const { invoke } = await import('@tauri-apps/api/core');
                                          await invoke('open_url', { url: dim.source_url });
                                        } catch (err) {
                                          console.error('打开链接失败:', err);
                                          message.error('无法打开链接');
                                        }
                                      }}
                                      style={{ fontSize: 11, color: '#3B82F6', cursor: 'pointer' }}
                                    >
                                      🔗 {dim.source_title || dim.source_url}
                                    </a>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              );
                            } else {
                              // 单个Skill，使用原来的简单布局
                              return Object.entries(groupedBySkill).map(([skillId, dims]) => {
                                const skill = BUILTIN_SKILLS.find((s: any) => s.id === skillId);
                                const skillName = skill ? skill.name : skillId;
                                const skillIcon = skill ? skill.icon : '📊';

                                return (
                                  <div key={skillId} style={{ marginBottom: 16, padding: 10, background: '#f9fafb', borderRadius: 6 }}>
                                    <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 12, color: '#4b5563' }}>
                                      {skillIcon} {skillName}
                                    </div>
                                    {dims.map((dim: any, idx: number) => {
                                      const evidenceColors: Record<string, string> = {
                                        '强': '#10b981',
                                        '中': '#f59e0b',
                                        '弱': '#ef4444',
                                        '未验证': '#6b7280',
                                      };
                                      const evidenceColor = evidenceColors[dim.evidence_strength] || '#6b7280';

                                      return (
                                        <div key={idx} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: idx < dims.length - 1 ? '1px solid #e5e7eb' : 'none' }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                            <span style={{ fontSize: 11, fontWeight: 600, color: '#1f2937' }}>
                                              {dim.dimension_type}
                                            </span>
                                            <Tag color={evidenceColor} style={{ fontSize: 10, padding: '0 6px', margin: 0 }}>
                                              {dim.evidence_strength}
                                            </Tag>
                                          </div>
                                          <div style={{ fontSize: 12, lineHeight: 1.6, color: '#334155' }}>
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{dim.content}</ReactMarkdown>
                                          </div>
                                          {dim.source_url && (
                                            <div style={{ marginTop: 4 }}>
                                              <a
                                                href="#"
                                                onClick={async (e) => {
                                                  e.preventDefault();
                                                  try {
                                                    const { invoke } = await import('@tauri-apps/api/core');
                                                    await invoke('open_url', { url: dim.source_url });
                                                  } catch (err) {
                                                    console.error('打开链接失败:', err);
                                                    message.error('无法打开链接');
                                                  }
                                                }}
                                                style={{ fontSize: 11, color: '#3B82F6', cursor: 'pointer' }}
                                              >
                                                🔗 {dim.source_title || dim.source_url}
                                              </a>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              });
                            }
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })()}

                <Descriptions column={2} size="small" bordered>
                  <Descriptions.Item label="来源"><Tag color={selectedNode.source_type === 'ai_draft' ? 'orange' : 'green'}>{selectedNode.source_type === 'ai_draft' ? 'AI草稿' : '已确认'}</Tag></Descriptions.Item>
                  <Descriptions.Item label="成本%">{selectedNode.cost_ratio_estimate != null ? `${selectedNode.cost_ratio_estimate}%` : '-'}</Descriptions.Item>
                  <Descriptions.Item label="父节点">{selectedNode.parent_id ? (nodes.find((n: any) => n.id === selectedNode.parent_id)?.component_name || '-') : '顶层'}</Descriptions.Item>
                  <Descriptions.Item label="趋势条目">{selectedNode.trend_item_id ? <Tag color="blue">📡{trendItems.find((t: any) => t.id === selectedNode.trend_item_id)?.query_category || ''}<Button size="small" type="link" danger onClick={() => handleLinkTrend(selectedNode.id, null)}>取消</Button></Tag> :
                    <Select size="small" placeholder="关联" style={{ width: 130 }} value={undefined} onChange={v => handleLinkTrend(selectedNode.id, v ?? null)} allowClear>{trendItems.map((t: any) => <Select.Option key={t.id} value={t.id}>{t.query_category}</Select.Option>)}</Select>}</Descriptions.Item>
                  <Descriptions.Item label="洞察"><Tag color={selectedNode.insight_status === 'queried' ? 'green' : 'gold'}>{selectedNode.insight_status === 'queried' ? '✅已查询' : '⏳待洞察'}</Tag></Descriptions.Item>
                  <Descriptions.Item label="更新">{selectedNode.updated_at || '-'}</Descriptions.Item>
                </Descriptions>

                {history.length > 0 && (
                  <div style={{ marginTop: 12 }}><h4>修改历史</h4>
                    <Table dataSource={history} rowKey="id" size="small" pagination={{ pageSize: 4 }}
                      columns={[{ title: '时间', dataIndex: 'changed_at', width: 140 }, { title: '字段', dataIndex: 'field_changed', width: 100 }, { title: '旧值', dataIndex: 'old_value', ellipsis: true }, { title: '新值', dataIndex: 'new_value', ellipsis: true }]} /></div>
                )}
              </div>

              <div className="content-card">
                <h4>子组件 ({nodes.filter((n: any) => n.parent_id === selectedNode.id).length})</h4>
                <Table dataSource={nodes.filter((n: any) => n.parent_id === selectedNode.id)} rowKey="id" size="small" pagination={false}
                  columns={[
                    { title: '名称', dataIndex: 'component_name', render: (v: string, r: any) => (<a onClick={() => selectNode(r)} style={{ cursor: 'pointer' }}>{v}</a>) },
                    { title: '类型', dataIndex: 'node_type', width: 60, render: (v: string) => <Tag color={v === 'terminal' ? 'orange' : 'blue'}>{v === 'terminal' ? '终端' : '结构'}</Tag> },
                    { title: '成本', dataIndex: 'cost_ratio_estimate', width: 55, render: (v: number) => v != null ? `${v}%` : '-' },
                    { title: '洞察', dataIndex: 'insight_status', width: 50, render: (v: string) => v === 'queried' ? '✅' : '⏳' },
                    { title: '操作', width: 118, render: (_: any, r: any) => (
                      r.source_type !== 'user_confirmed' ? <Tag style={{ fontSize: 10 }}>确认后可用</Tag> : r.node_type === 'terminal' ? (
                        <Button size="small" type="link" icon={<RadarChartOutlined style={{ color: '#8B5CF6' }} />} onClick={(event) => { event.stopPropagation(); requestInsightWithPreview(r); }}>洞察</Button>
                      ) : (
                        <Button size="small" type="link" icon={<ThunderboltOutlined />} onClick={(event) => { event.stopPropagation(); setAiDraftParentId(r.id); setAiDraftName(r.component_name); setAiDraftResult([]); setAiDraftOpen(true); }}>拆解</Button>
                      )
                    )},
                  ]} />
              </div>

              <div className="content-card" style={{ flexShrink: 0 }}>
                <h4>💬 节点追问</h4>
                {conversations.length > 0 && (
                  <div style={{ maxHeight: 120, overflow: 'auto', marginBottom: 8 }}>
                    {conversations.map((c: any, i: number) => (
                      <div key={c.id || i} style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2, fontSize: 12 }}>
                          <div style={{ background: 'var(--brand-gradient)', color: '#fff', padding: '4px 10px', borderRadius: '12px 12px 3px 12px', maxWidth: '80%' }}>{c.question}</div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-start', fontSize: 12 }}>
                          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', padding: '4px 10px', borderRadius: '12px 12px 12px 3px', maxWidth: '85%', fontSize: 13, lineHeight: 1.6 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{c.answer}</ReactMarkdown></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input placeholder="追问..." value={convAsk} onChange={e => setConvAsk(e.target.value)}
                    onPressEnter={handleNodeAsk} style={{ flex: 1, borderRadius: 20 }} size="small"
                    prefix={<QuestionCircleOutlined />} disabled={!selectedNode?.trend_item_id} />
                  <Button type="primary" icon={<SendOutlined />} onClick={handleNodeAsk}
                    disabled={!convAsk.trim() || convLoading || !selectedNode?.trend_item_id}
                    shape="circle" size="small" loading={convLoading} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {renderModals()}
    </div>
  );

  // ====== 共享弹窗 ======
  function renderModals() {
    return (
      <>
        {/* 查询预览确认弹窗 */}
        <Modal title="🔍 确认发送洞察查询" open={previewModalOpen}
          onCancel={() => { setPreviewModalOpen(false); setPreviewTargetNode(null); }}
          onOk={confirmInsightRequest} okText="确认发送" cancelText="取消" width={480}>
          <div style={{ padding: '8px 0' }}>
            <p>即将发送以下查询关键词至外部搜索和LLM服务：</p>
            <div style={{ padding: '12px 16px', background: 'var(--main-bg)', borderRadius: 8, marginBottom: 16, fontSize: 16, fontWeight: 600 }}>
              🔎 {previewTargetNode?.component_name || ''}
            </div>
            <Alert type="info" showIcon icon={<SafetyCertificateOutlined />}
              message="仅发送物料/原材料的通用名称，不会发送任何本地成本数据。" style={{ fontSize: 12 }} />
          </div>
        </Modal>

        {/* AI草案弹窗 */}
        <Modal title={`AI起草${aiDraftParentId ? '子组件' : '顶层'}`} open={aiDraftOpen}
          onCancel={() => setAiDraftOpen(false)} width={650} footer={[
          <Button key="cancel" onClick={() => setAiDraftOpen(false)}>取消</Button>,
          <Button key="retry" onClick={handleAiDraft} loading={aiDraftLoading}>重生成</Button>,
          <Button key="confirm" type="primary" onClick={confirmAiDraft}>确认入库</Button>,
        ]}>
          <Form><Form.Item label="名称"><Input value={aiDraftName} onChange={e => setAiDraftName(e.target.value)} placeholder="输入物料名称" onPressEnter={handleAiDraft} size="large" /></Form.Item></Form>
          {aiDraftLoading && <Spin tip="AI分析中..." style={{ display: 'block', margin: '20px auto' }} />}
          {aiDraftResult.length > 0 && (
            <Table dataSource={aiDraftResult.map((item: any, i: number) => ({ ...item, key: i }))}
              columns={[
                { title: '名称', dataIndex: 'component_name', width: 160, render: (v: string, _: any, idx: number) => editingDraftIndex === idx ? (
                  <Input size="small" value={v} autoFocus onChange={e => { const u = [...aiDraftResult]; u[idx] = { ...u[idx], component_name: e.target.value }; setAiDraftResult(u); }}
                    onBlur={() => setEditingDraftIndex(null)} onPressEnter={() => setEditingDraftIndex(null)} />
                ) : (<span onClick={() => setEditingDraftIndex(idx)} style={{ cursor: 'pointer' }}>{v || '点击编辑'}</span>) },
                { title: '成本%', dataIndex: 'cost_ratio_estimate', width: 70, render: (v: any, _: any, idx: number) => (
                  <Input size="small" type="number" value={v ?? ''} style={{ width: 55 }} onChange={e => { const u = [...aiDraftResult]; u[idx] = { ...u[idx], cost_ratio_estimate: e.target.value ? parseFloat(e.target.value) : null }; setAiDraftResult(u); }} />) },
                { title: '类型', dataIndex: 'node_type', width: 80, render: (v: string, _: any, idx: number) => (
                  <Select size="small" value={v || 'structural'} style={{ width: 70 }} onChange={val => { const u = [...aiDraftResult]; u[idx] = { ...u[idx], node_type: val }; setAiDraftResult(u); }}>
                    <Select.Option value="structural">结构</Select.Option>
                    <Select.Option value="terminal">终端</Select.Option>
                  </Select>) },
                { title: '', width: 30, render: (_: any, __: any, idx: number) => <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setAiDraftResult(aiDraftResult.filter((_: any, i: number) => i !== idx))} /> },
              ]} size="small" pagination={false} />)}
        </Modal>

        {/* 批量拆解 - 预览弹窗 */}
        <Modal title="批量拆解" open={batchDecomposeOpen}
          onCancel={() => { setBatchDecomposeOpen(false); setBatchDecomposeResults([]); setCostRatioWarning(null); }}
          footer={batchDecomposeResults.length > 0 ? [
            <Button key="cancel" onClick={() => { setBatchDecomposeOpen(false); setBatchDecomposeResults([]); setCostRatioWarning(null); }}>取消</Button>,
            costRatioWarning && <Button key="normalize" onClick={normalizeCostRatios}>自动归一化到100%</Button>,
            <Button key="confirm" type="primary" onClick={confirmBatchDecomposeDrafts}>确认入库为草稿</Button>,
          ] : [
            <Button key="cancel" onClick={() => setBatchDecomposeOpen(false)}>取消</Button>,
            <Button key="start" type="primary" onClick={confirmBatchDecompose} loading={batchDecomposeLoading}>开始拆解</Button>,
          ]}
        >
          {batchDecomposeLoading && <Spin tip="AI 批量拆解中..." style={{ display: 'block', margin: '20px auto' }} />}

          {!batchDecomposeLoading && batchDecomposeResults.length === 0 && (
            <div style={{ marginBottom: 12 }}>即将对 <b>{structuralSelected}</b> 个 structural 节点执行 AI 拆解：</div>
          )}
          {!batchDecomposeLoading && batchDecomposeResults.length === 0 && (
            <List dataSource={nodes.filter((n: any) => checkedIds.has(n.id) && n.node_type === 'structural')}
              renderItem={(item: any) => <List.Item>{item.component_name}</List.Item>} size="small" />
          )}

          {/* 拆解结果预览 */}
          {!batchDecomposeLoading && batchDecomposeResults.length > 0 && (
            <div>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>AI 拆解结果预览（将入库为草稿，需二次确认）</div>
              {costRatioWarning && (
                <Alert type="warning" showIcon message={costRatioWarning} style={{ marginBottom: 12, fontSize: 12 }}
                  description="可点击「自动归一化到100%」调整，或稍后在编辑弹窗中手动修改。" />
              )}
              {batchDecomposeResults.map((result, idx) => (
                <div key={idx} style={{ marginBottom: 16, padding: 12, background: 'var(--main-bg)', borderRadius: 8 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>📦 {result.parentName}</div>
                  <Table
                    dataSource={result.items.map((item, i) => ({ ...item, key: i }))}
                    columns={[
                      { title: '名称', dataIndex: 'component_name', width: 160 },
                      { title: '成本%', dataIndex: 'cost_ratio_estimate', width: 70, render: (v: number) => v != null ? `${v}%` : '-' },
                      { title: '类型', dataIndex: 'node_type', width: 70, render: (v: string) => <Tag color={v === 'terminal' ? 'orange' : 'blue'}>{v === 'terminal' ? '终端' : '结构'}</Tag> },
                    ]}
                    size="small" pagination={false} bordered />
                </div>
              ))}
            </div>
          )}
        </Modal>

        {/* 批量洞察 */}
        <Modal title="批量洞察" open={batchInsightOpen} onCancel={() => setBatchInsightOpen(false)} onOk={confirmBatchInsight} okText="开始洞察">
          <div style={{ marginBottom: 12 }}>即将对 <b>{terminalSelected}</b> 个 terminal 节点发起趋势洞察：</div>
          <List dataSource={nodes.filter((n: any) => checkedIds.has(n.id) && n.node_type === 'terminal')} renderItem={(item: any) => <List.Item>{item.component_name}</List.Item>} size="small" />
        </Modal>

        {/* 批量进度 */}
        {batchProgress.total > 0 && (
          <div style={{ position: 'fixed', bottom: 24, right: 24, background: 'var(--brand-gradient)', color: '#fff', padding: '12px 20px', borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', zIndex: 1000 }}>
            <Progress type="circle" percent={Math.round((batchProgress.done / batchProgress.total) * 100)} size={40} strokeColor="#fff" />
            <span style={{ marginLeft: 8 }}>批量 {batchProgress.done}/{batchProgress.total}</span>
          </div>
        )}

        {/* 修正反馈 */}
        <Modal title="修正汇总结果" open={feedbackModalOpen} onCancel={() => setFeedbackModalOpen(false)} onOk={submitFeedback} okText="保存修正" width={550}>
          <Form layout="vertical" size="small">
            <Form.Item label="AI原始方向"><Tag>{feedbackData.direction}</Tag></Form.Item>
            <Form.Item label="AI原始置信度"><Tag>{feedbackData.confidence}</Tag></Form.Item>
            <Form.Item label="修正后方向"><Radio.Group value={feedbackData.direction} onChange={e => setFeedbackData({ ...feedbackData, direction: e.target.value })}>
              <Radio.Button value="上涨">🔺上涨</Radio.Button><Radio.Button value="下降">🔻下降</Radio.Button><Radio.Button value="震荡">▬震荡</Radio.Button><Radio.Button value="信号不明确">？不明</Radio.Button>
            </Radio.Group></Form.Item>
            <Form.Item label="修正后置信度"><Radio.Group value={feedbackData.confidence} onChange={e => setFeedbackData({ ...feedbackData, confidence: e.target.value })}>
              <Radio.Button value="高">高</Radio.Button><Radio.Button value="中">中</Radio.Button><Radio.Button value="低">低</Radio.Button>
            </Radio.Group></Form.Item>
            <Form.Item label="修正原因（必填）"><Input.TextArea rows={3} value={feedbackData.reason} onChange={e => setFeedbackData({ ...feedbackData, reason: e.target.value })} placeholder="请说明为什么修正" /></Form.Item>
          </Form>
        </Modal>

        {/* 修正记录 */}
        <Modal title="汇总修正记录" open={feedbackHistoryOpen} onCancel={() => setFeedbackHistoryOpen(false)} width={700} footer={null}>
          {allFeedback.length === 0 ? <Empty description="暂无修正记录" /> : (
            <Table dataSource={allFeedback} rowKey="id" size="small"
              columns={[
                { title: '节点', dataIndex: 'component_name', width: 120 },
                { title: 'AI方向', dataIndex: 'ai_direction', width: 70, render: (v: string) => v ? <Tag color={TREND_COLORS[v]}>{v}</Tag> : '-' },
                { title: '修正方向', dataIndex: 'user_corrected_direction', width: 70, render: (v: string) => v ? <Tag color={TREND_COLORS[v]}>{v}</Tag> : '-' },
                { title: 'AI置信度', dataIndex: 'ai_confidence_level', width: 60 },
                { title: '修正置信度', dataIndex: 'user_corrected_confidence_level', width: 60 },
                { title: '原因', dataIndex: 'correction_reason', ellipsis: true },
                { title: '时间', dataIndex: 'created_at', width: 130 },
              ]} />
          )}
        </Modal>

        {/* 编辑节点 */}
        <Modal title={editingNode?.id ? '编辑节点' : '新增节点'} open={editModalOpen}
          onCancel={() => setEditModalOpen(false)} onOk={handleSaveNode} width={450}>
          {editingNode && (
            <Form layout="vertical" size="small">
              <Form.Item label="名称" required><Input value={editingNode.component_name} onChange={e => setEditingNode({ ...editingNode, component_name: e.target.value })} /></Form.Item>
              <Form.Item label="成本占比(%)"><Input type="number" value={editingNode.cost_ratio_estimate ?? ''} onChange={e => setEditingNode({ ...editingNode, cost_ratio_estimate: e.target.value ? parseFloat(e.target.value) : null })} /></Form.Item>
              <Form.Item label="节点类型"><Radio.Group value={editingNode.node_type || 'structural'} onChange={e => setEditingNode({ ...editingNode, node_type: e.target.value })}>
                <Radio.Button value="structural">结构（可拆解）</Radio.Button><Radio.Button value="terminal">终端（物料末端）</Radio.Button>
              </Radio.Group></Form.Item>
              <Form.Item label="来源"><Select value={editingNode.source_type} onChange={v => setEditingNode({ ...editingNode, source_type: v })}>
                <Select.Option value="ai_draft">AI草稿</Select.Option><Select.Option value="user_confirmed">已确认</Select.Option>
              </Select></Form.Item>
            </Form>
          )}
        </Modal>
      </>
    );
  }
}
