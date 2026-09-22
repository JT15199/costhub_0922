import { expect, it, describe } from 'vitest';
import { gateSources, isJunkSource, materialTerms, normalizeSourceText, scoreSource, describeSourceQuality } from '../ai/sourceQuality';
import { buildPublicSearchQuery, gatewayExpectedQuery, normalizePublicQuery, PUBLIC_PRICE_QUERY_QUESTION, PUBLIC_MODEL_QUERY_QUESTION } from '../ai/searchQuery';
import { validateCloudQueryArgs, validateNativeSearchArgs } from '../ai/security';
import { pickLocalModel, modelSizeB } from '../ai/localModelPick';
import { buildCompactionInstruction, extractCheckpoint, frameCheckpoint, hasCheckpoint, missingCheckpointSections, validateSummaryLoose } from '../ai/compactionCheckpoint';
import { buildInsightLocalContext } from '../ai/insightLocalContext';
import { contentPrivacyClassifier, deriveContextSourceTypes, evaluatePrivacy } from '../ai/privacyRouter';
import { findDimension, hasUsableDimensionContent, normalizeDimensionKey } from '../ai/skillDimensions';
import { parseEvidenceReference } from '../aiPanelChat';
import { createModelProfile, contextBudget, LOCAL_CONTEXT_CAP } from '../ai/modelProfile';
import { classifyCompactionLevel, DEFAULT_COMPACTION_POLICY } from '../ai/contextPolicy';

const source = (title: string, url: string, snippet = '') => ({ title, url, snippet });

describe('来源质量闸门', () => {
  it('硬剔除赌博/站群站点', () => {
    const junk = source('乐鱼·体育官方网站- 领先的数字体育与娱乐技术平台', 'https://leyu-network.com.cn/', '欢迎访问乐鱼·体育官方网站');
    expect(isJunkSource(junk)).toBe(true);
    const result = gateSources([junk, source('27寸 LCD OC面板 报价', 'https://example.com/a', '27寸 LCD OC 面板价格')], '27寸 LCD OC面板');
    expect(result.dropped).toHaveLength(1);
    expect(result.kept).toHaveLength(1);
  });

  it('特征词去掉通用品类词，只留有区分度的部分', () => {
    expect(materialTerms('27寸 LCD OC面板')).toEqual(expect.arrayContaining(['lcd', 'oc']));
    expect(materialTerms('27寸 LCD OC面板')).not.toContain('面板');
    expect(materialTerms('适配器')).toEqual(['适配器']);
  });

  it('英寸归一成寸，全角转半角', () => {
    expect(normalizeSourceText('２７英寸 IPS')).toContain('27寸');
  });

  it('相关来源排在无关来源前面', () => {
    const related = source('OC 面板价格走势', 'https://a.com', '27寸 OC 面板 报价');
    const unrelated = source('某公司发布年报', 'https://b.com', '营收增长');
    const result = gateSources([unrelated, related], '27寸 LCD OC面板');
    expect(result.kept[0].title).toBe('OC 面板价格走势');
    expect(scoreSource(related, materialTerms('27寸 LCD OC面板'))).toBeGreaterThan(scoreSource(unrelated, materialTerms('27寸 LCD OC面板')));
  });

  it('一条都没命中时保留少量来源并标记弱相关，而不是返回空', () => {
    const result = gateSources([source('招股说明书', 'https://c.com', '本次公开发行股票')], '适配器');
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].weak).toBe(true);
    expect(result.weak).toBe(1);
    expect(describeSourceQuality(result, ['适配器'])).toContain('弱相关');
  });

  it('没有来源时返回空（上层据此走降级路径）', () => {
    const result = gateSources([], '适配器');
    expect(result.kept).toHaveLength(0);
    expect(result.weak).toBe(0);
  });
});

