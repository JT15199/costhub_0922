// 离线验收反例：只读取源码，使用虚构对象 / 内存 SQLite，不连接应用数据库或模型。
// 运行：node docs/review-round3-repro.mjs（当前缺陷存在时退出码为 1）
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';

function load(path, extra = '', globals = {}, cut = '') {
  let source = fs.readFileSync(path, 'utf8');
  if (cut) source = source.split(cut)[0];
  source = source.replace(/^import[\s\S]*?;\r?\n/gm, '') + '\n' + extra;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, console, ...globals }, { filename: path });
  return exports;
}
let failed = 0;
function check(name, actual, expected) {
  try { assert.deepEqual(actual, expected); console.log('PASS', name); }
  catch { failed++; console.log('FAIL', name, JSON.stringify({ actual, expected })); }
}

const a = load('src/db/architecture.ts');
const bom = [{ module_name: 'screen', main_category: 'hardware', part_id: 1, quantity: 1, part_cost: 80, line_total: 80 }];
const pkg = [{ package_status: 'confirmed', module_name: 'screen', cost_before: 100, cost_after: 80, evidence_json: '{"referenceVersionId":9}' }];
const domains = a.buildTargetDomainRows(bom, [], 1);
const opportunities = a.buildConfirmedPackageOpportunities(pkg, bom);
check('上代100→当前80已实现；目标70没有独立机会，不能再扣10', a.calculateTargetAllocation(domains, 10, opportunities)[0].target, 80);
const pendingLines = [
  { package_id: 2, package_status: 'confirmed', module_name: 'screen', cost_before: 100, cost_after: 80, evidence_json: '{"baseline_included":false}', dependency_role: 'required' },
  { package_id: 2, package_status: 'confirmed', module_name: 'support', cost_before: 5, cost_after: 20, evidence_json: '{"baseline_included":false}', dependency_role: 'required' },
];
check('同一待实施依赖包减少20但必须增加15，净机会最多5',
  a.buildConfirmedPackageOpportunities(pendingLines, [
    { module_name: 'screen', main_category: 'hardware', part_cost: 100, quantity: 1 },
    { module_name: 'support', main_category: 'hardware', part_cost: 5, quantity: 1 },
  ]).hardware, 5);

let now = [
  { part_name: 'resistor', part_model: 'same', module_name: 'A', cost: 0, part_cost: 12, quantity: 1 },
  { part_name: 'resistor', part_model: 'same', module_name: 'B', cost: 0, part_cost: 28, quantity: 1 },
];
const previous = [
  { part_name: 'resistor', part_model: 'same', specs: '', module_name: 'A', line_total: 10 },
  { part_name: 'resistor', part_model: 'same', specs: '', module_name: 'B', line_total: 20 },
];
const c = load('src/components/CostPackageButton.tsx', 'export {lineTotal,loadSnapshot};', {
  getProjects: async () => [{ id: 2, name: 'Previous' }],
  getProjectBOMVersions: async id => id === 2 ? [{ id: 9, status: 'frozen', version_no: 1 }] : [],
  getProjectTargetVersions: async () => [], getProjectBOMs: async () => now,
  getTargets: async () => [], getTenderOverview: async () => null,
  getTenderDecision: async () => null, getProjectSpecProfile: async () => [],
  getProjectBOMVersionLines: async () => previous,
}, 'export default function CostPackageButton');
const snapshot = await c.loadSnapshot({ id: 1, reference_project_id: 2 }, [], [], [], []);
check('重复型号两行总差10，成本桥应对账', snapshot.slides[1].points.at(-1), '成本桥净变化：¥10.00');
check('旧cost列非零不能覆盖数量小计', c.lineTotal({ cost: 5, part_cost: 5, quantity: 4 }), 20);
now = [];
check('数据库真实空BOM不能回退到旧props', (await c.loadSnapshot({ id: 1 }, [{ part_cost: 30, quantity: 1 }], [], [], [])).bomCost, 0);

const sqlite = new DatabaseSync(':memory:');
const db = {
  select: async (sql, args = []) => sqlite.prepare(sql).all(...args),
  execute: async (sql, args = []) => { const r = sqlite.prepare(sql).run(...args); return { lastInsertId: Number(r.lastInsertRowid), rowsAffected: Number(r.changes) }; },
};
const v = load('src/db/voice.ts', '', { getDb: async () => db });
await v.getVoiceDimensions('demo', 1);
sqlite.prepare('INSERT INTO voice_dimension(name,product,project_id,module_name,kano_category,decision,rationale,confirmed) VALUES(?,?,?,?,?,?,?,?)')
  .run('clarity', 'demo', 1, 'screen', 'basic', 'keep', 'reviewed evidence', 1);
await v.replaceVoiceDimensions([{ name: 'clarity', weight: 2, count: 2, positive: 2, negative: 0, evidence: '[]' }], 'demo', 1);
const decision = sqlite.prepare('SELECT kano_category,decision,rationale FROM voice_dimension').get();
check('重新分析后人工取舍内容必须保留，可另行标记待复核', JSON.parse(JSON.stringify(decision)), { kano_category: 'basic', decision: 'keep', rationale: 'reviewed evidence' });
sqlite.close();
console.log(`${failed} 个业务反例未通过。此脚本是源码切片/替身诊断，不替代完整组件集成测试。`);
process.exitCode = failed ? 1 : 0;
