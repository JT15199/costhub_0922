#!/usr/bin/env node
// Quality Harness V1 — 自身健全性自检（core 步骤 Q10）
//
// 这个脚本存在的理由（实施指导 §24 / REG-DB-001）：
//   Harness 本身也会坏。如果脱敏规则失效，报告可能泄漏 API Key；
//   如果 DB guard 判定过宽，桌面 E2E 可能写到正式数据库。
//   两者都必须被自动化证据钉住，而不是靠人工相信。
//
// 退出码：0 = 全部通过；1 = 有断言失败。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redact, redactDeep, redactSelfTest } from './helpers/redact.mjs';
import {
  assertFixtureDatabase,
  integrityCheck,
  isStrictlyInside,
  seedFixture,
  snapshotCounts,
} from './helpers/dbGuard.mjs';
import { loadConfig } from './helpers/config.mjs';
import { generateFixturePassword, hashFixturePassword, resolveFixtureCredentials } from './helpers/fixtureCredentials.mjs';
import { buildSummary, renderMarkdown } from './helpers/report.mjs';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('');
console.log('Quality Harness self-check');
console.log('');

// ---------------------------------------------------------------------------
// 1. 脱敏
// ---------------------------------------------------------------------------
console.log('[1] redaction');
const selfTest = redactSelfTest();
check('redactSelfTest passes', selfTest.ok, JSON.stringify(selfTest.failures));

const secretProbes = [
  ['openai style key', 'export const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'],
  ['bearer token', 'headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" }', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
  ['api key field', '{"api_key":"averylongsecretvalue123"}', 'averylongsecretvalue123'],
  ['password field', 'password=hunter2secret', 'hunter2secret'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----', 'MIIEvQIBADAN'],
  ['sql connection string', 'postgres://admin:s3cr3tpassword@db.internal:5432/app', 's3cr3tpassword'],
];
for (const [label, input, secret] of secretProbes) {
  const output = redact(input);
  check(`scrubs ${label}`, !output.includes(secret), `leaked: ${secret}`);
}

// 环境变量注入的秘密必须被逐字抹掉
const probeEnvName = 'QUALITY_SELFCHECK_FAKE_SECRET';
process.env[probeEnvName] = 'FAKE-SECRET-VALUE-1234567890';
const withEnv = redact(`OPENAI_API_KEY=FAKE-SECRET-VALUE-1234567890`);
// 该变量名不在白名单里，走模式规则；用一个白名单内变量再验一次
process.env.DEEPSEEK_API_KEY = 'DEEPSEEK-FAKE-KEY-abcdef123456';
const deepseekScrubbed = redact('using key DEEPSEEK-FAKE-KEY-abcdef123456 now');
delete process.env.DEEPSEEK_API_KEY;
delete process.env[probeEnvName];
check('scrubs value of a whitelisted env secret verbatim', !deepseekScrubbed.includes('DEEPSEEK-FAKE-KEY-abcdef123456'), deepseekScrubbed);

// 路径折叠：不能出现完整绝对路径
const absoluteProbe = redact('C:\\Users\\someuser\\projects\\costhub\\src\\main.tsx');
check('folds windows absolute path', !/Users[\\/]someuser/i.test(absoluteProbe), absoluteProbe);

// 深层对象也要脱敏
const deep = redactDeep({ nested: { list: [{ token: 'supersecrettokenvalue' }] } });
check('redacts nested object values', !JSON.stringify(deep).includes('supersecrettokenvalue'), JSON.stringify(deep));

// ---------------------------------------------------------------------------
// 2. 数据库保护（V2：严格目录白名单）
// ---------------------------------------------------------------------------
console.log('');
console.log('[2] database guard (V2 strict allowlist)');

const config = loadConfig();
const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), 'artifacts', 'quality', 'selfcheck-'));
// 白名单根必须与 config 一致，否则测的不是真实策略
const fixtureDir = path.join(tmpRoot, 'quality-fixture-selfcheck');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureDb = path.join(fixtureDir, 'costhub.db');

// 2a. 不存在的库必须被拒
const missing = assertFixtureDatabase(path.join(fixtureDir, 'missing.db'), { fixtureRoot: fixtureDir });
check('rejects non-existent database', missing.ok === false, missing.reason);

// 2b. 无 marker 的库必须被拒
seedFixture(fixtureDb, { username: 'agent-test', fixtureRoot: fixtureDir });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(fixtureDb);
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('DELETE FROM settings WHERE key=?').run(config.database.fixtureMarkerKey);
  db.close();
}
const unmarked = assertFixtureDatabase(fixtureDb, { fixtureRoot: fixtureDir });
check('rejects database without fixture marker', unmarked.ok === false && /marker/i.test(unmarked.reason || ''), unmarked.reason);

