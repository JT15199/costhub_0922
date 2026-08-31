import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = process.argv[2];
const src = fs.readFileSync(path.join(ROOT, 'src', 'db.ts'), 'utf8');
if (src.length < 10000) { console.error('db.ts 疑似已被拆分（长度异常），拒绝运行：', src.length); process.exit(1); }
const ast = JSON.parse(fs.readFileSync(path.join(ROOT, '_tools', 'db-ast.json'), 'utf8'));

// ===== 域映射 ===== (function/variable name -> domain)
const DOMAINS = {
  core: ['db','dbUrl','schemaReady','dataLocked','rawDb','AUTH_KEY','AUTH_PLAIN_KEY','AUTH_CHANGED_KEY','AUTH_USERNAME_KEY','DEFAULT_PASSWORD','DEFAULT_USERNAME','sha256','getRawDb','getDbUrl','isAuthQuery','getDb','ignoreSchemaError','ensureSchema','localNow','isDataLocked','setDataLocked'],
  auth: ['ensureAuthPassword','getUsername','changeUsername','isFirstUse','getPlainPassword','verifyPassword','changePassword'],
  parts: ['getParts','getPart','savePart','deletePart','getPriceHistory','getCategories','getMainCategories','getSubCategories','getAllPartSuppliers','getPartSuppliers','addPartSupplier','updatePartSupplier','deletePartSupplier','updatePartWeightedCost','getSupplierPriceHistory'],
  suppliers: ['getSupplierProfiles','getSupplierProfile','saveSupplierProfile','deleteSupplierProfile'],
  projects: ['getProjects','getProject','saveProject','deleteProject','getProductCategories','saveProductCategory','deleteProductCategory','ensureDefaultCategories','copyProject','getProjectBOMs','recordProjectCostSnapshot','getProjectCostSnapshots','getSnapshotBOMDetail','deleteProjectCostSnapshot','addBOMItem','addVirtualBOMItem','updateBOMItem','updateBOMRefProject','deleteBOMItem','getModules','getModuleItems','saveModule','getModuleCategories','getModuleCategoryOrder','saveModuleCategoryOrder','deleteModule','updateModuleCategoryByName','syncPartsProjectsField','syncProjectModulesToLibrary','saveModuleItem','deleteModuleItem','getModuleCost','getLibraryModules','getLibraryModuleItems','updateLibraryModuleItem','deleteLibraryModule','renameLibraryModule','getProjectModuleSummary','getCostReviews','saveCostReview','deleteCostReview','getMeasures','saveMeasure','deleteMeasure','getTargets','saveTarget','deleteTarget','getSkus','getAllSkus','saveSku','deleteSku','getSkuDiffs','saveSkuDiff','deleteSkuDiff','getAllSkuDiffs','getProjectSuppliers','saveProjectSupplier','deleteProjectSupplier','getProjectSupplierPriceHistory','saveProjectSupplierPriceHistory'],
  competitors: ['getCompetitors','getCompetitor','saveCompetitor','deleteCompetitor','getCompetitorBOMs','addCompetitorBOMItem','updateCompetitorBOMItem','deleteCompetitorBOMItem','getCompetitorParts','saveCompetitorPart','deleteCompetitorPart','getFeatures','saveFeature','deleteFeature','getScores','saveScore','getAllScoresForRefs','getModuleNames','getModuleFeatureLinks','setModuleFeatureLinks'],
  compare: ['normalizePartName','getPartAliases','savePartAlias','deletePartAlias','getCompareCache','saveCompareCache','upsertInsight','getInsights','getUnreadInsightCount','markInsightRead'],
  trend: ['getTrendItem','getTrendItemByCategory','getTrendItemsWithDetails','getQuickTrendItems','saveQuickTrendItem','deleteQuickTrendItem','saveTrendItem','deleteTrendItem','addTrendMapping','getTrendSources','saveTrendSource','clearTrendSources','getTrendConversations','saveTrendConversation','getTrendSnapshots','getLatestTrendSnapshot','saveTrendSnapshot','getTrendInsightDimensions','deleteTrendSnapshot','saveTrendInsightDimensions','getTrendKeyEvents','saveTrendKeyEvent','getMaterialCategories','addMaterialCategory','removeMaterialCategory','getAllDecompositionNodes','getDecompositionTree','getDecompositionNode','saveDecompositionNode','deleteDecompositionNode','getDecompositionHistory','searchDecompositionNodes','saveRollupContribution','saveRollupFeedback','getAllChecklistWithLogs','updateChecklistActive','deleteAnalysisChecklistItem','getRollupContributions','getAllRollupFeedback'],
  settings: ['getSetting','setSetting','loadContextEntries','saveContextEntry','deleteContextEntry','PRESET_PROVIDERS','ensurePresetProviders','getApiProviders','saveApiProvider','deleteApiProvider','setActiveProvider','updateProviderPriorities','getOutboundRequestLogs','clearOutboundRequestLogs','logOutboundRequest','getAllApiProviders','getApiProvidersByType','getActiveApiProviders','addApiProvider','updateApiProvider','toggleApiProviderActive','saveAIRequestLog','updateAIRequestLog','saveAIUsageLog','getTokenUsageStats','getAllAIRequestLogs','deleteAIRequestLog','clearAllAIRequestLogs','getModuleRules','saveModuleRule','deleteModuleRule','clearModuleRules'],
  worklog: ['getWorkLogs','getWorkLogsGroupedByProject','getWorkLog','saveWorkLog','toggleWorkLogDone','deleteWorkLog','getWorkLogCategories','getWorkSummaries','saveWorkSummary','deleteWorkSummary'],
  dashboard: ['getDashboardStats'],
  tender: ['makeTenderCanonicalKey','recordTenderEvent','importTenderQuoteBatch','getTenderQuoteBatches','getTenderMatrix','updateTenderLineMatch','getTenderOverview','saveNegotiationItems','getNegotiationItems','updateNegotiationItemStatus','getTenderDecision','saveTenderDecision'],
};

