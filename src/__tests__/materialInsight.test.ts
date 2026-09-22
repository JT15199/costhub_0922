import { describe, expect, it } from 'vitest';
import {
  buildDecompositionContributionData,
  buildDirectTrendChartData,
  buildInsightHistoryChartData,
  buildSimulatedTrendChartData,
  filterMaterialInsightSubjects,
  filterInsightTreeNodes,
  getMaterialInsightModeMeta,
  getMaterialInsightPreviewNodes,
  getMaterialInsightResult,
  getSelectableInsightNodeIds,
  inferMaterialInsightMode,
  normalizeMaterialInsightLink,
  parseMaterialInsightResult,
  resolveMaterialInsightMode,
  safeHttpUrl,
  shouldUseSimulatedTrend,
  suggestMaterialInsightMode,
} from '../materialInsight';
import { executeWithSqliteRetry, isSqliteLockedError } from '../db/core';
import { getMaterialInsightDeleteIds, groupMaterialInsightRows } from '../db/trend';

describe('material insight parent grouping', () => {
  it('keeps child trend items out of the parent list and preserves their snapshots in the tree', () => {
    const subjects = groupMaterialInsightRows(
      [
        { id: 10, query_category: '电源模块', category_type: '分解洞察' },
        { id: 11, query_category: 'MOSFET', category_type: '直接查询' },
        { id: 12, query_category: '锂电池', category_type: '直接查询', source_type: 'quick' },
      ],
      [
        { id: 1, root_part_id: 1, parent_id: null, component_name: '电源模块', node_type: 'structural', trend_item_id: 10 },
        { id: 2, root_part_id: 1, parent_id: 1, component_name: 'MOSFET', node_type: 'terminal', trend_item_id: 11, insight_status: 'queried' },
      ],
      [{ id: 100, trend_item_id: 11, direction: '上涨', summary: '子节点历史快照' }],
    );

    expect(subjects.map(subject => subject.title)).toEqual(['电源模块', '锂电池']);
    expect(subjects[0].childTrendItemIds).toEqual([11]);
    expect(subjects[0].nodes).toHaveLength(2);
    expect(subjects.find(subject => subject.title === 'MOSFET')).toBeUndefined();
  });

  it('keeps direct queries separate and reports partial node completion', () => {
    const subjects = groupMaterialInsightRows(
      [{ id: 20, query_category: 'MLCC', category_type: '直接查询' }, { id: 21, query_category: 'MLCC', category_type: '直接查询' }],
      [
        { id: 3, root_part_id: 3, parent_id: null, component_name: '显示模组', node_type: 'structural' },
        { id: 4, root_part_id: 3, parent_id: 3, component_name: '面板', node_type: 'terminal', insight_status: 'queried' },
        { id: 5, root_part_id: 3, parent_id: 3, component_name: '驱动板', node_type: 'terminal', insight_status: 'failed' },
        { id: 6, root_part_id: 3, parent_id: 3, component_name: '结构件', node_type: 'terminal', insight_status: 'ready' },
      ],
    );
    const tree = subjects.find(subject => subject.title === '显示模组');
    const direct = subjects.find(subject => subject.title === 'MLCC');
    expect(tree?.status).toBe('partial');
    expect(tree?.completedNodes).toBe(1);
    expect(tree?.failedNodes).toBe(1);
    expect(tree?.skippedNodes).toBe(1);
    expect(direct?.kind).toBe('direct');
    expect(direct?.trendItemIds).toEqual([20, 21]);
  });
});

describe('sqlite delete safeguards', () => {
  it('retries locked errors a finite number of times but not other errors', async () => {
    expect(isSqliteLockedError(new Error('(code: 5) database is locked'))).toBe(true);
    let attempts = 0;
    await expect(executeWithSqliteRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('database is locked');
      return 'ok';
    }, 2, async () => {})).resolves.toBe('ok');
    expect(attempts).toBe(3);

    attempts = 0;
    await expect(executeWithSqliteRetry(async () => {
      attempts++;
      throw new Error('constraint failed');
    }, 2, async () => {})).rejects.toThrow('constraint failed');
    expect(attempts).toBe(1);
  });

  it('deduplicates delete targets for repeated task references', () => {
    expect(getMaterialInsightDeleteIds([
      { key: 'tree:1', rootNodeId: 1, trendItemIds: [10, 11] },
      { key: 'tree:1', rootNodeId: 1, trendItemIds: [10, 11] },
    ])).toEqual({ rootNodeIds: [1], trendItemIds: [10, 11], subjectKeys: ['tree:1'] });
  });
});

