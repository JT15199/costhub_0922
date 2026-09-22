import { createSpreadsheetTool } from './spreadsheetTool';
import { schemaFor, prepareBusinessArgs } from './toolSchema';
import { createBashTool, createEditTool, createReadTool, createWriteTool, formatSkillsForSystemPrompt, type Agent, type AgentEvent, type AgentTool, type AgentMessage } from '@earendil-works/pi-agent-core';
import { Type, type ImageContent } from '@earendil-works/pi-ai';
import { listTools, type AiTool } from '../aiTools';
import type { AiToolResult } from './contracts';
import { getToolManifest } from './toolRegistry';
import { createAiGatewayStream, type AiGatewayRoute, type AiGatewayTraceEvent } from './gateway';
import type { CloudProvider } from './cloudProvider';
import type { CloudSafeContext, CloudSafeDropCounts } from './cloudContext';
import { deriveContextSourceTypes, type PrivacyDecision } from './privacyRouter';
import type { PiExecutionContext } from './piExecution';
import { parseAnalysisChart, renderAnalysisSvg, type ChartArtifact } from './analysisChart';
import { compactContext, type CompactionPolicy, type CompactionStats, type CompactionState } from './contextPolicy';
import { createModelProfile, type ModelProfile, type ModelUsage } from './modelProfile';
import { createDiscoveryTools, discoverTools, formatToolCatalog, isDiscoveryTool, parseActivatedToolIds } from './toolSelection';
import { PiTaskHost } from './piHarness';
import { commitWorkingContext } from './piWorkingContext';
import type { LocalBackend } from '../localBackend';
import { createResultStore, externalizeAgentToolResult, resultReferenceText, type ResultStore } from './resultStore';
import { normalizeWorkingState, updateWorkingState, withStableMessageId, type WorkingState } from './workingState';
import { buildLocalContext } from './contextBuilder';
import type { ContextMetadata } from './contextMetadata';
import type { LocalPrivacyClassifier } from './privacyRouter';

const contentText = (content: any[]) => content.filter(part => part?.type === 'text').map(part => part.text).join('');
const messageText = (message: any) => Array.isArray(message?.content)
  ? message.content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text || '')).join('')
  : String(message?.content ?? '');
const toImage = (data: string): ImageContent => {
  const match = data.match(/^data:([^;]+);base64,(.*)$/);
  return { type: 'image', mimeType: match?.[1] || 'image/png', data: match?.[2] || data };
};

export async function prepareToolResult(result: { ok: boolean; text: string; result?: AiToolResult<unknown> }, execution?: PiExecutionContext, signal?: AbortSignal, resultStore?: ResultStore, toolName = 'tool') {
  const fullText = result.result ? JSON.stringify(result.result, null, 2) : result.text;
  if (fullText.length <= 6000 || !execution) return { content: [{ type: 'text' as const, text: fullText }], details: result, isError: !result.ok };
  const stored = await (resultStore || createResultStore(execution)).store(toolName, fullText, result.text.slice(0, 1000), signal);
  return {
    content: [{ type: 'text' as const, text: resultReferenceText(stored, { ok: result.ok, warnings: result.result?.warnings || [] }) }],
    details: { ...result, resultId: stored.id, fullResultPath: stored.fullContentPath, storedResult: stored }, isError: !result.ok,
  };
}

export function nativeToolPrompt(prompt: string): string {
  return prompt
    .replace(/【工具调用协议】[\s\S]*?【工具】/u, '【原生工具调用】需要数据时直接调用已提供的原生 function/tool；不要在正文输出工具名、JSON 或伪造调用标记。\n【工具】')
    .replace(/\[(?:TOOL|RESULT|CLOUD)\]/g, '原生工具标记');
}

function historyMessages(history: Array<{ role: 'user' | 'assistant'; content: string }>): AgentMessage[] {
  // Raw history is persisted in SQLite. Context reduction belongs to Pi's
  // transformContext so a restart never silently loses the older turns.
  return history.filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ role: message.role, content: [{ type: 'text', text: message.content }], timestamp: Date.now() } as AgentMessage));
}

