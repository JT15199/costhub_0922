import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Table, Button, Input, Select, Space, Modal, Form, Tag, message,
  Popconfirm, Spin, Empty, Tooltip, Progress, Radio, List, Card, Row, Col, Typography, Alert, Timeline,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined,
  CheckOutlined, SearchOutlined, DownloadOutlined, SendOutlined, QuestionCircleOutlined,
  RadarChartOutlined, ApartmentOutlined, MergeCellsOutlined,
  ArrowLeftOutlined, BranchesOutlined, SafetyCertificateOutlined, BugOutlined,
  RiseOutlined, FallOutlined, MinusOutlined,
  BarsOutlined, BarChartOutlined, ClockCircleOutlined, HistoryOutlined, InboxOutlined,
  LinkOutlined, BulbOutlined, SignalFilled, CheckSquareFilled, BorderOutlined, WarningOutlined,
} from '@ant-design/icons';
import {
  ReactFlow, MiniMap, Controls, Background, Panel, useNodesState, useEdgesState,
  Handle, Position,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  getAllDecompositionNodes, getDecompositionNode, saveDecompositionNode,
  deleteDecompositionNode, searchDecompositionNodes, getDecompositionHistory,
  getTrendItemsWithDetails, getLatestTrendSnapshot, getTrendItemByCategory,
  saveTrendItem, saveTrendSnapshot, getTrendSnapshots,
  getTrendConversations,
  saveTrendSource, clearTrendSources,
  getTrendSources,
  saveRollupContribution, getRollupContributions, saveRollupFeedback, getAllRollupFeedback,
  getTrendInsightDimensions, saveTrendInsightDimensions, saveTrendKeyEvent,
  getParts,
} from '../db';
import { hasLLMConfig } from '../apiConfig';
import { agentSearchLoop, askLLM, createStructuredInsight, BUILTIN_SKILLS, extractLLMJson, getActiveSkills, getSkill } from '../trendService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCategoryColor } from '../constants';

// 统一时间格式化：兼容本地时间（YYYY-MM-DD HH:MM:SS）与旧 ISO UTC（带 T）两种格式
function formatTime(t: string): string {
  if (!t) return '未知时间';
  const s = String(t);
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}

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

function parseDecompositionItems(response: string): any[] {
  const parsed = extractLLMJson(response);
  const items = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.components) ? parsed.components
      : Array.isArray(parsed?.children) ? parsed.children
        : Array.isArray(parsed?.items) ? parsed.items
          : Array.isArray(parsed?.data) ? parsed.data
            : null);

  if (!items) throw new Error('未识别到子组件数组');

  const normalized = items
    .map((item: any) => {
      const name = String(item?.component_name || item?.name || item?.title || '').trim();
      const ratioRaw = item?.cost_ratio_estimate ?? item?.cost_ratio ?? item?.ratio ?? null;
      const ratio = ratioRaw === null || ratioRaw === '' || Number.isNaN(Number(ratioRaw)) ? null : Number(ratioRaw);
      const nodeType = item?.node_type === 'terminal' ? 'terminal' : 'structural';
      return { component_name: name, cost_ratio_estimate: ratio, node_type: nodeType };
    })
    .filter((item: any) => item.component_name);

  if (normalized.length === 0) throw new Error('子组件缺少 component_name');
  return normalized;
}

