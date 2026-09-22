// Synthetic HTTP smoke only: no application DB or business writes.
const base = 'http://127.0.0.1:8080';
const models = await (await fetch(base + '/v1/models')).json();
const model = models.data[0].id;
const messages = [{ role: 'user', content: 'Call check_sample_total with rows [{"quantity":2,"price":1.25},{"quantity":10,"price":3.5}]. Use the tool exactly once.' }];
const tools = [{ type: 'function', function: { name: 'check_sample_total', description: 'Calculate quantity times price total.', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'number' }, price: { type: 'number' } }, required: ['quantity', 'price'] } } }, required: ['rows'] } } }];
async function call(tools) {
  const start = Date.now();
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, tools, stream: false, temperature: 0, max_tokens: 1024, chat_template_kwargs: { enable_thinking: false, preserve_thinking: false } }), signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  console.log(JSON.stringify({ status: response.status, elapsedMs: Date.now() - start, choices: body.choices, usage: body.usage, error: body.error }));
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return body.choices[0].message;
}
const first = await call(tools);
const tool = first.tool_calls?.[0];
if (!tool || first.tool_calls.length !== 1 || tool.function.name !== 'check_sample_total') throw new Error('Expected native tool call missing');
const args = JSON.parse(tool.function.arguments);
if (JSON.stringify(args.rows) !== JSON.stringify([{quantity:2,price:1.25},{quantity:10,price:3.5}])) throw new Error('Incorrect nested arguments');
messages.push(first, { role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ total: 37.5, source: 'synthetic' }) }, { role: 'user', content: 'Report the tool total.' });
const last = await call(undefined);
if (!/37\.5/.test(last.content || '')) throw new Error('Expected final tool total missing');
console.log('PASS: native nested tool call and result round trip (HTTP only).');