export interface PiRunMetrics {
  elapsedMs: number; modelMs: number; checkpointMs: number; toolMs: number;
  firstModelOutputMs?: number; firstToolMs?: number; toolCalls: number;
  inputTokens: number; outputTokens: number; rounds: number;
}
export interface PiRunOptions {
  baseUrl: string;
  model: string;
  backend?: LocalBackend;
  systemPrompt: string;
  userContent: string;
  tools: AiTool[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  agentMessages?: AgentMessage[];
  execution?: PiExecutionContext;
  images?: string[];
  think?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  profile?: ModelProfile;
  runId?: string;
  sessionId?: number;
  workingState?: WorkingState;
  compactionState?: CompactionState;
  compactionPolicy?: Partial<CompactionPolicy>;
  privacySourceTypes?: string[];
  privacyMetadata?: ContextMetadata[];
  localPrivacyClassifier?: LocalPrivacyClassifier;
  executeTool: (id: string, args: Record<string, unknown>, signal?: AbortSignal, callId?: string, trace?: (event: AiGatewayTraceEvent) => void) => Promise<{ ok: boolean; text: string; result?: AiToolResult<unknown> }>;
  onMetrics?: (metrics: PiRunMetrics) => Promise<void> | void;
  onGatewayTrace?: (event: AiGatewayTraceEvent) => void;
  gatewayRoute?: AiGatewayRoute;
  cloud?: { context: CloudSafeContext; privacyDecision: PrivacyDecision; provider: CloudProvider; localMessageCount?: number; dropped?: CloudSafeDropCounts; requestId?: string };
  onAgentReady?: (agent: Agent) => void;
  historySearch?: (query: string, limit?: number) => Promise<unknown>;
  historyRead?: (reference: string) => Promise<unknown>;
  onCheckpoint?: (messages: AgentMessage[], pending?: { id: string; name: string }, workingState?: WorkingState, compactionState?: CompactionState) => Promise<void>;
  onRawMessage?: (message: AgentMessage) => Promise<void>;
  onEvent?: {
    onExecutionReady?: (workspace: string, diagnostics: string[]) => void;
    onChart?: (artifact: ChartArtifact) => void;
    onToolProgress?: (name: string, text: string, callId: string) => void;
    onThought?: (text: string) => void;
    onAnswer?: (text: string) => void;
    onToolStart?: (name: string, args: any, callId: string) => void;
    onToolResult?: (name: string, args: any, ok: boolean, text: string, result?: AiToolResult<unknown>, callId?: string) => void;
    onCloudResult?: (args: any, ok: boolean, text: string) => void;
    onRoundStart?: (round: number) => void;
    onUsage?: (usage: ModelUsage) => void;
    onCompaction?: (stats: CompactionStats) => void;
  };
}

function nativeExecutionTools(execution?: PiExecutionContext, events?: PiRunOptions['onEvent'], history?: Pick<PiRunOptions, 'historySearch' | 'historyRead'>, resultStore?: ResultStore): AgentTool[] {
  if (!execution) return [];
  const normalizeTaskPath = (value: string) => {
    const stripLongPrefix = (path: string) => path.startsWith('\\\\?\\') ? path.slice(4) : path;
    const root = stripLongPrefix(execution.workspace).replace(/[\\/]+$/, '');
    const path = stripLongPrefix(value).replace(/\//g, '\\');
    const lowerRoot = root.toLocaleLowerCase();
    const lowerPath = path.toLocaleLowerCase();
    if (lowerPath === lowerRoot) return '.';
    if (lowerPath.startsWith(`${lowerRoot}\\`)) return path.slice(root.length + 1);
    return value;
  };
  const normalizeTaskArgs = (args: any) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const next = { ...args };
    for (const key of ['path', 'sourcePath', 'destinationPath', 'secondPath']) {
      if (typeof next[key] === 'string') next[key] = normalizeTaskPath(next[key]);
    }
    return next;
  };
  const wrap = (tool: any, env = execution.env): AgentTool => ({
    ...tool,
    execute: (callId: string, args: any, signal?: AbortSignal, onUpdate?: any) => tool.execute(callId, normalizeTaskArgs(args), signal, onUpdate, { env }),
  });
  const readTool = wrap(createReadTool());
  const readProperties = ((readTool.parameters as any)?.properties || {}) as Record<string, unknown>;
  const read: AgentTool = {
    ...readTool,
    description: `${readTool.description} For .xlsx/.xls files, return structured worksheet rows instead of binary text. For totals, reconciliation or quote comparison use analyze_spreadsheet: inspect first, then calculate over the full range. Read rows only to clarify mapping or exceptions.`,
    parameters: Type.Object({
      ...readProperties,
      sheet: Type.Optional(Type.String({ description: 'Excel 工作表名；不填时读取第一个工作表，可先查看 availableSheets' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Excel 文件使用 0-based；普通文本文件沿用原生 1-based，默认从文件开头读取' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Excel 每页最大行数；普通文本文件为最大行数，Excel 默认 8，普通文本沿用原生默认值' })),
      charOffset: Type.Optional(Type.Integer({ minimum: 0, description: '仅结果续读：当前行内的 0-based 字符起点，用于超长单行' })),
    }),
    execute: async (callId: string, rawArgs: any, signal?: AbortSignal, onUpdate?: any) => {
      const args = normalizeTaskArgs(rawArgs) as { path?: string; sheet?: string; offset?: number; limit?: number; charOffset?: number };
      if (/^\.costhub-results[\\/]/i.test(args.path || '')) {
        const absolute = await execution.env.absolutePath(args.path || '');
        if (!absolute.ok) throw absolute.error;
        const saved = await execution.env.readTextFile(absolute.value);
        if (!saved.ok) throw saved.error;
        const lines = saved.value.split(/\r?\n/);
        let start = args.offset ? Math.max(0, Math.floor(args.offset) - 1) : 0;
        const take = Math.min(200, Math.max(1, Math.floor(args.limit || 40)));
        if (start >= lines.length) throw new Error(`Offset ${args.offset} is beyond end of result (${lines.length} lines total)`);
        let charOffset = Math.max(0, Math.floor(args.charOffset || 0));
        const initialLine = start;
        const initialCharOffset = charOffset;
        const page: string[] = [];
        let responseChars = 0;
        const maxResponseChars = 6000;
        while (start < lines.length && page.length < take && responseChars < maxResponseChars) {
          const available = lines[start].slice(charOffset);
          if (!available) { start++; charOffset = 0; continue; }
          const room = Math.max(1, maxResponseChars - responseChars);
          const piece = available.slice(0, room);
          page.push(piece); responseChars += piece.length;
          if (piece.length < available.length) { charOffset += piece.length; break; }
          start++; charOffset = 0;
        }
        const hasRemainder = start < lines.length && (charOffset > 0 || page.length >= take || responseChars >= maxResponseChars);
        const nextOffset = start < lines.length ? start + 1 : null;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ file: args.path, format: 'line-addressable-result', offset: initialLine + 1, charOffset: initialCharOffset, returnedLines: page.length, totalLines: lines.length, nextOffset: hasRemainder ? nextOffset : null, ...(charOffset ? { nextCharOffset: charOffset } : {}), lines: page }) }], details: { file: args.path, offset: initialLine + 1, returnedLines: page.length, totalLines: lines.length, nextOffset } };
      }
      if (!/\.(xlsx|xls)$/i.test(args.path || '')) return readTool.execute(callId, args, signal, onUpdate);
      const absolute = await execution.env.absolutePath(args.path || '');
      if (!absolute.ok) throw absolute.error;
      const binary = await execution.env.readBinaryFile(absolute.value);
      if (!binary.ok) throw binary.error;
      const xlsx = await import('xlsx');
      const workbook = xlsx.read(binary.value, { type: 'array' });
      const offset = Math.max(0, Math.floor(args.offset || 0));
      let limit = Math.min(200, Math.max(1, Math.floor(args.limit || 8)));
      const availableSheets = workbook.SheetNames;
      const names = args.sheet ? [args.sheet] : availableSheets.slice(0, 1);
      if (args.sheet && !workbook.SheetNames.includes(args.sheet)) throw new Error(`worksheet not found: ${args.sheet}`);
      const allRows = names.map(name => ({ name, rows: xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }) as unknown[][] }));
      const previewCell = (value: unknown) => typeof value === 'string' && value.length >= 120 ? `${value.slice(0, 80)}…[${value.length} chars]` : value;
      const compactRow = (row: unknown[]) => {
        const out: unknown[] = [];
        let used = 0;
        for (let index = 0; index < row.length; index++) {
          const cell = previewCell(row[index]);
          const size = String(cell ?? '').length;
          if (used + size > 5000) { out.push(`[+${row.length - index} columns omitted; use sheet/offset/limit to continue]`); break; }
          out.push(cell); used += size;
        }
        return out;
      };
      const makeSheets = (take: number, compact = false) => allRows.map(({ name, rows }) => {
        const page = rows.slice(offset, offset + take);
        return { name, totalRows: rows.length, offset, returnedRows: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null, rows: compact ? page.map(compactRow) : page };
      });
      const makePayload = (take: number, compact = false) => ({ file: args.path, sheet: args.sheet || null, availableSheets, sheets: makeSheets(take, compact), offset, limit: take });
      const makePreview = () => {
        let take = Math.min(limit, 20);
        let preview = JSON.stringify(makePayload(take, true), null, 2);
        while (preview.length > 8000 && take > 1) { take = Math.max(1, Math.floor(take * 0.5)); preview = JSON.stringify(makePayload(take, true), null, 2); }
        return preview;
      };
      let payload = makePayload(limit);
      let text = JSON.stringify(payload, null, 2);
      // ponytail: cap one native result; continuation uses nextOffset, long cells use a preview plus a task file.
      while (text.length > 8000 && limit > 1) { limit = Math.max(1, Math.floor(limit * 0.75)); payload = makePayload(limit); text = JSON.stringify(payload, null, 2); }
      let fullResultPath: string | undefined;
      if (text.length > 8000 && typeof execution.env.writeFile === 'function') {
        fullResultPath = `.costhub-results/${crypto.randomUUID()}.txt`;
        const lines = [`# CostHub result: ${args.path || ''}`];
        for (const sheet of payload.sheets) for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex++) for (let column = 0; column < sheet.rows[rowIndex].length; column++) {
          const value = String(sheet.rows[rowIndex][column] ?? '');
          const chunkSize = 4000;
          for (let start = 0; start < Math.max(1, value.length); start += chunkSize) lines.push(JSON.stringify({ sheet: sheet.name, row: sheet.offset + rowIndex, column, chunk: Math.floor(start / chunkSize), text: value.slice(start, start + chunkSize) }));
        }
        const saved = await execution.env.writeFile(fullResultPath, lines.join('\n'), signal);
        if (!saved.ok) throw saved.error;
        text = JSON.stringify({ ...JSON.parse(makePreview()), truncated: true, fullResultPath, instruction: '当前消息仅含单元格和列数预览；完整页已落盘为可按行/字符块读取的结果。用 read(path, offset, limit) 无需 Shell 续读，或按 nextOffset 继续，不能把预览当作完整证据。' }, null, 2);
      } else if (text.length > 8000) {
        text = JSON.stringify({ ...JSON.parse(makePreview()), truncated: true, instruction: '当前消息仅含单元格和列数预览；请用 sheet/offset/limit 继续读取，不能把预览当作完整证据。' }, null, 2);
      }
      return { content: [{ type: 'text' as const, text }], details: { file: args.path, sheet: args.sheet || null, availableSheets, sheets: makeSheets(limit).map(({ name, totalRows, offset: pageOffset, returnedRows, nextOffset }) => ({ name, totalRows, offset: pageOffset, returnedRows, nextOffset })), ...(fullResultPath ? { fullResultPath } : {}) } };
    },
  };
  const powershell: AgentTool = {
    name: 'powershell', label: 'PowerShell',
    description: 'Run a PowerShell command in the task workspace. stdout/stderr are returned; long output is saved to the task workspace.',
    parameters: Type.Object({ command: Type.String({ description: 'PowerShell command' }), timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })) }),
    execute: async (callId: string, rawArgs: unknown, signal?: AbortSignal) => {
      const args = rawArgs as { command: string; timeout?: number };
      const result = await execution.env.exec(args.command, { timeout: args.timeout, abortSignal: signal, onStdout: value => events?.onToolProgress?.('powershell', value, callId), onStderr: value => events?.onToolProgress?.('powershell', value, callId) });
      if (!result.ok) throw result.error;
      const details = result.value as { stdout: string; stderr: string; exitCode: number; fullOutputPath?: string };
      if (details.exitCode !== 0) throw new Error(JSON.stringify(details));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...details, fullOutputPath: details.fullOutputPath || `${execution.workspace}/.costhub-output` }) }], details };
    },
  };
  const scriptTool = (name: 'python' | 'node', env: PiExecutionContext['pythonEnv']) => env ? ({
    name, label: name === 'python' ? 'Python（隔离）' : 'Node（隔离）',
    description: `Run ${name} source in the isolated task workspace. No network capability or user secret environment is inherited.`,
    parameters: Type.Object({ code: Type.String({ description: `${name} source code` }), timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })) }),
    execute: async (callId: string, rawArgs: unknown, signal?: AbortSignal) => {
      const args = rawArgs as { code: string; timeout?: number };
      const result = await env.exec(args.code, { timeout: args.timeout, abortSignal: signal, onStdout: value => events?.onToolProgress?.(name, value, callId), onStderr: value => events?.onToolProgress?.(name, value, callId) });
      if (!result.ok) throw result.error;
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.value) }], details: result.value };
    },
  } as AgentTool) : null;
  const tools: AgentTool[] = [read, createSpreadsheetTool(execution), wrap(createWriteTool()), wrap(createEditTool())];
  if (resultStore) tools.push({
    name: 'result_read', label: '读取完整结果',
    description: 'Read a locally stored large tool result by resultId. Use offset/limit for line ranges or query for matching lines; never guess omitted values.',
    parameters: Type.Object({
      resultId: Type.String({ description: 'Local result reference returned by a tool' }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: '0-based line offset' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Maximum returned lines' })),
      query: Type.Optional(Type.String({ description: 'Case-insensitive text filter; returns matching lines' })),
    }),
    execute: async (_callId: string, rawArgs: unknown) => {
      const args = rawArgs as { resultId: string; offset?: number; limit?: number; query?: string };
      const result = await resultStore.read(args.resultId, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
    },
  });
  if (execution.shellEnabled) tools.push(powershell);
  if (execution.shellEnabled && execution.bashEnv) tools.push(wrap(createBashTool(), execution.bashEnv));
  if (execution.shellEnabled) { const python = scriptTool('python', execution.pythonEnv); const node = scriptTool('node', execution.nodeEnv); if (python) tools.push(python); if (node) tools.push(node); }
  tools.push({
    name: 'render_analysis_chart', label: '分析图表',
    description: 'Generate a polished inline chart and SVG file from observed query/attachment data. Use bar for comparisons, line for ordered time, donut for 2–6 nonnegative parts. spec is JSON: {title,takeaway,type,unit,source,basis,labels:string[],series:[{name,values:(number|null)[]}]}. Cite actual sources, never invent numbers. No shell needed.',
    parameters: Type.Object({ spec: Type.String({ description: 'Chart JSON matching the documented schema; source and basis required' }) }),
    execute: async (callId, raw: unknown, signal) => {
      if (signal?.aborted) throw new Error('已取消绘图');
      const chart = parseAnalysisChart((raw as { spec: string }).spec);
      const path = `charts/analysis-${crypto.randomUUID()}.svg`;
      const result = await execution.env.writeFile(path, renderAnalysisSvg(chart), signal);
      if (!result.ok) throw result.error;
      const artifact = { chart, path, workspace: execution.workspace };
      events?.onChart?.(artifact);
      return { content: [{ type: 'text', text: JSON.stringify({ message: '图表已显示在对话中并保存 SVG', path, chart }) }], details: { artifact, callId } };
    },
  });
  if (history?.historySearch && history.historyRead) {
    tools.push({
      name: 'search_history', label: '搜索历史证据',
      description: 'Search the current session only after context compaction. Use the returned message/state/event reference before citing old facts; never search another session.',
      parameters: Type.Object({ query: Type.String({ description: 'Distinctive phrase, evidence ID, constraint, or tool result to find' }), limit: Type.Optional(Type.Number({ description: 'Maximum matches, 1-20' })) }),
      execute: async (_callId: string, rawArgs: unknown) => {
        const args = rawArgs as { query: string; limit?: number };
        const result = await history.historySearch!(args.query, args.limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      },
    });
    tools.push({
      name: 'read_evidence', label: '读取历史证据',
      description: 'Read one reference returned by search_history from the current session. Pass the reference EXACTLY as returned (e.g. message:12, event:3, state:0) — a bare number is also accepted. Do not invent new formats; if a reference is rejected twice, stop retrying and answer with the information you already have.',
      parameters: Type.Object({ reference: Type.String({ description: 'Copy the reference returned by search_history verbatim, e.g. message:12 / event:3 / state:0 (a bare number like 12 is treated as message:12)' }) }),
      execute: async (_callId: string, rawArgs: unknown) => {
        const result = await history.historyRead!((rawArgs as { reference: string }).reference);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      },
    });
  }
  return tools;
}

export async function runPiAgent(options: PiRunOptions): Promise<{ finalText: string; rounds: number; messages: AgentMessage[]; workingState: WorkingState; compactionState?: CompactionState }> {
  const resultStore = options.execution ? createResultStore(options.execution) : undefined;
  const executionTools = nativeExecutionTools(options.execution, options.onEvent, options, resultStore);
  const discoveryTools = createDiscoveryTools();
  const initialTools = [...options.tools, ...discoveryTools.filter(discovery => !options.tools.some(tool => tool.id === discovery.id))];
  const selected = new Map(initialTools.map(tool => [tool.id, tool]));
  const dynamicPiTools = new Map<string, AgentTool>();
  const activatedToolIds = new Set<string>();
  const executedBusinessToolIds = new Set<string>();
  let agentRef: PiTaskHost['agent'] | undefined;
  // ponytail: keep at most 32 successful reads within this run; mutations invalidate all.
  const reads = new Map<string, {callId:string; at:number}>();
  let repeatedReads = 0;
  const publishToolResult = (tool: AiTool, args: any, result: { ok: boolean; text: string; result?: AiToolResult<unknown> }, callId: string) => {
    if (tool.manifest?.kind === 'cloud') options.onEvent?.onCloudResult?.(args, result.ok, result.text);
    else options.onEvent?.onToolResult?.(tool.id, args, result.ok, result.text, result.result, callId);
  };
  const makeAgentTool = (tool: AiTool): AgentTool => ({
    name: tool.id,
    label: tool.name,
    description: tool.desc,
    parameters: schemaFor(tool),
    prepareArguments: (args: unknown) => prepareBusinessArgs(tool.id, args),
    execute: async (callId, args, signal) => {
      if (tool.id === 'discover_tools') {
        const found = discoverTools(String((args as any)?.query || ''), String((args as any)?.domains || ''));
        const added = found.filter(candidate => activateBusinessTool(candidate.id));
        added.forEach(candidate => activatedToolIds.add(candidate.id));
        const result = { ok: true, text: formatToolCatalog(found) + (added.length ? `\n\n已激活：${added.map(candidate => candidate.id).join('、')}；下一轮可直接调用。` : ''), result: undefined };
        publishToolResult(tool, args, result, callId);
        return { content: [{ type: 'text', text: result.text }], details: { text: result.text, toolIds: added.map(candidate => candidate.id) }, addedToolNames: added.map(candidate => candidate.id) };
      }
      if (tool.id === 'activate_tools') {
        const ids = parseActivatedToolIds((args as any)?.tool_ids);
        const activatedTools = ids.map(id => activateBusinessTool(id)).filter((item): item is AiTool => Boolean(item));
        activatedTools.forEach(item => {
          activatedToolIds.add(item.id);
          const piTool = dynamicPiTools.get(item.id);
          if (piTool && agentRef && !agentRef.state.tools.some(existing => existing.name === item.id)) {
            agentRef.state.tools = [...agentRef.state.tools, piTool];
          }
        });
        const activated = activatedTools.map(item => item.id);
        const unknown = ids.filter(id => !activated.includes(id));
        const catalog = formatToolCatalog(activatedTools);
        const result = {
          ok: true,
          text: `已激活：${activated.join('、') || '无'}；未知或无权限工具：${unknown.join('、') || '无'}。不要再次激活；请立即调用下面列出的业务工具。\n${catalog}`,
          result: undefined,
        };
        publishToolResult(tool, args, result, callId);
        return { content: [{ type: 'text', text: result.text }], details: { activated, unknown }, addedToolNames: activated };
      }
      if (signal?.aborted) throw new Error('任务已取消');
      if (tool.id !== 'ask_user') executedBusinessToolIds.add(tool.id);
      const cacheable = tool.manifest?.kind === 'read' && tool.id !== 'now';
      const key = JSON.stringify([tool.id, args], (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value);
      const cached = reads.get(key);
      if (cacheable && cached && Date.now() - cached.at < 30000) {
        repeatedReads++;
        if (repeatedReads >= 2) finishing = true;
        const result = {ok:true,text:`本轮相同只读查询已完成，复用工具调用 ${cached.callId} 的证据。${finishing ? '已多次重复读取已有证据，停止工具循环；请根据已有证据回答，未解决的部分说明缺口。' : '请直接使用已有结果，勿重复调用。'}`};
        publishToolResult(tool,args,result,callId);
        return {content:[{type:'text',text:result.text}],details:{reused:true,originalCallId:cached.callId},isError:false};
      }
      repeatedReads = 0;
      const result = await options.executeTool(tool.id, args as Record<string, unknown>, signal, callId, options.onGatewayTrace);
      if (cacheable && result.ok) {
        if (reads.size >= 32) reads.delete(reads.keys().next().value!);
        reads.set(key, {callId,at:Date.now()});
      }
      publishToolResult(tool, args, result, callId);
      return prepareToolResult(result, options.execution, signal, resultStore, tool.id);
    },
  });
  const activateBusinessTool = (id: string): AiTool | undefined => {
    const tool = listTools().find(candidate => candidate.id === id && candidate.manifest);
    if (!tool) return undefined;
    selected.set(id, tool);
    if (!dynamicPiTools.has(id)) dynamicPiTools.set(id, makeAgentTool(tool));
    return tool;
  };
  const piTools: AgentTool[] = initialTools.map(makeAgentTool);
  // Restore schemas for tools already present in a resumed transcript before the next request.
  for (const message of options.agentMessages || []) {
    for (const part of ((message as any).content || [])) {
      const id = part?.toolName || part?.name;
      if (typeof id === 'string' && !isDiscoveryTool(id)) activateBusinessTool(id);
    }
  }
  piTools.push(...executionTools);
  const initialAgentTools = piTools;
  const profile = options.profile || { ...createModelProfile(options.baseUrl, options.model), effectiveContext: options.contextWindow || 8192, maxTokens: options.maxTokens || 0 };
  const unlimitedOutput = !Number(profile.maxTokens);
  const piModel = {
    id: options.model, name: options.model, api: 'costhub-ollama', provider: 'costhub', baseUrl: options.baseUrl,
    reasoning: options.think !== false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: profile.effectiveContext, maxTokens: unlimitedOutput ? 16384 : profile.maxTokens, __unlimitedOutput: unlimitedOutput,
    preserveThinking: options.backend === 'llama.cpp' && profile.preserveThinking, reasoningEffort: profile.reasoningEffort, temperature: profile.temperature,
  } as any;
  const startedAt = performance.now();
  const metrics: PiRunMetrics = {elapsedMs:0, modelMs:0, checkpointMs:0, toolMs:0, toolCalls:0, inputTokens:0, outputTokens:0, rounds:0};
  let modelStartedAt = startedAt;
  const toolStartedAt = new Map<string, number>();
  let lastUsage: ModelUsage | undefined;
  let emptyAnswerRecoveryUsed = false;
  let round = 0;
  let compactionState: CompactionState | undefined = options.compactionState;
  let workingState = normalizeWorkingState(options.workingState, String(options.sessionId ?? options.runId ?? crypto.randomUUID()));
  let observedTurnMessages: AgentMessage[] = [];
  let rawMessageSeq = 0;
  let pendingPromptSource: { text: string; id: string } | undefined;
  const toolArgs = new Map<string, unknown>();
  let checkpointError: unknown;
  let finishing = false;
  const checkpoint = async (messages: AgentMessage[], pending?: { id: string; name: string }) => {
    if (checkpointError) throw checkpointError;
    const start = performance.now();
    try { await options.onCheckpoint?.(messages, pending, workingState, compactionState); } catch (error) { checkpointError = error; throw error; }
    finally { metrics.checkpointMs += performance.now() - start; }
  };
  const initialSystemPrompt = nativeToolPrompt(options.systemPrompt) + '\n\n【固定计算分工】查项目最贵/最便宜/Top N 用 query_project_bom(view=rank, metric=unit_cost或extended_cost, limit=N)，均价/极值/总额用 summary，模块/类别汇总用 group。已给项目名称或代号时直接查，无需先列项目。排序、求和、均值、占比由工具完成，不分页读取后口算，不再调用 calc 重算；拿到充分证据立即回答，缺项和并列要说明。\n【原生工具模式】当前运行在 Pi 原生工具模式。必须通过提供的原生 function/tool 调用工具；不要在正文输出伪造 JSON 调用标记。工具返回后再继续回答。常驻业务工具不足时，先调用 discover_tools(query, domains)；它会返回匹配工具的参数 schema 并自动激活，下一轮再调用对应业务工具。也可显式调用 activate_tools(tool_ids)。发现提示不是权限判定，写工具仍必须经过用户明确授权和现有确认门禁。' + (options.execution ? `\n\n【表格分工】Excel/CSV 金额核对、汇总、对比优先 analyze_spreadsheet：inspect 查看少量表头和样例，再明确列、明细行范围和计价口径，用 calculate 批量处理。禁止逐行口算或为固定计算逐页读取全表；结果文件是证据，只有需要解释具体异常才续读。不要对相同文件和参数重复计算。模型负责列识别、归类、异常解释；不确定的映射先核实，不得猜测。\n【任务文件与图表】分析比较时可使用 render_analysis_chart 生成图表，不必等待用户说出工具名称。不得虚构数字；Skills 可通过 read 按需读取。任务目录：${options.execution.workspace}。文件工具仅允许访问此目录；命令执行${options.execution.shellEnabled ? '已授权，运行在 Windows AppContainer 隔离目录内，无网络能力且不继承用户密钥环境' : '未启用，需要用户主动打开隔离脚本开关'}。可用依赖：${Object.entries(options.execution.dependencies).filter(([, value]) => value.available).map(([name]) => name).join('、') || '未检测到'}。\n${formatSkillsForSystemPrompt(options.execution.skills)}` : '');
  const host = PiTaskHost.create(options.runId || crypto.randomUUID(), {
    streamFn: createAiGatewayStream({
      baseUrl: options.baseUrl,
      model: options.model,
      backend: options.backend || 'ollama',
      buildContext: context => buildLocalContext(context, workingState),
      // ⚠️ 2026-09-21：来源标签不再硬编码 ['private_workspace']——那会让 evaluatePrivacy 在"来源策略"
      // 一步就返回、正则与分类器永不执行，筛查看起来是"真实判断"其实是个常量（用户实测质疑）。
      // 现在由**真实消息内容**推导：只有确实出现本地库数据/工具结果时才是 private_workspace，
      // 纯系统提示 + 用户提问会真正走内容级正则与分类器（仍然 fail-closed，只有 public 才可能上云）。
      privacy: {
        ...(options.privacySourceTypes ? { sourceTypes: options.privacySourceTypes } : { sourceTypesFrom: deriveContextSourceTypes }),
        metadata: options.privacyMetadata,
        classifier: options.localPrivacyClassifier,
      },
      route: options.gatewayRoute || 'local',
      cloud: options.cloud,
      onUsage: usage => { lastUsage = usage; options.onEvent?.onUsage?.(usage); },
    }, { onEvent: options.onGatewayTrace }),
    transformContext: async (messages, signal) => {
      const currentAgentTools = agentRef?.state.tools || initialAgentTools;
      const priorCheckpoint = Boolean(compactionState?.summary);
      const result = await compactContext(messages, profile, compactionState, signal || new AbortController().signal, stats => options.onEvent?.onCompaction?.(stats), { systemPrompt: initialSystemPrompt, tools: currentAgentTools, workingState, policy: options.compactionPolicy, hasPriorCheckpoint: priorCheckpoint });
      compactionState = result.state;
      // ⚠️ 2026-09-21 修复"压缩没有作用"：旧判断是 `result.state && ...`，而首次压缩前 state 为 undefined，
      // keepState(undefined) 仍是 undefined → 黄灯轻量剪枝与失败兜底剪枝**算完就被丢掉**，
      // provider 拿到的还是完整历史，但 onStats 已经把 tokensBefore→tokensAfter 报给 UI（用户看到"已压缩"却毫无变化）。
      // 现在按"消息是否真的变了"提交，state 与消息解耦。
      if (result.messages !== messages && agentRef) {
        reads.clear(); repeatedReads = 0;
        const workingMessages = commitWorkingContext(agentRef, messages, result.messages);
        await checkpoint(workingMessages);
        return workingMessages;
      }
      return messages;
    },
    prepareNextTurnWithContext: context => {
      if (finishing) return { context: { ...context.context, tools: [] } };
      const currentTools = context.context.tools || [];
      const known = new Set(currentTools.map(tool => tool.name));
      const additions = [...dynamicPiTools.values()].filter(tool => !known.has(tool.name));
      return additions.length ? { context: { ...context.context, tools: [...currentTools, ...additions] } } : undefined;
    },
    toolExecution: 'sequential',
    initialState: {
       systemPrompt: initialSystemPrompt,
       model: piModel, thinkingLevel: options.think === false ? 'off' : 'medium', tools: initialAgentTools, messages: options.agentMessages || historyMessages(options.history || []),
    },
    beforeToolCall: async ({ toolCall }) => {
       if (finishing) return { block: true, reason: '结论收尾阶段不允许再次执行工具。', terminate: true };
       if (options.signal?.aborted) return { block: true, reason: '任务已取消，未执行工具。', terminate: true };
       if (checkpointError) return { block: true, reason: '会话保存失败，已停止工具执行，请核对上次操作结果。', terminate: true };
      const tool = selected.get(toolCall.name);
      if ((!tool || tool.manifest?.kind !== 'read') && !isDiscoveryTool(toolCall.name)) { reads.clear(); repeatedReads = 0; }
      if (!executionTools.some(item => item.name === toolCall.name) && (!tool || (!getToolManifest(toolCall.name) && !isDiscoveryTool(toolCall.name)))) return { block: true, reason: '工具未在当前 CostHub Manifest 白名单中，已拒绝执行。', terminate: true };
       try { await checkpoint(agentRef?.state.messages || [], { id: toolCall.id, name: toolCall.name }); }
      catch { return { block: true, reason: '会话无法保存，未执行工具。', terminate: true }; }
      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError, context }, signal) => {
      const failed = isError || Boolean((result as any).isError);
      if (!failed && ['analyze_spreadsheet', 'read'].includes(toolCall.name)) executedBusinessToolIds.add(toolCall.name);
      if (toolCall.name === 'analyze_spreadsheet' && !failed && (result.details as any)?.stopLoop) finishing = true;
      const externalized = resultStore && toolCall.name !== 'result_read'
        ? await externalizeAgentToolResult(resultStore, toolCall.name, result, signal)
        : undefined;
      const content = externalized?.content || result.content;
      const details = externalized?.details ?? result.details;
      await checkpoint([...context.messages, { role: 'toolResult', toolCallId: toolCall.id, toolName: toolCall.name, content, details, isError: failed, timestamp: Date.now() }]);
      return { ...(externalized || {}), isError: failed };
    },
  }, options.signal, options.sessionId);
  const agent = host.agent;
  host.retain();
  try {
    agentRef = agent;
    options.onAgentReady?.(agent);
    if (options.execution) options.onEvent?.onExecutionReady?.(options.execution.workspace, options.execution.diagnostics);
    agent.subscribe(async (event: AgentEvent) => {
    if (event.type === 'message_end') {
      const sourceId = event.message.role === 'user' && pendingPromptSource && messageText(event.message) === pendingPromptSource.text
        ? pendingPromptSource.id
        : `${options.runId || workingState.sessionId}:message:${++rawMessageSeq}`;
      const durableMessage = withStableMessageId(event.message, sourceId);
      observedTurnMessages.push(durableMessage);
      if (durableMessage.role === 'assistant') {
        metrics.modelMs += performance.now() - modelStartedAt;
        metrics.inputTokens += durableMessage.usage?.input || 0;
        metrics.outputTokens += durableMessage.usage?.output || 0;
      }
      await options.onRawMessage?.(durableMessage);
    }
    if (event.type === 'turn_start') { modelStartedAt = performance.now(); round++; options.onEvent?.onRoundStart?.(round); }
    if (event.type === 'tool_execution_start') {
      metrics.toolCalls++; metrics.firstToolMs ??= performance.now() - startedAt;
      toolStartedAt.set(event.toolCallId, performance.now());
      toolArgs.set(event.toolCallId, event.args);
      const tool = selected.get(event.toolName);
      if (tool?.manifest?.kind !== 'cloud') options.onEvent?.onToolStart?.(event.toolName, event.args, event.toolCallId);
    }
    if (event.type === 'tool_execution_end') { metrics.toolMs += performance.now() - (toolStartedAt.get(event.toolCallId) ?? performance.now()); toolStartedAt.delete(event.toolCallId); }
    if (event.type === 'tool_execution_end' && executionTools.some(t => t.name === event.toolName)) {
      const output = contentText(event.result.content || []);
      options.onEvent?.onToolResult?.(event.toolName, toolArgs.get(event.toolCallId), !event.isError, output, undefined, event.toolCallId);
      toolArgs.delete(event.toolCallId);
    }
    if (event.type === 'message_update') {
      const update: any = event.assistantMessageEvent;
      if (update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta') metrics.firstModelOutputMs ??= performance.now() - startedAt;
      if (update.type === 'text_delta') options.onEvent?.onAnswer?.(update.delta);
      if (update.type === 'thinking_delta') options.onEvent?.onThought?.(update.delta);
    }
    });
    const promptAndCheckpoint = async (input: string, images?: ImageContent[], trackUserInput = false) => {
      observedTurnMessages = [];
      const sourcePrefix = `${workingState.sessionId}:turn:${crypto.randomUUID()}`;
      const promptMessage = withStableMessageId({ role: 'user', content: [{ type: 'text', text: input }], timestamp: Date.now() } as unknown as AgentMessage, `${options.runId || workingState.sessionId}:prompt:${crypto.randomUUID()}`);
      pendingPromptSource = { text: input, id: (promptMessage as any).id };
      if (trackUserInput) {
        try {
          workingState = updateWorkingState(workingState, {
            sessionId: workingState.sessionId,
            sourcePrefix,
            messages: [promptMessage],
          });
        } catch (error) {
          console.warn('预更新 AI 工作状态失败', error);
        }
      }
      try {
        await host.prompt(input, images);
      } finally {
        pendingPromptSource = undefined;
      }
      try {
        // Only feed this turn to the extractor; replaying the whole transcript
        // would let an old confirmed fact win again over a newer replacement.
        const stateMessages = observedTurnMessages.filter(message => trackUserInput || message.role !== 'user');
        if (trackUserInput && !stateMessages.some(message => message.role === 'user' && (message as any).id === (promptMessage as any).id)) {
          stateMessages.push(promptMessage);
          await options.onRawMessage?.(promptMessage);
        }
        workingState = updateWorkingState(workingState, { sessionId: workingState.sessionId, messages: stateMessages, sourcePrefix });
      } catch (error) {
        // State extraction is advisory; a parser failure must not change the agent answer.
        console.warn('更新 AI 工作状态失败', error);
      }
      await checkpoint(agent.state.messages);
    };
    const images = (options.images || []).map(toImage);
    await promptAndCheckpoint(options.userContent, images, true);
  let last = [...agent.state.messages].reverse().find((message: any) => message.role === 'assistant') as any;
  // Some native templates stop with an empty assistant message after a
  // multi-tool turn. Give the real model one final user query; never replay a
  // tool automatically, and leave the empty result intact if it still fails.
  let recoveryAttempts = 0;
  while (!options.signal?.aborted && recoveryAttempts < 2) {
    const hasAnswer = Boolean(contentText(last?.content || []).trim());
    const activatedReads = [...activatedToolIds].filter(id => {
      if (id === 'ask_user') return false;
      const kind = getToolManifest(id)?.kind;
      return kind === 'read' || kind === 'calculate';
    });
    const shouldContinueWithActivatedRead = !finishing && activatedReads.length > 0 && executedBusinessToolIds.size === 0;
    if (shouldContinueWithActivatedRead) {
      recoveryAttempts++;
      const activatedCatalog = formatToolCatalog(activatedReads.map(id => listTools().find(tool => tool.id === id)).filter((item): item is AiTool => Boolean(item)));
      await promptAndCheckpoint(`已激活只读工具：${activatedReads.join('、')}。请立即调用其中最符合原始请求的工具并使用原始请求中的参数；不要再次 discover_tools、activate_tools、ask_user 或先输出解释。\n${activatedCatalog}`);
    } else if (!hasAnswer && !emptyAnswerRecoveryUsed && String(lastUsage?.doneReason || '') === 'length'
      && Array.isArray(last?.content) && last.content.some((part: any) => part?.type === 'thinking')) {
      // One protected finish request is allowed after thinking consumed the
      // generation budget. It keeps the transcript/tools and only disables
      // thinking for this retry; it never replays a side-effecting tool.
      recoveryAttempts++;
      emptyAnswerRecoveryUsed = true;
      finishing = true;
      const previousLevel = (agent.state as any).thinkingLevel;
      (agent.state as any).thinkingLevel = 'off';
      try { await promptAndCheckpoint('刚才的思考达到输出上限但没有形成答案。请只基于现有约束、证据和工具结果，直接给出最终结论；不要再次调用工具。'); }
      finally { (agent.state as any).thinkingLevel = previousLevel; }
    } else if (!hasAnswer && !emptyAnswerRecoveryUsed && agent.state.messages.some((message: any) => message.role === 'toolResult')) {
      recoveryAttempts++;
      emptyAnswerRecoveryUsed = true;
      finishing = true;
      await promptAndCheckpoint('请基于刚才已经返回的工具结果直接输出最终结论；不要再次调用工具。证据不足时明确标为 unknown。');
    } else {
      break;
    }
    last = [...agent.state.messages].reverse().find((message: any) => message.role === 'assistant') as any;
  }
    return { finalText: last ? contentText(last.content || []) : '', rounds: round, messages: agent.state.messages, workingState, compactionState };
  } finally {
    metrics.elapsedMs = performance.now() - startedAt; metrics.rounds = round;
    try { await options.onMetrics?.(metrics); } catch (error) { console.warn('保存执行统计失败', error); }
    host.release();
  }
}

export { schemaFor };

export function createPiNativeTool(execution: PiExecutionContext, name: string): AgentTool | undefined {
  return nativeExecutionTools(execution, undefined, undefined, createResultStore(execution)).find(tool => tool.name === name);
}
