// Quality Harness V1 — profile 定义
//
// 三档（实施指导 §3 / §5.4）：
//
//   core  完全确定性：无网络、无 Ollama、无 API Key、无正式数据库。每次修改都必须跑。
//   full  core + 隔离桌面程序（真实 WebView2/CDP + 隔离 SQLite fixture）。仍不访问真实云端。
//   live  full + 本地 Ollama + 真实 Agent Tool Calling。只用于人工验收，不作为普通提交硬门槛。
//
// 设计约束：
//   * 命令全部是静态字面量，不接受外部输入拼接（exec.mjs 因此可以安全使用 shell）。
//   * required: false 的步骤失败只降级为 warning，绝不静默通过。
//   * 任何步骤都不得依赖真实 API Key 或公网。

const ROOT = process.cwd();

/** 供 E2E 复用的 fixture 目录（绝对路径在运行时拼装，报告中只出现相对名）。 */
export const FIXTURE_DIR = 'artifacts/quality/desktop-fixture';

/** 回归目录路径（regression-catalog.json）。 */
export const CATALOG_PATH = 'tests/quality/regression-catalog.json';

// ---------------------------------------------------------------------------
// CORE
// ---------------------------------------------------------------------------

/**
 * Q01–Q08（实施指导 §12）
 *
 * 注意 Q02（Vitest 全量）已经覆盖 Q04–Q07 的隐私/网关/审批/resultStore 测试文件。
 * 这里仍然把 Q04–Q07 单列为独立步骤，目的是：
 *   * 让「隐私与审批边界」在报告里有一行明确的结论，而不是淹没在 92 个文件里；
 *   * 让边界回归被破坏时能一眼定位到是哪一类边界。
 */
