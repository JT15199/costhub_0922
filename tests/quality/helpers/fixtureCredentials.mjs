// Quality Harness V2 — fixture 测试凭据（V2 要求 #4）
//
// 规则：
//   * 仓库中**不得**出现明文 fixture 密码（V1 曾在 fixtureData / README / actions 中硬编码一个固定口令）；
//   * 优先使用环境变量（由 CI 或人工提供），便于复现与人工登录排查；
//   * 未提供环境变量时，由 runner 生成**一次性随机密码**，
//     只存在于「进程环境 + 一次性凭据文件」中，不落 git、不进报告。
//
// 为什么不是「没有环境变量就直接失败」：
//   那会让 `npm run quality:full` 在任何人未预设变量的情况下必定失败，
//   与 V2 目标 4（避免质量框架反过来增加业务维护成本）直接冲突。
//   随机生成同样满足「禁止明文密码」这一核心诉求，且不牺牲开箱可用性。
//
// 为什么要一个凭据文件：
//   quality:full 由 runner 顺序启动 **多个独立进程**
//   （prepare-fixture.mjs 建库、run-e2e.mjs 登录），它们不共享内存。
//   若两边各自随机生成，密码必然不一致，登录就会失败。
//   因此 runner 生成一次并写入运行目录下的一次性文件，子步骤按同一优先级读取。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 生成一次性强随机密码（URL 安全字符集，长度足够抵抗暴力尝试）。 */
export function generateFixturePassword(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 计算 fixture 使用的 SHA-256 密码哈希（与 src/db/auth.ts 的校验口径一致）。 */
export function hashFixturePassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

/** 一次性凭据文件路径（位于本次运行目录，随 artifacts/ 一起被 gitignore）。 */
export function credentialFilePath(runDir) {
  return runDir ? path.join(runDir, '.fixture-credential') : null;
}

/**
 * 把凭据写入一次性文件，权限收紧到仅本用户可读写。
 * 不写入 stdout、不写入报告。
 */
export function persistFixtureCredential(runDir, credential) {
  const file = credentialFilePath(runDir);
  if (!file) return null;
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(credential)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * 解析本次运行使用的 fixture 凭据。
 *
 * 优先级：环境变量 > 一次性凭据文件 > 新生成。
 * 这样 runner 与独立调用的子步骤会得到同一个密码。
 *
 * @param {object} config 由 helpers/config.mjs 加载的配置
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{username: string, password: string, passwordHash: string, source: 'env'|'run-file'|'generated'}}
 */
export function resolveFixtureCredentials(config, env = process.env) {
  const envVar = config.fixture.passwordEnvVar;
  const fromEnv = typeof env[envVar] === 'string' ? env[envVar].trim() : '';
  if (fromEnv) {
    return { username: config.fixture.username, password: fromEnv, passwordHash: hashFixturePassword(fromEnv), source: 'env' };
  }

  const file = credentialFilePath(env.QUALITY_RUN_DIR);
  if (file && fs.existsSync(file)) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof stored?.password === 'string' && stored.password.length > 0) {
        return {
          username: stored.username || config.fixture.username,
          password: stored.password,
          passwordHash: hashFixturePassword(stored.password),
          source: 'run-file',
        };
      }
    } catch {
      // 文件损坏 → 退回生成（不会静默用错密码：生成后写文件，两边仍一致）
    }
  }

  const generated = generateFixturePassword();
  return {
    username: config.fixture.username,
    password: generated,
    passwordHash: hashFixturePassword(generated),
    source: 'generated',
  };
}

/** 环境变量名列表：这些值必须被报告脱敏逐字抹除。 */
export function fixtureSecretEnvNames(config) {
  return [config.fixture.passwordEnvVar];
}