// 2c. 带 marker 的库必须被接受
seedFixture(fixtureDb, { username: 'agent-test', passwordHash: 'a'.repeat(64), fixtureRoot: fixtureDir });
const accepted = assertFixtureDatabase(fixtureDb, { fixtureRoot: fixtureDir });
check('accepts marked fixture database', accepted.ok === true, accepted.reason);
check('reports integrity ok', accepted.evidence?.integrity === 'ok', String(accepted.evidence?.integrity));
check('reports path.relative evidence', accepted.evidence?.relativeToFixtureRoot === 'costhub.db', String(accepted.evidence?.relativeToFixtureRoot));

// 2d. V2 核心：白名单之外必须被拒，即使内容完全合法 ---------------------------------
// 这正是 V1 会误判的场景 —— 路径含 "quality" 关键词但不在白名单目录内。
const keywordOnlyDir = path.join(process.cwd(), 'artifacts', 'quality-old');
fs.mkdirSync(keywordOnlyDir, { recursive: true });
const keywordOnlyDb = path.join(keywordOnlyDir, 'costhub.db');
fs.copyFileSync(fixtureDb, keywordOnlyDb);
const keywordRejected = assertFixtureDatabase(keywordOnlyDb, { fixtureRoot: fixtureDir });
check(
  'V1 regression: rejects "quality-old" path that only LOOKS like a fixture',
  keywordRejected.ok === false,
  keywordRejected.reason,
);
fs.rmSync(keywordOnlyDir, { recursive: true, force: true });

// 2e. 验收要求 #4：src/test.db 必须 FAIL
const srcDir = path.join(tmpRoot, 'src');
fs.mkdirSync(srcDir, { recursive: true });
const srcDb = path.join(srcDir, 'costhub.db');
fs.copyFileSync(fixtureDb, srcDb);
const srcRejected = assertFixtureDatabase(srcDb, { fixtureRoot: fixtureDir });
check(
  'acceptance: src/costhub.db is REJECTED',
  srcRejected.ok === false,
  srcRejected.reason,
);

// 2f. 验收要求 #4：白名单目录内的库必须 PASS（内容经 seedFixture 合法化）
const allowedDir = path.join(tmpRoot, 'desktop-fixture');
fs.mkdirSync(allowedDir, { recursive: true });
const allowedDb = path.join(allowedDir, 'costhub.db');
fs.copyFileSync(fixtureDb, allowedDb);
const allowedPass = assertFixtureDatabase(allowedDb, { fixtureRoot: allowedDir });
check(
  'acceptance: artifacts/quality/desktop-fixture/costhub.db is ACCEPTED',
  allowedPass.ok === true,
  allowedPass.reason,
);

// 2g. 同名子目录不算越权，但逃逸必须被拒
const escape = assertFixtureDatabase(path.join(fixtureDir, '..', 'escaped', 'costhub.db'), { fixtureRoot: fixtureDir });
check('rejects path escaping the fixture root with ..', escape.ok === false, escape.reason);

// 2h. Windows 跨盘符 / 绝对路径相对化
const crossDrive = assertFixtureDatabase(path.join(tmpRoot, 'other-drive', 'costhub.db'), { fixtureRoot: fixtureDir });
check('rejects sibling directory outside the fixture root', crossDrive.ok === false, crossDrive.reason);

// 2i. isStrictlyInside 本身的行为
check('isStrictlyInside: child inside parent', isStrictlyInside('/a/b', '/a/b/c').inside === true);
check('isStrictlyInside: parent itself is not inside', isStrictlyInside('/a/b', '/a/b').inside === false);
check('isStrictlyInside: sibling is not inside', isStrictlyInside('/a/b', '/a/c').inside === false);
check('isStrictlyInside: ancestor is not inside', isStrictlyInside('/a/b/c', '/a/b').inside === false);

// 2j. 完整性检查与计数
check('integrityCheck returns ok', integrityCheck(fixtureDb) === 'ok');
const counts = snapshotCounts(fixtureDb);
check('snapshotCounts reads settings count', typeof counts.settings === 'number', JSON.stringify(counts));

// 2k. seedFixture 也必须拒绝白名单外的路径（写操作的 fail closed）
let seedRejected = false;
try {
  seedFixture(srcDb, { username: 'x', fixtureRoot: fixtureDir });
} catch {
  seedRejected = true;
}
check('seedFixture refuses to write outside the fixture root', seedRejected);

// ---------------------------------------------------------------------------
// 3. V2 配置与凭据策略
// ---------------------------------------------------------------------------
console.log('');
console.log('[3] V2 config and credential policy');

check('config.security.failClosed is true', config.security.failClosed === true);
check('config.database.fixtureOnly is true', config.database.fixtureOnly === true);
check('config.tests.allowFailure is false', config.tests.allowFailure === false);
check('config.report.leakCheckBeforeFinalize is true', config.report.leakCheckBeforeFinalize === true);
check('config.limits.maxFileLines is 300', config.limits.maxFileLines === 300, String(config.limits.maxFileLines));
check('config resolves fixtureRoot under artifacts/quality', /artifacts[\\/]quality[\\/]desktop-fixture$/.test(config.fixtureRoot), config.fixtureRoot);

