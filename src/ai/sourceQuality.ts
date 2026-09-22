// 检索来源质量闸门（2026-09-21）
//
// 背景（用户实测）：洞察链路"没有获得有效的信息"。查库核实——检索回来的来源是
//   · 「乐鱼·体育官方网站-领先的数字体育与娱乐技术平台」(leyu-network.com.cn)  ← 赌博站
//   · 驱动之家 blog 索引页（不是文章页）
//   · 《南通市久正人体工学股份有限公司》招股说明书 PDF、《上海龍旗科技股份有限公司》港交所公告 PDF
// 研判模型（本地或云端）拿到这些来源后只能如实写"公开信息不足"——链路本身没错，是**检索结果没把关**。
// 旧代码里 isRelevantSearchResult 只用在"测试搜索连接"上，真正的洞察链路一条都不过滤。
//
// 本模块是纯函数（可测、确定、不依赖模型）：
//   ① 硬剔除垃圾站（赌博/色情/站群 SEO）——这类来源一旦进入证据列表，会污染结论并损害可信度
//   ② 按"物料特征词命中"打分排序——特征词=物料名里去掉通用品类词后的部分（27寸/LCD/OC 而不是"面板"）
//   ③ 一条都没命中时**不返回空**：保留分数最高的少数几条并标记 weak，让模型说实话（"来源未直接提及该物料"），
//      而不是把整条链路推回"未获取可点击公开来源"的硬降级（用户明确反感的"什么都没收集到"）

export interface QualitySource {
  title: string;
  url: string;
  snippet?: string;
  /** 由本模块写入：该来源未直接提及物料名，只能作为背景参考。 */
  weak?: boolean;
  /** 由本模块写入：与物料的特征词命中数（越大越相关）。 */
  relevance?: number;
}

export interface SourceQualityResult<T extends QualitySource> {
  /** 通过闸门、按相关度降序排列的来源（已截断到 limit）。weak/relevance 由闸门写入。 */
  kept: (T & { weak?: boolean; relevance?: number })[];
  /** 被硬剔除的垃圾来源（赌博/站群等），用于审计与提示。 */
  dropped: T[];
  /** 保留但未直接命中物料特征词、只能当背景参考的来源条数。 */
  weak: number;
}

/** 赌博/色情/站群 SEO 等必须硬剔除的域名与标题特征。 */
const JUNK_DOMAIN = /(leyu|leyu[-_]?network|bet\d|casino|gambl|poker|slot|jackpot|porn|xxx|sex\d|188bet|365bet|vns\d|mgm|pgsoft|jdb|ky[-_]?game|tiyu|bocai|caipiao)/i;
const JUNK_TITLE = /(官方网站|官网入口|开户|注册送|首存|返水|博彩|娱乐城|娱乐平台|真人视讯|棋牌|体育赛事竞猜|彩票|投注|下载\s*APP\s*赢|威尼斯人|新葡京|太阳城|银河娱乐)/;

/**
 * 通用品类/业务词——出现在物料名里也不具备区分度。
 * 「27寸 LCD OC面板」真正有信息量的是 27寸 / LCD / OC；只命中"面板"的显示器新闻不算相关。
 */
const GENERIC_TERMS = new Set([
  '面板', '屏幕', '显示', '原材料', '材料', '价格', '报价', '行情', '市场', '趋势', '走势',
  '供应', '供需', '采购', '成本', '物料', '器件', '元件', '模块', '组件', '部件', '零配件', '配件',
  '产品', '商品', '规格', '参数', '型号', '品牌', '厂家', '供应商', '厂商', '最新', '分析', '数据',
  '其他', '通用', '制造', '加工', '包装', '结构', '硬件', '电源', '线材', '电子', '电器', '设备',
  '中国', '国内', '全球', '行业', '产业', '公司', '有限', '股份', '集团', '有限公司',
]);

const fullWidth = (value: string) => value.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');

