// Quality Harness V2 — profile 定义
//
// 三档（与 V1 相同的分层意图）：
//
//   core  完全确定性：无网络、无 Ollama、无 API Key、无正式数据库。
//   full  core + 隔离桌面程序（真实 WebView2/CDP + 隔离 SQLite fixture）。
//   live  full + 本地 Ollama + 真实 Agent Tool Calling。
//
// V2 相对 V1 的步骤变化：
//   * 删除 Q04–Q07（它们只是把 Q02 里的一部分文件再跑一遍）。隐私/网关/审批/
//     resultStore 的边界结论改由 Vitest 分类报告给出（一次执行，按文件归类）。
//   * 新增 Q03「Vitest 分类」：对同一次执行的结果做类别汇总。
//   * 新增 Q10「lint 基线门禁」：lint 仍然不参与 PASS/FAIL，但**新增**问题会硬失败。
//   * 新增 Q13「单文件行数门禁」：防止 Quality Harness 自身膨胀。
//   * Q12 的语义变化：它由 runner 在写完草稿报告后调用，校验的是**本次运行的报告**。
//
// 命令全部是静态字面量，不接受外部输入拼接。

export const FIXTURE_DIR = 'artifacts/quality/desktop-fixture';
export const CATALOG_PATH = 'tests/quality/regression-catalog.json';

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
    title: 'Vitest All (single execution, collected)',
    // reporter 把逐测试结果写到 QUALITY_VITEST_RESULT，供 Q03 分类使用。
    command: ['npx', 'vitest', 'run', '--reporter=default', '--reporter=./tests/quality/reporters/vitest-collect.mjs'],
    required: true,
    timeoutMs: 15 * 60 * 1000,
    // 冷启动/CPU 争用下已知存在 5s 超时抖动，允许一次重跑；
    // 重跑通过会被降级为 warning 并写入报告，不静默变绿。
    flakeRetry: { max: 1, knownFlaky: 'src/__tests__/costPackage.test.ts cold-import 5s timeout' },
    regressionIds: [],
  },
  {
    id: 'Q03',
    title: 'Vitest boundary classification (no re-run)',
    command: ['node', 'tests/quality/classify-vitest.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: ['REG-PRIV-001', 'REG-PRIV-002', 'REG-CLOUD-001', 'REG-APPROVAL-001', 'REG-STORE-001', 'REG-AGENT-001'],
  },
  {
    id: 'Q04',
    title: 'Rust Unit Tests',
    command: ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib'],
    required: true,
    timeoutMs: 20 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q05',
    title: 'Agent Deterministic Eval/Test',
    command: ['npm', 'run', 'test:agent'],
    required: true,
    timeoutMs: 5 * 60 * 1000,
    regressionIds: ['REG-AGENT-001'],
  },
  {
    id: 'Q06',
    title: 'Lint capture (not in gate)',
    // 采集输出留档；lint 本身失败是正常的（基线即失败），因此该步骤总是 pass。
    // 是否「新增了问题」由 Q07 的基线门禁判定。
    command: ['node', 'tests/quality/capture-lint.mjs'],
    required: false,
    timeoutMs: 12 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q07',
    title: 'Lint baseline gate (no new problems)',
    // V2 要求 #6：lint 债务只允许减少，不允许新增。
    command: ['node', 'tests/quality/lint-gate.mjs', 'artifacts/quality/lint-output.txt'],
    required: true,
    timeoutMs: 3 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q08',
    title: 'Harness self-check (redaction + DB guard)',
    command: ['node', 'tests/quality/self-check.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: ['REG-DB-001'],
  },
  {
    id: 'Q09',
    title: 'Regression catalog integrity',
    command: ['node', 'tests/quality/check-catalog.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: [],
  },
  {
    id: 'Q10',
    title: 'File size gate (max 300 lines)',
    command: ['node', 'tests/quality/file-size-check.mjs'],
    required: true,
    timeoutMs: 2 * 60 * 1000,
    regressionIds: [],
  },
];

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
    title: 'Fixture executable check',
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
];

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
    description: 'Deterministic gate: build + unit/integration (single run, classified) + rust + lint baseline + harness self-checks.',
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