describe('检索关键词重建（审批卡与实际请求必须逐字节一致）', () => {
  it('查询词 = 物料名 + 空格 + 已批准问题（与 Rust 网关严格相等校验对齐）', () => {
    const query = buildPublicSearchQuery('27寸 LCD OC面板', PUBLIC_PRICE_QUERY_QUESTION);
    expect(query).toBe(`27寸 LCD OC面板 ${PUBLIC_PRICE_QUERY_QUESTION}`);
  });

  it('绝不追加任何关键词——多一个词就会被网关拦下（2026-09-21 真实事故的回归守卫）', () => {
    const material = 'LCD OC面板';
    const question = PUBLIC_PRICE_QUERY_QUESTION;
    const gatewayExpected = gatewayExpectedQuery(material, question);
    expect(normalizePublicQuery(buildPublicSearchQuery(material, question))).toBe(gatewayExpected);
    // 反例：曾经把关键词拼在查询词后面 → normalize 后与期望值不等 → 网关拦截"查询词超出已批准的公开主题范围"
    const forbidden = normalizePublicQuery(`${buildPublicSearchQuery(material, question)} 涨价 供需`);
    expect(forbidden).not.toBe(gatewayExpected);
  });

  it('网关规则镜像：C1 检索请求体里的查询词必须与「物料+问题」规范化后完全相等', () => {
    // 这段逻辑逐字镜像 src-tauri/src/lib.rs 的 normalize_public_query + validate_public_query_binding。
    const rustNormalize = (value: string) => value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
    const rustValidate = (bodyQuery: string, material: string, question: string) =>
      rustNormalize(bodyQuery) === rustNormalize(`${material} ${question}`);
    for (const [material, question] of [
      ['LCD OC面板', PUBLIC_PRICE_QUERY_QUESTION],
      ['铜', PUBLIC_PRICE_QUERY_QUESTION],
      ['适配器', PUBLIC_PRICE_QUERY_QUESTION],
      ['连接器', PUBLIC_MODEL_QUERY_QUESTION],
    ] as const) {
      expect(rustValidate(buildPublicSearchQuery(material, question), material, question)).toBe(true);
    }
  });

  it('关键词形态的公开问题本身必须通过云端参数审查（不含金额/型号/公司/项目）', () => {
    for (const question of [PUBLIC_PRICE_QUERY_QUESTION, PUBLIC_MODEL_QUERY_QUESTION]) {
      const checked = validateCloudQueryArgs({ material: 'LCD OC面板', category: '直接查询', question });
      expect(checked.ok).toBe(true);
      const native = validateNativeSearchArgs({ material: 'LCD OC面板', category: '直接查询', question });
      expect(native.ok).toBe(true);
    }
  });

  it('纯函数：同样输入永远同样输出（载荷哈希绑定依赖这一点）', () => {
    expect(buildPublicSearchQuery('铜', '价格')).toBe(buildPublicSearchQuery('铜', '价格'));
  });
});

describe('本地模型自动选择', () => {
  it('排除嵌入/重排等非对话模型', () => {
    expect(pickLocalModel(['nomic-embed-text:latest', 'qwen3:27b'])).toBe('qwen3:27b');
  });

  it('优先参数规模大的对话模型', () => {
    expect(pickLocalModel(['qwen3:4b', 'qwen3:27b', 'llama3.1:8b'])).toBe('qwen3:27b');
  });

  it('同规模时按偏好与名字长度收敛，且解析 MoE 规模', () => {
    expect(modelSizeB('qwen3:27b')).toBe(27);
    expect(modelSizeB('mixtral:8x7b')).toBe(56);
    expect(pickLocalModel(['unknown-model:9b', 'qwen3:9b'])).toBe('qwen3:9b');
  });

  it('空列表返回空串', () => {
    expect(pickLocalModel([])).toBe('');
  });
});

describe('DSH 式检查点', () => {
  it('指令包含全部固定章节，并说明旧检查点要合并', () => {
    const instruction = buildCompactionInstruction(true);
    for (const title of ['主要请求与意图', '关键技术概念', '文件与代码', '错误与修复', '待办工作', '当前工作', '下一步', '关键上下文']) {
      expect(instruction).toContain(title);
    }
    expect(instruction).toContain('<compacted-summary>');
  });

  it('检查点包裹与提取往返一致', () => {
    const framed = frameCheckpoint('## 当前工作\n- 修复洞察链路');
    expect(framed.startsWith('这是一段自动生成的上下文检查点')).toBe(true);
    expect(hasCheckpoint(framed)).toBe(true);
    expect(extractCheckpoint(framed)).toContain('修复洞察链路');
  });

  it('缺章节能被检出（fail-closed 的依据）', () => {
    const missing = missingCheckpointSections('## 当前工作\n- x');
    expect(missing.length).toBeGreaterThan(0);
  });

  it('宽松校验接受实质内容、拒绝空壳摘要', () => {
    expect(validateSummaryLoose('## 当前工作\n- 已经完成一次真实的分析与修复')).toContain('当前工作');
    expect(() => validateSummaryLoose('   ')).toThrow();
    expect(() => validateSummaryLoose('## 主要请求与意图 (Primary Request and Intent)\n- (none)')).toThrow();
  });
});

