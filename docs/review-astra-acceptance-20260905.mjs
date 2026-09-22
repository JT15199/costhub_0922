// Acceptance probes: source functions, synthetic data, in-memory SQLite only.
// Run: node docs/review-astra-acceptance-20260905.mjs
// FAIL means an unmet acceptance requirement, not a passing bug snapshot.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
// Replace imports with explicit stand-ins; never load Tauri or an application DB.
function source(file, globals = {}, extra = '', cut = '') {
  let code = fs.readFileSync(path.join(root, file), 'utf8');
  if (cut) code = code.split(cut)[0];
  code = code.replace(/^import[\s\S]*?;\r?\n/gm, '') + '\n' + extra;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, console, ...globals }, { filename: file });
  return exports;
}
const json = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0;
async function check(name, expected, run) {
  let actual;
  try {
    actual = await run();
    assert.deepEqual(json(actual), json(expected));
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n  expected=${JSON.stringify(expected)}\n  actual=${JSON.stringify(actual)}${actual === undefined ? `\n  error=${error.message}` : ''}`);
  }
}

const sha256 = async value => createHash('sha256').update(value).digest('hex');
const AUTH_KEY = 'auth_password_hash', AUTH_CHANGED_KEY = 'auth_password_changed';
const oldPassword = 'SYNTHETIC_OLD_PASSWORD', defaultPassword = 'SYNTHETIC_DEFAULT_PASSWORD';
async function authCase(hash, failHashWrite = false) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO settings VALUES (?,?)').run('auth_password_plain', oldPassword);
    if (hash !== undefined) db.prepare('INSERT INTO settings VALUES (?,?)').run(AUTH_KEY, hash);
    const raw = {
      select: async (sql, args = []) => db.prepare(sql).all(...args),
      execute: async (sql, args = []) => {
        if (failHashWrite && sql.startsWith('INSERT') && args[0] === AUTH_KEY) throw new Error('synthetic write interruption');
        return db.prepare(sql).run(...args);
      },
    };
    const auth = source('src/db/auth.ts', {
      getRawDb: async () => raw, sha256, AUTH_KEY, AUTH_CHANGED_KEY,
      AUTH_USERNAME_KEY: 'auth_username', DEFAULT_USERNAME: 'SYNTHETIC_USER', DEFAULT_PASSWORD: defaultPassword,
      console: { error() {} },
    });
    let rejected = false;
    try { await auth.ensureAuthPassword(); } catch { rejected = true; }
    return {
      oldWorks: await auth.verifyPassword(oldPassword), defaultWorks: await auth.verifyPassword(defaultPassword),
      recoveryExists: Boolean(db.prepare('SELECT 1 FROM settings WHERE key=?').get('auth_password_plain')), rejected,
    };
  } finally { db.close(); }
}
await check('existing hash survives plaintext cleanup', { oldWorks: true, defaultWorks: false, recoveryExists: false, rejected: false }, () => authCase(sha256Value(oldPassword)));
function sha256Value(value) { return createHash('sha256').update(value).digest('hex'); }
await check('legacy plaintext is never silently replaced by default', true, async () => !(await authCase(undefined)).defaultWorks);
await check('interrupted migration preserves recovery or working hash', true, async () => {
  const result = await authCase(undefined, true);
  return result.oldWorks || result.recoveryExists;
});

const contracts = source('src/ai/contracts.ts');
await check('confirmed zero remains valid', 0, () => contracts.bomExtendedCostStrict({ part_cost: 0, price_state: 'confirmed', quantity: 2 }));
await check('confirmed flag cannot validate missing price', null, () => contracts.bomExtendedCostStrict({ part_cost: null, price_state: 'confirmed', quantity: 1 }));
await check('confirmed flag cannot validate negative price', null, () => contracts.bomExtendedCostStrict({ part_cost: -5, price_state: 'confirmed', quantity: 1 }));

const boms = [
  { id: 1, part_id: 1, module_name: 'screen', part_name: 'screen', main_category: 'hardware', part_cost: 100, quantity: 1, price_state: 'confirmed' },
  { id: 2, part_id: 2, module_name: 'cable', part_name: 'cable', main_category: 'cables', part_cost: 5, quantity: 1, price_state: 'confirmed' },
];
const packages = [
  { package_id: 1, package_status: 'confirmed', module_name: 'screen', cost_before: 100, cost_after: 80, evidence_json: '{"sourceVersionId":1}', dependency_role: 'primary' },
  { package_id: 1, package_status: 'confirmed', module_name: 'cable', cost_before: 5, cost_after: 20, evidence_json: '{"sourceVersionId":1}', dependency_role: 'required' },
];
const project = { id: 1, code: 'SYNTHETIC', category: '显示器', platform_fee_rate: 0 };
const planningDb = { select: async sql => {
  if (sql.includes('project_change_packages')) return packages;
  if (sql.includes('FROM projects')) return [project];
  return [];
} };
const architecture = source('src/db/architecture.ts', { ...contracts, getDb: async () => planningDb, getProjectBOMs: async () => boms }, 'ready = true;');
await check('complete package retains both domain deltas', { hardware: -20, cables: 15 }, () => architecture.buildConfirmedPackageDeltaVector(packages, boms));
await check('incomplete mandatory evidence blocks entire package', {}, () => architecture.buildConfirmedPackageDeltaVector([packages[0], { ...packages[1], evidence_json: '{}' }], boms));
await check('net opportunity and remaining gap reconcile', { opportunity: 5, gap: 10, targetSum: 100 }, async () => {
  const preview = await architecture.previewProjectTargetVersion(1, 90, 0);
  return { opportunity: preview.confirmedOpportunity, gap: preview.uncoveredGap, targetSum: preview.rows.reduce((sum, row) => sum + row.target, 0) };
});
await check('negative quantity cannot freeze a final BOM', true, async () => {
  const freezing = source('src/db/architecture.ts', {
    ...contracts, getProjectBOMs: async () => [{ ...boms[0], quantity: -1 }],
    getDb: async () => ({ ...planningDb, execute: async () => ({ lastInsertId: 99 }) }),
    localNow: () => '2026-09-05 00:00:00',
    require: name => {
      if (name === './worklog') return { recordSystemWorkLog: async () => {} };
      throw new Error(`Unexpected import: ${name}`);
    },
  }, 'ready = true;');
  try { await freezing.freezeProjectBOMVersion(1, { sourceType: 'final_bom' }); return false; }
  catch { return true; }
});

const specs = [{ field_key: 'refresh_rate', field_label: '刷新率', value_text: '144' }];
let versions = [];
const frozenLines = boms.map(row => ({ ...row, unit_cost: row.part_cost, line_total: row.part_cost * row.quantity }));
const projectStore = {
  getProjects: async () => [project], getProjectBOMs: async () => boms,
  getProjectBOMVersions: async () => versions, getProjectBOMVersionLines: async () => frozenLines,
  getProjectTargetVersions: async () => [], getTargets: async () => [], getMeasures: async () => [],
  getCostReviews: async () => [], getProjectCostSnapshots: async () => [],
  getTenderOverview: async () => null, getTenderDecision: async () => null,
  getSkus: async () => [], getAllSkuDiffs: async () => ({}), getChangePackages: async () => [],
  getProjectAnalysis: async () => [], getQuoteReviewLogs: async () => [],
};
const specStore = {
  getProjectSpecProfile: async () => specs,
  getLatestProjectSpecBaseline: async () => ({ id: 2, version_no: 2, spec_json: '{"refresh_rate":"144"}' }),
};
const report = source('src/components/CostPackageButton.tsx', { ...contracts, ...projectStore, ...specStore }, 'exports.reviewBomFingerprint = bomFingerprint;', 'export default function CostPackageButton');
versions = [{ id: 10, version_no: 1, status: 'frozen', data_fingerprint: report.reviewBomFingerprint(boms), platform_fee_rate: 0,
  spec_baseline_id: 1, project_snapshot_json: '{"spec_baseline_id":1,"spec_json":{"refresh_rate":"60"}}', sku_snapshot_json: '[]' }];
const snapshot = await report.loadSnapshot(project, [], [], [], [], []);
await check('report actually uses frozen BOM in fixture', 'frozen', () => snapshot.source.bomState);
await check('frozen BOM retains its bound specification', 1, () => snapshot.sourceVersionIds.spec);
const saved = [{ id: 1, artifact_type: 'phase_cost_package', title: 'Synthetic report', data_json: '{"projectId":1}',
  data_fingerprint: snapshot.dataFingerprint, source_version_ids: JSON.stringify(snapshot.sourceVersionIds), created_at: '2026-09-05' }];
const libraryDb = {
  execute: async () => ({}),
  select: async sql => {
    if (sql.includes('FROM analysis_artifacts')) return saved;
    if (sql.includes('SELECT id, category')) return [project];
    if (sql.includes('MAX(id)') && sql.includes('project_bom_versions')) return [{ project_id: 1, id: 10 }];
    return [];
  },
};
const library = source('src/db/artifacts.ts', {
  getDb: async () => libraryDb,
  require: name => {
    if (name === './projects') return projectStore;
    if (name === './architecture') return specStore;
    if (name === './ai') return { getRecommendations: async () => [] };
    throw new Error(`Unexpected import: ${name}`);
  },
});
await check('new report remains current without source changes', 'current', async () => (await library.getAnalysisLibraryItems()).find(row => row.id === 1).freshness);

// Second acceptance: use the actual frozen-table column names, not live BOM fields.
await check('real frozen row shape retains known total', { cost: 105, status: 'confirmed' }, async () => {
  const actualFrozenRows = frozenLines.map(({ part_cost, part_id, ...row }) => ({ ...row, canonical_part_id: part_id }));
  const actualReport = source('src/components/CostPackageButton.tsx', {
    ...contracts, ...projectStore, ...specStore, getProjectBOMVersionLines: async () => actualFrozenRows,
  }, '', 'export default function CostPackageButton');
  const result = await actualReport.loadSnapshot(project, [], [], [], [], []);
  return { cost: result.bomCost, status: result.source.costStatus };
});
await check('draft fee change invalidates report fingerprint', { beforeFee: 0, afterFee: 10, fingerprintChanged: true }, async () => {
  const oldVersions = versions;
  try {
    versions = [];
    const before = await report.loadSnapshot(project, [], [], [], [], []);
    project.platform_fee_rate = 10;
    const after = await report.loadSnapshot(project, [], [], [], [], []);
    return { beforeFee: before.source.feeRate, afterFee: after.source.feeRate, fingerprintChanged: before.dataFingerprint !== after.dataFingerprint };
  } finally { versions = oldVersions; project.platform_fee_rate = 0; }
});
await check('malformed legacy hash cannot destroy sole recoverable password', true, async () => {
  const result = await authCase('SYNTHETIC_TRUNCATED_HASH');
  return result.oldWorks || result.recoveryExists;
});

console.log(`\nAcceptance probes: ${passed} passed, ${failed} failed. No application database or network used.`);
process.exitCode = failed ? 1 : 0;
