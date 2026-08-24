// DSH 式运行轨迹时间线（v2.3.19，2026-08-18 用户：每次发什么prompt→调什么工具→生成什么结果→又发什么prompt，卡片串起来更清晰）
// 步骤：📤发送给模型 → 🔧工具调用(参数+结果) / 🔐云端 → 📤回填继续 → … → 📌结论
import { useState } from 'react';
import { SendOutlined, ToolOutlined, CloudOutlined, BulbOutlined } from '@ant-design/icons';

export interface TraceStep {
  type: 'prompt' | 'tool' | 'cloud' | 'conclusion';
  title: string;      // 卡片标题
  content: string;    // 内容（展示层截断，可展开）
  meta?: string;      // 如工具参数
  color: string;
  icon: any;
}

const STEP_STYLE: Record<string, { color: string; bg: string; border: string; icon: any }> = {
  prompt: { color: '#0A84FF', bg: '#F0F7FF', border: '#BFDBFE', icon: <SendOutlined /> },
  tool: { color: '#6366F1', bg: '#F5F5FF', border: '#C7D2FE', icon: <ToolOutlined /> },
  cloud: { color: '#8B5CF6', bg: '#FAF5FF', border: '#D8B4FE', icon: <CloudOutlined /> },
  conclusion: { color: '#7C3AED', bg: '#F7F3FF', border: '#DDD6FE', icon: <BulbOutlined /> },
};

function truncate(s: string, n: number): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export default function TraceTimeline({ steps }: { steps: TraceStep[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  if (!steps || steps.length === 0) return null;
  const toggle = (i: number) => setExpanded(prev => { const s = new Set(prev); if (s.has(i)) s.delete(i); else s.add(i); return s; });
  return (
    <div style={{ position: 'relative', padding: '4px 0 4px 22px' }}>
      {/* 中间连接线 */}
      <div style={{ position: 'absolute', left: 7, top: 16, bottom: 16, width: 2, background: '#E5E9F0', borderRadius: 2 }} />
      {steps.map((s, i) => {
        const st = STEP_STYLE[s.type] || STEP_STYLE.prompt;
        const isExp = expanded.has(i);
        const body = isExp ? s.content : truncate(s.content, 160);
        return (
          <div key={i} style={{ position: 'relative', marginBottom: 8 }}>
            {/* 节点圆点 */}
            <div style={{ position: 'absolute', left: -21, top: 12, width: 10, height: 10, borderRadius: '50%', background: st.color, border: '2px solid #fff', boxShadow: '0 0 0 1.5px ' + st.color + '55' }} />
            <div className="pop-in" style={{ border: '1px solid ' + st.border, borderRadius: 10, padding: '7px 10px', background: st.bg, cursor: s.content.length > 160 ? 'pointer' : 'default' }} onClick={() => s.content.length > 160 && toggle(i)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: st.color, fontWeight: 600 }}>
                <span style={{ fontSize: 12 }}>{st.icon}</span>
                {s.title}
                {s.meta && <span style={{ fontWeight: 400, color: '#64748B', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{s.meta}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 10, color: '#B0B7C3' }}>{s.type === 'prompt' ? '→ 发给模型' : s.type === 'tool' ? '工具' : s.type === 'cloud' ? '云端' : '结论'}</span>
              </div>
              <div style={{ fontSize: 11.5, color: '#334155', lineHeight: 1.6, marginTop: 3, whiteSpace: 'pre-wrap' }}>{body}</div>
              {s.content.length > 160 && <div style={{ fontSize: 10.5, color: st.color, marginTop: 2 }}>{isExp ? '收起 ▲' : '展开 ▼'}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
