import { useState } from 'react';
import { Button, Drawer, Tag } from 'antd';
import type { EvidenceRef } from '../../ai/contracts';

export default function EvidenceDrawer({ evidence }: { evidence: EvidenceRef[] }) {
  const [open, setOpen] = useState(false);
  if (!evidence.length) return null;
  const openRef = (item: EvidenceRef) => {
    const link = item.deepLink;
    if (!link) return;
    try { localStorage.setItem('costhub-open-project-pending', String(link.params.projectId || '')); } catch { }
    window.dispatchEvent(new CustomEvent('costhub-open-project', { detail: { pid: link.params.projectId } }));
  };
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)} aria-label={`查看依据，共 ${evidence.length} 条`} style={{ padding: 0, fontSize: 11 }}>查看依据（{evidence.length}）</Button>
      <Drawer title="数据依据" open={open} onClose={() => setOpen(false)} width={380}>
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>以下引用来自本次本地工具结果；推断和建议不替代人工决策。</div>
        {evidence.map((item, index) => (
          <div key={`${item.refType}-${item.refId}-${item.field}-${index}`} style={{ borderBottom: '1px solid #F1F5F9', padding: '10px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Tag color="blue" style={{ margin: 0 }}>{item.refType}</Tag>
              <b style={{ fontSize: 12 }}>{item.label}</b>
            </div>
            <div style={{ marginTop: 5, fontSize: 11.5, color: '#475569' }}>
              {item.field || '值'}：<span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(item.value ?? '—')}</span>
              {item.observedAt ? ` · ${item.observedAt.slice(0, 16)}` : ''}
            </div>
            {item.deepLink && <Button type="link" size="small" onClick={() => openRef(item)} style={{ padding: 0, marginTop: 4, fontSize: 11 }}>打开项目 →</Button>}
          </div>
        ))}
      </Drawer>
    </>
  );
}
