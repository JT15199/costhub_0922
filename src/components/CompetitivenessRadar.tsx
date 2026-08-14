// 竞争力雷达（v2.3.19+）：六维雷达——性能/规格/显示/外观/可靠性（特性评分，可录入）+ 成本竞争力（动态计算）
// 成本力 = 10 × (对比组内最低整机BOM成本 ÷ 本产品整机BOM成本)，保留 1 位小数，封顶 10
// 整机成本口径统一用 BOM 成本：我方项目 = project_boms 快照累加（与 recordProjectCostSnapshot 一致），竞品 = competitors.bom_cost
// 模块-特性关联：手动配置"哪些模块影响哪些特性"，评分时列出关联模块及其成本占比作为打分依据
import { useEffect, useState } from 'react';
import { Select, Button, Space, Modal, Slider, Tag, Input, Checkbox, message, Empty, Radio, Table } from 'antd';
import { RadarChartOutlined, LinkOutlined, EditOutlined, SearchOutlined, AimOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { getProjects, getCompetitors, getFeatures, getAllScoresForRefs, saveScore, getProjectBOMs, getCompetitorBOMs, getModuleNames, getModuleFeatureLinks, setModuleFeatureLinks } from '../db';
import { chartTooltip, chartTextMuted, chartSplitLine } from '../chartTheme';

// 我方固定第一色，竞品依次取项目色板其余色（系列/data 级设置，图例自动跟随）
const RADAR_COLORS = ['#0A84FF', '#5E5CE6', '#BF5AF2', '#FF9F0A', '#34C759', '#FF375F', '#64D2FF', '#98989D'];
// 成本长城图专用色板（语义配色：柱=规格差用冷色蓝紫系，线=成本差用暖色琥珀系；同下标成对）
const WALL_BAR_COLORS = ['#4F46E5', '#6366F1', '#818CF8', '#A5B4FC', '#7C3AED', '#8B5CF6', '#C7D2FE'];
const WALL_LINE_COLORS = ['#F59E0B', '#F97316', '#FB923C', '#FDBA74', '#EF4444', '#F87171', '#FCD34D'];

type RadarProduct = {
  key: string;
  type: 'project' | 'competitor';
  id: number;
  name: string;
  bomCost: number | null;        // null = 成本数据缺失（不画成本力维度）
  scoreMap: Record<number, number>; // feature_id → 分（仅已评分的）
  bomByModule?: { module: string; subtotal: number }[]; // 模块小计（评分弹窗展示依据）
};

export default function CompetitivenessRadar() {
  const [projects, setProjects] = useState<any[]>([]);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [features, setFeatures] = useState<any[]>([]);       // radar 五维
  const [links, setLinks] = useState<Record<string, number[]>>({}); // module_name → feature_id[]
  const [moduleNames, setModuleNames] = useState<any[]>([]);  // [{name,total}]

  const [selPid, setSelPid] = useState<number | null>(null);
  const [selCids, setSelCids] = useState<number[]>([]);
  const [radarProducts, setRadarProducts] = useState<RadarProduct[]>([]);
  // 视图切换：radar=六维雷达 + 特性×成本对比；wall=成本长城图（规格差柱 + 成本差曲线）
  const [viewMode, setViewMode] = useState<'radar' | 'wall'>('radar');

  // 关联配置弹窗
  const [linkModal, setLinkModal] = useState(false);
  const [selModule, setSelModule] = useState<string | null>(null);
  const [modFilter, setModFilter] = useState('');
  const [linkView, setLinkView] = useState<'module' | 'feature'>('module');
  const [pendingFeatureIds, setPendingFeatureIds] = useState<number[]>([]);

  // 评分弹窗
  const [scoreModal, setScoreModal] = useState(false);
  const [scoreProduct, setScoreProduct] = useState<RadarProduct | null>(null);

  useEffect(() => { (async () => {
    const [ps, cs, fs, ls, mns] = await Promise.all([
      getProjects(), getCompetitors(), getFeatures('radar'), getModuleFeatureLinks(), getModuleNames(),
    ]);
    setProjects(ps); setCompetitors(cs); setFeatures(fs); setLinks(ls); setModuleNames(mns);
  })(); }, []);

  // 竞品多选按同品类过滤
  const selProj = projects.find(p => p.id === selPid);
  const sameCatComps = competitors.filter(c => !selProj || !selProj.category || selProj.category === '未分类' || c.category === selProj.category);

  // ==================== 生成雷达 ====================
  const buildRadar = async () => {
    if (!selPid) { message.warning('请先选择我方项目'); return; }
    if (selCids.length === 0) { message.warning('请至少勾选一个竞品'); return; }
    const items: RadarProduct[] = [];
    // 我方：BOM 快照口径累加（原始值累加，最终显示才舍入——项目铁律）
    const myBoms = await getProjectBOMs(selPid);
    const myCost = myBoms.reduce((s, b) => s + ((b.part_cost || 0) * (b.quantity || 1)), 0);
    const myByMod: Record<string, number> = {};
    myBoms.forEach(b => { const m = b.module_name || '未分模块'; myByMod[m] = (myByMod[m] || 0) + ((b.part_cost || 0) * (b.quantity || 1)); });
    items.push({
      key: `p${selPid}`, type: 'project', id: selPid, name: `${selProj?.code || ''} ${selProj?.name || '我方项目'}`,
      bomCost: myCost > 0 ? myCost : null,
      scoreMap: {},
      bomByModule: Object.entries(myByMod).map(([module, subtotal]) => ({ module, subtotal })),
    });
    // 竞品：competitors.bom_cost
    const picked = competitors.filter(c => selCids.includes(c.id));
    for (const c of picked) {
      const cboms = await getCompetitorBOMs(c.id);
      const byMod: Record<string, number> = {};
      cboms.forEach(b => { const m = b.module_name || '未分模块'; byMod[m] = (byMod[m] || 0) + ((b.estimated_cost || 0) * (b.quantity || 1)); });
      items.push({
        key: `c${c.id}`, type: 'competitor', id: c.id, name: `${c.brand} ${c.model}`,
        bomCost: (c.bom_cost && c.bom_cost > 0) ? c.bom_cost : null,
        scoreMap: {},
        bomByModule: Object.entries(byMod).map(([module, subtotal]) => ({ module, subtotal })),
      });
    }
    // 评分：一次拉齐
    const [projScores, compScores] = await Promise.all([
      getAllScoresForRefs('project', [selPid]),
      getAllScoresForRefs('competitor', selCids),
    ]);
    items.forEach(it => {
      it.scoreMap = it.type === 'project' ? (projScores[it.id] || {}) : (compScores[it.id] || {});
    });
    setRadarProducts(items);
    message.success(`竞争力雷达已生成（${items.length} 个产品）`);
  };

  // ==================== 特性级成本分（v2.3.19 算法定版） ====================
  // 同一特性内，成本越低得分越高：得分 = 10 × (组内该特性最低成本 ÷ 本产品该特性成本)，1 位小数封顶 10
  // 单产品对比=10 分；成本缺失(null/0) → null（不参与均值、不画雷达该点）
  // 依赖 costTable（每产品每特性的关联模块成本合计）
  const featureCostScore = (prod: RadarProduct, fid: number): number | null => {
    const costs = radarProducts.map(p =>
      costTable.find(ct => ct.feature.id === fid)?.rows.find(r => r.prod.key === p.key)?.cost || 0,
    ).filter(c => c > 0);
    const myCost = costTable.find(ct => ct.feature.id === fid)?.rows.find(r => r.prod.key === prod.key)?.cost || 0;
    if (myCost <= 0) return null;
    if (costs.length <= 1) return 10;
    const min = Math.min(...costs);
    return Math.min(10, Math.round((10 * (min / myCost)) * 10) / 10);
  };
  // 成本竞争力（雷达第六维）= 已算出成本分的特性均值；全部缺失 → null
  const featureCostAvg = (prod: RadarProduct): number | null => {
    const vals = features.map(f => featureCostScore(prod, f.id)).filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
  };

  // 特性均值：已评分维度求平均，1 位小数；未评分返回 null
  const featureAvg = (prod: RadarProduct): number | null => {
    const vals = features.map(f => prod.scoreMap[f.id]).filter(v => v !== undefined && v !== null);
    if (vals.length === 0) return null;
    return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
  };

  // ==================== 特性 × 成本对比（同成本谁更强） ====================
  // 每个特性的成本 = 该产品中与此特性关联的模块成本合计（模块计入其关联的所有维度）
  // 每分成本 = 特性成本 ÷ 特性评分——同特性下谁低谁强（花更少的钱得到同样的表现）
  const featureCostTable = () => features.map(f => {
    const rows = radarProducts.map(p => {
      const cost = (p.bomByModule || [])
        .filter(m => (links[m.module] || []).includes(f.id))
        .reduce((s, m) => s + m.subtotal, 0);
      const score = p.scoreMap[f.id] !== undefined ? p.scoreMap[f.id] : null;
      const per = (score !== null && score > 0 && cost > 0) ? cost / score : null; // 每分成本
      return { prod: p, cost, score, per };
    });
    return { feature: f, rows };
  });
  const costTable = featureCostTable();
  const anyCostLinked = costTable.some(ct => ct.rows.some(r => r.cost > 0));

  // 每分成本对比条形图：X=特性，系列=产品（越低越好），系列级颜色保证图例一致
  const perCostOption = radarProducts.length === 0 || !anyCostLinked ? null : {
    tooltip: {
      ...chartTooltip('axis'),
      valueFormatter: (v: number) => (v !== null && v !== undefined ? `¥${Number(v).toFixed(2)}/分` : '—'),
    },
    legend: { data: radarProducts.map(p => p.name), top: 0, right: 0, textStyle: { color: chartTextMuted(), fontSize: 11 } },
    grid: { left: 55, right: 20, top: 32, bottom: 5, containLabel: true },
    xAxis: { type: 'category', data: features.map(f => f.name), axisLabel: { color: chartTextMuted(), fontSize: 11 }, axisTick: { show: false } },
    yAxis: { type: 'value', name: '每分成本 ¥', axisLabel: { color: chartTextMuted(), fontSize: 10.5 }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
    series: radarProducts.map((p, idx) => ({
      name: p.name, type: 'bar' as const, barGap: '10%',
      itemStyle: { color: RADAR_COLORS[idx % RADAR_COLORS.length], borderRadius: [4, 4, 0, 0] },
      data: features.map(f => {
        const row = costTable.find(ct => ct.feature.id === f.id)?.rows.find(r => r.prod.key === p.key);
        return row && row.per !== null ? Math.round(row.per * 100) / 100 : null;
      }),
    })),
  };

  // ==================== 雷达图 ====================
  const radarOption = radarProducts.length === 0 ? null : {
    tooltip: chartTooltip('item'),
    legend: { data: radarProducts.map(p => p.name), bottom: 0, textStyle: { color: chartTextMuted(), fontSize: 11 } },
    radar: {
      center: ['50%', '52%'], radius: '65%',
      indicator: [
        ...features.map(f => ({ name: f.name, max: 10 })),
        { name: '成本竞争力', max: 10 },
      ],
      axisName: { color: chartTextMuted(), fontSize: 11 },
      splitNumber: 5,
      splitLine: { lineStyle: { color: chartSplitLine() } },
      splitArea: { areaStyle: { color: ['rgba(255,255,255,0.04)', 'rgba(255,255,255,0.01)'] } },
      axisLine: { lineStyle: { color: chartSplitLine() } },
    },
    series: [{
      type: 'radar' as const,
      data: radarProducts.map((p, idx) => {
        const c = RADAR_COLORS[idx % RADAR_COLORS.length];
        const isMine = idx === 0; // 我方：加粗描边 + 数据点强调；竞品：弱化便于对比
        return {
          name: p.name,
          // 未评分特性 / 缺失成本 → null（不画该顶点），多边形对应边断开
          value: [
            ...features.map(f => (p.scoreMap[f.id] !== undefined ? p.scoreMap[f.id] : null)),
            featureCostAvg(p), // 成本竞争力 = 特性成本分均值（同特性内成本越低分越高）
          ],
          itemStyle: { color: c },
          areaStyle: { color: c + (isMine ? '33' : '1F') },
          lineStyle: { width: isMine ? 3 : 1.5 },
          symbol: isMine ? 'circle' : 'none',
          symbolSize: 6,
        };
      }),
    }],
  };

  // ==================== 关联配置：保存勾选 ====================
  const saveLinks = async (moduleName: string, ids: number[]) => {
    try {
      await setModuleFeatureLinks(moduleName, ids);
      setLinks(await getModuleFeatureLinks());
    } catch (e) {
      message.error('关联保存失败，请重试');
    }
  };
  const pickModule = (name: string) => {
    setSelModule(name);
    setPendingFeatureIds(links[name] || []);
  };
  const toggleFeature = (fid: number, checked: boolean) => {
    if (!selModule) return;
    const next = checked ? [...pendingFeatureIds, fid] : pendingFeatureIds.filter(x => x !== fid);
    setPendingFeatureIds(next);
    saveLinks(selModule, next);
  };

  // 模块列表（搜索过滤）
  const filteredModules = moduleNames.filter(m => !modFilter || m.name.includes(modFilter));

  // ==================== 评分 ====================
  const openScore = (prod: RadarProduct) => { setScoreProduct(prod); setScoreModal(true); };
  const handleScore = async (fid: number, v: number) => {
    if (!scoreProduct) return;
    await saveScore(scoreProduct.type, scoreProduct.id, fid, v);
    setScoreProduct({ ...scoreProduct, scoreMap: { ...scoreProduct.scoreMap, [fid]: v } });
    setRadarProducts(list => list.map(p => p.key === scoreProduct.key ? { ...p, scoreMap: { ...p.scoreMap, [fid]: v } } : p));
  };
  // ==================== 成本长城图（可选视图）：柱=规格差（我方评分−竞品，正=规格强），曲线=成本差（我方特性成本−竞品，负=成本低） ====================
  const mine = radarProducts[0];
  const rivals = radarProducts.slice(1);
  const wallOption = radarProducts.length >= 2 ? (() => {
    const scoreDiff = (r: RadarProduct, fid: number): number | null => {
      const m = mine.scoreMap[fid], rv = r.scoreMap[fid];
      if (m === undefined || rv === undefined) return null;
      return Math.round((m - rv) * 10) / 10;
    };
    const costDiff = (r: RadarProduct, fid: number): number | null => {
      const mc = costTable.find(ct => ct.feature.id === fid)?.rows.find(x => x.prod.key === mine.key)?.cost || 0;
      const rc = costTable.find(ct => ct.feature.id === fid)?.rows.find(x => x.prod.key === r.key)?.cost || 0;
      if (mc <= 0 || rc <= 0) return null;
      return Math.round((mc - rc) * 100) / 100;
    };
    // 自适应轴对称：示意优先——去掉最大 1~2 个极端点防拉爆，主体数据 ×1.25 余量 + nice 取整（1/2/5×10^n），0 居中
    const niceCeil = (v: number) => {
      if (v <= 0) return 1;
      const p = Math.pow(10, Math.floor(Math.log10(v)));
      for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
      return 10 * p;
    };
    const adaptiveAxis = (vals: (number | null)[], def: number) => {
      const abs = vals.filter((v): v is number => v !== null && isFinite(v)).map(v => Math.abs(v));
      if (abs.length === 0) return { min: -def, max: def };
      abs.sort((a, b) => a - b);
      // 去极端：样本多去掉更多（n>=8 去 2 个、n>=4 去 1 个、小样本全保留），极端值超出轴即被裁剪（示意，tooltip 仍可读）
      const drop = abs.length >= 8 ? 2 : abs.length >= 4 ? 1 : 0;
      const used = abs.slice(0, abs.length - drop);
      const m = Math.max(...used, 1);
      const r = niceCeil(m * 1.25);
      return { min: -r, max: r };
    };
    // tooltip 判读（单图/子图共用）
    const verdictOf = (spec: number | null, cost: number | null) => {
      if (spec === null || cost === null) return '';
      if (spec > 0 && cost < 0) return '<br/><b style="color:#10B981">💪 规格强 + 成本低——我方优势特性</b>';
      if (spec < 0 && cost > 0) return '<br/><b style="color:#DC2626">⚠️ 规格弱 + 成本高——我方劣势特性</b>';
      if (spec > 0) return '<br/><span style="color:#D97706">规格强但成本更高</span>';
      return '<br/><span style="color:#D97706">规格弱但成本更低</span>';
    };
    // ===== 多竞品（≥2）：子图网格——每竞品独立双轴自适应，数值差异大的竞品互不拉爆 =====
    if (rivals.length >= 2) {
      const n = rivals.length;
      const pct = 100 / n;
      const rivalData = rivals.map((r, i) => {
        const sVals = features.map(f => scoreDiff(r, f.id));
        const cVals = features.map(f => costDiff(r, f.id));
        return {
          r, i,
          sVals, cVals,
          sAxis: adaptiveAxis(sVals, 2),
          cAxis: adaptiveAxis(cVals, 10),
          barColor: WALL_BAR_COLORS[i % WALL_BAR_COLORS.length],
          lineColor: WALL_LINE_COLORS[i % WALL_LINE_COLORS.length],
        };
      });
      return {
        title: rivalData.map(d => ({
          text: d.r.name, left: (d.i * pct + pct / 2) + '%', top: 2, textAlign: 'center',
          textStyle: { fontSize: 11.5, fontWeight: 600, color: '#334155' },
        })),
        tooltip: {
          ...chartTooltip('axis'),
          formatter: (ps: any[]) => {
            const name = ps[0]?.axisValue || '';
            let spec: number | null = null, cost: number | null = null;
            (ps || []).forEach(p => {
              if (p.seriesName.includes('规格差')) spec = p.value;
              if (p.seriesName.includes('成本差')) cost = p.value;
            });
            return `<b>${name}</b><br/>规格差：${spec === null ? '—' : (spec > 0 ? '+' : '') + spec} 分<br/>成本差：${cost === null ? '—' : (cost > 0 ? '+' : '') + cost} 元${verdictOf(spec, cost)}`;
          },
        },
        grid: rivalData.map(d => ({
          left: (d.i * pct + 2) + '%', right: (100 - (d.i + 1) * pct + 2) + '%', top: 30, bottom: 46,
        })),
        xAxis: rivalData.map(d => ({
          type: 'category' as const, gridIndex: d.i, data: features.map(f => f.name),
          axisLabel: { color: chartTextMuted(), fontSize: 9.5, interval: 0, rotate: n >= 4 ? 22 : 0 },
          axisTick: { show: false }, axisLine: { lineStyle: { color: chartSplitLine() } },
        })),
        yAxis: rivalData.flatMap(d => [
          { type: 'value' as const, gridIndex: d.i, name: '规格差', min: d.sAxis.min, max: d.sAxis.max, nameTextStyle: { fontSize: 8.5, color: chartTextMuted() }, axisLabel: { fontSize: 8.5, color: chartTextMuted() }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } } },
          { type: 'value' as const, gridIndex: d.i, name: '成本差', min: d.cAxis.min, max: d.cAxis.max, nameTextStyle: { fontSize: 8.5, color: chartTextMuted() }, axisLabel: { fontSize: 8.5, color: chartTextMuted() }, splitLine: { show: false }, position: 'right' as const },
        ]),
        series: rivalData.flatMap(d => [
          {
            name: d.r.name + ' 规格差', type: 'bar' as const, xAxisIndex: d.i, yAxisIndex: d.i * 2, barWidth: '38%',
            itemStyle: { color: d.barColor, borderRadius: [2, 2, 0, 0] },
            label: { show: true, position: 'top', formatter: (p: any) => (p.value === null || p.value === undefined ? '' : (p.value > 0 ? '+' : '') + p.value), fontSize: 9, color: chartTextMuted() },
            markLine: {
              silent: true, symbol: 'none',
              lineStyle: { color: 'rgba(148,163,184,0.55)', type: 'dashed', width: 1 },
              label: { show: false },
              data: [{ yAxis: 0 }],
            },
            data: d.sVals,
          },
          {
            name: d.r.name + ' 成本差', type: 'line' as const, xAxisIndex: d.i, yAxisIndex: d.i * 2 + 1, symbol: 'circle', symbolSize: 5,
            lineStyle: { width: 2 }, itemStyle: { color: d.lineColor, borderColor: '#fff', borderWidth: 1 }, connectNulls: false,
            data: d.cVals,
          },
        ]),
      };
    }
    // ===== 单竞品：保持单图（图例 + 全宽双轴）=====
    const r = rivals[0];
    const sAxis = adaptiveAxis(features.map(f => scoreDiff(r, f.id)), 2);
    const cAxis = adaptiveAxis(features.map(f => costDiff(r, f.id)), 10);
    const barColor = WALL_BAR_COLORS[0];
    const lineColor = WALL_LINE_COLORS[0];
    return {
      tooltip: {
        ...chartTooltip('axis'),
        formatter: (ps: any[]) => {
          const name = ps[0]?.axisValue || '';
          let spec: number | null = null, cost: number | null = null;
          (ps || []).forEach(p => {
            if (p.seriesName.includes('规格差')) spec = p.value;
            if (p.seriesName.includes('成本差')) cost = p.value;
          });
          return `<b>${name}</b><br/>规格差：${spec === null ? '—' : (spec > 0 ? '+' : '') + spec} 分<br/>成本差：${cost === null ? '—' : (cost > 0 ? '+' : '') + cost} 元${verdictOf(spec, cost)}`;
        },
      },
      legend: {
        data: [`${r.name} 规格差`, `${r.name} 成本差`],
        top: 0, right: 0, textStyle: { color: chartTextMuted(), fontSize: 11 },
      },
      grid: { left: 60, right: 70, top: 36, bottom: 5, containLabel: true },
      xAxis: { type: 'category', data: features.map(f => f.name), axisLabel: { color: chartTextMuted(), fontSize: 11 }, axisTick: { show: false } },
      yAxis: [
        { type: 'value', name: '规格差(分)', min: sAxis.min, max: sAxis.max, axisLabel: { color: chartTextMuted(), fontSize: 10.5 }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
        { type: 'value', name: '成本差(¥)', min: cAxis.min, max: cAxis.max, axisLabel: { color: chartTextMuted(), fontSize: 10.5 }, splitLine: { show: false } },
      ],
      series: [
        {
          name: `${r.name} 规格差`, type: 'bar' as const, yAxisIndex: 0, barWidth: '30%',
          itemStyle: { color: barColor, borderRadius: [3, 3, 0, 0] },
          label: { show: true, position: 'top', formatter: (p: any) => (p.value === null || p.value === undefined ? '' : (p.value > 0 ? '+' : '') + p.value), fontSize: 9.5, color: chartTextMuted() },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: 'rgba(148,163,184,0.55)', type: 'dashed', width: 1 },
            label: { show: false },
            data: [{ yAxis: 0 }],
          },
          data: features.map(f => scoreDiff(r, f.id)),
        },
        {
          name: `${r.name} 成本差`, type: 'line' as const, yAxisIndex: 1, symbol: 'circle', symbolSize: 7,
          lineStyle: { width: 2.5 }, itemStyle: { color: lineColor, borderColor: '#fff', borderWidth: 1 }, connectNulls: false,
          data: features.map(f => costDiff(r, f.id)),
        },
      ],
    };
  })() : null;

  // 某产品某特性维度的关联模块（含小计与占比），供评分时参考
  const linkedModulesOf = (prod: RadarProduct, fid: number) => {
    const total = (prod.bomByModule || []).reduce((s, m) => s + m.subtotal, 0) || 1;
    return (prod.bomByModule || [])
      .filter(m => (links[m.module] || []).includes(fid))
      .sort((a, b) => b.subtotal - a.subtotal)
      .map(m => ({ ...m, ratio: (m.subtotal / total) * 100 }));
  };

  return (
    <div className="content-card" style={{ marginBottom: 14, padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}><RadarChartOutlined style={{ color: '#CF0A2C' }} /> 竞争力雷达（特性评分 + 成本竞争力）</b>
        <Space wrap>
          <Radio.Group value={viewMode} onChange={e => setViewMode(e.target.value)} size="small" optionType="button" buttonStyle="solid"
            options={[{ label: '雷达视图', value: 'radar' }, { label: '成本长城图', value: 'wall' }]} />
          <Button size="small" icon={<LinkOutlined />} onClick={() => { setLinkModal(true); if (!selModule && moduleNames.length > 0) pickModule(moduleNames[0].name); }}>模块-特性关联</Button>
          {radarProducts.map(p => (
            <Button key={p.key} size="small" icon={<EditOutlined />} onClick={() => openScore(p)}>评分 · {p.name}</Button>
          ))}
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Select placeholder="我方项目" value={selPid} onChange={v => { setSelPid(v); }} style={{ width: 240 }} size="small"
          options={projects.filter((p: any) => p.category !== '未分类' || true).map(p => ({ label: `[${p.code}] ${p.name}`, value: p.id }))} />
        <Select mode="multiple" placeholder="竞品（可多选，同品类）" value={selCids} onChange={v => setSelCids(v)} style={{ minWidth: 260, maxWidth: 480, flex: 1 }} size="small"
          options={sameCatComps.map(c => ({ label: `${c.brand} ${c.model}`, value: c.id }))} />
        <Button type="primary" size="small" icon={<AimOutlined />} onClick={buildRadar} disabled={!selPid || selCids.length === 0}>生成雷达</Button>
      </div>

      {radarProducts.length > 0 && (() => {
        const noCost = radarProducts.filter(p => p.bomCost === null);
        const noScore = radarProducts.filter(p => Object.keys(p.scoreMap).length === 0);
        const noLink = !anyCostLinked;
        return (noCost.length > 0 || noScore.length > 0 || noLink) ? (
          <div style={{ marginBottom: 10, padding: '6px 10px', background: '#FFF7E6', border: '1px solid #FFE7BA', borderRadius: 8, fontSize: 11.5, color: '#B45309', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {noCost.length > 0 && <span>⚠️ {noCost.map(p => p.name).join('、')} 无成本数据（成本竞争力/长城图成本差不完整）</span>}
            {noScore.length > 0 && <span>⚠️ {noScore.map(p => p.name).join('、')} 未评分（雷达特性维度空白）</span>}
            {noLink && <span>⚠️ 模块-特性关联未配置——先点「模块-特性关联」</span>}
          </div>
        ) : null;
      })()}
      {radarProducts.length > 0 && (viewMode === 'radar' ? (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 520px', minWidth: 380 }}>
              {radarOption ? <ReactECharts echarts={echarts} option={radarOption} style={{ height: 400 }} /> : null}
            </div>
            <div style={{ flex: '0 1 320px', minWidth: 260 }}>
              <div style={{ fontSize: 12, color: chartTextMuted(), marginBottom: 8 }}>评分概览（与雷达图数值一致 · 成本分=同特性内成本越低越高）</div>
              {radarProducts.map(p => {
                const avg = featureAvg(p);
                const cs = featureCostAvg(p);
                return (
                  <div key={p.key} style={{ border: '1px solid #E8ECF1', borderRadius: 8, padding: '8px 12px', marginBottom: 8, background: '#FAFBFC' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <b style={{ fontSize: 13 }}>{p.name}</b>
                      <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openScore(p)}>评分</Button>
                    </div>
                    {/* 每特性：评分 + 成本分 */}
                    {features.map(f => {
                      const sc = p.scoreMap[f.id];
                      const fcs = featureCostScore(p, f.id);
                      return (
                        <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5, padding: '3px 0', borderBottom: '1px solid #F1F5F9', fontVariantNumeric: 'tabular-nums' }}>
                          <span style={{ color: '#64748B' }}>{f.name}</span>
                          <span>
                            <span style={{ fontWeight: 600 }}>{sc !== undefined ? `${Number(sc).toFixed(1)} 分` : <span style={{ color: '#CBD5E1' }}>未评分</span>}</span>
                            <span style={{ color: '#94A3B8' }}> · 成本 </span>
                            <span style={{ fontWeight: 600, color: fcs !== null ? (fcs >= 8 ? '#10B981' : fcs >= 6 ? '#D97706' : '#DC2626') : '#CBD5E1' }}>
                              {fcs !== null ? `${fcs.toFixed(1)} 分` : '—'}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', gap: 16, marginTop: 6, alignItems: 'baseline' }}>
                      <div>
                        <div style={{ fontSize: 10.5, color: chartTextMuted() }}>特性均值</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#0A84FF', fontVariantNumeric: 'tabular-nums' }}>
                          {avg !== null ? `${avg.toFixed(1)} 分` : <span style={{ fontSize: 12, color: '#94A3B8' }}>未评分</span>}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10.5, color: chartTextMuted() }}>成本竞争力（特性均值）</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#10B981', fontVariantNumeric: 'tabular-nums' }}>
                          {cs !== null ? `${cs.toFixed(1)} 分` : <span style={{ fontSize: 12, color: '#94A3B8' }}>无成本数据</span>}
                        </div>
                      </div>
                      <div style={{ marginLeft: 'auto', fontSize: 11, color: chartTextMuted(), alignSelf: 'flex-end' }}>
                        BOM ¥{p.bomCost !== null ? p.bomCost.toFixed(2) : '—'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>
            成本竞争力（雷达第六维）= 各特性成本分的均值；<b>特性成本分 = 10 × (组内该特性最低成本 ÷ 本产品该特性成本)</b>，同一特性内成本越低得分越高，封顶 10。特性分 0–10，未评分的维度不在雷达上显示。
          </div>

          {/* ==================== 特性 × 成本对比（同成本谁更强） ==================== */}
          <div style={{ marginTop: 16, border: '1px solid #E8ECF1', borderRadius: 10, padding: '12px 14px', background: '#FAFBFC' }}>
            <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <b style={{ fontSize: 13, color: '#1E3A6E' }}>特性 × 成本对比（同成本谁更强）</b>
              {!anyCostLinked && <Tag color="orange">特性成本为 0——先到「模块-特性关联」配置哪些模块影响哪些特性</Tag>}
            </div>
            <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 8 }}>
              每个特性的成本 = 该产品中与此特性关联的模块成本合计（一个模块计入其关联的所有维度）；<b>每分成本 = 特性成本 ÷ 特性评分</b>——同特性下谁低谁强（花更少的钱得到同样的表现）。💪 = 该特性组内每分成本最低。
            </div>
            {/* 上下布局：图全宽（高度随竞品数自适应）+ 表全宽，避免侧栏挤压遮挡 */}
            <div style={{ marginBottom: 12 }}>
              {perCostOption ? <ReactECharts echarts={echarts} option={perCostOption} style={{ height: Math.max(240, radarProducts.length * 36 + 120) }} /> : (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94A3B8', fontSize: 12, border: '1px dashed #E2E8F0', borderRadius: 8 }}>
                  配置模块-特性关联并完成评分后，这里显示各特性的每分成本对比（越低越强）
                </div>
              )}
            </div>
            <div>
                <Table size="small" pagination={false} rowKey="key" dataSource={costTable.map(ct => {
                  const best = ct.rows.filter(r => r.per !== null).sort((a, b) => (a.per || 0) - (b.per || 0))[0];
                  return { key: ct.feature.id, name: ct.feature.name, rows: ct.rows, best };
                })}
                  scroll={{ x: 90 + radarProducts.length * 96 + 100 }}
                  columns={[
                    { title: '特性', dataIndex: 'name', width: 90, render: (v: string) => <b style={{ fontSize: 12.5 }}>{v}</b> },
                    ...radarProducts.map(p => ({
                      title: p.name, key: p.key, width: 96,
                      render: (_: any, r: any) => {
                        const row = r.rows.find((x: any) => x.prod.key === p.key);
                        if (!row) return null;
                        const isBest = r.best && r.best.prod.key === p.key && row.per !== null && row.per === r.best.per;
                        const score = row.score !== null && row.score !== undefined ? `${Number(row.score).toFixed(1)} 分` : '—';
                        const cost = row.cost > 0 ? `¥${row.cost.toFixed(2)}` : '—';
                        const per = row.per !== null ? `¥${row.per.toFixed(2)}/分` : '—';
                        return (
                          <div style={{ fontSize: 11.5, lineHeight: 1.55, fontVariantNumeric: 'tabular-nums' }}>
                            <div>{score}{row.score !== null && row.score !== undefined ? ' · ' + cost : ' · 未评分'}</div>
                            <div style={{ fontWeight: 600, color: isBest ? '#10B981' : '#334155' }}>
                              {per}{isBest ? ' 💪' : ''}
                            </div>
                          </div>
                        );
                      },
                    })),
                    {
                      title: '每分成本最低', key: 'best', width: 110,
                      render: (_: any, r: any) => r.best
                        ? <span style={{ fontSize: 11.5, color: '#10B981', fontWeight: 600 }}>💪 {r.best.prod.name}</span>
                        : <span style={{ fontSize: 11, color: '#CBD5E1' }}>—</span>,
                    },
                  ]} />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* ==================== 成本长城图：柱=规格差（我方−竞品），曲线=成本差（我方−竞品） ==================== */}
          <div style={{ border: '1px solid #E8ECF1', borderRadius: 10, padding: '12px 14px', background: '#FAFBFC' }}>
            <div style={{ marginBottom: 6 }}>
              <b style={{ fontSize: 13, color: '#1E3A6E' }}>成本长城图：规格差 vs 成本差</b>
              <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>柱（蓝紫系）= 我方规格评分 − 竞品（正=规格更强）；曲线（琥珀系）= 我方特性成本 − 竞品（负=成本更低）；多竞品时每竞品一个子图、轴各自适配</span>
            </div>
            {wallOption ? (
              <ReactECharts echarts={echarts} option={wallOption} style={{ height: 400 }} />
            ) : (
              <div style={{ textAlign: 'center', padding: '70px 20px', color: '#94A3B8', fontSize: 12, border: '1px dashed #E2E8F0', borderRadius: 8 }}>
                成本长城图需要至少 1 个竞品参与对比——生成雷达后切换到此视图
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11.5, color: '#64748B', marginTop: 4 }}>
              <span><b style={{ color: '#10B981' }}>💪 柱正 + 线负</b>：规格强且成本低——优势特性</span>
              <span><b style={{ color: '#DC2626' }}>⚠️ 柱负 + 线正</b>：规格弱且成本高——劣势特性</span>
              <span>柱正 + 线正：规格强但更贵</span>
              <span>柱负 + 线负：规格弱但便宜</span>
            </div>
          </div>
        </>
      ))}

      {/* ==================== 模块-特性关联弹窗 ==================== */}
      <Modal title="模块-特性关联" open={linkModal} onCancel={() => setLinkModal(false)} footer={null} width={720}
        afterOpenChange={(open) => { if (open && !selModule && moduleNames.length > 0) pickModule(moduleNames[0].name); }}>
        <div style={{ marginBottom: 10, fontSize: 12, color: '#6E6A64' }}>
          配置"哪些模块影响哪些特性"——评分时系统会列出该产品下关联的模块及成本占比，作为打分依据。同名模块全局一致。
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <Radio.Group value={linkView} onChange={e => setLinkView(e.target.value)} size="small" optionType="button" buttonStyle="solid"
            options={[{ label: '按模块配置', value: 'module' }, { label: '按特性检查', value: 'feature' }]} />
          <Input size="small" prefix={<SearchOutlined style={{ color: '#94A3B8' }} />} placeholder="搜索模块..." value={modFilter}
            onChange={e => { setModFilter(e.target.value); if (linkView === 'module') setSelModule(null); }}
            style={{ width: 200 }} allowClear />
        </div>

        {moduleNames.length === 0 ? (
          <Empty description="尚无模块数据——请先在项目管理中导入 BOM，再回来配置模块与特性的关联" />
        ) : linkView === 'module' ? (
          <div style={{ display: 'flex', gap: 12 }}>
            {/* 左：模块列表 */}
            <div style={{ flex: '1 1 280px', border: '1px solid #E8ECF1', borderRadius: 8, maxHeight: 380, overflow: 'auto', padding: 4 }}>
              {filteredModules.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>无匹配模块</div>}
              {filteredModules.map(m => {
                const linked = links[m.name] || [];
                const active = selModule === m.name;
                return (
                  <div key={m.name} onClick={() => pickModule(m.name)} role="button" tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') pickModule(m.name); }}
                    style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 2, background: active ? '#EEF2FF' : 'transparent', border: active ? '1px solid #C7D2FE' : '1px solid transparent' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                      <b style={{ fontSize: 12.5 }}>{m.name}</b>
                      <span style={{ fontSize: 10.5, color: '#94A3B8' }}>¥{m.total ? m.total.toFixed(2) : '0.00'}</span>
                    </div>
                    <div style={{ marginTop: 3, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      {features.filter(f => linked.includes(f.id)).map(f => (
                        <Tag key={f.id} color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{f.name}</Tag>
                      ))}
                      {linked.length === 0 && <span style={{ fontSize: 10.5, color: '#CBD5E1' }}>未关联</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* 右：特性勾选（勾选即保存） */}
            <div style={{ flex: '1 1 320px', border: '1px solid #E8ECF1', borderRadius: 8, padding: 12 }}>
              {selModule ? (
                <>
                  <div style={{ marginBottom: 8 }}><b style={{ fontSize: 13 }}>{selModule}</b>
                    <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>勾选即保存</span>
                  </div>
                  {features.map(f => (
                    <div key={f.id} style={{ padding: '7px 4px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Checkbox checked={(pendingFeatureIds || []).includes(f.id)} onChange={e => toggleFeature(f.id, e.target.checked)}>
                        <span style={{ fontSize: 13 }}>{f.name}</span>
                      </Checkbox>
                      <span style={{ fontSize: 10.5, color: '#94A3B8' }}>该模块影响{f.name}表现</span>
                    </div>
                  ))}
                </>
              ) : (
                <div style={{ textAlign: 'center', paddingTop: 80, color: '#94A3B8', fontSize: 12 }}>← 先选择左侧模块（或搜索定位）</div>
              )}
            </div>
          </div>
        ) : (
          /* 按特性检查：每个特性下已关联的模块 */
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            {features.map(f => {
              const mods = Object.entries(links).filter(([, fids]) => fids.includes(f.id)).map(([name]) => name);
              return (
                <div key={f.id} style={{ padding: '8px 10px', borderBottom: '1px solid #F1F5F9' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{f.name}
                    <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400, marginLeft: 8 }}>{mods.length} 个模块</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {mods.length > 0 ? mods.map(name => (
                      <Tag key={name} style={{ fontSize: 11, cursor: 'pointer', margin: 0 }} onClick={() => { setLinkView('module'); setModFilter(name); pickModule(name); }}>{name}</Tag>
                    )) : <span style={{ fontSize: 11, color: '#CBD5E1' }}>暂无关联模块——切到"按模块配置"补充</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {/* ==================== 评分弹窗 ==================== */}
      <Modal title={scoreProduct ? `评分 · ${scoreProduct.name}` : '评分'} open={scoreModal}
        onCancel={() => setScoreModal(false)} footer={null} width={560}>
        <div style={{ marginBottom: 10, fontSize: 12, color: '#6E6A64' }}>
          0–10 分，滑动即保存。每个维度下列出该产品中关联的模块及成本占比，作为打分依据。
        </div>
        {scoreProduct && features.map(f => {
          const val = scoreProduct.scoreMap[f.id] !== undefined ? scoreProduct.scoreMap[f.id] : 0;
          const linked = linkedModulesOf(scoreProduct, f.id);
          return (
            <div key={f.id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                <b style={{ fontSize: 13 }}>{f.name}</b>
                <Tag color={val >= 7 ? 'green' : val >= 4 ? 'blue' : 'orange'} style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{val.toFixed(1)} 分</Tag>
              </div>
              <Slider min={0} max={10} step={0.5} value={val} onChange={v => handleScore(f.id, v)} />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {linked.length > 0 ? linked.map(l => (
                  <Tag key={l.module} style={{ fontSize: 10.5, margin: 0 }}>📦 {l.module} · ¥{l.subtotal.toFixed(2)} · {l.ratio.toFixed(1)}%</Tag>
                )) : (
                  <span style={{ fontSize: 11, color: '#CBD5E1' }}>该产品暂无与此特性关联的模块——可到「模块-特性关联」中补充，让打分更有依据</span>
                )}
              </div>
            </div>
          );
        })}
      </Modal>
    </div>
  );
}
