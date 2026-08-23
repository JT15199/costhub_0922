// AI 状态探测（v2.3.19，2026-08-16）：Ollama 连接状态 + 模型名
// 供 AIStatusBar（状态条）与 dailyBrief（今日速览）共用
// ⚠️ 本地直连铁律：127.0.0.1 优先（绕过公司代理 WinHTTP 转发），失败再试配置地址
import { invoke } from '@tauri-apps/api/core';
import { getSetting } from './db';

export interface OllamaStatus {
  connected: boolean;
  baseUrl: string;
  model: string;
  reason: 'ok' | 'no-model' | 'model-missing' | 'offline' | 'error';
}

/** 探测 Ollama：配置 localhost 时先试 127.0.0.1（IP 字面量），失败再试配置地址 */
export async function detectOllama(): Promise<OllamaStatus> {
  try {
    const model = (await getSetting('local_ai_model', '')).trim();
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    if (!model) return { connected: false, baseUrl: base, model: '', reason: 'no-model' };
    const candidates = [...new Set([
      ...(base.includes('localhost') ? ['http://127.0.0.1:11434'] : []),
      base,
      'http://127.0.0.1:11434',
    ])];
    for (const u of candidates) {
      try {
        const r = await invoke<{ status: number; body: string; success: boolean }>('http_get', { request: { url: u + '/api/tags', headers: {}, body: null } });
        if (!r?.success) continue;
        // 检查模型是否已下载（Ollama 在线但模型未 pull 是常见坑，提前区分出来）
        let hasModel = true;
        try {
          const list: string[] = (JSON.parse(r.body || '{}').models || []).map((m: any) => String(m.name || ''));
          const short = model.split(':')[0];
          hasModel = list.some(n => n === model || n === short || n.startsWith(short + ':'));
        } catch { hasModel = true; } // body 解析失败不阻断（兼容旧版/异常返回）
        if (!hasModel) return { connected: false, baseUrl: u, model, reason: 'model-missing' };
        return { connected: true, baseUrl: u, model, reason: 'ok' };
      } catch { /* 试下一个候选 */ }
    }
    return { connected: false, baseUrl: base, model, reason: 'offline' };
  } catch {
    return { connected: false, baseUrl: '', model: '', reason: 'error' };
  }
}
