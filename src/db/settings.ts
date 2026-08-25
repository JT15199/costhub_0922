// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import { PRESET_PROVIDERS as PRESET_PROVIDER_TEMPLATES } from '../constants';
import { getDb } from './core';



// ==================== settings 读写（本地 AI / 演示生成共用） ====================
export async function getSetting(key: string, def = '') {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', [key]);
  return rows[0]?.value || def;
}


export async function setSetting(key: string, value: string) {
  const db = await getDb();
  await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}



// ==================== 本地知识条目 / 习惯库（local_ai_context）====================
// 演示生成的习惯库与右侧 AI 协作窗共用：分类 category（'general' 默认 / 可自定义，如 演示结构/风格描述/素材模板）
export async function loadContextEntries() {
  return (await getDb()).select<any[]>('SELECT * FROM local_ai_context ORDER BY updated_at DESC');
}


export async function saveContextEntry(key: string, title: string, content: string, category = 'general') {
  await (await getDb()).execute("INSERT OR REPLACE INTO local_ai_context (key,title,content,category,updated_at) VALUES (?,?,?,?,datetime('now','localtime'))", [key, title, content, category]);
}


export async function deleteContextEntry(key: string) {
  await (await getDb()).execute("DELETE FROM local_ai_context WHERE key=?", [key]);
}



// ==================== API Providers (compat exports used by Settings) ====================
export const PRESET_PROVIDERS = PRESET_PROVIDER_TEMPLATES;



export async function ensurePresetProviders() {
  const d = await getDb();
  try {
    await d.execute(`
      DELETE FROM api_providers
      WHERE is_preset = 1
        AND IFNULL(api_key, '') = ''
        AND EXISTS (
          SELECT 1 FROM api_providers q
          WHERE q.provider_type = api_providers.provider_type
            AND q.provider_name = api_providers.provider_name
            AND q.id <> api_providers.id
            AND (IFNULL(q.api_key, '') <> '' OR q.id < api_providers.id)
        )
    `);
  } catch {}
  let priority = 20;
  for (const preset of PRESET_PROVIDER_TEMPLATES) {
    await d.execute(
      `INSERT INTO api_providers
        (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
       SELECT ?,?,?,?,?,0,?,1,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM api_providers
         WHERE provider_type = ? AND provider_name = ?
       )`,
      [
        preset.provider_type, preset.provider_name, '', preset.base_url || '', (preset as any).model_name || '', priority++, preset.monthly_quota_note || '', preset.registration_url || '',
        preset.provider_type, preset.provider_name,
      ]
    );
  }
}



export async function getApiProviders() {
  return getAllApiProviders();
}



export async function saveApiProvider(data: any) {
  const normalized = {
    ...data,
    is_active: data.is_active ?? data.enabled ?? 0,
    is_preset: data.is_preset ?? 0,
    base_url: data.base_url || '',
    model_name: data.model_name || '',
    monthly_quota_note: data.monthly_quota_note || '',
    registration_url: data.registration_url || '',
  };
  if (data.id) {
    return updateApiProvider(normalized);
  }
  return addApiProvider(normalized);
}



export async function deleteApiProvider(id: number) {
  await (await getDb()).execute('DELETE FROM api_providers WHERE id = ?', [id]);
}



export async function setActiveProvider(providerType: string, providerId: number) {
  const d = await getDb();
  await d.execute('UPDATE api_providers SET is_active = 0 WHERE provider_type = ?', [providerType]);
  await d.execute('UPDATE api_providers SET is_active = 1 WHERE id = ?', [providerId]);
}



export async function updateProviderPriorities(providers: any[]) {
  const d = await getDb();
  for (let index = 0; index < providers.length; index++) {
    const item = providers[index];
    const id = typeof item === 'number' ? item : item.id;
    const priority = typeof item === 'number' ? index + 1 : (item.priority ?? index + 1);
    if (id != null) await d.execute('UPDATE api_providers SET priority = ? WHERE id = ?', [priority, id]);
  }
}



