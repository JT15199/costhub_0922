// 云端洞察待确认横幅（v2.3.19 重构：非打断式，2026-08-17）
// 背景：原来 preview 模式在自动洞察时直接弹 antd Modal.confirm，用户反馈"弹窗自己弹、不知从哪看"
// 方案：待确认队列（cloudConfirm.tsx）+ 底部固定横幅（App 级挂载，任何页面可见）：
//   有待确认 → 「🔐 N 个关键物料洞察等待云端发送确认 · 查看确认」
//   点击打开 Modal 列表（物料/品类/问题 + 确认发送/跳过），底部 全部确认 / 全部跳过
//   确认 → dispatch costhub-insight-request（App 监听 → scheduleAppInsight 继续自动洞察）
import { useEffect, useState } from 'react';
import { Modal, Button, Tag } from 'antd';
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import {
  getPendingConfirms, confirmPending, skipPending, confirmAllPending, skipAllPending,
  type PendingConfirm,
} from '../cloudConfirm';

export default function CloudConfirmBar() {
  const [pending, setPending] = useState<PendingConfirm[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const refresh = () => setPending(getPendingConfirms());
    refresh();
    window.addEventListener('costhub-cloud-pending', refresh);
    return () => window.removeEventListener('costhub-cloud-pending', refresh);
  }, []);

  useEffect(() => {
    if (pending.length === 0) setOpen(false); // 全部处理完自动关闭
  }, [pending.length]);

  if (pending.length === 0) return null;

  const fireInsightRequest = () => window.dispatchEvent(new CustomEvent('costhub-insight-request'));
  const onConfirm = (id: string) => { confirmPending(id); fireInsightRequest(); };
  const onSkip = (id: string) => { skipPending(id); };
  const onConfirmAll = () => { confirmAllPending(); fireInsightRequest(); setOpen(false); };
  const onSkipAll = () => { skipAllPending(); setOpen(false); };

  return (
    <>
      {/* 底部固定横幅：不打断当前操作，随时可见可点 */}
      <div
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 1100,
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none',
          background: 'linear-gradient(135deg, #FFF7E6, #FFFBEB)', border: '1px solid #FFD591',
          borderRadius: 12, padding: '8px 14px', boxShadow: '0 6px 20px rgba(212,107,8,0.18)',
          fontSize: 12.5, color: '#874D00',
        }}
        title="自动洞察触发了待确认的云端发送，点击查看"
      >
        <LockOutlined style={{ color: '#D46B08' }} />
        <span><b>{pending.length} 个关键物料洞察</b> 等待云端发送确认</span>
        <span style={{ background: '#D46B08', color: '#fff', borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>查看确认</span>
      </div>

      <Modal
        title={<span><LockOutlined style={{ color: '#D46B08', marginRight: 8 }} />云端洞察发送确认</span>}
        open={open}
        onCancel={() => setOpen(false)}
        width={680}
        footer={[
          <Button key="skip" onClick={onSkipAll}>全部跳过</Button>,
          <Button key="ok" type="primary" icon={<SafetyCertificateOutlined />} onClick={onConfirmAll}>全部确认发送</Button>,
        ]}
      >
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#FFF7E6', border: '1px solid #FFE7BA', borderRadius: 8, fontSize: 12, color: '#B45309' }}>
          以下洞察将发送云端搜索分析。安全边界：<b>仅发送物料通用名与品类</b>（已脱敏），本地成本/供应商/项目数据不会外传。
          确认后立即执行自动洞察；「跳过」则该物料本次会话不再询问。
        </div>
        {pending.map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid #F0F0F0', borderRadius: 10, marginBottom: 8, background: 'var(--color-surface, #fff)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 13.5 }}>{p.material}</b>
                {p.category && <Tag color="blue" style={{ margin: 0 }}>{p.category}</Tag>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>排队于 {p.addedAt}</span>
              </div>
              <div style={{ fontSize: 12, color: '#6E6E73', marginTop: 3 }}>{p.question}</div>
            </div>
            <Button size="small" type="primary" onClick={() => onConfirm(p.id)}>确认发送</Button>
            <Button size="small" onClick={() => onSkip(p.id)}>跳过</Button>
          </div>
        ))}
        <div style={{ marginTop: 10, fontSize: 11.5, color: '#94A3B8' }}>
          确认方式可在「设置 → AI 服务 → 发送前确认」改为「自动脱敏发送」（不排队、直接发送）。
        </div>
      </Modal>
    </>
  );
}
