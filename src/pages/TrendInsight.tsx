import { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Select, Input, Tag, Space, Spin, message,
  Descriptions, Input as AntInput, Popconfirm, Empty, Tooltip, Tabs, Card, Checkbox
} from 'antd';
import {
  SearchOutlined, ReloadOutlined, QuestionCircleOutlined,
  SettingOutlined, SendOutlined, DeleteOutlined,
  BookOutlined, LinkOutlined, CalendarOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import {
  getParts, getTrendItem, saveTrendItem, deleteTrendItem,
  getTrendSources, saveTrendSource, clearTrendSources,
  getTrendConversations, saveTrendConversation,
  getTrendItemsWithDetails, saveTrendSnapshot, getTrendSnapshots,
  getTrendInsightDimensions, saveTrendInsightDimensions,
  getTrendKeyEvents, saveTrendKeyEvent,
  getMaterialCategories, addMaterialCategory, removeMaterialCategory,
} from '../db';
import { getCategoryColor } from '../constants';
import { hasSearchConfig, hasLLMConfig } from '../apiConfig';
import { multiTurnAsk, supplementarySearch, agentSearchLoop, getActiveSkill, createStructuredInsight, BUILTIN_SKILLS } from '../trendService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ReactECharts from 'echarts-for-react';

// 用默认浏览器打开链接
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

const TREND_DIRECTIONS: Record<string, { icon: string; color: string; label: string }> = {
  '上涨': { icon: '🔺', color: '#EF4444', label: '上涨' },
  '下降': { icon: '🔻', color: '#10B981', label: '下降' },
  '震荡': { icon: '▬', color: '#F59E0B', label: '震荡' },
  '信号不明确': { icon: '？', color: '#94A3B8', label: '信号不明确' },
};
const CONFIDENCE_COLORS: Record<string, string> = { '高': '#10B981', '中': '#F59E0B', '低': '#EF4444' };
const SUGGESTED_ACTION_COLORS: Record<string, string> = {
  '备料/锁价': '#EF4444',
  '观望': '#F59E0B',
  '维持常规节奏': '#10B981',
};

export default function TrendInsight(_props: any) {
  const [loading, setLoading] = useState(false);
  const [parts, setParts] = useState<any[]>([]);
  const [trendEnabledParts, setTrendEnabledParts] = useState<any[]>([]);
  const [trendItems, setTrendItems] = useState<any[]>([]);
  const [selectedTrendId, setSelectedTrendId] = useState<number | null>(null);
  const [selectedTrend, setSelectedTrend] = useState<any>(null);
  const [trendSources, setTrendSources] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [materialCategories, setMaterialCategories] = useState<any[]>([]);

  // Modals
  const [enableModalOpen, setEnableModalOpen] = useState(false);
  const [enableBatch, setEnableBatch] = useState<any[]>([]);
  const [enableCategoryType, setEnableCategoryType] = useState('直接查询');
  const [enableQueryCategory, setEnableQueryCategory] = useState('');
  const [enableMaterialCategory, setEnableMaterialCategory] = useState('');

  const [queryLoading, setQueryLoading] = useState(false);
  const [leftTab, setLeftTab] = useState('trends');
  const [convLoading, setConvLoading] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');

  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [snapshotDimensions, setSnapshotDimensions] = useState<any[]>([]);
  const [snapshotEvents, setSnapshotEvents] = useState<any[]>([]);
  const [selectedSnapshotIds, setSelectedSnapshotIds] = useState<number[]>([]);
  const [snapshotDetailModalOpen, setSnapshotDetailModalOpen] = useState(false);
  const [viewingSnapshot, setViewingSnapshot] = useState<any>(null);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [skillContent, setSkillContent] = useState('');
  const [skillContentLoading, setSkillContentLoading] = useState(false);
  const [materialModalOpen, setMaterialModalOpen] = useState(false);
  const [newMaterialName, setNewMaterialName] = useState('');
  const [batchQueryOpen, setBatchQueryOpen] = useState(false);
  const [batchQueryItems, setBatchQueryItems] = useState<any[]>([]);
  const [batchQueryProgress, setBatchQueryProgress] = useState('');
  const [quickInsightModalOpen, setQuickInsightModalOpen] = useState(false);
  const [quickInsightName, setQuickInsightName] = useState('');
  const [quickInsightCategory, setQuickInsightCategory] = useState('');
  const [quickInsightSkill, setQuickInsightSkill] = useState('price-trend');

  // 加载数据 + 自动同步趋势条目
  const loadData = async () => {
    setLoading(true);
    try {
      const allParts = await getParts('', '', '');
      setParts(allParts);
      const enabled = allParts.filter((p: any) => p.trend_enabled === 1);
      setTrendEnabledParts(enabled);

      // 自动同步：为已开启趋势关注但尚未关联 trend_item 的器件创建条目
      const existingItems = await getTrendItemsWithDetails();
      for (const part of enabled) {
        const queryCat = part.trend_query_category || part.sub_category || '';
        const catType = part.trend_category_type || '直接查询';
        if (!queryCat) continue;

        const matched = existingItems.find((item: any) =>
          item.query_category === queryCat && item.category_type === catType
        );

        if (matched) {
          // 已有对应条目，检查是否已关联该器件
          const alreadyMapped = matched.mapped_parts?.some((p: any) => p.id === part.id);
          if (!alreadyMapped) {
            await (await import('../db').then(m => m.addTrendMapping))(matched.id, part.id);
          }
        } else {
          // 创建新的趋势条目
          const newId = await saveTrendItem({
            query_category: queryCat,
            category_type: catType,
            trend_direction: '',
            confidence_level: '',
            summary: '',
            suggested_action: '',
            raw_search_results: '',
            last_updated_at: '',
          });
          await (await import('../db').then(m => m.addTrendMapping))(newId, part.id);
        }
      }

      const items = await getTrendItemsWithDetails();
      setTrendItems(items);
      const mats = await getMaterialCategories();
      setMaterialCategories(mats);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  // 选中趋势条目时加载详情 + 快照历史
  useEffect(() => {
    if (selectedTrendId) {
      (async () => {
        // 并行查询所有数据，显著提升性能
        const [item, sources, convs, snaps] = await Promise.all([
          getTrendItem(selectedTrendId),
          getTrendSources(selectedTrendId),
          getTrendConversations(selectedTrendId),
          getTrendSnapshots(selectedTrendId),
        ]);
        setSelectedTrend(item);
        setTrendSources(sources);
        setConversations(convs);
        setSnapshots(snaps);
        setSelectedSnapshotId(snaps.length ? snaps[snaps.length - 1].id : null);
      })();
    } else {
      setSelectedTrend(null);
      setTrendSources([]);
      setConversations([]);
      setSnapshots([]);
      setSelectedSnapshotId(null);
      setSnapshotDimensions([]);
      setSnapshotEvents([]);
    }
  }, [selectedTrendId]);

  useEffect(() => {
    if (!selectedSnapshotId) {
      setSnapshotDimensions([]);
      setSnapshotEvents([]);
      return;
    }
    (async () => {
      const [dimensions, events] = await Promise.all([
        getTrendInsightDimensions(selectedSnapshotId),
        getTrendKeyEvents(selectedSnapshotId),
      ]);
      setSnapshotDimensions(dimensions);
      setSnapshotEvents(events);
    })();
  }, [selectedSnapshotId]);

  const openSkillDetails = async (skill = getActiveSkill()) => {
    setSkillModalOpen(true);
    setSkillContentLoading(true);
    setSkillContent('');
    const fileName = skill.id === 'price-trend' ? 'price-trend-analysis'
      : skill.id === 'supply-demand' ? 'supply-demand-analysis'
      : skill.id === 'competition' ? 'competition-analysis'
      : skill.id;
    try {
      const response = await fetch(`/skills/${fileName}.md`);
      if (!response.ok) throw new Error('Skill 文件未找到');
      setSkillContent(await response.text());
    } catch (error: any) {
      setSkillContent(`## ${skill.name}\n\n${skill.description}\n\n${skill.systemPrompt}`);
      message.warning(`无法读取独立 Skill 文件：${error.message || '未知错误'}`);
    } finally {
      setSkillContentLoading(false);
    }
  };

  const selectedSnapshot = snapshots.find(snapshot => snapshot.id === selectedSnapshotId) || null;

  // 查看快照详情
  const handleViewSnapshotDetail = async (snapshot: any) => {
    setViewingSnapshot(snapshot);
    const [dimensions, events] = await Promise.all([
      getTrendInsightDimensions(snapshot.id),
      getTrendKeyEvents(snapshot.id),
    ]);
    setSnapshotDimensions(dimensions);
    setSnapshotEvents(events);
    setSnapshotDetailModalOpen(true);
  };

  // 删除选中的快照
  const handleDeleteSelectedSnapshots = async () => {
    if (selectedSnapshotIds.length === 0) return;
    try {
      const d = await import('../db').then(m => m.getDb());
      for (const id of selectedSnapshotIds) {
        await (await d).execute('DELETE FROM trend_snapshots WHERE id = ?', [id]);
      }
      message.success(`已删除 ${selectedSnapshotIds.length} 个快照`);
      setSelectedSnapshotIds([]);
      if (selectedTrendId) {
        const snaps = await getTrendSnapshots(selectedTrendId);
        setSnapshots(snaps);
        setSelectedSnapshotId(snaps.length ? snaps[snaps.length - 1].id : null);
      }
    } catch (e) {
      console.error(e);
      message.error('删除失败');
    }
  };

  // 开启趋势关注（批量）
  const handleEnableTrend = () => {
    const selected = parts.filter((p: any) => !p.trend_enabled);
    setEnableBatch(selected);
    setEnableCategoryType('直接查询');
    setEnableQueryCategory('');
    setEnableMaterialCategory('');
    setEnableModalOpen(true);
  };

  const confirmEnableTrend = async (partIds: number[]) => {
    const d = await import('../db').then(m => m.getDb());
    const queryCat = enableCategoryType === '原材料映射' ? enableMaterialCategory : enableQueryCategory;
    for (const partId of partIds) {
      await (await d).execute(
        'UPDATE parts SET trend_enabled=1, trend_query_category=?, trend_category_type=? WHERE id=?',
        [queryCat, enableCategoryType, partId]
      );
    }
    message.success(`已为 ${partIds.length} 个器件开启趋势关注`);
    setEnableModalOpen(false);
    loadData();
  };

  // 关闭趋势关注
  const handleDisableTrend = async (partId: number) => {
    const d = await import('../db').then(m => m.getDb());
    await (await d).execute('UPDATE parts SET trend_enabled=0 WHERE id=?', [partId]);
    message.success('已关闭趋势关注');
    loadData();
  };

  // 快速添加物料洞察（无需器件库）
  const handleQuickInsight = async () => {
    if (!quickInsightName.trim() || !quickInsightCategory.trim()) {
      message.warning('请输入物料名称和查询类别');
      return;
    }
    try {
      // 创建趋势条目
      const trendItemId = await saveTrendItem({
        query_category: quickInsightCategory,
        category_type: '直接查询',
        trend_direction: null,
        confidence_level: null,
        last_updated_at: null,
      });

      // 立即执行洞察
      message.info(`正在为"${quickInsightName}"生成洞察...`);
      await runTrendQuery(trendItemId);

      setQuickInsightModalOpen(false);
      setQuickInsightName('');
      setQuickInsightCategory('');
      setSelectedTrendId(trendItemId);
      loadData();
    } catch (e) {
      console.error(e);
      message.error('添加失败');
    }
  };

  // 趋势查询（Agent 模式：LLM 自主多轮搜索；降级：单次搜索+分析；最差：演示数据）
  const runTrendQuery = async (trendItemId: number) => {
    setQueryLoading(true);
    try {
      const item = await getTrendItem(trendItemId);
      if (!item) { message.error('趋势条目不存在'); return; }

      const hasLLM = await hasLLMConfig();
      const hasSearch = await hasSearchConfig();
      let direction: string, confidence: string, summary: string, action: string;
      let sources: { title: string; url: string; snippet: string }[] = [];
      let agentRounds = 0;
      const skill = getActiveSkill();
      let structuredResult: any = null;

      if (hasLLM) {
        // Agent 模式：LLM 自主分析（有搜索 API 则联网多轮搜索，否则基于知识库）
        const mode = hasSearch ? 'Agent 联网搜索' : 'LLM 知识库分析';
        message.loading({ content: `正在使用「${skill.name}」Skill 进行 ${mode}...`, key: 'agent', duration: 0 });

        const result = await agentSearchLoop(
          item.query_category,
          item.category_type,
          undefined,
          (progress) => { message.loading({ content: progress, key: 'agent', duration: 0 }); }
        );

        message.destroy('agent');
        direction = result.trend_direction;
        confidence = result.confidence_level;
        summary = result.summary;
        action = result.suggested_action;
        sources = result.allSources.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
        agentRounds = result.searchRounds;
        message.loading({ content: `正在按「${skill.name}」整理可审计结论...`, key: 'agent', duration: 0 });
        structuredResult = await createStructuredInsight(item.query_category, skill, result.allSources, result.summary);
        direction = structuredResult.trend_direction;
        confidence = structuredResult.confidence_level;
        summary = structuredResult.summary;
        action = structuredResult.suggested_action;
        // 保存趋势快照
        const snapshotId = await saveTrendSnapshot({
          trend_item_id: trendItemId,
          direction,
          confidence_level: confidence,
          magnitude_min: structuredResult.magnitude_min,
          magnitude_max: structuredResult.magnitude_max,
          magnitude_reference: structuredResult.magnitude_reference,
          summary,
          suggested_action: action,
          raw_search_results: JSON.stringify(sources),
          skill_used: skill.id,
        });
        await saveTrendInsightDimensions(snapshotId!, structuredResult.dimensions || []);
        for (const event of structuredResult.key_events || []) {
          if (event.event_description) await saveTrendKeyEvent({ ...event, trend_snapshot_id: snapshotId! });
        }
      } else {
        // 模拟数据（API 未配置时的演示数据）
        const mockTrends: Record<string, any> = {
          '上涨': { direction: '上涨', confidence: '高', summary: '近期市场供需偏紧，上游原材料价格持续走高，多家供应商已发出涨价通知。预计未来1-2个月仍有上行空间。', action: '备料/锁价' },
          '下降': { direction: '下降', confidence: '中', summary: '产能充足，市场竞争激烈，价格呈下行趋势。下游需求疲软导致供应商降价促销。', action: '观望' },
          '震荡': { direction: '震荡', confidence: '中', summary: '价格在一定区间内波动，短期无明显方向。供需基本平衡，季节性因素影响有限。', action: '维持常规节奏' },
          '信号不明确': { direction: '信号不明确', confidence: '低', summary: '公开信息较少，未能获取足够的市场信号。建议关注行业报告或等待更多数据。', action: '观望' },
        };
        const directions = Object.keys(mockTrends);
        const mockResult = mockTrends[directions[Math.floor(Math.random() * directions.length)]];
        direction = mockResult.direction;
        confidence = mockResult.confidence;
        summary = mockResult.summary;
        action = mockResult.action;
        sources = [
          { title: '行业价格监测报告', url: 'https://example.com/report1', snippet: '近期价格波动明显，供应商报价上调约5-8%。' },
          { title: '市场分析周报', url: 'https://example.com/report2', snippet: '下游需求持续增长，上游产能扩张速度不及预期。' },
        ];
      }

      if (!hasLLM) {
        const demoDimensions = (skill.outputDimensions || []).map((dimension_type, dimension_order) => ({
          dimension_type,
          dimension_order,
          content: '演示模式：尚未配置大模型服务，无法基于公开资料生成该维度的可靠结论。请配置服务后重新查询。',
          evidence_strength: '未验证',
        }));
        const snapshotId = await saveTrendSnapshot({
          trend_item_id: trendItemId,
          direction,
          confidence_level: confidence,
          summary,
          suggested_action: action,
          raw_search_results: JSON.stringify(sources),
          skill_used: skill.id,
        });
        await saveTrendInsightDimensions(snapshotId!, demoDimensions);
      }

      const now = new Date().toISOString().split('T')[0];

      // 更新趋势条目
      await saveTrendItem({
        ...item,
        trend_direction: direction,
        confidence_level: confidence,
        summary,
        suggested_action: action,
        raw_search_results: JSON.stringify(sources),
        last_updated_at: now,
      });

      // 更新来源
      await clearTrendSources(trendItemId);
      for (const s of sources) {
        await saveTrendSource({
          trend_item_id: trendItemId,
          source_title: s.title,
          source_url: s.url,
          excerpt: s.snippet,
        });
      }

      const agentTag = agentRounds > 0 ? `（Agent ${agentRounds}轮搜索）` : '';
      message.success(`趋势查询完成：${direction}${agentTag}${!hasLLM ? '（演示数据）' : ''}`);
      loadData();
      if (selectedTrendId === trendItemId) {
        setSelectedTrendId(null);
        setTimeout(() => setSelectedTrendId(trendItemId), 100);
      }
    } catch (e: any) {
      console.error(e);
      message.error(`趋势查询失败：${e.message || '未知错误'}`);
    }
    setQueryLoading(false);
  };

  // 追问（真正的多轮对话，携带完整上下文）
  const handleAskQuestion = async () => {
    if (!askQuestion.trim() || !selectedTrendId || convLoading) return;
    const questionText = askQuestion.trim();
    setAskQuestion('');
    setConvLoading(true);
    try {
      const hasLLM = await hasLLMConfig();
      let answer: string;

      if (hasLLM) {
        const convHistory = await getTrendConversations(selectedTrendId);
        answer = await multiTurnAsk(
          selectedTrend?.raw_search_results || '',
          selectedTrend?.last_updated_at || '',
          convHistory,
          questionText
        );
      } else {
        answer = '未配置 LLM API Key，无法进行追问。请在设置页面配置 DeepSeek 或 OpenAI API。';
      }

      await saveTrendConversation({ trend_item_id: selectedTrendId, question: questionText, answer });
      const convs = await getTrendConversations(selectedTrendId);
      setConversations(convs);
    } catch (e: any) {
      message.error(`追问失败：${e.message || '未知错误'}`);
      setAskQuestion(questionText);
    }
    setConvLoading(false);
  };

  // 补充搜索：针对当前追问话题重新搜索（有搜索 API 则实时搜索，否则 LLM 知识库）
  const handleSupplementarySearch = async () => {
    if (!askQuestion.trim() || !selectedTrendId) return;
    const questionText = askQuestion.trim();
    setAskQuestion('');
    setQueryLoading(true);
    try {
      const { searchResults, analysis } = await supplementarySearch(
        selectedTrend?.query_category || '',
        selectedTrend?.category_type || '直接查询',
        questionText
      );

      if (searchResults.length === 0) {
        await saveTrendConversation({
          trend_item_id: selectedTrendId,
          question: `🔍 补充搜索：${questionText}`,
          answer: '未找到相关最新信息，建议调整查询关键词或稍后重试。',
        });
      } else {
        // 2. 保存补充搜索的来源
        for (const s of searchResults) {
          await saveTrendSource({
            trend_item_id: selectedTrendId,
            source_title: `[补充搜索] ${s.title}`,
            source_url: s.url,
            excerpt: s.snippet,
          });
        }
        // 3. 保存回答
        await saveTrendConversation({
          trend_item_id: selectedTrendId,
          question: `🔍 补充搜索：${questionText}`,
          answer: analysis,
        });
      }

      const convs = await getTrendConversations(selectedTrendId);
      setConversations(convs);
      message.success('补充搜索完成');
    } catch (e: any) {
      message.error(`补充搜索失败：${e.message || '未知错误'}`);
      setAskQuestion(questionText);
    }
    setQueryLoading(false);
  };

  // 删除趋势条目
  const handleDeleteTrendItem = async (id: number) => {
    await deleteTrendItem(id);
    if (selectedTrendId === id) setSelectedTrendId(null);
    message.success('已删除趋势条目');
    loadData();
  };

  // 原材料类别管理
  const handleAddMaterial = async () => {
    if (!newMaterialName.trim()) return;
    await addMaterialCategory(newMaterialName.trim());
    setNewMaterialName('');
    message.success('已添加原材料类别');
    const mats = await getMaterialCategories();
    setMaterialCategories(mats);
  };

  const handleDeleteMaterial = async (categoryName: string) => {
    await removeMaterialCategory(categoryName);
    message.success('已删除');
    const mats = await getMaterialCategories();
    setMaterialCategories(mats);
  };

  // 批量趋势查询
  const runBatchQuery = async () => {
    const selected = batchQueryItems.filter((item: any) => item._checked);
    if (selected.length === 0) { message.warning('请选择要更新的条目'); return; }
    setBatchQueryOpen(false);
    setQueryLoading(true);
    let completed = 0;
    for (const item of selected) {
      setBatchQueryProgress(`正在查询：${item.query_category} (${completed + 1}/${selected.length})...`);
      try {
        await runTrendQuery(item.id);
        completed++;
      } catch (e) {
        completed++;
      }
      // 避免请求过快
      if (completed < selected.length) await new Promise(r => setTimeout(r, 1500));
    }
    setBatchQueryProgress('');
    setQueryLoading(false);
    message.success(`批量查询完成：${completed}/${selected.length} 条`);
    loadData();
  };

  // ====== 分组趋势条目（按类别合并） ======
  const groupedTrendItems = () => {
    const groups: Record<string, any[]> = {};
    for (const item of trendItems) {
      const key = item.query_category || '未分类';
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return groups;
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;

  return (
    <div style={{ display: 'flex', gap: 20, height: 'calc(100vh - 60px)' }}>
      {/* ====== 左侧：趋势关注列表 ====== */}
      <div style={{ flex: '0 0 420px', display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
        <div className="page-title" style={{ marginBottom: 0 }}>
          <span className="emoji">📡</span> 物料趋势洞察
        </div>

        {/* 已关注的趋势条目 */}
        <div className="content-card" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <Tabs
            activeKey={leftTab}
            onChange={setLeftTab}
            size="small"
            tabBarExtraContent={
              <Space size={6}>
                <Button size="small" type="primary" onClick={() => setQuickInsightModalOpen(true)}>+ 洞察</Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={loadData} />
              </Space>
            }
            items={[
              {
                key: 'trends',
                label: '趋势关注',
                children: (
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {trendItems.length === 0 ? (
                      <Empty description="暂无趋势关注条目" image={Empty.PRESENTED_IMAGE_SIMPLE}>
                        <Button type="primary" onClick={handleEnableTrend}>从器件库开启趋势关注</Button>
                      </Empty>
                    ) : (
                      <>
                        {Object.entries(groupedTrendItems()).map(([category, items]) => (
                          <div key={category} style={{ marginBottom: 12 }}>
                            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)', fontSize: 12 }}>
                              {items[0]?.category_type === '原材料映射' ? '🏗️' : '🔧'} {category}
                            </div>
                            {items.map((item: any) => {
                              const d = TREND_DIRECTIONS[item.trend_direction];
                              const isStale = !item.last_updated_at || (new Date().getTime() - new Date(item.last_updated_at).getTime()) > 45 * 86400000;
                              const age = item.last_updated_at ? Math.floor((Date.now() - new Date(item.last_updated_at).getTime()) / 86400000) : 999;
                              return (
                                <div
                                  key={item.id}
                                  className={`nav-item ${selectedTrendId === item.id ? 'active' : ''}`}
                                  style={{ padding: '8px 12px', marginBottom: 3, cursor: 'pointer', borderRadius: 8 }}
                                  onClick={() => { setSelectedTrendId(item.id); }}
                                >
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span style={{ fontSize: 16, opacity: Math.max(0.2, 1 - age * 0.02) }}>{d?.icon || '？'}</span>
                                      <div>
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>{item.query_category}</div>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                          {item.mapped_parts?.length || 0} 器件
                                          {isStale && item.last_updated_at && <Tag color="orange" style={{ marginLeft: 4, fontSize: 9 }}>建议更新</Tag>}
                                        </div>
                                      </div>
                                    </div>
                                    {item.trend_direction && <Tag color={d?.color} style={{ margin: 0, fontSize: 10 }}>{d?.label}</Tag>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                        {trendItems.length > 0 && (
                          <Button block size="small" style={{ marginTop: 8 }} onClick={() => {
                            setBatchQueryItems(trendItems.map((item: any) => ({ ...item, _checked: false })));
                            setBatchQueryOpen(true);
                          }}>批量更新全部</Button>
                        )}
                      </>
                    )}
                  </div>
                ),
              },
              {
                key: 'watchlist',
                label: '关注清单',
                children: (
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {trendItems.length === 0 ? (
                      <Empty description="暂无关注条目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    ) : (
                      <div>
                        {trendItems
                          .filter((item: any) => item.trend_direction)
                          .sort((a: any, b: any) => {
                            const order: Record<string, number> = { '上涨': 0, '下降': 1, '震荡': 2, '信号不明确': 3 };
                            return (order[a.trend_direction] ?? 4) - (order[b.trend_direction] ?? 4);
                          })
                          .map((item: any) => {
                            const d = TREND_DIRECTIONS[item.trend_direction];
                            return (
                              <Card
                                key={item.id}
                                size="small"
                                hoverable
                                style={{ marginBottom: 8, cursor: 'pointer', borderLeft: `3px solid ${d?.color || '#94A3B8'}` }}
                                onClick={() => { setSelectedTrendId(item.id); setLeftTab('trends'); }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                                      {d?.icon} {item.query_category}
                                      <Tag color={d?.color} style={{ marginLeft: 8, fontSize: 10 }}>{d?.label}</Tag>
                                      {item.confidence_level && <Tag style={{ fontSize: 10 }}>{item.confidence_level}置信</Tag>}
                                    </div>
                                    {item.summary && (
                                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5, maxHeight: 40, overflow: 'hidden' }}>
                                        {item.summary.slice(0, 150)}
                                      </div>
                                    )}
                                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                                      {item.last_updated_at || '未查询'} · {item.mapped_parts?.length || 0} 器件
                                    </div>
                                  </div>
                                </div>
                              </Card>
                            );
                          })}
                        <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
                          按趋势方向排序 · 点击卡片查看详情
                        </div>
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'parts',
                label: `关注器件(${trendEnabledParts.length})`,
                children: (
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {trendEnabledParts.length === 0 ? (
                      <Empty description="暂无已关注器件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    ) : (
                      trendEnabledParts.map((p: any) => (
                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12, borderBottom: '1px solid var(--card-border)' }}>
                          <div style={{ flex: 1 }}>
                            <div>
                              {p.trend_category_type === '原材料映射' ? (
                                <>
                                  <span style={{ fontWeight: 500 }}>{p.trend_query_category}</span>
                                  <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>
                                    (映射自: {p.name})
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span>{p.name}</span>
                                  <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{p.model}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <Space size={4}>
                            <Tag style={{ fontSize: 10 }}>{p.trend_category_type}</Tag>
                            {p.trend_category_type !== '原材料映射' && (
                              <Tag color="blue" style={{ fontSize: 10 }}>{p.trend_query_category}</Tag>
                            )}
                            <Popconfirm title="关闭？" onConfirm={() => handleDisableTrend(p.id)}>
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          </Space>
                        </div>
                      ))
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>

        <Button type="dashed" block icon={<SettingOutlined />} onClick={handleEnableTrend}>
          管理趋势关注器件
        </Button>
      </div>

      {/* ====== 右侧：详情面板 ====== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {!selectedTrend ? (
          <div className="content-card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: 16 }}>
            <Empty description="选择左侧趋势条目查看详情">
              <Button onClick={handleEnableTrend}>从器件库开启趋势关注</Button>
            </Empty>
          </div>
        ) : (
          <>
            {/* 可滚动的上半部分：详情 + 来源 */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="content-card" style={{ flexShrink: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <h3 style={{ margin: 0 }}>
                    {TREND_DIRECTIONS[selectedTrend.trend_direction]?.icon || '📊'} {selectedTrend.query_category}
                  </h3>
                  <Tag color="purple" style={{ marginTop: 4, fontSize: 11 }}>
                    {(() => { const s = getActiveSkill(); return `${s.icon} 分析框架：${s.name}`; })()}
                  </Tag>
                  <Button size="small" type="link" icon={<BookOutlined />} onClick={() => openSkillDetails()} style={{ paddingLeft: 6 }}>
                    查看 Skill 方法论
                  </Button>
                </div>
                <Space>
                  <Button
                    type="primary"
                    icon={<SearchOutlined />}
                    onClick={() => runTrendQuery(selectedTrend.id!)}
                    loading={queryLoading}
                  >
                    Agent 搜索
                  </Button>
                  <Popconfirm title="确定删除此趋势条目？" onConfirm={() => handleDeleteTrendItem(selectedTrend.id!)}>
                    <Button danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </Space>
              </div>

              <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
                <Descriptions.Item label="查询类别">{selectedTrend.query_category}</Descriptions.Item>
                <Descriptions.Item label="类别类型">
                  <Tag>{selectedTrend.category_type === '原材料映射' ? '🏗️ 原材料映射' : '🔧 直接查询'}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="趋势方向">
                  {selectedTrend.trend_direction ? (
                    <Tag color={TREND_DIRECTIONS[selectedTrend.trend_direction]?.color} style={{ fontSize: 14 }}>
                      {TREND_DIRECTIONS[selectedTrend.trend_direction]?.icon} {selectedTrend.trend_direction}
                    </Tag>
                  ) : <span style={{ color: 'var(--text-muted)' }}>未查询</span>}
                </Descriptions.Item>
                <Descriptions.Item label="置信度">
                  {selectedTrend.confidence_level ? (
                    <Tag color={CONFIDENCE_COLORS[selectedTrend.confidence_level]}>{selectedTrend.confidence_level}</Tag>
                  ) : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="建议动作">
                  {selectedTrend.suggested_action ? (
                    <Tag color={SUGGESTED_ACTION_COLORS[selectedTrend.suggested_action] || 'default'}>
                      {selectedTrend.suggested_action}
                    </Tag>
                  ) : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="最近更新">
                  {selectedTrend.last_updated_at || '未查询'}
                  {selectedTrend.last_updated_at && new Date().getTime() - new Date(selectedTrend.last_updated_at).getTime() > 45 * 86400000 && (
                    <Tag color="orange" style={{ marginLeft: 8 }}>建议更新</Tag>
                  )}
                </Descriptions.Item>
              </Descriptions>

              {snapshots.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ fontWeight: 650, fontSize: 16 }}><ClockCircleOutlined /> 历史洞察快照</div>
                    <Space>
                      {selectedSnapshotIds.length > 0 && (
                        <Popconfirm
                          title={`确定删除选中的 ${selectedSnapshotIds.length} 个快照？`}
                          onConfirm={handleDeleteSelectedSnapshots}
                        >
                          <Button size="small" danger icon={<DeleteOutlined />}>
                            删除选中 ({selectedSnapshotIds.length})
                          </Button>
                        </Popconfirm>
                      )}
                      <Checkbox
                        indeterminate={selectedSnapshotIds.length > 0 && selectedSnapshotIds.length < snapshots.length}
                        checked={selectedSnapshotIds.length === snapshots.length}
                        onChange={(e) => setSelectedSnapshotIds(e.target.checked ? snapshots.map(s => s.id) : [])}
                      >
                        全选
                      </Checkbox>
                    </Space>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[...snapshots].reverse().map((snapshot) => (
                      <Card
                        key={snapshot.id}
                        size="small"
                        style={{
                          borderLeft: `3px solid ${snapshot.id === selectedSnapshotId ? '#1890ff' : '#d9d9d9'}`,
                          cursor: 'pointer',
                          transition: 'all 0.3s',
                        }}
                        hoverable
                        onClick={() => {
                          setSelectedSnapshotId(snapshot.id);
                          handleViewSnapshotDetail(snapshot);
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <Checkbox
                              checked={selectedSnapshotIds.includes(snapshot.id)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                e.stopPropagation();
                                setSelectedSnapshotIds(prev =>
                                  e.target.checked ? [...prev, snapshot.id] : prev.filter(id => id !== snapshot.id)
                                );
                              }}
                            />
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <CalendarOutlined style={{ color: '#8c8c8c' }} />
                                <span style={{ fontWeight: 600, fontSize: 14 }}>
                                  {snapshot.query_time?.slice(0, 16) || '未知时间'}
                                </span>
                                <Tag color={snapshot.direction === '上涨' ? 'red' : snapshot.direction === '下降' ? 'green' : 'default'}>
                                  {snapshot.direction || '未判断'}
                                </Tag>
                                {snapshot.skill_used && (
                                  <Tag color="purple">
                                    {BUILTIN_SKILLS.find(skill => skill.id === snapshot.skill_used)?.name || snapshot.skill_used}
                                  </Tag>
                                )}
                              </div>
                              <div style={{ fontSize: 13, color: '#666', lineHeight: 1.5 }}>
                                {snapshot.summary?.slice(0, 80) || '暂无结论'}
                                {snapshot.summary && snapshot.summary.length > 80 && '...'}
                              </div>
                            </div>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {selectedSnapshot && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <h4 style={{ margin: 0 }}>🧭 方法论洞察结论</h4>
                    <Tag color="purple">
                      分析框架：{BUILTIN_SKILLS.find(skill => skill.id === selectedSnapshot.skill_used)?.name || selectedSnapshot.skill_used || '历史未标注'}
                    </Tag>
                    {selectedSnapshot.source_type === 'aggregated' && <Tag color="blue">层级汇总</Tag>}
                  </div>
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--main-bg)', lineHeight: 1.75, marginBottom: 12 }}>
                    <strong>采购结论：</strong>{selectedSnapshot.summary || '暂无结论'}
                  </div>

                  {snapshotDimensions.length > 0 ? (
                    <div style={{ display: 'grid', gap: 10 }}>
                      {snapshotDimensions.map((dimension: any, index: number) => {
                        const evidenceColor: Record<string, string> = { '强': 'green', '中': 'gold', '弱': 'orange', '未验证': 'default' };
                        return (
                          <Card key={dimension.id || dimension.dimension_type} size="small" style={{ borderLeft: `3px solid ${index % 2 ? 'var(--brand-secondary, #8B5CF6)' : 'var(--brand, #6366F1)'}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                              <strong style={{ fontSize: 15 }}>{dimension.dimension_type}</strong>
                              <Tag color={evidenceColor[dimension.evidence_strength] || 'default'}>{dimension.evidence_strength || '未验证'}证据</Tag>
                            </div>
                            <div style={{ lineHeight: 1.75 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{dimension.content}</ReactMarkdown></div>
                            {(dimension.source_url || dimension.source_title) && (
                              <a
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  openExternal(dimension.source_url);
                                }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, marginTop: 6, cursor: 'pointer' }}
                              >
                                <LinkOutlined /> {dimension.source_title || '打开来源'}
                              </a>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
                      该历史快照创建于结构化洞察功能启用前，仅保留原始摘要。
                    </div>
                  )}

                  {snapshotEvents.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <h4 style={{ marginBottom: 8 }}>⏱️ 关键事件</h4>
                      {snapshotEvents.map((event: any) => (
                        <div key={event.id} style={{ padding: '8px 10px', borderLeft: '2px solid var(--brand, #6366F1)', background: 'var(--main-bg)', marginBottom: 6, borderRadius: '0 6px 6px 0' }}>
                          <Space size={6} wrap>
                            {event.event_date && <Tag>{event.event_date}</Tag>}
                            {event.impact_direction && <Tag color={event.impact_direction === '利多上涨' ? 'red' : event.impact_direction === '利多下跌' ? 'green' : 'default'}>{event.impact_direction}</Tag>}
                            <span>{event.event_description}</span>
                          </Space>
                          {(event.source_url || event.source_title) && <div><a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              openExternal(event.source_url);
                            }}
                            style={{ fontSize: 12, cursor: 'pointer' }}
                          ><LinkOutlined /> {event.source_title || '打开事件来源'}</a></div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {selectedTrend.summary && !selectedSnapshot && (
                <div style={{ marginBottom: 16 }}>
                  <h4>判断依据</h4>
                  <div style={{ background: 'var(--main-bg)', padding: 12, borderRadius: 8, fontSize: 14, lineHeight: 1.8 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedTrend.summary}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* 信息来源 */}
              {trendSources.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <h4>信息来源</h4>
                  {trendSources.map((s: any, i: number) => (
                    <div key={s.id || i} style={{ padding: '8px 12px', background: 'var(--main-bg)', borderRadius: 8, marginBottom: 8 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{s.source_title}</div>
                      {s.source_url && <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          openExternal(s.source_url);
                        }}
                        style={{ fontSize: 12, cursor: 'pointer' }}
                      >{s.source_url}</a>}
                      {s.excerpt && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{s.excerpt}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* 关联器件 */}
              {selectedTrend.mapped_parts?.length > 0 && (
                <div>
                  <h4>关联器件 ({selectedTrend.mapped_parts.length})</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {selectedTrend.mapped_parts.map((p: any) => (
                      <Tag key={p.id} color={getCategoryColor(p.main_category)}>
                        {p.name} {p.model ? `(${p.model})` : ''}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {/* 趋势历史图表 */}
            {snapshots.length >= 2 && (
              <div className="content-card" style={{ flexShrink: 0 }}>
                <h4>📈 趋势历史</h4>
                <ReactECharts
                  style={{ height: 200 }}
                  option={{
                    tooltip: { trigger: 'axis', formatter: (params: any) => {
                      const p = params[0];
                      const snap = snapshots[p.dataIndex];
                      let tip = `<b>${p.axisValue}</b><br/>趋势：${snap?.direction || '-'}`;
                      if (snap?.magnitude_min != null) tip += `<br/>幅度：${snap.magnitude_min}%~${snap.magnitude_max}%`;
                      if (snap?.magnitude_reference) tip += `<br/>基准：${snap.magnitude_reference}`;
                      if (snap?.confidence_level) tip += `<br/>置信度：${snap.confidence_level}`;
                      return tip;
                    }},
                    grid: { top: 10, right: 20, bottom: 20, left: 50 },
                    xAxis: { type: 'category', data: snapshots.map((s: any) => s.query_time?.slice(0, 10) || ''), axisLabel: { fontSize: 10, rotate: 30 } },
                    yAxis: [
                      { type: 'value', name: '幅度(%)', axisLabel: { fontSize: 10 } },
                    ],
                    series: [
                      {
                        name: '涨跌幅区间',
                        type: 'bar',
                        data: snapshots.map((s: any) => {
                          if (s.magnitude_min != null && s.magnitude_max != null) {
                            return [s.magnitude_min, s.magnitude_max];
                          }
                          return null;
                        }),
                        itemStyle: {
                          color: (params: any) => {
                            if (!params.data) return '#94A3B8';
                            const [min, max] = params.data;
                            if (min >= 0) return '#EF4444';
                            if (max <= 0) return '#10B981';
                            return '#F59E0B';
                          },
                          borderRadius: 4,
                        },
                        barWidth: 20,
                      },
                      {
                        name: '仅有方向',
                        type: 'scatter',
                        data: snapshots.map((s: any, _i: number) => {
                          if (s.magnitude_min == null && s.direction) {
                            const icons: Record<string, number> = { '上涨': 1, '下降': -1, '震荡': 0, '信号不明确': 0 };
                            return { value: icons[s.direction] || 0, symbolSize: 14, itemStyle: { color: s.direction === '上涨' ? '#EF4444' : s.direction === '下降' ? '#10B981' : '#94A3B8' } };
                          }
                          return null;
                        }).filter(Boolean),
                        symbol: (val: any) => val === 1 ? 'triangle' : val === -1 ? 'arrow' : 'diamond',
                        symbolSize: 20,
                      },
                    ],
                  }}
                  opts={{ renderer: 'canvas' }}
                />
              </div>
            )}
            </div>{/* 可滚动上半部分结束 */}

            {/* 追问区域 - 固定在底部 */}
            <div className="content-card" style={{ flexShrink: 0, maxHeight: '42vh', display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--card-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0 }}>💬 多轮追问与讨论</h4>
                {selectedTrend?.last_updated_at && (
                  <Tag color={new Date().getTime() - new Date(selectedTrend.last_updated_at).getTime() > 30 * 86400000 ? 'orange' : 'green'} style={{ fontSize: 11 }}>
                    📅 搜索时间：{selectedTrend.last_updated_at}
                    {new Date().getTime() - new Date(selectedTrend.last_updated_at).getTime() > 30 * 86400000 ? '（可能已过时）' : ''}
                  </Tag>
                )}
              </div>

              {/* 安全提示 */}
              <div style={{
                background: '#FFF7ED',
                padding: '8px 12px',
                borderRadius: 8,
                marginBottom: 12,
                fontSize: 12,
                color: '#EA580C',
                border: '1px solid #FED7AA',
              }}>
                ⚠️ 请勿输入内部真实价格、供应商名称等敏感信息。对话基于公开搜索结果进行，LLM 会如实标注信息时效性和来源可信度。
              </div>

              {/* 对话历史 */}
              {conversations.length === 0 ? (
                <Empty description="输入问题开始多轮讨论，每次对话都会携带完整上下文" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginBottom: 8, padding: '0 4px' }}>
                  {conversations.map((c: any, idx: number) => (
                    <div key={c.id || idx} style={{ marginBottom: 14 }}>
                      {/* 用户问题 */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                        <div style={{
                          background: 'var(--brand-gradient)',
                          color: '#fff', padding: '10px 16px',
                          borderRadius: '18px 18px 6px 18px',
                          maxWidth: '82%', fontSize: 13, lineHeight: 1.6,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                        }}>
                          {c.question}
                        </div>
                      </div>
                      {/* AI 回答 */}
                      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                        <div style={{
                          background: 'var(--card-bg)',
                          border: '1px solid var(--card-border)',
                          padding: '10px 16px',
                          borderRadius: '18px 18px 18px 6px',
                          maxWidth: '85%', fontSize: 13, lineHeight: 1.7,
                        }}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.answer}</ReactMarkdown>
                        </div>
                      </div>
                      {/* 时间戳 */}
                      {c.created_at && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>
                          {c.created_at}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 输入框 + 操作按钮 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <AntInput
                  placeholder="输入追问，LLM 会结合之前全部对话上下文回复..."
                  value={askQuestion}
                  onChange={e => setAskQuestion(e.target.value)}
                  onPressEnter={handleAskQuestion}
                  style={{ flex: 1, borderRadius: 20 }}
                  prefix={<QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />}
                  disabled={convLoading}
                />
                <Tooltip title="多轮追问（基于已有上下文）">
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={handleAskQuestion}
                    disabled={!askQuestion.trim() || convLoading}
                    shape="circle"
                    loading={convLoading}
                  />
                </Tooltip>
                <Tooltip title="补充搜索：针对当前问题重新搜索最新信息">
                  <Button
                    icon={<SearchOutlined />}
                    onClick={handleSupplementarySearch}
                    disabled={!askQuestion.trim() || convLoading || queryLoading}
                    shape="circle"
                  />
                </Tooltip>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
                按 Enter 发送追问 · 点击 🔍 触发补充搜索获取最新数据 · 对话支持无限轮次
              </div>
            </div>
          </>
        )}
      </div>

      {/* ====== Skill 方法论详情 ====== */}
      <Modal
        title={<Space><BookOutlined /> Skill 方法论说明</Space>}
        open={skillModalOpen}
        onCancel={() => setSkillModalOpen(false)}
        footer={<Button onClick={() => setSkillModalOpen(false)}>关闭</Button>}
        width={760}
      >
        {skillContentLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : (
          <div style={{ maxHeight: '62vh', overflow: 'auto', paddingRight: 8, lineHeight: 1.8 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{skillContent}</ReactMarkdown>
          </div>
        )}
      </Modal>

      {/* ====== 开启趋势关注弹窗 ====== */}
      <Modal
        title="管理趋势关注器件"
        open={enableModalOpen}
        onCancel={() => setEnableModalOpen(false)}
        onOk={() => {
          const selectedIds = enableBatch.filter((p: any) => p._selected).map((p: any) => p.id);
          if (selectedIds.length === 0) { message.warning('请选择器件'); return; }
          confirmEnableTrend(selectedIds);
        }}
        width={700}
        okText="确认开启"
      >
        <div style={{ marginBottom: 16 }}>
          <Space>
            <span>查询类型：</span>
            <Select value={enableCategoryType} onChange={setEnableCategoryType} style={{ width: 140 }}>
              <Select.Option value="直接查询">🔧 直接查询</Select.Option>
              <Select.Option value="原材料映射">🏗️ 原材料映射</Select.Option>
            </Select>
            {enableCategoryType === '直接查询' ? (
              <Input
                placeholder="输入查询类别名称（如：Tcon IC）"
                value={enableQueryCategory}
                onChange={e => setEnableQueryCategory(e.target.value)}
                style={{ width: 280 }}
              />
            ) : (
              <Select
                placeholder="选择原材料类别"
                value={enableMaterialCategory || undefined}
                onChange={setEnableMaterialCategory}
                style={{ width: 280 }}
                dropdownRender={menu => (
                  <>
                    {menu}
                    <div style={{ padding: '4px 8px', borderTop: '1px solid var(--card-border)' }}>
                      <Button type="link" size="small" onClick={() => setMaterialModalOpen(true)}>
                        + 管理原材料类别
                      </Button>
                    </div>
                  </>
                )}
              >
                {materialCategories.map((m: any) => (
                  <Select.Option key={m.id} value={m.category_name}>{m.category_name}</Select.Option>
                ))}
              </Select>
            )}
          </Space>
        </div>
        <Table
          dataSource={enableBatch}
          columns={[
            { title: '选择', dataIndex: '_selected', width: 60, render: (_: any, record: any) => (
              <input type="checkbox" checked={!!record._selected} onChange={e => {
                setEnableBatch(prev => prev.map(p => p.id === record.id ? { ...p, _selected: e.target.checked } : p));
              }} />
            )},
            { title: '器件名称', dataIndex: 'name', width: 160 },
            { title: '型号', dataIndex: 'model', width: 100 },
            { title: '大类', dataIndex: 'main_category', width: 90, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
            { title: '子类', dataIndex: 'sub_category', width: 100 },
            { title: '成本', dataIndex: 'cost', width: 80, render: (v: number) => `¥${v?.toFixed(2)}` },
          ]}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 8 }}
          scroll={{ y: 300 }}
        />
      </Modal>

      {/* ====== 原材料类别管理弹窗 ====== */}
      <Modal
        title="原材料类别管理"
        open={materialModalOpen}
        onCancel={() => setMaterialModalOpen(false)}
        footer={null}
        width={420}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <Input
            placeholder="输入原材料类别名称（如：铝合金、ABS树脂）"
            value={newMaterialName}
            onChange={e => setNewMaterialName(e.target.value)}
            onPressEnter={handleAddMaterial}
            style={{ flex: 1 }}
          />
          <Button type="primary" onClick={handleAddMaterial}>添加</Button>
        </div>
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          {materialCategories.length === 0 ? (
            <Empty description="暂无原材料类别" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            materialCategories.map((m: any) => (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--card-border)' }}>
                <span>🏗️ {m.category_name}</span>
                <Popconfirm title="确定删除？" onConfirm={() => handleDeleteMaterial(m.id)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            ))
          )}
        </div>
      </Modal>

      {/* ====== 批量查询弹窗 ====== */}
      <Modal
        title="批量更新趋势"
        open={batchQueryOpen}
        onCancel={() => setBatchQueryOpen(false)}
        onOk={runBatchQuery}
        width={600}
        okText="开始查询"
        cancelText="取消"
      >
        <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-muted)' }}>
          选择要更新的趋势条目，系统将逐个查询最新的市场行情。已配置 API 时使用真实数据，否则使用演示数据。
        </div>
        {batchQueryProgress && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--brand-light, #EDE9FE)', borderRadius: 8, fontSize: 13 }}>
            {batchQueryProgress}
          </div>
        )}
        <Table
          dataSource={batchQueryItems}
          columns={[
            { title: '选择', dataIndex: '_checked', width: 60, render: (_: any, record: any) => (
              <input type="checkbox" checked={!!record._checked} onChange={e => {
                setBatchQueryItems((prev: any[]) => prev.map(p => p.id === record.id ? { ...p, _checked: e.target.checked } : p));
              }} />
            )},
            { title: '查询类别', dataIndex: 'query_category', width: 160 },
            { title: '类型', dataIndex: 'category_type', width: 110, render: (v: string) => <Tag>{v === '原材料映射' ? '🏗️ 原材料' : '🔧 直接查询'}</Tag> },
            { title: '当前趋势', dataIndex: 'trend_direction', width: 120, render: (v: string) => v ? (
              <Tag color={TREND_DIRECTIONS[v]?.color}>{TREND_DIRECTIONS[v]?.icon} {v}</Tag>
            ) : <Tag>未查询</Tag> },
            { title: '关联器件', dataIndex: 'mapped_parts', width: 80, render: (v: any[]) => v?.length || 0 },
          ]}
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ y: 300 }}
        />
      </Modal>

      {/* ====== 快照详情弹窗 ====== */}
      <Modal
        title={
          <Space>
            <CalendarOutlined />
            快照详情
            {viewingSnapshot && (
              <Tag color={viewingSnapshot.direction === '上涨' ? 'red' : viewingSnapshot.direction === '下降' ? 'green' : 'default'}>
                {viewingSnapshot.direction || '未判断'}
              </Tag>
            )}
          </Space>
        }
        open={snapshotDetailModalOpen}
        onCancel={() => setSnapshotDetailModalOpen(false)}
        width={900}
        footer={null}
      >
        {viewingSnapshot && (
          <div>
            <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="查询时间">{viewingSnapshot.query_time?.slice(0, 16)}</Descriptions.Item>
              <Descriptions.Item label="使用框架">
                {viewingSnapshot.skill_used ? (
                  <Tag color="purple">{BUILTIN_SKILLS.find(skill => skill.id === viewingSnapshot.skill_used)?.name || viewingSnapshot.skill_used}</Tag>
                ) : '历史未标注框架'}
              </Descriptions.Item>
            </Descriptions>

            {viewingSnapshot.summary && (
              <div style={{ marginBottom: 16 }}>
                <h4>结论摘要</h4>
                <div style={{ padding: '12px', background: '#f5f5f5', borderRadius: 8 }}>
                  {viewingSnapshot.summary}
                </div>
              </div>
            )}

            {snapshotDimensions.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <h4>分析维度</h4>
                <div style={{ display: 'grid', gap: 10 }}>
                  {snapshotDimensions.map((dimension: any, index: number) => {
                    const evidenceColor: Record<string, string> = { '强': 'green', '中': 'gold', '弱': 'orange', '未验证': 'default' };
                    return (
                      <Card key={dimension.id || dimension.dimension_type} size="small" style={{ borderLeft: `3px solid ${index % 2 ? '#8B5CF6' : '#6366F1'}` }}>
                        <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                          {dimension.dimension_type}
                          <Tag color={evidenceColor[dimension.evidence_strength || '未验证']}>{dimension.evidence_strength || '未验证'}</Tag>
                        </div>
                        <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>{dimension.observation}</div>
                        {dimension.data_points && (
                          <div style={{ fontSize: 12, color: '#999', background: '#fafafa', padding: 6, borderRadius: 4 }}>
                            {dimension.data_points}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {snapshotEvents.length > 0 && (
              <div>
                <h4>关键事件</h4>
                <div style={{ display: 'grid', gap: 8 }}>
                  {snapshotEvents.map((event: any) => (
                    <Card key={event.id} size="small" style={{ borderLeft: '3px solid #faad14' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{event.event_time}</div>
                          <div style={{ fontSize: 13 }}>{event.event_description}</div>
                        </div>
                        {event.impact_level && (
                          <Tag color={event.impact_level === '高' ? 'red' : event.impact_level === '中' ? 'orange' : 'default'}>
                            {event.impact_level}
                          </Tag>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ====== 快速洞察弹窗 ====== */}
      <Modal
        title="快速物料洞察"
        open={quickInsightModalOpen}
        onOk={handleQuickInsight}
        onCancel={() => {
          setQuickInsightModalOpen(false);
          setQuickInsightName('');
          setQuickInsightCategory('');
        }}
        okText="立即洞察"
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>物料名称</div>
          <Input
            placeholder="例如：LCD显示屏、MCU芯片"
            value={quickInsightName}
            onChange={(e) => setQuickInsightName(e.target.value)}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>查询类别</div>
          <Input
            placeholder="例如：LCD面板、微控制器"
            value={quickInsightCategory}
            onChange={(e) => setQuickInsightCategory(e.target.value)}
          />
          <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
            提示：查询类别决定了搜索范围，建议使用通用的物料分类名称
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 8 }}>洞察框架</div>
          <Select
            style={{ width: '100%' }}
            value={quickInsightSkill}
            onChange={setQuickInsightSkill}
            options={BUILTIN_SKILLS.map(skill => ({
              value: skill.id,
              label: skill.name,
            }))}
          />
        </div>
      </Modal>

      {/* ====== 查询进度提示 ====== */}
      {batchQueryProgress && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24,
          background: 'var(--brand-gradient)', color: '#fff',
          padding: '12px 20px', borderRadius: 12,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          zIndex: 1000, fontSize: 14, fontWeight: 500,
        }}>
          <Spin size="small" style={{ marginRight: 8 }} /> {batchQueryProgress}
        </div>
      )}
    </div>
  );
}