let outboundEnsured = false;
async function ensureOutboundLogsTable() {
  if (outboundEnsured) return;
  const d = await getDb();
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS outbound_request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now','localtime')),
      method TEXT DEFAULT '',
      url TEXT DEFAULT '',
      status_code INTEGER DEFAULT 0,
      response_time_ms INTEGER DEFAULT 0,
      error_message TEXT DEFAULT '',
      payload_summary TEXT DEFAULT '',
      reviewed INTEGER DEFAULT 0
    )`);
  } catch { /* 已存在则忽略 */ }
  try { await d.execute("ALTER TABLE outbound_request_logs ADD COLUMN payload_summary TEXT DEFAULT ''"); } catch { /* 已有 */ }
  try { await d.execute("ALTER TABLE outbound_request_logs ADD COLUMN reviewed INTEGER DEFAULT 0"); } catch { /* 已有 */ }
  outboundEnsured = true;
}

export async function getOutboundRequestLogs(limit = 100) {
  await ensureOutboundLogsTable();
  return (await getDb()).select<any[]>('SELECT * FROM outbound_request_logs ORDER BY id DESC LIMIT ?', [limit]);
}



export async function clearOutboundRequestLogs() {
  await (await getDb()).execute('DELETE FROM outbound_request_logs');
}



// ⚠️ 外发审计（2026-08-18 强化）：每次云端请求记录 payload_summary（脱敏后的外发内容摘要）+
// reviewed（是否经审批）——设置页「AI 外发安全中心」可逐条验证外发边界（仅物料名/品类/问题）
// 2026-08-18 分工：外发安全中心只记云端外发——本地地址（本地 Ollama/回环/内网）不算外发，跳过
function isLocalUrl(url: string): boolean {
  const u = String(url || '').toLowerCase();
  return /^https?:\/\/(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
}

export async function logOutboundRequest(data: any) {
  await ensureOutboundLogsTable();
  if (isLocalUrl(data.url)) return; // 本地调用不记外发安全中心（去看 AI 请求日志）
  const d = await getDb();
  await d.execute(
    'INSERT INTO outbound_request_logs (timestamp, method, url, status_code, response_time_ms, error_message, payload_summary, reviewed) VALUES (datetime(\'now\',\'localtime\'),?,?,?,?,?,?,?)',
    [data.method, data.url, data.status_code, data.response_time_ms, data.error_message, data.payload_summary || '', data.reviewed ? 1 : 0]
  );
}



// ==================== API Providers ====================
export async function getAllApiProviders() {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers ORDER BY provider_type, priority');
}



export async function getApiProvidersByType(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? ORDER BY priority', [type]);
}



export async function getActiveApiProviders(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? AND is_active = 1 ORDER BY priority', [type]);
}



export async function addApiProvider(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO api_providers (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [data.provider_type, data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.is_preset ? 1 : 0, data.monthly_quota_note || '', data.registration_url || '']
  );
  return r.lastInsertId;
}



export async function updateApiProvider(data: any) {
  const d = await getDb();
  await d.execute(
    'UPDATE api_providers SET provider_name=?, api_key=?, base_url=?, model_name=?, is_active=?, priority=?, monthly_quota_note=?, registration_url=? WHERE id=?',
    [data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.monthly_quota_note || '', data.registration_url || '', data.id]
  );
  return data.id;
}



export async function toggleApiProviderActive(id: number, isActive: boolean) {
  await (await getDb()).execute('UPDATE api_providers SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}



// ==================== AI Request Logs（AI请求审计日志） ====================

export async function saveAIRequestLog(data: {
  request_type: string;
  material_name?: string;
  system_prompt: string;
  user_prompt: string;
  response_summary: string;
  success: boolean;
  error_message?: string;
  provider_name?: string;      // 供应商
  model_name?: string;         // 模型
  prompt_tokens?: number;      // 输入 token
  completion_tokens?: number;  // 输出 token
  total_tokens?: number;       // 总 token
}) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO ai_request_logs (request_type, material_name, system_prompt, user_prompt, response_summary, success, error_message, provider_name, model_name, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      data.request_type,
      data.material_name || '',
      data.system_prompt,
      data.user_prompt,
      data.response_summary,
      data.success ? 1 : 0,
      data.error_message || '',
      data.provider_name || '',
      data.model_name || '',
      data.prompt_tokens ?? 0,
      data.completion_tokens ?? 0,
      data.total_tokens ?? 0
    ]
  );
  return r.lastInsertId;
}



/** 更新 AI 请求日志（洞察完成后把 response_summary 从"分析中..."更新为最终结果） */
export async function updateAIRequestLog(id: number, data: { response_summary?: string; success?: boolean; error_message?: string; provider_name?: string; model_name?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.response_summary !== undefined) { sets.push('response_summary=?'); vals.push(data.response_summary); }
  if (data.success !== undefined) { sets.push('success=?'); vals.push(data.success ? 1 : 0); }
  if (data.error_message !== undefined) { sets.push('error_message=?'); vals.push(data.error_message || ''); }
  if (data.provider_name !== undefined) { sets.push('provider_name=?'); vals.push(data.provider_name || ''); }
  if (data.model_name !== undefined) { sets.push('model_name=?'); vals.push(data.model_name || ''); }
  if (data.prompt_tokens !== undefined) { sets.push('prompt_tokens=?'); vals.push(data.prompt_tokens ?? 0); }
  if (data.completion_tokens !== undefined) { sets.push('completion_tokens=?'); vals.push(data.completion_tokens ?? 0); }
  if (data.total_tokens !== undefined) { sets.push('total_tokens=?'); vals.push(data.total_tokens ?? 0); }
  if (sets.length === 0) return;
  vals.push(id);
  await (await getDb()).execute(`UPDATE ai_request_logs SET ${sets.join(', ')} WHERE id=?`, vals);
}



// Token 用量记录（轻量，每次外部 LLM 调用记录一条）
export async function saveAIUsageLog(data: {
  provider_name: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO ai_request_logs (request_type, material_name, system_prompt, user_prompt, response_summary, success, error_message, provider_name, model_name, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      'usage',
      '',
      '',
      '',
      '',
      1,
      '',
      data.provider_name,
      data.model_name,
      data.prompt_tokens,
      data.completion_tokens,
      data.total_tokens
    ]
  );
}



// Token 用量统计（按供应商/模型聚合）
// 今日云端（非本地）请求次数与 token 消耗（Dashboard 用量格 + 阈值管控）
export async function getDailyCloudUsage(): Promise<{ count: number; tokens: number }> {
  const d = await getDb();
  const rows = await d.select<any[]>(
    "SELECT COUNT(*) AS cnt, SUM(COALESCE(total_tokens,0)) AS tk FROM ai_request_logs WHERE provider_name NOT LIKE 'Ollama%' AND created_at >= datetime('now','localtime','start of day')"
  );
  return { count: rows?.[0]?.cnt || 0, tokens: rows?.[0]?.tk || 0 };
}

export async function getTokenUsageStats(): Promise<{
  total: { prompt: number; completion: number; total: number; count: number };
  byProvider: { provider_name: string; model_name: string; prompt: number; completion: number; total: number; count: number }[];
  daily: { day: string; total: number }[];
}> {
  const d = await getDb();
  const rows = await d.select<any[]>(
    'SELECT provider_name, model_name, SUM(COALESCE(prompt_tokens,0)) as prompt, SUM(COALESCE(completion_tokens,0)) as completion, SUM(COALESCE(total_tokens,0)) as total, COUNT(*) as cnt FROM ai_request_logs GROUP BY provider_name, model_name ORDER BY total DESC'
  );
  const totalRow = await d.select<any[]>(`SELECT SUM(COALESCE(prompt_tokens,0)) as p, SUM(COALESCE(completion_tokens,0)) as c, SUM(COALESCE(total_tokens,0)) as t, COUNT(*) as cnt FROM ai_request_logs WHERE provider_name NOT LIKE 'Ollama%'`);
  const daily = await d.select<any[]>(
    "SELECT substr(created_at,1,10) as day, SUM(COALESCE(total_tokens,0)) as total FROM ai_request_logs WHERE provider_name NOT LIKE 'Ollama%' GROUP BY day ORDER BY day DESC LIMIT 30"
  );
  const t = totalRow[0] || { p: 0, c: 0, t: 0, cnt: 0 };
  return {
    total: { prompt: t.p || 0, completion: t.c || 0, total: t.t || 0, count: t.cnt || 0 },
    byProvider: rows || [],
    daily: daily || [],
  };
}



export async function getAllAIRequestLogs(limit = 100) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM ai_request_logs ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}



export async function deleteAIRequestLog(id: number) {
  await (await getDb()).execute('DELETE FROM ai_request_logs WHERE id = ?', [id]);
}



export async function clearAllAIRequestLogs() {
  await (await getDb()).execute('DELETE FROM ai_request_logs');
}



// ==================== 分类规则引擎（用户可编辑） ====================
export async function getModuleRules() {
  return (await getDb()).select<any[]>(
    'SELECT * FROM module_rules ORDER BY sort_order, id'
  );
}


export async function saveModuleRule(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      'UPDATE module_rules SET keywords=?, module=?, main_category=?, sub_category=?, sort_order=? WHERE id=?',
      [data.keywords, data.module, data.main_category, data.sub_category || '', data.sort_order || 0, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO module_rules (keywords, module, main_category, sub_category, sort_order, source) VALUES (?,?,?,?,?,?)',
      [data.keywords, data.module, data.main_category, data.sub_category || '', data.sort_order || 0, data.source || 'manual']
    );
    return r.lastInsertId;
  }
}


export async function deleteModuleRule(id: number) {
  await (await getDb()).execute('DELETE FROM module_rules WHERE id = ?', [id]);
}


export async function clearModuleRules() {
  await (await getDb()).execute('DELETE FROM module_rules');
}