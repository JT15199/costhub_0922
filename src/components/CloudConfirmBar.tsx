import { useEffect, useState } from 'react';
import { Button, Modal } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { getApprovalHistory, getPendingConfirms, type PendingConfirm } from '../cloudConfirm';
import CloudApprovalCards from './CloudApprovalCards';

/** 独立待审批入口：全局只提示数量，点开后在一个独立窗口内逐条处理，不把后台队列塞进当前对话。 */
export default function CloudConfirmBar() {
  const [pending, setPending] = useState<PendingConfirm[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const refresh = () => setPending(getPendingConfirms());
    refresh();
    window.addEventListener('costhub-cloud-pending', refresh);
    return () => window.removeEventListener('costhub-cloud-pending', refresh);
  }, []);
  useEffect(() => { if (!pending.length && open) setOpen(false); }, [pending.length, open]);
  if (!pending.length) return null;
  const softCount = pending.filter(item => item.riskLevel === 'soft').length;
  const hardCount = pending.filter(item => item.riskLevel === 'hard').length;
  const current = pending.find(item => item.sessionId);
  const locate = () => {
    if (current) {
      window.dispatchEvent(new CustomEvent('costhub-open-cloud-approval', { detail: { id: current.id, sessionId: current.sessionId, runId: current.runId } }));
    } else {
      setOpen(true);
    }
  };
  return <>
    <div className={`ai-cloud-notification${hardCount ? ' is-risk' : ''}`} role="status">
      <LockOutlined aria-hidden="true" />
      <span>
        <b>{pending.length} 个待审批请求</b>
        {hardCount > 0 && <em className="is-hard"> · {hardCount} 个含本地业务信息需改名</em>}
        {softCount > 0 && <em className="is-soft"> · {softCount} 个需你确认</em>}
        {' '}· 会话内请求可定位到原对话，后台请求在这里单独处理
      </span>
      <Button size="small" onClick={locate}>查看并审批</Button>
      <Button size="small" type="text" onClick={() => setOpen(true)}>全部待审批</Button>
    </div>
    <Modal title="云端待审批中心" open={open} onCancel={() => setOpen(false)} footer={null} width={720} destroyOnHidden>
      <CloudApprovalCards showAll />
      {getApprovalHistory(20).length > 0 && <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>审批历史（只读）</summary>
        <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
          {getApprovalHistory(20).map(entry => <div key={entry.eventId} style={{ fontSize: 11, color: 'var(--color-text-secondary,#64748b)' }}>
            {entry.at} · {entry.material} · {entry.scopeLevel || 'C1'} · <b>{entry.status === 'approved' ? '已批准' : entry.status === 'rejected' ? '本次拒绝' : entry.status === 'ignored_30d' ? '30 天忽略' : entry.status === 'expired' ? '已过期' : '已取消'}</b>
          </div>)}
        </div>
      </details>}
    </Modal>
  </>;
}
