// AI 状态探测（v2.3.19，2026-08-16）：Ollama 连接状态 + 模型名
// 供 AIStatusBar（状态条）与 dailyBrief（今日速览）共用
// ⚠️ 本地直连铁律：127.0.0.1 优先（绕过公司代理 WinHTTP 转发），失败再试配置地址
import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './db';
import { getLocalBackend, localModelsPath, type LocalBackend } from './localBackend';
import { pickLocalModel } from './ai/localModelPick';

export interface OllamaStatus {
  connected: boolean;
  baseUrl: string;
  model: string;
  reason: 'ok' | 'no-model' | 'model-missing' | 'offline' | 'error';
  backend?: LocalBackend;
  /** 本次探测自动选定了模型（原设置为空），UI 可据此提示用户。 */
  autoSelected?: boolean;
}

/** 探测 Ollama：配置 localhost 时先试 127.0.0.1（IP 字面量），失败再试配置地址 */
export async function detectOllama(): Promise<OllamaStatus> {
  try {
    const backend = await getLocalBackend();
    const configured = (await getSetting('local_ai_model', '')).trim();
    let model = configured;
    const base = (await getSetting('local_ai_base_url', backend === 'llama.cpp' ? 'http://127.0.0.1:8080' : 'http://localhost:11434')).replace(/\/$/, '');
    const candidates = [...new Set([
      ...(base.includes('localhost') ? ['http://127.0.0.1:11434'] : []),
      base,
      ...(backend === 'ollama' ? ['http://127.0.0.1:11434'] : []),
    ])];
    for (const u of candidates) {
      try {
        const r = await invoke<{ status: number; body: string; success: boolean }>('http_get', { request: { url: u + localModelsPath(backend), headers: {}, body: null, backend } });
        if (!r?.success) continue;
        // 检查模型是否已下载（Ollama 在线但模型未 pull 是常见坑，提前区分出来）
        let list: string[] = [];
        let parsed = true;
        try {
          const data = JSON.parse(r.body || '{}'); list = (data.models || data.data || []).map((m: any) => String(m.name || m.id || ''));
        } catch { parsed = false; } // body 解析失败不阻断（兼容旧版/异常返回）
        // ⚠️ 2026-09-21：原设置为空时**不再直接判 no-model**——服务在线就从模型列表里自动挑一个并落库。
        // 之前「改过 Base URL → 模型选择被清空 → 洞察研判静默回落云端」就是这里缺了自愈。
        if (parsed && list.length === 0) return { connected: false, baseUrl: u, model, reason: configured ? 'model-missing' : 'no-model', backend };
        let autoSelected = false;
        if (!model && parsed) {
          model = pickLocalModel(list);
          if (model) { autoSelected = true; setSetting('local_ai_model', model).catch(() => { }); }
        }
        if (!model) return { connected: false, baseUrl: u, model, reason: 'no-model', backend };
        const short = model.split(':')[0];
        const hasModel = !parsed || list.length === 0 || list.some(n => n === model || n === short || n.startsWith(short + ':'));
        if (!hasModel) return { connected: false, baseUrl: u, model, reason: 'model-missing', backend };
        return { connected: true, baseUrl: u, model, reason: 'ok', backend, ...(autoSelected ? { autoSelected: true } : {}) };
      } catch { /* 试下一个候选 */ }
    }
    return { connected: false, baseUrl: base, model, reason: 'offline', backend };
  } catch {
    return { connected: false, baseUrl: '', model: '', reason: 'error' };
  }
}
