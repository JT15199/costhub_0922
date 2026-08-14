// 规格级项目预估（v2.3.19）：新项目按规格匹配最像的历史项目，估算成本 + 差异依据
// 四维规格相似度：尺寸 40% + 分辨率 30% + 刷新率 20% + 面板类型 10%

export interface SpecInput {
  screen_size?: string;    // "27英寸" / "27\"" / "23.8\""
  resolution?: string;     // "2560×1440 (QHD)" / "1920×1080"
  refresh_rate?: string;   // "144Hz" / "165Hz"
  panel_type?: string;     // "IPS" / "VA"
}

export interface HistoricProject extends SpecInput {
  id: number;
  code: string;
  name?: string;
  bomCost: number;         // 实际 BOM 成本（用于估算）
}

export interface EstimateCandidate {
  project: HistoricProject;
  similarity: number;      // 0-100
}

export interface EstimateResult {
  candidates: EstimateCandidate[];  // 按相似度降序
  estimate: number;                 // 相似度加权估算成本
  matchedCount: number;             // 参与估算的项目数
}

// ===== 规格解析 =====
export function parseScreenSize(s: string): number {
  if (!s) return 0;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

export function parseResolution(r: string): number {
  if (!r) return 0;
  const m = String(r).match(/(\d+)\s*[×xX*]\s*(\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * parseInt(m[2]);
}

export function parseRefreshRate(r: string): number {
  if (!r) return 0;
  const m = String(r).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// ===== 四维相似度 =====
export function specSimilarity(a: SpecInput, b: SpecInput): number {
  // 尺寸：差值 ≤0.5 英寸满分，每多 1 英寸扣 25 分
  const sa = parseScreenSize(a.screen_size || '');
  const sb = parseScreenSize(b.screen_size || '');
  let sizeScore = 0;
  if (sa > 0 && sb > 0) {
    const d = Math.abs(sa - sb);
    sizeScore = d <= 0.5 ? 100 : Math.max(0, 100 - (d - 0.5) * 25);
  } else sizeScore = 50; // 未知规格给中间分

  // 分辨率：像素总量比值（log2 差越小越好）
  const ra = parseResolution(a.resolution || '');
  const rb = parseResolution(b.resolution || '');
  let resScore = 0;
  if (ra > 0 && rb > 0) {
    const ratio = Math.max(ra, rb) / Math.min(ra, rb);
    resScore = ratio <= 1.05 ? 100 : Math.max(0, 100 - Math.log2(ratio) * 40);
  } else resScore = 50;

  // 刷新率：差 ≤10Hz 满分，每多 10Hz 扣 20 分
  const fa = parseRefreshRate(a.refresh_rate || '');
  const fb = parseRefreshRate(b.refresh_rate || '');
  let hzScore = 0;
  if (fa > 0 && fb > 0) {
    const d = Math.abs(fa - fb);
    hzScore = d <= 10 ? 100 : Math.max(0, 100 - (d - 10) * 2);
  } else hzScore = 50;

  // 面板类型：相同 100，不同 50，未知 50
  const pa = (a.panel_type || '').trim().toUpperCase();
  const pb = (b.panel_type || '').trim().toUpperCase();
  const panelScore = pa && pb ? (pa === pb ? 100 : 50) : 50;

  return Math.round(sizeScore * 0.4 + resScore * 0.3 + hzScore * 0.2 + panelScore * 0.1);
}

// ===== 估算 =====
export function estimateProjectCost(specs: SpecInput, history: HistoricProject[], topN = 3): EstimateResult {
  const candidates = history
    .map(p => ({ project: p, similarity: specSimilarity(specs, p) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
  const usable = candidates.filter(c => c.similarity > 0 && c.project.bomCost > 0);
  const totalW = usable.reduce((s, c) => s + c.similarity, 0);
  const estimate = totalW > 0
    ? usable.reduce((s, c) => s + c.similarity * c.project.bomCost, 0) / totalW
    : (candidates[0]?.project.bomCost || 0);
  return { candidates, estimate: Math.round(estimate * 100) / 100, matchedCount: usable.length };
}
