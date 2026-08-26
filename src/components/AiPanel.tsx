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
import { verifyConclusionNumbers } from '../verifyConclusion';

// ===== 页面 → 上下文名（App 传入当前页 key） =====
const PAGE_LABELS: Record<string, string> = {
  dashboard: '工作台', projects: '项目管理', competitors: '竞品管理', compare: '对比分析',
  reports: '成本报告', workLog: '工作手账', parts: '器件库', modules: '模块库',
  supplierManagement: '供应商管理', decomposition: '物料趋势洞察', userVoice: '用户原声分析',
  quoteReview: '审价',
};

// 行情/洞察类任务判断：用于无关工具软拦截（用户：更新行情却调用了查询项目工具）
const isTrendTask = (q: string) => /行情|洞察|趋势|最新价格|物料行情/.test(q || '');
const IRRELEVANT_FOR_TREND = ['query_project_bom', 'query_project_cost', 'query_part_suppliers', 'query_project_health', 'compare_subcategory_cost'];

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
  const pendingRetryRef = useRef<{ prompt: string; material?: string; category?: string } | null>(null); // 云端申请等待确认：确认后直接云端查询（不依赖模型）
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
      if (pr.material) { runCloudDirectRef.current?.(pr.material, pr.category || ''); }
      else setTimeout(() => { sendRef.current?.(pr.prompt); }, 300);
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
    // ⚠️ 2026-08-18 修复"没反应"：streaming 延后到所有前置构建成功之后——前置抛错撤回消息不卡死
    let tools: any[] = [];
    let sys = '';
    let baseUrl = '';
    try {
    tools = listTools();
    const toolList = tools.map(t =>
      t.name + '（' + t.id + '）' + (t.params.length ? ' 参数：' + t.params.map((p: any) => p.key + (p.required ? '' : '?') + '(' + p.desc + ')').join(',') : '无参数')
    );
    let prefCtx = '';
    try { prefCtx = await import('../aiLearning').then(m => m.buildPreferenceContext()); } catch { prefCtx = ''; }
    sys = buildThinkSystemPrompt(toolList, prefCtx) + '\n\n【任务执行】用户让你做任何查询/分析/洞察时，必须先用工具获取真实数据再回答：\n' +
      '· 更新/查询某物料的最新行情洞察（如"更新 Scaler IC 行情"）→ 必须两步都做完，缺一不可：\n' +
      '   ① query_material_insight({"material_name":"物料名"}) 查历史结论\n' +
      '   ② insight_material_trend({"material_name":"物料名","category":"品类"}) 查最新行情（云端，需底部横幅审批；审批确认后会自动续跑）\n' +
      '   注意：即使①已有历史结论，也必须做②——"更新"就是要最新行情，不能只复述历史后说"请提供更多数据"就结束。\n' +
      '· 保持物料一致：用户指定什么物料就用什么（如 Scaler IC），严禁擅自换成其他物料（如液晶面板）。\n' +
      '· 查项目/器件/供应商/竞品/原声/目标 → 对应 query_* 工具\n' +
      '· 计算核验 → calc\n' +
      '【严禁】行情/洞察类任务调用 query_project_bom / query_project_cost / query_part_suppliers / query_project_health / compare_subcategory_cost 等与物料行情无关的工具。\n' +
      '【禁止自言自语】不要输出"让我先查看…""现在我需要…"这类计划性独白——需要数据就直接输出 [TOOL] 调用标记，否则直接给结论。\n' +
      '【数据铁律】所有价格/百分比/份额/趋势数字必须来自工具 [RESULT] 返回的真实数据；禁止编造（如"$100-$150"）；工具没查到就明确说"未查到该物料行情数据"；输出前自检每个数字都能在工具结果里找到。\n' +
      '· 工具返回"等待确认/需审批"时【绝对禁止编造行情数据】——告诉用户"已提交云端审批，底部横幅确认后会自动续跑获取真实行情"，然后等待，不要自己编价格区间。\n' +
      '· 用户给的是品类级物料（如 Scaler IC）时，先用 query_material_insight 查看库内关联的具体型号，确认用户要查哪个型号，不要笼统编造。\n' +
      '【写回结论】分析类任务完成后，可把结论落库供以后参考（落库后对话显示"✅ 已记录"，对应面板自动展示）：\n' +
      '· 卖点/模块价值分析 → save_selling_analysis({"project_code":"项目代号","conclusion":"结论要点"})——如哪个卖点值得保留/哪个模块该降本减配\n' +
      '· 物料行情洞察 → insight_material_trend 已自动写入洞察列表卡片，无需额外操作\n' +
      '· 只有用户明确要求记录时才调用 save_* 工具，不要每次分析都写。\n' +
      '【数据工程】用户让你录入/拆解数据时（丢 BOM 表/供应商报价/竞品 BOM/原声）：\n' +
      '① 先 read_excel 或读取附件获取文件内容，理解表结构（识别 器件名/型号/数量/单价 列，不要猜列名）\n' +
      '② 解析成结构化 JSON 数组后调对应导入工具：BOM→import_bom_to_project（自动归类模块）、供应商报价→import_supplier_quote、竞品 BOM→import_competitor_bom、原声→import_voice_items\n' +
      '③ 数据校验：数量/单价必须是数字；缺失必填字段的条目跳过并报告；导入工具返回统计后如实汇报（新建几个器件/复用几个/跳过几个）\n' +
      '④ 用户没给目标项目/产品时先问清楚，不要擅自指定。\n' +
      '【报告与文件】用户要生成报告/演示/表格时：\n' +
      '· 生成报告/演示（HTML 网页报告或 PPTX）→ 分析完成把结论组织成 3-6 节（每节 heading+points）→ generate_report（保存到导出目录 exports/）\n' +
      '· 把数据整理成 Excel → write_excel（每表 rows 二维数组，第一行表头，数值用数字类型）\n' +
      '· 读用户提供的 Excel → read_excel；附件文件 → 输入区 📎\n' +
      '· 生成后如实汇报文件名/格式/保存位置，不编造内容。';
    baseUrl = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    // 用 state model（头部下拉选择已同步 setSetting；detectOllama 同步）
    if (!(model || modelInfo.model)) { message.warning('未选择模型（头部下拉选择）'); setStreaming(false); return; }
    } catch (e: any) {
      // 前置失败（提示词构建/配置读取）：撤回用户消息 + 报错，streaming 保持 false 可重试
      setMessages(prev => prev.slice(0, -1));
      setStreaming(false);
      message.error('发送失败：' + String(e?.message || e).slice(0, 200));
      return;
    }
    setStreaming(true);
    setMessages(prev => [...prev, { role: 'assistant', content: '', reasoning: '', steps: [] }]);
    followRef.current = true;

    // 数字防幻觉证据收集（工具/云端结果原文，供 verifyConclusionNumbers 校验结论文本）
    const evidenceParts: string[] = [];

    // 物料上下文保护：从提问提取目标物料（"更新X的行情"→X），防止模型跑题到其他物料（用户：Scaler IC 被换成液晶面板）
    const hintMatch = userContent.match(/(?:更新|查|看|洞察|分析)(?:一下)?([^\s，。,.、]{1,24}?)(?:的|的行情|的洞察|的走势|行情|趋势|洞察|价格)/);
    const targetMaterial = hintMatch ? hintMatch[1].trim() : '';

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
          // ⚠️ 2026-08-19 修复：insight_material_trend 返回"等待云端发送确认"时 ok 是 true（工具正常执行只是提示审批）——只看文本含"等待云端发送确认"即记 pending，确认后自动续跑
          if (res.text && res.text.includes('等待云端发送确认')) pendingRetryRef.current = { prompt: userContent, material: String(args?.material_name || ''), category: String(args?.category || '') };
          evidenceParts.push(res.text || '');
          // 物料一致性：用户指定了物料，模型却查别的 → 拦截提示（用户：Scaler IC 被换成液晶面板）
          if (targetMaterial && (id === 'query_material_insight' || id === 'insight_material_trend')) {
            const used = String(args?.material_name || '');
            if (used && used !== targetMaterial && !used.includes(targetMaterial) && !targetMaterial.includes(used)) {
              return { ...res, text: '[提示] 用户指定的物料是「' + targetMaterial + '」，但你查询的是「' + used + '」。请用「' + targetMaterial + '」重新调用 ' + id + ' 工具，不要换成其他物料。' };
            }
          }
          // 行情任务软拦截：无关工具调用给提示，引导改用行情工具（用户：更新 Scaler IC 行情却查了 M270 项目）
          if (isTrendTask(userContent) && IRRELEVANT_FOR_TREND.includes(id)) {
            return { ...res, text: res.text + '\n\n[提示] 当前是行情/洞察任务，你调用了与物料行情无关的工具。请改用 query_material_insight 查历史洞察、insight_material_trend 查最新行情（需审批），不要再查项目/器件数据。' };
          }
          return res;
        },
        approveCloud: async (call) => {
          const { requestCloudConfirm, getPendingConfirms } = await import('../cloudConfirm');
          const material = String(call.material_name || '');
          const ok = await requestCloudConfirm({ material, category: String(call.category || '') });
          if (ok) return true;
          // false 分两种情况：①刚入队/已在队列=等待确认（'pending'，不能误报"用户拒绝"）②本会话已跳过=真拒绝
          const inQueue = getPendingConfirms().some(p => p.material === material);
          if (inQueue) { pendingRetryRef.current = { prompt: userContent, material, category: String(call.category || '') }; return 'pending'; }
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
          onToolResult: (name, args, ok, text) => { evidenceParts.push(text || ''); appendStep({ kind: 'tool', name, ok, detail: JSON.stringify(args || {}) + ' → ' + (text || '').slice(0, 150) }); },
          onCloudResult: (_call, ok, result) => { evidenceParts.push(result || ''); appendStep({ kind: 'cloud', name: '云端行情', ok, detail: (ok ? '✓ ' : '✗ ') + (result || '').slice(0, 150) }); },
        },
      });
      finalText = res.finalText || '';
      // 数字防幻觉：结论中的数字必须在工具/云端结果证据中出现，否则附注请人工核对（用户：模型编造"$100-$150"行情）
      try {
        const { unverified } = verifyConclusionNumbers(finalText, userContent + '\n' + evidenceParts.join('\n'));
        if (unverified.length > 0) {
          finalText += '\n\n[校验] 含 ' + unverified.length + ' 个未能溯源的数字：' + unverified.map(u => u.ctx).join('、') + '——请人工核对（行情数字应以工具 [RESULT] 为准）';
        }
      } catch { /* 校验失败不影响 */ }
      // 代码级防"假更新"：本轮有"等待云端发送确认"的工具结果（云端未真正执行）→ 结论前强制警示，防模型假装已更新
      if (evidenceParts.some(t => String(t || '').includes('等待云端发送确认'))) {
        finalText = '⚠️ 云端行情审批待确认：请点击屏幕底部「🔐 等待云端发送确认」横幅确认，确认后系统将自动获取真实行情并更新洞察卡片。以下内容中的行情数字未经云端核实。\n\n' + finalText;
      }
    } catch (e: any) {
      finalText = '模型调用失败：' + String(e?.message || e).slice(0, 300);
      setMessages(prev => {
        const arr = [...prev]; const last = arr[arr.length - 1];
        if (last && last.role === 'assistant' && !last.content) arr[arr.length - 1] = { ...last, content: finalText };
        return arr;
      });
    } finally {
      setStreaming(false); // 任何路径都复位（用户：没反应=streaming 卡死）
    }
    // 完成后用干净结论覆盖（onAnswer 累积的多轮文本含 [TOOL] 标记与中间轮重复，finalText 才是 cleanProtocolText 后的结论）
    setMessages(prev => {
      const arr = [...prev]; const last = arr[arr.length - 1];
      if (last && last.role === 'assistant') arr[arr.length - 1] = { ...last, content: finalText };
      return arr;
    });
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

  // ===== 审批确认后直接云端查询+写库（2026-08-19：不依赖 9B 模型重新调工具——确认即真正更新洞察） =====
  const runCloudDirect = async (material: string, category: string) => {
    setStreaming(true);
    setMessages(prev => [...prev, { role: 'user', content: '（云端审批已确认，正在获取「' + material + '」最新行情…）' }]);
    setMessages(prev => [...prev, { role: 'assistant', content: '', reasoning: '', steps: [] }]);
    followRef.current = true;
    try {
      const { agentSearchLoop } = await import('../trendService');
      const r = await agentSearchLoop(material, category, 'price-trend');
      let synced = false;
      try {
        const { getDb, saveTrendSnapshot } = await import('../db');
        const db = await getDb();
        const items = await db.select<any[]>('SELECT * FROM trend_items WHERE query_category LIKE ? ORDER BY id DESC LIMIT 1', ['%' + material + '%']);
        if (items.length) {
          await saveTrendSnapshot({ trend_item_id: items[0].id, source_type: 'ai_panel', direction: r.trend_direction || '', confidence_level: r.confidence_level || '', summary: r.summary || '', suggested_action: r.suggested_action || '', skill_used: 'ai_confirm_retry', magnitude_min: r.magnitude_min, magnitude_max: r.magnitude_max });
          await db.execute("UPDATE trend_items SET last_queried_at=datetime('now','localtime') WHERE id=?", [items[0].id]);
          synced = true;
          try { window.dispatchEvent(new CustomEvent('costhub-trend-updated')); } catch { }
        }
      } catch (e) { console.error('写库失败:', e); }
      const text = '✅ 云端审批已确认，已获取「' + material + '」最新行情：\n趋势 ' + (r.trend_direction || '信号不明确') + '，置信度 ' + (r.confidence_level || '中') + (r.magnitude_min != null ? '，近1-3月幅度 ' + r.magnitude_min + '%~' + (r.magnitude_max ?? '') + '%' : '') + '\n摘要：' + (r.summary || '') + (r.suggested_action ? '\n建议：' + r.suggested_action : '') + (synced ? '\n📌 已更新物料洞察列表卡片' : '\n（该物料不在洞察列表，未写卡片）');
      setMessages(prev => { const arr = [...prev]; const last = arr[arr.length - 1]; if (last && last.role === 'assistant') arr[arr.length - 1] = { ...last, content: text }; return arr; });
    } catch (e: any) {
      const err = '云端查询失败：' + String(e?.message || e).slice(0, 300);
      setMessages(prev => { const arr = [...prev]; const last = arr[arr.length - 1]; if (last && last.role === 'assistant' && !last.content) arr[arr.length - 1] = { ...last, content: err }; return arr; });
    } finally { setStreaming(false); }
  };
  const runCloudDirectRef = useRef<((m: string, c: string) => void) | null>(null);
  useEffect(() => { runCloudDirectRef.current = runCloudDirect; });

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
