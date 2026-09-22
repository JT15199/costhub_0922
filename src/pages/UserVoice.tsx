// 用户原声分析（v2.3.19，2026-08-18）：Excel 导入 → 自动分块 → 本地模型逐块提炼 → 汇总最有价值特性维度
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Table, Tag, Progress, message, Empty, AutoComplete } from 'antd';
import { UploadOutlined, PlayCircleOutlined, DeleteOutlined, MessageOutlined, DownloadOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { addVoiceItem, clearVoiceItems, getAllVoiceItems, getVoiceDimensions, getVoiceProducts, getProjects, getRunningVoiceRun } from '../db';
import SellingPointPanel from '../components/SellingPointPanel';
import { downloadVoiceTemplate } from '../excelTemplates';
import { detectVoiceSheet } from '../voiceImport';
import { analyzeVoiceProduct } from '../voiceAnalysis';

export default function UserVoice() {
  const [count, setCount] = useState(0);
  const [dims, setDims] = useState<any[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState('');
  const [products, setProducts] = useState<string[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [sample, setSample] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => { const seq = ++loadSeq.current; const projectId = Number(projects.find((item: any) => item.code === product)?.id || 0); const [items, dimensions, productRows, rr] = await Promise.all([getAllVoiceItems(product, projectId), getVoiceDimensions(product, projectId), getVoiceProducts(), getRunningVoiceRun(product, projectId)]); if (seq !== loadSeq.current) return; setCount(items.length); setSample(items.slice(0, 5).map((i: any) => String(i.content || '').slice(0, 60))); setDims(dimensions); setProducts(productRows.map((p: any) => p.product)); if (rr) setLog(prev => [...prev, '⚠️ 检测到上次「' + (product || '未选产品') + '」的分析未完成，可从第 ' + (Number(rr.done_chunks || 0) + 1) + ' 块继续']); }, [product, projects]);
  useEffect(() => { void load(); }, [load]);
  // AI 数据工程联动：切回页面自动刷新（BOM/报价/原声等写库后可见）
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.page === 'userVoice') void load(); };
    window.addEventListener('app-page-active', h);
    return () => window.removeEventListener('app-page-active', h);
  }, [load]);
  useEffect(() => { (async () => { try { setProjects(await getProjects('', '', '')); } catch { } })(); }, []);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
        const detected = detectVoiceSheet(wb.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, defval: '' }) })));
        if (!detected.contents.length) { message.warning('未识别到评论文本列，请检查表头或下载模板'); return; }
        let added = 0, skipped = 0;
        const selectedProjectId = Number(projects.find((item: any) => item.code === product)?.id || 0);
        for (const content of detected.contents) { const id = await addVoiceItem(content, file.name, product, selectedProjectId); if (id > 0) added++; else skipped++; }
        const items = await getAllVoiceItems(product, selectedProjectId);
        const total = items.length;
        setCount(total); setSample(items.slice(0, 5).map((i: any) => String(i.content || '').slice(0, 60))); setProducts((await getVoiceProducts()).map((p: any) => p.product));
        message.success('「' + (product || '未选产品') + '」导入完成：新增 ' + added + ' 条' + (skipped > 0 ? '，跳过 ' + skipped + ' 条重复' : '') + '（' + detected.sheetName + '，该产品共 ' + total + ' 条）');
      } catch (err: any) { message.error('Excel 解析失败：' + (err?.message || err)); }
    };
    reader.readAsBinaryString(file);
    return false;
  };

  const runAnalyze = async () => {
    if (busy) { abortRef.current?.abort(); return; }
    if (!product) { message.warning('请先选择产品（顶部）'); return; }
    setBusy(true); setRunning(null); setLog(['正在检查本地模型连接并恢复未完成分析…']);
    const controller = new AbortController(); abortRef.current = controller;
    const selectedProject = projects.find(item => item.code === product);
    try {
      await analyzeVoiceProduct(product, Number(selectedProject?.id || 0), msg => {
        setLog(prev => [...prev, msg]);
        const match = msg.match(/第 (\d+)\/(\d+) 块/);
        if (match) setRunning({ done: Math.max(0, Number(match[1]) - 1), total: Number(match[2]) });
      }, controller.signal);
      await load();
      message.success('「' + product + '」原声分析完成，主题、原句证据和人工决策状态已保留');
    } catch (error: any) {
      const detail = String(error?.message || error);
      if (controller.signal.aborted) message.info('分析已暂停，可再次点击继续');
      else message.error(detail);
      setLog(prev => [...prev, '✖ ' + detail]);
    } finally {
      abortRef.current = null; setBusy(false); setRunning(null);
    }
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
          <Button icon={<DownloadOutlined />} onClick={downloadVoiceTemplate}>模板</Button>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>已导入 <b>{count}</b> 条原声</span>
          <Button icon={<PlayCircleOutlined />} type={busy ? 'default' : 'primary'} danger={busy} loading={false} onClick={runAnalyze} disabled={!busy && !product}>{busy ? '停止分析' : '开始分析（自动分块）'}</Button>
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
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>用户原声提炼 · 最有价值特性维度（{product}，按声量排序）<span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400 }}> 点击行展开查看依据原声</span></div>
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
