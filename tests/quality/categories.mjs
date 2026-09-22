// Quality Harness V2 — Vitest 结果分类规则（V2 要求 #5）
//
// 这些类别在 V1 里是靠「把同一批测试文件再跑一遍」实现的（Q04–Q07）。
// V2 改为对**一次执行**的结果做分类，因此规则集中在这里，便于维护与评审。
//
// 每条规则用正则匹配仓库相对路径。一个文件可以命中多个类别（例如
// privacyRouter.test.ts 同时是隐私边界与正则守卫），这是刻意的：
// 报告需要按「边界」而不是按「目录」呈现结论。

export const CATEGORIES = [
  {
    id: 'privacy',
    title: 'Privacy Boundary',
    description: '隐私路由、正则守卫、本地端点约束',
    match: file => /(privacyRouter|securityPolicy|safeQuery|cloudContext)\.test\.ts$/.test(file),
    regressionIds: ['REG-PRIV-001', 'REG-PRIV-002'],
  },
  {
    id: 'cloud',
    title: 'Cloud Projection',
    description: '云端网关与 CloudSafe 投影边界',
    match: file => /(cloudGateway|aiGateway|nativeSearchSources|aiBridge)\.test\.ts$/.test(file),
    regressionIds: ['REG-CLOUD-001', 'REG-SOURCE-001', 'REG-SOURCE-002'],
  },
  {
    id: 'approval',
    title: 'Approval Flow',
    description: '云端审批队列、放行与续跑',
    match: file => /(materialInsightApproval|aiApproval|cloudConfirm|materialInsight)\.test\.ts$/.test(file),
    regressionIds: ['REG-APPROVAL-001', 'REG-SEARCH-001'],
  },
  {
    id: 'store',
    title: 'Result Store / Context',
    description: '大结果引用与上下文策略',
    match: file => /(resultStore|contextPolicy|contextBuilder|compactionRuntime)\.test\.ts$/.test(file),
    regressionIds: ['REG-STORE-001'],
  },
  {
    id: 'agent',
    title: 'Agent Toolchain',
    description: 'Agent 工具链、协议、模型画像与评测',
    match: file => /(aiTools|thinkEngine|aiAgent|aiEval|aiSkills|aiContracts|aiStructuredTools|aiC2|aiLearning|modelProfile|harnessPhases|piToolSelection|piStreamPolicy|piHost|requestChannel)\.test\.ts$/.test(file),
    regressionIds: ['REG-AGENT-001'],
  },
  {
    id: 'desktop-contract',
    title: 'Desktop Contract',
    description: 'Harness 自身的桌面契约（E2E 选择器/夹具/DB 保护）由 F03 覆盖，这里列出相关的确定性测试',
    match: file => /(authStartup|architecture)\.test\.ts$/.test(file),
    regressionIds: ['REG-UI-001', 'REG-DB-001'],
  },
];

/** 汇总所有类别声明的回归 ID（供 catalog 交叉校验）。 */
export function categoryRegressionIds() {
  return [...new Set(CATEGORIES.flatMap(category => category.regressionIds))];
}
