// 云端查询脱敏评审（纯函数，2026-09-21）
// 背景：旧闸门只有"通过 / 不通过"两态——不通过时直接抛错，用户看不到到底哪条规则命中、也没法处理，
// 只能反复重来（用户反馈："不同意的能标出来哪里有问题，如果工具自己觉得怎么都敏感，那他就自己换个名称给我，
// 或者经过我的同意也能审批下去，我永远是有最高权限"）。
// 本模块把"不通过"拆成两级：
//   ① hard（业务机密：金额/成本、供应商与公司名、项目代号与内部字段、BOM/料号/客户/订单）
//      —— 任何情况都不外发（这是 CLAUDE.md 的成本数据红线），只能改用建议的通用名后再发；
//   ② soft（公开可查、但可能带内部线索：器件型号、规格数字、疑似编号短码）
//      —— 用户可以看清命中内容后强制批准（最高权限在本机、且只涉及三个白名单字段）。
// 同时提供 suggestSafeQuery：工具自己给出"换个名字"的替代方案，用户一键采用。

export type QueryRiskLevel = 'soft' | 'hard';

export interface QueryRiskItem {
  level: QueryRiskLevel;
  field: 'material' | 'category' | 'question';
  rule: string;
  sample: string;
  advice: string;
}

export interface QueryReview {
  /** 没有任何命中：可以直接进入审批 */
  ok: boolean;
  items: QueryRiskItem[];
  hardCount: number;
  softCount: number;
  /** 一句话结论，直接给用户看 */
  verdict: string;
}

export interface SafeQuerySuggestion {
  material: string;
  category: string;
  question: string;
  changes: string[];
}

type FieldName = 'material' | 'category' | 'question';

interface Rule {
  level: QueryRiskLevel;
  field?: FieldName;
  re: RegExp;
  rule: string;
  advice: string;
}

/** 硬规则：命中即不可外发（金额/成本、供应商公司、项目与内部业务字段）。 */
const HARD_RULES: Rule[] = [
  { level: 'hard', re: /[¥￥]\s*\d+(?:\.\d+)?/g, rule: '金额（¥/￥）', advice: '去掉金额，只保留物料通用名' },
  { level: 'hard', re: /\d+(?:\.\d+)?\s*(?:元|块钱|万元|亿元)/g, rule: '金额（元）', advice: '去掉金额，只保留物料通用名' },
  { level: 'hard', re: /(?:成本|单价|采购价|报价|价格|毛利|利润)\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?/g, rule: '成本类数字', advice: '成本数字属于本地数据，不能外发' },
  { level: 'hard', re: /[\u4e00-\u9fa5]{2,6}(?:科技|电子|半导体|光电|精密|股份|集团|实业|能源|光学|材料|模具|塑胶|五金|有限(?:公司)?|公司|厂)/g, rule: '公司/厂家名称', advice: '去掉公司名，改用物料通用名' },
  { level: 'hard', re: /(?:项目代号|项目名|项目编号|料号|物料编码|BOM|客户|内部成本|目标成本|采购合同|订单号|供应商)/g, rule: '项目/内部业务字段', advice: '本地业务字段不能外发' },
  // 只把"字母 + 2~3 位数字"当项目短码（M270/A002）；一位数字的（USB3/BT5）是公开标准词，不误判。
  { level: 'hard', re: /\b[A-Z]{1,3}[-_]?\d{2,3}\b/g, rule: '项目/产品短码（如 M270、A002）', advice: '去掉项目短码，只保留物料通用名' },
];

/** 软规则：公开信息，但可能带内部线索；用户可核对后强制批准。 */
const SOFT_RULES: Rule[] = [
  { level: 'soft', re: /\b[A-Z]{1,6}\d[A-Z0-9\-_.]{1,}\b/g, rule: '器件型号/料号形态', advice: '型号公开可查，但会暴露选型；可强制发送或改用通用名' },
  { level: 'soft', re: /\d+(?:\.\d+)?\s*(?:寸|英寸|吋)/g, rule: '规格参数（尺寸）', advice: '规格数字可公开查询，确认后再发' },
  { level: 'soft', re: /\d+(?:\.\d+)?\s*(?:mm|cm|MHz|GHz|KHz|Hz|nm|um|μm)/gi, rule: '规格参数（物理/频率）', advice: '规格数字可公开查询，确认后再发' },
  { level: 'soft', re: /\d+(?:\.\d+)?\s*(?:GB|TB|MB|KB|mAh|Wh|W|V|A|mA|dpi|ppi|fps|nit|nits)\b/gi, rule: '规格参数（容量/电气）', advice: '规格数字可公开查询，确认后再发' },
  // 时间区间（1-3 月 / 1-3 年）是公开口径，不算数字区间；只有价格形态的区间才提示。
  { level: 'soft', re: /\d+(?:\.\d+)?\s*(?:-|~|至|到)\s*\d+(?:\.\d+)?(?!\s*(?:月|年|周|天|日|小时|个|季度))/g, rule: '数字区间', advice: '区间数字可能被当地成本数据，确认后再发' },
];

function collect(text: string, rules: Rule[], field: FieldName): QueryRiskItem[] {
  const items: QueryRiskItem[] = [];
  for (const rule of rules) {
    const matcher = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text))) {
      const sample = String(match[0] || '').trim();
      if (sample) items.push({ level: rule.level, field, rule: rule.rule, sample: sample.slice(0, 40), advice: rule.advice });
      if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
    }
  }
  return items;
}

