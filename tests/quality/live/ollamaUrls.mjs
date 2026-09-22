// Quality Harness V1 — 本地模型端点解析（不读数据库）
//
// live 档的探测脚本运行在 Node 里，没有 Tauri 的 get_db_path / settings 通道，
// 因此这里只能读环境变量与约定默认值。安全约束：
//   * 只允许回环地址（应用侧的 securityPolicy.ts 也是这个口径）；
//   * localhost 统一改写为 127.0.0.1，避免 Windows 上解析到 IPv6/代理。

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/** 返回允许探测的本地模型 base url。 */
export function getSettinglessOllamaBase() {
  const override = String(process.env.COSTHUB_QUALITY_OLLAMA_URL || '').trim();
  const raw = override || 'http://127.0.0.1:11434';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`COSTHUB_QUALITY_OLLAMA_URL is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`local model endpoint must be http(s), got ${parsed.protocol}`);
  }

  // 硬边界：live 探测只允许回环地址，防止误把局域网/公网地址当成本地模型
  if (!LOOPBACK.has(parsed.hostname)) {
    throw new Error(
      `local model endpoint must be loopback (127.0.0.1 / ::1 / localhost), got "${parsed.hostname}" — refusing to probe a non-local address`,
    );
  }

  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  const port = parsed.port || '11434';
  return `${parsed.protocol}//${host}:${port}`.replace(/\/$/, '');
}
