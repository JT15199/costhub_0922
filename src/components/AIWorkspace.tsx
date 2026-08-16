// AI 工作台（2026-08-16）：AI 状态条 + 今日速览合并为一张卡，减少驾驶舱顶部卡片数量（解决"信息杂乱"）
import AIStatusBar from './AIStatusBar';
import DailyBrief from './DailyBrief';

export default function AIWorkspace({ onNavigate }: { onNavigate?: (page: string) => void }) {
  return (
    <div style={{
      marginBottom: 14,
      borderRadius: 12,
      padding: '10px 16px 12px',
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
    }}>
      <AIStatusBar onNavigate={onNavigate} compact />
      <div style={{ borderTop: '1px dashed var(--color-border)', marginTop: 6 }} />
      <DailyBrief onNavigate={onNavigate} compact />
    </div>
  );
}
