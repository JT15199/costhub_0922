// 本地模型自动选择（2026-09-21）
//
// 背景：`local_ai_model` 为空时，原先 detectOllama() 直接判 'no-model' 并**不联网探测**，
// 于是所有"本地优先"的链路（洞察研判、规范化、原声分析…）静默回落到云端。
// 实测：用户在设置里改过 Base URL 后模型选择被清空（LocalBackendSettings 的 baseUrl onChange 会 save('local_ai_model','')），
// 服务明明在线却一直报"未选择本地模型"，洞察的 [研判] 也一直在云端做。
//
// 这里给一个纯函数：从服务端返回的模型列表里挑一个可用的对话模型。
// 判定顺序完全确定（不依赖模型智能）：先排除非对话模型，再按偏好关键词，再比参数规模。

/** 嵌入/重排/语音/翻译等非对话模型，不能用来做研判。 */
const NON_CHAT = /(embed|embedding|bge[-_:]|gte[-_:]|rerank|whisper|tts|speech|clip[-_:]|stable-diffusion|flux|sdxl|ocr)/i;

/** 对话模型偏好（越靠前越优先）；命中即按该档排序。 */
const PREFERRED = [
  'qwen3', 'qwen2.5', 'qwen2', 'qwythos', 'deepseek', 'glm',
  'llama3.3', 'llama3.2', 'llama3.1', 'llama3', 'llama',
  'gemma3', 'gemma2', 'gemma', 'mistral', 'minicpm', 'phi4', 'phi3', 'phi', 'yi',
];

/** 从 `qwen3:27b` / `deepseek-r1:14b` 这类标签里取参数规模（单位 B）。取不到返回 0。 */
export function modelSizeB(name: string): number {
  const match = String(name || '').toLowerCase().match(/(?:^|[-_:.])(\d+(?:\.\d+)?)\s*b(?:\b|$)/);
  if (match) return Number(match[1]) || 0;
  const moe = String(name || '').toLowerCase().match(/(\d+)x(\d+(?:\.\d+)?)b/);
  if (moe) return (Number(moe[1]) || 1) * (Number(moe[2]) || 0);
  return 0;
}

function preferenceRank(name: string): number {
  const lower = String(name || '').toLowerCase();
  const index = PREFERRED.findIndex(key => lower.includes(key));
  return index < 0 ? PREFERRED.length : index;
}

/**
 * 从可用模型里挑一个最适合做本地研判的模型。
 * 规则：排除非对话模型 → 参数规模大的优先（研判质量主要看模型大小）→ 同规模按偏好关键词 → 再按名字短的（主模型优先于量化变体）。
 * 全部被排除时退回列表第一项，绝不返回空（有模型就该能用）。
 */
export function pickLocalModel(models: string[]): string {
  const list = (models || []).map(name => String(name || '').trim()).filter(Boolean);
  if (list.length === 0) return '';
  const chat = list.filter(name => !NON_CHAT.test(name));
  const pool = chat.length > 0 ? chat : list;
  const best = [...pool].sort((a, b) => {
    const size = modelSizeB(b) - modelSizeB(a);
    if (size !== 0) return size;
    const rank = preferenceRank(a) - preferenceRank(b);
    if (rank !== 0) return rank;
    return a.length - b.length;
  });
  return best[0];
}