async function openExternal(url: string) {
  if (!url) return;
  try {
    // 直接导入 Tauri shell 插件
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch (err) {
    console.error('打开链接失败:', err);
    // 降级：尝试用window.open
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

const TREND_COLORS: Record<string, string> = { '上涨': '#EF4444', '下降': '#10B981', '震荡': '#F59E0B', '信号不明确': '#94A3B8' };
const TREND_ICONS: Record<string, React.ReactNode> = {
  '上涨': <RiseOutlined />,
  '下降': <FallOutlined />,
  '震荡': <MinusOutlined />,
  '信号不明确': <QuestionCircleOutlined />
};
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
  const isQueried = data.insightStatus === 'queried';
  const ratio = data.costRatio != null ? Number(data.costRatio) : 0;
  const isBig = ratio >= 15; // 成本大头（≥15%）
  // 洞察状态点：已洞察=绿 + 方向色；待洞察=灰；大头未洞察=橙（建议优先）
  const statusDot = !isDraft && (isQueried
    ? <span title="已洞察" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#34C759', marginRight: 4, flexShrink: 0 }} />
    : isBig
      ? <span title="成本大头未洞察 · 建议优先" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#FF9500', marginRight: 4, flexShrink: 0 }} />
      : <span title="待洞察" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#C7C7CC', marginRight: 4, flexShrink: 0 }} />);
  // 成本热度：占比越高底色越深（蓝 tint）
  const heat = isDraft ? 0 : Math.min(0.12, 0.02 + (ratio / 100) * 0.10);
  return (
    <div
      style={{
        background: isDraft
          ? 'linear-gradient(135deg, #F8FAFC, #F1F5F9)'
          : `linear-gradient(180deg, rgba(0,122,255,${heat.toFixed(3)}), rgba(0,122,255,0) 70%), var(--card-bg, #FFF)`,
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
        {isChecked ? <CheckSquareFilled style={{ fontSize: 14 }} /> : <BorderOutlined style={{ fontSize: 14 }} />}
      </span>
      <div style={{ fontWeight: 700, color: 'var(--text-primary, #1E293B)', marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
        {statusDot}{data.trendIcon && <span>{data.trendIcon}</span>}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.label}</span>
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, marginBottom: 7 }}>
        <Tag color={isTerminal ? 'orange' : 'blue'} style={{ fontSize: 9, margin: 0, padding: '0 5px', lineHeight: '16px' }}>{isTerminal ? '终端物料' : '结构节点'}</Tag>
        {data.costRatio != null && <span style={{ color: isBig && !isQueried ? '#C93400' : 'var(--text-muted, #64748B)', fontWeight: isBig && !isQueried ? 700 : 400 }}>占比 {data.costRatio}%{isBig && !isQueried ? ' · 优先' : ''}</span>}
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
  // 树交互升级：血缘链高亮 / 聚焦 / 面包屑
  const [focusNodeId, setFocusNodeId] = useState<number | null>(null);
  const [chainPath, setChainPath] = useState<{ id: number; name: string }[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [trendItems, setTrendItems] = useState<any[]>([]);
  const [snapshotMap, setSnapshotMap] = useState<Record<number, any>>({});
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [convAsk, setConvAsk] = useState('');
  const [convLoading, setConvLoading] = useState(false);
  const [conversations, setConversations] = useState<any[]>([]);
  const [trendSources, setTrendSources] = useState<any[]>([]);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
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


  // ===== 树交互：血缘链 / 聚焦 / 面包屑 =====
  const getAncestorChain = (nodeId: number): { id: number; name: string }[] => {
    const chain: { id: number; name: string }[] = [];
    let cur: any = nodes.find((n: any) => n.id === nodeId);
    while (cur) {
      chain.unshift({ id: cur.id, name: cur.component_name || cur.label || String(cur.id) });
      cur = nodes.find((n: any) => n.id === cur.parent_id);
    }
    return chain;
  };
  const applyChainHighlight = useCallback((chainIds: Set<number>, focus: boolean) => {
    setRfNodes((current: any[]) => current.map((n: any) => {
      const inChain = chainIds.has(Number(n.id));
      return {
        ...n,
        style: { opacity: inChain ? 1 : (focus ? 0.15 : 0.25), transition: 'opacity 200ms ease-out' },
      };
    }));
    setRfEdges((current: any[]) => current.map((e: any) => ({
      ...e,
      animated: chainIds.has(Number(e.source)) && chainIds.has(Number(e.target)),
      style: chainIds.has(Number(e.source)) && chainIds.has(Number(e.target))
        ? { stroke: '#007AFF', strokeWidth: 2.4, transition: 'stroke 160ms ease-out' }
        : { stroke: undefined, strokeWidth: undefined },
    })));
  }, []);
  const clearChainHighlight = useCallback(() => {
    setRfNodes((current: any[]) => current.map((n: any) => ({ ...n, style: undefined })));
    setRfEdges((current: any[]) => current.map((e: any) => ({ ...e, animated: false, style: undefined })));
  }, []);
  // ====== 数据加载 ======
  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllDecompositionNodes();
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

  // ====== 快捷洞察（无需分解树，直接洞察单个物料行情） ======
  const [quickItems, setQuickItems] = useState<any[]>([]);
  const [quickSnapMap, setQuickSnapMap] = useState<Record<number, any>>({});
  // 添加快捷洞察弹窗
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddName, setQuickAddName] = useState('');
  // 快捷洞察详情弹窗
  const [quickDetailItem, setQuickDetailItem] = useState<any>(null);
  const [quickDetailSnaps, setQuickDetailSnaps] = useState<any[]>([]);
  const [quickDetailDims, setQuickDetailDims] = useState<any[]>([]);
  const [quickDetailLoading, setQuickDetailLoading] = useState(false);
  // 详情弹窗中选中的批次时间（时间轴切换查看）
  const [quickDetailBatch, setQuickDetailBatch] = useState<string>('');
  // 快捷洞察追问
  const [quickAskInput, setQuickAskInput] = useState('');
  const [quickAskLoading, setQuickAskLoading] = useState(false);
  const [quickAskHistory, setQuickAskHistory] = useState<{ q: string; a: string }[]>([]);

  // 基于洞察结论追问（复用 agentSearchLoop + askLLM）
  const quickAsk = async () => {
    const q = quickAskInput.trim();
    if (!q || !quickDetailItem) return;
    setQuickAskInput('');
    setQuickAskLoading(true);
    try {
      const { hasLLMConfig } = await import('../apiConfig');
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) { message.warning('LLM 未配置'); setQuickAskLoading(false); return; }

      const { agentSearchLoop, askLLM } = await import('../trendService');
      // 最新快照作为洞察上下文
      const ctxSnap = quickDetailSnaps[0];

      message.loading({ content: '正在搜索并分析...', key: 'quickAsk', duration: 0 });
      const searchResult = await agentSearchLoop(q, '追问', quickDetailItem.query_category,
        (progress: string) => message.loading({ content: progress, key: 'quickAsk', duration: 0 }));

      const contextPrompt = `# 追问上下文

物料名称：${quickDetailItem.query_category}

最新洞察结论（${formatTime(ctxSnap?.query_time || '')}）：
${ctxSnap ? `- 趋势方向：${ctxSnap.direction}
- 置信度：${ctxSnap.confidence_level}
- 摘要：${ctxSnap.summary}` : '尚未洞察'}

历史对话：
${quickAskHistory.map(c => `Q: ${c.q}\nA: ${c.a}`).join('\n\n')}

最新搜索结果：
${searchResult.allSources.map((s: any, i: number) => `${i + 1}. ${s.title}\n${s.snippet}\n来源: ${s.url}`).join('\n\n')}

请基于以上上下文和最新搜索结果回答用户的追问。`;

      const answer = await askLLM(contextPrompt, q);
      setQuickAskHistory(prev => [...prev, { q, a: answer }]);
      message.destroy('quickAsk');
    } catch (e: any) {
      message.destroy('quickAsk');
      message.error('追问失败: ' + (e?.message || '未知错误'));
    } finally {
      setQuickAskLoading(false);
    }
  };

  // 打开快捷洞察详情：加载该物料全部快照（含历史）+ 各 Skill 维度
  const openQuickDetail = async (item: any) => {
    setQuickDetailItem(item);
    setQuickDetailLoading(true);
    try {
      const { getTrendSnapshots, getTrendInsightDimensions } = await import('../db');
      const snaps = await getTrendSnapshots(item.id);
      setQuickDetailSnaps(snaps);
      // 默认选中最新批次（第一条的 query_time）
      if (snaps.length > 0) setQuickDetailBatch(snaps[0].query_time || '');
      // 加载每个快照的维度（含 _skill_used）
      const allDims: any[] = [];
      for (const snap of snaps) {
        const dims = await getTrendInsightDimensions(snap.id);
        dims.forEach((d: any) => { d._skill_used = snap.skill_used; d._snapshot_id = snap.id; d._query_time = snap.query_time; });
        allDims.push(...dims);
      }
      setQuickDetailDims(allDims);
    } catch (e: any) {
      message.error('加载详情失败: ' + (e?.message || '未知错误'));
    } finally {
      setQuickDetailLoading(false);
    }
  };

  // 快捷洞察：创建 trend_item（source_type=quick）并走正式洞察流程
  const quickInsight = async (name: string, itemId?: number) => {
    try {
      const { saveQuickTrendItem } = await import('../db');
      let trendItemId = itemId;
      if (!trendItemId) {
        trendItemId = await saveQuickTrendItem({ material_name: name, category_type: '直接查询' });
      }
      const mockNode = {
        id: -1,
        component_name: name,
        node_type: 'terminal',
        trend_item_id: trendItemId,
      };
      await requestInsightWithPreview(mockNode);
    } catch (e: any) {
      const errMsg = e?.message || e?.toString?.() || JSON.stringify(e) || '未知错误';
      message.error('洞察失败：' + errMsg);
    }
  };

  // 添加快捷洞察（仅创建条目，不立即洞察）
  const confirmQuickAdd = async () => {
    const name = quickAddName.trim();
    if (!name) { message.warning('请输入物料名称'); return; }
    try {
      const { saveQuickTrendItem, getQuickTrendItems } = await import('../db');
      await saveQuickTrendItem({ material_name: name, category_type: '直接查询' });
      message.success(`已添加「${name}」，点击洞察按钮查询行情`);
      setQuickAddName(''); setQuickAddOpen(false);
      setQuickItems(await getQuickTrendItems());
    } catch (e: any) {
      const errMsg = e?.message || e?.toString?.() || JSON.stringify(e) || '未知错误';
      message.error(`添加失败：${errMsg}`);
    }
  };

  const loadQuickItems = useCallback(async () => {
    try {
      const { getQuickTrendItems, getLatestTrendSnapshot } = await import('../db');
      const items = await getQuickTrendItems();
      setQuickItems(items);
      const map: Record<number, any> = {};
      for (const item of items) {
        const snap = await getLatestTrendSnapshot(item.id);
        if (snap) map[item.id] = snap;
      }
      setQuickSnapMap(map);
    } catch (e) { console.error('加载快捷洞察失败:', e); }
  }, []);

  useEffect(() => {
    loadTree();
    loadWatchedParts();
    loadQuickItems();
  }, [loadTree, loadWatchedParts, loadQuickItems]);

  // 页面激活时重新加载（器件库标记/取消关注、项目管理改动后切过来要同步）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.page !== 'decomposition') return;
      loadWatchedParts();
      loadQuickItems();
      loadTree();
    };
    window.addEventListener('app-page-active', handler);
    return () => window.removeEventListener('app-page-active', handler);
  }, [loadTree, loadWatchedParts, loadQuickItems]);

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
          trendIcon: direction ? TREND_ICONS[direction] : (node.node_type === 'terminal' && node.insight_status === 'pending' ? <ClockCircleOutlined /> : ''),
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
    setTrendSources([]);
    setAvailableHistoryTimes([]);
    setSelectedHistoryTime(null);

    if (full?.trend_item_id) {
      const snaps = await getTrendSnapshots(full.trend_item_id);
      setSnapshots(snaps);
      setConversations(await getTrendConversations(full.trend_item_id));
      setTrendSources(await getTrendSources(full.trend_item_id));

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
        // snaps 按 query_time DESC，取第一条即最新汇总
        const latestAgg = lastAgg[0];
        const contribs = await getRollupContributions(latestAgg.id);
        setRollupContributions(contribs);
        setRollupResult(latestAgg);
      } else { setRollupContributions([]); setRollupResult(null); }
    } else { setSnapshots([]); setConversations([]); setTrendSources([]); setRollupContributions([]); setRollupResult(null); }
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
  // 本次洞察选择的 Skill（弹窗中多选，默认带出设置中激活的）
  const [previewSkills, setPreviewSkills] = useState<string[]>([]);
  const [allSkills, setAllSkills] = useState<any[]>([]);

  const requestInsightWithPreview = (node: any) => {
    setPreviewTargetNode(node);
    // 打开弹窗时加载 Skill 列表（静态导入，即时可用），默认选中设置中激活的
    setAllSkills(BUILTIN_SKILLS.filter(s => s.id !== 'custom'));
    setPreviewSkills(getActiveSkills().map(s => s.id));
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
    await handleNodeInsight(previewTargetNode, previewSkills);
  };

  // ====== 洞察 ======
  // skillIds 可选：本次洞察指定使用的 Skill（弹窗选择）；不传则用设置中激活的
  const handleNodeInsight = async (node: any, skillIds?: string[]) => {
    setInsightLoading(true);
    try {
      console.log('开始洞察节点:', node);
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) {
        message.warning('未配置 LLM API Key，请先在「设置」中完成供应商配置');
        setInsightLoading(false);
        return;
      }

      let workingNode = { ...node };
      console.log('工作节点:', workingNode);

      if (!workingNode.trend_item_id) {
        console.log('创建 trend_item...');
        const catType = workingNode.component_name?.includes('合金') || workingNode.component_name?.includes('树脂') || workingNode.component_name?.includes('钢') || workingNode.component_name?.includes('铝') ? '原材料映射' : '直接查询';
        workingNode.trend_item_id = await ensureTrendItem(workingNode.component_name, catType);
        await saveDecompositionNode({ ...workingNode, trend_item_id: workingNode.trend_item_id });
        console.log('trend_item_id:', workingNode.trend_item_id);
      }
      if (!workingNode.trend_item_id) {
        message.warning('无法创建趋势条目');
        setInsightLoading(false);
        return;
      }

      // 获取本次洞察使用的Skill列表（弹窗选择优先，未选择则用设置中激活的）
      console.log('获取 Skill 列表...');
      let skills: any[];
      if (skillIds && skillIds.length > 0) {
        skills = skillIds.map(id => getSkill(id)).filter(Boolean);
      } else {
        skills = getActiveSkills();
      }
      console.log('使用的 Skills:', skills.map((s: any) => s.name));

      if (skills.length === 0) {
        message.warning('未选择任何Skill，请在设置中选择');
        setInsightLoading(false);
        return;
      }

      // 先搜索一次，然后用多个Skill分析
      console.log('开始搜索:', workingNode.component_name);
      message.loading({ content: `正在为「${workingNode.component_name}」搜索信息...`, key: 'insight', duration: 0 });
      const result = await agentSearchLoop(workingNode.component_name, '直接查询', undefined,
        (progress: string) => message.loading({ content: progress, key: 'insight', duration: 0 }));
      console.log('搜索结果:', result);

      // 对每个激活的Skill生成洞察（并行执行：各Skill独立LLM调用，可同时进行）
      const structuredResults = await Promise.all(skills.map(async (skill, i) => {
        console.log(`生成洞察 ${i + 1}/${skills.length}:`, skill.name);
        message.loading({ content: `正在按「${skill.name}」生成采购结论 (${i + 1}/${skills.length})...`, key: 'insight', duration: 0 });
        const structured = await createStructuredInsight(workingNode.component_name, skill, result.allSources, result.summary);
        console.log('结构化洞察结果:', skill.name, structured);
        return { skill, structured };
      }));

      // 并行落库
      await Promise.all(structuredResults.map(async ({ skill, structured }) => {
        const snapshotId = await saveTrendSnapshot({
          trend_item_id: workingNode.trend_item_id, source_type: 'direct_query', skill_used: skill.id,
          direction: structured.trend_direction, confidence_level: structured.confidence_level,
          magnitude_min: structured.magnitude_min, magnitude_max: structured.magnitude_max,
          magnitude_reference: structured.magnitude_reference, summary: structured.summary,
          suggested_action: structured.suggested_action, raw_search_results: JSON.stringify(result.allSources),
        });
        console.log('保存快照ID:', snapshotId);

        await saveTrendInsightDimensions(snapshotId!, structured.dimensions || []);
        for (const event of structured.key_events || []) {
          if (event.event_description) await saveTrendKeyEvent({ ...event, trend_snapshot_id: snapshotId! });
        }
      }));

      await clearTrendSources(workingNode.trend_item_id);
      await Promise.all(result.allSources.map((source: any) =>
        saveTrendSource({ trend_item_id: workingNode.trend_item_id, source_title: source.title, source_url: source.url, excerpt: source.snippet })
      ));
      await saveDecompositionNode({ ...workingNode, insight_status: 'queried' });
      message.destroy('insight');
      message.success(`「${workingNode.component_name}」洞察完成：使用了${skills.length}个Skill`);
      await loadTree();
      loadQuickItems(); // 快捷洞察区同步刷新（含最近洞察时间/趋势）
      if (selectedId === workingNode.id) await selectNode(workingNode);
    } catch (e: any) {
      console.error('洞察失败 - 完整错误:', e);
      console.error('错误类型:', typeof e);
      console.error('错误字符串:', String(e));
      console.error('错误堆栈:', e?.stack);
      message.destroy('insight');
      const errorMsg = e?.message || e?.toString() || JSON.stringify(e) || '未知错误';
      message.error(`趋势查询失败：${errorMsg}`);
    } finally {
      setInsightLoading(false);
    }
  };

  // ====== 节点追问 ======
  const [followUpModalOpen, setFollowUpModalOpen] = useState(false);

  const handleNodeAsk = async () => {
    if (!convAsk.trim() || !selectedNode?.trend_item_id) return;
    const q = convAsk.trim(); setConvAsk(''); setConvLoading(true);

    // 添加一条"正在思考"的临时消息
    const thinkingMsgId = Date.now();
    const thinkingMsg = {
      id: thinkingMsgId,
      question: q,
      answer: '',
      trend_item_id: selectedNode.trend_item_id,
      created_at: new Date().toISOString(),
      isStreaming: true,
    };
    setConversations(prev => [...prev, thinkingMsg]);

    try {
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) {
        message.warning('LLM 未配置');
        setConvLoading(false);
        setConversations(prev => prev.filter(c => c.id !== thinkingMsgId));
        return;
      }

      // 1. 执行联网搜索
      // 更新临时消息显示搜索状态
      setConversations(prev => {
        const newConvs = [...prev];
        const idx = newConvs.findIndex(c => c.id === thinkingMsgId);
        if (idx !== -1) newConvs[idx] = { ...newConvs[idx], answer: '正在搜索相关信息...' };
        return newConvs;
      });
      setConversations(prev => {
        const newConvs = [...prev];
        const idx = newConvs.findIndex(c => c.id === thinkingMsgId);
        if (idx !== -1) newConvs[idx] = { ...newConvs[idx], answer: '正在搜索相关信息...' };
        return newConvs;
      });

      const searchResult = await agentSearchLoop(
        q,
        '追问',
        selectedNode.component_name,
        (progress: string) => {
          setConversations(prev => {
            const newConvs = [...prev];
            const idx = newConvs.findIndex(c => c.id === thinkingMsgId);
            if (idx !== -1) newConvs[idx] = { ...newConvs[idx], answer: progress };
            return newConvs;
          });
        }
      );

      // 2. 携带历史对话上下文和搜索结果调用 LLM
      setConversations(prev => {
        const newConvs = [...prev];
        const idx = newConvs.findIndex(c => c.id === thinkingMsgId);
        if (idx !== -1) newConvs[idx] = { ...newConvs[idx], answer: '正在生成回答...' };
        return newConvs;
      });

      const conversationHistory = await getTrendConversations(selectedNode.trend_item_id);
      // snapshots 按 query_time DESC，第一条即最新洞察
      const latestSnapshot = snapshots.length > 0 ? snapshots[0] : null;

      const contextPrompt = `# 追问上下文

物料名称：${selectedNode.component_name}

最新洞察结论：
${latestSnapshot ? `- 趋势方向：${latestSnapshot.direction}
- 置信度：${latestSnapshot.confidence_level}
- 摘要：${latestSnapshot.summary}` : '尚未洞察'}

历史对话：
${conversationHistory.filter((c: any) => c.id !== thinkingMsgId).map((c: any) => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n')}

最新搜索结果：
${searchResult.allSources.map((s: any, idx: number) => `${idx + 1}. ${s.title}\n${s.snippet}\n来源: ${s.url}`).join('\n\n')}

请基于以上上下文和最新搜索结果回答用户的追问。`;

      const answer = await askLLM(contextPrompt, q);

      // 模拟流式输出效果
      let currentText = '';
      const chars = answer.split('');
      const chunkSize = Math.max(1, Math.floor(chars.length / 50)); // 分50次输出

      for (let i = 0; i < chars.length; i += chunkSize) {
        currentText += chars.slice(i, i + chunkSize).join('');
        setConversations(prev => {
          const newConvs = [...prev];
          const idx = newConvs.findIndex(c => c.id === thinkingMsgId);
          if (idx !== -1) newConvs[idx] = { ...newConvs[idx], answer: currentText };
          return newConvs;
        });
        await new Promise(resolve => setTimeout(resolve, 20)); // 每20ms输出一次
      }

      // 流式完成后，保存到数据库
      await (await import('../db')).saveTrendConversation({ trend_item_id: selectedNode.trend_item_id, question: q, answer });

      // 追问完成后，异步更新洞察摘要（不阻塞UI）
      if (selectedNode.trend_item_id) {
        (async () => {
          try {
            const allConversations = await getTrendConversations(selectedNode.trend_item_id);
            const latestSnap = snapshots.length > 0 ? snapshots[0] : null;
            if (!latestSnap) return;

            const updatePrompt = `你是物料采购分析专家。请综合以下信息，更新「${selectedNode.component_name}」的洞察结论。

## 原始洞察结论
趋势方向：${latestSnap.direction}
置信度：${latestSnap.confidence_level}
摘要：${latestSnap.summary}

## 追问对话记录（最近5条）
${allConversations.slice(-5).map((c: any) => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n')}

## 任务
1. 综合原始洞察和追问信息，更新摘要（80字以内）
2. 如果追问信息改变了判断，更新趋势方向
3. 输出JSON：{"trend_direction":"上涨|下降|震荡|信号不明确","confidence_level":"高|中|低","summary":"更新后的摘要"}`;

            const raw = await askLLM(updatePrompt, '请综合更新洞察结论');
            let parsed: any;
            try {
              parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
            } catch {
              // 解析失败则不更新
              return;
            }
            if (!parsed.trend_direction || !parsed.summary) return;

            const { saveTrendSnapshot } = await import('../db');
            await saveTrendSnapshot({
              trend_item_id: selectedNode.trend_item_id,
              source_type: 'followup_update',
              direction: parsed.trend_direction,
              confidence_level: parsed.confidence_level || latestSnap.confidence_level,
              magnitude_min: latestSnap.magnitude_min,
              magnitude_max: latestSnap.magnitude_max,
              magnitude_reference: latestSnap.magnitude_reference,
              summary: parsed.summary,
              suggested_action: latestSnap.suggested_action,
              raw_search_results: latestSnap.raw_search_results,
            });
            // 刷新洞察数据
            if (selectedNode) await selectNode(selectedNode);
          } catch (e) {
            console.error('更新洞察摘要失败:', e);
          }
        })();
      }

      // 重新加载对话列表（移除临时消息，加载真实数据）
      setConversations(await getTrendConversations(selectedNode.trend_item_id));
      message.success('已获取回答');
    } catch (e: any) {
      message.error(`追问失败：${e.message}`);
      setConvAsk(q);
      setConversations(prev => prev.filter(c => c.id !== thinkingMsgId));
    }
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
      component_id: selectedId, component_name: selectedNode.component_name, ai_direction: snap.direction, ai_summary: snap.summary, ai_confidence_level: snap.confidence_level,
      user_corrected_direction: feedbackData.direction, user_corrected_confidence_level: feedbackData.confidence,
      user_corrected_summary: feedbackData.summary, correction_reason: feedbackData.reason,
    });
    message.success('修正记录已保存'); setFeedbackModalOpen(false);
  };
  const openFeedbackHistory = async () => {
    setAllFeedback(await getAllRollupFeedback());
    setFeedbackHistoryOpen(true);
  };

  // AI分析过程状态
  const [aiAnalysisSteps, setAiAnalysisSteps] = useState<string[]>([]);

  // ====== AI 起草 ======
  const handleAiDraft = async () => {
    if (!aiDraftName.trim()) return;
    setAiDraftLoading(true);
    setAiAnalysisSteps([]);
    try {
      const hasLLM = await hasLLMConfig();
      if (!hasLLM) { message.warning('未配置 LLM'); setAiDraftLoading(false); return; }

      // 步骤1：收集上下文
      setAiAnalysisSteps(['正在收集上下文信息...']);
      const parentInfo = aiDraftParentId ? await getDecompositionNode(aiDraftParentId) : null;

      // 获取完整的祖先链路（从根节点到当前节点）
      const ancestorChain: string[] = [];
      if (parentInfo) {
        let currentNode = parentInfo;
        ancestorChain.unshift(currentNode.component_name);

        // 向上追溯到根节点
        while (currentNode.parent_id) {
          try {
            currentNode = await getDecompositionNode(currentNode.parent_id);
            if (currentNode) {
              ancestorChain.unshift(currentNode.component_name);
            } else {
              break;
            }
          } catch {
            break;
          }
        }
      }

      const contextInfo = ancestorChain.length > 0
        ? `完整层级：${ancestorChain.join(' → ')} → ${aiDraftName}`
        : `顶层物料：${aiDraftName}`;

      setAiAnalysisSteps(prev => [...prev, `上下文：${contextInfo}`]);

      // 步骤2：分析拆解策略
      setAiAnalysisSteps(prev => [...prev, 'AI正在分析拆解策略...']);
      await new Promise(r => setTimeout(r, 500)); // 让用户看到过程

      // 改进的Prompt：融入完整上下文和Serenity产业链方法论
      const systemPrompt = `你是资深的电子产品BOM结构分析专家。你的任务是将物料按照产业链层级和功能模块科学拆解。

## 拆解方法论（基于Serenity产业链分析框架）

### 1. 产业链视角
- **上游原材料层**：基础材料、化工原料（如FR-4基板、铜箔、树脂）
- **中游零组件层**：标准器件、芯片、连接器、被动元件
- **下游模组层**：功能模块、子系统（如电源模块、驱动板）

### 2. 功能模块视角
- **核心功能**：实现主要产品功能的关键部件（如显示面板、主控芯片）
- **辅助功能**：支持核心功能的部件（如电源转换、信号处理）
- **结构保护**：机械结构、外壳、散热、固定件

### 3. 成本占比估算原则
- **核心器件**：通常占总成本30-50%
- **标准器件**：占15-25%
- **结构件**：占10-20%
- **其他辅料**：占5-15%

### 4. 节点类型判断
- **terminal（终端物料）**：不可再拆的最小单元，如单个芯片、电阻、螺丝
- **structural（结构节点）**：可继续拆解的组件，如"电源模块"可拆为"AC-DC转换器 + EMI滤波器 + 保护电路"

## 重要原则：保持上下文一致性
- 拆解时必须考虑当前组件在整体产品中的位置和作用
- 子组件的功能必须服务于父组件的功能
- 拆解粒度要与层级深度相匹配（越往下拆越细）

## 输出格式
JSON数组：[{"component_name":"名称","cost_ratio_estimate":数字,"node_type":"structural|terminal"}]

## 约束
1. 输出3-8个子组件
2. 成本占比总和必须接近100%（允许95-105%的误差）
3. 名称要专业、具体，避免"其他"、"辅料"等模糊表述
4. 优先按功能模块拆解，而非简单罗列零散器件
5. 同一层级的拆解粒度要一致`;

      let userPrompt = '';
      if (ancestorChain.length > 0) {
        // 子组件拆解：提供完整上下文
        userPrompt = `## 拆解任务
请将「${aiDraftName}」科学拆解为子组件。

## 上下文信息
- **完整层级链**：${ancestorChain.join(' → ')} → ${aiDraftName}
- **父组件**：${parentInfo?.component_name}
- **当前组件**：${aiDraftName}
- **层级深度**：第 ${ancestorChain.length + 1} 层

## 拆解要求
1. **功能关联性**：子组件必须服务于「${aiDraftName}」的功能，并最终支撑「${ancestorChain[0]}」的整体功能
2. **层级一致性**：拆解粒度要与当前层级深度相匹配
   - 如果是第2-3层，按功能模块拆解（如"电源模块"、"信号处理模块"）
   - 如果是第4-5层，按具体器件拆解（如"主控芯片"、"电容组"）
   - 如果是第6层以上，应该到达terminal节点（单个元器件）
3. **成本合理性**：考虑「${aiDraftName}」在「${parentInfo?.component_name}」中的占比，合理分配子组件成本

## 分析步骤
1. 确定「${aiDraftName}」在整体产品中的作用
2. 识别核心功能→辅助功能→结构保护
3. 估算各子组件成本占比
4. 判断是structural还是terminal

请输出JSON数组。`;
      } else {
        // 顶层拆解
        userPrompt = `## 拆解任务
请将顶层物料「${aiDraftName}」科学拆解为一级子组件。

## 拆解要求
1. 识别核心功能模块（通常2-4个）
2. 识别标准器件/辅料模块（1-3个）
3. 识别结构/包装模块（1-2个）
4. 估算各模块成本占比
5. 所有一级模块通常都是structural（可继续拆解）

请输出JSON数组。`;
      }

      // 步骤3：调用LLM
      setAiAnalysisSteps(prev => [...prev, 'AI正在生成拆解方案...']);
      const response = await askLLM(systemPrompt, userPrompt);

      // 步骤4：解析结果
      setAiAnalysisSteps(prev => [...prev, '正在解析和验证结果...']);
      const items = parseDecompositionItems(response);

      // 步骤5：验证合理性
      const totalRatio = items.reduce((sum, item) => sum + (item.cost_ratio_estimate || 0), 0);
      const validationMsg = totalRatio >= 95 && totalRatio <= 105
        ? `成本占比验证通过（${totalRatio.toFixed(1)}%）`
        : `成本占比需要调整（${totalRatio.toFixed(1)}%）`;
      setAiAnalysisSteps(prev => [...prev, validationMsg]);

      // 步骤6：完成
      setAiAnalysisSteps(prev => [...prev, `分析完成！生成了 ${items.length} 个子组件`]);
      setAiDraftResult(items);

    } catch (e: any) {
      setAiAnalysisSteps(prev => [...prev, `分析失败：${e.message}`]);
      message.error(`AI 起草失败：${e.message}`);
    }
    setAiDraftLoading(false);
  };
  const confirmAiDraft = async () => {
    try {
      if (aiDraftResult.length === 0) {
        message.warning('请先生成分解结果');
        return;
      }

      let count = 0;
      // 如果是顶层起草（parent_id == null），先创建根节点
      let rootId = aiDraftParentId;
      if (rootId === null && aiDraftName.trim()) {
        console.log('创建顶层节点:', aiDraftName.trim());
        rootId = await saveDecompositionNode({
          parent_id: null,
          component_name: aiDraftName.trim(),
          cost_ratio_estimate: null,
          source_type: 'ai_draft',
          node_type: 'structural',
          insight_status: 'pending',
          trend_item_id: null,
        });
        console.log('顶层节点ID:', rootId);
        count++;
      }
      for (const item of aiDraftResult) {
        if (!item.component_name) continue;
        console.log('保存子节点:', item.component_name, 'parent_id:', rootId);
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
      await loadTree();
    } catch (e: any) {
      console.error('确认入库失败 - 完整错误:', e);
      console.error('错误类型:', typeof e);
      console.error('错误字符串:', String(e));
      console.error('错误堆栈:', e?.stack);
      const errorMsg = e?.message || e?.toString() || JSON.stringify(e) || '未知错误';
      message.error(`入库失败：${errorMsg}`);
    }
  };

  const confirmNode = async (node: any) => {
    try {
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
                title: '成本占比校验失败',
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
      await selectNode(node);
      await loadTree();
    } catch (e: any) {
      console.error('确认节点失败:', e);
      message.error(`确认失败：${e.message || '未知错误'}`);
    }
  };

  const handleSaveNode = async () => {
    try {
      if (!editingNode?.component_name) { message.warning('请输入名称'); return; }
      const nt = editingNode.node_type || 'structural';
      if (nt === 'terminal' && !editingNode.trend_item_id && editingNode.source_type === 'user_confirmed') {
        const catType = editingNode.component_name?.includes('合金') || editingNode.component_name?.includes('树脂') || editingNode.component_name?.includes('钢') ? '原材料映射' : '直接查询';
        editingNode.trend_item_id = await ensureTrendItem(editingNode.component_name, catType);
      }
      await saveDecompositionNode({ ...editingNode, node_type: nt });
      setEditModalOpen(false); setEditingNode(null); message.success('已保存');
      await loadTree();
      if (selectedId) await selectNode(await getDecompositionNode(selectedId));
    } catch (e: any) {
      console.error('保存节点失败:', e);
      message.error(`保存失败：${e.message || '未知错误'}`);
    }
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
    try {
      const drafts = nodes.filter((n: any) => checkedIds.has(n.id) && n.source_type === 'ai_draft');
      if (drafts.length === 0) { message.warning('未选中任何草稿节点'); return; }
      let done = 0, fail = 0;
      for (const node of drafts) {
        try {
          await confirmNode(node);
          done++;
        } catch (e) {
          console.error('确认节点失败:', e);
          fail++;
        }
      }
      message.success(`批量确认完成：${done} 成功${fail > 0 ? `，${fail} 失败` : ''}`);
      setCheckedIds(new Set());
      await loadTree();
    } catch (e: any) {
      console.error('批量确认失败:', e);
      message.error(`批量确认失败：${e.message || '未知错误'}`);
    }
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
    const failures: string[] = [];
    let done = 0;

    const systemPrompt = `你是资深的电子产品BOM结构分析专家。运用Serenity产业链拆解方法论，按照产业链层级（上游原材料→中游零组件→下游模组）和功能模块（核心功能→辅助功能→结构保护）科学拆解物料。

输出JSON数组：[{"component_name":"专业准确的名称","cost_ratio_estimate":成本占比百分比,"node_type":"structural|terminal"}]

约束：
1. 3-8个子组件
2. 成本占比总和必须在95-105%之间
3. 名称专业具体，避免"其他"等模糊词
4. terminal=终端物料（不可再拆），structural=结构节点（可继续拆）
5. 同层级拆解粒度一致`;

    for (const node of selected) {
      try {
        const response = await askLLM(
          systemPrompt,
          `请将「${node.component_name}」科学拆解为子组件。分析其核心功能→辅助功能→结构保护，估算各部分成本占比。输出JSON数组。`
        );
        allResults.push({
          parentId: node.id,
          parentName: node.component_name,
          items: parseDecompositionItems(response),
        });
        done++;
      } catch (e: any) {
        failures.push(`「${node.component_name}」：${e.message || '解析失败'}`);
        done++;
      }
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
    if (failures.length > 0) {
      message.warning(`部分拆解失败：${failures.slice(0, 3).join('；')}${failures.length > 3 ? `；另有 ${failures.length - 3} 项` : ''}`);
    }
    if (allResults.length === 0 && failures.length > 0) {
      Modal.error({
        title: '批量拆解失败',
        content: <div style={{ whiteSpace: 'pre-wrap' }}>{failures.join('\n')}</div>,
      });
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
    try {
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
            title: '成本占比校验失败',
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
      await loadTree();
    } catch (e: any) {
      console.error('批量入库失败:', e);
      message.error(`入库失败：${e.message || '未知错误'}`);
    }
  };

  // ====== 批量洞察 ======
  const runBatchInsight = () => setBatchInsightOpen(true);
  const confirmBatchInsight = async () => {
    const selected = nodes.filter((n: any) => checkedIds.has(n.id) && n.node_type === 'terminal');
    if (selected.length === 0) { message.warning('未选中 terminal 节点'); return; }
    setBatchInsightOpen(false);
    setBatchProgress({ done: 0, total: selected.length });
    // 有界并发：同时最多2个洞察，避免 API 请求风暴，速度仍远快于串行
    const CONCURRENCY = 2;
    let done = 0;
    const queue = [...selected];
    const worker = async () => {
      while (queue.length > 0) {
        const node = queue.shift()!;
        try { await handleNodeInsight(node); } catch { /* 单个失败不阻塞 */ }
        done++;
        setBatchProgress({ done, total: selected.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));
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

  const renderSkillDimensions = (skillId: string, dims: any[]) => {
    const evidenceColors: Record<string, string> = { '强': '#10B981', '中': '#3B82F6', '弱': '#F59E0B', '未验证': '#94A3B8' };

    // SWOT：2x2 四象限矩阵
    if (skillId === 'swot') {
      const quad = (key: string, color: string, bg: string) => {
        const d = dims.find(x => x.dimension_type === key);
        return (
          <div style={{ padding: 10, background: bg, borderRadius: 8, border: `1px solid ${color}22` }}>
            <div style={{ fontWeight: 700, fontSize: 12, color, marginBottom: 4 }}>{key}</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#334155' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{d?.content || '公开信息不足'}</ReactMarkdown>
            </div>
            {d?.source_url && (
              <a href="#" onClick={(e) => { e.preventDefault(); openExternal(d.source_url); }} style={{ fontSize: 10.5, color: '#3B82F6' }}>
                <LinkOutlined style={{ fontSize: 10, marginRight: 3 }} />{d.source_title || '来源'}
              </a>
            )}
          </div>
        );
      };
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {quad('优势(Strengths)', '#10B981', '#F0FDF4')}
          {quad('劣势(Weaknesses)', '#EF4444', '#FEF2F2')}
          {quad('机会(Opportunities)', '#3B82F6', '#EFF6FF')}
          {quad('威胁(Threats)', '#F59E0B', '#FFFBEB')}
        </div>
      );
    }

    // PEST：四宫格
    if (skillId === 'pest') {
      const quads = [
        { key: '政治(Political)', color: '#1E40AF', bg: '#EFF6FF' },
        { key: '经济(Economic)', color: '#047857', bg: '#ECFDF5' },
        { key: '社会(Social)', color: '#B45309', bg: '#FFFBEB' },
        { key: '技术(Technological)', color: '#6D28D9', bg: '#F5F3FF' },
      ];
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {quads.map(q => {
            const d = dims.find(x => x.dimension_type === q.key);
            return (
              <div key={q.key} style={{ padding: 10, background: q.bg, borderRadius: 8, border: `1px solid ${q.color}22` }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: q.color, marginBottom: 4 }}>{q.key}</div>
                <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#334155' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{d?.content || '公开信息不足'}</ReactMarkdown>
                </div>
                {d?.source_url && (
                  <a href="#" onClick={(e) => { e.preventDefault(); openExternal(d.source_url); }} style={{ fontSize: 10.5, color: '#3B82F6' }}>
                    <LinkOutlined style={{ fontSize: 10, marginRight: 3 }} />{d.source_title || '来源'}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    // 竞争格局：波特五力强度条
    if (skillId === 'competition') {
      const five = [
        { key: '供应商议价能力', strong: '供方强势', weak: '供方弱势' },
        { key: '买方议价能力', strong: '买方强势', weak: '买方弱势' },
        { key: '行业内竞争强度', strong: '竞争激烈', weak: '竞争缓和' },
        { key: '替代品威胁', strong: '替代威胁大', weak: '替代威胁小' },
        { key: '新进入者威胁', strong: '进入威胁大', weak: '进入威胁小' },
      ];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {five.map(f => {
            const d = dims.find(x => x.dimension_type === f.key);
            return (
              <div key={f.key} style={{ padding: 8, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{f.key}</span>
                  <span style={{ fontSize: 10.5, color: '#9CA3AF' }}>{f.strong} ← → {f.weak}</span>
                </div>
                <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#334155' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{d?.content || '公开信息不足'}</ReactMarkdown>
                </div>
                {d?.source_url && (
                  <a href="#" onClick={(e) => { e.preventDefault(); openExternal(d.source_url); }} style={{ fontSize: 10.5, color: '#3B82F6' }}>
                    <LinkOutlined style={{ fontSize: 10, marginRight: 3 }} />{d.source_title || '来源'}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    // 风险评估：等级化风险卡
    if (skillId === 'risk') {
      const riskLevel = (content: string) => {
        if (/高|严重|紧急|重大/.test(content)) return { color: '#DC2626', bg: '#FEF2F2', lbl: '高风险' };
        if (/中|一般|中等/.test(content)) return { color: '#D97706', bg: '#FFFBEB', lbl: '中风险' };
        if (/低|轻微|较小/.test(content)) return { color: '#059669', bg: '#ECFDF5', lbl: '低风险' };
        return { color: '#6B7280', bg: '#F9FAFB', lbl: '待评估' };
      };
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {dims.map((d, idx) => {
            const lv = riskLevel(d.content || '');
            return (
              <div key={idx} style={{ padding: 10, background: lv.bg, borderRadius: 8, border: `1px solid ${lv.color}33` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 12 }}>{d.dimension_type}</span>
                  <Tag color={lv.color} style={{ fontSize: 9.5, margin: 0, fontWeight: 700 }}>{lv.lbl}</Tag>
                </div>
                <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#334155' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
                </div>
                {d.source_url && (
                  <a href="#" onClick={(e) => { e.preventDefault(); openExternal(d.source_url); }} style={{ fontSize: 10.5, color: '#3B82F6' }}>
                    <LinkOutlined style={{ fontSize: 10, marginRight: 3 }} />{d.source_title || '来源'}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    // 供应链韧性：三要素评分条
    if (skillId === 'resilience') {
      const scoreOf = (content: string) => {
        if (/高|强|充足|多源|灵活/.test(content)) return { v: 85, color: '#10B981', lbl: '强' };
        if (/中|一般|中等/.test(content)) return { v: 55, color: '#F59E0B', lbl: '中' };
        if (/低|弱|不足|单一|缺乏/.test(content)) return { v: 25, color: '#EF4444', lbl: '弱' };
        return { v: 50, color: '#94A3B8', lbl: '待评估' };
      };
      const scoreDims = dims.filter(d => d.dimension_type !== '韧性评分与建议');
      const finalDim = dims.find(d => d.dimension_type === '韧性评分与建议');
      return (
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {scoreDims.map((d, idx) => {
              const sc = scoreOf(d.content || '');
              return (
                <div key={idx}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{d.dimension_type}</span>
                    <Tag color={sc.color} style={{ fontSize: 9.5, margin: 0, fontWeight: 700 }}>{sc.lbl}</Tag>
                  </div>
                  <div style={{ height: 8, background: '#E5E7EB', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${sc.v}%`, height: '100%', background: sc.color, borderRadius: 4, transition: 'width .3s' }} />
                  </div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#334155', marginTop: 4 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
                  </div>
                </div>
              );
            })}
          </div>
          {finalDim && (
            <div style={{ marginTop: 10, padding: 10, background: '#F0FDF4', border: '1px solid #86EFAC55', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#047857', marginBottom: 4 }}>🎯 {finalDim.dimension_type}</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#334155' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{finalDim.content}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      );
    }

    // 默认：标准列表
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {dims.map((dim: any, idx: number) => (
          <div key={idx} style={{ padding: '8px 10px', background: '#fff', borderRadius: 8, border: '1px solid #E2E8F0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}><BorderOutlined style={{ fontSize: 11, marginRight: 4, color: '#3B82F6' }} />{dim.dimension_type}</span>
              <Tag color={evidenceColors[dim.evidence_strength] || '#94A3B8'} style={{ fontSize: 9, margin: 0 }}>{dim.evidence_strength}</Tag>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: '#334155' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{dim.content}</ReactMarkdown>
            </div>
            {dim.source_url && (
              <a href="#" onClick={(e) => { e.preventDefault(); openExternal(dim.source_url); }} style={{ fontSize: 11, color: '#3B82F6' }}>
                <LinkOutlined style={{ fontSize: 11, marginRight: 4 }} />{dim.source_title || dim.source_url}
              </a>
            )}
          </div>
        ))}
      </div>
    );
  };

  // ====== 渲染：清单页 ======
  if (view === 'list') {
    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;
    return (
      <div style={{ padding: '0 20px', maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="page-title" style={{ marginBottom: 0 }}>
            <SignalFilled /> 物料趋势洞察
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

        {/* 快捷洞察区：无需分解树，直接洞察单个物料行情 */}
        <Card
          size="small"
          title={
            <Space>
              <ThunderboltOutlined style={{ color: '#F59E0B' }} />
              <span>快捷洞察 ({quickItems.length})</span>
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
                无需分解树，直接查询单个物料行情（如"锂电池"）
              </span>
            </Space>
          }
          extra={
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setQuickAddName(''); setQuickAddOpen(true); }} style={{ fontWeight: 600 }}>
              添加物料
            </Button>
          }
          style={{ marginBottom: 20, borderTop: '3px solid #F59E0B' }}
        >
          {quickItems.length === 0 ? (
            <Empty description="还没有快捷洞察物料 — 点右上角「添加物料」直接洞察想查的行情（无需分解）" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '20px 0' }} />
          ) : (
            <>
            <Row gutter={[12, 12]}>
              {quickItems.map((item: any) => {
                const snap = quickSnapMap[item.id];
                const dir = snap?.direction || '';
                const dirColor = TREND_COLORS[dir] || '#94A3B8';
                const lastTime = snap?.query_time || item.last_queried_at;
                return (
                  <Col key={item.id} xs={24} sm={12} md={8} lg={6}>
                    <Card
                      size="small"
                      hoverable
                      style={{ borderLeft: `3px solid ${dirColor}`, cursor: 'pointer' }}
                      bodyStyle={{ padding: '10px 12px' }}
                      onClick={() => openQuickDetail(item)}
                      actions={[
                        <Button key="insight" size="small" type="primary" icon={<RadarChartOutlined />}
                          onClick={(e) => { e.stopPropagation(); quickInsight(item.query_category, item.id); }}>
                          洞察行情
                        </Button>,
                        <Popconfirm key="del" title={`删除「${item.query_category}」？`}
                          onConfirm={async () => {
                            const { deleteQuickTrendItem } = await import('../db');
                            await deleteQuickTrendItem(item.id);
                            message.success('已删除');
                            loadQuickItems();
                          }}>
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                        </Popconfirm>,
                      ]}
                    >
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{item.query_category}</div>
                        {/* 最近洞察时间 */}
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          <ClockCircleOutlined style={{ marginRight: 4 }} />
                          {lastTime ? formatTime(lastTime) : '尚未洞察'}
                        </div>
                        {/* 成本趋势 */}
                        {snap ? (
                          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Tag color={dirColor} style={{ fontSize: 11, margin: 0 }}>{TREND_ICONS[dir] || ''} {dir}</Tag>
                            <Tag style={{ fontSize: 10, margin: 0 }}>{snap.confidence_level}置信</Tag>
                            {snap.magnitude_min != null && (
                              <span style={{ fontSize: 11, color: '#666' }}>
                                幅度 {String(snap.magnitude_min).replace('%', '')}%~{String(snap.magnitude_max).replace('%', '')}%
                              </span>
                            )}
                          </div>
                        ) : (
                          <div style={{ marginTop: 6, fontSize: 11, color: '#F59E0B' }}>
                            <ClockCircleOutlined style={{ marginRight: 4 }} />待洞察
                          </div>
                        )}
                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              <HistoryOutlined style={{ marginRight: 4 }} /> 点击卡片查看详情（分 Skill 结果 / 历史对比 / 融合总结）
            </div>
            </>
          )}
        </Card>

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
                              // 创建 trend_item（本地时间，与 SQLite 一致）
                              const now = new Date();
                              const pad = (n: number) => String(n).padStart(2, '0');
                              const localTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
                              const newId = await saveTrendItem({
                                material_name: part.name,
                                category_type: part.main_category,
                                last_queried_at: localTime,
                                source_type: 'quick',
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
              <BulbOutlined style={{ marginRight: 4 }} /> 在"器件库"中开启"关注趋势"可将物料添加到此列表
            </div>
          </Card>
        )}

        {/* 顶层物料标题 */}
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>
          <ApartmentOutlined /> 顶层物料清单
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
                          <div><InboxOutlined /> {stats.total} 个节点 · {stats.confirmed} 已确认</div>
                          <Space size={6} style={{ marginTop: 4 }}>
                            <Button size="small" type="primary" icon={<BranchesOutlined />} onClick={() => enterTreeView(node.id)}>查看分解树</Button>
                            <Button size="small" icon={<RadarChartOutlined />} onClick={() => requestInsightWithPreview(node)}>AI 洞察</Button>
                          </Space>
                          {stats.pendingInsight > 0 && <div style={{ color: '#F59E0B' }}><ClockCircleOutlined style={{ marginRight: 4 }} />{stats.pendingInsight} 个待洞察</div>}
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

            {/* 调试按钮：打开控制台 */}
            <Button
              size="small"
              icon={<BugOutlined />}
              onClick={() => {
                // 提示用户右键打开控制台
                Modal.info({
                  title: '打开开发者控制台',
                  content: (
                    <div>
                      <p>请按以下方式打开控制台查看调试信息：</p>
                      <ol>
                        <li>在窗口任意位置<strong>右键点击</strong></li>
                        <li>选择"<strong>Inspect Element</strong>"或"<strong>检查元素</strong>"</li>
                        <li>控制台会显示详细的错误信息</li>
                      </ol>
                      <p style={{ marginTop: 12, color: '#666', fontSize: 12 }}>
                        或者尝试按 <code>F12</code> 或 <code>Ctrl+Shift+I</code>
                      </p>
                    </div>
                  ),
                  okText: '知道了'
                });
              }}
            >
              调试
            </Button>

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
                onNodeMouseEnter={(_, node: any) => {
                  if (focusNodeId) return;
                  const chain = getAncestorChain(Number(node.id));
                  setChainPath(chain);
                  applyChainHighlight(new Set(chain.map(c => c.id)), false);
                }}
                onNodeMouseLeave={() => { if (!focusNodeId) { setChainPath([]); clearChainHighlight(); } }}
                onNodeDoubleClick={(_, node: any) => {
                  if (focusNodeId === Number(node.id)) {
                    setFocusNodeId(null); setChainPath([]); clearChainHighlight();
                  } else {
                    const chain = getAncestorChain(Number(node.id));
                    setFocusNodeId(Number(node.id));
                    setChainPath(chain);
                    applyChainHighlight(new Set(chain.map(c => c.id)), true);
                  }
                }}
                onPaneClick={() => { setSelectedId(null); setSelectedNode(null); setCanvasHintVisible(true); setRfNodes((current: any[]) => current.map((node: any) => ({ ...node, selected: false }))); clearChainHighlight(); setFocusNodeId(null); setChainPath([]); }}
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
                                <Panel position="top-left" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, background: 'rgba(255,255,255,0.92)', borderRadius: 10, padding: '6px 12px', boxShadow: '0 2px 10px rgba(0,0,0,0.08)', maxWidth: 480, overflow: 'hidden' }}>
                  <span style={{ color: '#86868B', flexShrink: 0 }}>路径</span>
                  {chainPath.length > 0
                    ? chainPath.map((c, i) => (
                        <span key={c.id} style={{ whiteSpace: 'nowrap' }}>
                          {i > 0 && <span style={{ color: '#C7C7CC', margin: '0 2px' }}>›</span>}
                          <b style={{ fontWeight: i === chainPath.length - 1 ? 700 : 500, color: i === chainPath.length - 1 ? '#007AFF' : '#1D1D1F', cursor: 'pointer' }}
                            onClick={() => { const n = nodes.find((x: any) => x.id === c.id); if (n && setSelectedNode) { setSelectedId(c.id); setSelectedNode(n); } }}>
                            {c.name}
                          </b>
                        </span>
                      ))
                    : <span style={{ color: '#C7C7CC' }}>悬停节点看血缘链 · 双击聚焦</span>}
                  {focusNodeId != null && <span style={{ color: '#FF9500', flexShrink: 0, marginLeft: 4 }}>聚焦中 ✕</span>}
                </Panel>
<Panel position="top-left">
                  <div style={{ padding: '8px 10px', borderRadius: 10, background: 'color-mix(in srgb, var(--card-bg, #fff) 92%, transparent)', border: '1px solid var(--card-border, #E2E8F0)', boxShadow: '0 4px 12px rgba(15,23,42,0.08)', fontSize: 11, color: 'var(--text-secondary, #475569)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 3 }}><ApartmentOutlined /> 智能分解画布</div>
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
                    {selectedNode.insight_status === 'pending' && selectedNode.node_type === 'terminal' && <Tag color="gold" icon={<ClockCircleOutlined />}>待洞察</Tag>}
                    {rollupResult?.source_type === 'aggregated' && <Tag color="purple" icon={<BarChartOutlined />}>已汇总</Tag>}
                  </div>
                  <Space wrap>
                    {selectedNode.source_type === 'ai_draft' && (
                      <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => confirmNode(selectedNode)}>确认</Button>
                    )}
                    {selectedNode.source_type === 'user_confirmed' && selectedNode.node_type !== 'terminal' && (
                      <Button size="small" icon={<ThunderboltOutlined />} onClick={() => { setAiDraftParentId(selectedNode.id); setAiDraftName(selectedNode.component_name); setAiDraftResult([]); setAiDraftOpen(true); }}>AI拆解</Button>
                    )}
                    {/* 终端节点：发起洞察 */}
                    {selectedNode.source_type === 'user_confirmed' && selectedNode.node_type === 'terminal' && (
                      <Tooltip title="只发送物料通用名称，不包含本地价格、供应商和 BOM 数据。">
                        <Button size="small" type="primary" icon={<RadarChartOutlined />}
                          onClick={() => requestInsightWithPreview(selectedNode)} loading={insightLoading}>
                          {selectedNode.insight_status === 'queried' ? '重新洞察行情' : 'AI 洞察行情'}
                        </Button>
                      </Tooltip>
                    )}
                    {/* 结构节点：既可以直接洞察，也可以汇总子节点 */}
                    {selectedNode.source_type === 'user_confirmed' && selectedNode.node_type !== 'terminal' && (
                      <Space size={8}>
                        <Tooltip title="直接对该结构节点发起市场行情洞察">
                          <Button size="small" icon={<RadarChartOutlined />} type="primary"
                            onClick={() => requestInsightWithPreview(selectedNode)} loading={insightLoading}>
                            洞察行情
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
                    <WarningOutlined style={{ marginRight: 6 }} />{childrenQueried.length}/{childrenTotal.length} 个子节点已洞察，汇总可能不完整。
                  </div>
                )}

                {rollupResult?.source_type === 'aggregated' && (
                  <div style={{ marginBottom: 12, padding: 12, background: 'var(--main-bg)', borderRadius: 10, border: '1px solid #C4B5FD' }}>
                    <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ApartmentOutlined /> 趋势汇总
                    </div>
                    <Space><Tag color={TREND_COLORS[rollupResult.direction]} style={{ fontSize: 13 }}>{TREND_ICONS[rollupResult.direction]} {rollupResult.direction}</Tag><Tag>{rollupResult.confidence_level}置信</Tag><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rollupResult.query_time?.slice(0, 10)}</span></Space>
                    <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{rollupResult.summary}</ReactMarkdown></div>
                  </div>
                )}

                {(() => {
                  const directSnaps = snapshots.filter(s => s.source_type !== 'aggregated');
                  if (directSnaps.length === 0) return null;
                  // snapshots 按 query_time DESC 排序，第一条即最新洞察
                  const s = directSnaps[0];
                  if (!s) return null;
                  // 与上一次洞察方向对比（提示判断变化）
                  const prev = directSnaps[1];
                  const dirConflict = prev && prev.direction && s.direction
                    && prev.direction !== s.direction
                    && !['震荡', '信号不明确'].includes(s.direction);
                  return (
                    <div style={{ marginBottom: 12, padding: 12, background: 'var(--main-bg)', borderRadius: 10, border: '1px solid var(--card-border)' }}>
                      <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <RadarChartOutlined /> 最新洞察 {s.skill_used ? <Tag style={{ fontSize: 10 }}>框架：{s.skill_used}</Tag> : null}
                      </div>
                      {dirConflict && (
                        <div style={{ fontSize: 12, color: '#B45309', marginBottom: 8, padding: '6px 10px', background: '#FFF7ED', borderRadius: 6 }}>
                          <WarningOutlined style={{ marginRight: 6 }} />本次方向「{s.direction}」与上次洞察「{prev.direction}」不同（{prev.query_time?.slice(0, 10)}），建议核实数据口径或查看历史快照对比。
                        </div>
                      )}
                      <Space><Tag color={TREND_COLORS[s.direction]} style={{ fontSize: 13 }}>{TREND_ICONS[s.direction]} {s.direction}</Tag><Tag>{s.confidence_level}置信</Tag>{s.magnitude_min != null && <Tag>幅度 {String(s.magnitude_min).replace('%', '')}% ~ {String(s.magnitude_max).replace('%', '')}%</Tag>}<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.query_time?.slice(0, 10)}</span></Space>
                      <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{s.summary}</ReactMarkdown></div>
                      {/* 维度展示 */}
                      {insightDimensions.length > 0 && (
                        <div style={{ marginTop: 12, borderTop: '1px solid var(--card-border)', paddingTop: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <BarsOutlined /> 分维度分析
                            </div>
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
                                  label: time ? new Date(time).toLocaleString('zh-CN') : '早期记录'
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
                                      <BulbOutlined style={{ fontSize: 16 }} />
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
                                      const skillIcon = skill ? skill.icon : <BarChartOutlined />;

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
                                          {/* 按 Skill 定制呈现 */}
                                          {renderSkillDimensions(skillId, dims)}
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
                                const skillIcon = skill ? skill.icon : <BarChartOutlined />;

                                return (
                                  <div key={skillId} style={{ marginBottom: 16, padding: 10, background: '#f9fafb', borderRadius: 6 }}>
                                    <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 12, color: '#4b5563' }}>
                                      {skillIcon} {skillName}
                                    </div>
                                    {renderSkillDimensions(skillId, dims)}
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

                {/* 节点关键信息 - 紧凑展示 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12, fontSize: 12 }}>
                  <Tag color={selectedNode.source_type === 'ai_draft' ? 'orange' : 'green'}>
                    {selectedNode.source_type === 'ai_draft' ? 'AI草稿' : '已确认'}
                  </Tag>
                  {selectedNode.cost_ratio_estimate != null && (
                    <Tag>成本占比 {selectedNode.cost_ratio_estimate}%</Tag>
                  )}
                  <Tag color={selectedNode.insight_status === 'queried' ? 'green' : 'gold'} icon={selectedNode.insight_status === 'queried' ? <CheckOutlined /> : <ClockCircleOutlined />}>
                    {selectedNode.insight_status === 'queried' ? '已洞察' : '待洞察'}
                  </Tag>
                  {selectedNode.updated_at && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      <ClockCircleOutlined style={{ marginRight: 4 }} />
                      {new Date(selectedNode.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {selectedNode.parent_id && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      父节点: {nodes.find((n: any) => n.id === selectedNode.parent_id)?.component_name || '-'}
                    </span>
                  )}
                </div>

                {trendSources.length > 0 && (
                  <div style={{ marginTop: 12, padding: 12, border: '1px solid #E2E8F0', borderRadius: 8, background: '#F8FAFC' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <h4 style={{ margin: 0 }}>依据来源</h4>
                      <Tag color="blue" style={{ margin: 0 }}>{trendSources.length} 条</Tag>
                    </div>
                    <List
                      size="small"
                      dataSource={sourcesExpanded ? trendSources : trendSources.slice(0, 3)}
                      renderItem={(source: any, index) => (
                        <List.Item style={{ alignItems: 'flex-start', padding: '8px 0' }}>
                          <div style={{ width: '100%' }}>
                            <a
                              href={source.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => {
                                e.preventDefault();
                                openExternal(source.source_url);
                              }}
                              style={{ fontSize: 12, fontWeight: 600 }}
                            >
                              {index + 1}. {source.source_title || source.source_url}
                            </a>
                            {source.excerpt && (
                              <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: '#64748B' }}>
                                {source.excerpt}
                              </div>
                            )}
                          </div>
                        </List.Item>
                      )}
                    />
                    {trendSources.length > 3 && (
                      <div
                        onClick={() => setSourcesExpanded(v => !v)}
                        style={{ marginTop: 6, fontSize: 12, color: '#3B82F6', cursor: 'pointer', textAlign: 'center', padding: '4px 0', borderTop: '1px solid #E2E8F0' }}
                      >
                        {sourcesExpanded ? '▲ 收起' : `▼ 展开剩余 ${trendSources.length - 3} 条来源`}
                      </div>
                    )}
                  </div>
                )}

                {/* 历史记录时间线 */}
                {snapshots.length > 1 && (
                  <div style={{ marginTop: 12, padding: 12, border: '1px solid #E2E8F0', borderRadius: 8, background: '#F8FAFC' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <HistoryOutlined /> 历史洞察记录
                      </h4>
                      <Tag color="purple" style={{ margin: 0 }}>{snapshots.length} 次</Tag>
                    </div>
                    <Timeline
                      mode="left"
                      items={snapshots.slice().reverse().map((snap: any) => ({
                        color: TREND_COLORS[snap.direction] || '#94A3B8',
                        dot: snap.source_type === 'aggregated' ? <ApartmentOutlined /> : <RadarChartOutlined />,
                        children: (
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <Tag color={TREND_COLORS[snap.direction]} style={{ margin: 0 }}>
                                {TREND_ICONS[snap.direction]} {snap.direction}
                              </Tag>
                              {snap.confidence_level && <Tag style={{ margin: 0 }}>{snap.confidence_level}置信</Tag>}
                              {snap.source_type === 'aggregated' && <Tag color="purple" style={{ margin: 0 }}>汇总</Tag>}
                              {snap.skill_used && <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>{snap.skill_used}</Tag>}
                            </div>
                            <div style={{ fontSize: 11, color: '#64748B', marginBottom: 4 }}>
                              <ClockCircleOutlined /> {snap.query_time ? new Date(snap.query_time).toLocaleString('zh-CN') : `第 ${snapshots.length - snapshots.slice().reverse().indexOf(snap) - 1 + 1} 次洞察`}
                            </div>
                            {snap.summary && (
                              <div style={{ fontSize: 12, lineHeight: 1.5, color: '#475569', marginTop: 6 }}>
                                {snap.summary.slice(0, 100)}{snap.summary.length > 100 ? '...' : ''}
                              </div>
                            )}
                          </div>
                        ),
                      }))}
                    />
                  </div>
                )}

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
                    { title: '洞察', dataIndex: 'insight_status', width: 50, render: (v: string) => v === 'queried' ? <CheckOutlined style={{ color: '#10B981' }} /> : <ClockCircleOutlined style={{ color: '#F59E0B' }} /> },
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
                <h4 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span><QuestionCircleOutlined /> 智能追问</span>
                  {conversations.length > 0 && (
                    <Tag color="blue">{conversations.length} 条对话</Tag>
                  )}
                </h4>
                {conversations.length > 0 && (
                  <div style={{ marginBottom: 8, padding: '8px 12px', background: 'var(--main-bg)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    最近追问：{conversations[conversations.length - 1]?.question}
                  </div>
                )}
                <Button
                  type="primary"
                  block
                  icon={<SendOutlined />}
                  onClick={() => setFollowUpModalOpen(true)}
                  disabled={!selectedNode?.trend_item_id}
                  style={{ borderRadius: 8 }}
                >
                  {conversations.length > 0 ? '继续追问' : '开始追问'}
                </Button>
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                  <BulbOutlined style={{ marginRight: 4 }} /> 点击打开对话窗口，自动联网搜索最新信息
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {renderModals()}
    </div>
  );

  // ====== 按 Skill 定制维度呈现 ======
  // 不同分析框架使用不同的可视化形式（SWOT矩阵/PEST四宫格/五力强度条/风险等级卡/韧性评分）
  // ====== 共享弹窗 ======
  function renderModals() {
    return (
      <>
        {/* 添加快捷洞察物料弹窗 */}
        <Modal title={<Space size={6}><ThunderboltOutlined />添加快捷洞察物料</Space>} open={quickAddOpen}
          onCancel={() => setQuickAddOpen(false)}
          onOk={confirmQuickAdd} okText="添加" cancelText="取消" width={440}>
          <div style={{ padding: '8px 0' }}>
            <div style={{ marginBottom: 8, fontSize: 12.5, color: '#64748b' }}>
              输入想查询行情的物料名称（如"锂电池"、"MLCC"、"32寸LCD面板"），无需分解，直接洞察行情趋势。
            </div>
            <Input
              placeholder="输入物料名称，如：锂电池"
              value={quickAddName}
              onChange={e => setQuickAddName(e.target.value)}
              onPressEnter={confirmQuickAdd}
              autoFocus
              style={{ borderRadius: 8 }}
            />
          </div>
        </Modal>

        {/* 快捷洞察详情弹窗：分 Skill 结果 + 历史 + 融合总结 */}
        <Modal
          title={<Space size={6}><RadarChartOutlined style={{ color: '#F59E0B' }} />「{quickDetailItem?.query_category || ''}」洞察详情</Space>}
          open={!!quickDetailItem}
          onCancel={() => setQuickDetailItem(null)}
          footer={null}
          width={820}
          destroyOnClose
        >
          {quickDetailLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          ) : (
            <div style={{ padding: '4px 0' }}>
              {/* ===== 历史洞察时间轴（横向节点，点击切换批次） ===== */}
              {(() => {
                if (quickDetailSnaps.length === 0) {
                  return <Empty description="尚未洞察，点击卡片上的「洞察行情」开始分析" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 30 }} />;
                }
                // 按 query_time 分批次（quickDetailSnaps 已按 id DESC，最新在前）
                const byBatch: Record<string, any[]> = {};
                quickDetailSnaps.forEach(s => {
                  const k = s.query_time || 'unknown';
                  if (!byBatch[k]) byBatch[k] = [];
                  byBatch[k].push(s);
                });
                const batchKeys = Object.keys(byBatch);
                // 时间轴节点：从左到右时间递增（最早在左，最近在右）
                const timelineKeys = [...batchKeys].reverse();
                // 当前选中批次（默认最新 = batchKeys[0]，即 timelineKeys 最右）
                const curBatch = byBatch[quickDetailBatch] || byBatch[batchKeys[0]] || [];
                const curKey = (quickDetailBatch && byBatch[quickDetailBatch]) ? quickDetailBatch : batchKeys[0];
                const isLatest = curKey === batchKeys[0];

                // 融合总结（选中批次多 Skill 时）
                const dirs = curBatch.map(s => s.direction);
                const upCount = dirs.filter(d => d === '上涨').length;
                const downCount = dirs.filter(d => d === '下降').length;
                const unClear = dirs.filter(d => !d || d === '信号不明确').length;
                let fusedDir = '信号不明确';
                let fusedConf = '低';
                if (upCount > downCount && upCount > unClear) { fusedDir = '上涨'; fusedConf = upCount >= 2 ? '中' : '低'; }
                else if (downCount > upCount && downCount > unClear) { fusedDir = '下降'; fusedConf = downCount >= 2 ? '中' : '低'; }
                else if (unClear === 0 && upCount === downCount) { fusedDir = '震荡'; fusedConf = '中'; }

                return (
                  <div>
                    {/* 时间轴 */}
                    <div style={{ marginBottom: 14, padding: '12px 14px', background: '#F8FAFC', border: '1px solid #EEF2F8', borderRadius: 10 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#64748B', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <HistoryOutlined /> 历史洞察时间轴（{batchKeys.length} 批）
                        <span style={{ fontWeight: 400, color: '#94A3B8' }}>点击节点切换查看</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
                        {timelineKeys.map((k, idx) => {
                          const batch = byBatch[k];
                          const sel = k === curKey;
                          // 该批次融合方向（多数）
                          const bDirs = batch.map(s => s.direction);
                          const bUp = bDirs.filter(d => d === '上涨').length;
                          const bDown = bDirs.filter(d => d === '下降').length;
                          const bDir = bUp > bDown ? '上涨' : bDown > bUp ? '下降' : '震荡';
                          const bColor = TREND_COLORS[bDir] || '#94A3B8';
                          return (
                            <div key={k} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                              <div
                                onClick={() => setQuickDetailBatch(k)}
                                style={{
                                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer',
                                  padding: '4px 2px', minWidth: 74,
                                }}
                              >
                                {/* 节点圆（选中高亮） */}
                                <div style={{
                                  width: 14, height: 14, borderRadius: '50%',
                                  background: sel ? bColor : '#fff',
                                  border: `2.5px solid ${bColor}`,
                                  boxShadow: sel ? `0 0 0 4px ${bColor}33` : 'none',
                                  transition: 'all .2s',
                                }} />
                                <div style={{
                                  fontSize: 10, fontWeight: sel ? 700 : 500,
                                  color: sel ? '#1E293B' : '#64748B', whiteSpace: 'nowrap',
                                }}>
                                  {formatTime(k).slice(5)} {/* MM-DD HH:mm */}
                                </div>
                                <div style={{ fontSize: 9, color: sel ? bColor : '#94A3B8', fontWeight: 600 }}>
                                  {TREND_ICONS[bDir] || ''} {bDir} · {batch.length}
                                </div>
                                {/* 选中节点显示删除按钮 */}
                                {sel && batchKeys.length > 1 && (
                                  <Popconfirm
                                    title={`删除该批次（${formatTime(k)}）的 ${batch.length} 条洞察？`}
                                    onConfirm={async () => {
                                      try {
                                        const { deleteTrendSnapshot } = await import('../db');
                                        for (const s of batch) {
                                          await deleteTrendSnapshot(s.id);
                                        }
                                        message.success('已删除该批次洞察');
                                        // 重新加载详情
                                        if (quickDetailItem) await openQuickDetail(quickDetailItem);
                                        loadQuickItems();
                                      } catch (e: any) {
                                        message.error('删除失败: ' + (e?.message || '未知错误'));
                                      }
                                    }}
                                  >
                                    <Button
                                      size="small" type="text" danger
                                      icon={<DeleteOutlined />}
                                      style={{ fontSize: 10, padding: 0, height: 18, marginTop: 2 }}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  </Popconfirm>
                                )}
                              </div>
                              {idx < batchKeys.length - 1 && (
                                <div style={{ width: 18, height: 2, background: '#E2E8F0', marginTop: -22, flexShrink: 0 }} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 选中批次的融合总结 */}
                    {curBatch.length > 1 && (
                      <div style={{ marginBottom: 14, padding: 14, background: 'linear-gradient(135deg, #F0F6FF, #EEF2F8)', borderRadius: 10, border: '1px solid #D5E0FF' }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <MergeCellsOutlined style={{ color: '#4F46E5' }} /> {isLatest ? '多框架融合总结' : '该批次融合总结'}
                          <Tag color={TREND_COLORS[fusedDir]} style={{ fontSize: 11, margin: 0 }}>{TREND_ICONS[fusedDir] || ''} {fusedDir}</Tag>
                          <Tag style={{ fontSize: 10, margin: 0 }}>{fusedConf}置信</Tag>
                          <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>{formatTime(curKey)}</span>
                        </div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.9, color: '#3A4760', whiteSpace: 'pre-wrap' }}>
                          {curBatch.map(s => `【${s.skill_used || '分析'}】${s.summary || ''}`).join('\n')}
                        </div>
                        <div style={{ marginTop: 6, fontSize: 11, color: '#6B7280' }}>
                          ℹ️ 融合规则：以多数 Skill 方向为准；各 Skill 结果可分别查看下方详情
                        </div>
                      </div>
                    )}

                    {/* 选中批次：按 Skill 分组差异化呈现 */}
                    <div style={{ display: 'grid', gridTemplateColumns: curBatch.length > 1 ? '1fr 1fr' : '1fr', gap: 10 }}>
                      {curBatch.map(s => {
                        const skill = BUILTIN_SKILLS.find((x: any) => x.id === s.skill_used);
                        const dims = quickDetailDims.filter(d => d._snapshot_id === s.id);
                        return (
                          <div key={s.id} style={{ padding: 12, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #F1F5F9' }}>
                              <span style={{ fontSize: 15 }}>{skill?.icon || '📊'}</span>
                              <span style={{ fontWeight: 700, fontSize: 13 }}>{skill?.name || s.skill_used || '分析'}</span>
                              <span style={{ marginLeft: 'auto' }}>
                                <Tag color={TREND_COLORS[s.direction]} style={{ fontSize: 10.5, margin: 0 }}>{TREND_ICONS[s.direction] || ''} {s.direction}</Tag>
                                <Tag style={{ fontSize: 9.5, margin: '0 0 0 4px' }}>{s.confidence_level}置信</Tag>
                              </span>
                            </div>
                            <div style={{ fontSize: 12, lineHeight: 1.8, color: '#3A4760', marginBottom: 8 }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.summary || ''}</ReactMarkdown>
                            </div>
                            {s.suggested_action && (
                              <div style={{ fontSize: 11.5, color: '#4F46E5', marginBottom: 8 }}>
                                💡 建议：{s.suggested_action}
                              </div>
                            )}
                            {/* 按 Skill 差异化呈现维度 */}
                            {renderSkillDimensions(s.skill_used || '', dims)}
                          </div>
                        );
                      })}
                    </div>

                    {/* ===== 基于洞察结论追问 ===== */}
                    <div style={{ marginTop: 16, padding: 12, background: '#FAFBFD', border: '1px solid #EEF2F8', borderRadius: 10 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <QuestionCircleOutlined style={{ color: '#4F46E5' }} /> 基于洞察结论追问
                        <span style={{ fontWeight: 400, fontSize: 11, color: '#94A3B8' }}>自动联网搜索最新信息后回答</span>
                      </div>
                      {quickAskHistory.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, maxHeight: 220, overflowY: 'auto' }}>
                          {quickAskHistory.map((c, i) => (
                            <div key={i} style={{ fontSize: 12, lineHeight: 1.7, color: '#3A4760' }}>
                              <div style={{ fontWeight: 600, color: '#1E293B', marginBottom: 2 }}>Q：{c.q}</div>
                              <div style={{ whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #EEF2F8', borderRadius: 6, padding: '6px 10px' }}>
                                {c.a}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Input
                          placeholder="追问，如：上游碳酸锂价格波动对电池成本影响有多大？"
                          value={quickAskInput}
                          onChange={e => setQuickAskInput(e.target.value)}
                          onPressEnter={quickAsk}
                          style={{ borderRadius: 8 }}
                          disabled={quickAskLoading}
                        />
                        <Button type="primary" icon={<SendOutlined />} onClick={quickAsk} loading={quickAskLoading} style={{ borderRadius: 8 }}>
                          追问
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Modal>

        {/* 查询预览确认弹窗 */}
        <Modal title={<Space size={6}><SearchOutlined />确认发送洞察查询</Space>} open={previewModalOpen}
          onCancel={() => { setPreviewModalOpen(false); setPreviewTargetNode(null); }}
          onOk={confirmInsightRequest} okText="确认发送" cancelText="取消" width={560}>
          <div style={{ padding: '8px 0' }}>
            <p>即将发送以下查询关键词至外部搜索和LLM服务：</p>
            <div style={{ padding: '12px 16px', background: 'var(--main-bg)', borderRadius: 8, marginBottom: 16, fontSize: 16, fontWeight: 600 }}>
              <SearchOutlined style={{ marginRight: 8 }} />{previewTargetNode?.component_name || ''}
            </div>
            {/* 本次洞察使用的 Skill 多选 */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>本次洞察使用分析框架（可多选）</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {allSkills.map(s => {
                    const sel = previewSkills.includes(s.id);
                    return (
                      <div key={s.id} style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
                        background: sel ? '#eff6ff' : '#f9fafb',
                        border: '1px solid' + (sel ? '#bfdbfe' : '#e5e7eb'),
                        borderRadius: 8, cursor: 'pointer'
                      }}
                        onClick={() => {
                          const next = sel
                            ? previewSkills.filter(x => x !== s.id)
                            : [...previewSkills, s.id];
                          setPreviewSkills(next);
                        }}
                      >
                        <span style={{ fontSize: 16 }}>{s.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.name}</div>
                          <div style={{ fontSize: 10.5, color: '#9ca3af', lineHeight: 1.4 }}>{s.description}</div>
                        </div>
                        {/* 纯视觉勾选（点击由卡片 onClick 控制，避免 Checkbox.Group 全选问题） */}
                        <span style={{
                          width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                          border: '1.5px solid' + (sel ? '#6366F1' : '#D1D5DB'),
                          background: sel ? '#6366F1' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {sel && <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                已选 {previewSkills.length} 个框架 · 多框架并行分析，结果分别存档可对比
              </div>
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
          aiDraftResult.length > 0 && (() => {
            const totalRatio = aiDraftResult.reduce((sum, item) => sum + (item.cost_ratio_estimate || 0), 0);
            const needsNormalize = totalRatio < 95 || totalRatio > 105;
            return needsNormalize ? <Button key="normalize" onClick={() => {
              const sum = aiDraftResult.reduce((s, i) => s + (i.cost_ratio_estimate || 0), 0);
              if (sum > 0) {
                const ratio = 100 / sum;
                setAiDraftResult(aiDraftResult.map(i => ({
                  ...i,
                  cost_ratio_estimate: i.cost_ratio_estimate != null ? Math.round(i.cost_ratio_estimate * ratio * 10) / 10 : null,
                })));
                message.success('已归一化到100%');
              }
            }}>归一化到100%</Button> : null;
          })(),
          <Button key="confirm" type="primary" onClick={confirmAiDraft}>确认入库</Button>,
        ]}>
          <Form><Form.Item label="名称"><Input value={aiDraftName} onChange={e => setAiDraftName(e.target.value)} placeholder="输入物料名称" onPressEnter={handleAiDraft} size="large" /></Form.Item></Form>

          {/* AI分析过程显示 */}
          {aiDraftLoading && (
            <div style={{ margin: '20px 0', padding: '16px', background: 'var(--main-bg)', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <Spin size="small" style={{ marginRight: 8 }} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>AI 分析中...</span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 2, color: 'var(--text-secondary)' }}>
                {aiAnalysisSteps.map((step, idx) => (
                  <div key={idx} style={{
                    paddingLeft: 16,
                    opacity: idx === aiAnalysisSteps.length - 1 ? 1 : 0.6,
                    fontWeight: idx === aiAnalysisSteps.length - 1 ? 600 : 400,
                  }}>
                    {step}
                  </div>
                ))}
              </div>
            </div>
          )}

          {aiDraftResult.length > 0 && (() => {
            const totalRatio = aiDraftResult.reduce((sum, item) => sum + (item.cost_ratio_estimate || 0), 0);
            const needsWarning = totalRatio < 95 || totalRatio > 105;
            return needsWarning ? (
              <Alert type="warning" showIcon
                message={`成本占比总和为 ${totalRatio.toFixed(1)}%，不在合理范围（95%-105%）`}
                description="建议点击「归一化到100%」按钮调整，或手动修改各项占比。"
                style={{ marginBottom: 12 }} />
            ) : (
              <Alert type="success" showIcon
                message={`成本占比总和为 ${totalRatio.toFixed(1)}%，符合要求`}
                style={{ marginBottom: 12 }} />
            );
          })()}
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
                  <div style={{ fontWeight: 600, marginBottom: 8 }}><InboxOutlined /> {result.parentName}</div>
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
              <Radio.Button value="上涨"><RiseOutlined style={{ marginRight: 4 }} />上涨</Radio.Button><Radio.Button value="下降"><FallOutlined style={{ marginRight: 4 }} />下降</Radio.Button><Radio.Button value="震荡"><MinusOutlined style={{ marginRight: 4 }} />震荡</Radio.Button><Radio.Button value="信号不明确"><QuestionCircleOutlined style={{ marginRight: 4 }} />不明</Radio.Button>
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

        {/* 追问对话历史弹窗 */}
        <Modal
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <QuestionCircleOutlined style={{ color: '#8B5CF6' }} />
              <span>智能追问对话</span>
              {selectedNode && <Tag color="blue">{selectedNode.component_name}</Tag>}
            </div>
          }
          open={followUpModalOpen}
          onCancel={() => setFollowUpModalOpen(false)}
          width={900}
          footer={null}
          bodyStyle={{ padding: 0 }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: 600 }}>
            {/* 对话历史区域 */}
            <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', background: '#F9FAFB' }}>
              {conversations.length === 0 ? (
                <Empty
                  description="还没有对话记录"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  style={{ marginTop: 60 }}
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {conversations.map((c: any, i: number) => (
                    <div key={c.id || i} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {/* 用户问题 */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <div style={{
                          maxWidth: '75%',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: '#fff',
                          padding: '12px 16px',
                          borderRadius: '16px 16px 4px 16px',
                          boxShadow: '0 2px 8px rgba(102, 126, 234, 0.3)',
                        }}>
                          <div style={{ fontSize: 13, lineHeight: 1.6, fontWeight: 500 }}>
                            {c.question}
                          </div>
                        </div>
                      </div>

                      {/* AI 回答 */}
                      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                        <div style={{
                          maxWidth: '85%',
                          background: '#fff',
                          border: '1px solid #E5E7EB',
                          padding: '14px 18px',
                          borderRadius: '16px 16px 16px 4px',
                          boxShadow: '0 2px 6px rgba(0, 0, 0, 0.05)',
                        }}>
                          {c.isStreaming && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, color: '#8B5CF6' }}>
                              <Spin size="small" />
                              <span style={{ fontSize: 11 }}>思考中...</span>
                            </div>
                          )}
                          <div style={{ fontSize: 13, lineHeight: 1.7, color: '#1F2937' }}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.answer}</ReactMarkdown>
                          </div>
                          {!c.isStreaming && (
                            <div style={{ marginTop: 8, fontSize: 11, color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <ClockCircleOutlined />
                              <span>{c.created_at ? new Date(c.created_at).toLocaleString('zh-CN') : '刚刚'}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 输入区域 */}
            <div style={{
              borderTop: '1px solid #E5E7EB',
              padding: '16px 24px',
              background: '#fff',
            }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                <Input.TextArea
                  placeholder="继续追问物料行情..."
                  value={convAsk}
                  onChange={e => setConvAsk(e.target.value)}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault();
                      handleNodeAsk();
                    }
                  }}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  style={{ flex: 1, borderRadius: 12, fontSize: 13 }}
                  disabled={!selectedNode?.trend_item_id || convLoading}
                />
                <Tooltip title="Shift+Enter 换行，Enter 发送">
                  <Button
                    type="primary"
                    icon={<SearchOutlined />}
                    size="large"
                    onClick={handleNodeAsk}
                    disabled={!convAsk.trim() || convLoading || !selectedNode?.trend_item_id}
                    loading={convLoading}
                    style={{ height: 40, borderRadius: 12, paddingLeft: 20, paddingRight: 20 }}
                  >
                    搜索并回答
                  </Button>
                </Tooltip>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: '#6B7280' }}>
                <BulbOutlined style={{ marginRight: 4 }} /> 追问会自动联网搜索最新信息，并结合历史对话上下文回答
              </div>
            </div>
          </div>
        </Modal>
      </>
    );
  }
}
