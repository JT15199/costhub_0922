import { invoke } from '@tauri-apps/api/core';
import type { LocalBackend } from '../localBackend';
import { startOllamaStream } from '../ollama';
import type { PiExecutionContext } from './piExecution';
import { createPiNativeTool } from './piRuntime';
import * as XLSX from 'xlsx';

export interface PiCapability {
  supported: boolean; reason: string; checkedAt: number; digest?: string; ollamaVersion?: string;
  advertisedContext?: number; backend?: LocalBackend; vision?: boolean; build?: string;
  checks?: { toolArguments: boolean; toolResult: boolean }; durationMs?: number;
}
export interface SampleAcceptance { ok: boolean; rows: number; pages: number; total: number; compare: boolean; exportRows: number; reason: string; }

export function runLocalSampleAcceptance(): SampleAcceptance {
  const rows = Array.from({ length: 450 }, (_, index) => ({ id: index + 1, name: index === 400 ? 'TAIL-EXCEPTION-401' : `sample-${index + 1}`, quantity: 1, price: 1 }));
  const pages: Array<typeof rows> = [];
  for (let offset = 0; offset < rows.length; offset += 200) pages.push(rows.slice(offset, offset + 200));
  const merged = pages.flat();
  const total = merged.reduce((sum, row) => sum + row.quantity * row.price, 0);
  const compare = merged.length === rows.length && merged.every((row, index) => row.id === rows[index].id);
  const exportRows = merged.map(row => `${row.name},${row.quantity},${row.price}`).length;
  const ok = merged.length === 450 && pages.length === 3 && merged.some(row => row.name === 'TAIL-EXCEPTION-401') && total === 450 && compare && exportRows === 450;
  return { ok, rows: merged.length, pages: pages.length, total, compare, exportRows, reason: ok ? '长表分页、尾部异常、合计、比较和导出行数均通过' : '样例长表验收失败' };
}

export async function runLocalProductionSampleAcceptance(execution: PiExecutionContext, signal?: AbortSignal): Promise<SampleAcceptance> {
  const rows = Array.from({ length: 450 }, (_, index) => [index + 1, index === 400 ? 'TAIL-EXCEPTION-401' : `sample-${index + 1}`, 1, 1]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '报价样例');
  const source = await execution.env.writeFile('acceptance-sample.xlsx', new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })), signal);
  if (!source.ok) throw source.error;
  const read = createPiNativeTool(execution, 'read');
  if (!read) throw new Error('生产 read 工具未注册');
  const readPage = async (offset: number) => {
    const result: any = await read.execute(`acceptance-read-${offset}`, { path: 'acceptance-sample.xlsx', sheet: '报价样例', offset, limit: 40 }, signal);
    let text = result.content?.[0]?.text || '';
    const preview = JSON.parse(text);
    if (preview.truncated && preview.fullResultPath) {
      const full = await execution.env.readTextFile(preview.fullResultPath);
      if (!full.ok) throw full.error;
      text = full.value;
    }
    const payload = JSON.parse(text);
    const sheet = payload.sheets?.[0];
    return { rows: sheet?.rows || [], nextOffset: sheet?.nextOffset ?? null };
  };
  const pageRows: any[][] = [];
  let nextOffset: number | null = 0;
  while (nextOffset !== null) {
    const page = await readPage(nextOffset);
    pageRows.push(page.rows);
    nextOffset = page.nextOffset;
  }
  const pages = pageRows.length;
  const merged = pageRows.flat();
  const total = merged.reduce((sum: number, row: any[]) => sum + Number(row[2] || 0) * Number(row[3] || 0), 0);
  const compare = merged.length === rows.length && merged.every((row: any[], index) => row[0] === rows[index][0] && row[1] === rows[index][1]);
  const exportRows = merged.map((row: any[]) => row.join(',')).length;
  const output = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(output, XLSX.utils.aoa_to_sheet(merged), '验收导出');
  const exported = await execution.env.writeFile('acceptance-export.xlsx', new Uint8Array(XLSX.write(output, { type: 'array', bookType: 'xlsx' })), signal);
  if (!exported.ok) throw exported.error;
  const reread = await execution.env.readBinaryFile(await execution.env.absolutePath('acceptance-export.xlsx').then(result => { if (!result.ok) throw result.error; return result.value; }));
  if (!reread.ok) throw reread.error;
  const exportBook = XLSX.read(reread.value, { type: 'array' });
  const rereadRows = XLSX.utils.sheet_to_json(exportBook.Sheets['验收导出'], { header: 1, defval: '' }) as any[][];
  const ok = merged.length === 450 && pages > 1 && merged.some((row: any[]) => row[1] === 'TAIL-EXCEPTION-401') && total === 450 && compare && exportRows === 450 && rereadRows.length === 450;
  return { ok, rows: merged.length, pages, total, compare, exportRows, reason: ok ? '真实任务目录已完成 XLSX 分页、尾部异常、合计、比较、导出和回读' : '真实任务目录样例验收失败' };
}
const keyFor = (baseUrl: string, model: string, fingerprint = '', backend: LocalBackend = 'ollama') => `costhub-pi-capability:v4:${backend}:${baseUrl.replace(/\/$/, '')}:${model}:${fingerprint}`;
export function readPiCapability(baseUrl: string, model: string, fingerprint = '', backend: LocalBackend = 'ollama'): PiCapability | null {
  try { const parsed = JSON.parse(localStorage.getItem(keyFor(baseUrl, model, fingerprint, backend)) || 'null'); return parsed?.supported && Date.now() - parsed.checkedAt < 86400000 ? parsed : null; } catch { return null; }
}

