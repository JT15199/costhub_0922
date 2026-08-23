// 价值工程计算纯函数（v2.3.19，2026-08-18）
// 价值由数据算（不人为定义）：价值分 = Σ(品类特性评分 × 权重)；价值指数 VE = 价值分 / 每千元成本；
// 模块价值比 = 模块特性贡献占比 / 模块成本占比（>1 物有所值，<1 贵而不值 → 价值工程对象）
export interface VETemplate { featureKey: string; featureLabel: string; weight: number; }
export interface VEObject {
  refType: 'project' | 'competitor';
  refId: number;
  name: string;
  category: string;
  bomCost: number;
  marketPrice?: number;
  moduleCosts: Record<string, number>;        // 模块名 → 成本
  moduleFeatures: Record<string, string[]>;   // 模块名 → 关联特性 key
  scores: Record<string, number>;             // featureKey → 评分(0-10)
}
export interface VEResult {
  refType: 'project' | 'competitor';
  refId: number;
  name: string;
  valueScore: number;      // 加权价值分 0-10
  bomCost: number;
  ve: number;              // 价值指数 = valueScore / (bomCost/1000)，越高越好
  costPerValue: number;    // 每价值分成本 = bomCost / valueScore，越低越好
  modules: {
    module: string; cost: number; costRatio: number; valueContribution: number; valueRatio: number;
  }[];
  worstModules: { module: string; valueRatio: number; costRatio: number }[]; // 价值比最低的模块（高成本低价值）
}

function weightedScore(obj: VEObject, templates: VETemplate[]): number {
  let sum = 0, wsum = 0;
  for (const t of templates) {
    const s = obj.scores[t.featureKey];
    if (s == null) continue;
    sum += s * (t.weight || 1);
    wsum += t.weight || 1;
  }
  return wsum > 0 ? sum / wsum : 0;
}

export function computeValueEngineering(objects: VEObject[], templates: VETemplate[]): VEResult[] {
  return objects.map(obj => {
    const valueScore = weightedScore(obj, templates);
    const bomCost = obj.bomCost || 1;
    const ve = valueScore > 0 ? valueScore / (bomCost / 1000) : 0;
    const costPerValue = valueScore > 0 ? bomCost / valueScore : 0;
    // 模块价值比：模块特性贡献占比 / 模块成本占比
    let totalVal = 0;
    const modVal: Record<string, number> = {};
    for (const [mod, feats] of Object.entries(obj.moduleFeatures || {})) {
      let v = 0;
      for (const fk of feats || []) {
        const s = obj.scores[fk];
        if (s != null) v += s;
      }
      modVal[mod] = v;
      totalVal += v;
    }
    const totalCost = Object.values(obj.moduleCosts || {}).reduce((s, c) => s + (c || 0), 0) || 1;
    const modules = Object.entries(obj.moduleCosts || {}).map(([module, cost]) => {
      const costRatio = totalCost ? cost / totalCost : 0;
      const valueContribution = totalVal ? (modVal[module] || 0) / totalVal : 0;
      // 有特性贡献才做价值比（>1 物有所值 / <1 贵而不值）；无特性贡献时 valueRatio 置 -1（不评判，避免误标）
      const valueRatio = (totalVal > 0 && valueContribution > 0 && costRatio > 0)
        ? valueContribution / costRatio
        : (costRatio > 0 ? -1 : 1);
      return { module, cost, costRatio, valueContribution, valueRatio };
    });
    // 有特性贡献 → 找价值比最低(<1)的高成本模块；无特性贡献 → 只标成本占比最高的 1 个作为「重点成本模块」提示
    const worstModules = totalVal > 0
      ? modules.filter(m => m.costRatio >= 0.05 && m.valueRatio > 0 && m.valueRatio < 1).sort((a, b) => a.valueRatio - b.valueRatio).slice(0, 3)
      : modules.filter(m => m.costRatio >= 0.05).sort((a, b) => b.costRatio - a.costRatio).slice(0, 1);
    return { refType: obj.refType, refId: obj.refId, name: obj.name, valueScore, bomCost, ve, costPerValue, modules, worstModules };
  });
}