const nameToDomain = Object.create(null);
for (const [dom, names] of Object.entries(DOMAINS)) for (const nm of names) nameToDomain[nm] = dom;

const allDeclared = ast.filter(s => s.kind === 'function' || s.kind === 'variable').map(s => s.name.split(',')[0]);
const unmapped = allDeclared.filter(nm => !nameToDomain[nm]);
if (unmapped.length) { console.error('UNMAPPED:', unmapped.join(', ')); process.exit(1); }
console.log('mapping OK, declared:', allDeclared.length);

const domStmts = {};
for (const dom of Object.keys(DOMAINS)) domStmts[dom] = [];
for (const s of ast) {
  if (s.kind === 'import') continue;
  if (s.kind === 'export') { continue; } // 原 export { getDb } 由下方 core 统一导出
  const first = s.name.split(',')[0];
  const dom = nameToDomain[first];
  if (!dom) continue;
  domStmts[dom].push(s);
}

function collectRefs(text) {
  const refs = new Set();
  const locals = new Set();
  const sfs = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isIdentifier(node)) refs.add(node.text);
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      const nm = node.name;
      if (ts.isIdentifier(nm)) locals.add(nm.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) locals.add(node.name.text);
    if (ts.isFunctionExpression(node) && node.name) locals.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) locals.add(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(sfs);
  return { refs, locals };
}

const domNeeds = {};
for (const dom of Object.keys(DOMAINS)) {
  const text = domStmts[dom].map(s => src.slice(s.start, s.end)).join('\n');
  const { refs, locals } = collectRefs(text);
  const own = new Set(DOMAINS[dom]);
  const needs = new Set();
  for (const nm of refs) {
    if (own.has(nm)) continue;
    if (locals.has(nm)) continue;
    if (nameToDomain[nm]) needs.add(nm);
  }
  domNeeds[dom] = [...needs].sort();
}

const HEAD = '// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）\n// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射\n';
fs.mkdirSync(path.join(ROOT, 'src', 'db'), { recursive: true });

for (const dom of Object.keys(DOMAINS)) {
  const parts = [HEAD];
  if (dom === 'core') {
    parts.push("import Database from '@tauri-apps/plugin-sql';");
    parts.push("import { invoke } from '@tauri-apps/api/core';");
  }
  if (dom === 'settings') parts.push("import { PRESET_PROVIDERS as PRESET_PROVIDER_TEMPLATES } from '../constants';");
  const byDom = Object.create(null);
  for (const nm of domNeeds[dom]) {
    const d = nameToDomain[nm];
    if (d === dom) continue;
    if (!byDom[d]) byDom[d] = [];
    byDom[d].push(nm);
  }
  for (const d of Object.keys(byDom).sort()) {
    const rel = d === 'core' ? './core' : './' + d;
    parts.push('import { ' + byDom[d].join(', ') + ' } from \'' + rel + '\';');
  }
  if (parts.length > 1) parts.push('');
  const body = domStmts[dom].map(s => src.slice(s.start, s.end)).join('\n\n');
  parts.push(body);
  if (dom === 'core') parts.push("\nexport { getDb, getRawDb, sha256, localNow, dataLocked, AUTH_KEY, AUTH_PLAIN_KEY, AUTH_CHANGED_KEY, AUTH_USERNAME_KEY, DEFAULT_PASSWORD, DEFAULT_USERNAME };");
  const f = path.join(ROOT, 'src', 'db', dom + '.ts');
  fs.writeFileSync(f, parts.join('\n'));
  console.log('written', dom, '-', domStmts[dom].length, 'stmts, cross-imports:', domNeeds[dom].join(',') || '(none)');
}

const agg = [
  '// ===== CostHub 数据访问层（v2.3.19 可维护性重构）=====',
  '// 已按业务域拆分到 src/db/ 目录，本文件仅为聚合导出，页面 import 路径不变',
  '// 重新生成：node _tools/split-db.mjs <项目根>',
  "export * from './db/core';",
  ...['auth','parts','suppliers','projects','competitors','compare','trend','settings','worklog','dashboard','tender'].map(d => "export * from './db/" + d + "';"),
];
fs.writeFileSync(path.join(ROOT, 'src', 'db.ts'), agg.join('\n') + '\n');
console.log('db.ts rewritten as aggregation');
