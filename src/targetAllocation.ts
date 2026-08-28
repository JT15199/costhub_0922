// 新项目目标成本分配（v2.3.19，2026-08-27 用户：整体目标外部输入，按上一代特性价值+价值工程分配到领域/特性）
// 领域 = 项目 BOM 模块分组（用户：大结构/大硬件/多媒体/包装/互连等）；特性 = 卖点（带声量）；新特性无历史声量 → 手输预算
// 价值密度 = 支撑声量 ÷ 成本占比（客观数据，不主观打分）；老特性按价值密度自动分配，新特性预算由用户定
import { allocateModuleCosts } from './sellingPointAnalyzer';

export interface TargetFeature {
  name: string; isNew: boolean; voice: number; prevCost: number; targetCost: number;
}
export interface TargetDomain {
  name: string; prevCost: number; prevRatio: number; voice: number; density: number;
  targetCost: number; targetRatio: number; delta: number; features: TargetFeature[];
}
export interface TargetAllocationResult {
  domains: TargetDomain[]; newFeatures: TargetFeature[];
  targetTotal: number; allocatedSum: number; diff: number;
}

/** BOM → 模块（领域）成本：Σ 器件成本×数量 */
export function computeModuleCosts(boms: any[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const b of boms || []) {
    if (b && b.is_deleted) continue;
    const mod = String(b?.module_name || '未归类');
    const cost = (Number(b?.part_cost ?? b?.cost) || 0) * (Number(b?.quantity) || 1);
    m[mod] = (m[mod] || 0) + cost;
  }
  return m;
}

/**
 * 目标分配：老特性模块按价值密度（声量÷成本占比）分配 autoTotal（目标总成本−新特性预算）；
 * 模块内老特性按声量占比分摊；新特性手输预算并入所属模块；取整差额并入最大模块保证 Σ=目标。
 */
