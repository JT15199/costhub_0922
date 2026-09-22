export interface SkillDefinition {
  id: string;
  version: string;
  name: string;
  triggers: string[];
  requiredData: string[];
  allowedTools: string[];
  steps: string[];
  confidenceRule: string;
  stopCondition: string;
  recommendationUi: 'table' | 'card' | 'timeline';
}

export const SKILL_DEFINITIONS: SkillDefinition[] = [
  { id: 'similar-project-estimate', version: '1.0.0', name: '类似项目预估', triggers: ['类似项目', '历史项目', '预估成本', '参考项目'], requiredData: ['projects', 'project_boms'], allowedTools: ['estimate_similar_projects'], steps: ['解析项目', '比较规格特征', '计算历史成本区间', '报告差异与缺口'], confidenceRule: '样本数不少于 3 且规格匹配度高为高，否则降级', stopCondition: '没有可比历史项目时停止并报告数据不足', recommendationUi: 'table' },
  { id: 'quote-negotiation', version: '1.0.0', name: '报价审核与议价排序', triggers: ['报价审核', '议价', '谈价', '报价差异'], requiredData: ['supplier_quote_batches', 'supplier_quote_lines'], allowedTools: ['rank_quote_negotiations', 'query_tender_analysis'], steps: ['读取当前轮次', '仅保留 exact/equivalent', '按可谈金额排序', '标记不可比项'], confidenceRule: '可比关系由人工确认或规则高置信建立', stopCondition: '没有可比报价时只报告覆盖缺口', recommendationUi: 'table' },
  { id: 'quote-change-attribution', version: '1.0.0', name: '报价轮次与规格变更归因', triggers: ['报价轮次', '规格变更', '涨价原因', '报价变化'], requiredData: ['supplier_quote_batches', 'supplier_quote_lines', 'project_spec_baselines'], allowedTools: ['explain_quote_change'], steps: ['选取相邻批次', '拆分数量变化', '拆分单价变化', '列出新增删除项'], confidenceRule: '批次存在且键可匹配为中高置信', stopCondition: '少于两个报价批次时停止', recommendationUi: 'timeline' },
  { id: 'target-gap-diagnosis', version: '1.0.0', name: '目标成本差距诊断', triggers: ['目标成本', '超目标', '成本缺口'], requiredData: ['project_targets', 'project_boms'], allowedTools: ['query_target_status'], steps: ['对账目标与实际', '按领域排序缺口', '提示数据缺口'], confidenceRule: '目标与有效 BOM 均存在为高', stopCondition: '没有目标成本时停止', recommendationUi: 'card' },
  { id: 'project-retro', version: '1.0.0', name: '项目复盘', triggers: ['项目复盘', '复盘', '经验沉淀'], requiredData: ['projects', 'project_boms', 'project_process_events'], allowedTools: ['query_project_bom', 'query_cost_snapshots', 'query_tender_analysis'], steps: ['汇总全过程数据', '区分事实与推断', '等待用户确认后保存'], confidenceRule: '只对有证据事件输出事实', stopCondition: '关键阶段数据不足时报告缺口', recommendationUi: 'card' },
  { id: 'daily-brief', version: '1.0.0', name: '每日异常简报', triggers: ['今日简报', '每日简报', '今天处理'], requiredData: ['ai_advisor_insights', 'project_targets'], allowedTools: ['query_advisor_insights', 'query_target_status'], steps: ['读取未处理事项', '按影响排序', '显示数据缺口'], confidenceRule: '无异常时明确报告暂无需要处理', stopCondition: '读取失败时报告不可用', recommendationUi: 'card' },
  { id: 'data-quality', version: '1.0.0', name: '数据质量助手', triggers: ['数据质量', '数据缺口', '异常单价', '同物异名'], requiredData: ['parts', 'project_boms', 'supplier_quote_lines'], allowedTools: ['query_data_readiness', 'query_project_bom'], steps: ['扫描缺失与异常', '生成修复预览', '等待用户确认'], confidenceRule: '规则命中即报告，不替用户修改', stopCondition: '没有异常时保持安静', recommendationUi: 'table' },
];

export function getSkill(id: string): SkillDefinition | undefined {
  return SKILL_DEFINITIONS.find(skill => skill.id === id);
}

export function detectSkill(question: string): SkillDefinition | undefined {
  return SKILL_DEFINITIONS.find(skill => skill.triggers.some(trigger => question.includes(trigger)));
}
