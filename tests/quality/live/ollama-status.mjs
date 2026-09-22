#!/usr/bin/env node
// Quality Harness V1 — 本地模型可用性探测（live 档 L01）
//
// 存在的意义（实施指导 §5.4 / §14）：
//   「Ollama 不存在」必须被判为 BLOCKED_ENVIRONMENT，
//   **不能伪装成 PASS**，也不能让 live 档的缺失拖累 core/full。
//
// 退出码契约（被 profiles.mjs 的 blockedExitCodes 消费）：
//   0 = Ollama 在线且至少有一个可用模型
//   3 = 环境不具备（未运行 / 无模型）→ runner 记为 blocked
//   1 = 探测本身出错（非环境问题）

import { getSettinglessOllamaBase } from './ollamaUrls.mjs';

const TIMEOUT_MS = 8000;

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const base = getSettinglessOllamaBase();
console.log(`[live] probing local model runtime at ${base} …`);

const version = await probe(`${base}/api/version`);
if (!version.ok) {
  console.error('BLOCKED_ENVIRONMENT: local model runtime is not reachable.');
  console.error(`  endpoint : ${base}`);
  console.error(`  detail   : ${version.error || `HTTP ${version.status}`}`);
  console.error('  meaning  : live gate cannot run. This is NOT a pass and NOT a code failure.');
  console.error('  action   : start Ollama (or configure a local backend), then rerun npm run quality:live');
  process.exit(3);
}

const tags = await probe(`${base}/api/tags`);
const models = Array.isArray(tags.body?.models) ? tags.body.models.map(model => model.name).filter(Boolean) : [];

console.log(`[live] runtime version: ${version.body?.version || 'unknown'}`);
console.log(`[live] models available: ${models.length}`);

if (models.length === 0) {
  console.error('BLOCKED_ENVIRONMENT: local model runtime is running but has no models installed.');
  console.error('  action: pull a model, e.g. ollama pull qwen3:4b');
  process.exit(3);
}

console.log(JSON.stringify({
  ok: true,
  base,
  version: version.body?.version || null,
  modelCount: models.length,
  models: models.slice(0, 20),
  note: 'Model names only; no inference performed at this step.',
}, null, 2));
console.log('OLLAMA READY');
process.exit(0);
