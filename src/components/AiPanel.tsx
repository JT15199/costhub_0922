// 右侧 AI 互动窗（v2.3.19，2026-08-18 用户：功能页右侧放 AI 互动窗口，替代独立本地 AI 助手页）
// 设计：不预设功能——模型持有全部工具清单（文本协议 [TOOL]），对话里自主调用；右侧窗常驻、可折叠、可拖拽调宽
// 引擎：thinkEngine.runThinkLoop（多轮工具循环 + 轨迹事件）；轨迹=执行记录卡（🔧 工具 / 🔐 云端）
import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Tooltip, message, Select, Switch, Modal, Input } from 'antd';
import * as XLSX from 'xlsx';
import {
  PlusOutlined, HistoryOutlined, SendOutlined,
  RightOutlined, LeftOutlined, QuestionCircleOutlined, ReloadOutlined, StopOutlined,
  PaperClipOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { getSetting, setSetting, saveAIRequestLog } from '../db';
import { listTools, executeTool } from '../aiTools';
import { runThinkLoop, buildThinkSystemPrompt, parsePlanCall } from '../thinkEngine';
import { detectOllama } from '../aiStatus';
import { loadSessions, newSession, loadMessages, saveMsg, type Session } from '../aiPanelChat';
import { getDataReadiness } from '../dataReadiness';
import ToolResultView from './ToolResultView';
// 支持结果可视化的工具（分析结果直接看图，不依赖模型）
const VISUAL_TOOLS = ['query_project_cost', 'query_project_bom', 'query_target_status', 'compare_subcategory_cost', 'query_project_module_value', 'query_competitor_bom', 'insight_material_trend', 'query_material_insight', 'query_supplier_profile'];
import { detectSkills } from '../aiSkills';
import { buildDataMap } from '../dataMap';
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
// 规范化任务判断（2026-08-27 用户：主动规范化却收到"物料通用名没有洞察记录"——1B 模型跑偏去查行情工具）
const isCanonicalTask = (q: string) => /规范化|规范一下|标准名|统一命名|整理物料|物料规范/.test(q || '');
const IRRELEVANT_FOR_CANONICAL = ['query_material_insight', 'insight_material_trend', 'query_project_bom', 'query_project_cost', 'query_part_suppliers', 'query_project_health', 'compare_subcategory_cost', 'query_competitor_bom', 'query_supplier_profile', 'query_price_insights', 'query_voice_dims'];
// 写操作安全（2026-08-19 用户：防止工具乱改数据库）：导入类写工具执行前需用户确认；所有写工具执行后留审计日志
const WRITE_TOOLS = ['import_bom_to_project', 'import_supplier_quote', 'import_competitor_bom', 'import_voice_items'];
const AUDIT_TOOLS = [...WRITE_TOOLS, 'save_selling_analysis', 'save_project_analysis', 'create_todo', 'add_goal', 'insight_material_trend', 'quote_review', 'canonicalize_project'];
const WRITE_TOOL_NAMES: Record<string, string> = { import_bom_to_project: 'BOM 拆解入库', import_supplier_quote: '供应商报价入库', import_competitor_bom: '竞品 BOM 入库', import_voice_items: '原声批量导入' };

interface Step { kind: 'tool' | 'cloud'; name: string; ok: boolean; detail: string; args?: any; }
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKw, setSearchKw] = useState('');
  const [searchRes, setSearchRes] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // 2026-08-19 任务清单（[PLAN] 协议，借鉴 DSH todo_write/workflow）：模型拆解步骤，前端显示进度
  const [plan, setPlan] = useState<{ steps: string[]; done: number } | null>(null);
  // 2026-08-19 结构化澄清（借鉴 DSH ask_user_question）：AI 调 ask_user → 渲染选项等待用户点击
  const [pendingAsk, setPendingAsk] = useState<{ question: string; options: string[] } | null>(null);
  const [askInput, setAskInput] = useState('');
  const askResolveRef = useRef<((answer: string) => void) | null>(null);
  // 写操作确认（防止工具乱改数据库）
  const [pendingWrite, setPendingWrite] = useState<{ toolId: string; summary: string } | null>(null);
  const writeConfirmRef = useRef<{ resolve: (ok: boolean) => void } | null>(null);
  const [modelInfo, setModelInfo] = useState<{ ready: boolean; model: string }>({ ready: false, model: '' });
  const [ctxLabel, setCtxLabel] = useState(PAGE_LABELS[activePage || ''] || '当前页面');
  // 2026-08-18：模型选择 / 深度思考 / 附件（图片+Excel）
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [deepThink, setDeepThink] = useState(() => localStorage.getItem('ai-panel-deepthink') !== '0');
  const [attachments, setAttachments] = useState<{ kind: 'excel' | 'image'; name: string; data?: string; type?: string; label?: string; rowsCount?: number; headers?: string[] }[]>([]);
  const [readiness, setReadiness] = useState<{ ok: number; partial: number; missing: number; total: number }>({ ok: 0, partial: 0, missing: 0, total: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef({ aborted: false });
  const planRef = useRef<{ steps: string[] } | null>(null);
  const pendingRetryRef = useRef<{ prompt: string; material?: string; category?: string }[]>([]); // 云端申请等待确认队列（支持批量）：确认后逐个直接云端查询（不依赖模型）
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; current: string } | null>(null);
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
      const q = pendingRetryRef.current;
      if (!q.length) return;
      pendingRetryRef.current = [];
      const withMat = q.filter(x => x.material);
      if (withMat.length) {
        // 批量：逐个云端查询更新（借鉴 DSH workflow 批量编排），显示进度
        const runAll = async () => {
          for (let i = 0; i < withMat.length; i++) {
            setBatchProgress({ done: i, total: withMat.length, current: withMat[i].material || '' });
            await runCloudDirectRef.current?.(withMat[i].material || '', withMat[i].category || '');
          }
          setBatchProgress(null);
        };
        runAll();
      } else {
        const pr = q[0];
        setTimeout(() => { sendRef.current?.(pr.prompt); }, 300);
      }
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
    // 2026-08-19 智能附件：Excel → 只给模型摘要+类型引导（完整数据由 import_* 工具直接从全局附件数据读取，不再把表格当 prompt）
    let userContent = text;
    const images: string[] = [];
    if (attachments.length) {
      const excelParts = attachments.filter(a => a.kind === 'excel');
      if (excelParts.length) {
        const summary = excelParts.map(a => {
          const guide =
            a.type === 'bom' ? '这是 BOM 表——请调用 import_bom_to_project 自动拆解录入（工具会直接读取该表格完整数据，无需你传内容），然后分析成本结构、给出降本建议'
            : a.type === 'voice' ? '这是用户原声表——请调用 import_voice_items 自动导入（工具直接读取完整数据），再分析用户最在意的维度/卖点'
            : a.type === 'supplier' ? '这是供应商报价表——请调用 import_supplier_quote 自动录入（工具直接读取），再分析价格合理性'
            : a.type === 'competitor' ? '这是竞品数据表——请调用 import_competitor_bom 自动录入（工具直接读取），再给出对标分析'
            : '请读取该表格（可调 read_excel）并分析内容给出建议';
          return '【附件：' + a.name + ' · ' + (a.label || '表格') + ' · 列：' + (a.headers || []).slice(0, 8).join('/') + ' · ' + (a.rowsCount || 0) + ' 行】' + guide;
        }).join('\n');
        userContent += (text ? '\n\n' : '') + summary + (text ? '' : '\n\n请按上述引导处理该附件。');
      }
      const imgParts = attachments.filter(a => a.kind === 'image');
      if (imgParts.length) {
        const imgSummary = imgParts.map(a => {
          const W = window as any;
          const ocr = (W.__costhub_attachment_data || []).find((x: any) => x.name === a.name);
          return '【图片：' + a.name + '】' + (ocr ? '——已 OCR 提取为' + (ocr.label || ocr.type || '表格') + '（' + ((ocr.rows || []).length - 1) + ' 行），可按类型调 import_* 工具处理或直接分析内容' : '——需支持视觉的模型看图，或联网 OCR 提取文字');
        }).join('\n');
        userContent += (userContent ? '\n\n' : '') + imgSummary;
      }
      imgParts.forEach(a => { if (a.data) images.push(a.data); });
      setAttachments([]);
    }
    abortRef.current.aborted = false;
    setPlan(null);
    // 2026-08-27 发送前实时预检（不用页面加载时的缓存状态）：区分 Ollama 未运行 / 模型未下载，快速报原因不空跑 3 分钟
    try {
      const st = await detectOllama();
      if (!st.connected) {
        setModelInfo({ ready: false, model: st.model || '' });
        message.warning(st.reason === 'model-missing'
          ? '本地模型未下载：请先在 Ollama 拉取模型（如 qwen2.5:1.5b），或在 设置 → 连接设置 选择已下载的模型'
          : 'Ollama 未运行：请先启动 Ollama 再试（设置 → 连接设置 → 检测连接）');
        return;
      }
      if (st.model) setModelInfo({ ready: true, model: st.model });
    } catch {
      if (!modelInfo.ready) { message.warning('本地模型未连接（设置 → 连接设置 → 配置 Ollama 模型并启动）'); return; }
    }
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
    try { sys = (await buildDataMap()) + '\n\n'; } catch { sys = ''; } // 数据库地图：先看数据在哪再选工具（用户：AI 能否清晰知道什么内容在哪里）
    sys = sys + buildThinkSystemPrompt(toolList, prefCtx) + '\n\n【任务执行】用户让你做任何查询/分析/洞察时，必须先用工具获取真实数据再回答：\n' +
      '· 复杂任务（多步骤/多物料/分析+生成）先输出计划标记拆解步骤：[PLAN] {"steps":["步骤1","步骤2"]}——前端会显示执行进度，每完成一个工具自动勾选。\n' +
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
      '④ 用户没给目标项目/产品时先问清楚，不要擅自指定——用 ask_user 工具提问，options 必须给具体选项（问项目就先用 query_projects 拿项目列表作选项），不要空选项\n' +
      '【物料规范化】规范化是自动发生的隐线：导入 BOM/报价时新器件会自动规范成标准名（品类+规格+型号），用户无需主动操作。\n' +
      '· 仅当用户明确要"补规范存量项目"时才调 canonicalize_project（按项目批量补录，笼统物料如支架/底座只归类不编造规格）；用户说"规范化/规范一下"却没给项目时，用 ask_user 问要规范哪个项目（选项给项目列表）\n' +
      '· 严禁把"规范化"理解成查物料行情/洞察——规范化与行情无关，不要调 query_material_insight/insight_material_trend，也不要编造物料名\n' +
      '· 这是写操作：用户没明确指定项目代号时，必须先 ask_user 让用户选择要规范哪个项目（选项给项目列表），绝不能擅自选一个项目规范化\n' +
      '【写操作安全】以下工具会修改你的数据库，执行前会弹出确认（用户确认才执行）：import_bom_to_project / import_supplier_quote / import_competitor_bom / import_voice_items。\n' +
      '· 只有用户明确要求"录入/导入/写入"时才调用写工具；查询类工具（query_* 等）绝不写库。\n' +
      '· 不要为了完成任务擅自写入；用户取消写入时如实告知未修改任何数据。\n' +
      '· 所有写操作都会记录审计日志（谁·何时·用什么工具·改了什么），可追溯。\n' +
      '【报告与文件】用户要生成报告/演示/表格时：\n' +
      '· 生成报告/演示（HTML 网页报告或 PPTX）→ 分析完成把结论组织成 3-6 节（每节 heading+points）→ generate_report（保存到导出目录 exports/）\n' +
      '· 把数据整理成 Excel → write_excel（每表 rows 二维数组，第一行表头，数值用数字类型）\n' +
      '· 读用户提供的 Excel → read_excel；附件文件 → 输入区 📎\n' +
      '· 生成后如实汇报文件名/格式/保存位置，不编造内容。';
    // 2026-08-19 技能注入（借鉴 DSH Skills）：按提问检测匹配技能，追加精炼步骤
    try {
      const skills = detectSkills(userContent);
      if (skills.length) sys += '\n\n【当前任务技能】' + skills.map(s => s.name + '：' + s.guide).join('\n');
    } catch { }
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
          // 结构化澄清：ask_user 工具 → 渲染选项等待用户点击（借鉴 DSH ask_user_question）
          if (id === 'ask_user') {
            const question = String(args?.question || '');
            let options: string[] = [];
            try { const o = JSON.parse(String(args?.options || '[]')); if (Array.isArray(o)) options = o.map(String); } catch { }
            // 2026-08-27 问项目但模型没给选项 → 代码级自动填充项目列表（用户实测：只有"继续/跳过"两个无意义按钮）
            if (options.length === 0 && /项目|project|project_code/.test(question)) {
              try {
                const { getProjects } = await import('../db');
                const projs = (await getProjects('', '', '')).filter((x: any) => !x.is_deleted);
                options = projs.map((x: any) => String(x.code || x.name || '')).filter(Boolean).slice(0, 12);
                if (!options.length) options = ['暂无项目（先去项目管理页创建）'];
              } catch { }
            }
            setAskInput('');
            const answer = await new Promise<string>(resolve => {
              askResolveRef.current = resolve;
              setPendingAsk({ question, options });
            });
            return { ok: true, text: '用户选择了：' + answer };
          }
          // 写操作保护：canonicalize_project 会修改器件库，必须在用户明确指定项目代号后才能执行（用户没指定→先 ask_user 让用户选，不要擅自选项目写库——2026-08-27 用户实测：没指定项目被规范了 M270）
          if (id === 'canonicalize_project') {
            const codeMatch = userContent.match(/[A-Za-z]{1,4}\s?[-_]?\d{2,}/);
            if (!codeMatch) {
              return { ok: true, text: '[提示] 用户没有指定要规范哪个项目，且 canonicalize_project 会修改器件库（写入规范化结果）。请先调用 ask_user 工具让用户选择项目（可先调用 query_projects 拿到项目列表作为选项），不要擅自选一个项目规范化。' };
            }
          }
          // 写操作安全：导入类写工具执行前确认（用户确认才写库）
          if (WRITE_TOOLS.includes(id)) {
            const parts: string[] = [];
            for (const k of ['project_code', 'brand', 'model', 'product', 'file_name', 'material']) { if (args?.[k]) parts.push(k + '=' + String(args[k]).slice(0, 40)); }
            const summary = (WRITE_TOOL_NAMES[id] || id) + (parts.length ? '（' + parts.join('，') + '）' : '') + '——将写入你的数据库，请确认';
            const confirmed = await new Promise<boolean>(resolve => {
              writeConfirmRef.current = { resolve };
              setPendingWrite({ toolId: id, summary });
            });
            writeConfirmRef.current = null;
            setPendingWrite(null);
            if (!confirmed) return { ok: true, text: '用户取消了本次写入（' + (WRITE_TOOL_NAMES[id] || id) + '），未修改任何数据。' };
          }
          const res = await executeTool(id, args);
          // 写操作审计：所有写工具执行后留痕（谁·何时·用什么·改了什么）
          if (AUDIT_TOOLS.includes(id)) {
            try {
              const { logWriteAudit } = await import('../db');
              // 撤销支持：写工具内部收集插入 id（window.__costhub_undo）→ 记入审计 undo_json
              let undoJson = '';
              try { const W = window as any; const u = W.__costhub_undo; if (u && u.toolId === id) { undoJson = JSON.stringify(u.inserts || {}); W.__costhub_undo = null; } } catch { }
              await logWriteAudit(id, JSON.stringify(args || {}).slice(0, 300), (res.text || '').slice(0, 500), undoJson);
            } catch { }
          }
          // ⚠️ 2026-08-19 修复：insight_material_trend 返回"等待云端发送确认"时 ok 是 true（工具正常执行只是提示审批）——只看文本含"等待云端发送确认"即记 pending，确认后自动续跑
          if (res.text && res.text.includes('等待云端发送确认')) {
            const mm = String(args?.material_name || '');
            if (mm && !pendingRetryRef.current.some(x => x.material === mm)) pendingRetryRef.current.push({ prompt: userContent, material: mm, category: String(args?.category || '') });
          }
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
          // 规范化任务软拦截（2026-08-27 用户：主动说规范化却收到"物料通用名没有洞察记录"——模型跑偏去查行情工具）
          if (isCanonicalTask(userContent) && id !== 'canonicalize_project' && IRRELEVANT_FOR_CANONICAL.includes(id)) {
            return { ...res, text: res.text + '\n\n[提示] 当前是"物料规范化"任务。新器件导入时会自动规范化（隐线），无需查行情/洞察。如需补规范存量项目：用户已指定项目代号则调 canonicalize_project(project_code)；没指定则先调 ask_user 让用户选择项目（选项给项目列表）。不要调用行情/洞察/项目查询类工具，也不要编造物料名参数。' };
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
          if (inQueue) { if (!pendingRetryRef.current.some(x => x.material === material)) pendingRetryRef.current.push({ prompt: userContent, material, category: String(call.category || '') }); return 'pending'; }
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
            const content = (last.content || '') + t;
            arr[arr.length - 1] = { ...last, content };
            // 任务清单：模型输出 [PLAN] 标记 → 显示执行计划（借鉴 DSH）
            if (!planRef.current) { const p = parsePlanCall(content); if (p) { planRef.current = p; setPlan({ steps: p.steps, done: 0 }); } }
            return arr;
          }),
          onToolResult: (name, args, ok, text) => {
            evidenceParts.push(text || ''); appendStep({ kind: 'tool', name, ok, args: args || {}, detail: JSON.stringify(args || {}) + ' → ' + (text || '').slice(0, 150) });
            // 任务清单：完成一个工具 → 步骤进度 +1
            if (planRef.current) setPlan(p => p ? { ...p, done: Math.min(p.done + 1, p.steps.length) } : p);
          },
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
  // 表格行处理：识别类型 → 完整数据存全局（工具直接读）→ 附件摘要
  const handleSheetRows = async (name: string, rows: any[][]) => {
    const dataRows = rows.filter((r: any[]) => (r || []).some((c: any) => String(c || '').trim() !== ''));
    const headerRow = dataRows[0] || [];
    const headers = (headerRow || []).map((x: any) => String(x || ''));
    const body = dataRows.slice(1);
    const { detectSheetType } = await import('../sheetType');
    const st = detectSheetType(headers, body);
    try {
      const W = window as any;
      W.__costhub_attachment_data = (W.__costhub_attachment_data || []).filter((x: any) => x.name !== name);
      W.__costhub_attachment_data.push({ name, type: st.type, rows: [headerRow, ...body] });
    } catch { }
    setAttachments(prev => [...prev, { kind: 'excel', name, type: st.type, label: st.label, rowsCount: body.length, headers }]);
    message.success('已附加' + st.label + '：' + name + '（' + body.length + ' 行）');
  };
  const pickAttachment = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv,.txt,.pdf,image/*';
    input.onchange = async (ev: any) => {
      const file = ev.target?.files?.[0];
      if (!file) return;
      try {
        const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        // 表格类（xlsx/xls/csv）：解析成二维数组 → 识别类型存全局
        if (['.xlsx', '.xls', '.csv'].includes(ext)) {
          let rows: any[][];
          if (ext === '.csv') {
            const text = await file.text();
            const wb = XLSX.read(text, { type: 'string' });
            rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', header: 1 }) as any[][];
          } else {
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf);
            rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', header: 1 }) as any[][];
          }
          handleSheetRows(file.name, rows);
        } else if (ext === '.txt' || ext === '.pdf') {
          let text: string;
          if (ext === '.pdf') {
            const { extractPdfText } = await import('../attachmentTools');
            text = await extractPdfText(await file.arrayBuffer());
          } else { text = await file.text(); }
          const { textToRows } = await import('../attachmentTools');
          const rows = textToRows(text);
          if (rows) handleSheetRows(file.name, rows);
          else handleSheetRows(file.name, [['内容'], ...text.split('\n').map(l => [String(l || '').trim()]).filter(x => x[0])]);
        } else {
          // 图片：存 base64（VL 模型用）+ 立即 OCR 提取文字（拍照报价单等，非 VL 也能处理）
          const reader = new FileReader();
          reader.onload = async () => {
            const b64 = String(reader.result || '');
            let ocrText = '';
            try { const { ocrImage } = await import('../attachmentTools'); ocrText = await ocrImage(b64); } catch (e) { console.error('OCR 失败', e); }
            if (ocrText.trim()) {
              const { textToRows } = await import('../attachmentTools');
              const rows = textToRows(ocrText);
              if (rows) handleSheetRows(file.name, rows);
              else handleSheetRows(file.name, [['内容'], ...ocrText.split('\n').map(l => [String(l || '').trim()]).filter(x => x[0])]);
            }
            setAttachments(prev => [...prev, { kind: 'image', name: file.name, data: b64 }]);
            message.success('已附加图片：' + file.name + (ocrText.trim() ? '（OCR 提取 ' + ocrText.trim().split('\n').length + ' 行文字）' : '（未提取到文字，需联网 OCR 引擎）'));
          };
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

  // 会话搜索 Modal（2026-08-19）
  const runSearch = async () => {
    try { const { searchSessions } = await import('../aiPanelChat'); setSearchRes(await searchSessions(searchKw)); } catch { setSearchRes([]); }
  };
  const searchModal = (
    <Modal title="🔍 搜索历史会话" open={searchOpen} onCancel={() => setSearchOpen(false)} footer={null} width={420}>
      <Input placeholder="输入关键词（如：Scaler、降本、审价）" value={searchKw} onChange={e => setSearchKw(e.target.value)} onPressEnter={runSearch} style={{ marginBottom: 10 }} />
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        {searchRes.length === 0 ? (
          <div style={{ fontSize: 11.5, color: '#9A978B', textAlign: 'center', padding: 16 }}>输入关键词回车搜索会话内容</div>
        ) : searchRes.map((s: any) => (
          <div key={s.id} onClick={() => { setSearchOpen(false); switchSession(s.id); }} style={{ padding: '7px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#334155' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F4F3EE'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            {s.title || ('会话 #' + s.id)}
            <div style={{ fontSize: 10, color: '#94A3B8' }}>{String(s.updated_at || '').slice(0, 16)}</div>
          </div>
        ))}
      </div>
    </Modal>
  );

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
    <>
    {searchModal}

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
            <Dropdown menu={{ items: [
              { key: '__search', label: '🔍 搜索历史会话', onClick: () => setSearchOpen(true) },
              { type: 'divider' },
              ...sessions.map(s => ({ key: String(s.id), label: s.title || ('会话 #' + s.id), onClick: () => switchSession(s.id) })),
            ] }} placement="bottomRight">
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
        {/* 批量云端更新进度 */}
        {batchProgress && (
          <div style={{ background: '#EDF6F0', border: '1px solid #CDE3D4', borderRadius: 9, padding: '7px 11px', fontSize: 11, color: '#1F7A4C', lineHeight: 1.7 }}>
            🔄 批量更新行情：第 {batchProgress.done + 1}/{batchProgress.total} 个 · {batchProgress.current}
          </div>
        )}
        {/* 任务清单（[PLAN] 协议，借鉴 DSH todo_write/workflow） */}
        {plan && (
          <div style={{ background: '#FBFAF6', border: '1px solid #E6E4DC', borderRadius: 9, padding: '8px 11px', fontSize: 11, color: '#5F5D54', lineHeight: 1.8 }}>
            <div style={{ fontWeight: 700, color: '#181713', marginBottom: 3 }}>📋 执行计划</div>
            {plan.steps.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flexShrink: 0, width: 14, textAlign: 'center' }}>{i < plan.done ? '✅' : i === plan.done ? <span style={{ color: '#A67C1F' }}>⟳</span> : '□'}</span>
                <span style={{ textDecoration: i < plan.done ? 'line-through' : 'none', opacity: i < plan.done ? 0.6 : 1 }}>{s}</span>
              </div>
            ))}
          </div>
        )}
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
                          {/* 2026-08-19 结果可视化：查询类工具结果直接渲染图表/表格（不依赖模型） */}
                          {s.kind === 'tool' && s.ok && s.args && VISUAL_TOOLS.includes(s.name) && (
                            <ToolResultView toolId={s.name} args={s.args} />
                          )}
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
        {pendingWrite && (
          <div style={{ background: '#FFF3EC', border: '1px solid #F0C9B5', borderRadius: 9, padding: '9px 12px', marginBottom: 6 }}>
            <div style={{ fontSize: 12, color: '#181713', fontWeight: 700, marginBottom: 5 }}>⚠️ 确认写入数据库</div>
            <div style={{ fontSize: 11.5, color: '#5F5D54', marginBottom: 8, lineHeight: 1.6 }}>{pendingWrite.summary}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="small" type="primary" style={{ fontSize: 11.5, borderRadius: 6, background: '#C0392B', borderColor: '#C0392B' }} onClick={() => { writeConfirmRef.current?.resolve(true); }}>执行写入</Button>
              <Button size="small" style={{ fontSize: 11.5, borderRadius: 6 }} onClick={() => { writeConfirmRef.current?.resolve(false); }}>取消</Button>
            </div>
          </div>
        )}
        {pendingAsk && (
          <div style={{ background: '#FFF8EC', border: '1px solid #F0D9B5', borderRadius: 9, padding: '9px 12px', marginBottom: 6 }}>
            <div style={{ fontSize: 12, color: '#181713', fontWeight: 600, marginBottom: 7 }}>🤔 {pendingAsk.question}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {pendingAsk.options.length > 0 ? (
                <>
                  {pendingAsk.options.map((o, oi) => (
                    <Button key={oi} size="small" style={{ fontSize: 11.5, borderRadius: 6, background: '#FFFFFF', borderColor: '#D5C4A8' }} onClick={() => {
                      askResolveRef.current?.(o); askResolveRef.current = null; setPendingAsk(null); setAskInput('');
                    }}>{o}</Button>
                  ))}
                  <Button size="small" style={{ fontSize: 11.5, borderRadius: 6 }} onClick={() => {
                    askResolveRef.current?.('（用户选择跳过，请自行合理处理或说明）'); askResolveRef.current = null; setPendingAsk(null); setAskInput('');
                  }}>跳过</Button>
                </>
              ) : (
                <>
                  <Input size="small" placeholder="输入你的回答…" value={askInput}
                    onChange={e => setAskInput(e.target.value)}
                    onPressEnter={() => { const v = askInput.trim(); if (!v) return; askResolveRef.current?.(v); askResolveRef.current = null; setPendingAsk(null); setAskInput(''); }}
                    style={{ flex: 1, minWidth: 160, fontSize: 11.5, borderRadius: 6 }} />
                  <Button size="small" type="primary" style={{ fontSize: 11.5, borderRadius: 6 }} disabled={!askInput.trim()} onClick={() => { const v = askInput.trim(); if (!v) return; askResolveRef.current?.(v); askResolveRef.current = null; setPendingAsk(null); setAskInput(''); }}>发送</Button>
                  <Button size="small" style={{ fontSize: 11.5, borderRadius: 6 }} onClick={() => {
                    askResolveRef.current?.('（用户选择跳过，请自行合理处理或说明）'); askResolveRef.current = null; setPendingAsk(null); setAskInput('');
                  }}>跳过</Button>
                </>
              )}
            </div>
          </div>
        )}
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
    </>
  );
}