import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../db/core', () => ({ getDb: async () => ({
  select: async (sql: string, args: any[] = []) => state.db.prepare(sql).all(...args),
  execute: async (sql: string, args: any[] = []) => { const r = state.db.prepare(sql).run(...args); return {lastInsertId:Number(r.lastInsertRowid)}; },
}) }));
import { requestChannel } from '../ai/requestChannel';
import {saveAIRequestLog, saveAIUsageLog, getAllAIRequestLogs, getDailyCloudUsage, getTokenUsageStats} from '../db/settings';
afterEach(() => state.db?.close());
it('keeps local channels out of cloud counts, migrates legacy spellings on read and leaves missing provenance unknown', async () => {
 state.db = new DatabaseSync(':memory:');
 state.db.exec(`CREATE TABLE ai_request_logs (id INTEGER PRIMARY KEY, request_type TEXT, material_name TEXT, system_prompt TEXT, user_prompt TEXT, response_summary TEXT, success INTEGER, error_message TEXT, provider_name TEXT, model_name TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, request_channel TEXT DEFAULT 'unknown', created_at TEXT DEFAULT (datetime('now','localtime')))`);
 for(const provider of ['Ollama 本地','ollama（本地）','llama.cpp 本地','llama.cpp（本地）','']) {
   state.db.prepare('INSERT INTO ai_request_logs(provider_name,total_tokens) VALUES (?,?)').run(provider,100);
 }
 const base={request_type:'test',system_prompt:'',user_prompt:'',response_summary:'',success:true,total_tokens:10};
 await saveAIRequestLog({...base,provider_name:'future-local',request_channel:'local'});
 await saveAIRequestLog({...base,provider_name:'Ollama',request_channel:'cloud'});
 await saveAIUsageLog({provider_name:'DeepSeek',model_name:'x',prompt_tokens:3,completion_tokens:7,total_tokens:10,request_channel:'cloud'});
 const rows=await getAllAIRequestLogs();
 expect(rows.filter(r=>requestChannel(r)==='local')).toHaveLength(5);
 expect(rows.filter(r=>requestChannel(r)==='unknown')).toHaveLength(1);
 expect(await getDailyCloudUsage()).toEqual({count:2,tokens:20});
 const stats=await getTokenUsageStats();
 expect(stats.total.total).toBe(20);expect(stats.byProvider).toHaveLength(2);expect(stats.daily[0].total).toBe(20);
 expect(requestChannel({provider_name:'LLAMA.CPP 本地'})).toBe('local');
 expect(requestChannel({provider_name:'Ollama',request_channel:'cloud'})).toBe('cloud');
});
