// 右侧 AI 互动窗（v2.3.19，2026-08-18 用户：功能页右侧放 AI 互动窗口，替代独立本地 AI 助手页）
// 设计：不预设功能——模型持有全部工具清单（文本协议 [TOOL]），对话里自主调用；右侧窗常驻、可折叠、可拖拽调宽
// 引擎：thinkEngine.runThinkLoop（多轮工具循环 + 轨迹事件）；轨迹=执行记录卡（🔧 工具 / 🔐 云端）
import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Tooltip, message, Select, Switch } from 'antd';
import * as XLSX from 'xlsx';
import {
  PlusOutlined, HistoryOutlined, SendOutlined,
  RightOutlined, LeftOutlined, QuestionCircleOutlined, ReloadOutlined, StopOutlined,
  PaperClipOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { getSetting, setSetting, saveAIRequestLog } from '../db';
import { listTools, executeTool } from '../aiTools';
import { runThinkLoop, buildThinkSystemPrompt } from '../thinkEngine';
import { detectOllama } from '../aiStatus';
import { loadSessions, newSession, loadMessages, saveMsg, type Session } from '../aiPanelChat';
import { getDataReadiness } from '../dataReadiness';

// ===== 页面 → 上下文名（App 传入当前页 key） =====
const PAGE_LABELS: Record<string, string> = {
  dashboard: '工作台', projects: '项目管理', competitors: '竞品管理', compare: '对比分析',
  reports: '成本报告', workLog: '工作手账', parts: '器件库', modules: '模块库',
  supplierManagement: '供应商管理', decomposition: '物料趋势洞察', userVoice: '用户原声分析',
  quoteReview: '审价',
};

interface Step { kind: 'tool' | 'cloud'; name: string; ok: boolean; detail: string; }
interface Msg { role: 'user' | 'assistant'; content: string; reasoning?: string; steps?: Step[]; }

export default function AiPanel({ activePage }: { activePage?: string }) {
  // ===== 折叠 / 宽度（可拖拽调整，本地记忆） =====
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ai-panel-collapsed') === '1');
  const [width, setWidth] = useState(() => { const s = Number(localStorage.getItem('ai-panel-width')); return s >= 300 && s <= 560 ? s : 384; });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const widthRef = useRef(width); widthRef.current = width;
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (dragRef.current) {
        const w = Math.min(560, Math.max(300, dragRef.current.startW + (dragRef.current.startX - e.clientX)));
        setWidth(w); localStorage.setItem('ai-panel-width', String(w));
      }
    };
    const up = () => { if (dragRef.current) { dragRef.current = null; document.body.style.cursor = ''; } };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, []);
  const toggleCollapse = () => {
    const v = !collapsed; setCollapsed(v); localStorage.setItem('ai-panel-collapsed', v ? '1' : '0');
  };

  // ===== 对话状态 =====
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [modelInfo, setModelInfo] = useState<{ ready: boolean; model: string }>({ ready: false, model: '' });
  const [ctxLabel, setCtxLabel] = useState(PAGE_LABELS[activePage || ''] || '当前页面');
  // 2026-08-18：模型选择 / 深度思考 / 附件（图片+Excel）
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [deepThink, setDeepThink] = useState(() => localStorage.getItem('ai-panel-deepthink') !== '0');
  const [attachments, setAttachments] = useState<{ kind: 'excel' | 'image'; name: string; data: string }[]>([]);
  const [readiness, setReadiness] = useState<{ ok: number; partial: number; missing: number; total: number }>({ ok: 0, partial: 0, missing: 0, total: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef({ aborted: false });
  const pendingRetryRef = useRef<{ prompt: string } | null>(null); // 云端申请等待确认：确认后自动重发（costhub-insight-request）
  const followRef = useRef(true);

  // 上下文联动：页面切换 + 页面内选中对象（costhub-ai-ctx 事件，detail: { label }）
  useEffect(() => { setCtxLabel(PAGE_LABELS[activePage || ''] || '当前页面'); }, [activePage]);
  useEffect(() => {
    const h = (e: any) => { const label = e?.detail?.label; if (label) setCtxLabel(String(label)); };
    window.addEventListener('costhub-ai-ctx', h);
    return () => window.removeEventListener('costhub-ai-ctx', h);
  }, []);

  // 数据就绪度引导预填：任何入口 dispatch costhub-open-ai-prompt + localStorage(costhub-ai-prompt-pending) → 本窗直接消费发送
  useEffect(() => {
    const consume = () => {
      let raw: string | null = null;
      try { raw = localStorage.getItem('costhub-ai-prompt-pending'); } catch { }
      if (!raw) return;
      try { localStorage.removeItem('costhub-ai-prompt-pending'); } catch { }
      let prompt = raw, auto = false;
      try { const j = JSON.parse(raw); if (j && typeof j.prompt === 'string') { prompt = j.prompt; auto = !!j.auto; } } catch { }
      if (!prompt.trim()) return;
      setInput(prompt);
      if (auto) setTimeout(() => { sendRef.current?.(prompt); }, 400);
    };
    consume();
    window.addEventListener('costhub-open-ai-prompt', consume);
    return () => window.removeEventListener('costhub-open-ai-prompt', consume);
  }, []);

  // 聚焦右侧协作窗（原「本地 AI 助手」页入口统一改指向这里）：折叠则展开，然后聚焦输入框
  useEffect(() => {
    const h = () => {
      if (localStorage.getItem('ai-panel-collapsed') === '1') {
        setCollapsed(false); localStorage.setItem('ai-panel-collapsed', '0');
      }
      setTimeout(() => inputRef.current?.focus(), 150);
    };
    window.addEventListener('costhub-ai-focus', h);
    return () => window.removeEventListener('costhub-ai-focus', h);
  }, []);

  // 模型列表（/api/tags，供头部下拉选择）
  useEffect(() => {
    (async () => {
      try {
        const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
        const { invoke } = await import('@tauri-apps/api/core');
        const r = await invoke<{ success: boolean; body: string }>('http_get', { request: { url: base + '/api/tags', headers: {}, body: null } });
        if (r?.success) {
          const data = JSON.parse(r.body || '{}');
          setModels((data.models || []).map((m: any) => String(m.name || '')));
        }
      } catch { /* 拉取失败不影响 */ }
    })();
  }, []);

  // 云端审批确认后自动续跑（2026-08-18 用户：同意审批两次却失败——确认触发的是后台 autoInsight 重跑，不是对话）
  // 对话里遇到 'pending'/工具返回'等待确认'时记下提问；底部横幅确认后 costhub-insight-request → 自动重发，第二次审批放行 → 云端真正调用
  useEffect(() => {
    const h = () => {
      const pr = pendingRetryRef.current;
      if (!pr) return;
      pendingRetryRef.current = null;
      setTimeout(() => { sendRef.current?.(pr.prompt); }, 300);
    };
    window.addEventListener('costhub-insight-request', h);
    return () => window.removeEventListener('costhub-insight-request', h);
  }, []);

  // 模型状态探测
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try { const st = await detectOllama(); if (alive) { setModelInfo({ ready: st.connected, model: st.connected ? st.model : '' }); setModel(st.connected ? st.model : ''); } } catch { }
    };
    check();
    const iv = setInterval(check, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // 会话初始化 + 数据就绪度（引导入口用，动态计数不硬编码）
  useEffect(() => { loadSessions().then(s => setSessions(s)).catch(() => {}); }, []);
  useEffect(() => {
    let alive = true;
    getDataReadiness().then(items => { if (alive) setReadiness({ ok: items.filter(i => i.level === 'ok').length, partial: items.filter(i => i.level === 'partial').length, missing: items.filter(i => i.level === 'missing').length, total: items.length }); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const switchSession = async (id: number) => {
    if (streaming) return;
    const msgs = await loadMessages(id);
    setSessionId(id);
    setMessages(msgs.map(m => ({ role: m.role, content: m.content || '', reasoning: m.reasoning || '' })));
  };
  const newChat = async () => {
    if (streaming) return;
    setSessionId(null); setMessages([]); setInput('');
  };

  // 自动跟随滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // ===== 发送：模型自主调用工具（runThinkLoop） =====
  const send = async (raw: string) => {
    const text = (raw || '').trim();
    if ((!text && attachments.length === 0) || streaming) return;
    // 2026-08-18 附件：Excel 表格文本拼进提问；图片 base64 走多模态（images）
    let userContent = text;
    const images: string[] = [];
    if (attachments.length) {
      const excelParts = attachments.filter(a => a.kind === 'excel');
      if (excelParts.length) {
        userContent += (text ? '\n\n' : '') + excelParts.map(a => '【附件：' + a.name + '】\n' + a.data).join('\n\n') + '\n\n请基于以上附件内容一起分析。';
      }
      attachments.filter(a => a.kind === 'image').forEach(a => images.push(a.data));
      setAttachments([]);
    }
    abortRef.current.aborted = false;
    if (!modelInfo.ready) { message.warning('本地模型未连接（设置 → 连接设置 → 配置 Ollama 模型并启动）'); return; }
    let sid = sessionId;
    if (!sid) { sid = await newSession((userContent || '附件').slice(0, 20)); setSessionId(sid); setSessions(await loadSessions()); }
    const currentSid = sid;
    setMessages(prev => [...prev, { role: 'user', content: userContent }]);
    await saveMsg(currentSid, 'user', userContent);
    setInput('');
    setStreaming(true);
    setMessages(prev => [...prev, { role: 'assistant', content: '', reasoning: '', steps: [] }]);
    followRef.current = true;

    const tools = listTools();
    const toolList = tools.map(t =>
      t.name + '（' + t.id + '）' + (t.params.length ? ' 参数：' + t.params.map(p => p.key + (p.required ? '' : '?') + '(' + p.desc + ')').join(',') : '无参数')
    );
    let prefCtx = '';
    try { prefCtx = await import('../aiLearning').then(m => m.buildPreferenceContext()); } catch { prefCtx = ''; }
    const sys = buildThinkSystemPrompt(toolList, prefCtx) + '\n\n【任务执行】用户让你做任何查询/分析/洞察时，必须先用工具获取真实数据再回答：\n' +
      '· 查已有物料洞察/趋势结论 → query_price_insights\n' +
      '· 查物料是否洞察过/最近洞察结论 → query_material_insight（如 Scaler IC）\n' +
      '· 查最新行情趋势（需云端，走审批横幅） → insight_material_trend\n' +
      '· 查项目/器件/供应商/竞品/原声/目标 → 对应 query_* 工具\n' +
      '· 计算核验 → calc\n' +
      '禁止不调工具凭空"搜索/综合"或编造数据；工具结果在 [RESULT] 返回后基于真实数据回答。数据不足就明确说缺什么。';
    const baseUrl = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    // 用 state model（头部下拉选择已同步 setSetting；detectOllama 同步）
    if (!(model || modelInfo.model)) { message.warning('未选择模型（头部下拉选择）'); setStreaming(false); return; }

    const appendStep = (st: Step) => {
      setMessages(prev => {
        const arr = [...prev]; const last = arr[arr.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        arr[arr.length - 1] = { ...last, steps: [...(last.steps || []), st] };
        return arr;
      });
    };

    let finalText = '';
    try {
      const res = await runThinkLoop({
        baseUrl, model, systemPrompt: sys, userContent,
        think: deepThink,
        images,
        localTools: tools.map(x => ({ id: x.id, desc: x.desc, params: x.params })),
        executeTool: async (id, args) => {
          const res = await executeTool(id, args);
          if (!res.ok && res.text.includes('等待云端发送确认')) pendingRetryRef.current = { prompt: userContent };
          return res;
        },
        approveCloud: async (call) => {
          const { requestCloudConfirm, getPendingConfirms } = await import('../cloudConfirm');
          const material = String(call.material_name || '');
          const ok = await requestCloudConfirm({ material, category: String(call.category || '') });
          if (ok) return true;
          // false 分两种情况：①刚入队/已在队列=等待确认（'pending'，不能误报"用户拒绝"）②本会话已跳过=真拒绝
          const inQueue = getPendingConfirms().some(p => p.material === material);
          if (inQueue) { pendingRetryRef.current = { prompt: userContent }; return 'pending'; }
          return false;
        },
        runCloud: async (call) => {
          const { agentSearchLoop } = await import('../trendService');
          return agentSearchLoop(String(call.material_name || ''), String(call.category || ''), 'price-trend');
        },
        abortRef: abortRef.current,
        onEvent: {
          onRoundStart: () => setMessages(prev => {
            const arr = [...prev]; const last = arr[arr.length - 1];
            if (last && last.role === 'assistant') arr[arr.length - 1] = { ...last, content: '', reasoning: '' };
            return arr;
          }),
          onThought: (t) => setMessages(prev => {
            const arr = [...prev]; const last = arr[arr.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            arr[arr.length - 1] = { ...last, reasoning: (last.reasoning || '') + t };
            return arr;
          }),
          onAnswer: (t) => setMessages(prev => {
            const arr = [...prev]; const last = arr[arr.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            arr[arr.length - 1] = { ...last, content: (last.content || '') + t };
            return arr;
          }),
          onToolResult: (name, args, ok, text) => appendStep({ kind: 'tool', name, ok, detail: JSON.stringify(args || {}) + ' → ' + (text || '').slice(0, 150) }),
          onCloudResult: (_call, ok, result) => appendStep({ kind: 'cloud', name: '云端行情', ok, detail: (ok ? '✓ ' : '✗ ') + (result || '').slice(0, 150) }),
        },
      });
      finalText = res.finalText || '';
    } catch (e: any) {
      finalText = '模型调用失败：' + String(e?.message || e).slice(0, 300);
      setMessages(prev => {
        const arr = [...prev]; const last = arr[arr.length - 1];
        if (last && last.role === 'assistant' && !last.content) arr[arr.length - 1] = { ...last, content: finalText };
        return arr;
      });
    }
    // 完成后用干净结论覆盖（onAnswer 累积的多轮文本含 [TOOL] 标记与中间轮重复，finalText 才是 cleanProtocolText 后的结论）
    setMessages(prev => {
      const arr = [...prev]; const last = arr[arr.length - 1];
      if (last && last.role === 'assistant') arr[arr.length - 1] = { ...last, content: finalText };
      return arr;
    });
    setStreaming(false);
    try { await saveMsg(currentSid, 'assistant', finalText || '(无内容)'); } catch { }
    setSessions(await loadSessions().catch(() => sessions));
    try {
      await saveAIRequestLog({
        request_type: 'local_ai_chat', system_prompt: sys.slice(0, 2000),
        user_prompt: text.slice(0, 2000), response_summary: finalText.slice(0, 2000),
        success: true, provider_name: 'Ollama（本地）', model_name: model,
      });
    } catch { /* 忽略 */ }
  };

  // ===== 附件选择（2026-08-18 用户：对话框要能添加图片和 excel 等文件） =====
  const pickAttachment = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,image/*';
    input.onchange = async (ev: any) => {
      const file = ev.target?.files?.[0];
      if (!file) return;
      try {
        if (/\.(xlsx|xls)$/i.test(file.name)) {
          const buf = await file.arrayBuffer();
          const wb = XLSX.read(buf);
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 }) as any[][];
          const text = rows.slice(0, 120).map((r: any[]) => (r || []).map(String).join('\t')).join('\n');
          setAttachments(prev => [...prev, { kind: 'excel', name: file.name, data: text }]);
          message.success('已附加表格：' + file.name);
        } else {
          const reader = new FileReader();
          reader.onload = () => { setAttachments(prev => [...prev, { kind: 'image', name: file.name, data: String(reader.result || '') }]); message.success('已附加图片：' + file.name + '（需支持视觉的模型，如 qwen3-vl）'); };
          reader.readAsDataURL(file);
        }
      } catch (e: any) { message.error('附件读取失败：' + String(e?.message || e)); }
    };
    input.click();
  };

  // ===== 停止生成（2026-08-18 用户：模型没有停止功能） =====
  const stopGen = () => {
    abortRef.current.aborted = true;
    message.info('已请求停止，模型输出会尽快结束');
  };

  // sendRef：稳定引用（预填自动发送用，避免闭包捕获旧 send）
  const sendRef = useRef<((raw: string) => void) | null>(null);
  useEffect(() => { sendRef.current = send; });

  // ===== 渲染：折叠态 =====
  if (collapsed) {
    return (
      <div style={{ width: 42, height: '100vh', flexShrink: 0, background: '#F4F3EE', borderLeft: '1px solid #E6E4DC', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', overflow: 'hidden' }}>
        <Tooltip title="展开 AI 协作窗">
          <Button type="text" icon={<LeftOutlined />} onClick={toggleCollapse} style={{ color: '#181713' }} />
        </Tooltip>
        <div style={{ writingMode: 'vertical-rl', fontSize: 11, color: '#9A978B', letterSpacing: '0.2em', marginTop: 18, userSelect: 'none' }}>协作分析</div>
        <div style={{ flex: 1 }} />
        <Tooltip title="AI 使用指南">
          <Button type="text" icon={<QuestionCircleOutlined />} style={{ color: '#9A978B' }} onClick={() => window.dispatchEvent(new Event('costhub-open-ai-guide'))} />
        </Tooltip>
      </div>
    );
  }

  // ===== 渲染：展开态 =====
  return (
    <div style={{ width, height: '100vh', flexShrink: 0, background: '#F4F3EE', borderLeft: '1px solid #E6E4DC', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {/* 拖拽调整宽度 */}
      <div
        onMouseDown={e => { e.preventDefault(); dragRef.current = { startX: e.clientX, startW: widthRef.current }; document.body.style.cursor = 'col-resize'; }}
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 5 }}
      />

      {/* 头部（紧凑：模型选择 + 深度思考 + 操作按钮） */}
      <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid #E6E4DC', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: modelInfo.ready ? '#1F7A4C' : '#C0392B', flexShrink: 0 }} />
          <Select
            size="small" variant="borderless" showSearch
            style={{ width: 136, flexShrink: 0 }}
            value={model || undefined}
            placeholder={modelInfo.ready ? '选择模型' : '未连接'}
            options={models.map(m => ({ value: m, label: m }))}
            onChange={(v: string) => { setModel(v); setSetting('local_ai_model', v).catch(() => {}); setModelInfo(prev => ({ ...prev, model: v, ready: true })); }}
            popupMatchSelectWidth={false}
            title={modelInfo.ready ? '本地模型（Ollama）' : '本地模型未连接'}
          />
          <Tooltip title="深度思考：打开则模型先思考再回答（更深入，较慢）">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: deepThink ? '#181713' : '#9A978B', cursor: 'pointer', flexShrink: 0, userSelect: 'none' }}
              onClick={() => { const v = !deepThink; setDeepThink(v); localStorage.setItem('ai-panel-deepthink', v ? '1' : '0'); }}>
              <Switch size="small" checked={deepThink} style={{ background: deepThink ? '#181713' : '#B8B5AA' }} />
              深度思考
            </span>
          </Tooltip>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
            <Tooltip title="AI 使用指南"><Button type="text" size="small" icon={<QuestionCircleOutlined />} style={{ color: '#9A978B' }} onClick={() => window.dispatchEvent(new Event('costhub-open-ai-guide'))} /></Tooltip>
            <Tooltip title="新对话"><Button type="text" size="small" icon={<PlusOutlined />} style={{ color: '#5F5D54' }} onClick={newChat} /></Tooltip>
            <Dropdown menu={{ items: sessions.map(s => ({ key: String(s.id), label: s.title || ('会话 #' + s.id), onClick: () => switchSession(s.id) })) }} placement="bottomRight">
              <Tooltip title="历史会话"><Button type="text" size="small" icon={<HistoryOutlined />} style={{ color: '#5F5D54' }} /></Tooltip>
            </Dropdown>
            <Tooltip title="折叠"><Button type="text" size="small" icon={<RightOutlined />} style={{ color: '#5F5D54' }} onClick={toggleCollapse} /></Tooltip>
          </div>
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: '#5F5D54', background: '#FFFFFF', border: '1px solid #E6E4DC', borderRadius: 6, padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: '#9A978B' }}>当前</span><b style={{ color: '#181713', fontWeight: 600 }}>{ctxLabel}</b>
        </div>
      </div>
      {/* 对话区 */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && !streaming ? (
          <div style={{ fontSize: 11.5, color: '#9A978B', lineHeight: 1.9, padding: '6px 4px' }}>
            <div style={{ fontWeight: 700, color: '#5F5D54', marginBottom: 2 }}>直接说需求，我自动调用工具查库分析</div>
            · 这个项目哪里贵、怎么降？<br />
            · 审这份报价：面板 ¥610、驱动板 ¥185…<br />
            · 对比竞品 A 和 M270 的成本<br />
            · 用户原声里最在意什么？<br />
            · 我缺哪些数据、现在能做什么？
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
              {m.role === 'user' ? (
                <div style={{ maxWidth: '88%', background: '#181713', color: '#fff', borderRadius: 9, padding: '7px 11px', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{m.content}</div>
              ) : (
                <>
                  {m.reasoning ? (
                    <details style={{ width: '100%' }}>
                      <summary style={{ fontSize: 10.5, color: '#9A978B', cursor: 'pointer', userSelect: 'none' }}>思考过程（{m.reasoning.length} 字）</summary>
                      <div style={{ fontSize: 11, color: '#8B7355', whiteSpace: 'pre-wrap', lineHeight: 1.7, marginTop: 4, background: '#FBFAF6', border: '1px solid #E6E4DC', borderRadius: 7, padding: 7 }}>{m.reasoning}</div>
                    </details>
                  ) : null}
                  {m.steps && m.steps.length > 0 ? (
                    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {m.steps.map((s, si) => (
                        <div key={si} style={{ background: '#FBFAF6', border: '1px dashed #D5D2C6', borderRadius: 7, padding: '5px 9px', fontSize: 10.5, color: '#5F5D54', lineHeight: 1.6 }}>
                          <span>{s.kind === 'tool' ? '🔧' : '🔐'}</span> <b style={{ color: '#181713' }}>{s.name}</b> {s.ok ? '' : <span style={{ color: '#C0392B' }}>失败</span>}
                          <span style={{ marginLeft: 4, color: '#9A978B' }}>{s.detail}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ maxWidth: '92%', background: '#FFFFFF', border: '1px solid #E6E4DC', borderRadius: 9, padding: '7px 11px', fontSize: 12.5, lineHeight: 1.65, color: '#2B2925', whiteSpace: 'pre-wrap' }}>
                    {m.content || (streaming ? '正在分析…' : '')}
                  </div>
                </>
              )}
            </div>
          ))
        )}
        {streaming && messages.length > 0 && messages[messages.length - 1].role === 'user' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9A978B' }}>
            <ReloadOutlined spin /> 模型分析中（可自主调用工具）…
          </div>
        ) : null}
      </div>

      {/* 输入区 */}
      <div style={{ padding: '8px 10px', borderTop: '1px solid #E6E4DC', flexShrink: 0 }}>
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 5 }}>
            {attachments.map((a, ai) => (
              <span key={ai} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#FBFAF6', border: '1px solid #E6E4DC', borderRadius: 5, padding: '2px 7px', fontSize: 10.5, color: '#5F5D54' }}>
                <span>{a.kind === 'image' ? '🖼' : '📄'}</span>
                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                <Button type="text" size="small" icon={<DeleteOutlined />} style={{ fontSize: 10, width: 16, height: 16, padding: 0, color: '#9A978B' }} onClick={() => setAttachments(prev => prev.filter((_, i) => i !== ai))} />
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: '#FFFFFF', border: '1px solid #D5D2C6', borderRadius: 9, padding: '3px 3px 3px 6px' }}>
          <Tooltip title="附加文件（Excel / 图片）">
            <Button type="text" size="small" icon={<PaperClipOutlined />} style={{ color: '#9A978B', flexShrink: 0 }} onClick={pickAttachment} />
          </Tooltip>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="直接说需求，模型自动调用工具…"
            disabled={streaming}
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 12.5, background: 'transparent', color: '#181713', padding: '6px 0' }}
          />
          {streaming ? (
            <Button
              size="small" icon={<StopOutlined />}
              onClick={stopGen}
              style={{ background: '#C0392B', borderColor: '#C0392B', color: '#fff', borderRadius: 7 }}
            />
          ) : (
            <Button
              type="primary" size="small" icon={<SendOutlined />}
              onClick={() => send(input)}
              style={{ background: '#181713', borderColor: '#181713', borderRadius: 7 }}
            />
          )}
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', fontSize: 10.5, color: '#9A978B' }}>
          <span>数据就绪度</span>
          <b style={{ color: readiness.missing > 0 ? '#A67C1F' : '#1F7A4C', marginLeft: 4 }}>{readiness.missing > 0 ? readiness.missing + ' 项缺' : '已就绪 ' + readiness.ok + '/' + readiness.total}</b>
          {readiness.missing > 0 && <span style={{ marginLeft: 8, color: '#9A978B' }}>· 半 {readiness.partial}</span>}
          <span style={{ marginLeft: 'auto', cursor: 'pointer', color: '#5F5D54' }} onClick={() => {
            try { localStorage.setItem('costhub-ai-prompt-pending', JSON.stringify({ prompt: '先看看我的数据就绪度：我缺哪些数据？没有这些数据，我现在能做到什么、做不到什么？分别建议怎么补。', auto: true })); } catch { }
            window.dispatchEvent(new Event('costhub-open-ai-prompt'));
          }}>让 AI 引导我 →</span>
        </div>
      </div>
    </div>
  );
}
