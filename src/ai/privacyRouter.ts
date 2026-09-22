import { auditPromptStrict } from './security';
import type { ContextMetadata } from './contextMetadata';

export type PrivacyClassification = 'public' | 'sensitive' | 'unknown';
export type PrivacyCandidateRoute = 'local' | 'cloud_candidate';

export interface PrivacyClassifierInput {
  text: string;
  sourceTypes: string[];
  metadata: ContextMetadata[];
}

export interface PrivacyClassifierResult {
  classification: PrivacyClassification;
  reasonCode: string;
}

export type LocalPrivacyClassifier = (input: PrivacyClassifierInput) => PrivacyClassifierResult;

const CONFIDENTIALITY_SIGNAL_PATTERNS: RegExp[] = [
  /保密|机密|内部使用|内部资料|未公开|尚未公开|未发布|尚未发布|未上市|上市前|不得外传|禁止外传|请勿(?:对外|外传|透露|泄露)|不要(?:对外|外传|透露|泄露)/iu,
  /\b(?:confidential|private|internal[- ]only|not[- ]for[- ]release|unreleased|pre[- ]launch|do not disclose|do not share)\b/iu,
];

function hasConfidentialitySignal(text: string) {
  return CONFIDENTIALITY_SIGNAL_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * 内容级隐私分类器（2026-09-21 新增，取代"来源标签即结论"的写法）。
 *
 * 背景（用户实测）：默认对话路径的 classification 恒为 'sensitive'——因为 piRuntime 固定传
 * `sourceTypes: ['private_workspace']`，evaluatePrivacy 在来源策略那一步就返回了，正则与分类器**根本没跑**，
 * 面板上"一步步筛查"因此没有任何真实判断。用户的原话："我怀疑是写死的使用本地模型，并没有真实判断。"
 *
 * 现在的判定顺序（全部**基于内容**，且仍然 fail-closed——只有 public 才可能上云）：
 *   ① 保密声明（"内部资料/不得外传"等）      → unknown（不放行）
 *   ② 本地业务标识（金额+成本词 / 项目代号 / 料号 / 供应商 / 路径 / 密钥）→ sensitive，并**列出命中的具体项**
 *   ③ 全部元数据都被用户核验为公开           → public（唯一能上云的分支）
 *   ④ 内容里确实没有任何本地线索             → unknown + reasonCode=content_no_local_signal
 * 也就是说：classification 与 reasonCode 会随内容变化，不再是与输入无关的常量。
 */
export const contentPrivacyClassifier: LocalPrivacyClassifier = ({ text, sourceTypes, metadata }) => {
  const value = String(text || '');
  if (hasConfidentialitySignal(value)) {
    return { classification: 'unknown', reasonCode: 'classifier_confidentiality_signal' };
  }
  const localSignals = detectLocalBusinessSignals(value);
  if (localSignals.length > 0) {
    return { classification: 'sensitive', reasonCode: `classifier_local_signals:${localSignals.slice(0, 4).join('+')}` };
  }
  const allVerifiedPublicMetadata = metadata.length > 0 && metadata.every(item => item.sensitivity === 'public' && item.cloudSafe && item.verified === true);
  if (allVerifiedPublicMetadata) {
    return { classification: 'public', reasonCode: 'classifier_verified_public_metadata' };
  }
  return {
    classification: 'unknown',
    reasonCode: sourceTypes.length ? 'classifier_unverified_public_source' : 'content_no_local_signal',
  };
};

/**
 * 检测文本里的本地业务线索（纯规则、可解释、可测）。
 * 返回命中的规则名数组，供 UI 逐条展示"到底命中了什么"——这是"真实判断"与"写死结论"的区别所在。
 */
export function detectLocalBusinessSignals(text: string): string[] {
  const value = String(text || '');
  const hits: string[] = [];
  if (/[¥￥]\s*\d+(?:\.\d+)?/.test(value)) hits.push('金额（¥）');
  if (/\d+(?:\.\d+)?\s*(?:元|万元|亿元)/.test(value)) hits.push('金额（元）');
  if (/(?:成本|单价|采购价|报价|毛利|利润|底价)\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?/.test(value)) hits.push('成本类数字');
  if (/\b[A-Z]{1,3}[-_]?\d{2,3}\b/.test(value)) hits.push('项目/产品短码');
  if (/(?:项目代号|项目编号|料号|物料编码|成本基线|内部成本|目标成本|BOM)/i.test(value)) hits.push('内部业务字段');
  if (/[\u4e00-\u9fa5]{2,6}(?:科技|电子|半导体|光电|精密|股份|集团|实业|光学|模具|塑胶|五金|有限公司|公司|厂)/.test(value)) hits.push('公司/厂家名称');
  if (/(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\)/.test(value)) hits.push('本地路径');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) hits.push('私钥');
  if (/\bapi[-_ ]?key\s*[:=]\s*\S+/i.test(value)) hits.push('API Key');
  if (/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)) hits.push('Bearer Token');
  if (/(?:\+?86[- ]?)?1[3-9]\d{9}\b/.test(value)) hits.push('手机号');
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) hits.push('邮箱');
  return hits;
}