function dedupe(items: QueryRiskItem[]): QueryRiskItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.level}|${item.field}|${item.rule}|${item.sample}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 评审一次云端查询（只看允许外发的三个字段）。
 * allowModel=true 时（模型原生搜索/公开型号查询）型号与规格不再算命中，其余硬规则不变。
 */
export function reviewQuery(input: { material?: string; category?: string; question?: string }, options: { allowModel?: boolean } = {}): QueryReview {
  const fields: Array<[FieldName, string]> = [
    ['material', String(input.material || '')],
    ['category', String(input.category || '')],
    ['question', String(input.question || '')],
  ];
  const softRules = options.allowModel ? SOFT_RULES.filter(rule => rule.rule.includes('数字区间')) : SOFT_RULES;
  const items = dedupe(fields.flatMap(([field, text]) => collect(text, [...HARD_RULES, ...softRules], field)));
  const hardCount = items.filter(item => item.level === 'hard').length;
  const softCount = items.filter(item => item.level === 'soft').length;
  const verdict = hardCount
    ? `不可外发：命中 ${hardCount} 处本地业务信息（${[...new Set(items.filter(i => i.level === 'hard').map(i => i.rule))].join('、')}）`
    : softCount
      ? `可发送但需确认：命中 ${softCount} 处公开可查但敏感的内容（${[...new Set(items.map(i => i.rule))].join('、')}）`
      : '未命中任何敏感规则，可以直接审批';
  return { ok: items.length === 0, items, hardCount, softCount, verdict };
}

const PUBLIC_QUESTION = '近 1-3 月公开市场价格趋势';
const GENERIC_MATERIAL = '电子物料';

const HARD_STRIPPERS: RegExp[] = [
  /[¥￥]\s*\d+(?:\.\d+)?/g,
  /\d+(?:\.\d+)?\s*(?:元|块钱|万元|亿元)/g,
  /(?:成本|单价|采购价|报价|价格|毛利|利润)\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?/g,
  /[\u4e00-\u9fa5]{2,6}(?:科技|电子|半导体|光电|精密|股份|集团|实业|能源|光学|材料|模具|塑胶|五金|有限(?:公司)?|公司|厂)/g,
  /\b[A-Z]{1,3}[-_]?\d{2,3}\b/g,
];

const SOFT_STRIPPERS: RegExp[] = [
  /\b[A-Z]{1,6}\d[A-Z0-9\-_.]{1,}\b/g,
  /\d+(?:\.\d+)?\s*(?:寸|英寸|吋|mm|cm|MHz|GHz|KHz|Hz|nm|um|μm)/gi,
  /\d+(?:\.\d+)?\s*(?:GB|TB|MB|KB|mAh|Wh|W|V|A|mA|dpi|ppi|fps|nit|nits)\b/gi,
  /\d+(?:\.\d+)?\s*(?:-|~|至|到)\s*\d+(?:\.\d+)?(?!\s*(?:月|年|周|天|日|小时|个|季度))/g,
];

function normalizeText(text: string): string {
  return text
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/[，,、；;：:]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-_/·.]+|[\s\-_/·.]+$/g, '')
    .trim();
}

/**
 * 给出"换个名字"的脱敏替代方案：去掉机密片段与型号规格，必要时退回品类通用名。
 * 返回值里的 changes 直接展示给用户看改了什么。
 */
export function suggestSafeQuery(input: { material?: string; category?: string; question?: string }): SafeQuerySuggestion {
  const changes: string[] = [];
  const rawMaterial = String(input.material || '').trim();
  const rawCategory = String(input.category || '').trim();
  const rawQuestion = String(input.question || '').trim();

  const collectSamples = (text: string, rules: RegExp[]): string[] => {
    const found: string[] = [];
    for (const rule of rules) {
      const matcher = new RegExp(rule.source, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(text))) {
        const sample = String(match[0] || '').trim();
        if (sample && !found.includes(sample)) found.push(sample);
        if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
      }
    }
    return found;
  };

  const strip = (text: string, rules: RegExp[]): string => rules.reduce((acc, rule) => acc.replace(new RegExp(rule.source, rule.flags), ' '), text);

  const hardHits = collectSamples(`${rawMaterial} ${rawCategory}`, HARD_STRIPPERS);
  const softHits = collectSamples(`${rawMaterial} ${rawCategory}`, SOFT_STRIPPERS);
  let material = normalizeText(strip(strip(rawMaterial, HARD_STRIPPERS), SOFT_STRIPPERS));
  const category = normalizeText(strip(rawCategory, HARD_STRIPPERS));

  if (hardHits.length) changes.push(`去掉本地业务信息「${hardHits.slice(0, 3).join('、')}」`);
  if (softHits.length) changes.push(`去掉型号/规格「${softHits.slice(0, 3).join('、')}」`);

  if (material.replace(/[^\u4e00-\u9fa5A-Za-z]/g, '').length < 2) {
    const categoryUsable = category && reviewQuery({ material: category, category: '', question: '' }).ok;
    material = categoryUsable ? category : GENERIC_MATERIAL;
    changes.push(`物料名退回通用词「${material}」`);
  }

  const question = rawQuestion && reviewQuery({ material: '', category: '', question: rawQuestion }).ok
    ? rawQuestion
    : PUBLIC_QUESTION;
  if (question !== rawQuestion) changes.push('查询问题换成公开口径（不含本地数字）');

  return {
    material,
    category,
    question,
    changes: changes.length ? changes : ['无需修改，当前内容只含公开信息'],
  };
}

/** 是否允许"我知道风险，仍然发送"：只有软命中才给这个按钮；硬命中必须先改名。 */
export function canForceSend(review: QueryReview): boolean {
  return review.hardCount === 0 && review.softCount > 0;
}