const coreSteps = [
  {
    id: 'Q01',
    title: 'TypeScript/Vite Build',
    command: ['npm', 'run', 'build'],
    required: true,
    timeoutMs: 8 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q02',
    title: 'Vitest All',
    command: ['npx', 'vitest', 'run'],
    required: true,
    timeoutMs: 15 * 60 * 1000,
    // 冷启动/CPU 争用下已知存在 5s 超时抖动，允许一次重跑；
    // 重跑通过会被降级为 warning 并写入报告（见 run-quality.mjs），不静默变绿。
    flakeRetry: { max: 1, knownFlaky: 'src/__tests__/costPackage.test.ts cold-import 5s timeout' },
    regressionIds: [],
  },
  {
    id: 'Q03',
    title: 'Rust Unit Tests',
    command: ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib'],
    required: true,
    timeoutMs: 20 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q04',
    title: 'Privacy Regression',
    command: ['npx', 'vitest', 'run', '--reporter=dot', 'src/__tests__/privacyRouter.test.ts', 'src/__tests__/safeQuery.test.ts', 'src/__tests__/securityPolicy.test.ts'],
    required: true,
    timeoutMs: 5 * 60 * 1000,
    regressionIds: ['REG-PRIV-001', 'REG-PRIV-002'],
  },
  {
    id: 'Q05',
    title: 'Cloud Gateway Regression',
    command: ['npx', 'vitest', 'run', '--reporter=dot', 'src/__tests__/cloudGateway.test.ts', 'src/__tests__/aiGateway.test.ts', 'src/__tests__/nativeSearchSources.test.ts'],
    required: true,
    timeoutMs: 5 * 60 * 1000,
    regressionIds: ['REG-CLOUD-001', 'REG-SOURCE-001', 'REG-SOURCE-002', 'REG-SEARCH-001'],
  },
  {
    id: 'Q06',
    title: 'Approval Regression',
    command: ['npx', 'vitest', 'run', '--reporter=dot', 'src/__tests__/materialInsightApproval.test.ts', 'src/__tests__/aiApproval.test.ts', 'src/__tests__/cloudConfirm.test.ts'],
    required: true,
    timeoutMs: 5 * 60 * 1000,
    regressionIds: ['REG-APPROVAL-001', 'REG-SEARCH-001'],
  },
  {
    id: 'Q07',
    title: 'ResultStore Regression',
    command: ['npx', 'vitest', 'run', '--reporter=dot', 'src/__tests__/resultStore.test.ts', 'src/__tests__/contextPolicy.test.ts'],
    required: true,
    timeoutMs: 5 * 60 * 1000,
    regressionIds: ['REG-STORE-001'],
  },
  {
    id: 'Q08',
    title: 'Agent Deterministic Eval/Test',
    command: ['npm', 'run', 'test:agent'],
    required: true,
    timeoutMs: 5 * 60 * 1000,
    regressionIds: ['REG-AGENT-001'],
  },
  {
    id: 'Q09',
    title: 'Lint (baseline debt — non-blocking in V1)',
    command: ['npm', 'run', 'lint'],
    // 依据实施指导 §12：基线 lint 存在历史债务（113 errors / 149 warnings），
    // V1 先作为 warning，不允许一次性大改几百个文件“修 lint”。
    required: false,
    timeoutMs: 10 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q10',
    title: 'Harness self-check (redaction + DB guard)',
    command: ['node', 'tests/quality/self-check.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: ['REG-DB-001'],
  },
  {
    id: 'Q11',
    title: 'Regression catalog integrity',
    command: ['node', 'tests/quality/check-catalog.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q12',
    title: 'Report leak check (redaction verified on real artifacts)',
    // 独立于 Q10：Q10 验证脱敏函数本身，Q12 验证**真实落盘的报告文件**
    // ——包括子进程 stdout/stderr 带进来的、我们没预料到的内容。
    // 这是「报告是否可能泄漏 API Key」这一问的实证答案。
    command: ['node', 'tests/quality/check-report-leaks.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: ['REG-PRIV-002'],
  },
];

// ---------------------------------------------------------------------------
// FULL
// ---------------------------------------------------------------------------

const fullSteps = [
  {
    id: 'F01',
    title: 'Desktop fixture prepare (isolated DB)',
    command: ['node', 'tests/quality/desktop/prepare-fixture.mjs'],
    required: true,
    timeoutMs: 10 * 60 * 1000,
    regressionIds: ['REG-DB-001'],
  },
  {
    id: 'F02',
    title: 'Portable build available + launch',
    command: ['node', 'tests/quality/desktop/check-portable.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'F03',
    title: 'Desktop E2E-001..008 (WebView2 / CDP)',
    command: ['node', 'tests/quality/desktop/run-e2e.mjs'],
    required: true,
    timeoutMs: 20 * 60 * 1000,
    regressionIds: ['REG-DB-001', 'REG-UI-001'],
  },
  {
    id: 'F04',
    title: 'Portable package check',
    // 原来指向 artifacts/agent-upgrade/20260910-portable/CostHub-Portable，
    // 那是 2026-09-10 的一次性打包产物（artifacts/ 被 gitignore，fresh clone 后不存在），
    // 作为质量步骤会造成「路径陈旧 → 永远失败」的噪声。
    // 改为复用同一个检查脚本校验**当前夹具**里的可执行文件，语义等价且始终可用。
    command: ['node', 'tests/quality/desktop/check-portable.mjs'],
    required: false,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: [],
  },
];

// ---------------------------------------------------------------------------
// LIVE
// ---------------------------------------------------------------------------

const liveSteps = [
  {
    id: 'L01',
    title: 'Ollama status probe',
    command: ['node', 'tests/quality/live/ollama-status.mjs'],
    required: true,
    timeoutMs: 60 * 1000,
    regressionIds: [],
    // 探测不到 Ollama 时脚本以 exit 3 退出 → runner 记为 blocked（不是 PASS）
    blockedExitCodes: [3],
  },
  {
    id: 'L02',
    title: 'Real tool smoke (local model)',
    command: ['node', 'tests/agent-upgrade/real-tool-smoke.mjs'],
    required: true,
    timeoutMs: 15 * 60 * 1000,
    regressionIds: [],
    blockedExitCodes: [3],
  },
  {
    id: 'L03',
    title: 'Real summary evidence (local model)',
    command: ['node', 'tests/agent-upgrade/real-summary-evidence.mjs'],
    required: true,
    timeoutMs: 15 * 60 * 1000,
    regressionIds: [],
    blockedExitCodes: [3],
  },
];

export const PROFILES = {
  core: {
    name: 'core',
    description: 'Deterministic gate: build + unit/integration + rust + boundary regressions. No network, no Ollama, no API key, no production DB.',
    steps: coreSteps,
    artifactsDir: 'artifacts/quality',
  },
  full: {
    name: 'full',
    description: 'core + isolated desktop application (real WebView2/CDP + isolated SQLite fixture). Still no cloud.',
    steps: [...coreSteps, ...fullSteps],
    artifactsDir: 'artifacts/quality',
  },
  live: {
    name: 'live',
    description: 'full + local Ollama tool calling. Human acceptance only; blocked (not PASS) when Ollama is unavailable.',
    steps: [...coreSteps, ...fullSteps, ...liveSteps],
    artifactsDir: 'artifacts/quality',
  },
};

export function getProfile(name) {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`unknown quality profile "${name}" (expected: ${Object.keys(PROFILES).join(', ')})`);
  }
  return profile;
}

export { ROOT };
