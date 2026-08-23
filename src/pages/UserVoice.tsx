// 用户原声分析（v2.3.19，2026-08-18）：Excel 导入 → 自动分块 → 本地模型逐块提炼 → 汇总最有价值特性维度
import { useEffect, useState } from 'react';
import { Button, Card, Table, Tag, Progress, message, Empty, AutoComplete } from 'antd';
import { UploadOutlined, PlayCircleOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { getSetting } from '../db';
import { addVoiceItem, clearVoiceItems, getAllVoiceItems, getVoiceItemCount, getVoiceDimensions, getVoiceProducts, startVoiceRun, updateVoiceRunProgress, finishVoiceRun, getRunningVoiceRun, replaceVoiceDimensions } from '../db';
import { chunkVoiceItems, mergeDimensions, type BlockDimension } from '../voiceAnalyer';

const COL_KEYS = ['评价', '评论', '反馈', '内容', '点评', '口碑', 'text', 'content', 'comment', 'review', 'feedback'];

function parseDimensions(text: string): BlockDimension[] {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return [];
  const cand = [body.slice(s, e + 1), body.slice(s, e + 1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,(\s*[}]])/g, '$1')];
  for (const c of cand) {
    try { const d = JSON.parse(c); if (d && Array.isArray(d.dimensions)) return d.dimensions; } catch { }
  }
  return [];
}

