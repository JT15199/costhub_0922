import { useState, useEffect, useCallback } from 'react';
import { EmojiIcon } from '../iconMap';
import { Button, Input, Select, message, Empty, Popconfirm, DatePicker, Spin, Tooltip, Checkbox, Modal, AutoComplete } from 'antd';
import { PlusOutlined, DeleteOutlined, SearchOutlined, RobotOutlined, CheckOutlined, CloseOutlined, FlagOutlined, CheckCircleFilled, BookOutlined, PushpinOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  getWorkLogs, saveWorkLog, deleteWorkLog, toggleWorkLogDone,
} from '../db';

const LOG_CATEGORIES = ['成本分析', '供应商谈判', 'BOM审核', '项目推进', '会议', '问题解决', '工具建设', '其他'];

const NOTE_COLORS: Record<string, string> = {
  '成本分析': '#FFF8E1', '供应商谈判': '#FFE9E4', 'BOM审核': '#E8F4FD',
  '项目推进': '#E8F5E9', '会议': '#F3E8FF', '问题解决': '#FFEBEE',
  '工具建设': '#E0F7FA', '其他': '#F5F5F5',
};
const NOTE_PIN: Record<string, string> = {
  '成本分析': '#F9A825', '供应商谈判': '#F4511E', 'BOM审核': '#1E88E5',
  '项目推进': '#43A047', '会议': '#8E24AA', '问题解决': '#E53935',
  '工具建设': '#00ACC1', '其他': '#757575',
};

