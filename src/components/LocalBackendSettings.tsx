import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Input, InputNumber, Modal, Select, Space, Switch, Tag, message } from 'antd';
import { CheckCircleOutlined, DownloadOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from '../db';
import { LOCAL_CONTEXT_CAP } from '../ai/modelProfile';
import { getLocalBackend, loadModelOptions, localModelsPath, modelOptionsKey, normalizeLocalBackend, type LocalBackend } from '../localBackend';
import { probePiCapability, runLocalProductionSampleAcceptance, type PiCapability, type SampleAcceptance } from '../ai/piCapability';
import { createPiExecutionContext } from '../ai/piExecution';

type ServerConfig = { executable: string; model_path: string; mmproj: string; port: number; context_size: number; gpu_layers: number; threads: number; batch_size: number; reasoning: 'auto' | 'on' | 'off' };
const defaults: ServerConfig = { executable: '', model_path: '', mmproj: '', port: 8080, context_size: 0, gpu_layers: 0, threads: 8, batch_size: 512, reasoning: 'auto' };

export default function LocalBackendSettings() {
  const [backend, setBackend] = useState<LocalBackend>('ollama');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [health, setHealth] = useState<'unknown' | 'loading' | 'ready' | 'failed'>('unknown');
  const [serverNotice, setServerNotice] = useState('');
  const [serverConfig, setServerConfig] = useState<ServerConfig>(defaults);
  const [capability, setCapability] = useState<PiCapability | null>(null);
  const [sample, setSample] = useState<SampleAcceptance | null>(null);
  const [probeRunning, setProbeRunning] = useState(false);
  const [sampleRunning, setSampleRunning] = useState(false);
  const [modelOptions, setModelOptions] = useState<{ reasoningEffort: 'low' | 'medium' | 'xhigh'; preserveThinking: boolean; temperature?: number; maxTokens: number }>({ reasoningEffort: 'medium', preserveThinking: false, maxTokens: 0 });
  const probeAbort = useRef<AbortController | null>(null);
  const probeGeneration = useRef(0);
  const serverGeneration = useRef(0);
  const lastServerOperation = useRef<{ generation: number; action: 'start' | 'stop' | 'config' }>({ generation: 0, action: 'config' });
  const [serverAction, setServerAction] = useState<'start' | 'stop' | null>(null);
  const serverActionRef = useRef<'start' | 'stop' | null>(null);

  const save = (key: string, value: string) => setSetting(key, value);
  const invalidateProbe = () => { probeGeneration.current += 1; probeAbort.current?.abort(); };
  const invalidateServer = (action: 'start' | 'stop' | 'config') => { const generation = ++serverGeneration.current; lastServerOperation.current = { generation, action }; return generation; };
  const refreshServerStatus = async () => { try { const status = await invoke<{ running: boolean }>('llama_server_status'); setServerRunning(Boolean(status?.running)); } catch { setServerRunning(false); } };
  const load = async () => {
    const b = normalizeLocalBackend(await getLocalBackend());
    const [url, selectedModel, ...values] = await Promise.all([
      getSetting('local_ai_base_url', b === 'llama.cpp' ? 'http://127.0.0.1:8080' : 'http://localhost:11434'), getSetting('local_ai_model', ''),
      ...Object.keys(defaults).map(key => getSetting(`llama_cpp_${key}`, String(defaults[key as keyof ServerConfig]))),
    ]);
    const next = { ...defaults };
    Object.keys(defaults).forEach((key, index) => {
      const value = values[index];
      if (key === 'reasoning') (next as any)[key] = ['auto', 'on', 'off'].includes(value) ? value : defaults.reasoning;
      else if (key === 'executable' || key === 'model_path' || key === 'mmproj') (next as any)[key] = value;
      else (next as any)[key] = Number(value) >= 0 ? Number(value) : (defaults as any)[key];
    });
    setBackend(b); setBaseUrl(url); setModel(selectedModel); setServerConfig(next);
    if (selectedModel) { const options = await loadModelOptions(b, url, selectedModel); setModelOptions({ reasoningEffort: options.reasoningEffort || 'medium', preserveThinking: options.preserveThinking ?? false, ...(options.temperature === undefined ? {} : { temperature: options.temperature }), maxTokens: options.maxTokens || 0 }); }
    if (b === 'llama.cpp') await refreshServerStatus();
  };
  useEffect(() => { void load(); return () => { probeGeneration.current += 1; probeAbort.current?.abort(); invalidateServer('config'); }; }, []);
  const updateServer = (key: keyof ServerConfig, value: string | number | null) => { setServerConfig(current => ({ ...current, [key]: value === null ? 0 : value })); if (key === 'port') { invalidateProbe(); invalidateServer('config'); setCapability(null); setHealth('unknown'); } };
  const updateModelOptions = async (patch: Partial<typeof modelOptions>) => { const next = { ...modelOptions, ...patch }; setModelOptions(next); if (model) await save(modelOptionsKey(backend, baseUrl, model), JSON.stringify(next)); };
  const managedUrl = () => `http://127.0.0.1:${serverConfig.port}`;
  const persistServer = async (syncEndpoint = false) => {
    for (const [key, value] of Object.entries(serverConfig)) await save(`llama_cpp_${key}`, String(value));
    if (syncEndpoint && backend === 'llama.cpp' && /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+$/i.test(baseUrl)) { const url = managedUrl(); setBaseUrl(url); await save('local_ai_base_url', url); }
  };
  const checkHealth = async (probeUrl = baseUrl, requestGeneration = serverGeneration.current): Promise<boolean> => {
    if (requestGeneration !== serverGeneration.current) return false;
    setHealth('loading');
    try {
      const response = await invoke<{ success: boolean; status: number; body: string }>('http_get', { request: { url: `${probeUrl.replace(/\/$/, '')}${localModelsPath(backend)}`, headers: {}, body: null, backend } });
      if (!response.success) throw new Error(response.body || `HTTP ${response.status}`);
      const data = JSON.parse(response.body || '{}');
      const nextModels = (data.models || data.data || []).map((item: any) => String(item.name || item.id || '')).filter(Boolean);
      if (requestGeneration !== serverGeneration.current) return false;
      setModels(nextModels); if (model && !nextModels.includes(model)) { setModel(''); void save('local_ai_model', ''); }
      setHealth('ready'); return true;
    } catch (error) { if (requestGeneration === serverGeneration.current) setHealth('failed'); return false; }
  };
  const refresh = async () => { const requestGeneration = serverGeneration.current; setLoading(true); try { if (await checkHealth(baseUrl, requestGeneration)) message.success('模型列表已刷新'); else if (requestGeneration === serverGeneration.current) message.error('连接失败，请检查地址和服务日志'); } finally { setLoading(false); } };
  const manageServer = async (action: 'start' | 'stop') => {
    if (serverActionRef.current === action || (action === 'start' && serverActionRef.current === 'stop')) return;
    const operation = invalidateServer(action);
    serverActionRef.current = action; setServerAction(action); setLoading(true);
    try {
      if (action === 'start') {
        const url = managedUrl(); setBaseUrl(url); await save('local_ai_base_url', url); await persistServer(); setServerNotice(''); setHealth('loading');
        if (operation !== serverGeneration.current || serverActionRef.current !== 'start') return;
        const result = await invoke<{ running: boolean }>('llama_server_start', { config: serverConfig }); setServerRunning(Boolean(result?.running));
        if (operation !== serverGeneration.current || serverActionRef.current !== 'start') {
          if (lastServerOperation.current.action === 'stop' && lastServerOperation.current.generation > operation) await invoke('llama_server_stop').catch(() => {});
          return;
        }
        if (!result?.running) { setServerNotice('llama.cpp 进程未能保持运行，请查看最近日志。'); throw new Error('llama.cpp 进程已退出'); }
        let ready = false;
        const deadline = Date.now() + 180000;
        while (!ready) {
          if (operation !== serverGeneration.current || serverActionRef.current !== 'start') return;
          ready = await checkHealth(url, operation);
          if (operation !== serverGeneration.current || serverActionRef.current !== 'start') return;
          if (ready) break;
          const status = await invoke<{ running: boolean }>('llama_server_status').catch(() => ({ running: false }));
          if (operation !== serverGeneration.current || serverActionRef.current !== 'start') return;
          setServerRunning(Boolean(status?.running));
          if (!status?.running) { setServerNotice('llama.cpp 进程已退出，请查看最近日志。'); throw new Error('llama.cpp 进程已退出'); }
          const remaining = deadline - Date.now();
          if (remaining <= 0) { setServerNotice('llama.cpp 仍在加载，等待已超时；进程可能仍在运行，可查看日志或点击停止。'); setHealth('loading'); throw new Error('llama.cpp 等待服务就绪超时（进程可能仍在加载）'); }
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
        }
        setServerNotice('');
        message.success('llama.cpp 服务已可用');
      } else { await invoke('llama_server_stop'); if (operation !== serverGeneration.current) return; setServerRunning(false); setHealth('unknown'); setServerNotice(''); message.success('llama.cpp 已停止'); }
    } catch (error: any) { if (!String(error?.message || error).includes('等待服务就绪超时')) setHealth('failed'); message.error(`操作失败：${error?.message || error}`); } finally { if (serverActionRef.current === action) { serverActionRef.current = null; setServerAction(null); setLoading(false); } }
  };
  const runProbe = async () => {
    if (probeAbort.current) { probeAbort.current.abort(); return; }
    if (!model) { message.warning('请先选择模型'); return; }
    const controller = new AbortController(); const generation = ++probeGeneration.current; probeAbort.current = controller; setProbeRunning(true); setLoading(true);
    try { const result = await probePiCapability(baseUrl, model, true, backend, controller.signal); if (generation === probeGeneration.current && !controller.signal.aborted) setCapability(result); } catch (error: any) { if (!controller.signal.aborted) message.error(String(error?.message || error)); } finally { if (probeAbort.current === controller) { probeAbort.current = null; setProbeRunning(false); setLoading(false); } }
  };
  const exportDiagnostics = () => {
    const cleanText = (value: unknown) => String(value || '').replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s,;，；)）]+/g, '<path>').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
    const cleanModel = model ? model.split(/[\\/]/).pop()?.slice(0, 120) || null : null;
    const payload = { appVersion: '2.3.19', backend, model: cleanModel, service: cleanText(capability?.ollamaVersion || capability?.build || ''), context: capability?.advertisedContext || null, vision: capability?.vision ?? null, toolchain: capability ? { supported: capability.supported, checks: capability.checks, durationMs: capability.durationMs, reason: cleanText(capability.reason) } : null, sample: sample ? { ...sample, reason: cleanText(sample.reason) } : null, exportedAt: new Date().toISOString() };
    Modal.confirm({ title: '导出脱敏诊断', content: '将包含应用版本、后端、模型文件名、服务版本、上下文、视觉能力、工具链结果和样例结果；不会包含原始模型目录、对话正文或数据库数据。', okText: '导出', cancelText: '取消', onOk: () => { const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'costhub-diagnostics.json'; link.click(); URL.revokeObjectURL(url); } });
  };
  const showLog = async () => { try { const log = await invoke<string>('llama_server_log'); const url = URL.createObjectURL(new Blob([log], { type: 'text/plain' })); const link = document.createElement('a'); link.href = url; link.download = 'llama-server.log'; link.click(); URL.revokeObjectURL(url); } catch (error: any) { message.error(String(error?.message || error)); } };
  const runSample = async () => {
    setSampleRunning(true);
    try { setSample(await runLocalProductionSampleAcceptance(await createPiExecutionContext())); }
    catch (error: any) { setSample({ ok: false, rows: 0, pages: 0, total: 0, compare: false, exportRows: 0, reason: String(error?.message || error) }); }
    finally { setSampleRunning(false); }
  };

  return <Card size="small" title="本地模型连接" style={{ marginBottom: 16 }}>
    <Space wrap>
      <Select value={backend} style={{ width: 150 }} options={[{ value: 'ollama', label: 'Ollama（默认）' }, { value: 'llama.cpp', label: 'llama.cpp' }]} onChange={async (value: LocalBackend) => { invalidateProbe(); invalidateServer('config'); const nextBase = baseUrl === 'http://localhost:11434' || baseUrl === 'http://127.0.0.1:8080' ? (value === 'llama.cpp' ? 'http://127.0.0.1:8080' : 'http://localhost:11434') : baseUrl; setBackend(value); setBaseUrl(nextBase); setModel(''); setModels([]); setHealth('unknown'); setCapability(null); await save('local_ai_backend', value); await save('local_ai_base_url', nextBase); await save('local_ai_model', ''); }} />
      <Input value={baseUrl} onChange={event => { invalidateProbe(); invalidateServer('config'); setBaseUrl(event.target.value); setModels([]); setCapability(null); setHealth('unknown'); }} onBlur={() => save('local_ai_base_url', baseUrl)} placeholder="http://127.0.0.1:8080" style={{ width: 260 }} />
      <Select showSearch allowClear value={model || undefined} style={{ width: 280 }} options={models.map(value => ({ value, label: value }))} onChange={value => { invalidateProbe(); invalidateServer('config'); const next = value || ''; setModel(next); setCapability(null); setHealth('unknown'); void save('local_ai_model', next); if (next) void loadModelOptions(backend, baseUrl, next).then(options => setModelOptions({ reasoningEffort: options.reasoningEffort || 'medium', preserveThinking: options.preserveThinking ?? false, ...(options.temperature === undefined ? {} : { temperature: options.temperature }), maxTokens: options.maxTokens || 0 })); }} placeholder="先刷新并选择模型" />
      <Button icon={<ReloadOutlined />} loading={loading && !probeAbort.current} onClick={refresh}>刷新模型</Button>
      <Button icon={probeRunning ? <StopOutlined /> : <CheckCircleOutlined />} loading={false} onClick={runProbe}>{probeRunning ? '取消自检' : '工具链自检'}</Button>
      <Button icon={<DownloadOutlined />} onClick={exportDiagnostics}>导出诊断</Button><Button loading={sampleRunning} onClick={runSample}>独立样例验收</Button>
    </Space>
    <Space wrap style={{ marginTop: 12 }}><Select value={modelOptions.reasoningEffort} onChange={value => void updateModelOptions({ reasoningEffort: value })} options={[{ value: 'low', label: '推理强度：低' }, { value: 'medium', label: '推理强度：中' }, { value: 'xhigh', label: '推理强度：高' }]} /><Switch checked={modelOptions.preserveThinking} onChange={value => void updateModelOptions({ preserveThinking: value })} checkedChildren="保留思考" unCheckedChildren="不保留思考" /><InputNumber min={0} max={2} step={0.1} value={modelOptions.temperature} placeholder="模型默认" onChange={value => void updateModelOptions({ temperature: value === null ? undefined : value })} addonBefore="温度（空=模型默认）" /><InputNumber min={0} max={1048576} value={modelOptions.maxTokens || undefined} onChange={value => void updateModelOptions({ maxTokens: value || 0 })} addonBefore="输出上限（空=不设）" /></Space>
    {backend === 'llama.cpp' && <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
      <Input value={serverConfig.executable} onChange={event => updateServer('executable', event.target.value)} onBlur={() => persistServer()} placeholder="llama-server.exe 路径（可用相对应用目录路径）" />
      <Input value={serverConfig.model_path} onChange={event => updateServer('model_path', event.target.value)} onBlur={() => persistServer()} placeholder="GGUF 模型路径（可用相对应用目录路径）" />
      <Input value={serverConfig.mmproj} onChange={event => updateServer('mmproj', event.target.value)} onBlur={() => persistServer()} placeholder="可选 mmproj 视觉投影文件路径" />
      <Space wrap><InputNumber min={1} max={65535} value={serverConfig.port} onChange={value => updateServer('port', value)} onBlur={() => persistServer(true)} addonBefore="端口" /><InputNumber min={0} max={1048576} value={serverConfig.context_size} onChange={value => updateServer('context_size', value)} onBlur={() => persistServer()} addonBefore="上下文（0=模型默认）" /><InputNumber min={0} max={999} value={serverConfig.gpu_layers} onChange={value => updateServer('gpu_layers', value)} onBlur={() => persistServer()} addonBefore="GPU层" /><InputNumber min={1} max={256} value={serverConfig.threads} onChange={value => updateServer('threads', value)} onBlur={() => persistServer()} addonBefore="线程" /><InputNumber min={1} max={8192} value={serverConfig.batch_size} onChange={value => updateServer('batch_size', value)} onBlur={() => persistServer()} addonBefore="批量" /><Select value={serverConfig.reasoning} onChange={value => { updateServer('reasoning', value); void save('llama_cpp_reasoning', value); }} options={[{ value: 'auto', label: '思考：自动' }, { value: 'on', label: '思考：开启' }, { value: 'off', label: '思考：关闭' }]} /></Space>
      <Space><Button type="primary" loading={serverAction === 'start'} disabled={serverAction === 'stop'} onClick={() => manageServer('start')}>启动 llama.cpp</Button><Button danger loading={serverAction === 'stop'} onClick={() => manageServer('stop')}>停止</Button><Button onClick={showLog}>查看最近日志</Button></Space>
    </Space>}
    <Alert type={health === 'ready' ? 'success' : health === 'failed' ? 'error' : 'info'} showIcon style={{ marginTop: 12 }} message={<span>连接状态：<Tag color={health === 'ready' ? 'green' : health === 'loading' ? 'orange' : health === 'failed' ? 'red' : 'default'}>{health === 'ready' ? '服务可用' : health === 'loading' ? '加载中' : health === 'failed' ? '连接失败' : '未检测'}</Tag>{backend === 'llama.cpp' && <Tag color={serverRunning ? 'green' : 'default'}>{serverRunning ? '本应用管理的服务运行中' : '未由本应用启动'}</Tag>}；修改 llama.cpp 启动参数后请停止并重新启动。输出长度未配置时不发送硬上限；实际上下文以服务报告为准。</span>} description={serverNotice || undefined} />
    {capability && <Descriptions size="small" column={2} style={{ marginTop: 12 }}><Descriptions.Item label="工具链">{capability.supported ? <Tag color="green">通过</Tag> : <Tag color="red">失败</Tag>}</Descriptions.Item><Descriptions.Item label="原因">{capability.reason}</Descriptions.Item><Descriptions.Item label="有效上下文">{capability.advertisedContext ? `${Math.min(capability.advertisedContext, LOCAL_CONTEXT_CAP)} tokens${capability.advertisedContext > LOCAL_CONTEXT_CAP ? `（服务报告 ${capability.advertisedContext}，已按上限 ${LOCAL_CONTEXT_CAP} 使用：上下文水位要够得着，自动压缩才会真正触发）` : ''}` : '服务未报告（按 8192 使用）'}</Descriptions.Item><Descriptions.Item label="视觉">{capability.vision == null ? '未报告' : capability.vision ? '已启用' : '未启用'}</Descriptions.Item></Descriptions>}
    {sample && <Alert type={sample.ok ? 'success' : 'error'} showIcon style={{ marginTop: 12 }} message={`独立样例验收：${sample.ok ? '通过' : '失败'}（${sample.rows} 行，${sample.pages} 页；不写入正式数据库）`} description={sample.reason} />}
  </Card>;
}
