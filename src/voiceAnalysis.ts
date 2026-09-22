import { getAllVoiceItems, getSetting, replaceVoiceDimensions, startVoiceRun, finishVoiceRun, updateVoiceRunProgress, getRunningVoiceRun } from './db';
import { detectOllama } from './aiStatus';
import { logLocalAICall, startOllamaStream } from './ollama';
import { chunkVoiceItems, findVoiceEvidence, mergeDimensions, parseDimensions, type BlockDimension } from './voiceAnalyer';

export async function analyzeVoiceProduct(product: string, projectId = 0, onProgress?: (message: string) => void, signal?: AbortSignal) {
  const name = String(product || '').trim();
  if (!name) throw new Error('请先选择项目或产品');
  const model = await getSetting('local_ai_model', '');
  if (!model) throw new Error('未配置本地模型（设置 → 连接设置）');
  const items = (await getAllVoiceItems(name, projectId)).map((item: any) => String(item.content || '').trim()).filter(Boolean);
  if (!items.length) throw new Error('该项目暂无原声，请先导入');
  const status = await detectOllama();
  if (!status.connected) throw new Error(status.reason === 'model-missing' ? `本地模型「${model}」未下载` : 'Ollama 未运行');
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  const blocks = chunkVoiceItems(items, 3000);
  const promptVersion = 'voice-dimension-v2';
  const inputFingerprint = JSON.stringify({ product: name, projectId, model, promptVersion, items });
  const existing = await getRunningVoiceRun(name, projectId);
  const canResume = existing && Number(existing.total_items) === items.length && Number(existing.total_chunks) === blocks.length && Boolean(existing.input_fingerprint) && existing.input_fingerprint === inputFingerprint;
  const runId = canResume ? Number(existing.id) : await startVoiceRun(items.length, blocks.length, name, projectId, inputFingerprint);
  const results: BlockDimension[][] = canResume ? (() => { try { const parsed = JSON.parse(String(existing.result_json || '[]')); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })() : [];
  const startBlock = canResume ? Math.min(Number(existing.done_chunks || 0), blocks.length) : 0;
  for (let index = startBlock; index < blocks.length; index++) {
    if (signal?.aborted) { await finishVoiceRun(runId, 'paused', '用户停止分析'); throw new Error('分析已暂停，可再次点击“生成主题”继续'); }
    const block = blocks[index];
    onProgress?.(`正在分析第 ${index + 1}/${blocks.length} 块（${block.items.length} 条原声）`);
    const system = '你是用户口碑分析专家。请从给出的真实评价中提炼用户最在意的特性，合并近义表达。只输出 JSON：{"dimensions":[{"name":"特性名","sentiment":"positive或negative"}]}。最多 12 个维度，每个名称不超过 8 字，只依据评价，不要编造。';
    const user = '用户评价：\n' + block.items.join('\n');
    let output = '';
    const ok = await new Promise<boolean>(resolve => {
      let settled = false; let cleanup = () => { }; let abort = () => { };
      const finish = (value: boolean) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); cleanup(); resolve(value); };
      abort = () => finish(false);
      if (signal?.aborted) return finish(false);
      signal?.addEventListener('abort', abort, { once: true });
      void startOllamaStream(base, model, [{ role: 'system', content: system }, { role: 'user', content: user }], text => { output += text; }, () => {}, () => finish(true), () => finish(false), { endpoint: 'native', think: false, json: false, num_predict: 16384, signal }).then(stop => { cleanup = stop; if (settled) cleanup(); }).catch(() => finish(false));
    });
    if (!ok) { if (signal?.aborted) { await finishVoiceRun(runId, 'paused', '用户停止分析'); throw new Error('分析已暂停，可再次点击“生成主题”继续'); } await finishVoiceRun(runId, 'error', `第 ${index + 1} 块模型连接失败`); throw new Error(`第 ${index + 1} 块本地模型分析失败`); }
    const dimensions = parseDimensions(output);
    if (!dimensions.length) { await finishVoiceRun(runId, 'error', `第 ${index + 1} 块未识别出主题`); throw new Error(`第 ${index + 1} 块未识别出主题`); }
    results.push(dimensions);
    await logLocalAICall({ request_type: 'voice_analyze', system_prompt: system, user_prompt: user, response_summary: output.slice(0, 200), success: true, model_name: model });
    await updateVoiceRunProgress(runId, index + 1, results);
  }
  const merged = mergeDimensions(results).map(item => ({ ...item, evidence: JSON.stringify(findVoiceEvidence(item.name, items)) }));
  if (signal?.aborted) { await finishVoiceRun(runId, 'paused', '用户停止分析'); throw new Error('分析已暂停，可再次点击“生成主题”继续'); }
  await replaceVoiceDimensions(merged, name, projectId, runId);
  await finishVoiceRun(runId, 'done');
  onProgress?.(`已生成 ${merged.length} 个主题，原声证据已关联`);
  return merged;
}