describe('洞察的本机内部事实', () => {
  const rows = [
    { project_code: 'CM27', module_name: '显示模块', quantity: 1, unit_cost: 680, line_cost: 680, part_model: 'M270-OC' },
    { project_code: 'CM24', module_name: '显示模块', quantity: 2, unit_cost: 400, line_cost: 800 },
  ];

  it('给出聚合与明细，供本地模型回答"看自己"类维度', () => {
    const text = buildInsightLocalContext(rows);
    expect(text).toContain('覆盖 2 个项目');
    expect(text).toContain('合计金额 ¥1480.00');
    expect(text).toContain('CM24');
    expect(text).toContain('模块 显示模块');
  });

  it('没有命中记录时返回空串（不编造事实）', () => {
    expect(buildInsightLocalContext([])).toBe('');
  });

  it('明细截断但聚合仍按全量计算', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ project_code: `P${i}`, quantity: 1, unit_cost: 10, line_cost: 10 }));
    const text = buildInsightLocalContext(many, { maxRows: 3 });
    expect(text).toContain('合计金额 ¥200.00');
    expect(text).toContain('仅列前 3 条');
  });
});

describe('Skill 维度容错匹配（同一症状的第二条成因）', () => {
  const dims = [
    { dimension_type: '供给面', content: '上游产能收缩，交期拉长' },
    { dimension_type: '2. 需求因子', content: '下游备货进入旺季' },
    { dimension_type: '成本因子（Cost）', content: '树脂与铜价上行' },
    { dimension_type: '金融与政策因子：', content: '汇率小幅走弱' },
    { dimension_type: '展望 ', content: '预计维持高位震荡' },
  ];

  it('归一化去掉序号/括号/标点/空白/全角差异', () => {
    expect(normalizeDimensionKey('1. 成本因子（Cost）')).toBe('成本因子');
    expect(normalizeDimensionKey('金融与政策因子：')).toBe('金融与政策因子');
    expect(normalizeDimensionKey('　供给因子 ')).toBe('供给因子');
    expect(normalizeDimensionKey('看行业/趋势')).toBe('看行业趋势');
  });

  it('模型写「供给面」也能匹配到 Skill 的「供给因子」，不再丢内容', () => {
    expect(findDimension(dims, '供给因子')?.content).toBe('上游产能收缩，交期拉长');
  });

  it('序号/括号/全角冒号/尾随空格的变体都能匹配', () => {
    expect(findDimension(dims, '需求因子')?.content).toBe('下游备货进入旺季');
    expect(findDimension(dims, '成本因子')?.content).toBe('树脂与铜价上行');
    expect(findDimension(dims, '金融与政策因子')?.content).toBe('汇率小幅走弱');
    expect(findDimension(dims, '展望')?.content).toBe('预计维持高位震荡');
  });

  it('同前缀维度不会互相误配（看竞争/看机会/看自己只共享一个「看」字）', () => {
    const kan = [
      { dimension_type: '看行业/趋势', content: '行业内容' },
      { dimension_type: '看市场/客户', content: '市场内容' },
      { dimension_type: '看竞争', content: '竞争内容' },
      { dimension_type: '看自己', content: '自己内容' },
      { dimension_type: '看机会', content: '机会内容' },
    ];
    expect(findDimension(kan, '看竞争')?.content).toBe('竞争内容');
    expect(findDimension(kan, '看自己')?.content).toBe('自己内容');
    // 「看」只有 1 个字，不足以做前缀匹配 → 不会把「看机会」错配给「看市场/客户」
    expect(findDimension([{ dimension_type: '看', content: 'x' }], '看机会')).toBeUndefined();
  });

  it('命名完全对不上时按位置兜底（提示词要求按序输出），且不用空内容兜底', () => {
    const odd = [{ dimension_type: '一', content: '真实内容A' }, { dimension_type: '二', content: '真实内容B' }];
    expect(findDimension(odd, '供给因子', 0)?.content).toBe('真实内容A');
    expect(findDimension([{ dimension_type: '一', content: '' }], '供给因子', 0)).toBeUndefined();
  });

  it('完全同名的单字维度仍算匹配；空/缺参数安全返回 undefined', () => {
    expect(findDimension([{ dimension_type: '看', content: 'x' }], '看')?.content).toBe('x');
    expect(findDimension([], '供给因子')).toBeUndefined();
    expect(findDimension(null, '供给因子')).toBeUndefined();
    expect(findDimension([{ dimension_type: '供给因子', content: 'y' }], '')).toBeUndefined();
  });
  it('占位话术判定：真正的兜底文案不算可用内容', () => {
    expect(hasUsableDimensionContent('公开信息不足')).toBe(false);
    expect(hasUsableDimensionContent('公开信息不足，暂无法形成可靠结论。')).toBe(false);
    expect(hasUsableDimensionContent('上游产能收缩，交期拉长')).toBe(true);
  });
});