async function modelFingerprint(baseUrl: string, model: string, backend: LocalBackend) {
  const base = baseUrl.replace(/\/$/, '');
  if (backend === 'llama.cpp') {
    const response = await invoke<{ success: boolean; body: string }>('http_get', { request: { url: `${base}/props`, headers: {}, body: null, backend } });
    if (!response.success) throw new Error('服务尚未就绪，或不支持 /props；请检查启动日志');
    const props = JSON.parse(response.body);
    const context = Number(props?.default_generation_settings?.n_ctx || props?.n_ctx || 0) || undefined;
    const build = String(props.build_info || '');
    return { key: JSON.stringify([build, props.model_path, props.chat_template, context, props.modalities]), advertisedContext: context, build, vision: Boolean(props.modalities?.vision) };
  }
  const response = await invoke<{ success: boolean; body: string }>('http_get', { request: { url: `${base}/api/tags`, headers: {}, body: null, backend } });
  if (!response.success) throw new Error('Ollama 服务尚未就绪');
  const row = (JSON.parse(response.body).models || []).find((item: any) => item.name === model || item.model === model);
  let advertisedContext: number | undefined;
  try {
    const detail = await invoke<{ success: boolean; body: string }>('http_post', { request: { url: `${base}/api/show`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), backend } });
    const info = JSON.parse(detail.body || '{}')?.model_info || {};
    const contextKey = Object.keys(info).find(key => /context[_-]?length$/i.test(key));
    advertisedContext = contextKey ? Number(info[contextKey]) || undefined : undefined;
  } catch { /* older Ollama versions may not expose model details */ }
  return { key: JSON.stringify([row?.digest || '', advertisedContext || 0]), digest: row?.digest, advertisedContext };
}

const sampleTool = { type: 'function', function: { name: 'check_sample_total', description: 'Sum quantity * price for the supplied synthetic rows. No database access.', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'number' }, price: { type: 'number' } }, required: ['quantity', 'price'] } } }, required: ['rows'] } } };

/** Uses the same Rust stream and delta merger as chat. Only synthetic data; no business tools. */
export async function probePiCapability(baseUrl: string, model: string, force = false, backend: LocalBackend = 'ollama', signal?: AbortSignal): Promise<PiCapability> {
  const started = Date.now();
  const result: PiCapability = { supported: false, reason: '未完成自检', checkedAt: started, backend, checks: { toolArguments: false, toolResult: false } };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 180000);
  const call = async (messages: any[], tools?: any[]) => {
    let text = ''; const calls: any[] = [];
    await new Promise<void>((resolve, reject) => {
      startOllamaStream(baseUrl, model, messages, token => { text += token; }, () => {}, resolve, error => reject(new Error(error)), {
        backend, endpoint: 'native', json: false, think: false, temperature: 0, num_predict: 1024, tools,
        signal: controller.signal, onToolCalls: value => { calls.push(...value); },
      }).catch(reject);
    });
    return { text, calls };
  };
  try {
    if (signal?.aborted) throw new Error('已取消');
    const fingerprint = await modelFingerprint(baseUrl, model, backend);
    Object.assign(result, fingerprint);
    const cached = force ? null : readPiCapability(baseUrl, model, fingerprint.key, backend);
    if (cached) return cached;
    const messages: any[] = [{ role: 'system', content: 'Use the provided tool to calculate the supplied rows. Call it exactly once; do not calculate yourself.' }, { role: 'user', content: 'Call check_sample_total with rows [{"quantity":2,"price":1.25},{"quantity":10,"price":3.5}].' }];
    const first = await call(messages, [sampleTool]);
    if (first.calls.length !== 1 || first.calls[0]?.function?.name !== 'check_sample_total') throw new Error('没有返回预期原生工具调用，请检查模型聊天模板');
    const tool = first.calls[0], fn = tool.function;
    const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    if (!(Array.isArray(args?.rows) && args.rows.length === 2 && args.rows[0].quantity === 2 && args.rows[0].price === 1.25 && args.rows[1].quantity === 10 && args.rows[1].price === 3.5)) throw new Error('嵌套工具参数不正确，未执行样例计算');
    result.checks!.toolArguments = true;
    const id = tool.id || 'sample-1';
    messages.push({ role: 'assistant', content: first.text, tool_calls: [{ ...(backend === 'llama.cpp' ? { id, type: 'function' } : {}), function: { name: fn.name, arguments: backend === 'llama.cpp' ? JSON.stringify(args) : args } }] });
    messages.push({ role: 'tool', ...(backend === 'llama.cpp' ? { tool_call_id: id } : { tool_name: fn.name }), content: JSON.stringify({ total: args.rows.reduce((sum: number, row: any) => sum + row.quantity * row.price, 0), source: 'synthetic sample' }) });
    messages.push({ role: 'user', content: 'Report the total from the tool result. Do not call tools again.' });
    const second = await call(messages);
    if (second.calls.length || !/37[.,]50?/.test(second.text)) throw new Error('工具回传后的结论未通过样例核对');
    result.checks!.toolResult = true;
    result.supported = true;
    result.reason = '流式工具调用、嵌套参数、工具回传与样例合计核对通过';
    result.durationMs = Date.now() - started;
    try { localStorage.setItem(keyFor(baseUrl, model, fingerprint.key, backend), JSON.stringify(result)); } catch { /* no cache */ }
  } catch (error) { result.reason = controller.signal.aborted ? '自检已取消或超时；可在模型加载完成后重试' : String((error as Error).message || error).slice(0, 240); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  result.durationMs = Date.now() - started;
  return result;
}
