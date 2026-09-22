// 云端发送前的纯函数审计：保持独立，避免安全闸门加载完整行情服务。
export const SENSITIVE_PATTERNS: { re: RegExp; desc: string }[] = [
  { re: /[¥￥]\s*\d+(?:\.\d+)?/, desc: '金额（¥/￥）' },
  { re: /\b\d+(?:\.\d+)?\s*(?:元|块钱)\b/, desc: '金额（元）' },
  { re: /\b\d+(?:\.\d+)?\s*(?:-|~|至|到)\s*\d+(?:\.\d+)?(?!(?:\s*(?:月|年|周|天|日|小时)))/, desc: '价格区间' },
  { re: /(?:成本|单价|采购价|报价|价格)\s*[:：]?\s*\d/, desc: '成本类数字' },
  { re: /(?:供应商|份额|占比|项目代号|项目名)\s*[:：]?\s*\S/, desc: '供应商/项目信息' },
  { re: /[\u4e00-\u9fa5]{2,6}(?:科技|电子|半导体|光电|精密|股份|集团|实业|能源|光学|有限(?:公司)?|公司)/, desc: '公司/厂家名称' },
];

export interface AuditResult { safe: boolean; matches: { pattern: string; sample: string }[]; }

export interface SensitiveRange {
  start: number;
  end: number;
  sample: string;
  pattern: string;
}

export function auditSensitive(text: string): AuditResult {
  const matches: { pattern: string; sample: string }[] = [];
  for (const p of SENSITIVE_PATTERNS) {
    const m = text.match(p.re);
    if (m) matches.push({ pattern: p.desc, sample: m[0].slice(0, 40) });
  }
  return { safe: matches.length === 0, matches };
}

// 型号与规格可反查料号/供应商，也属于不可外传的敏感信息。
export function auditPromptStrict(text: string): AuditResult {
  const base = auditSensitive(text);
  if (!base.safe) return base;
  const extra = [
    { re: /\b[A-Z]{1,6}[0-9][A-Z0-9\-]{2,}\b/, desc: '器件型号' },
    { re: /\d+\s*(?:寸|英寸|mm|MHz|GHz|Hz|nm)\b/, desc: '规格参数' },
  ];
  for (const p of extra) {
    const m = text.match(p.re);
    if (m) { base.safe = false; base.matches.push({ pattern: p.desc, sample: m[0].slice(0, 40) }); }
  }
  return base;
}

/** Return exact local-only ranges for UI highlighting; React renders the text, never HTML. */
export function findSensitiveRanges(text: string): SensitiveRange[] {
  const patterns = [
    ...SENSITIVE_PATTERNS,
    { re: /\b[A-Z]{1,6}[0-9][A-Z0-9\-]{2,}\b/, desc: '器件型号' },
    { re: /\d+\s*(?:寸|英寸|mm|MHz|GHz|Hz|nm)\b/, desc: '规格参数' },
  ];
  const ranges: SensitiveRange[] = [];
  for (const pattern of patterns) {
    const flags = pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`;
    const matcher = new RegExp(pattern.re.source, flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text))) {
      const sample = match[0] || '';
      if (sample) ranges.push({ start: match.index, end: match.index + sample.length, sample, pattern: pattern.desc });
      if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
    }
  }
  const merged: SensitiveRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      last.sample = text.slice(last.start, last.end);
      last.pattern = [...new Set(`${last.pattern}/${range.pattern}`.split('/'))].join('/');
    } else merged.push({ ...range });
  }
  return merged;
}

export function validateCloudQueryArgs(args: any): { ok: boolean; reason?: string; clean?: { material: string; category: string; question: string } } {
  if (!args || typeof args !== 'object') return { ok: false, reason: '工具参数格式错误' };
  const material = String(args.material || args.material_name || '').trim().slice(0, 100);
  const category = String(args.category || '').trim().slice(0, 50);
  const question = String(args.question || '').trim().slice(0, 200);
  if (!material) return { ok: false, reason: '缺少物料名称（请使用物料通用名）' };
  if (!question) return { ok: false, reason: '缺少查询问题' };
  const audit = auditPromptStrict('物料名称：' + material + '\n品类：' + category + '\n查询问题：' + question);
  if (/\b[A-Z]{1,3}\d{1,2}\b/.test(material + ' ' + question)) {
    return { ok: false, reason: '参数疑似含项目/产品短码（如 P1/M270）——请使用物料通用名，不含任何编号' };
  }
  if (!audit.safe) {
    return { ok: false, reason: '参数含敏感信息（' + audit.matches.map(m => m.pattern + ':' + m.sample).join('、') + '）——请只用物料通用名，不含型号/金额/供应商/项目信息' };
  }
  return { ok: true, clean: { material, category, question } };
}

/** 模型原生联网搜索：允许公开型号/规格数字，但继续拦截金额、供应商、项目、BOM 等本地业务信息。 */
export function validateNativeSearchArgs(args: any): { ok: boolean; reason?: string; clean?: { material: string; category: string; question: string } } {
  if (!args || typeof args !== 'object') return { ok: false, reason: '工具参数格式错误' };
  const material = String(args.material || args.material_name || '').trim().slice(0, 100);
  const category = String(args.category || '').trim().slice(0, 50);
  const question = String(args.question || '').trim().slice(0, 200);
  if (!material) return { ok: false, reason: '缺少物料名称' };
  if (!question) return { ok: false, reason: '缺少查询问题' };
  const audit = auditSensitive('物料名称：' + material + '\n品类：' + category + '\n查询问题：' + question);
  if (!audit.safe) {
    return { ok: false, reason: '参数含本地业务信息（' + audit.matches.map(m => m.pattern + ':' + m.sample).join('、') + '）——模型原生搜索也不能外发金额、供应商、项目、BOM 等信息' };
  }
  if (/项目代号|项目名|BOM|料号|客户|内部成本|目标成本|采购|合同|订单|供应商/i.test(material + category + question)) {
    return { ok: false, reason: '参数含项目/供应商/BOM/采购等本地业务字段，不能外发' };
  }
  return { ok: true, clean: { material, category, question } };
}

/** 受控公开型号查询：允许型号数字，但仍只允许公开字段和公开问题，不能复用普通主题闸门。 */
export function validatePublicModelQueryArgs(args: any): { ok: boolean; reason?: string; clean?: { material: string; category: string; question: string } } {
  if (!args || typeof args !== 'object') return { ok: false, reason: '工具参数格式错误' };
  const material = String(args.material || args.material_name || '').trim().slice(0, 100);
  const category = String(args.category || '').trim().slice(0, 50);
  const question = String(args.question || '').trim().slice(0, 200);
  if (!material || !question || category !== '公开型号') return { ok: false, reason: '公开型号查询必须使用“公开型号”品类' };
  const audit = auditSensitive('公开型号：' + material + '\n查询问题：' + question);
  if (!audit.safe || /项目|供应商|公司|成本|采购|报价|金额|内部|BOM|客户/i.test(material + question)) {
    return { ok: false, reason: '公开型号查询只允许公开型号与公开规格问题' };
  }
  return { ok: true, clean: { material, category, question } };
}
