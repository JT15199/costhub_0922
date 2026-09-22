import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Button, DatePicker, Empty, Form, Input, InputNumber, Modal, Select, Spin, Tag, message } from 'antd';
import { BookOutlined, DeleteOutlined, EditOutlined, LinkOutlined, RobotOutlined, SaveOutlined, SearchOutlined } from '@ant-design/icons';
import JournalShelf, { bookAppearance, JournalTurningPage, journalMotionEnabled } from '../components/JournalShelf';
import dayjs, { type Dayjs } from 'dayjs';
import { buildSummaryPrompts, deleteWorkLog, deleteWorkSummary, getProjectBOMs, getProjects, getSetting, getWorkLogs, getWorkSummaries, saveProductionCostSaving, saveWorkLog, saveWorkSummary, setSetting, toggleWorkLogDone, type WorkLogRecord, WORK_LOG_TYPES } from '../db';
import { isSqliteLockedError } from '../db/core';
import { startOllamaStream } from '../ollama';

type EditorValue = Partial<WorkLogRecord> & { evidence_json?: string };

const TYPE_LABEL: Record<string, string> = { work_progress: '工作进展', decision: '决策记录', risk: '问题风险', reflection: '心得思考', outcome: '成果痕迹', follow_up: '待跟进', cost_progress: '关键成本进展' };
const SUMMARY_LABEL: Record<string, string> = { week: '周报', month: '月报', project_review: '项目复盘', performance: '绩效总结', growth: '成长复盘' };
const PROJECT_STAGES = ['Charter', 'CDCP', 'PDCP', 'ADCP', '量产后降本'];
const newJournalEntry = (project_id = 0, work_project = ''): EditorValue => ({ log_date: dayjs().format('YYYY-MM-DD HH:mm'), record_type: 'work_progress', stage: 'Charter', content: '', title: '', project_id, work_project, impact: '', next_action: '', importance: 'normal', due_at: '' });
const dateRange = (kind: string): [Dayjs, Dayjs] => kind === 'month' ? [dayjs().startOf('month'), dayjs()] : [dayjs().subtract(6, 'day'), dayjs()];