/**
 * Conservative built-in classifier: source labels alone are never proof of
 * public content. Verified metadata may produce PUBLIC only when local rules
 * find no confidentiality signal; everything else stays UNKNOWN.
 * 保留为兼容入口（既有测试与调用方引用），行为与 contentPrivacyClassifier 的内容侧一致。
 */
export const defaultLocalPrivacyClassifier: LocalPrivacyClassifier = contentPrivacyClassifier;

/** Local-only classifier used after the user reviews the exact public projection. */
export const reviewedPublicClassifier: LocalPrivacyClassifier = ({ text, metadata }) => {
  if (!metadata.length || !metadata.every(item => item.sensitivity === 'public' && item.cloudSafe && item.verified === true)) {
    return { classification: 'unknown', reasonCode: 'classifier_unverified_public_source' };
  }
  return hasConfidentialitySignal(text)
    ? { classification: 'unknown', reasonCode: 'classifier_confidentiality_signal' }
    : { classification: 'public', reasonCode: 'classifier_reviewed_public_content' };
};

export interface PrivacyEvaluationInput {
  text: string;
  sourceTypes?: string[];
  metadata?: ContextMetadata[];
  classifier?: LocalPrivacyClassifier;
}

export interface PrivacyDecision {
  classification: PrivacyClassification;
  candidateRoute: PrivacyCandidateRoute;
  cloudSafe: boolean;
  reasonCode: string;
  sourceTypes: string[];
  regexMatches: string[];
  classifierUsed: boolean;
}

export const SENSITIVE_SOURCE_TYPES = [
  'supplier_quote',
  'supplier_negotiation',
  'bom_database',
  'target_cost',
  'cost_baseline',
  'historical_price',
  'project_database',
  'procurement_data',
  'commercial_strategy',
  'internal_financial_data',
  'local_file',
  'private_workspace',
] as const;

const sensitiveSourceTypes = new Set<string>(SENSITIVE_SOURCE_TYPES);

const REGEX_GUARD_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'api_key', re: /\bapi[-_ ]?key\s*[:=]\s*\S+/i },
  { code: 'bearer_token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { code: 'password', re: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i },
  { code: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: 'phone', re: /(?:\+?86[- ]?)?1[3-9]\d{9}\b/ },
  { code: 'local_path', re: /(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\|\/(?:Users|home|private|var|tmp)\/)/ },
  { code: 'business_sensitive_term', re: /供应商|报价|成本|目标成本|底价|BOM|料号|项目编号|成本基线|议价|历史最低价|内部敏感词/iu },
];

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function finish(classification: PrivacyClassification, reasonCode: string, sourceTypes: string[], regexMatches: string[] = [], classifierUsed = false): PrivacyDecision {
  const cloudSafe = classification === 'public';
  return {
    classification,
    candidateRoute: cloudSafe ? 'cloud_candidate' : 'local',
    cloudSafe,
    reasonCode,
    sourceTypes,
    regexMatches,
    classifierUsed,
  };
}

