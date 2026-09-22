// Agent Runtime Stage 3.5 — 真实链路验证（人工执行，不进任何质量门）
//
// 目的：在**真实运行的应用 + 真实本地模型**上，验证 Runtime 新链路的稳定性。
// 与 quality:full 的区别：
//   * full 档的桌面 E2E 必须确定性、不依赖模型 → 这里反过来，必须有真实模型；
//   * 因此本脚本**不进 core/full/live 档**，只在人工验证时手动执行。
//
// 观测通道（两条，互相独立）：
//   1) `window.__costhubRuntimeEvents` —— 开发构建下的 RuntimeEvent 旁路记录器（顺序证据）
//   2) `local_ai_session_events` 表 —— 应用自身持久化的网关事件（含 seq，可跨重启核对）
//
// 前置：应用必须以**开发构建**运行（`npm run tauri:dev`），因为记录器只在 DEV 生效。
//
// 用法：
//   node tests/quality/validate/runtime-real-flow.mjs            # 三个 Case 全跑
//   node tests/quality/validate/runtime-real-flow.mjs case1      # 只跑一个 Case
//
// 退出码：0 全部通过；1 有断言失败；3 环境不具备（库/CDP/凭据不可用）。

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../helpers/config.mjs';
import { resolveFixtureCredentials } from '../helpers/fixtureCredentials.mjs';
import { readSessionEvents, readRuntimeRecorder } from './runtimeObservations.mjs';
import {
  CDP_PORT,
  RUNTIME_FLAG_KEY,
  applyRuntimeFlag,
  connectWithRetry,
  resolveIdentity,
  sendAndWait,
  setRuntimeFlag,
} from './runtimeDriver.mjs';

const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, 'artifacts', 'quality', 'stage3-5-real-flow.json');

/** 三个 Case 的输入。刻意用夹具项目代号，保证工具能命中真实数据。 */
const CASES = [
  {
    id: 'case1',
    title: '纯本地问答',
    prompt: '用一句话说明什么是BOM成本分析，不要调用任何工具。',
    assert(checks, sent, recorder) {
      // 不依赖模型质量：只断言"链路走通 + 流式 + 有回答 + 没崩"。
      // 模型说了什么、说得好不好，不是本阶段的验收对象。
      check(checks, '确实出现流式阶段（停止按钮出现过）', sent.sawStreaming);
      check(checks, '面板出现新增回答文本', sent.answerAdded);
      check(checks, '无 error 事件', !recorder.types.includes('error'));
      // 以下只有记录器真的收到事件时才断言，否则如实标注为"无证据"而不是假装通过
      if (recorder.types.length > 0) {
        const t = recorder.types;
        check(checks, 'budget 是第一个事件', t[0] === 'budget', t[0]);
        check(checks, 'privacy 先于 route', t.indexOf('privacy') >= 0 && t.indexOf('privacy') < t.indexOf('route'));
        check(checks, '产生 token 流式事件', t.filter(x => x === 'token').length > 0, t.filter(x => x === 'token').length);
        check(checks, '以 final 结束', t.includes('final'), t[t.length - 1]);
        check(checks, '未发生工具调用（纯问答意图）', !t.includes('tool_start'));
      }
    },
  },
  {
    id: 'case2',
    title: '工具调用',
    prompt: '请用工具查询项目 QAFIX-0001 的 BOM 明细，然后用一句话概括它的成本构成。',
    assert(checks, sent, recorder) {
      check(checks, '确实出现流式阶段', sent.sawStreaming);
      check(checks, '面板出现新增回答文本', sent.answerAdded);
      check(checks, '无 error 事件', !recorder.types.includes('error'));
      if (recorder.types.length > 0) {
        const starts = recorder.events.filter(e => e.type === 'tool_start');
        const ends = recorder.events.filter(e => e.type === 'tool_result');
        check(checks, '发生了工具调用', starts.length > 0, starts.map(s => s.detail.toolId));
        check(checks, 'tool_start 与 tool_result 配对', starts.length > 0 && ends.length >= starts.length, { starts: starts.length, ends: ends.length });
        check(checks, '工具结果报告成功', ends.length > 0 && ends.every(e => e.detail.ok === true), ends.map(e => e.detail.ok));
      }
    },
  },
  {
    id: 'case3',
    title: '隐私与路由（云端审批链路）',
    prompt: '帮我查一下"伺服电机"最新的公开市场价格行情。',
    assert(checks, sent, recorder) {
      check(checks, '确实出现流式阶段', sent.sawStreaming);
      check(checks, '无 error 事件', !recorder.types.includes('error'));
      if (recorder.types.length > 0) {
        const privacy = recorder.events.filter(e => e.type === 'privacy');
        const route = recorder.events.filter(e => e.type === 'route');
        check(checks, '发出 privacy 事件', privacy.length > 0);
        check(checks, '发出 route 事件', route.length > 0);
        check(checks, '隐私判定带 cloudSafe 布尔结论', typeof privacy[0]?.detail.decision?.cloudSafe === 'boolean', privacy[0]?.detail.decision);
        check(checks, '路由结论是 local/cloud 之一', ['local', 'cloud'].includes(route[0]?.detail.route), route[0]?.detail.route);
      }
    },
  },
];

function log(message) {
  console.log(message);
}

function check(checks, name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
}

