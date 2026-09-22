import type { PiExecutionContext } from './piExecution';
import type { ContextMetadata, DataSensitivity } from './contextMetadata';
import type { StateItem } from './workingState';

export type ResultSensitivity = DataSensitivity;

export interface StoredResult {
  id: string;
  toolName: string;
  createdAt: number;
  fullContentPath: string;
  summary: string;
  keyFacts: StateItem[];
  sensitivity: ResultSensitivity;
  metadata: ContextMetadata;
}

export interface ResultReadRequest {
  offset?: number;
  limit?: number;
  query?: string;
}

export interface ResultReadResponse {
  result: StoredResult;
  offset?: number;
  returnedLines: number;
  totalLines: number;
  nextOffset: number | null;
  lines?: string[];
  matches?: { line: number; text: string }[];
}

export interface ResultStore {
  store(toolName: string, fullContent: string, summary: string, signal?: AbortSignal): Promise<StoredResult>;
  registerExisting(toolName: string, fullContentPath: string, summary: string): Promise<StoredResult>;
  read(resultId: string, request?: ResultReadRequest): Promise<ResultReadResponse>;
}

const RESULT_ID = /^result_[0-9a-f-]{36}$/i;
const RESULT_DIR = '.costhub-results';
const resultPath = (id: string) => `${RESULT_DIR}/${id}.txt`;
const metadataPath = (id: string) => `${RESULT_DIR}/${id}.meta.json`;
const boundedSummary = (value: string) => String(value || '').slice(0, 1200);
const errorText = (error: unknown) => String((error as Error)?.message || error).slice(0, 400);
const resultMetadata = (id: string): ContextMetadata => ({ sourceType: 'tool_result', sensitivity: 'unknown', cloudSafe: false, priority: 'normal', sourceIds: [id] });

function safeResultId(id: string): string {
  if (!RESULT_ID.test(id)) throw new Error('resultId 格式无效');
  return id;
}

function relativeResultPath(workspace: string, value: string): string {
  const path = String(value || '').replace(/\\/g, '/');
  const root = String(workspace || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const lowerPath = path.toLocaleLowerCase();
  const lowerRoot = root.toLocaleLowerCase();
  const relative = lowerPath === lowerRoot ? '.' : lowerPath.startsWith(`${lowerRoot}/`) ? path.slice(root.length + 1) : path;
  if (!relative.toLocaleLowerCase().startsWith(`${RESULT_DIR}/`)) throw new Error('结果文件不在任务结果目录内');
  return relative;
}

function referencePayload(stored: StoredResult, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    resultId: stored.id,
    summary: stored.summary,
    truncated: true,
    instruction: '完整结果只保存在本地。需要原文时调用 result_read(resultId, offset, limit, query)，不要猜测缺失数据。',
  };
}

export function resultReferenceText(stored: StoredResult, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(referencePayload(stored, extra));
}

export function createResultStore(execution: PiExecutionContext): ResultStore {
  const known = new Map<string, StoredResult>();

  const persistMetadata = async (stored: StoredResult) => {
    const saved = await execution.env.writeFile(metadataPath(stored.id), JSON.stringify(stored));
    if (!saved.ok) throw saved.error;
    known.set(stored.id, stored);
    return stored;
  };

  const loadMetadata = async (resultId: string): Promise<StoredResult> => {
    const id = safeResultId(resultId);
    const cached = known.get(id);
    if (cached) return cached;
    const saved = await execution.env.readTextFile(metadataPath(id));
    if (saved.ok) {
      try {
        const parsed = JSON.parse(saved.value) as StoredResult;
        if (parsed.id === id && typeof parsed.fullContentPath === 'string') {
          const normalized = { ...parsed, keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : [], sensitivity: parsed.sensitivity || 'unknown', metadata: parsed.metadata || resultMetadata(id) };
          known.set(id, normalized);
          return normalized;
        }
      } catch { /* fall through to the deterministic legacy path */ }
    }
    const fallback: StoredResult = { id, toolName: 'unknown', createdAt: 0, fullContentPath: resultPath(id), summary: '', keyFacts: [], sensitivity: 'unknown', metadata: resultMetadata(id) };
    known.set(id, fallback);
    return fallback;
  };

  return {
    store: async (toolName, fullContent, summary, signal) => {
      const id = `result_${crypto.randomUUID()}`;
      const stored: StoredResult = { id, toolName, createdAt: Date.now(), fullContentPath: resultPath(id), summary: boundedSummary(summary), keyFacts: [], sensitivity: 'unknown', metadata: resultMetadata(id) };
      const saved = await execution.env.writeFile(stored.fullContentPath, fullContent, signal);
      if (!saved.ok) throw saved.error;
      return persistMetadata(stored);
    },
    registerExisting: async (toolName, fullContentPath, summary) => {
      const path = relativeResultPath(execution.workspace, fullContentPath);
      const id = `result_${crypto.randomUUID()}`;
      const stored: StoredResult = { id, toolName, createdAt: Date.now(), fullContentPath: path, summary: boundedSummary(summary), keyFacts: [], sensitivity: 'unknown', metadata: resultMetadata(id) };
      return persistMetadata(stored);
    },
    read: async (resultId, request = {}) => {
      const stored = await loadMetadata(resultId);
      const absolute = await execution.env.absolutePath(stored.fullContentPath);
      if (!absolute.ok) throw absolute.error;
      const saved = await execution.env.readTextFile(absolute.value);
      if (!saved.ok) throw new Error(`结果 ${stored.id} 不可读取：${errorText(saved.error)}`);
      const lines = saved.value.split(/\r?\n/);
      const limit = Math.min(200, Math.max(1, Math.floor(request.limit || 40)));
      if (request.query) {
        const query = String(request.query).toLocaleLowerCase();
        const matches = lines.map((text, line) => ({ line: line + 1, text })).filter(item => item.text.toLocaleLowerCase().includes(query)).slice(0, limit);
        return { result: stored, returnedLines: matches.length, totalLines: lines.length, nextOffset: null, matches };
      }
      const offset = Math.max(0, Math.floor(request.offset || 0));
      const page = lines.slice(offset, offset + limit);
      return { result: stored, offset, returnedLines: page.length, totalLines: lines.length, nextOffset: offset + page.length < lines.length ? offset + page.length : null, lines: page };
    },
  };
}

export async function externalizeAgentToolResult(
  store: ResultStore,
  toolName: string,
  result: { content?: Array<{ type?: string; text?: string }>; details?: unknown },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown } | undefined> {
  const text = (result.content || []).filter(part => part?.type === 'text').map(part => part.text || '').join('');
  const details = result.details && typeof result.details === 'object' ? result.details as Record<string, unknown> : {};
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* plain text result */ }
  if (typeof parsed.resultId === 'string') return undefined;
  const existingPath = typeof details.fullResultPath === 'string' ? details.fullResultPath : typeof parsed.fullResultPath === 'string' ? parsed.fullResultPath : undefined;
  if (!existingPath && text.length <= 6000) return undefined;
  const stored = existingPath
    ? await store.registerExisting(toolName, existingPath, String(parsed.summary || text.slice(0, 1000)))
    : await store.store(toolName, text, text.slice(0, 1000), signal);
  // ponytail: keep only small scalar metadata in the active context; full
  // arrays/objects stay in the local result file and are read via result_read.
  const extra = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => {
    if (key === 'fullResultPath' || key === 'fullOutputPath') return false;
    return value == null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 240);
  }));
  return {
    content: [{ type: 'text', text: resultReferenceText(stored, extra) }],
    details: { ...details, resultId: stored.id, storedResult: stored },
  };
}