export function buildTargetAllocation(input: {
  targetTotal: number;
  moduleCosts: Record<string, number>;
  sps: { id: number; name: string; positive: number; negative: number; isNew?: boolean }[];
  spModules: Record<number, string[]>;
  newFeatureBudgets?: Record<string, number>;
}): TargetAllocationResult {
  const { targetTotal, moduleCosts, sps, spModules, newFeatureBudgets } = input;
  const totalPrev = Object.values(moduleCosts).reduce((s, v) => s + (Number(v) || 0), 0);

  // 特性成本（声量加权分摊，复用卖点分析）
  const spModulesArr: { spId: number; module: string }[] = [];
  for (const sp of sps || []) for (const m of spModules?.[sp.id] || []) spModulesArr.push({ spId: sp.id, module: m });
  const voiceBySp: Record<number, number> = {};
  for (const sp of sps || []) voiceBySp[sp.id] = (sp.positive || 0) + (sp.negative || 0);
  const { bySp } = allocateModuleCosts(spModulesArr, moduleCosts, voiceBySp);

  // 模块支撑声量（只算老特性）
  const modVoice: Record<string, number> = {};
  for (const sp of sps || []) { if (sp.isNew) continue; for (const m of spModules?.[sp.id] || []) modVoice[m] = (modVoice[m] || 0) + (voiceBySp[sp.id] || 0); }

  // 新特性预算（手输），从目标总成本扣除后老特性自动分配
  const newFeatures: TargetFeature[] = [];
  let newTotal = 0;
  for (const sp of sps || []) {
    if (sp.isNew) { const t = Number(newFeatureBudgets?.[sp.name] ?? 0) || 0; newFeatures.push({ name: sp.name, isNew: true, voice: 0, prevCost: 0, targetCost: t }); newTotal += t; }
  }
  const autoTotal = Math.max(0, targetTotal - newTotal);

  // 价值密度（显示用）：声量 ÷ 成本占比
  const densityMap: Record<string, number> = {};
  for (const m of Object.keys(moduleCosts)) {
    const cost = moduleCosts[m] || 0;
    const voice = modVoice[m] || 0;
    const ratio = totalPrev > 0 ? cost / totalPrev : 0;
    densityMap[m] = ratio > 0 ? voice / ratio : 0;
  }

  // 2026-08-28 分配口径（用户：结合上一代、符合基本的大概规律——价值密度只做温和修正，不颠覆上一代结构）：
  // 基线 = 上一代成本占比（等比缩放到目标总成本）；因子 = 声量占比 ÷ 成本占比（>1 关注度超成本规模→加投，<1→降）；
  // 目标占比 = 基线 × (1 + (因子-1)×ALPHA)，钳制 [基线×LOW, 基线×HIGH]，归一化保证 Σ=1。
  const ALPHA = 0.4; // 调整强度（温和）
  const LOW = 0.8, HIGH = 1.3; // 上下限钳制（不砍穿物料刚需 / 不过度加码）
  const voiceTotal = Object.values(modVoice).reduce((s, v) => s + v, 0);
  const shares: Record<string, number> = {};
  for (const m of Object.keys(moduleCosts)) {
    const base = totalPrev > 0 ? (moduleCosts[m] || 0) / totalPrev : 0;
    const voiceRatio = voiceTotal > 0 ? (modVoice[m] || 0) / voiceTotal : 0;
    const factor = base > 0 ? voiceRatio / base : 0; // 无声量 → 0（该降），但钳制保底
    let share = base * (1 + (factor - 1) * ALPHA);
    if (base > 0) share = Math.min(Math.max(share, base * LOW), base * HIGH);
    shares[m] = Math.max(0, share);
  }
  const shareSum = Object.values(shares).reduce((s, v) => s + v, 0);
  const rawTarget: Record<string, number> = {};
  for (const m of Object.keys(moduleCosts)) {
    const share = shareSum > 0 ? shares[m] / shareSum : (Object.keys(moduleCosts).length ? 1 / Object.keys(moduleCosts).length : 0);
    rawTarget[m] = Math.floor(autoTotal * share * 100) / 100;
  }
  let used = Object.values(rawTarget).reduce((s, v) => s + v, 0);
  const diffAuto = Math.round((autoTotal - used) * 100) / 100;
  if (Math.abs(diffAuto) > 0.001) {
    const biggest = Object.keys(rawTarget).sort((a, b) => rawTarget[b] - rawTarget[a])[0];
    if (biggest) rawTarget[biggest] = Math.round((rawTarget[biggest] + diffAuto) * 100) / 100;
  }

  // 特性级：模块目标内老特性按声量占比分摊；新特性预算并入所属模块
  const domains: TargetDomain[] = Object.keys(moduleCosts).map(m => {
    const prevCost = moduleCosts[m] || 0;
    const prevRatio = totalPrev > 0 ? prevCost / totalPrev : 0;
    const voice = modVoice[m] || 0;
    const density = densityMap[m] || 0;
    const modSps = (sps || []).filter(sp => (spModules?.[sp.id] || []).includes(m));
    const oldSps = modSps.filter(sp => !sp.isNew);
    const newSps = modSps.filter(sp => !!sp.isNew);
    const oldVoice = oldSps.reduce((s, sp) => s + (voiceBySp[sp.id] || 0), 0);
    const oldTarget = rawTarget[m] || 0;
    const features: TargetFeature[] = [];
    for (const sp of oldSps) {
      const v = voiceBySp[sp.id] || 0;
      const t = oldVoice > 0 ? Math.round((oldTarget * (v / oldVoice)) * 100) / 100 : (oldSps.length ? oldTarget / oldSps.length : 0);
      features.push({ name: sp.name, isNew: false, voice: v, prevCost: Math.round((bySp[sp.id] || 0) * 100) / 100, targetCost: t });
    }
    const newBudget = newSps.reduce((s, sp) => s + (Number(newFeatureBudgets?.[sp.name] ?? 0) || 0), 0);
    for (const sp of newSps) features.push({ name: sp.name, isNew: true, voice: 0, prevCost: 0, targetCost: Number(newFeatureBudgets?.[sp.name] ?? 0) || 0 });
    const targetCost = Math.round((oldTarget + newBudget) * 100) / 100;
    // 特性取整差额：并入该领域第一个老特性
    const featSum = features.reduce((s, f) => s + f.targetCost, 0);
    const featDiff = Math.round((targetCost - featSum) * 100) / 100;
    if (Math.abs(featDiff) > 0.001 && features.length) features[0].targetCost = Math.round((features[0].targetCost + featDiff) * 100) / 100;
    const targetRatio = targetTotal > 0 ? targetCost / targetTotal : 0;
    return { name: m, prevCost: Math.round(prevCost * 100) / 100, prevRatio, voice, density: Math.round(density * 100) / 100, targetCost, targetRatio, delta: Math.round((targetCost - prevCost) * 100) / 100, features };
  }).sort((a, b) => b.targetCost - a.targetCost);

  // 对账：Σ 领域目标 vs 目标总成本（取整差额并入最大领域）
  let allocatedSum = Math.round(domains.reduce((s, d) => s + d.targetCost, 0) * 100) / 100;
  let diff = Math.round((targetTotal - allocatedSum) * 100) / 100;
  if (Math.abs(diff) > 0.001 && domains.length) {
    domains[0].targetCost = Math.round((domains[0].targetCost + diff) * 100) / 100;
    domains[0].delta = Math.round((domains[0].targetCost - domains[0].prevCost) * 100) / 100;
    domains[0].targetRatio = targetTotal > 0 ? domains[0].targetCost / targetTotal : 0;
    allocatedSum = Math.round(domains.reduce((s, d) => s + d.targetCost, 0) * 100) / 100;
    diff = 0;
  }
  return { domains, newFeatures, targetTotal, allocatedSum, diff };
}