async function main() {
  const config = loadConfig();
  const dbPath = path.resolve(process.env.STAGE35_DB || path.join('src-tauri', 'target', 'debug', 'costhub.db'));

  log('');
  log('Agent Runtime Stage 3.5 — 真实链路验证');
  log('');

  if (!fs.existsSync(dbPath)) {
    log(`BLOCKED: database not found at ${dbPath} — 先跑 npm run tauri:dev 让应用建库`);
    process.exit(3);
  }

  const identity = resolveIdentity(dbPath, resolveFixtureCredentials(config));
  if (!identity) {
    log('BLOCKED: 无法确定登录身份（密码已被改动？请设置 STAGE35_USER / STAGE35_PASSWORD）');
    process.exit(3);
  }
  log(`[identity] ${identity.username} (source: ${identity.source})`);

  const only = process.argv[2] || '';
  const selected = only ? CASES.filter(c => c.id === only) : CASES;
  if (selected.length === 0) {
    log(`BLOCKED: 未知 Case "${only}"（可选：${CASES.map(c => c.id).join(' / ')}）`);
    process.exit(3);
  }

  const cdp = await connectWithRetry();
  log(`[cdp] connected on ${CDP_PORT}`);

  const results = { ranAt: new Date().toISOString(), db: dbPath.replace(/\\/g, '/'), cases: [] };
  /** 累积所有 Case 的 gateway 事件明细（用于判断是否真重复）。 */
  const allGatewayDetails = [];

  try {
    await cdp.waitForDom(60000);

    // 切开关 → 重载 → 重新登录（AiPanel 只在挂载时读一次 flag；登录态不持久化）
    if (!await applyRuntimeFlag(cdp, identity, true, log)) {
      log('BLOCKED: 无法让应用按 Runtime 路径挂载');
      process.exit(3);
    }
    log('[panel] AI 协作窗就绪');

    for (const item of selected) {
      log('');
      log(`=== ${item.id} ${item.title} ===`);
      const checks = [];
      const sent = await sendAndWait(cdp, dbPath, item.prompt);
      check(checks, '本轮运行完成', sent.ok, sent.reason);
      if (sent.ok) {
        const recorder = sent.recorder || { types: [], events: [], gatewayTypes: [] };
        log(`  RuntimeEvent: ${recorder.types.join(' → ') || '(记录器为空)'}`);
        if (recorder.available === false) {
          log('  注：本机开发实例的记录器未收集到事件，RuntimeEvent 顺序无法由此证据支撑');
        }
        for (const e of recorder.events.filter(x => x.type === 'gateway')) allGatewayDetails.push(e.detail);
        item.assert(checks, sent, recorder);
      }
      for (const c of checks) {
        log(`    ${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` — ${JSON.stringify(c.detail)}`}`);
      }
      results.cases.push({
        id: item.id, title: item.title, prompt: item.prompt, checks,
        elapsedMs: sent.elapsedMs ?? null,
        runtimeEvents: sent.recorder ? sent.recorder.types : null,
      });
    }

    // ---------- 轨迹重复检查（本进程所有 Case 的 Runtime 事件 vs 底层网关事件）----------
    log('');
    log('=== 轨迹重复检查 ===');
    const gatewayDetails = allGatewayDetails;
    const gatewayTypes = gatewayDetails.map(d => String(d.gatewayType ?? 'unknown'));
    const adjacent = gatewayTypes.filter((type, i) => i > 0 && gatewayTypes[i - 1] === type);
    log(`  gateway 事件序列: ${gatewayTypes.join(' → ') || '(none)'}`);
    log(`  相邻同类型重复: ${adjacent.length ? adjacent.join(', ') : '无'}`);

    // 相邻同类型是否**完全同一条**：只有内容也相同才算重复投递，
    // 同类但内容不同（例如两次真实的网络尝试）必须保留。
    const identicalAdjacent = gatewayDetails.filter((detail, i) => i > 0
      && JSON.stringify(detail) === JSON.stringify(gatewayDetails[i - 1]));
    identicalAdjacent.forEach(d => log(`  相邻且内容完全相同: ${JSON.stringify(d)}`));
    if (identicalAdjacent.length === 0) log('  相邻且内容完全相同: 无');

    const events = await readSessionEvents(dbPath, { limit: 600 });
    const dbGateway = events.filter(e => String(e.event_type || '').startsWith('gateway_'));
    const dbAdjacent = dbGateway.filter((e, i) => i > 0
      && dbGateway[i - 1].event_type === e.event_type
      && dbGateway[i - 1].runId === e.runId);
    log(`  应用持久化 gateway 事件: ${dbGateway.length} 条 · 相邻同类型同轮重复: ${dbAdjacent.length}`);
    results.traceDuplicate = {
      gatewayTypes,
      adjacentDuplicates: adjacent,
      identicalAdjacentCount: identicalAdjacent.length,
      gatewayDetails,
      dbGatewayCount: dbGateway.length,
      dbAdjacentDuplicates: dbAdjacent.length,
      dbGatewayTypes: dbGateway.map(e => e.event_type),
    };

    await setRuntimeFlag(cdp, false);
    log('');
    log(`[flag] 已恢复 ${RUNTIME_FLAG_KEY}=0`);  } finally {
    try { cdp.close(); } catch { /* ignore */ }
  }

  const all = results.cases.flatMap(c => c.checks);
  const failed = all.filter(c => !c.ok);
  results.status = failed.length === 0 ? 'pass' : 'fail';
  results.passed = all.length - failed.length;
  results.failed = failed.length;

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  log('');
  log(`STAGE 3.5 REAL FLOW: ${results.status.toUpperCase()} (${results.passed} pass · ${results.failed} fail)`);
  log(`report: ${path.relative(ROOT, REPORT_PATH).replace(/\\/g, '/')}`);
  log('');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`[stage3.5] crashed: ${error?.stack || error}`);
  process.exit(1);
});