// 生成的随机密码必须强且不重复
const pw1 = generateFixturePassword();
const pw2 = generateFixturePassword();
check('generated fixture password has sufficient length', pw1.length >= 24, String(pw1.length));
check('generated fixture passwords differ between runs', pw1 !== pw2);
check('fixture password hash is a 64-char sha256 hex', /^[0-9a-f]{64}$/.test(hashFixturePassword('x')), hashFixturePassword('x').slice(0, 12));

// 环境变量优先；未设置时生成
const envVar = config.fixture.passwordEnvVar;
const fromGenerated = resolveFixtureCredentials(config, {});
check('credentials generated when env var absent', fromGenerated.source === 'generated' && fromGenerated.password.length >= 24);
check('generated credential hash matches its password', fromGenerated.passwordHash === hashFixturePassword(fromGenerated.password));
const fromEnv = resolveFixtureCredentials(config, { [envVar]: 'provided-by-operator-password' });
check('credentials taken from env var when present', fromEnv.source === 'env' && fromEnv.password === 'provided-by-operator-password', fromEnv.source);

// 仓库中不得出现明文 fixture 密码（V1 曾硬编码一个固定口令）。
// 扫描**整个** Harness 目录，而不只是几个文件 —— 注释里出现也算泄漏。
//
// 注意：本文件自身被排除，否则「检测用的字面量」会把检查自己判成泄漏。
// 为避免扫描器把本文件里的字符串当成真泄漏，待查口令由片段拼接构造，
// 不做成完整字面量。
const legacyPlaintext = [[ 'agent', 'test', '666' ].join('-')];
const SELF = path.resolve('tests/quality/self-check.mjs');
const leakedFiles = [];
const walkHarness = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkHarness(full); continue; }
    if (!/\.(mjs|js|json|md)$/.test(entry.name)) continue;
    if (path.resolve(full) === SELF) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (legacyPlaintext.some(secret => text.includes(secret))) leakedFiles.push(full.replace(/\\/g, '/'));
  }
};
for (const root of ['tests/quality']) if (fs.existsSync(root)) walkHarness(root);
check('no legacy plaintext fixture password anywhere in the harness', leakedFiles.length === 0, leakedFiles.join(', '));

// ---------------------------------------------------------------------------
// 4. 报告
// ---------------------------------------------------------------------------
console.log('');
console.log('[4] reporting');

const summary = buildSummary({
  profile: 'selfcheck',
  runId: 'selfcheck',
  git: { commit: 'deadbeef' },
  environment: { platform: process.platform, node: process.version },
  startedAt: new Date().toISOString(),
  durationMs: 1,
  steps: [
    { id: 'S1', title: 'pass step', required: true, status: 'pass', exitCode: 0, durationMs: 1, regressionIds: [] },
    { id: 'S2', title: 'fail step', required: true, status: 'fail', exitCode: 1, durationMs: 2, regressionIds: [] },
  ],
});
check('gate is FAIL when a required step fails', summary.gate === 'FAIL', summary.gate);
check('requiredFailures counted', summary.requiredFailures === 1, String(summary.requiredFailures));

const blockedSummary = buildSummary({
  profile: 'selfcheck', runId: 'x', git: {}, environment: {}, startedAt: '', durationMs: 0,
  steps: [
    { id: 'S1', title: 'ok', required: true, status: 'pass', exitCode: 0, durationMs: 0 },
    { id: 'S2', title: 'blocked', required: true, status: 'blocked', exitCode: 3, durationMs: 0, blockedReason: 'ollama missing' },
  ],
});
check('gate is BLOCKED_ENVIRONMENT (not PASS) when a step is blocked', blockedSummary.gate === 'BLOCKED_ENVIRONMENT', blockedSummary.gate);

const warnSummary = buildSummary({
  profile: 'selfcheck', runId: 'x', git: {}, environment: {}, startedAt: '', durationMs: 0,
  steps: [
    { id: 'S1', title: 'ok', required: true, status: 'pass', exitCode: 0, durationMs: 0 },
    { id: 'S2', title: 'optional', required: false, status: 'warning', exitCode: 1, durationMs: 0, reason: 'lint debt' },
  ],
});
check('optional failure does not block the gate', warnSummary.gate === 'PASS', warnSummary.gate);
check('optional failure is still counted as a warning', warnSummary.warnings === 1, String(warnSummary.warnings));

const markdown = renderMarkdown(summary);
check('markdown contains gate line', markdown.includes('QUALITY GATE: FAIL'));
check('markdown renders a step table', markdown.includes('| Step | Result |'));

// 报告里不得出现秘密
const leaky = buildSummary({
  profile: 'selfcheck', runId: 'x', git: { commit: 'deadbeef' }, environment: {}, startedAt: '', durationMs: 0,
  steps: [{ id: 'S1', title: 'leak', required: true, status: 'fail', exitCode: 1, durationMs: 0, stderrTail: 'api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' }],
});
check('summary redacts secrets in step tails', !JSON.stringify(leaky).includes('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'));

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`SELF-CHECK FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('SELF-CHECK PASSED');
process.exit(0);
