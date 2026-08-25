// 用户原声分析（v2.3.19，2026-08-18）：Excel 导入 → 自动分块 → 本地模型逐块提炼 → 汇总最有价值特性维度
import { useEffect, useState } from 'react';
import { Button, Card, Table, Tag, Progress, message, Empty, AutoComplete } from 'antd';
import { UploadOutlined, PlayCircleOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { getSetting } from '../db';
import { addVoiceItem, clearVoiceItems, getAllVoiceItems, getVoiceDimensions, getVoiceProducts, getProjects, startVoiceRun, updateVoiceRunProgress, finishVoiceRun, getRunningVoiceRun, replaceVoiceDimensions } from '../db';
import { chunkVoiceItems, mergeDimensions, parseDimensions, type BlockDimension } from '../voiceAnalyer';
import { detectOllama } from '../aiStatus';
import SellingPointPanel from '../components/SellingPointPanel';

const COL_KEYS = ['评价', '评论', '反馈', '内容', '点评', '口碑', 'text', 'content', 'comment', 'review', 'feedback'];

// 每个维度附「依据原声」：在原始原声中匹配该特性词（结果可溯源、不主观），最多 3 条真实原声
function findEvidence(name: string, items: string[]): string[] {
  const nn = String(name || '').replace(/\s+/g, '');
  if (!nn) return [];
  const norm = (s: string) => String(s || '').replace(/\s+/g, '');
  const hit: string[] = [];
  for (const it of items) { const ni = norm(it); if (ni.includes(nn)) { hit.push(it); if (hit.length >= 3) break; } }
  if (hit.length === 0 && nn.length >= 3) {
    const prefix = nn.slice(0, 2);
    for (const it of items) { const ni = norm(it); if (ni.includes(prefix)) { hit.push(it); if (hit.length >= 3) break; } }
  }
  return hit;
}

export default function UserVoice() {
  const [count, setCount] = useState(0);
  const [dims, setDims] = useState<any[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [curBlock, setCurBlock] = useState<{ idx: number; total: number; items: string[] } | null>(null);
  const [liveDims, setLiveDims] = useState<string[]>([]);
  const [liveChars, setLiveChars] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState('');
  const [products, setProducts] = useState<string[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [sample, setSample] = useState<string[]>([]);

  const load = async () => { const items = await getAllVoiceItems(product); setCount(items.length); setSample(items.slice(0, 5).map((i: any) => String(i.content || '').slice(0, 60))); setDims(await getVoiceDimensions(product)); setProducts((await getVoiceProducts()).map((p: any) => p.product)); const rr = await getRunningVoiceRun(product); if (rr) { try { await finishVoiceRun(rr.id, 'error', '上次分析被中断，已自动结束'); } catch { } setRunning(null); setLog(prev => [...prev, '⚠️ 检测到上次「' + (product || '未选产品') + '」的分析被中断（未完成），已自动结束，可重新开始']); } };
  useEffect(() => { load(); }, [product]);
  useEffect(() => { (async () => { try { setProjects(await getProjects('', '', '')); } catch { } })(); }, []);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
        let added = 0, skipped = 0;
        for (const r of rows) {
          // 自动识别文本列；找不到则把非空单元格拼接
          let content = '';
          for (const k of COL_KEYS) { if (String(r[k] || '').trim()) { content = String(r[k]).trim(); break; } }
          if (!content) content = Object.values(r).filter((v: any) => v && String(v).trim()).map(String).join(' ');
          if (content) { const id = await addVoiceItem(content, file.name, product); if (id > 0) added++; else skipped++; }
        }
        const items = await getAllVoiceItems(product);
        const total = items.length;
        setCount(total); setSample(items.slice(0, 5).map((i: any) => String(i.content || '').slice(0, 60))); setProducts((await getVoiceProducts()).map((p: any) => p.product));
        message.success('「' + (product || '未选产品') + '」导入完成：新增 ' + added + ' 条' + (skipped > 0 ? '，跳过 ' + skipped + ' 条重复' : '') + '（该产品共 ' + total + ' 条）');
      } catch (err: any) { message.error('Excel 解析失败：' + (err?.message || err)); }
    };
    reader.readAsBinaryString(file);
    return false;
  };

  const runAnalyze = async () => {
    if (busy) return;
    setBusy(true); setRunning(null); setLog([]);
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）；分析需要本地 Ollama 模型'); setBusy(false); return; }
    if (!product) { message.warning('请先选择产品（顶部）'); setBusy(false); return; }
    const items = (await getAllVoiceItems(product)).map((i: any) => i.content);
    if (items.length === 0) { message.warning('该产品暂无原声，请先导入'); setBusy(false); return; }
    // ✔ 预检：确认 Ollama 在线且模型已下载——失败快速给原因，不空跑 N 块超时
    setLog(['正在检查本地模型连接…']);
    const st = await detectOllama();
    if (!st.connected) {
      const why = st.reason === 'model-missing' ? '本地模型「' + model + '」未下载（请到设置→连接设置里拉取该模型，或改用已下载的模型）'
        : st.reason === 'offline' ? 'Ollama 未运行（请先启动 Ollama 服务，再回来分析）'
        : '未配置本地模型（设置 → 连接设置）';
      setLog(prev => [...prev, '✖ ' + why]);
      message.error(why);
      setBusy(false);
      return;
    }
    setLog(prev => [...prev, '✔ 本地模型已连接（' + st.model + ' @ ' + st.baseUrl + '），开始分析 ' + items.length + ' 条原声…']);
    const blocks = chunkVoiceItems(items, 3000);
    const runId = await startVoiceRun(items.length, blocks.length, product);
    const results: BlockDimension[][] = [];
    let failBlocks = 0, emptyBlocks = 0;
    setLiveDims([]);
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      setCurBlock({ idx: i + 1, total: blocks.length, items: blk.items });
      setLog(prev => [...prev, '分析第 ' + (i + 1) + '/' + blocks.length + ' 块（' + blk.items.length + ' 条）...']);
      const sys = '你是用户口碑分析专家。下面是一批用户对电子产品的真实评价。请提炼"用户最在意、最有价值的特性维度"，并把相近的说法归纳合并成更高层的特性（如"颜色准/发黄/偏红"都归为"色彩还原"，"卡顿/延迟/拖影"归为"响应速度"），不要拆得太细。只输出 JSON，不要任何分析/解释/前后缀：{"dimensions":[{"name":"特性名","sentiment":"positive或negative"}]}。规则：1) 最多 12 个维度 2) 每个名称不超过 8 字 3) 特性要具体有用（如 续航/压感/外形/连接）4) positive=满意喜欢，negative=吐槽 5) 只依据给出的评价，不要编造。';
      const user = '用户评价：\n' + blk.items.join('\n');
      let full = '';
      setLiveChars(0);
      // 不截断、不超时（用户 2026-08-18：所有本地 AI 都不要截断，让他思考，只要确认在线连接中、会有输出即可）：
      // 预检已确认在线+模型就绪，放心让模型想多久都行，等它自然结束（onDone）或报错（onError）——不再用任何超时掐断
      const ok = await new Promise<boolean>((resolve) => {
        let done = false;
        startOllamaStream(base, model, [{ role: 'system', content: sys }, { role: 'user', content: user }],
          (t) => { full += t; setLiveChars(full.length); }, () => { },
          () => { if (!done) { done = true; resolve(true); } },
          (_err: any) => { if (!done) { done = true; resolve(false); } },
          // 结构化提炼用自由文本（json:false）+ 健壮解析兜底；think:false 免长思考；num_predict 大不截断
          { endpoint: 'native', think: false, json: false, num_predict: 16384 });
      });
      if (!ok) {
        failBlocks++;
        setLog(prev => [...prev, '  ⚠️ 第 ' + (i + 1) + ' 块模型连接报错/中断，已跳过继续']);
        setCurBlock(prev => prev ? { ...prev, items: [] } : prev);
        continue;
      }
      const dims = parseDimensions(full);
      if (dims.length === 0) {
        emptyBlocks++;
        const snippet = full.trim().replace(/\s+/g, ' ').slice(0, 120);
        setLog(prev => [...prev, '  ⚠️ 第 ' + (i + 1) + ' 块模型有输出（' + full.length + ' 字）但未识别出维度，已跳过' + (snippet ? '；输出样例：' + snippet : '')]);
        setCurBlock(prev => prev ? { ...prev, items: [] } : prev);
        try { await logLocalAICall({ request_type: 'voice_analyze', system_prompt: sys, user_prompt: user, response_summary: snippet, success: false, error_message: '输出未解析出维度', model_name: model }); } catch { }
        continue;
      }
      setLiveDims(prev => [...prev, ...dims.map((d_: any) => d_.name)]);
      setCurBlock(prev => prev ? { ...prev, items: [] } : prev);
      // ⚠️ 本地模型调用留痕（AI 请求日志）：每次用户原声提炼记录到 ai_request_logs（本地，不涉外发）
      try { await logLocalAICall({ request_type: 'voice_analyze', system_prompt: sys, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model }); } catch { /* 日志失败不阻断 */ }
      setLog(prev => [...prev, '  第 ' + (i + 1) + ' 块提炼出 ' + dims.length + ' 个维度（模型输出 ' + full.length + ' 字）']);
      results.push(dims);
      setRunning({ done: i + 1, total: blocks.length });
      await updateVoiceRunProgress(runId, i + 1);
    }
    const merged = mergeDimensions(results);
    // ✔ 每个维度附「依据原声」——结果可溯源、不主观（在原始原声中匹配该特性词）
    const withEvidence = merged.map(m => ({ ...m, evidence: JSON.stringify(findEvidence(m.name, items)) }));
    await replaceVoiceDimensions(withEvidence, product);
    if (merged.length === 0) {
      await finishVoiceRun(runId, 'error', '未提炼出维度');
      setDims([]); setRunning(null); setBusy(false);
      if (failBlocks === blocks.length) message.error('分析未完成：本地模型连接报错（已跳过全部 ' + blocks.length + ' 块）。请确认 Ollama 运行正常后重试');
      else message.warning('未提炼出特性维度（模型有输出但格式未被识别）。可在日志查看输出样例，或重试');
      return;
    }
    await finishVoiceRun(runId, 'done');
    setDims(await getVoiceDimensions(product));
    setRunning(null); setBusy(false);
    const skipNote = (failBlocks + emptyBlocks) > 0 ? '（跳过 ' + failBlocks + ' 块报错、' + emptyBlocks + ' 块未识别）' : '';
    message.success('「' + product + '」分析完成：提炼出 ' + merged.length + ' 个特性维度（按用户关注度排序）' + skipNote);
  };

  return (
    <div>
      <div className="page-title"><MessageOutlined /> 用户原声分析{product ? <span style={{ fontSize: 13, color: '#0A84FF', marginLeft: 12 }}>（{product}）</span> : null}</div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <AutoComplete size="middle" value={product} style={{ width: 220 }} placeholder="选择项目/输入产品名"
            options={(() => {
              const projOpts = projects.filter((p: any) => !p.is_deleted && p.code).map((p: any) => ({ value: p.code, label: (p.code || '') + ' ' + (p.name || '') }));
              const otherOpts = products.filter(p => !projOpts.some(o => o.value === p)).map(p => ({ value: p }));
              return [...projOpts, ...otherOpts];
            })()} onChange={v => setProduct(String(v || '').trim())}
            onSelect={(v) => { const val = String(v || '').trim(); setProduct(val); window.dispatchEvent(new CustomEvent('costhub-ai-ctx', { detail: { label: '用户原声分析 · ' + (val || '未选产品') } })); }} allowClear />
          <Button type="primary" icon={<UploadOutlined />} loading={busy} onClick={() => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.xlsx,.xls'; input.onchange = (ev: any) => { const f = ev.target.files?.[0]; if (f) handleFile(f); }; input.click(); }}>导入用户原声（Excel）</Button>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>已导入 <b>{count}</b> 条原声</span>
          <Button icon={<PlayCircleOutlined />} type="primary" loading={busy} onClick={runAnalyze} disabled={running != null}>开始分析（自动分块）</Button>
          <Button danger icon={<DeleteOutlined />} disabled={busy} onClick={async () => { await clearVoiceItems(); await load(); setLog([]); message.success('已清空'); }}>清空</Button>
        </div>
        {sample.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: '#64748B', lineHeight: 1.7, background: '#FAFBFC', border: '1px solid #EEF1F4', borderRadius: 6, padding: '6px 10px' }}>
            <b style={{ color: '#475569' }}>已导入原声示例（共 {count} 条）：</b>
            {sample.map((s, i) => <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {s}</div>)}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 11.5, color: '#94A3B8', lineHeight: 1.6 }}>导入上一代产品的用户评价/口碑 Excel，本地模型自动分块（每块约 3000 字）逐块提炼用户最在意的特性维度，全部完成后自动汇总为「最有价值特性」权重榜——作为价值工程/新品特性的客观依据。<b style={{ color: '#0A84FF' }}>选「项目」后原声归到该项目代号，与下方卖点价值分析（原声×模块成本）直接关联。</b></div>
        {running && (
          <div style={{ marginTop: 10, background: '#F5FAFF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <Progress percent={Math.round((running.done / running.total) * 100)} size="small" style={{ flex: 1 }} />
              <b style={{ fontSize: 12.5, color: '#0A84FF', whiteSpace: 'nowrap' }}>{running.done}/{running.total} 块</b>
            </div>
            {curBlock && (
              <div style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.6 }}>
                <div><b>正在分析第 {curBlock.idx} 块（共 {curBlock.total} 块）</b> · 本块 {curBlock.items.length} 条原声{liveChars > 0 && <span style={{ color: '#0A84FF' }}> · 模型输出中（已 {liveChars} 字）</span>}</div>
                {curBlock.items.length > 0 && (
                  <div style={{ color: '#64748B', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>样例：{curBlock.items.slice(0, 2).map((s: string) => s.slice(0, 22)).join(' ｜ ')}</div>
                )}
              </div>
            )}
            {liveDims.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, color: '#94A3B8' }}>已提炼维度（实时累积）：</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>{liveDims.slice(0, 20).map((d, i) => <Tag key={i} color="blue" style={{ margin: 0, fontSize: 10.5 }}>{d}</Tag>)}</div>
              </div>
            )}
          </div>
        )}
        {log.length > 0 && (
          <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto', background: '#F8FAFC', border: '1px solid #E8ECF1', borderRadius: 6, padding: '6px 10px', fontSize: 11.5, color: '#64748B' }}>
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </Card>
      {dims.length === 0 ? (
        <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="导入原声并点击「开始分析」后，这里展示提炼出的最有价值特性维度" /></Card>
      ) : (
        <Card size="small">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>用户原声提炼 · 最有价值特性维度（{product}，按声量排序）<span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>　点击行展开查看依据原声</span></div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10, lineHeight: 1.6 }}>
            🔥 声量 = 提到该特性的用户数（<b>在乎的人多</b>），主导排序最靠前；💬 好评率 = 正面占比（做得好不好）；😡 负面多 = 待改进。类型：<b>🔥强卖点</b>（声量高口碑好）/ <b>⚠️待改进</b>（声量高吐槽多）/ <b>○次要</b>（声量低）。
          </div>
          <Table size="small" dataSource={dims} rowKey="id" pagination={{ pageSize: 10 }}
            expandable={{
              expandedRowRender: (r: any) => {
                let ev: string[] = [];
                try { const p = JSON.parse(r.evidence || '[]'); if (Array.isArray(p)) ev = p.map(String).filter(Boolean); } catch { }
                if (ev.length === 0) return <span style={{ fontSize: 11.5, color: '#94A3B8' }}>（原声中未直接匹配到该特性词，可回导入内容核对）</span>;
                return <div style={{ paddingLeft: 8 }}>{ev.map((s, i) => <div key={i} style={{ fontSize: 11.5, color: '#64748B', lineHeight: 1.6 }}>「{s}」</div>)}</div>;
              }
            }}
            columns={[
              { title: '特性维度', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
              { title: '🔥 声量', dataIndex: 'weight', width: 80, align: 'center', render: (v: number) => <b style={{ color: '#0A84FF', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{v}</b> },
              { title: '💬 好评率', key: 'q', width: 90, align: 'center', render: (_: any, r: any) => { const quality = r.count > 0 ? Math.round((r.positive / r.count) * 100) : 0; return <Tag color={quality >= 60 ? 'green' : quality >= 30 ? 'orange' : 'red'}>{quality}%</Tag>; } },
              { title: '👍 正面', dataIndex: 'positive', width: 70, align: 'center', render: (v: number) => <span style={{ color: '#10B981', fontWeight: 600 }}>{v}</span> },
              { title: '👎 负面', dataIndex: 'negative', width: 70, align: 'center', render: (v: number) => <span style={{ color: '#DC2626', fontWeight: 600 }}>{v}</span> },
              { title: '类型', key: 'kind', width: 90, align: 'center', render: (_: any, r: any) => r.kind === 'strong' ? <Tag color="red">🔥强卖点</Tag> : r.kind === 'fix' ? <Tag color="orange">⚠️待改进</Tag> : <Tag color="default">○次要</Tag> },
              { title: '声量分布', key: 'bar', render: (_: any, r: any) => { const max = dims[0]?.weight || 1; return <div style={{ height: 10, background: '#F1F5F9', borderRadius: 5, overflow: 'hidden' }}><div style={{ width: Math.round((r.weight / max) * 100) + '%', height: '100%', background: 'linear-gradient(90deg,#0A84FF,#5E5CE6)' }} /></div>; } },
            ]} />
        </Card>
      )}
      <SellingPointPanel product={product} />
    </div>
  );
}
