// Quality Harness V1 — 报告脱敏（测试侧独立实现）
//
// 设计约束（来自实施指导 §5.2）：
//   * 只用于「测试报告脱敏」，禁止 import 生产隐私模块（src/ai/privacyRouter.ts 等）
//     —— 否则会把应用运行环境依赖拖进纯 Node 的 runner。
//   * 报告里禁止出现：API Key / Bearer Token / 密码 / Windows 用户目录 /
//     本机用户名 / 私钥 / 完整绝对业务路径。
//
// 这是一个「宁多杀不放过」的过滤器：它只需要保证报告不自证泄漏，
// 因此对疑似凭据一律替换为占位符，不尝试保留可读性。

/** 需要保留原样、不做路径折叠的占位串。 */
const PLACEHOLDER = '[redacted]';

/** 允许出现在报告里的相对路径根名（项目内目录，不含用户名）。 */
const SAFE_SEGMENTS = null;

/**
 * 已知的环境变量名 → 值，用于把「实际出现的秘密值」直接抹掉。
 * 这是我们最强的一道防线：即使某个秘密以未预期的格式打印出来，
 * 只要它来自这些环境变量，也会被逐字替换。
 */
function envSecretValues() {
  const names = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'SERPAPI_API_KEY',
    'TAVILY_API_KEY',
    'BRAVE_API_KEY',
    'BING_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'COSTHUB_API_KEY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    // V2：fixture 测试密码（可能来自环境变量，也可能是 runner 生成的一次性随机值）。
    // 无论来源如何，都不允许出现在报告文本里。
    'QUALITY_TEST_PASSWORD',
  ];
  const values = [];
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length >= 8) values.push(value.trim());
  }
  return values;
}

/** Windows / POSIX 用户主目录前缀，替换为 <home>。 */
function homePrefixes() {
  const out = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) out.push(home);
  const drive = process.env.HOMEDRIVE || '';
  const path = process.env.HOMEPATH || '';
  if (drive && path) out.push(drive + path);
  return out.filter(Boolean);
}

