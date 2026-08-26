// AI 技能库（v2.3.19，2026-08-19 借鉴 DSH Skills：分析套路固化为可复用模板，按任务注入精炼步骤）
// 设计：send 时按用户提问检测匹配技能 → 追加「当前任务技能」说明（比固定全量提示更聚焦，27B 模型按模板执行）
export interface AiSkill { id: string; name: string; triggers: string[]; guide: string; }

export const AI_SKILLS: AiSkill[] = [
  {
    id: 'trend', name: '行情洞察', triggers: ['行情', '洞察', '最新.*价格', '走势'],
    guide: '两步必做：① query_material_insight 查历史（含关联型号）② insight_material_trend 查最新（需底部横幅审批；确认后系统自动续跑并更新洞察卡片）。审批待确认时禁止编造行情数据。',
  },
  {
    id: 'quote', name: '审价', triggers: ['审价', '审这份', '报价合理', '议价'],
    guide: '用 quote_review：逐项判定 合理/偏高/虚高 + 合理价 + 议价要点，对照器件库参考价；审价记录自动保存到历史。',
  },
  {
    id: 'bom', name: 'BOM 拆解', triggers: ['bom', '拆解', '录入.*项目', '导入.*清单'],
    guide: '用 import_bom_to_project：器件按名称+型号去重入库（复用已有）、自动归模块、写入项目 BOM；然后分析成本结构给降本建议。表格附件已自动识别，工具直接读取完整数据。',
  },
  {
    id: 'selling', name: '卖点价值', triggers: ['卖点', '价值分析', '模块价值'],
    guide: '用 query_project_module_value 读模块级价值（成本/声量/好评/类型），分析后可用 save_selling_analysis 把结论记入卖点面板。',
  },
  {
    id: 'health', name: '项目体检', triggers: ['体检', '健康', '哪里贵', '为什么贵'],
    guide: '用 query_project_health 拿深度数据（成本结构/目标/快照），逐模块分析"哪里贵、为什么、怎么降"，结论可用 save_project_analysis 记录到驾驶舱。',
  },
  {
    id: 'report', name: '报告生成', triggers: ['报告', '演示', 'ppt', 'pptx', '导出.*excel'],
    guide: '分析完成后组织 3-6 节（heading+points）→ generate_report（HTML/PPTX）；表格数据 → write_excel。报告保存在导出目录 exports/。',
  },
];

/** 按提问检测匹配的技能（命中任一触发词） */
export function detectSkills(text: string): AiSkill[] {
  const t = text || '';
  return AI_SKILLS.filter(s => s.triggers.some(tr => new RegExp(tr, 'i').test(t)));
}