export default function UserVoice() {
  const [count, setCount] = useState(0);
  const [dims, setDims] = useState<any[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState('');
  const [products, setProducts] = useState<string[]>([]);

  const load = async () => { setCount(await getVoiceItemCount(product)); setDims(await getVoiceDimensions(product)); setProducts((await getVoiceProducts()).map((p: any) => p.product)); const rr = await getRunningVoiceRun(product); if (rr) setRunning({ done: rr.done_chunks, total: rr.total_chunks }); };
  useEffect(() => { load(); }, [product]);

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
        const total = await getVoiceItemCount(product);
        setCount(total); setProducts((await getVoiceProducts()).map((p: any) => p.product));
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
    const blocks = chunkVoiceItems(items, 3000);
    const runId = await startVoiceRun(items.length, blocks.length, product);
    const results: BlockDimension[][] = [];
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      setLog(prev => [...prev, '分析第 ' + (i + 1) + '/' + blocks.length + ' 块（' + blk.items.length + ' 条）...']);
      const sys = '你是用户口碑分析专家。下面是一批用户对电子产品的真实评价。请提炼"用户最在意、最有价值的特性维度"，每个标注情感倾向。只输出 JSON：{"dimensions":[{"name":"特性名","sentiment":"positive或negative"}]}。规则：1) 最多 15 个维度 2) 只依据给出的评价，不要编造 3) 特性要具体有用（如 续航/压感/外形/连接）4) positive=用户满意喜欢，negative=用户吐槽。';
      const user = '用户评价：\n' + blk.items.join('\n');
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base, model, [{ role: 'system', content: sys }, { role: 'user', content: user }],
          (t) => { full += t; }, () => { }, () => resolve(), (err) => reject(new Error(err)),
          // json:false 必须（默认 format json 吞自由文本）；提炼不需要长思考
          { endpoint: 'native', think: false, json: false, num_predict: 1500 });
      });
      const dims = parseDimensions(full);
      // ⚠️ 本地模型调用留痕（AI 请求日志）：每次用户原声提炼记录到 ai_request_logs（本地，不涉外发）
      try { await logLocalAICall({ request_type: 'voice_analyze', system_prompt: sys, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model }); } catch { /* 日志失败不阻断 */ }
      setLog(prev => [...prev, '  第 ' + (i + 1) + ' 块提炼出 ' + dims.length + ' 个维度']);
      results.push(dims);
      setRunning({ done: i + 1, total: blocks.length });
      await updateVoiceRunProgress(runId, i + 1);
    }
    const merged = mergeDimensions(results);
    await replaceVoiceDimensions(merged.map(m => ({ ...m, evidence: '', })), product);
    await finishVoiceRun(runId, 'done');
    setDims(await getVoiceDimensions(product));
    setRunning(null); setBusy(false);
    message.success('「' + product + '」分析完成：提炼出 ' + merged.length + ' 个特性维度（按用户关注度排序）');
  };

  return (
    <div>
      <div className="page-title"><MessageOutlined /> 用户原声分析{product ? <span style={{ fontSize: 13, color: '#0A84FF', marginLeft: 12 }}>（{product}）</span> : null}</div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <AutoComplete size="middle" value={product} style={{ width: 200 }} placeholder="选择/输入产品"
            options={products.map(p => ({ value: p }))} onChange={v => setProduct(String(v || '').trim())} allowClear
            onBlur={() => setProduct(String(product).trim())} />
          <Button type="primary" icon={<UploadOutlined />} loading={busy} onClick={() => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.xlsx,.xls'; input.onchange = (ev: any) => { const f = ev.target.files?.[0]; if (f) handleFile(f); }; input.click(); }}>导入用户原声（Excel）</Button>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>已导入 <b>{count}</b> 条原声</span>
          <Button icon={<PlayCircleOutlined />} type="primary" loading={busy} onClick={runAnalyze} disabled={running != null}>开始分析（自动分块）</Button>
          <Button danger icon={<DeleteOutlined />} disabled={busy} onClick={async () => { await clearVoiceItems(); await load(); setLog([]); message.success('已清空'); }}>清空</Button>
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, color: '#94A3B8', lineHeight: 1.6 }}>导入上一代产品的用户评价/口碑 Excel，本地模型自动分块（每块约 3000 字）逐块提炼用户最在意的特性维度，全部完成后自动汇总为「最有价值特性」权重榜——作为价值工程/新品特性的客观依据。</div>
        {running && (
          <div style={{ marginTop: 10 }}>
            <Progress percent={Math.round((running.done / running.total) * 100)} />
            <div style={{ fontSize: 12, color: '#475569' }}>正在分析 {running.done}/{running.total} 块...</div>
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
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>用户原声提炼 · 最有价值特性维度（{product}，按声量排序）</div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10, lineHeight: 1.6 }}>
            🔥 声量 = 提到该特性的用户数（<b>在乎的人多</b>），主导排序最靠前；💬 好评率 = 正面占比（做得好不好）；😡 负面多 = 待改进。类型：<b>🔥强卖点</b>（声量高口碑好）/ <b>⚠️待改进</b>（声量高吐槽多）/ <b>○次要</b>（声量低）。
          </div>
          <Table size="small" dataSource={dims} rowKey="id" pagination={{ pageSize: 10 }} columns={[
            { title: '特性维度', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
            { title: '🔥 声量', dataIndex: 'weight', width: 80, align: 'center', render: (v: number) => <b style={{ color: '#0A84FF', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{v}</b> },
            { title: '💬 好评率', key: 'q', width: 90, align: 'center', render: (_: any, r: any) => { const quality = r.count > 0 ? Math.round((r.positive / r.count) * 100) : 0; return <Tag color={quality >= 60 ? 'green' : quality >= 30 ? 'orange' : 'red'}>{quality}%</Tag>; } },
            { title: '👍 正面', dataIndex: 'positive', width: 70, align: 'center', render: (v: number) => <span style={{ color: '#10B981', fontWeight: 600 }}>{v}</span> },
            { title: '👎 负面', dataIndex: 'negative', width: 70, align: 'center', render: (v: number) => <span style={{ color: '#DC2626', fontWeight: 600 }}>{v}</span> },
            { title: '类型', key: 'kind', width: 90, align: 'center', render: (_: any, r: any) => { const q = r.count > 0 ? r.positive / r.count : 0; return r.count >= (dims[0]?.weight || 1) * 0.5 ? (q >= 0.5 ? <Tag color="red">🔥强卖点</Tag> : <Tag color="orange">⚠️待改进</Tag>) : <Tag color="default">○次要</Tag>; } },
            { title: '声量分布', key: 'bar', render: (_: any, r: any) => { const max = dims[0]?.weight || 1; return <div style={{ height: 10, background: '#F1F5F9', borderRadius: 5, overflow: 'hidden' }}><div style={{ width: Math.round((r.weight / max) * 100) + '%', height: '100%', background: 'linear-gradient(90deg,#0A84FF,#5E5CE6)' }} /></div>; } },
          ]} />
        </Card>
      )}
    </div>
  );
}