const RULES = [
  // 私钥块：整块吃掉（含首尾行）
  { id: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[redacted-private-key]' },

  // URL 内嵌凭据 https://user:pass@host
  { id: 'url_credentials', pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: `$1${PLACEHOLDER}@` },

  // Authorization / Bearer
  { id: 'bearer', pattern: /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, replacement: `Bearer ${PLACEHOLDER}` },
  { id: 'authorization_header', pattern: /\b(authorization\s*["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, replacement: `$1${PLACEHOLDER}` },

  // 常见厂商 key 前缀
  { id: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: 'sk-[redacted]' },
  { id: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replacement: 'sk-ant-[redacted]' },
  { id: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: 'AIza[redacted]' },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: 'gh[redacted]' },
  { id: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: 'xox[redacted]' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: '[redacted-jwt]' },

  // key=value / key": "value 形式的凭据字段
  {
    id: 'credential_field',
    pattern: /\b((?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|password|passwd|pwd|token|credential)\s*["']?\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi,
    replacement: `$1${PLACEHOLDER}`,
  },

  // --flag=value 形式的凭据
  { id: 'credential_flag', pattern: /(--(?:api-?key|token|password|secret)[=\s]+)([^\s"']+)/gi, replacement: `$1${PLACEHOLDER}` },

  // 邮箱与手机号（可能来自日志里的账号）
  { id: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[redacted-email]' },
  { id: 'phone_cn', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[redacted-phone]' },
];

/**
 * 折叠绝对路径，避免泄漏本机用户名与目录结构。
 * 保留相对于仓库根的尾部片段，前缀替换为 <path>。
 */
function foldPaths(text) {
  let out = text;
  // Windows 盘符绝对路径：C:\Users\x\repo\a\b.ts → <path>/a/b.ts（保留末 3 段）
  out = out.replace(/\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]*/g, match => tailOf(match));
  // UNC 路径 \\server\share\...
  out = out.replace(/\\\\[^\\/\s"'<>|]+[\\/][^\\/\s"'<>|]+(?:[\\/][^\\/\s"'<>|]+)*/g, match => tailOf(match));
  // POSIX 绝对路径 /home/x/... /Users/x/... /tmp/...
  out = out.replace(/(?<![\w.])\(?(\/(?:home|Users|tmp|root|var|opt|mnt)\/[^\s"'<>|)]*)/g, match => tailOf(match));
  return out;
}

/** 只保留路径的最后 3 段，其余替换为 <path>。 */
function tailOf(rawPath) {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(part => part.length > 0 && part !== '.');
  if (parts.length <= 3) return `<path>/${parts.join('/')}`;
  return `<path>/…/${parts.slice(-3).join('/')}`;
}

/**
 * 脱敏主入口。
 * @param {unknown} input 任意值；非字符串会先 JSON/字符串化
 * @returns {string}
 */
export function redact(input) {
  if (input == null) return '';
  let text = typeof input === 'string' ? input : safeStringify(input);

  // 1) 先抹掉来自环境变量的真实秘密值（最强防线，逐字替换）
  for (const secret of envSecretValues()) {
    text = text.split(secret).join(PLACEHOLDER);
  }
  // 2) 用户主目录前缀
  for (const home of homePrefixes()) {
    text = text.split(home).join('<home>');
    text = text.split(home.replace(/\\/g, '/')).join('<home>');
  }
  // 3) 模式规则
  for (const rule of RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  // 4) 路径折叠（放在凭据规则之后，避免破坏已替换内容）
  text = foldPaths(text);
  return text;
}

/** 截断到指定长度并标注省略量，避免报告体积失控。 */
export function redactTail(input, maxChars = 4000) {
  const text = redact(input);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

/** 敏感字段名：命中则整值替换，不依赖值本身长得像秘密。 */
const SENSITIVE_KEY = /(api[_-]?key|apikey|secret|password|passwd|pwd|token|credential|private[_-]?key|authorization|cookie|session)/i;

/**
 * 深度脱敏一个对象（用于写入 JSON 报告）。
 *
 * 关键点：不能只对「叶子值」调用 redact()。
 * 像 `{ token: "abc..." }` 这种结构，秘密本身没有任何可识别格式，
 * 只有字段名能暴露它是凭据——逐值脱敏会漏掉它（曾被 self-check 抓到）。
 * 因此这里做两道：
 *   1) 敏感字段名 → 整值替换
 *   2) 整个对象先 JSON 序列化后跑一遍 redact()，再解析回来，
 *      这样「key: value」相邻结构对模式规则可见
 */
export function redactDeep(value, depth = 0) {
  if (depth > 12) return '[redacted-depth]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactDeep(item, depth + 1);
    }
    return out;
  }
  return redact(String(value));
}

/**
 * 报告落盘前的最后一道：整个 summary 走一遍「序列化 → redact → 反序列化」，
 * 让跨字段的模式（如 key 与 value 相邻）也能被规则命中。
 * 解析失败时退回 redactDeep（宁可不美化，也不能泄漏）。
 */
export function redactSummary(summary) {
  const structural = redactDeep(summary);
  try {
    const asText = JSON.stringify(structural);
    const scrubbed = redact(asText);
    return JSON.parse(scrubbed);
  } catch {
    return structural;
  }
}

/** 安全 JSON 化（处理循环引用与 BigInt）。 */
export function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    return String(value);
  }
}

/** 供 runner 自检：确认脱敏规则确实生效。 */
export function redactSelfTest() {
  const probes = [
    ['api_key=sk-abcdefghijklmnopqrstuvwxyz012345', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'],
    ['password: hunter2hunter2', 'hunter2hunter2'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'MIIabc'],
    ['contact user@example.com', 'user@example.com'],
  ];
  const failures = [];
  for (const [input, secret] of probes) {
    if (redact(input).includes(secret)) failures.push(input);
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home && redact(`file at ${home}\\secret\\x.txt`).includes(home)) failures.push(`home:${home}`);
  return { ok: failures.length === 0, failures, safeSegments: SAFE_SEGMENTS };
}
