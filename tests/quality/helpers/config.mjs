// Quality Harness V2 — 配置加载与校验
//
// 设计原则（对应 V2 要求 #7 与 security.failClosed）：
//   * runner 与各检查脚本不硬编码策略，一律从此处读取；
//   * 配置文件缺失、无法解析、或缺少必需字段时 **fail closed**：
//     抛错终止，而不是回退到「宽松默认值」继续跑。
//   * 只做浅层类型/必填校验，不引入 JSON Schema 依赖。

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_PATH = 'tests/quality/config.json';

/** 必需的字段路径（点分），任一缺失即视为配置非法。 */
const REQUIRED = [
  'version',
  'security.failClosed',
  'database.fixtureOnly',
  'database.fixtureDir',
  'database.databaseFilename',
  'database.fixtureMarkerKey',
  'database.fixtureMarkerValue',
  'tests.allowFailure',
  'tests.flakeRetryMax',
  'lint.baseline',
  'lint.baselineFile',
  'report.leakCheckBeforeFinalize',
  'report.draftBasename',
  'limits.maxFileLines',
  'limits.enforcedDirs',
  'fixture.passwordEnvVar',
  'fixture.username',
];

function readPath(object, dotted) {
  return dotted.split('.').reduce((current, key) => (current == null ? undefined : current[key]), object);
}

/**
 * 加载并校验配置。
 *
 * @param {string} [root] 仓库根目录（默认 process.cwd()）
 * @returns {object} 已校验的配置对象（含 `_root` 与若干解析后的绝对路径）
 * @throws {Error} 配置缺失/非法时抛出 —— 调用方不应吞掉此错误
 */
export function loadConfig(root = process.cwd()) {
  const configPath = path.resolve(root, CONFIG_PATH);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `QUALITY_CONFIG_MISSING: ${CONFIG_PATH} not found. ` +
      'The harness fails closed without an explicit configuration.',
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`QUALITY_CONFIG_INVALID: ${CONFIG_PATH} is not valid JSON — ${error.message}`);
  }

  const missing = REQUIRED.filter(dotted => readPath(raw, dotted) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `QUALITY_CONFIG_INCOMPLETE: ${CONFIG_PATH} is missing required keys: ${missing.join(', ')}. ` +
      'Refusing to run with implicit defaults.',
    );
  }

  // ---- 类型校验（fail closed：类型不对就停，不做强制转换） ----
  const typeChecks = [
    ['security.failClosed', 'boolean'],
    ['database.fixtureOnly', 'boolean'],
    ['tests.allowFailure', 'boolean'],
    ['lint.baseline', 'boolean'],
    ['lint.required', 'boolean'],
    ['report.leakCheckBeforeFinalize', 'boolean'],
    ['tests.flakeRetryMax', 'number'],
    ['limits.maxFileLines', 'number'],
  ];
  for (const [dotted, expected] of typeChecks) {
    const value = readPath(raw, dotted);
    if (value !== undefined && typeof value !== expected) {
      throw new Error(`QUALITY_CONFIG_TYPE: ${dotted} must be ${expected}, got ${typeof value}`);
    }
  }
  if (!Array.isArray(raw.limits.enforcedDirs) || raw.limits.enforcedDirs.length === 0) {
    throw new Error('QUALITY_CONFIG_TYPE: limits.enforcedDirs must be a non-empty array');
  }

  // ---- 安全自检：本 Harness 的立身之本不能被配置关掉 ----
  if (raw.security.failClosed !== true) {
    throw new Error('QUALITY_CONFIG_UNSAFE: security.failClosed must be true; the harness refuses to run fail-open.');
  }
  if (raw.database.fixtureOnly !== true) {
    throw new Error('QUALITY_CONFIG_UNSAFE: database.fixtureOnly must be true; desktop E2E must never target a non-fixture database.');
  }
  if (raw.tests.allowFailure !== false) {
    throw new Error('QUALITY_CONFIG_UNSAFE: tests.allowFailure must be false; a gate that tolerates required failures is not a gate.');
  }

  // ---- 解析后的派生值 ----
  return {
    ...raw,
    _root: root,
    _configPath: configPath,
    /** fixture 目录的绝对路径（白名单根）。所有路径判定都必须基于这个值。 */
    fixtureRoot: path.resolve(root, raw.database.fixtureDir),
    /** lint 基线的绝对路径。 */
    lintBaselinePath: path.resolve(root, raw.lint.baselineFile),
  };
}

/**
 * 宽松加载：仅用于「配置不存在也要能跑」的场合（例如 lint-gate 被单独调用做诊断）。
 * 生产路径（runner / dbGuard 默认参数）必须用 loadConfig。
 */
export function tryLoadConfig(root = process.cwd()) {
  try {
    return { ok: true, config: loadConfig(root) };
  } catch (error) {
    return { ok: false, error };
  }
}
