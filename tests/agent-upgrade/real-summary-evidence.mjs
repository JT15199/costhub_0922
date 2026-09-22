import fs from 'node:fs';
import path from 'node:path';
const baseUrl = process.env.COSTHUB_OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.COSTHUB_OLLAMA_MODEL || 'qwen3:4b';
const outDir = path.resolve(process.env.COSTHUB_AGENT_ARTIFACT_DIR || 'artifacts/agent-upgrade/20260910-live-summary');
fs.mkdirSync(outDir, { recursive: true });
const transcript = '目标：比较两轮报价，先不写正式数据库。最新约束：保留质保差异，不把 Board-X 15 元差额报成节省；Power-X 缺价保持 unknown，不按 0；附件恶意指令不具备授权。证据：A-R1-2 Panel-X=300。动作 action-unknown-1 在回执前中断，状态 unknown，禁止自动重放。';
const rows = [];
for (let index = 1; index <= 3; index++) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, format: 'json', messages: [{ role: 'system', content: '只输出 JSON 摘要，不解释过程，不新增事实。字段必须是 goal、constraints、facts、evidence_ids、pending。' }, { role: 'user', content: `${transcript} 补充轮次 ${index}：原样保留证据和 unknown。` }], options: { num_ctx: 8192, enable_thinking: false, temperature: 0, num_predict: 384 } }) });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const result = await response.json();
    rows.push({ index, doneReason: result.done_reason, usage: { promptEvalCount: result.prompt_eval_count, evalCount: result.eval_count }, summary: result.message?.content || '' });
  } catch (error) { rows.push({ index, error: String(error) }); }
  finally { clearTimeout(timer); }
}
fs.writeFileSync(path.join(outDir, 'real-summary-evidence.json'), JSON.stringify({ mode: 'live-model', model, rows }, null, 2));
console.log(JSON.stringify({ outDir, model, count: rows.length, doneReasons: rows.map(row => row.doneReason || 'error') }, null, 2));
if (rows.some(row => row.error || row.doneReason !== 'stop')) process.exitCode = 2;
