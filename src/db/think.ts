// AI 自主分析日志（2026-08-17 用户需求：后台自发自主分析，过程可回溯）
import { getDb } from './core';

export interface ThinkLog {
  id?: number;
  started_at?: string;
  finished_at?: string;
  status: string;        // running | done | error
  topic: string;         // 本轮分析主题（模型总结或规则生成）
  overview: string;      // 本轮数据概览（模型看到的输入）
  thoughts: string;      // 思考过程全文（分段用 \n\n---\n 分隔）
  tools_json: string;    // 工具调用轨迹 JSON
  clouds_json: string;   // 云端申请轨迹 JSON
  conclusion: string;   // 最终结论
  error?: string;
}

export async function saveThinkLog(data: ThinkLog): Promise<number> {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE ai_think_logs SET finished_at=?, status=?, topic=?, thoughts=?, tools_json=?, clouds_json=?, conclusion=?, error=? WHERE id=?',
      [data.finished_at || '', data.status, data.topic || '', data.thoughts || '', data.tools_json || '[]', data.clouds_json || '[]', data.conclusion || '', data.error || '', data.id]);
    return data.id;
  }
  const r = await d.execute('INSERT INTO ai_think_logs (status, topic, overview, thoughts, tools_json, clouds_json, conclusion, error) VALUES (?,?,?,?,?,?,?,?)',
    [data.status, data.topic || '', data.overview || '', data.thoughts || '', data.tools_json || '[]', data.clouds_json || '[]', data.conclusion || '', data.error || '']);
  return r.lastInsertId!;
}

export async function getThinkLogs(limit = 20): Promise<ThinkLog[]> {
  return (await getDb()).select<ThinkLog[]>('SELECT * FROM ai_think_logs ORDER BY id DESC LIMIT ?', [limit]);
}

export async function getRunningThinkLog(): Promise<ThinkLog | null> {
  const r = await (await getDb()).select<ThinkLog[]>("SELECT * FROM ai_think_logs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  return r[0] || null;
}