function metadataClassification(metadata: ContextMetadata[]): PrivacyClassification | undefined {
  if (metadata.some(item => item.sensitivity === 'internal' || item.sensitivity === 'sensitive' || item.sensitivity === 'restricted' || item.cloudSafe === false)) return 'sensitive';
  if (metadata.some(item => item.sensitivity === 'unknown')) return 'unknown';
  return undefined;
}

function guardMatches(text: string) {
  const matches = auditPromptStrict(text).matches.map(match => `legacy:${match.pattern}`);
  for (const pattern of REGEX_GUARD_PATTERNS) if (pattern.re.test(text)) matches.push(pattern.code);
  return unique(matches);
}

/** Fail-closed privacy decision; the classifier seam remains local-only. */
export function evaluatePrivacy(input: PrivacyEvaluationInput): PrivacyDecision {
  const sourceTypes = unique((Array.isArray(input.sourceTypes) ? input.sourceTypes : []).map(value => String(value).trim().toLocaleLowerCase()));
  const metadata = (Array.isArray(input.metadata) ? input.metadata : []).filter(item => Boolean(item && typeof item === 'object'));
  const text = String(input.text || '');
  // ⚠️ 2026-09-21：正则闸门现在**总是执行**，不再因为"来源标签敏感"就被跳过。
  // 旧行为导致 regexMatches 恒为 []，面板只能显示"未发现规则命中"——而其实检查根本没跑，那是不实陈述。
  // 来源策略仍然最先决定 classification（fail-closed 不变），但用户现在能看到真实命中项。
  const matches = guardMatches(text);
  const sourceSensitive = sourceTypes.find(source => sensitiveSourceTypes.has(source));
  if (sourceSensitive) return finish('sensitive', `source_policy:${sourceSensitive}`, sourceTypes, matches);

  const metadataResult = metadataClassification(metadata);
  if (metadataResult) return finish(metadataResult, metadataResult === 'sensitive' ? 'metadata_not_cloud_safe' : 'metadata_unknown', sourceTypes, matches);

  if (matches.length) return finish('sensitive', 'regex_guard', sourceTypes, matches);

  const classifier = input.classifier || contentPrivacyClassifier;
  try {
    const result = classifier({ text, sourceTypes, metadata });
    if (!result || !['public', 'sensitive', 'unknown'].includes(result.classification)) {
      return finish('unknown', 'classifier_invalid_result', sourceTypes, [], true);
    }
    return finish(result.classification, result.reasonCode || `classifier_${result.classification}`, sourceTypes, matches, true);
  } catch {
    return finish('unknown', 'classifier_error', sourceTypes, [], true);
  }
}

/**
 * 从真实消息列表推导"来源标签"，取代硬编码的 `['private_workspace']`。
 * 只有**确实出现了本地库数据或工具结果**时才标 private_workspace；纯系统提示 + 用户提问不标，
 * 这样内容级正则与分类器才有机会真正执行（否则永远在来源策略那一步短路）。
 */
export function deriveContextSourceTypes(messages: unknown[]): string[] {
  const types = new Set<string>(['user_message']);
  for (const raw of messages || []) {
    const message = raw as any;
    const role = String(message?.role || '');
    if (role === 'toolResult' || role === 'tool') { types.add('private_workspace'); continue; }
    if (role !== 'user' && role !== 'system') continue;
    const text = Array.isArray(message?.content)
      ? message.content.map((part: any) => String(part?.text || '')).join('\n')
      : String(message?.content || '');
    // 工作状态注入与本地工具回填都带这些标题；出现即说明上下文里有本地库数据。
    // （标题与 contextBuilder.projectWorkingState / 各本地提示词保持一致，改标题时要同步这里）
    if (/【CostHub 结构化工作状态】|【工作状态|【本机内部事实|【长期记忆|【用户目标|本机内部数据/.test(text)) types.add('private_workspace');
  }
  return [...types];
}