// 通用流式调用（复用 src/ollama.ts 的 startOllamaStream，与本地 AI 助手/演示生成器共用）
import { startOllamaStream } from '../ollama';
async function startSummaryStream(
  baseUrl: string, model: string,
  systemPrompt: string, userPrompt: string,
  onToken: (t: string) => void,
  onReasoning: (t: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
  onTimeout: () => void,
) {
  let finished = false;
  const timeoutId = setTimeout(() => { if (!finished) { finished = true; onTimeout(); } }, 600000);
  const finish = () => { if (!finished) { finished = true; clearTimeout(timeoutId); } };
  try {
    const cleanup = await startOllamaStream(
      baseUrl, model,
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      onToken,
      onReasoning,
      () => { finish(); onDone(); },
      (e) => { finish(); onError(e); },
      { num_predict: 16384, temperature: 0.3, think: false, endpoint: 'native', json: false },
    );
    // 超时后清理监听器
    const t = setTimeout(() => { try { cleanup(); } catch { } }, 610000);
    void t;
  } catch (e: any) { finish(); onError(String(e?.message || e)); }
}

export default function WorkLog() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [view, setView] = useState<'notes' | 'todos'>('notes');
  // 分类章节折叠状态（默认全展开）
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  // 便签编辑状态
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [noteDate, setNoteDate] = useState(dayjs());
  const [noteCategory, setNoteCategory] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  // 项目标签（来自项目库 + 自由输入，空=公共/其他）
  const [noteProject, setNoteProject] = useState('');
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  // 待办输入
  const [todoInput, setTodoInput] = useState('');
  const [todoProject, setTodoProject] = useState('');
  // 总结
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryRange, setSummaryRange] = useState<[any, any] | null>(null);
  // 时间轴：根据记录日期生成的快捷月份
  const [timelineMonths, setTimelineMonths] = useState<{ key: string; label: string; start: string; end: string; count: number }[]>([]);
  // 时间轴多选月份
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [summaryResult, setSummaryResult] = useState('');
  // 总结模型（独立设置，可用非思考型模型加速）
  const [summaryModel, setSummaryModel] = useState('');
  const [summaryModels, setSummaryModels] = useState<string[]>([]);
  // 已保存的总结
  const [savedSummaries, setSavedSummaries] = useState<any[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  // 当前查看全文的总结
  const [viewingSummary, setViewingSummary] = useState<any>(null);
  const [summaryElapsed, setSummaryElapsed] = useState(0);
  // 收到字符计数（实时反馈模型在响应）
  const [summaryChars, setSummaryChars] = useState(0);
  // 第一步压缩阶段的字符计数（压缩时界面也有实时反馈）
  const [condenseChars, setCondenseChars] = useState(0);
  // 第一步压缩阶段的实时文本（界面实时展示压缩内容）
  const [condensedText, setCondensedText] = useState('');
  const [summaryPhase, setSummaryPhase] = useState<'idle' | 'preparing' | 'reading' | 'generating' | 'done' | 'error'>('idle');

  // 总结计时器
  useEffect(() => {
    if (!summarizing) return;
    setSummaryElapsed(0);
    const start = Date.now();
    const iv = setInterval(() => setSummaryElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(iv);
  }, [summarizing]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getWorkLogs(categoryFilter, keyword, '', '', projectFilter);
      setLogs(rows);
    } catch (e) { console.error('加载失败:', e); }
    setLoading(false);
  }, [categoryFilter, keyword, projectFilter]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const notes = logs.filter(l => !l.is_todo);
  // 时间轴：按月份聚合有记录的日期（只显示有记录的月份）
  useEffect(() => {
    if (!logs.length) { setTimelineMonths([]); return; }
    const byMonth: Record<string, { label: string; count: number }> = {};
    logs.forEach(l => {
      const d = (l.log_date || '').slice(0, 7); // YYYY-MM
      if (!d) return;
      if (!byMonth[d]) {
        byMonth[d] = { label: d, count: 0 };
      }
      byMonth[d].count++;
    });
    // 时间轴从左到右递增：最早的月份在左，最近的月份在右（YYYY-MM 字符串排序即时间顺序）
    const months = Object.keys(byMonth).sort().map(k => ({
      key: k, label: k, count: byMonth[k].count,
      start: `${k}-01`,
      end: `${k}-${new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0).getDate()}`,
    }));
    setTimelineMonths(months);
  }, [logs]);
  const todos = logs.filter(l => l.is_todo);
  const openTodos = todos.filter(t => !t.done);
  const doneTodos = todos.filter(t => t.done);

  const startCompose = () => {
    setEditingId(null); setNoteDate(dayjs()); setNoteCategory('');
    setNoteTitle(''); setNoteContent(''); setNoteProject(''); setComposing(true);
  };
  const startEdit = (log: any) => {
    setEditingId(log.id); setNoteDate(dayjs(log.log_date));
    setNoteCategory(log.category || ''); setNoteTitle(log.title || '');
    setNoteContent(log.content); setNoteProject(log.work_project || ''); setComposing(true);
  };
  const cancelCompose = () => { setComposing(false); setEditingId(null); };

  // 加载项目库名称作为项目标签选项（含历史便签用过的项目名）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ getProjects }, { getWorkLogs }] = await Promise.all([
          import('../db'), import('../db'),
        ]);
        const projs = await getProjects();
        const used = await getWorkLogs('', '', '', '');
        const names = new Set<string>();
        projs.forEach((p: any) => { if (p.name) names.add(p.name); });
        used.forEach((l: any) => { if (l.work_project) names.add(l.work_project); });
        if (!cancelled) setProjectOptions(Array.from(names).sort((a, b) => a.localeCompare(b, 'zh')));
      } catch { /* 加载失败不阻塞 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // 保存时把项目名记入选项（输入过程不记忆，避免"鼠/鼠标/鼠标项"都被存进去）
  const rememberProject = (name: string) => {
    const n = (name || '').trim();
    if (n && !projectOptions.includes(n)) {
      setProjectOptions(prev => [...prev, n].sort((a, b) => a.localeCompare(b, 'zh')));
    }
  };

  const saveNote = async () => {
    if (!noteContent.trim()) { message.warning('写点内容吧'); return; }
    try {
      await saveWorkLog({
        id: editingId ?? undefined,
        log_date: noteDate.format('YYYY-MM-DD HH:mm'),
        title: noteTitle.trim(), content: noteContent.trim(),
        category: noteCategory || '其他', tags: '', work_project: noteProject.trim(), is_todo: false, done: false,
      });
      message.success(editingId ? '已更新' : '已记录');
      rememberProject(noteProject);
      setComposing(false); setEditingId(null); loadLogs();
    } catch (e: any) { message.error(`保存失败：${e?.message || e}`); }
  };

  const addTodo = async () => {
    if (!todoInput.trim()) return;
    try {
      await saveWorkLog({
        log_date: dayjs().format('YYYY-MM-DD HH:mm'),
        title: '', content: todoInput.trim(),
        category: '项目推进', tags: '', work_project: todoProject.trim(), is_todo: true, done: false,
      });
      setTodoInput(''); rememberProject(todoProject); setTodoProject(''); loadLogs();
    } catch (e: any) { message.error(`添加失败：${e?.message || e}`); }
  };

  const toggleTodo = async (id: number, done: boolean) => {
    await toggleWorkLogDone(id, done);
    loadLogs();
  };

  // ===== AI 总结（流式输出 + 过程呈现） =====
  const handleSummarize = async () => {
    if (!summaryRange || !summaryRange[0] || !summaryRange[1]) {
      message.warning('请选择总结的时间范围'); return;
    }
    setSummarizing(true); setSummaryResult(''); setSummaryElapsed(0); setSummaryChars(0); setCondenseChars(0); setCondensedText(''); setSummaryPhase('preparing');
    try {
      const start = summaryRange[0].format('YYYY-MM-DD');
      const end = summaryRange[1].format('YYYY-MM-DD');
      setSummaryPhase('reading');
      const rows = await getWorkLogs('', '', start, end);
      if (!rows.length) { message.warning('该时间段没有记录'); setSummarizing(false); return; }

      const db = await import('../db').then(m => m.getDb());
      const cfg = await db.select<any[]>('SELECT key, value FROM settings WHERE key IN (?,?,?)', ['local_ai_base_url', 'local_ai_model', 'local_ai_summary_model']);
      const baseUrl = cfg.find(c => c.key === 'local_ai_base_url')?.value || 'http://localhost:11434';
      // 总结模型：优先用独立设置，未设置则用对话模型
      const model = cfg.find(c => c.key === 'local_ai_summary_model')?.value
        || cfg.find(c => c.key === 'local_ai_model')?.value || '';
      if (!model) {
        message.warning('未配置 AI 模型，请先在设置中配置本地模型');
        setSummarizing(false); setSummaryPhase('idle'); return;
      }
      // 打开总结弹窗（压缩阶段即可看到实时反馈）
      setSummaryOpen(true);

      // 分组：按项目标签分组（无标签归入"公共/其他"），待办分已完成/未完成
      const noteRows = rows.filter(r => !r.is_todo);
      const todoRows = rows.filter(r => r.is_todo);
      const grouped: Record<string, string[]> = {};
      noteRows.forEach(r => {
        const p = (r.work_project || '').trim() || '公共/其他';
        if (!grouped[p]) grouped[p] = [];
        grouped[p].push(`${(r.log_date || '').slice(0, 10)} ${r.title ? '[' + r.title + '] ' : ''}${r.content}`);
      });
      let logText = '';
      Object.entries(grouped).forEach(([proj, items]) => {
        logText += `\n【${proj}】\n` + items.map(i => `- ${i}`).join('\n');
      });
      const doneList = todoRows.filter(t => t.done).map(t => `${(t.log_date || '').slice(0, 10)} ${(t.work_project || '').trim() ? '[' + t.work_project.trim() + '] ' : ''}${t.content}`);
      const openList = todoRows.filter(t => !t.done).map(t => `${(t.log_date || '').slice(0, 10)} ${(t.work_project || '').trim() ? '[' + t.work_project.trim() + '] ' : ''}${t.content}`);
      if (doneList.length) logText += `\n【已完成的待办事项】\n` + doneList.map(i => `- ${i}`).join('\n');
      if (openList.length) logText += `\n【未完成的待办事项】\n` + openList.map(i => `- ${i}`).join('\n');

      // ===== 第一步：压缩提炼（控制 token 占用，日志再多也不爆） =====
      setSummaryPhase('reading');
      let condensedAcc = '';
      const condensePrompt = `你是工作日志提炼助手。把下面的工作记录压缩成结构化的素材，供后续撰写总结使用。

要求：
1. 保持【项目名】分组不变（无项目名的归在"公共/其他"），每组内条目**按时间先后排序**
2. 每条提炼成一句话要点（20-40字），格式："X月X日 做了什么 → 结果"，保留关键数据（金额、百分比、结论）
3. **同一项目的多条记录要能串成时间线**：同一项目在不同日期的记录，按时间顺序排列，为后续串联成文做准备
4. 对"公共/其他"分组：每条要点末尾用【】标注性质——推动协调类标【公共事务】，建模型/建工具/方法论标【能力建设】，支援/带教/借助资源标【协作互助】
5. 待办事项只保留【已完成】和【未完成】两个标题下的条目
6. 只输出压缩后的要点，不要解释、不要评价`;
      const condenseUser = `请压缩这些工作记录：\n${logText}`;
      await new Promise<void>((resolve) => {
        startSummaryStream(baseUrl, model, condensePrompt, condenseUser,
          (t) => { condensedAcc += t; setCondenseChars(condensedAcc.length); setCondensedText(condensedAcc); },
          () => { /* 压缩阶段不显示思考 */ },
          () => { resolve(); },
          () => { resolve(); },
          () => { resolve(); });
      });
      // 如果压缩失败或为空，退回原始文本
      let condensedText = condensedAcc;
      if (condensedText.trim().length < 20) { condensedText = logText; }

      // ===== 第二步：正式总结（流式，实时反馈） =====
      const systemPrompt = `你是员工的绩效总结助手。把下面的工作要点写成一份有层次、有逻辑、能体现真实贡献的年中/年终总结。

## 输出结构（必须遵守）
按四个维度组织正文，每个维度一个小节：
一、项目维度（重点，篇幅最大）：按项目成段，每个项目是一段连贯的叙述，不是列表
二、公共事务：推动XX事项、牵头XX工作等，写清推动了什么、结果如何
三、能力建设：模型/工具/方法论建设，写清建了什么、用在哪儿、带来什么价值
四、协作互助：借助别人的帮助 + 帮助别人做得更好，两头各写清楚

## 每个项目/事项的写法（必须遵守）
- 一段话串起：**起因/背景 → 关键动作（按时间先后，用"随后""接着""在此基础上"衔接）→ 结果/贡献**
- 同一项目的记录必须合并成一条故事线，例如：
  ✅ 正确示范："手写笔项目从选件需求梳理起步，先后完成笔尖双供应商比价、传感器模组国产化替代（单支降本2.4元）、主控芯片替代验证，最终BOM定稿¥34.6、较目标低0.4元，首批5000支顺利量产。"
  ❌ 错误示范（禁止）："手写笔选件需求梳理（6月5日）；笔尖供应商比价（6月12日）；传感器选型（6月19日）..."
- **禁止**：编号列表、逐条罗列、每条带日期、每条都写"贡献：..."的模板句式
- 时间跨度长的项目体现阶段推进（初期…随后…最终…）

## 语言风格（必须遵守，书面正式）
- 使用**正式书面语**，语气严谨、客观，适合绩效考评材料；**禁止口语化表达**
- ❌ 禁止的口语化表达："搞""弄""整""挺""特别""咱们""一下""这块""那边""差不多""反正""搞定""带了一下""帮忙弄了"等
- ✅ 正式替代："推进""完成""主导""落实""优化""组织""协调""达成"等书面动词
- 用词规范：不说"很多"说"显著提升"；不说"花了不少时间"说"投入大量精力"；不说"省了钱"说"实现成本节约"
- 句式完整、主谓宾齐全，避免碎片化短句；数字和单位规范表述（如"降本2.4元/支""效率提升40%"）

## 硬性禁止
1. 禁止输出任何编号列表（1. 2. 3.）或项目符号列表
2. 禁止每条记录单独成行、每条都附日期
3. 禁止"贡献：xxx"这种机械模板句式——把贡献融进叙述里
4. 禁止把每条便签翻译一遍；多条记录必须融合成段落

要求：
1. 保留具体数据，不要虚构
2. 未完成的事项简要带过或注明进展
3. 项目归属以【】分组标题为准；【公共/其他】分组内标注了【公共事务】【能力建设】【协作互助】的要点，归入对应维度
4. 语言专业、简洁、连贯，适合写进绩效考评材料
5. 直接输出总结正文，不要任何思考过程、不要解释、不要前缀`;
      const userPrompt = `这是我在 ${start} 到 ${end} 的工作要点：\n${condensedText}\n\n请按四个维度写总结。每个项目写成连贯的一段话（起因→动作→结果），禁止编号列表、禁止逐条罗列、禁止"贡献："模板句式。语言务必正式书面，禁止口语化表达。`;

      // 流式调用（复用 BOM 分类验证可靠的 startOllamaStream，实时反馈）
      setSummaryPhase('generating');
      let fullText = '';
      let step2Error = '';
      let summaryReasoning = '';
      await new Promise<void>((resolve) => {
        startOllamaStream(
          baseUrl, model,
          [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          (t) => { fullText += t; setSummaryChars(fullText.length); setSummaryResult(fullText); },
          (t) => { summaryReasoning += t; }, // 思考单独收集，不混入正文
          () => { resolve(); },
          (e) => { step2Error = e; resolve(); },
          { num_predict: 16384, temperature: 0.3, think: false, endpoint: 'native', json: false },
        );
      });
      setSummarizing(false);
      setSummaryPhase(step2Error ? 'error' : fullText ? 'done' : 'error');
      if (step2Error) {
        setSummaryResult(`[总结失败] ${step2Error}\n\n请检查：1) Ollama 是否运行 2) 模型是否可用 3) 可重试`);
        message.error(`总结失败：${step2Error}`);
      } else if (!fullText) {
        setSummaryResult('[总结失败] 模型未返回内容（空响应）\n\n可尝试重新生成');
        setSummaryPhase('error');
        message.error('总结失败：模型未返回内容');
      }
    } catch (e: any) {
      message.error(`总结失败：${e?.message || e}`);
      setSummarizing(false); setSummaryPhase('error');
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* 标题 */}
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <BookOutlined style={{ color: 'var(--color-primary)' }} /> 工作手账
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          记工作、列待办、打勾完成，年底 AI 帮你串成总结
        </div>
      </div>

      {/* 视图切换 + 工具栏 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', background: 'var(--color-surface)', borderRadius: 8, padding: 3, border: '1px solid var(--color-border)' }}>
          <Button size="small" type={view === 'notes' ? 'primary' : 'text'} onClick={() => setView('notes')}>手账</Button>
          <Button size="small" type={view === 'todos' ? 'primary' : 'text'} onClick={() => setView('todos')}>
            待办 {openTodos.length > 0 && <span style={{ marginLeft: 2 }}>({openTodos.length})</span>}
          </Button>
        </div>
        <Input placeholder="搜索…" prefix={<SearchOutlined />} style={{ width: 160 }} value={keyword} onChange={e => setKeyword(e.target.value)} allowClear />
        <Select placeholder="分类" allowClear style={{ width: 110 }} value={categoryFilter || undefined} onChange={v => setCategoryFilter(v || '')} options={LOG_CATEGORIES.map(c => ({ value: c, label: c }))} />
        <Select
          placeholder="项目" allowClear showSearch style={{ width: 150 }}
          value={projectFilter || undefined} onChange={v => setProjectFilter(v || '')}
          options={projectOptions.map(p => ({ value: p, label: p }))}
        />
        {view === 'notes' && <Button type="primary" icon={<PlusOutlined />} onClick={startCompose}>写一张便签</Button>}
        <Tooltip title="选时间范围生成工作总结">
          <Button icon={<RobotOutlined />} onClick={async () => {
            // 打开总结弹窗时加载模型列表 + 已保存的总结模型设置
            setSummaryOpen(true);
            try {
              const db = await (await import('../db')).getDb();
              const cfg = await db.select<any[]>('SELECT key, value FROM settings WHERE key IN (?,?)', ['local_ai_base_url', 'local_ai_summary_model']);
              const baseUrl = cfg.find(c => c.key === 'local_ai_base_url')?.value || 'http://localhost:11434';
              setSummaryModel(cfg.find(c => c.key === 'local_ai_summary_model')?.value || '');
              // 拉取模型列表
              const { invoke } = await import('@tauri-apps/api/core');
              const result = await invoke<{ success: boolean; body: string }>('http_get', {
                request: { url: `${baseUrl.replace(/\/$/, '')}/api/tags`, headers: {}, body: null }
              });
              if (result.success) {
                const data = JSON.parse(result.body);
                setSummaryModels((data.models || []).map((m: any) => m.name));
              }
            } catch { /* 拉取失败不影响打开 */ }
          }} disabled={!logs.length}>AI 总结</Button>
          <Button icon={<BookOutlined />} onClick={async () => {
            setSavedSummaries(await (await import('../db')).getWorkSummaries());
            setShowSaved(true);
          }}>已保存总结</Button>
        </Tooltip>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}

      {/* ===== 待办视图 ===== */}
      {!loading && view === 'todos' && (
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          {/* 快速添加待办 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              placeholder="添加待办事项，回车确认…" value={todoInput}
              onChange={e => setTodoInput(e.target.value)}
              onPressEnter={addTodo}
              prefix={<FlagOutlined style={{ color: '#F4511E' }} />}
              style={{ flex: 1, minWidth: 200 }}
            />
            <AutoComplete
              size="middle" allowClear placeholder="项目：选择或输入（空=公共）" style={{ width: 180 }}
              value={todoProject}
              onChange={(v: string) => setTodoProject(v)}
              options={projectOptions.map(p => ({ value: p }))}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={addTodo}>添加</Button>
          </div>

          {/* 未完成 */}
          {openTodos.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>进行中（{openTodos.length}）</div>
              {openTodos.map(t => (
                <div key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                  background: '#FFF8F0', borderRadius: 8, marginBottom: 8,
                  border: '1px solid #FFE0B2',
                }}>
                  <Checkbox checked={false} onChange={() => toggleTodo(t.id, true)} />
                  <span style={{ flex: 1, fontSize: 13.5, color: 'rgba(0,0,0,0.85)' }}>{t.content}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{(t.log_date || '').slice(5, 16)}</span>
                  {t.work_project && (
                    <span style={{ fontSize: 10.5, padding: '1px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.06)', color: 'rgba(0,0,0,0.6)' }}><EmojiIcon e="📌" /> {t.work_project}</span>
                  )}
                  <Popconfirm title="删除？" onConfirm={async () => { await deleteWorkLog(t.id); loadLogs(); }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}

          {/* 已完成 */}
          {doneTodos.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                已完成（{doneTodos.length}）<span style={{ fontWeight: 400, fontSize: 11 }}>—— 完成的事项会进入年终总结</span>
              </div>
              {doneTodos.map(t => (
                <div key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                  background: '#F0F9F0', borderRadius: 8, marginBottom: 8, border: '1px solid #C8E6C9',
                }}>
                  <Checkbox checked onChange={() => toggleTodo(t.id, false)} />
                  <span style={{ flex: 1, fontSize: 13.5, color: 'rgba(0,0,0,0.45)', textDecoration: 'line-through' }}>{t.content}</span>
                  <CheckCircleFilled style={{ color: '#43A047' }} />
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{(t.log_date || '').slice(5, 16)}</span>
                  {t.work_project && (
                    <span style={{ fontSize: 10.5, padding: '1px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.06)', color: 'rgba(0,0,0,0.6)' }}><EmojiIcon e="📌" /> {t.work_project}</span>
                  )}
                  <Popconfirm title="删除？" onConfirm={async () => { await deleteWorkLog(t.id); loadLogs(); }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}

          {!openTodos.length && !doneTodos.length && (
            <Empty description="还没有待办，在上方添加吧" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 40 }} />
          )}
        </div>
      )}

      {/* ===== 手账视图（便签墙） ===== */}
      {!loading && view === 'notes' && (
        <div>
          {/* 写便签编辑卡（置顶显示） */}
          {composing && (
            <div style={{ maxWidth: 420, margin: '0 auto 24px', background: NOTE_COLORS[noteCategory] || '#FFF8E1', borderRadius: 10,
              padding: '22px 18px 16px', position: 'relative',
              boxShadow: '0 6px 20px rgba(0,0,0,0.10)', transform: 'rotate(-0.5deg)' }}>
              <div style={{
                position: 'absolute', top: -8, left: '50%', transform: 'translateX(-50%)',
                width: 22, height: 22, borderRadius: '50%',
                background: `radial-gradient(circle at 35% 35%, ${NOTE_PIN[noteCategory] || '#F9A825'}, ${NOTE_PIN[noteCategory] || '#F9A825'}99)`,
                boxShadow: '0 2px 6px rgba(0,0,0,0.3)', zIndex: 2,
              }} />
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Select size="small" allowClear placeholder="分类（可选）" value={noteCategory || undefined} onChange={v => setNoteCategory(v || '')} style={{ width: 110 }} options={LOG_CATEGORIES.map(c => ({ value: c, label: c }))} />
                <AutoComplete
                  size="small" allowClear placeholder="项目：选择或输入（空=公共）" style={{ width: 180 }}
                  value={noteProject}
                  onChange={(v: string) => setNoteProject(v)}
                  options={projectOptions.map(p => ({ value: p }))}
                />
                <DatePicker size="small" value={noteDate} onChange={v => v && setNoteDate(v)} format="MM-DD" style={{ width: 90 }} />
              </div>
              <Input placeholder="标题（可选）" value={noteTitle} onChange={e => setNoteTitle(e.target.value)} bordered={false}
                style={{ background: 'transparent', fontSize: 15, fontWeight: 600, padding: '0 0 4px', marginBottom: 4 }} />
              <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} value={noteContent} onChange={e => setNoteContent(e.target.value)}
                placeholder="今天做了什么？结果如何？像写日记一样随手记…" bordered={false}
                style={{ background: 'transparent', fontSize: 14, lineHeight: 1.8, padding: 0 }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={cancelCompose}>取消</Button>
                <Button size="small" type="primary" icon={<CheckOutlined />} onClick={saveNote}>保存</Button>
              </div>
            </div>
          )}

          {/* 分类章节：按分类分组，像笔记本的章节 */}
          {LOG_CATEGORIES.filter(cat => notes.some(n => (n.category || '其他') === cat)).map(cat => {
            const catNotes = notes.filter(n => (n.category || '其他') === cat);
            const collapsed = collapsedCats[cat];
            return (
              <div key={cat} style={{ marginBottom: 24 }}>
                {/* 章节头 */}
                <div
                  onClick={() => setCollapsedCats(prev => ({ ...prev, [cat]: !prev[cat] }))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                    padding: '10px 16px', marginBottom: 14,
                    background: `linear-gradient(135deg, ${NOTE_COLORS[cat] || '#FFF8E1'}, ${(NOTE_COLORS[cat] || '#FFF8E1')}88)`,
                    borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
                  }}
                >
                  <PushpinOutlined style={{ fontSize: 14, color: NOTE_PIN[cat] || '#F9A825' }} />
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{cat}</span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{catNotes.length} 张便签</span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', transition: 'transform 0.2s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                </div>
                {/* 章节内容：便签网格 */}
                {!collapsed && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
                    {catNotes.map(log => (
                      <div key={log.id} style={{
                        background: NOTE_COLORS[log.category] || '#FFF8E1', borderRadius: 10,
                        padding: '20px 18px 14px', position: 'relative',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.08)', transform: 'rotate(-0.4deg)',
                        transition: 'all 0.25s', cursor: 'pointer',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'rotate(0deg) scale(1.02)'; e.currentTarget.style.boxShadow = '0 8px 28px rgba(0,0,0,0.14)'; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'rotate(-0.4deg)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'; }}
                        onClick={() => startEdit(log)}
                      >
                        <div style={{
                          position: 'absolute', top: -8, left: '50%', transform: 'translateX(-50%)',
                          width: 20, height: 20, borderRadius: '50%',
                          background: `radial-gradient(circle at 35% 35%, ${NOTE_PIN[log.category] || '#F9A825'}, ${NOTE_PIN[log.category] || '#F9A825'}99)`,
                          boxShadow: '0 2px 6px rgba(0,0,0,0.3)', zIndex: 2,
                        }} />
                        <div style={{ position: 'absolute', top: 8, right: 8, opacity: 0, transition: 'opacity 0.2s' }} onClick={e => e.stopPropagation()}>
                          <Popconfirm title="删除这张便签？" onConfirm={async () => { await deleteWorkLog(log.id); message.success('已删除'); loadLogs(); }}>
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </div>
                        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{(log.log_date || '').slice(5, 16)}</span>
                          {log.work_project && (
                            <span style={{
                              fontSize: 10.5, padding: '1px 8px', borderRadius: 999,
                              background: 'rgba(0,0,0,0.06)', color: 'rgba(0,0,0,0.6)',
                              border: '1px solid rgba(0,0,0,0.08)',
                            }}><EmojiIcon e="📌" /> {log.work_project}</span>
                          )}
                        </div>
                        {log.title && <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, color: 'rgba(0,0,0,0.88)' }}>{log.title}</div>}
                        <div style={{
                          fontSize: 13, lineHeight: 1.8, color: 'rgba(0,0,0,0.75)',
                          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          maxHeight: 160, overflow: 'hidden',
                          display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical',
                        }}>{log.content}</div>
                        <div style={{ fontSize: 10, color: 'rgba(0,0,0,0.35)', textAlign: 'right', marginTop: 8 }}>点击编辑</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {!notes.length && !composing && (
            <Empty description={<span>还没有便签，点「写一张便签」开始记录吧</span>} style={{ padding: 60 }} />
          )}
        </div>
      )}

      {!loading && view === 'notes' && !notes.length && !composing && (
        <Empty description={<span>还没有便签，点「写一张便签」开始记录吧</span>} style={{ padding: 60 }} />
      )}

      {/* 总结 Modal（用 antd Modal，portal 挂 body，不受 zoom 缩放影响遮罩覆盖） */}
      <Modal
        title={<span style={{ fontWeight: 700, fontSize: 16 }}><RobotOutlined style={{ marginRight: 6 }} />AI 工作总结</span>}
        open={summaryOpen}
        onCancel={() => setSummaryOpen(false)}
        footer={null}
        width={720}
        destroyOnClose
      >
        {/* 时间轴：横向月份轴，可多选 */}
        {timelineMonths.length > 0 && (
          <div style={{ marginBottom: 16, padding: '14px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span><EmojiIcon e="📅" /> 时间轴选择</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>点选月份（可多选），范围自动覆盖所选首尾月</span>
              <Button
                size="small" type="text" style={{ marginLeft: 'auto', fontSize: 11 }}
                onClick={() => { setSelectedMonths([]); setSummaryRange(null); }}
              >清除</Button>
            </div>
            <div style={{ position: 'relative', padding: '8px 0 4px' }}>
              {/* 横轴 */}
              <div style={{ position: 'absolute', top: 22, left: 8, right: 8, height: 2, background: 'var(--color-border)' }} />
              {/* 选中的范围高亮带 */}
              {selectedMonths.length >= 2 && (() => {
                const idxs = selectedMonths.map(k => timelineMonths.findIndex(m => m.key === k)).filter(i => i >= 0).sort((a, b) => a - b);
                if (!idxs.length) return null;
                const left = idxs[0] / Math.max(timelineMonths.length - 1, 1) * 100;
                const right = (1 - idxs[idxs.length - 1] / Math.max(timelineMonths.length - 1, 1)) * 100;
                return <div style={{ position: 'absolute', top: 18, left: `${left}%`, right: `${right}%`, height: 10, background: 'rgba(10,132,255,0.15)', borderRadius: 5, transition: 'all 0.2s' }} />;
              })()}
              {/* 月份节点 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', position: 'relative' }}>
                {timelineMonths.map(m => {
                  const sel = selectedMonths.includes(m.key);
                  return (
                    <div key={m.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer', zIndex: 1 }}
                      onClick={() => {
                        const next = sel ? selectedMonths.filter(k => k !== m.key) : [...selectedMonths, m.key];
                        setSelectedMonths(next);
                        if (next.length) {
                          const first = timelineMonths.filter(x => next.includes(x.key)).sort((a, b) => a.key.localeCompare(b.key))[0];
                          const last = timelineMonths.filter(x => next.includes(x.key)).sort((a, b) => b.key.localeCompare(a.key))[0];
                          setSummaryRange([dayjs(first.start), dayjs(last.end)]);
                        } else {
                          setSummaryRange(null);
                        }
                      }}
                    >
                      {/* 节点圆 */}
                      <div style={{
                        width: 14, height: 14, borderRadius: '50%', transition: 'all 0.2s',
                        background: sel ? 'var(--color-primary)' : '#fff',
                        border: `2px solid ${sel ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        boxShadow: sel ? '0 0 0 4px rgba(10,132,255,0.15)' : 'none',
                        transform: sel ? 'scale(1.2)' : 'scale(1)',
                      }} />
                      {/* 月份标签：YYYY-MM 取月份数字（如 "2026-07" → 7月） */}
                      <div style={{ fontSize: 10.5, fontWeight: sel ? 700 : 500, color: sel ? 'var(--color-primary)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                        {String(Number(m.label.slice(5, 7)))}月
                      </div>
                      {/* 记录数 */}
                      <div style={{ fontSize: 9.5, color: sel ? 'var(--color-primary)' : 'var(--color-text-tertiary)', opacity: 0.7 }}>
                        {m.count}条
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* 当前范围显示 */}
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
              {selectedMonths.length ? (
                <>已选 {selectedMonths.length} 个月：{selectedMonths.slice().sort()[0]} ~ {selectedMonths.slice().sort()[selectedMonths.length - 1]}（{summaryRange?.[0]?.format('YYYY-MM-DD')} ~ {summaryRange?.[1]?.format('YYYY-MM-DD')}）</>
              ) : (
                <>尚未选择，点选月份设定范围</>
              )}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
          <DatePicker.RangePicker value={summaryRange as any} onChange={(v) => setSummaryRange(v as any)} placeholder={['开始日期', '结束日期']} />
          <Select
            size="middle" style={{ width: 180 }} allowClear placeholder="总结模型（默认同对话）"
            value={summaryModel || undefined}
            onChange={async (v) => {
              setSummaryModel(v || '');
              const db = await (await import('../db')).getDb();
              await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', ['local_ai_summary_model', v || '']);
              message.success(v ? `总结模型已设为 ${v}` : '总结模型已恢复为对话模型');
            }}
            options={summaryModels.map(m => ({ label: m, value: m }))}
          />
          <Button type="primary" icon={<RobotOutlined />} loading={summarizing} onClick={handleSummarize}>生成总结</Button>
          {summarizing && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Spin size="small" />
              {summaryPhase === 'preparing' || summaryPhase === 'reading' ? `正在读取工作记录… ${summaryElapsed}s`
                : summaryPhase === 'generating' ? `正在生成总结… ${summaryElapsed}s${summaryChars > 0 ? ` · 已收到 ${summaryChars} 字符` : ''}`
                : '处理中…'}
            </span>
          )}
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {summaryResult ? (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 2, color: '#333' }}>
              {summaryResult}
              {summarizing && <span style={{ opacity: 0.5 }}>▍</span>}
            </div>
          ) : (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '30px 0', textAlign: 'center' }}>
              {summarizing ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Spin size="small" /> {summaryPhase === 'reading' ? '正在读取并压缩工作记录…' : `正在生成总结…`} <b>{summaryElapsed}s</b>
                  {(summaryPhase === 'reading' ? condenseChars : summaryChars) > 0 && (
                    <span style={{ color: 'var(--color-text-tertiary)' }}>· 已收到 {summaryPhase === 'reading' ? condenseChars : summaryChars} 字符</span>
                  )}
                </span>
              ) : (
                <>
                  选择时间范围后点击「生成总结」<br />
                  <span style={{ fontSize: 12 }}>便签按分类组织，已完成待办单独成节，逐字实时呈现</span>
                </>
              )}
              {summarizing && summaryPhase === 'reading' && condensedText && (
                <div style={{ textAlign: 'left', marginTop: 16, fontSize: 12, lineHeight: 1.9, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {condensedText}
                </div>
              )}
            </div>
          )}
        </div>
        {summaryResult && (
          <div style={{ textAlign: 'right', marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button icon={<SaveOutlined />} onClick={async () => {
              const start = summaryRange?.[0]?.format('YYYY-MM-DD') || '';
              const end = summaryRange?.[1]?.format('YYYY-MM-DD') || '';
              await (await import('../db')).saveWorkSummary({
                title: `${start} ~ ${end} 工作总结`, content: summaryResult, start_date: start, end_date: end,
              });
              message.success('总结已保存，可在「已保存总结」中查看');
            }}>保存总结</Button>
            <Button onClick={() => navigator.clipboard?.writeText(summaryResult).then(() => message.success('已复制'))}>复制总结</Button>
          </div>
        )}
      </Modal>

      {/* 已保存总结查看 */}
      <Modal
        title={<span><BookOutlined style={{ marginRight: 6 }} />已保存的总结</span>}
        open={showSaved}
        onCancel={() => setShowSaved(false)}
        footer={null}
        width={720}
      >
        {savedSummaries.length === 0 && (
          <Empty description="还没有保存的总结。生成总结后点「保存总结」即可存到这里" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 30 }} />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {savedSummaries.map(s => (
            <div key={s.id} style={{ padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{s.title}</span>
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{s.created_at}</span>
                <Button size="small" type="text" icon={<CheckOutlined />} onClick={() => navigator.clipboard?.writeText(s.content).then(() => message.success('已复制'))} />
                <Popconfirm title="删除这份总结？" onConfirm={async () => {
                  await (await import('../db')).deleteWorkSummary(s.id);
                  setSavedSummaries(await (await import('../db')).getWorkSummaries());
                  message.success('已删除');
                }}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'rgba(0,0,0,0.75)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'hidden' }}>
                {s.content.slice(0, 180)}{s.content.length > 180 ? '…' : ''}
              </div>
              <div style={{ textAlign: 'right', marginTop: 4 }}>
                <Button size="small" type="link" onClick={() => setViewingSummary(s)}>查看全文</Button>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* 已保存总结全文查看 */}
      <Modal
        title={<span><BookOutlined style={{ marginRight: 6 }} />总结全文</span>}
        open={!!viewingSummary}
        onCancel={() => setViewingSummary(null)}
        footer={null}
        width={760}
      >
        {viewingSummary && (
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{viewingSummary.title}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>{viewingSummary.created_at}</div>
            <div style={{
              fontSize: 13, lineHeight: 2, color: 'rgba(0,0,0,0.85)', whiteSpace: 'pre-wrap',
              maxHeight: '60vh', overflowY: 'auto', background: 'var(--color-surface)',
              border: '1px solid var(--color-border)', borderRadius: 10, padding: '14px 18px',
            }}>
              {viewingSummary.content}
            </div>
            <div style={{ textAlign: 'right', marginTop: 10 }}>
              <Button icon={<CheckOutlined />} onClick={() => navigator.clipboard?.writeText(viewingSummary.content).then(() => message.success('已复制'))}>复制全文</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
