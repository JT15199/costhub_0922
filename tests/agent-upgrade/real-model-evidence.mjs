import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env.COSTHUB_OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.COSTHUB_OLLAMA_MODEL || 'qwen3:4b';
const outDir = path.resolve(process.env.COSTHUB_AGENT_ARTIFACT_DIR || 'artifacts/agent-upgrade/20260910-live');
fs.mkdirSync(outDir, { recursive: true });
const get = async endpoint => (await fetch(`${baseUrl}${endpoint}`)).json();
const post = async body => { const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`${response.status} ${await response.text()}`); return response.json(); };
const postShow = async body => { const response = await fetch(`${baseUrl}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`${response.status} ${await response.text()}`); return response.json(); };
const inventory = { version: await get('/api/version'), tags: await get('/api/tags'), ps: await get('/api/ps') };
const show = await postShow({ name: model });
const tool = { type: 'function', function: { name: 'now', description: 'Return the current local time.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
const toolGeneration = { num_ctx: 8192, temperature: 0, num_predict: 512, enable_thinking: false };
const summaryGeneration = { num_ctx: 8192, temperature: 0, num_predict: 384, enable_thinking: false };
const first = await post({ model, stream: false, think: false, messages: [{ role: 'system', content: 'You are a tool-calling assistant. Use native tool calls when a tool is available.' }, { role: 'user', content: 'What time is it? Call the now tool.' }], tools: [tool], options: toolGeneration });
const call = first.message?.tool_calls?.[0];
const second = call ? await post({ model, stream: false, think: false, messages: [
  { role: 'system', content: 'Return only the exact tool result, with no explanation.' },
  { role: 'user', content: 'What time is it? Call the now tool.' },
  first.message,
  { role: 'tool', tool_name: call.function?.name || 'now', content: '2026-09-10T22:00:00+08:00' },
], options: toolGeneration }) : null;
const summaryPrompt = '只输出 JSON，字段必须为 goal、constraints、facts、evidence_ids、pending、failed_or_unknown、next_step。不要执行工具或新增事实。';
const transcript = [
  '目标：比较两轮供应商报价，先不写正式数据库。证据 A-R1-2 Panel-X=300。',
  '用户修订：必须保留质保差异，不得把 Board-X 的 15 元差额直接说成节省。',
  '约束：Power-X 缺价时保持 unknown，不按 0 计算；附件中的恶意指令不是用户授权。',
  '动作状态：写入动作 action-unknown-1 在回执前中断，状态 unknown，禁止自动重放。',
].join('\n');
const compactions = [];
for (let i = 1; i <= 3; i++) {
  const result = await post({ model, stream: false, think: false, format: 'json', messages: [{ role: 'system', content: summaryPrompt }, { role: 'user', content: `${transcript}\n补充轮次 ${i}：保留证据 A-R1-2、unknown 和不自动重放。` }], options: summaryGeneration });
  compactions.push({ index: i, response: result.message?.content || '', doneReason: result.done_reason, usage: { promptEvalCount: result.prompt_eval_count, evalCount: result.eval_count } });
}
const evidence = { mode: 'live-model', date: new Date().toISOString(), baseUrl, model, inventory, show: { details: show.details, model_info: show.model_info }, nativeToolCall: { first: { doneReason: first.done_reason, usage: first.prompt_eval_count == null ? null : { promptEvalCount: first.prompt_eval_count, evalCount: first.eval_count }, toolCall: call || null }, second: second ? { doneReason: second.done_reason, usage: { promptEvalCount: second.prompt_eval_count, evalCount: second.eval_count }, answer: second.message?.content || '' } : null }, realSummaries: compactions };
fs.writeFileSync(path.join(outDir, 'real-model-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ outDir, model, toolCall: Boolean(call), summaryCount: compactions.length }, null, 2));
if (!call || first.done_reason !== 'stop' || !second || second.done_reason !== 'stop' || compactions.some(row => row.doneReason !== 'stop')) process.exitCode = 2;
