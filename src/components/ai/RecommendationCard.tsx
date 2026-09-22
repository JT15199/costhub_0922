import { useState } from 'react';
import { Button, Card, Input, InputNumber, Modal, Tag } from 'antd';
import type { AiRecommendation } from '../../ai/contracts';
import EvidenceDrawer from './EvidenceDrawer';
import DataGapCard from './DataGapCard';

const confidenceLabel = { high: '高置信', medium: '中置信', low: '低置信' } as const;

export default function RecommendationCard({
  recommendation,
  onUseful,
  onNotUseful,
  onAdopt,
  onTodo,
  onOpen,
  onResult,
}: {
  recommendation: AiRecommendation;
  onUseful: () => void;
  onNotUseful: () => void;
  onAdopt: () => void;
  onTodo: () => void;
  onOpen: () => void;
  onResult: (input: { actualSaving?: number; actualResult?: string; note?: string }) => Promise<void> | void;
}) {
  const r = recommendation;
  const [resultOpen, setResultOpen] = useState(false);
  const [actualSaving, setActualSaving] = useState<number | null>(null);
  const [actualResult, setActualResult] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const saveResult = async () => {
    setSaving(true);
    try { await onResult({ actualSaving: actualSaving ?? undefined, actualResult, note }); setResultOpen(false); setActualSaving(null); setActualResult(''); setNote(''); }
    finally { setSaving(false); }
  };
  return (
    <>
      <Card size="small" style={{ marginBottom: 8, borderColor: '#DDD6FE' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{r.title}</b>
        <Tag color={r.confidence === 'high' ? 'green' : r.confidence === 'medium' ? 'blue' : 'orange'} style={{ margin: 0 }}>{confidenceLabel[r.confidence]}</Tag>
        {r.status && r.status !== 'open' && <Tag style={{ margin: 0 }}>{r.status === 'useful' ? '有用' : r.status === 'not_useful' ? '无用' : r.status === 'adopted' ? '已采纳' : r.status === 'done' ? '已完成' : '已忽略'}</Tag>}
      </div>
      <div style={{ marginTop: 6, color: '#334155', fontSize: 12, lineHeight: 1.6 }}><b>结论：</b>{r.conclusion}</div>
      {r.expectedImpact && <div style={{ marginTop: 4, color: '#166534', fontSize: 11.5 }}>预计影响：¥{r.expectedImpact.min.toFixed(2)} ~ ¥{r.expectedImpact.max.toFixed(2)}</div>}
      {r.assumptions.length > 0 && <div style={{ marginTop: 4, color: '#64748B', fontSize: 11.5 }}>假设：{r.assumptions.join('；')}</div>}
      {r.risks.length > 0 && <div style={{ marginTop: 4, color: '#92400E', fontSize: 11.5 }}>风险：{r.risks.join('；')}</div>}
      <DataGapCard gaps={r.dataGaps} />
      <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <EvidenceDrawer evidence={r.evidence} />
        <Button size="small" onClick={onOpen}>{r.action.type === 'open' ? r.action.label : '打开项目'}</Button>
        <Button size="small" onClick={onTodo}>转待办</Button>
        <Button size="small" type="primary" onClick={onAdopt}>已采纳</Button>
        <Button size="small" onClick={() => setResultOpen(true)}>记录结果</Button>
        <Button size="small" onClick={onUseful}>有用</Button>
        <Button size="small" onClick={onNotUseful}>无用</Button>
      </div>
      </Card>
      <Modal title="记录建议实际结果" open={resultOpen} onCancel={() => setResultOpen(false)} onOk={() => void saveResult()} confirmLoading={saving} okText="保存结果" cancelText="取消">
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>用于复盘建议是否真正有效；不会自动修改 BOM 或成本数据。</div>
        <div style={{ marginBottom: 8, fontSize: 12 }}>实际节省金额（元，可选）</div>
        <InputNumber min={0} precision={2} value={actualSaving ?? undefined} onChange={value => setActualSaving(value == null ? null : Number(value))} style={{ width: '100%', marginBottom: 12 }} aria-label="实际节省金额" />
        <div style={{ marginBottom: 8, fontSize: 12 }}>执行结果</div>
        <Input.TextArea rows={3} value={actualResult} onChange={event => setActualResult(event.target.value)} placeholder="例如：已完成二供导入，最终价格下降……" aria-label="建议执行结果" />
        <div style={{ margin: '12px 0 8px', fontSize: 12 }}>备注</div>
        <Input.TextArea rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="可选" aria-label="建议结果备注" />
      </Modal>
    </>
  );
}