export default function WorkLog() {
  const [projectsReady, setProjectsReady] = useState(false);
  const [tab, setTab] = useState<'records' | 'project' | 'summary'>('records');
  const [logs, setLogs] = useState<WorkLogRecord[]>([]); const [projects, setProjects] = useState<any[]>([]); const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState(''); const [projectFilter, setProjectFilter] = useState<number | ''>(''); const [typeFilter, setTypeFilter] = useState('');
  const [editing, setEditing] = useState<EditorValue | null>(null); const [selectedProject, setSelectedProject] = useState<number | ''>('');
  const [summaries, setSummaries] = useState<any[]>([]); const [viewingSummary, setViewingSummary] = useState<any>(null); const [sourceRows, setSourceRows] = useState<WorkLogRecord[]>([]);
  const [summaryType, setSummaryType] = useState('week'); const [summaryRange, setSummaryRange] = useState<[Dayjs, Dayjs]>(dateRange('week')); const [summaryProject, setSummaryProject] = useState<number | ''>(''); const [summaryModel, setSummaryModel] = useState('');
  const [summaryText, setSummaryText] = useState(''); const [summaryRows, setSummaryRows] = useState<WorkLogRecord[]>([]); const [summarizing, setSummarizing] = useState(false);

  const load = useCallback(async () => { setLoading(true); try { setLogs(await getWorkLogs()); setSummaries(await getWorkSummaries()); } catch (e: any) { message.error(`工作手账加载失败：${String(e?.message || e).slice(0, 100)}`); } finally { setLoading(false); } }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { Promise.all([getProjects('', '', ''), getSetting('local_ai_summary_model', '')]).then(([ps, m]) => { setProjects(Array.isArray(ps) ? ps : []); setSummaryModel(m); setSelectedProject(p => p || (ps[0]?.id || '')); setProjectsReady(true); }).catch(() => { }); }, []);
  const visibleLogs = useMemo(() => logs.filter(l => (!typeFilter || l.record_type === typeFilter) && (!projectFilter || l.project_id === projectFilter) && (!keyword.trim() || [l.title, l.content, l.tags, l.work_project].join(' ').toLowerCase().includes(keyword.trim().toLowerCase()))), [logs, typeFilter, projectFilter, keyword]);
  const followUps = useMemo(() => logs.filter(l => (l.record_type === 'follow_up' || l.is_todo) && !l.done), [logs]);
  const openEditor = (log?: WorkLogRecord) => setEditing(log ? { ...log, evidence_json: JSON.stringify(log.evidence || []) } : newJournalEntry());
  const save = async (value = editing): Promise<number | false> => {
    if (!value?.content?.trim()) { message.warning('请先填写工作记录'); return false; }
    try {
      const id = await saveWorkLog({ ...value, is_todo: value.record_type === 'follow_up' ? 1 : 0, done: value.done || 0, category: value.category || '其他', tags: value.tags || '', content: value.content.trim() } as any);
      if (!id) throw new Error('未写入记录，请确认数据库已解锁');
      setEditing(null); await load(); message.success(value.id ? '本条记录已修改' : '已新增一条记录，历史内容保留'); return id;
    } catch (e: any) { message.error(isSqliteLockedError(e) ? '数据库仍被占用，本条内容已保留，请稍后再保存。' : `保存失败：${e?.message || e}`); return false; }
  };
  const startSummary = (type = summaryType) => { const range = dateRange(type === 'month' ? 'month' : 'week'); setSummaryType(type); setSummaryRange(range); setTab('summary'); setSummaryText(''); };
  const generateSummary = async () => {
    const start = summaryRange[0]?.format('YYYY-MM-DD'), end = summaryRange[1]?.format('YYYY-MM-DD'); if (!start || !end) return;
    setSummarizing(true); setSummaryText('');
    try { const rows = await getWorkLogs('', '', start, end, summaryProject); if (!rows.length) { message.info('该范围内没有工作记录'); setSummarizing(false); return; } setSummaryRows(rows); const base = await getSetting('local_ai_base_url', 'http://localhost:11434'); const model = summaryModel || await getSetting('local_ai_model', ''); if (!model) throw new Error('未配置本地模型'); const prompt = buildSummaryPrompts(summaryType, start, end, rows); let text = ''; await new Promise<void>(resolve => { startOllamaStream(base, model, [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], t => { text += t; setSummaryText(text); }, () => { }, resolve, e => { text = `[生成失败] ${e}`; setSummaryText(text); resolve(); }, { num_predict: 12000, temperature: 0.25, think: false, endpoint: 'native', json: false }); }); if (text.startsWith('[生成失败]')) message.error(text); } catch (e: any) { message.error(`总结失败：${e?.message || e}`); } finally { setSummarizing(false); }
  };
  const saveSummary = async () => { if (!summaryText || !summaryRows.length) return; const start = summaryRange[0].format('YYYY-MM-DD'), end = summaryRange[1].format('YYYY-MM-DD'); await saveWorkSummary({ title: `${SUMMARY_LABEL[summaryType] || '工作总结'} · ${start} ~ ${end}`, content: summaryText, start_date: start, end_date: end, summary_type: summaryType, project_filter: summaryProject, source_log_ids: summaryRows.map(r => r.id) }); setSummaries(await getWorkSummaries()); message.success('总结已保存，并保留原始记录引用'); };
  const viewEvidence = async (summary: any) => { const ids = Array.isArray(summary.source_log_ids) ? summary.source_log_ids : []; const all = await getWorkLogs(); setSourceRows(all.filter(r => ids.includes(r.id))); setViewingSummary(summary); };

  return <div className="worklog-page"><header className="worklog-header"><div><span className="eyebrow">COSTHUB · WORK JOURNAL</span><h1><BookOutlined /> 工作手账</h1></div><div className="worklog-header-actions"><Button type="primary" onClick={() => openEditor()}>写一条手账</Button><Button type="primary" icon={<RobotOutlined />} onClick={() => startSummary('week')}>生成 AI 总结</Button></div></header><nav className="worklog-tabs" aria-label="工作手账栏目">{[['records', '工作记录'], ['project', '项目脉络'], ['summary', 'AI 总结']].map(([key, label]) => <button type="button" className={tab === key ? 'is-active' : ''} key={key} onClick={() => setTab(key as any)}>{label}</button>)}</nav>
    {tab === 'records' && <Records allLogs={logs} logs={visibleLogs} projects={projects} loading={loading || !projectsReady} keyword={keyword} setKeyword={setKeyword} projectFilter={projectFilter} setProjectFilter={setProjectFilter} typeFilter={typeFilter} setTypeFilter={setTypeFilter} followUps={followUps} onEdit={openEditor} onSave={save} onDelete={async (id: number) => { await deleteWorkLog(id); load(); }} onToggle={async (id: number, done: boolean) => { await toggleWorkLogDone(id, done); load(); }} onSummary={startSummary} onRefresh={load} />}
    {tab === 'project' && <ProjectTrail logs={logs} projects={projects} selected={selectedProject} setSelected={setSelectedProject} onSummary={() => { setSummaryProject(selectedProject); setSummaryType('project_review'); setSummaryRange([dayjs().subtract(90, 'day'), dayjs()]); setTab('summary'); }} />}
    {tab === 'summary' && <SummaryPanel summaries={summaries} summaryType={summaryType} setSummaryType={(v: string) => { setSummaryType(v); if (v === 'week' || v === 'month') setSummaryRange(dateRange(v)); }} summaryRange={summaryRange} setSummaryRange={(v: [Dayjs, Dayjs] | null) => v && setSummaryRange(v)} summaryProject={summaryProject} setSummaryProject={(v: number | '') => setSummaryProject(v)} projects={projects} summaryModel={summaryModel} setSummaryModel={async (v: string) => { setSummaryModel(v); await setSetting('local_ai_summary_model', v); }} summaryText={summaryText} summarizing={summarizing} onGenerate={generateSummary} onSave={saveSummary} onView={viewEvidence} onDelete={async (id: number) => { await deleteWorkSummary(id); setSummaries(await getWorkSummaries()); }} />}
    <Modal open={!!editing} title={editing?.id ? '编辑工作记录' : '写一条手账'} onCancel={() => setEditing(null)} footer={null} width={720}><Editor value={editing || {}} projects={projects} onChange={setEditing} onSave={save} /></Modal><Modal open={!!viewingSummary} title={viewingSummary?.title || '总结全文'} onCancel={() => setViewingSummary(null)} footer={null} width={820}>{viewingSummary && <><div className="summary-viewer">{viewingSummary.content}</div><div className="evidence-index"><b>原始记录证据（{sourceRows.length} 条）</b>{sourceRows.map(r => <div key={r.id}><Tag>[记录#{r.id}]</Tag>{r.title || r.content.slice(0, 80)}</div>)}</div></>}</Modal>
  </div>;
}

function Records({ allLogs, logs, projects, loading, keyword, setKeyword, projectFilter, setProjectFilter, typeFilter, setTypeFilter, followUps, onEdit, onSave, onDelete, onToggle, onSummary, onRefresh }: any) {
  const [journalMode, setJournalMode] = useState<'albums' | 'board' | 'list'>('albums');
  const [costEntryOpen, setCostEntryOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [annualTarget, setAnnualTarget] = useState<number | null>(null);
  const savingYear = dayjs().year();
  const costProgressLogs = useMemo(() => logs.filter((l: WorkLogRecord) => l.record_type === 'cost_progress'), [logs]);
  useEffect(() => { if (targetOpen) getSetting(`production_cost_target_${savingYear}`, '0').then(value => setAnnualTarget(Number(value) || null)).catch(() => {}); }, [targetOpen, savingYear]);
  const saveAnnualTarget = async () => { if (!annualTarget || annualTarget <= 0) { message.warning('请输入大于 0 的全年总目标'); return; } await setSetting(`production_cost_target_${savingYear}`, String(annualTarget)); window.dispatchEvent(new Event('costhub-production-target-updated')); setTargetOpen(false); message.success(`已设置 ${savingYear} 年全年总降本目标`); };
  const [bookCatalog, setBookCatalog] = useState<{ key: string; name: string }[] | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [bookEditor, setBookEditor] = useState<{ key: string; name: string; existing: boolean } | null>(null);
  const [savingBook, setSavingBook] = useState(false);
  useEffect(() => { getSetting('worklog_books', '').then(raw => {
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some(book => !book || typeof book.key !== 'string' || typeof book.name !== 'string')) throw new Error('书册数据格式无效');
      setBookCatalog(parsed);
    }
    setCatalogReady(true);
  }).catch(() => message.error('书册加载失败，请重新进入手账')); }, []);
  const persistBooks = async (next: { key: string; name: string }[]) => {
    if (!catalogReady) throw new Error('书册尚未加载完成');
    await setSetting('worklog_books', JSON.stringify(next));
    setBookCatalog(next);
  };
  const [selectedBook, setSelectedBook] = useState<string>('memo');
  const [readingId, setReadingId] = useState<number | null>(null);
  const [readingBookKey, setReadingBookKey] = useState<string | null>(null);
  const [bookCategories, setBookCategories] = useState<Record<string, string>>({});
  const [categoriesReady, setCategoriesReady] = useState(false);
  useEffect(() => { getSetting('worklog_book_categories', '{}').then(raw => {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) setBookCategories(Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.trim())) as Record<string, string>);
    setCategoriesReady(true);
  }).catch(() => message.error('书册分类加载失败，请重新进入手账后再调整分类')); }, []);
  const saveBookCategory = async (key: string, category: string) => {
    if (!categoriesReady) throw new Error('分类尚未加载完成');
    const updated = { ...bookCategories, [key]: category };
    await setSetting('worklog_book_categories', JSON.stringify(updated));
    setBookCategories(updated);
  };
  const grouped = new Map<string, WorkLogRecord[]>();
  logs.forEach((l: WorkLogRecord) => grouped.set(String(l.log_date).slice(0, 10), [...(grouped.get(String(l.log_date).slice(0, 10)) || []), l]));
  const knownProjectIds = new Set(projects.map((p: any) => Number(p.id)));
  const bookKeyForLog = (log: WorkLogRecord) => log.project_id && knownProjectIds.has(Number(log.project_id)) ? String(log.project_id) : log.work_project?.trim() ? `manual:${log.work_project.trim()}` : 'memo';
  const chronological = (rows: WorkLogRecord[]) => [...rows].sort((a, b) => String(a.log_date).localeCompare(String(b.log_date)) || a.id - b.id);
  const manualProjectNames = [...new Set<string>(allLogs.filter((l: WorkLogRecord) => bookKeyForLog(l).startsWith('manual:')).map((l: WorkLogRecord) => l.work_project.trim()))];
  const memoRows = allLogs.filter((l: WorkLogRecord) => bookKeyForLog(l) === 'memo');
  const sourceBooks = [
    ...projects.map((p: any) => ({ key: String(p.id), code: p.code || `P-${p.id}`, name: p.name || '未命名项目', sub: p.category || '项目记录', category: bookCategories[String(p.id)] || p.category || '未分类', rows: chronological(allLogs.filter((l: WorkLogRecord) => Number(l.project_id) === Number(p.id))) })),
    ...manualProjectNames.map(name => ({ key: `manual:${name}`, code: 'MANUAL', name, sub: '手动关联项目', category: bookCategories[`manual:${name}`] || '未分类', rows: chronological(allLogs.filter((l: WorkLogRecord) => bookKeyForLog(l) === `manual:${name}`)) })),
    ...(memoRows.length || !projects.length ? [{ key: 'memo', code: 'MEMO', name: '工作备忘', sub: '未关联项目的记录', category: bookCategories.memo || '其他', rows: chronological(memoRows) }] : []),
  ];
  // Existing recorded notebooks remain available; empty projects never become books automatically.
  const catalogInitializing = useRef(false);
  const catalog = bookCatalog ?? sourceBooks.filter(book => book.rows.length > 0).map(({ key, name }) => ({ key, name }));
  useEffect(() => {
    if (!catalogReady || loading || bookCatalog !== null || catalogInitializing.current) return;
    catalogInitializing.current = true;
    void persistBooks(catalog).catch(error => { setCatalogReady(false); message.error(`书册初始化失败：${String(error)}`); });
  }, [catalogReady, loading, bookCatalog, catalog]);
  const books = catalog.map(entry => ({ ...(sourceBooks.find(book => book.key === entry.key) || { key: entry.key, code: 'MANUAL', sub: '独立书册', category: '其他', rows: [] as WorkLogRecord[] }), ...entry, category: bookCategories[entry.key] || sourceBooks.find(book => book.key === entry.key)?.category || '其他' }));
  const saveBook = async () => {
    if (!bookEditor || savingBook) return;
    const name = bookEditor.name.trim();
    if (!name) { message.warning('请输入书册名称'); return; }
    const key = bookEditor.key || `manual:${name}`;
    if (!bookEditor.existing && catalog.some(book => book.key === key)) { message.warning('该项目或名称已有书册，请编辑已有书册'); return; }
    setSavingBook(true);
    try { await persistBooks(bookEditor.existing ? catalog.map(book => book.key === key ? { key, name } : book) : [...catalog, { key, name }]); setSelectedBook(key); setBookEditor(null); message.success('书册已保存'); }
    catch (error) { message.error(`书册保存失败：${String(error)}`); }
    finally { setSavingBook(false); }
  };
  const removeBook = (key: string) => Modal.confirm({ title: '删除这本书册？', content: '从书架移除，原始工作记录仍保留在“记录列表”中。需要时可重新创建关联书册。', okText: '删除书册', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => { try { await persistBooks(catalog.filter(book => book.key !== key)); if (readingBookKey === key) setReadingBookKey(null); } catch (error) { message.error(`删除失败：${String(error)}`); throw error; } } });
  const shelfBooks = books.filter(book => (!projectFilter || book.key === String(projectFilter)) && ((!keyword && !typeFilter) || logs.some((log: WorkLogRecord) => bookKeyForLog(log) === book.key)));
  const activeBook = shelfBooks.find(book => book.key === selectedBook) || shelfBooks[0];
  const activeRows: WorkLogRecord[] = activeBook?.rows || [];
  const readingBook = books.find(book => book.key === readingBookKey) || sourceBooks.find(book => book.key === readingBookKey);
  const readingRows: WorkLogRecord[] = readingBook?.rows || [];
  const readingLog = readingRows.find(log => log.id === readingId) || readingRows.at(-1) || null;
  const openBook = (key: string) => { setSelectedBook(key); setReadingBookKey(key); setReadingId(books.find(book => book.key === key)?.rows.at(-1)?.id || null); };
  const openLog = (log: WorkLogRecord) => { const key = bookKeyForLog(log); setSelectedBook(key); setReadingBookKey(key); setReadingId(log.id); };
  const journalContent = journalMode === 'albums' ? <>
    <div className="journal-book-actions"><Button type="primary" disabled={bookCatalog === null || !catalogReady} onClick={() => setBookEditor({ key: '', name: '', existing: false })}>新建书册</Button><Button disabled={bookCatalog === null || !catalogReady || !activeBook} onClick={() => activeBook && setBookEditor({ key: activeBook.key, name: activeBook.name, existing: true })}>编辑书册</Button><Button danger disabled={bookCatalog === null || !catalogReady || !activeBook} onClick={() => activeBook && removeBook(activeBook.key)}>删除书册</Button></div>
    <Modal open={!!bookEditor} title={bookEditor?.existing ? '编辑书册' : '新建书册'} onCancel={() => { if (!savingBook) setBookEditor(null); }} onOk={saveBook} confirmLoading={savingBook} okText="保存书册" cancelText="取消"><Form layout="vertical"><Form.Item label="书册名称" required><Input aria-label="书册名称" maxLength={80} value={bookEditor?.name || ''} onChange={event => setBookEditor(value => value && { ...value, name: event.target.value })} /></Form.Item>{!bookEditor?.existing && <Form.Item label="关联项目（可选）"><Select aria-label="书册关联项目" allowClear placeholder="不关联项目，创建独立书册" value={bookEditor?.key || undefined} onChange={key => setBookEditor(value => value && { ...value, key: key || '', name: value.name || sourceBooks.find(book => book.key === key)?.name || '' })} options={sourceBooks.filter(book => !catalog.some(entry => entry.key === book.key)).map(book => ({ value: book.key, label: `${book.code} · ${book.name}` }))} /></Form.Item>}<p>书册名称可自行修改；历史记录的项目归属保持不变。</p></Form></Modal>
    <JournalShelf books={shelfBooks} selected={activeBook?.key} onSelect={setSelectedBook} onOpen={openBook} onCategoryChange={saveBookCategory} />
    <section className="journal-below">
      <div className="content-card journal-current"><div className="journal-current-title"><div><span className="eyebrow">CURRENT NOTEBOOK</span><h2>{activeBook?.code || 'MEMO'} · {activeBook?.name || '工作备忘'}</h2><p>{activeBook?.sub || '先写下今天的判断，再慢慢补齐上下文。'}</p></div><Button type="primary" disabled={!activeBook} onClick={() => openBook(activeBook.key)}>展开手账</Button></div>{activeRows.slice(-3).reverse().map((log: WorkLogRecord) => <button type="button" className="journal-entry-preview" key={log.id} onClick={() => openLog(log)}><span className="journal-date-block">{String(log.log_date).slice(8, 10)}<small>{dayjs(log.log_date).format('MMM YYYY').toUpperCase()}</small></span><span><strong>{log.title || TYPE_LABEL[log.record_type] || '工作记录'}</strong><p>{TYPE_LABEL[log.record_type] || '工作记录'} · {log.evidence?.length ? '已关联证据' : '暂无关联证据'}</p></span><span aria-hidden="true">→</span></button>)}{!activeRows.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这本手账还没有记录" />}</div>
      <aside className="journal-sticky"><h3>下一步，记在这里。</h3>{followUps[0] ? <label><input type="checkbox" checked={!!followUps[0].done} onChange={e => onToggle(followUps[0].id, e.target.checked)} />{followUps[0].content}</label> : <p>把下一次需要验证的判断写下来，回到这里继续。</p>}<small>{followUps[0]?.work_project || '工作备忘'} · {followUps[0]?.due_at || '待安排'}</small></aside>
    </section>
    <section className="content-card journal-cost-progress"><div className="journal-cost-progress-head"><div><span className="eyebrow">COST PROGRESS</span><h2>关键成本进展</h2><p>记录不同器件的单台降本、原因和年发货量，收益会汇总到工作台。</p></div><div className="journal-cost-progress-actions"><Button onClick={() => setTargetOpen(true)}>设置年度总目标</Button><Button type="primary" onClick={() => setCostEntryOpen(true)}>录入关键成本</Button></div></div>{costProgressLogs.slice(0, 3).map((log: WorkLogRecord) => <button type="button" className="journal-cost-progress-row" key={log.id} onClick={() => openLog(log)}><time>{String(log.log_date).slice(0, 10)}</time><span><strong>{log.work_project || '未关联项目'}</strong><small>{log.title || '关键成本进展'}</small></span><p>{log.content}</p><span aria-hidden="true">→</span></button>)}{!costProgressLogs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有关键成本进展，从这里录入第一条" />}</section><CostProgressEntry open={costEntryOpen} projects={projects} onClose={() => setCostEntryOpen(false)} onSaved={async () => { setCostEntryOpen(false); await onRefresh?.(); }} /><Modal open={targetOpen} title={`设置 ${savingYear} 年全年总降本目标`} onCancel={() => setTargetOpen(false)} onOk={() => void saveAnnualTarget()} okText="保存年度目标" cancelText="取消"><p className="journal-cost-entry-hint">这是所有器件和项目降本收益的汇总目标，不属于某一条关键成本记录。</p><InputNumber autoFocus min={0.01} precision={0} value={annualTarget ?? undefined} onChange={value => setAnnualTarget(typeof value === 'number' ? value : null)} addonBefore="¥" addonAfter="全年总目标" style={{ width: '100%' }} /></Modal>
  </> : journalMode === 'board' ? <div className="journal-note-board">{logs.map((log: WorkLogRecord, index: number) => <button type="button" className="journal-note" style={{ '--note-angle': `${index % 2 ? -1 : 1}deg` } as React.CSSProperties} key={log.id} onClick={() => openLog(log)}><small>{log.work_project || 'MEMO'} / {TYPE_LABEL[log.record_type] || '工作进展'}</small><h3>{log.title || TYPE_LABEL[log.record_type] || '工作记录'}</h3><p>{log.content}</p><small>{String(log.log_date).slice(0, 10)} · 打开记录 →</small></button>)}{!logs.length && <div className="content-card worklog-empty"><Empty description="没有匹配记录" /></div>}</div> : <div className="journal-list content-card">{[...grouped].map(([date, rows]) => <section className="journal-list-day" key={date}><h2>{date === dayjs().format('YYYY-MM-DD') ? '今天' : date}<small>{rows.length} 条</small></h2>{rows.map(log => <div className="journal-list-record" key={log.id}><button type="button" onClick={() => openLog(log)}><strong>{log.title || TYPE_LABEL[log.record_type] || '工作记录'}</strong><p>{log.work_project || 'MEMO'} · {TYPE_LABEL[log.record_type] || '工作进展'} · {log.evidence?.length ? '已关联证据' : '暂无证据'}</p></button><time>{String(log.log_date).slice(11, 16)}</time><Button type="text" aria-label="编辑记录" icon={<EditOutlined />} onClick={() => onEdit(log)} /><Button type="text" danger aria-label="删除记录" icon={<DeleteOutlined />} onClick={() => onDelete(log.id)} /></div>)}</section>)}{!logs.length && <Empty description="没有匹配记录" />}</div>;
  return <><div className="worklog-layout"><main><div className="journal-toolbar"><div className="journal-mode-tabs" role="tablist" aria-label="手账视图">{[['albums', '手账册'], ['board', '便签'], ['list', '记录列表']].map(([key, label]) => <button type="button" role="tab" aria-selected={journalMode === key} className={journalMode === key ? 'is-active' : ''} key={key} onClick={() => setJournalMode(key as 'albums' | 'board' | 'list')}>{label}</button>)}</div><Input allowClear prefix={<SearchOutlined />} placeholder="搜索标题、内容或项目" value={keyword} onChange={e => setKeyword(e.target.value)} /><Select allowClear placeholder="记录类型" value={typeFilter || undefined} onChange={setTypeFilter} options={WORK_LOG_TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }))} /><Select allowClear placeholder="关联项目" value={projectFilter || undefined} onChange={v => setProjectFilter(v || '')} options={projects.map((p: any) => ({ value: p.id, label: `[${p.code}] ${p.name}` }))} /></div>{loading ? <div className="content-card worklog-loading"><Spin /></div> : journalContent}</main><aside className="worklog-side"><section className="content-card"><div className="section-heading"><h2>今日跟进</h2><span>{followUps.length}</span></div>{followUps.slice(0, 5).map((r: WorkLogRecord) => <label className="follow-row" key={r.id}><input type="checkbox" checked={!!r.done} onChange={e => onToggle(r.id, e.target.checked)} /><span>{r.content}</span><small>{r.due_at || '待安排'}</small></label>)}{!followUps.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待跟进" />}</section><section className="content-card"><div className="section-heading"><h2>AI 总结</h2><RobotOutlined /></div><p>按本周、本月、项目或季度记录生成，所有引用来自手账原始记录。</p><Button block onClick={() => onSummary('week')}>生成本周总结</Button></section></aside></div>{readingBook && <JournalReader key={readingBook.key} log={readingLog} rows={readingRows} book={readingBook} projects={projects} onClose={() => setReadingBookKey(null)} onSelect={setReadingId} onSave={onSave} />}</>; }

function CostProgressEntry({ open, projects, onClose, onSaved }: { open: boolean; projects: any[]; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [form] = Form.useForm();
  const selectedProjectRef = Form.useWatch('project_ref', form);
  const [boms, setBoms] = useState<any[]>([]);
  const projectLabel = (project: any) => `[${project.code || `P-${project.id}`}] ${project.name || '未命名项目'}`;
  const bomLabel = (row: any) => `${row.module_name || '未分模块'} / ${row.part_name || '未命名器件'}${row.part_model ? ` · ${row.part_model}` : ''}`;
  const selectedProject = projects.find(project => projectLabel(project) === selectedProjectRef);
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ project_ref: projects[0] ? projectLabel(projects[0]) : '', saving_year: dayjs().year() });
  }, [open, projects, form]);
  useEffect(() => {
    if (!selectedProject?.id) { setBoms([]); form.setFieldValue('part_ref', undefined); return; }
    getProjectBOMs(Number(selectedProject.id)).then(setBoms).catch(() => setBoms([]));
    form.setFieldValue('part_ref', undefined);
  }, [selectedProject?.id, form]);
  const submit = async () => {
    try {
      const value = await form.validateFields();
      const bom = boms.find(row => bomLabel(row) === value.part_ref);
      const projectName = selectedProject?.name || String(value.project_ref || '').trim();
      const projectCode = selectedProject?.code || '';
      await saveProductionCostSaving({
        project_id: Number(selectedProject?.id || 0), project_code: projectCode, project_name: projectName,
        project_bom_id: Number(bom?.id || 0), part_id: Number(bom?.part_id || 0),
        part_name: bom?.part_name || String(value.part_ref || '').trim(), part_model: bom?.part_model || '', module_name: bom?.module_name || '',
        saving_year: Number(value.saving_year), unit_saving: Number(value.unit_saving), annual_shipments: Number(value.annual_shipments), note: String(value.note || '').trim(),
      });
      window.dispatchEvent(new Event('costhub-production-saving-updated'));
      message.success('关键成本进展已保存，并同步到年度收益看板');
      await onSaved();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(`保存失败：${e?.message || e}`);
    }
  };
  return <Modal open={open} title="录入关键成本进展" width={650} onCancel={onClose} onOk={() => void submit()} okText="保存到手账与收益看板" cancelText="取消">
    <p className="journal-cost-entry-hint">项目和器件都支持下拉选择或直接手写；这里只记录单项器件的降本事实，全年总目标请在手账的“设置年度总目标”中单独维护。</p>
    <Form form={form} layout="vertical">
      <div className="journal-cost-entry-grid"><Form.Item label="项目" name="project_ref" rules={[{ required: true, message: '请选择或填写项目' }]}><AutoComplete allowClear options={projects.map(project => ({ value: projectLabel(project) }))} placeholder="选择项目或手写项目名称" /></Form.Item><Form.Item label="项目器件" name="part_ref" rules={[{ required: true, message: '请选择或填写项目器件' }]}><AutoComplete allowClear options={boms.map(row => ({ value: bomLabel(row) }))} placeholder={selectedProject ? '选择项目 BOM 器件或手写' : '手写项目器件名称'} /></Form.Item></div>
      <div className="journal-cost-entry-grid"><Form.Item label="年度" name="saving_year" rules={[{ required: true }]}><InputNumber min={2000} max={2100} precision={0} style={{ width: '100%' }} /></Form.Item><Form.Item label="单台降本幅度（¥/台）" name="unit_saving" rules={[{ required: true, type: 'number', min: 0.01, message: '请输入大于 0 的降本幅度' }]}><InputNumber min={0.01} precision={2} style={{ width: '100%' }} /></Form.Item></div>
      <Form.Item label="年发货量（台）" name="annual_shipments" rules={[{ required: true, type: 'number', min: 1, message: '请输入大于 0 的发货量' }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
      <Form.Item label="降本原因" name="note" rules={[{ required: true, message: '请填写降本原因' }]}><Input.TextArea rows={4} placeholder="如：二供导入、结构件改版、供应商议价或规格优化" /></Form.Item>
    </Form>
  </Modal>;
}

function JournalEntryContent({ log }: { log: WorkLogRecord }) {
  return <div className="journal-entry-copy"><div className="journal-entry-date"><span>{TYPE_LABEL[log.record_type] || '工作进展'}</span><time>{String(log.log_date).slice(0, 16)}</time></div><span className="journal-entry-type">{log.stage || '工作进展'}</span><h1>{log.title || TYPE_LABEL[log.record_type] || '工作记录'}</h1><div className="journal-entry-body">{log.content}</div>{log.next_action && <div className="journal-entry-next">下一步<br />{log.next_action}</div>}<div className="journal-entry-source">{log.evidence?.length ? <><LinkOutlined /> 已关联 {log.evidence.length} 条证据</> : '暂无关联证据'}</div></div>;
}

function JournalReader({ log, rows, book, projects, onClose, onSelect, onSave }: { log: WorkLogRecord | null; rows: WorkLogRecord[]; book: any; projects: any[]; onClose: () => void; onSelect: (id: number) => void; onSave: (value: EditorValue) => Promise<number | false> }) {
  const index = rows.findIndex(row => row.id === log?.id);
  const [inlineValue, setInlineValue] = useState<EditorValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [coverOpen, setCoverOpen] = useState(journalMotionEnabled);
  const [turn, setTurn] = useState<{ target: number; backward: boolean; from: WorkLogRecord } | null>(null);
  const turnTarget = useRef<number | null>(null);
  const finishTurn = useCallback(() => {
    const target = turnTarget.current;
    if (target === null) return;
    turnTarget.current = null;
    onSelect(target);
    setTurn(null);
  }, [onSelect]);
  useEffect(() => { if (!coverOpen) return; const timer = window.setTimeout(() => setCoverOpen(false), 1450); return () => window.clearTimeout(timer); }, [coverOpen]);
  useEffect(() => {
    if (!turn) return;
    // Animation end is primary; fallback also completes when motion is switched off mid-turn.
    const timer = window.setTimeout(finishTurn, 1750);
    return () => window.clearTimeout(timer);
  }, [turn, finishTurn]);
  const turnPage = useCallback((id: number) => {
    if (!log || id === log.id || turnTarget.current !== null || inlineValue || coverOpen) return;
    if (!journalMotionEnabled()) { onSelect(id); return; }
    turnTarget.current = id;
    setTurn({ target: id, backward: rows.findIndex(row => row.id === id) < index, from: log });
  }, [log, inlineValue, coverOpen, onSelect, rows, index]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName || '') || (event.target as HTMLElement)?.isContentEditable) return;
      if (event.key === 'ArrowLeft' && rows[index - 1]) { event.preventDefault(); turnPage(rows[index - 1].id); }
      if (event.key === 'ArrowRight' && rows[index + 1]) { event.preventDefault(); turnPage(rows[index + 1].id); }
    };
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, rows, turnPage]);
  const startNew = () => setInlineValue(newJournalEntry(Number(book.key) || 0, book.key.startsWith('manual:') ? book.key.slice(7) : book.key === 'memo' ? '' : (projects.find(project => String(project.id) === book.key)?.name || book.name)));
  const startEdit = () => { if (log) setInlineValue({ ...log, evidence_json: JSON.stringify(log.evidence || []) }); };
  const saveInline = async (value: EditorValue) => {
    setSaving(true);
    try { const id = await onSave(value); if (id) { setInlineValue(null); onSelect(id); } return id; }
    finally { setSaving(false); }
  };
  const close = () => {
    if (saving) return;
    if (inlineValue) { Modal.confirm({ title:'离开未保存的记录？', content:'当前输入尚未保存，继续留在这里可以完成记录。', okText:'放弃并合上', cancelText:'继续记录', onOk:onClose }); }
    else onClose();
  };
  const busy = !!inlineValue || !!turn || coverOpen;
  return <Modal open title={null} footer={null} width={1080} centered className="journal-reader-modal" onCancel={close} maskClosable={!inlineValue} keyboard={!inlineValue}>
    <div className="journal-reader-toolbar"><div><span className="eyebrow">工作手账 / {book.category || '未分类'}</span><h2>{book.code} · {book.name}</h2><p className="journal-reader-mode-hint">一本项目手账 · {rows.length} 条记录 · 按时间排列</p></div><div className="journal-reader-actions"><Button disabled={!log || busy} onClick={startEdit} icon={<EditOutlined />}>修改本条</Button><Button type="primary" disabled={busy} onClick={startNew}>继续记录</Button></div></div>
    <div style={bookAppearance(book.key)} className={`journal-open-book journal-bound ${turn ? 'is-turning' : ''}`}>
      <aside className="journal-left-leaf"><div className="journal-leaf-top"><span>{book.code}</span><span>记录目录</span></div><h3>{book.category || '项目记录'}</h3><p>继续记录会新增一页，已写内容始终保留。</p><div className="journal-toc">{rows.map((row, rowIndex) => <button type="button" disabled={busy} className={row.id === log?.id ? 'is-active' : ''} aria-current={row.id === log?.id ? 'page' : undefined} key={row.id} onClick={() => turnPage(row.id)}><span>{String(rowIndex + 1).padStart(2, '0')}</span><span className="journal-toc-title">{row.title || TYPE_LABEL[row.record_type] || '工作记录'}<small>{String(row.log_date).slice(0, 16)}</small></span></button>)}</div><small className="journal-leaf-footer">CostHub · 每一次记录，都是新的一页</small></aside>
      <article className={`journal-right-leaf ${inlineValue ? 'is-editing' : ''}`}>
        {inlineValue ? <div className="journal-inline-editor"><div className="journal-inline-editor-head"><div><span className="eyebrow">{inlineValue.id ? 'EDIT THIS ENTRY' : 'NEW ENTRY'}</span><h1>{inlineValue.id ? '修改本条记录' : '继续记录 · 新的一页'}</h1><p className="journal-reader-mode-hint">{inlineValue.id ? '保存后仅更新当前这一条记录。' : '保存为新记录，不会覆盖前面的内容。'}</p></div><Button type="text" disabled={saving} onClick={() => setInlineValue(null)}>取消</Button></div><Editor value={inlineValue} projectLocked projects={projects} onChange={setInlineValue} onSave={saveInline} /></div>
          : log ? <div className={turn ? '' : 'journal-page-arrival'} key={log.id}><JournalEntryContent log={log} /></div>
          : <Empty description="这本书还没有记录"><Button type="primary" disabled={coverOpen} onClick={startNew}>写下第一条记录</Button></Empty>}
      </article>
      <span className="journal-binding" aria-hidden="true" />
      {(coverOpen || turn) && <div className="bound-layers" aria-hidden="true">
        {coverOpen && <div className="bound-cover" onAnimationEnd={event => { if (event.target === event.currentTarget) setCoverOpen(false); }}><div className="bound-cover-front"><small>COSTHUB / {book.code}</small><strong>{book.name}</strong><span>工作手账 · {rows.length} 条记录</span></div><div className="bound-cover-back" /></div>}
        {turn && <JournalTurningPage backward={turn.backward} onFinish={finishTurn}><JournalEntryContent log={turn.from} /></JournalTurningPage>}
      </div>}
    </div>
    <div className="journal-reader-controls"><span aria-live="polite">{Math.max(0, index + 1)} / {rows.length} 条记录</span><div><Button disabled={!rows[index - 1] || busy} onClick={() => turnPage(rows[index - 1].id)}>上一页</Button><Button disabled={!rows[index + 1] || busy} onClick={() => turnPage(rows[index + 1].id)}>下一页</Button></div><span>{turn ? '翻页中…' : '方向键翻阅 · Esc 合上'}</span></div>
  </Modal>;
}
function ProjectTrail({ logs, projects, selected, setSelected, onSummary }: any) { const rows = logs.filter((l: WorkLogRecord) => l.project_id === Number(selected)); const stageFor = (r: WorkLogRecord) => PROJECT_STAGES.includes(r.stage) ? r.stage : r.record_type === 'outcome' ? '量产后降本' : r.record_type === 'decision' ? 'CDCP' : r.record_type === 'risk' ? 'PDCP' : 'Charter'; return <div className="project-trail"><section className="content-card project-trail-head"><div><span className="eyebrow">PROJECT THREAD</span><h2>项目脉络</h2><p>按 Charter、CDCP、PDCP、ADCP 和量产后降本组织同一项目的判断与结果。</p></div><Select showSearch value={selected || undefined} placeholder="选择项目" onChange={setSelected} options={projects.map((p: any) => ({ value: p.id, label: `[${p.code}] ${p.name}` }))} /><Button type="primary" onClick={onSummary} disabled={!selected}>生成项目复盘</Button></section>{selected && <section className="content-card project-stage"><div className="stage-line">{PROJECT_STAGES.map((s, i) => <span className={rows.some((r: WorkLogRecord) => stageFor(r) === s) ? 'has-data' : ''} key={s}><i>{i + 1}</i>{s}</span>)}</div></section>}<section className="content-card project-trail-list">{rows.map((r: WorkLogRecord) => <div className="trail-row" key={r.id}><time>{String(r.log_date).slice(0, 16)}</time><Tag>{stageFor(r)}</Tag><div><b>{TYPE_LABEL[r.record_type]}</b><p>{r.content}</p><small>[记录#{r.id}] {r.impact || r.next_action || '暂无结果/影响'}</small></div></div>)}{!rows.length && <Empty description={selected ? '该项目还没有手账记录' : '请选择项目'} />}</section></div>; }
function SummaryPanel({ summaries, summaryType, setSummaryType, summaryRange, setSummaryRange, summaryProject, setSummaryProject, projects, summaryModel, setSummaryModel, summaryText, summarizing, onGenerate, onSave, onView, onDelete }: any) { return <div className="summary-page"><section className="content-card summary-controls"><div className="section-heading"><div><span className="eyebrow">EVIDENCE-BASED WRITING</span><h2>AI 总结</h2></div><span>引用手账记录和项目系统事件，来源可回看</span></div><div className="summary-control-row"><Select value={summaryType} onChange={setSummaryType} options={Object.entries(SUMMARY_LABEL).map(([value, label]) => ({ value, label }))} /><DatePicker.RangePicker value={summaryRange} onChange={setSummaryRange} /><Select allowClear placeholder="全部项目" value={summaryProject || undefined} onChange={v => setSummaryProject(v || '')} options={projects.map((p: any) => ({ value: p.id, label: `[${p.code}] ${p.name}` }))} /><Input placeholder="总结模型（默认对话模型）" value={summaryModel} onChange={e => setSummaryModel(e.target.value)} onBlur={() => setSummaryModel(summaryModel)} /><Button type="primary" icon={<RobotOutlined />} loading={summarizing} onClick={onGenerate}>生成总结</Button></div><p className="summary-safety-note">数字、金额、项目结论必须能回到原始记录；资料不足时模型会标记“记录中未明确”。</p></section><section className="summary-result content-card">{summaryText ? <><div className="summary-viewer">{summaryText}</div><div className="summary-actions"><Button icon={<SaveOutlined />} onClick={onSave}>保存总结</Button></div></> : <Empty description={summarizing ? '正在读取记录并流式生成…' : '选择范围和总结类型后开始生成'} />}</section><section className="content-card saved-summary-list"><div className="section-heading"><h2>已保存总结</h2><span>{summaries.length} 份</span></div>{summaries.map((s: any) => <div className="saved-summary-row" key={s.id}><div><b>{s.title}</b><small>{SUMMARY_LABEL[s.summary_type] || '工作总结'} · {s.start_date} ~ {s.end_date} · 引用 {s.source_log_ids?.length || 0} 条记录</small></div><Button size="small" icon={<SearchOutlined />} onClick={() => onView(s)}>查看原始记录</Button><Button size="small" danger type="text" aria-label="删除总结" icon={<DeleteOutlined />} onClick={() => onDelete(s.id)} /></div>)}</section></div>; }
function Editor({ value, projects, onChange, onSave, projectLocked = false }: { value: EditorValue; projects: any[]; onChange: (v: EditorValue) => void; onSave: (value: EditorValue) => void | Promise<number | boolean>; projectLocked?: boolean }) { const [saving, setSaving] = useState(false); const patch = (p: Partial<EditorValue>) => onChange({ ...value, ...p }); return <div className="worklog-editor"><div className="editor-grid"><Select value={value.record_type || 'work_progress'} onChange={(v: string) => patch({ record_type: v })} options={WORK_LOG_TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }))} /><Select value={value.stage || 'Charter'} onChange={(v: string) => patch({ stage: v })} options={PROJECT_STAGES.map(stage => ({ value: stage, label: stage }))} /><DatePicker showTime value={value.log_date ? dayjs(value.log_date) : dayjs()} onChange={(v: Dayjs | null) => v && patch({ log_date: v.format('YYYY-MM-DD HH:mm') })} />{projectLocked ? <Input readOnly aria-label="当前书册项目" value={value.work_project || '工作备忘'} /> : <AutoComplete allowClear showSearch placeholder="关联项目（可选择或手写）" value={value.work_project || undefined} onChange={(v: string) => { const p = projects.find((row: any) => row.name === v || row.code === v); patch({ work_project: v || '', project_id: p?.id || 0 }); }} options={projects.map((p: any) => ({ value: p.name, label: p.name }))} />}</div><Input placeholder="标题（可选）" value={value.title || ''} onChange={e => patch({ title: e.target.value })} /><Input.TextArea autoSize={{ minRows: 5, maxRows: 10 }} placeholder="今天做了什么？判断是什么？结果或影响如何？" value={value.content || ''} onChange={e => patch({ content: e.target.value })} /><div className="editor-grid"><Input placeholder="结果或影响（可选）" value={value.impact || ''} onChange={e => patch({ impact: e.target.value })} /><Input placeholder="下一步（可选）" value={value.next_action || ''} onChange={e => patch({ next_action: e.target.value })} /><Input placeholder="到期时间（可选）" value={value.due_at || ''} onChange={e => patch({ due_at: e.target.value })} /></div><Input prefix={<LinkOutlined />} placeholder="证据链接（可选，多个用换行分隔）" value={value.evidence_json && value.evidence_json !== '[]' ? String(value.evidence_json) : ''} onChange={e => patch({ evidence_json: JSON.stringify(e.target.value.split(/\n|,/).map((x: string) => x.trim()).filter(Boolean)) })} /><Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={async () => { if (saving) return; setSaving(true); try { await onSave(value); } finally { setSaving(false); } }}>{value.id ? '保存本条修改' : '保存为新记录'}</Button></div>; }