describe('material insight entry and selection rules', () => {
  it('uses stable identifiers for direct and decomposition modes', () => {
    expect(getMaterialInsightModeMeta('direct')).toMatchObject({ id: 'direct', label: '直接洞察', icon: 'thunderbolt' });
    expect(getMaterialInsightModeMeta('decompose')).toMatchObject({ id: 'decomposition', label: '分解型洞察', icon: 'branches' });
  });

  it('infers the default mode and normalizes deep-link context', () => {
    expect(inferMaterialInsightMode('电源模块成本机会').mode).toBe('decompose');
    expect(inferMaterialInsightMode('MLCC').mode).toBe('direct');
    expect(normalizeMaterialInsightLink({ material: ' MLCC ', projectId: '8', partId: 9, mode: 'direct' })).toEqual({ material: 'MLCC', projectId: 8, projectCode: undefined, partId: 9, rootId: undefined, prompt: undefined, mode: 'direct' });
  });

  it('selects only terminal nodes and supports batch selection', () => {
    const nodes = [{ id: 1, node_type: 'structural' }, { id: 2, node_type: 'terminal', source_type: 'user_confirmed' }, { id: 3, node_type: 'terminal', source_type: 'ai_draft' }];
    expect(getSelectableInsightNodeIds(nodes)).toEqual([2]);
    expect(getSelectableInsightNodeIds(nodes, [2, 3])).toEqual([2]);
  });

  it('caps the expanded task preview at three terminal nodes', () => {
    const nodes = [1, 2, 3, 4].map(id => ({ id, node_type: 'terminal', component_name: `节点${id}`, cost_ratio_estimate: id }));
    expect(getMaterialInsightPreviewNodes(nodes)).toHaveLength(3);
    expect(getMaterialInsightPreviewNodes(nodes).map(node => node.id)).toEqual([4, 3, 2]);
  });

  it('filters parent tasks by mode, status and search text', () => {
    const subjects = [
      { title: 'MLCC', categoryType: '直接查询', kind: 'direct', status: 'completed' },
      { title: '电源模块', categoryType: '分解洞察', kind: 'decomposition', status: 'partial' },
      { title: '面板', categoryType: '直接查询', kind: 'direct', status: 'pending' },
    ];
    expect(filterMaterialInsightSubjects(subjects, '', 'decomposition').map(subject => subject.title)).toEqual(['电源模块']);
    expect(filterMaterialInsightSubjects(subjects, '', 'all', 'pending').map(subject => subject.title)).toEqual(['面板']);
    expect(filterMaterialInsightSubjects(subjects, 'mlc', 'direct').map(subject => subject.title)).toEqual(['MLCC']);
  });

  it('keeps the launcher explicit while allowing a non-blocking suggestion', () => {
    expect(resolveMaterialInsightMode('auto')).toBe('direct');
    expect(suggestMaterialInsightMode('direct', '电源模块成本机会')?.mode).toBe('decompose');
    expect(suggestMaterialInsightMode('decompose', 'MLCC')?.mode).toBe('direct');
    expect(suggestMaterialInsightMode('direct', 'MLCC')).toBeNull();
  });

  it('records missing structured fields instead of fabricating them', () => {
    const result = parseMaterialInsightResult({ summary: '来源不足' }, { asOf: '2026-09-02' });
    expect(result.direction).toBe('信号不明确');
    expect(result.magnitudeMin).toBeNull();
    expect(result.dataGaps).toEqual(expect.arrayContaining(['缺少可追溯证据ID', '缺少上下行驱动拆分', '缺少可计算的价格幅度']));
  });

  it('normalizes directional drivers and keeps a suggested action visible', () => {
    const result = parseMaterialInsightResult({ direction: '上涨', drivers: [{ label: '供给', text: '交期拉长', direction: '上行' }], suggested_action: '先核验项目报价' });
    expect(result.drivers[0].direction).toBe('上涨');
    expect(result.actions[0].text).toBe('先核验项目报价');
  });

  it('calculates decomposition coverage and only plots reliable node contributions', () => {
    const data = buildDecompositionContributionData(
      [
        { id: 1, node_type: 'terminal', component_name: '面板', cost_ratio_estimate: 60, insight_status: 'queried', trend_item_id: 11 },
        { id: 2, node_type: 'terminal', component_name: '驱动板', cost_ratio_estimate: 25, insight_status: 'failed', trend_item_id: 12 },
        { id: 3, node_type: 'terminal', component_name: '结构件', cost_ratio_estimate: 15, insight_status: 'ready', trend_item_id: 13 },
      ],
      [{ id: 101, trend_item_id: 11, direction: '上涨', confidence_level: '中', query_time: '2026-09-02' }],
    );
    expect(data.coverage).toMatchObject({ total: 3, completed: 1, failed: 1, skipped: 1, rate: 1 / 3 });
    expect(data.points.map(point => point.name)).toEqual(['面板']);
    expect(data.kind).toBe('bidir');
  });

  it('does not draw a fake direct trend when numeric evidence is absent', () => {
    expect(buildDirectTrendChartData([{ id: 1, magnitude_min: null, magnitude_max: null }]).kind).toBe('insufficient');
    expect(buildDirectTrendChartData([{ id: 1, magnitude_min: 1, magnitude_max: 2 }]).kind).toBe('single');
    expect(buildDirectTrendChartData([
      { id: 1, magnitude_min: 1, magnitude_max: 2 },
      { id: 2, magnitude_min: 2, magnitude_max: 4 },
    ]).kind).toBe('range');
    expect(shouldUseSimulatedTrend({ kind: 'insufficient', reason: 'none' })).toBe(true);
    expect(shouldUseSimulatedTrend({ kind: 'single', point: { id: 1, time: '', value: 1, min: 1, max: 1, direction: '', confidence: '', sourceType: '', reference: '' } })).toBe(true);
    expect(shouldUseSimulatedTrend({ kind: 'points', points: [] })).toBe(false);
  });

  it('accepts only HTTP and HTTPS source URLs', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    expect(safeHttpUrl('file:///tmp/demo')).toBe('');
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
  });

  it('keeps every snapshot in direction history and simulates a deterministic non-price trend when needed', () => {
    const snapshots = [
      { id: 1, query_time: '2026-08-01', direction: '下降', confidence_level: '高' },
      { id: 2, query_time: '2026-08-02', direction: '震荡', confidence_level: '中' },
      { id: 3, query_time: '2026-08-03', direction: '分化', confidence_level: '低' },
      { id: 4, query_time: '2026-08-04', direction: '上涨', confidence_level: '中' },
      { id: 5, query_time: '2026-08-05', direction: '信号不明确', confidence_level: '低' },
    ];
    expect(buildInsightHistoryChartData(snapshots)).toHaveLength(5);
    expect(buildInsightHistoryChartData(snapshots).map(point => point.score)).toEqual([-1, 0, 0, 1, 0]);
    expect(buildSimulatedTrendChartData(snapshots).map(point => point.value)).toEqual([96, 95.4, 96.4, 98.9, 98.9]);
  });

  it('recovers persisted structured JSON and preserves legacy snapshots', () => {
    const persisted = getMaterialInsightResult({ query_time: '2026-09-02', result_json: JSON.stringify({ headline: '价格保持平稳', direction: '震荡', confidence: '中', magnitudeMin: 1, magnitudeMax: 2 }) });
    expect(persisted.headline).toBe('价格保持平稳');
    expect(persisted.magnitudeMin).toBe(1);
    const legacy = getMaterialInsightResult({ query_time: '2026-09-01', direction: '下降', confidence_level: '低', summary: '旧快照', result_json: '{}' });
    expect(legacy.direction).toBe('下降');
    expect(legacy.rawText).toBe('旧快照');
  });

  it('filters a focused branch while retaining its ancestor path', () => {
    const nodes = [
      { id: 1, parent_id: null, component_name: '总成' },
      { id: 2, parent_id: 1, component_name: '电源' },
      { id: 3, parent_id: 2, component_name: 'MOSFET' },
      { id: 4, parent_id: 1, component_name: '结构' },
    ];
    expect(filterInsightTreeNodes(nodes, 'all', [], 3).map(node => node.id)).toEqual([1, 2, 3]);
    expect(filterInsightTreeNodes(nodes, 'selected', [3], null).map(node => node.id)).toEqual([1, 2, 3]);
  });
});
