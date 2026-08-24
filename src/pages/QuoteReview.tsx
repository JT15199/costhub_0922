// AI 审价助手（v2.3.19，2026-08-18，大模型解锁新能力 #1）
// 贴供应商报价 → AI 逐项审价（合理/偏高/虚高 + 合理价 + 议价弹药），对照系统已有参考价 + 品类常识
import { useEffect, useState } from 'react';
import { Card, Button, Input, Table, Tag, message, Empty, Tooltip } from 'antd';
import { AuditOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { getParts, getAllPartSuppliers, getSetting } from '../db';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { buildQuoteReviewPrompt, parseQuoteReview, type QuoteReviewItem } from '../quoteReview';

const SAMPLE = '27寸液晶面板 | M270QAN | ¥610 | 1\n' +
  '主控板 | MNT-MAIN | ¥185 | 1\n' +
  '电源适配器 | 24V 3A | ¥42 | 1\n' +
  'Type-C 转接板 | TC01 | ¥28 | 1\n' +
  '外壳套件 | SHELL-27 | ¥95 | 1';

const VERDICT_TAG: Record<string, { color: string; text: string }> = {
  '虚高': { color: 'red', text: '❌ 虚高' },
  '偏高': { color: 'orange', text: '⚠️ 偏高' },
  '合理': { color: 'green', text: '✅ 合理' },
};

export default function QuoteReview() {
  const [quote, setQuote] = useState('');
  const [result, setResult] = useState<QuoteReviewItem[]>([]);
  const [refCount, setRefCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadRefCount = async () => {
    try { const parts = await getParts(); setRefCount(parts.length); } catch { }
  };
  useEffect(() => { loadRefCount(); }, []);

  const runReview = async () => {
    const q = quote.trim();
    if (!q) { message.warning('请先粘贴供应商报价'); return; }
    const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
    const model = await getSetting('local_ai_model', '');
    if (!model) { message.error('未配置本地模型（设置 → 连接设置）'); return; }
    setBusy(true); setErr(''); setResult([]);
    try {
      // 系统参考价上下文（器件库已有供应商报价）
      let context = '';
      try {
        const [parts, suppliers] = await Promise.all([getParts(), getAllPartSuppliers()]);
        const byPart: Record<number, string[]> = {};
        (suppliers || []).forEach((s: any) => { (byPart[s.part_id] = byPart[s.part_id] || []).push(s.supplier_name + ' ¥' + (Number(s.price) || 0)); });
        const lines: string[] = [];
        for (const p of parts.slice(0, 60)) {
          const sups = byPart[p.id] || [];
          if (sups.length > 0) lines.push(p.name + (p.model ? '(' + p.model + ')' : '') + '：' + sups.join('；'));
        }
        context = lines.slice(0, 60).join('\n');
      } catch { /* 参考价加载失败不阻断 */ }
      const { system, user } = buildQuoteReviewPrompt(q, context);
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
          t => { full += t; }, () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', think: false, json: false, num_predict: 16384 });
      });
      await logLocalAICall({ request_type: 'voice_analyze', system_prompt: system, user_prompt: user, response_summary: full.slice(0, 200), success: true, model_name: model });
      const items = parseQuoteReview(full);
      setResult(items);
      if (items.length === 0) setErr('AI 未识别出审价结果（模型输出：' + full.trim().replace(/\s+/g, ' ').slice(0, 120) + '），请重试或调整报价格式');
      else {
        const xu = items.filter(i => i.verdict === '虚高').length;
        const gao = items.filter(i => i.verdict === '偏高').length;
        message.success('审价完成：' + (xu + gao > 0 ? '发现 ' + xu + ' 项虚高、' + gao + ' 项偏高，可据此议价' : '全部价格合理'));
      }
    } catch (e: any) { setErr('审价失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const xu = result.filter(i => i.verdict === '虚高').length;
  const gao = result.filter(i => i.verdict === '偏高').length;

  return (
    <div>
      <div className="page-title"><AuditOutlined /> AI 审价助手</div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, color: '#94A3B8', lineHeight: 1.6, marginBottom: 10 }}>
          把供应商报价贴进来（每行一项，含 器件名/型号/单价 即可），AI 会对照「器件库已有参考价」（当前 {refCount} 种器件）+ 品类常识逐项审价：标出 虚高/偏高/合理，给出合理价区间和议价要点。判断仅供参考，最终以你的业务判断为准。
        </div>
        <Input.TextArea rows={7} value={quote} onChange={e => setQuote(e.target.value)} placeholder={'粘贴供应商报价，例如：\n' + SAMPLE} />
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button className="tappable" type="primary" icon={<ThunderboltOutlined />} loading={busy} onClick={runReview}>AI 审价</Button>
          <Button className="tappable" onClick={() => setQuote(SAMPLE)}>填入示例</Button>
        </div>
      </Card>

      {err && <Card size="small" style={{ marginBottom: 12 }}><div style={{ color: '#DC2626', fontSize: 12 }}>{err}</div></Card>}

      {result.length > 0 && (
        <Card size="small">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <b style={{ fontSize: 12.5 }}>审价结果</b>
            {xu > 0 && <Tag color="red">❌ {xu} 虚高</Tag>}
            {gao > 0 && <Tag color="orange">⚠️ {gao} 偏高</Tag>}
            {result.length - xu - gao > 0 && <Tag color="green">✅ {result.length - xu - gao} 合理</Tag>}
            <span style={{ fontSize: 11, color: '#94A3B8' }}>共 {result.length} 项</span>
          </div>
          <Table size="small" dataSource={result} rowKey="index" pagination={false} columns={[
            { title: '#', dataIndex: 'index', width: 44, align: 'center' },
            { title: '项目', dataIndex: 'item', render: (v: string) => <b>{v}</b> },
            { title: '判定', dataIndex: 'verdict', width: 80, align: 'center', render: (v: string) => <Tag color={VERDICT_TAG[v]?.color || 'default'}>{VERDICT_TAG[v]?.text || v}</Tag> },
            { title: '合理价', dataIndex: 'fair_price', width: 120, render: (v: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v || '—'}</span> },
            { title: '依据', dataIndex: 'reason', render: (v: string) => <span style={{ fontSize: 11.5, color: '#475569' }}>{v || '—'}</span> },
            { title: '议价要点', dataIndex: 'negotiate', width: 200, render: (v: string) => <Tooltip title={v}><span style={{ fontSize: 11.5, color: '#0A84FF' }}>{v || '—'}</span></Tooltip> },
          ]} />
        </Card>
      )}

      {result.length === 0 && !err && !busy && (
        <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="粘贴报价后点「AI 审价」，结果在这里逐项列出" /></Card>
      )}
    </div>
  );
}
