// AI 工作状态条（v2.3.19，2026-08-16）：打开应用就能看到"本地 AI 在工作"
// 三态：连接中（呼吸）→ 已连接（绿点+模型名）→ 未连接（灰点/未配置）
// 监听 costhub-ai-task 事件（{task, done}）实时显示当前任务与最近完成记录；30 秒自检保持状态新鲜
import { useEffect, useState } from 'react';
import { detectOllama, type OllamaStatus } from '../aiStatus';
import { EmojiIcon } from '../iconMap';

const STATUS_TEXT: Record<string, { dot: string; color: string; text: string }> = {
  ok: { dot: '#22C55E', color: '#16A34A', text: '本地 AI 已连接' },
  offline: { dot: '#9CA3AF', color: '#6B7280', text: '本地 AI 未连接（Ollama 离线）' },
  'no-model': { dot: '#F59E0B', color: '#D97706', text: '本地 AI 未配置模型' },
  error: { dot: '#EF4444', color: '#DC2626', text: '本地 AI 探测失败' },
};

export default function AIStatusBar({ onNavigate, compact }: { onNavigate?: (page: string) => void; compact?: boolean }) {
  const [st, setSt] = useState<OllamaStatus | null>(null);
  const [task, setTask] = useState('');
  const [lastDone, setLastDone] = useState('');
  const [lastAt, setLastAt] = useState('');

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      const s = await detectOllama();
      if (alive) setSt(s);
    };
    probe();
    const iv = setInterval(probe, 30 * 1000);
    const onTask = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as { task?: string; done?: boolean };
      if (d.done) {
        setLastDone(d.task || '任务');
        setLastAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        setTask('');
      } else if (d.task) {
        setTask(d.task);
      }
    };
    window.addEventListener('costhub-ai-task', onTask);
    return () => { alive = false; clearInterval(iv); window.removeEventListener('costhub-ai-task', onTask); };
  }, []);

  const s = st ? STATUS_TEXT[st.reason] : null;
  return (
    <div
      onClick={() => onNavigate?.('localAI')}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: compact ? 0 : 14,
        padding: compact ? '6px 0' : '8px 14px',
        borderRadius: compact ? 0 : 10,
        background: compact ? 'transparent' : 'var(--color-surface)',
        border: compact ? 'none' : '1px solid var(--color-border)',
        cursor: 'pointer', flexWrap: 'wrap',
      }}
      title={st?.connected ? `模型：${st.model} · ${st.baseUrl}` : '点击打开本地 AI 助手'}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: s?.color || '#6B7280' }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: st === null ? '#9CA3AF' : s?.dot || '#9CA3AF',
            animation: st === null ? 'ai-status-pulse 1.2s ease-in-out infinite' : undefined,
            boxShadow: st?.connected ? `0 0 6px ${s?.dot}` : undefined,
            flexShrink: 0,
          }}
        />
        <b>{s ? s.text : '正在连接本地 AI…'}</b>
        {st?.connected && <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>{st.model}</span>}
        {!st?.connected && st && <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>点击去配置 →</span>}
      </span>

      {task && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#2563EB' }}>
          <EmojiIcon e="🤖" />
          {task}
          <span className="ai-breathe" style={{ display: 'inline-block', width: 14, textAlign: 'center', fontSize: 11 }}>●</span>
        </span>
      )}
      {!task && lastDone && (
        <span style={{ fontSize: 11.5, color: '#94A3B8' }}>
          <EmojiIcon e="✓" /> 刚刚完成{lastDone} · {lastAt}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: '#94A3B8' }}>
        <EmojiIcon e="🔒" /> 数据只在本机处理
      </span>
    </div>
  );
}
