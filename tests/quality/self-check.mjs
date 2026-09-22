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
import { assertFixtureDatabase, FIXTURE_MARKER_KEY, integrityCheck, seedFixture, snapshotCounts } from './helpers/dbGuard.mjs';
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
// 2. 数据库保护
// ---------------------------------------------------------------------------
console.log('');
console.log('[2] database guard');

// 注意：故意不使用 os.tmpdir()。Windows 上它位于 AppData\Local\Temp，
// 而 dbGuard 把 AppData\Local 视为正式运行库特征路径并拒绝——这是我们想要的严格性，
// 因此自检使用仓库内一个有 "quality" 段、且不会被误判为正式库的临时目录。
const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), 'artifacts', 'quality', 'selfcheck-'));
const fixtureDir = path.join(tmpRoot, 'quality-fixture-selfcheck');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureDb = path.join(fixtureDir, 'costhub.db');

// 2a. 不存在的库必须被拒
const missing = assertFixtureDatabase(path.join(fixtureDir, 'missing.db'));
check('rejects non-existent database', missing.ok === false, missing.reason);

// 2b. 无 marker 的库必须被拒
seedFixture(fixtureDb, { username: 'agent-test' });
// 先手动建表再删 marker：模拟「看起来像但没标记」的库
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(fixtureDb);
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('DELETE FROM settings WHERE key=?').run(FIXTURE_MARKER_KEY);
  db.close();
}
const unmarked = assertFixtureDatabase(fixtureDb);
check('rejects database without fixture marker', unmarked.ok === false && /marker/i.test(unmarked.reason || ''), unmarked.reason);

// 2c. 带 marker 的 fixture 必须被接受
seedFixture(fixtureDb, { username: 'agent-test', passwordHash: 'a'.repeat(64) });
const accepted = assertFixtureDatabase(fixtureDb);
check('accepts marked fixture database', accepted.ok === true, accepted.reason);
check('reports integrity ok', accepted.evidence?.integrity === 'ok', String(accepted.evidence?.integrity));

// 2d. 正式库特征路径必须被拒（即使文件内容完全合法）
const productionishDir = path.join(tmpRoot, 'AppData', 'Roaming', 'CostHub');
fs.mkdirSync(productionishDir, { recursive: true });
const productionishDb = path.join(productionishDir, 'costhub.db');
fs.copyFileSync(fixtureDb, productionishDb);
const rejectedPath = assertFixtureDatabase(productionishDb);
check('rejects production-looking path even with valid content', rejectedPath.ok === false, rejectedPath.reason);

// 2e. 非 fixture 目录名必须被拒
// 位置选在盘根：既不含 "quality" 段（否则会被 REQUIRED_DIR_MARKER 放过），
// 也不含 AppData/Target 等正式库特征段（否则会被 FORBIDDEN 规则拦掉，
// 那样测的就不是「目录名不对」这一条了）。
const plainRoot = fs.mkdtempSync(`${path.parse(process.cwd()).root}qh-selfcheck-`);
const plainDir = path.join(plainRoot, 'plain-place');
fs.mkdirSync(plainDir, { recursive: true });
const plainDb = path.join(plainDir, 'costhub.db');
fs.copyFileSync(fixtureDb, plainDb);
const rejectedName = assertFixtureDatabase(plainDb);
check(
  'rejects database outside a fixture directory',
  rejectedName.ok === false && /fixture directory/i.test(rejectedName.reason || ''),
  rejectedName.reason,
);
fs.rmSync(plainRoot, { recursive: true, force: true });

// 2f. 完整性检查与计数
check('integrityCheck returns ok', integrityCheck(fixtureDb) === 'ok');
const counts = snapshotCounts(fixtureDb);
check('snapshotCounts reads settings count', typeof counts.settings === 'number', JSON.stringify(counts));

// ---------------------------------------------------------------------------
// 3. 报告
// ---------------------------------------------------------------------------
console.log('');
console.log('[3] reporting');

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
