import fs from 'node:fs';
import path from 'node:path';
const baseUrl = process.env.COSTHUB_OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.COSTHUB_OLLAMA_MODEL || 'qwen3:4b';
const toolDefinition = { type: 'function', function: { name: 'now', description: 'Current time', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, messages: [{ role: 'system', content: 'You are a tool-calling assistant. Use native tool calls when a tool is available.' }, { role: 'user', content: 'What time is it? Call the now tool.' }], tools: [toolDefinition], options: { num_ctx: 8192, enable_thinking: false, temperature: 0, num_predict: 512 } }) });
if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
const result = await response.json();
const call = result.message?.tool_calls?.[0];
let followup = null;
if (call) {
  const followupMessages = [
    { role: 'system', content: 'Return only the exact tool result, with no explanation.' },
    { role: 'user', content: 'What time is it? Call the now tool.' }, result.message,
    { role: 'tool', tool_name: call.function?.name || 'now', content: '2026-09-10T22:00:00+08:00' },
  ];
  const second = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, messages: followupMessages, options: { num_ctx: 8192, enable_thinking: false, temperature: 0, num_predict: 512 } }) });
  if (!second.ok) throw new Error(`${second.status} ${await second.text()}`);
  followup = await second.json();
  if (followup.done_reason === 'length') {
    const retry = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, messages: followupMessages, options: { num_ctx: 8192, enable_thinking: false, temperature: 0, num_predict: 768 } }) });
    if (!retry.ok) throw new Error(`${retry.status} ${await retry.text()}`);
    followup = await retry.json();
  }
}
const evidence = { mode: 'live-model', model, first: { doneReason: result.done_reason, usage: { promptEvalCount: result.prompt_eval_count, evalCount: result.eval_count }, message: result.message }, followup: followup ? { doneReason: followup.done_reason, usage: { promptEvalCount: followup.prompt_eval_count, evalCount: followup.eval_count }, message: followup.message } : null };
const outDir = path.resolve(process.env.COSTHUB_AGENT_ARTIFACT_DIR || 'artifacts/agent-upgrade/20260910-live-tool');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'real-tool-call.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ outDir, model, doneReason: result.done_reason, toolCalls: result.message?.tool_calls?.length || 0, followupDoneReason: followup?.done_reason || null }, null, 2));
if (!call || result.done_reason === 'length' || followup?.done_reason === 'length') process.exitCode = 2;