/** 归一化文本：全角转半角、英寸统一成寸、去空白、统一小写。 */
export function normalizeSourceText(value: string): string {
  return fullWidth(String(value || ''))
    .replace(/英寸/g, '寸')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 把物料名拆成特征词。
 * 强特征词 = 含拉丁字母/数字，或是不在通用词表里的中文词（如「适配器」「支架」）。
 * 只取强特征词做命中判定；全部落空时才退化为整名匹配。
 */
export function materialTerms(materialName: string): string[] {
  const text = normalizeSourceText(materialName);
  const terms = new Set<string>();
  // 拉丁词 / 数字+单位 / 中文词组
  for (const match of text.matchAll(/[a-z][a-z0-9+._-]*|\d+(?:\.\d+)?\s?(?:寸|mm|cm|w|v|a|mah|gb|g|kg|khz|hz|mp|nm|um|k|m)|[\u4e00-\u9fff]{2,}/g)) {
    const token = match[0].trim();
    if (!token) continue;
    if (GENERIC_TERMS.has(token)) continue;
    if (token.length < 2) continue;
    terms.add(token);
  }
  if (terms.size === 0) {
    const fallback = text.trim();
    if (fallback) terms.add(fallback);
  }
  return [...terms];
}

/** 垃圾来源判定（赌博/站群等），导出以便审计与测试。 */
export function isJunkSource(source: QualitySource): boolean {
  const host = String(source.url || '').toLowerCase();
  const title = String(source.title || '');
  return JUNK_DOMAIN.test(host) || JUNK_TITLE.test(title);
}

/** 单条来源与物料特征词的命中得分：每个命中词计 1 分（长词优先不重复计）。 */
export function scoreSource(source: QualitySource, terms: string[]): number {
  const text = normalizeSourceText(`${source.title || ''} ${source.snippet || ''} ${source.url || ''}`);
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += 1;
  return score;
}

/**
 * 来源质量闸门：硬剔垃圾 → 按相关度排序 → 截断。
 * 一条都没命中时保留分数最高的 fallbackLimit 条并标记 weak（不返回空）。
 */
export function gateSources<T extends QualitySource>(
  sources: T[],
  materialName: string,
  options: { limit?: number; fallbackLimit?: number } = {},
): SourceQualityResult<T> {
  const limit = options.limit ?? 8;
  const fallbackLimit = options.fallbackLimit ?? 3;
  const terms = materialTerms(materialName);
  const seen = new Set<string>();
  const scored: { source: T; score: number }[] = [];
  const dropped: T[] = [];
  for (const source of sources || []) {
    if (!source || !source.url || !source.title) continue;
    const key = String(source.url).replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    if (isJunkSource(source)) { dropped.push(source); continue; }
    scored.push({ source, score: scoreSource(source, terms) });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.filter(item => item.score > 0);
  const weakPool = hits.length > 0 ? [] : scored.slice(0, fallbackLimit);
  // 命中为 0、但确实取回了来源：保留最高分的少量来源并标注弱相关（让模型能说清"来源未提及该物料"）
  const useWeak = hits.length === 0;
  const chosen = (hits.length > 0 ? hits : weakPool).slice(0, limit);
  const kept = chosen.map(({ source, score }) => ({
    ...source,
    relevance: score,
    ...(useWeak ? { weak: true } : {}),
  }));
  return { kept, dropped, weak: useWeak ? kept.length : 0 };
}

/** 给用户/模型看的一句话说明（来源质量）。 */
export function describeSourceQuality(result: SourceQualityResult<QualitySource>, terms?: string[]): string {
  const parts: string[] = [];
  if (result.weak > 0) {
    parts.push(`取回 ${result.kept.length} 条来源均未直接提及该物料${terms && terms.length ? `（特征词：${terms.join('/')}）` : ''}，已标注"弱相关·仅背景参考"`);
  }
  if (result.dropped.length > 0) parts.push(`已剔除 ${result.dropped.length} 条无关/垃圾来源`);
  return parts.join('；');
}