describe('证据引用宽容解析（本地模型不再卡在"格式无效"上打转）', () => {
  it('认标准写法', () => {
    expect(parseEvidenceReference('message:12')).toEqual({ kind: 'message', id: 12 });
    expect(parseEvidenceReference('event:3')).toEqual({ kind: 'event', id: 3 });
    expect(parseEvidenceReference('state:0')).toEqual({ kind: 'state', id: 0 });
  });

  it('认常见变体：msg / 中文 / # / 空格 / 裸数字', () => {
    expect(parseEvidenceReference('msg:12')).toEqual({ kind: 'message', id: 12 });
    expect(parseEvidenceReference('消息 12')).toEqual({ kind: 'message', id: 12 });
    expect(parseEvidenceReference('事件:7')).toEqual({ kind: 'event', id: 7 });
    expect(parseEvidenceReference('状态 2')).toEqual({ kind: 'state', id: 2 });
    expect(parseEvidenceReference('#12')).toEqual({ kind: 'message', id: 12 });
    expect(parseEvidenceReference('12')).toEqual({ kind: 'message', id: 12 });
    expect(parseEvidenceReference('  18  ')).toEqual({ kind: 'message', id: 18 });
  });

  it('无法识别的写法返回 null（由调用方给出可照抄的示例）', () => {
    expect(parseEvidenceReference('证据一')).toBeNull();
    expect(parseEvidenceReference('the third message')).toBeNull();
    expect(parseEvidenceReference('')).toBeNull();
    expect(parseEvidenceReference('message:abc')).toBeNull();
  });
});

describe('上下文预算：水位线必须够得着（否则自动压缩永不触发）', () => {
  it('宣称 131072 的模型被压到上限，水位线变成可达到的量级', () => {
    const profile = createModelProfile('http://127.0.0.1:11434', 'gemma3:27b', 131072);
    expect(profile.advertisedContext).toBe(131072);
    expect(profile.effectiveContext).toBe(LOCAL_CONTEXT_CAP);
    const budget = contextBudget(profile.effectiveContext, profile.maxTokens);
    const yellow = budget.inputHard * DEFAULT_COMPACTION_POLICY.yellowRatio;
    expect(yellow).toBeLessThan(20000);
    expect(classifyCompactionLevel(yellow / budget.inputHard)).toBe('yellow');
  });

  it('小于上限的模型窗口不被放大', () => {
    expect(createModelProfile('http://x', 'qwen3:4b', 8192).effectiveContext).toBe(8192);
  });
});

describe('内容级隐私判定（不再是常量）', () => {
  it('含本地业务数字的内容判为 sensitive 并列出命中项', () => {
    const decision = evaluatePrivacy({ text: '这块料成本 12.5 元，项目代号 CM27', sourceTypes: ['user_message'] });
    expect(decision.classification).toBe('sensitive');
    expect(decision.regexMatches.length + 1).toBeGreaterThan(1);
    expect(decision.cloudSafe).toBe(false);
  });

  it('干净的用户提问会真正跑分类器，且 route 仍是本地（fail-closed）', () => {
    const decision = evaluatePrivacy({ text: '帮我看看液晶面板的公开行情', sourceTypes: ['user_message'] });
    expect(decision.classifierUsed).toBe(true);
    expect(decision.reasonCode).toBe('classifier_unverified_public_source');
    expect(decision.classification).toBe('unknown');
    expect(decision.candidateRoute).toBe('local');
    expect(decision.cloudSafe).toBe(false);
  });

  it('来源标签敏感时分类由来源决定，但正则仍然执行并如实记录', () => {
    const decision = evaluatePrivacy({ text: '项目代号 CM27', sourceTypes: ['private_workspace'] });
    expect(decision.reasonCode).toBe('source_policy:private_workspace');
    expect(decision.regexMatches.length).toBeGreaterThan(0);
  });

  it('只有全部元数据都被核验为公开时才可能 public', () => {
    const decision = evaluatePrivacy({
      text: '液晶面板公开行情',
      sourceTypes: ['user_message'],
      metadata: [{ sourceType: 'user_message', sensitivity: 'public', cloudSafe: true, priority: 'normal', sourceIds: [], verified: true } as any],
      classifier: contentPrivacyClassifier,
    });
    expect(decision.classification).toBe('public');
    expect(decision.candidateRoute).toBe('cloud_candidate');
  });

  it('来源标签按真实消息推导，不再硬编码 private_workspace', () => {
    expect(deriveContextSourceTypes([{ role: 'user', content: '你好' }])).toEqual(['user_message']);
    expect(deriveContextSourceTypes([{ role: 'user', content: '你好' }, { role: 'toolResult', content: '{}' }])).toContain('private_workspace');
    expect(deriveContextSourceTypes([{ role: 'user', content: '【工作状态】项目 CM27' }])).toContain('private_workspace');
    // 与 contextBuilder.projectWorkingState 实际注入的标题一致（改标题必须同步）
    expect(deriveContextSourceTypes([{ role: 'user', content: [{ type: 'text', text: '【CostHub 结构化工作状态】\n事实：x' }] }])).toContain('private_workspace');
  });
});
