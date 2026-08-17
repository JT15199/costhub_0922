// AI 自主分析面板（v2.3.19，2026-08-17 用户核心需求：后台自发自主分析，过程实时呈现，DSH 式）
// · 实时区：进行中的一轮（💭 思考流 / 🔧 工具卡 / 🔐 云端申请 / 📌 结论），事件驱动流式更新
// · 时间线：ai_think_logs 历史记录（可展开看完整思考过程与依据）
// · 现有后台引擎（比价/巡检/洞察）是其自主思考的一部分：状态汇总在顶部展示
import { useEffect, useState } from 'react';
import { Button, Tag, Spin, Tooltip } from 'antd';
import { RobotOutlined, ThunderboltOutlined, ExperimentOutlined } from '@ant-design/icons';
import { getThinkLogs, type ThinkLog } from '../db/think';
import { getInsights } from '../db';
import { getAdvisorInsights } from '../db/advisor';
import { getQuickTrendItems } from '../db/trend';
import { cleanProtocolText } from '../thinkEngine';

interface LiveState {
  status: 'running' | 'done' | 'error';
  thoughts: string;
  tools: { name: string; args: any; ok: boolean; text: string }[];
  clouds: { material: string; ok: boolean; result: string }[];
  answer: string;
  error?: string;
  skipped?: string;
}

export default function AutoThinkPanel({ mode = 'summary', onNavigate }: { mode?: 'summary' | 'full' | 'inline'; onNavigate?: (page: string) => void }) {
  const full = mode === 'full';
  const inline = mode === 'inline';
  const [logs, setLogs] = useState<ThinkLog[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState({ insights: 0, advisor: 0, trends: 0 });

  const refreshLogs = async () => {
    try { setLogs(await getThinkLogs(15)); } catch { /* 忽略 */ }
  };
  const refreshEngine = async () => {
    try {
      const ins = await getInsights();
      const adv = await getAdvisorInsights('open');
      const tr = await getQuickTrendItems();
      setEngine({ insights: ins.filter((i: any) => i.status === 'unread').length, advisor: adv.length, trends: tr.length });
    } catch { /* 忽略 */ }
  };

  useEffect(() => {
    refreshLogs(); refreshEngine();
    // App 调度（后台自发）的事件 → 实时渲染
    const onEv = (e: Event) => {
      const ev = ((e as CustomEvent).detail || {}) as any;
      if (ev.kind === 'start') {
        setLive({ status: 'running', thoughts: '', tools: [], clouds: [], answer: '' });
      } else if (ev.kind === 'thought') {
        setLive(prev => prev ? { ...prev, thoughts: prev.thoughts + ev.text } : prev);
      } else if (ev.kind === 'tool') {
        setLive(prev => prev ? { ...prev, tools: [...prev.tools, { name: ev.name, args: ev.args, ok: ev.ok, text: ev.text }] } : prev);
      } else if (ev.kind === 'cloud_request') {
        setLive(prev => prev ? { ...prev, clouds: [...prev.clouds, { material: ev.call?.material_name || '?', ok: false, result: '等待审批…' }] } : prev);
      } else if (ev.kind === 'cloud') {
        setLive(prev => prev ? { ...prev, clouds: [...prev.clouds, { material: ev.call?.material_name || '?', ok: ev.ok, result: ev.result || '' }] } : prev);
      } else if (ev.kind === 'answer') {
        setLive(prev => prev ? { ...prev, answer: prev.answer + ev.text } : prev);
      } else if (ev.kind === 'done') {
        setLive(prev => prev ? { ...prev, status: 'done', answer: prev.answer || ev.conclusion || '' } : { status: 'done', thoughts: '', tools: [], clouds: [], answer: ev.conclusion || '' });
        refreshLogs(); refreshEngine();
      } else if (ev.kind === 'skipped') {
        setLive({ status: 'done', thoughts: '', tools: [], clouds: [], answer: '', skipped: ev.reason || '数据无变化' });
      } else if (ev.kind === 'error') {
        setLive(prev => prev ? { ...prev, status: 'error', error: ev.error } : prev);
      }
    };
    window.addEventListener('costhub-think-event', onEv);
    return () => window.removeEventListener('costhub-think-event', onEv);
  }, []);

  // 手动触发一轮（与 App 调度共享防重入：autoThink 内部兜底）
  const runNow = async () => {
    if (busy) return;
    setBusy(true);
    setLive({ status: 'running', thoughts: '', tools: [], clouds: [], answer: '' });
    const { runAutoThink } = await import('../autoThink');
    await runAutoThink({ force: true, onEvent: (ev) => {
      if (ev.kind === 'thought') setLive(prev => prev ? { ...prev, thoughts: prev.thoughts + ev.text } : prev);
      else if (ev.kind === 'tool') setLive(prev => prev ? { ...prev, tools: [...prev.tools, { name: ev.name, args: ev.args, ok: ev.ok, text: ev.text }] } : prev);
      else if (ev.kind === 'cloud_request') setLive(prev => prev ? { ...prev, clouds: [...prev.clouds, { material: ev.call?.material_name || '?', ok: false, result: '等待审批…' }] } : prev);
      else if (ev.kind === 'cloud') setLive(prev => prev ? { ...prev, clouds: [...prev.clouds, { material: ev.call?.material_name || '?', ok: ev.ok, result: ev.result || '' }] } : prev);
      else if (ev.kind === 'answer') setLive(prev => prev ? { ...prev, answer: prev.answer + ev.text } : prev);
      else if (ev.kind === 'done') { setLive(prev => prev ? { ...prev, status: 'done', answer: prev.answer || ev.conclusion || '' } : prev); refreshLogs(); refreshEngine(); }
      else if (ev.kind === 'skipped') setLive({ status: 'done', thoughts: '', tools: [], clouds: [], answer: '', skipped: ev.reason || '数据无变化' });
      else if (ev.kind === 'error') setLive(prev => prev ? { ...prev, status: 'error', error: ev.error } : prev);
    } });
    setBusy(false);
  };

  // inline：嵌入 AI 洞察建议卡（合并自主分析结论，无外壳/无按钮/无引擎汇总）
  if (inline) {
    return (
      <div style={{ marginBottom: 10 }}>
        {live && (
          <div style={{ fontSize: 12, color: live.status === 'error' ? '#DC2626' : '#7C3AED', padding: '2px 0 6px' }}>
            {live.status === 'running' ? <span><Spin size="small" /> 🧠 AI 正在自主分析…</span>
              : live.skipped ? '⏭ ' + live.skipped
              : live.status === 'error' ? '本轮分析失败：' + live.error
              : cleanProtocolText(live.answer) ? '✓ ' + cleanProtocolText(live.answer).slice(0, 90) + (cleanProtocolText(live.answer).length > 90 ? '…' : '')
              : '✓ 本轮分析完成'}
          </div>
        )}
        {logs.length === 0 ? (
          <div style={{ fontSize: 12, color: '#94A3B8', padding: '2px 0 6px' }}>暂无自主分析记录——AI 后台自发分析后结论会出现在这里</div>
        ) : logs.slice(0, 3).map((l, i) => (
          <div key={l.id ?? i} style={{ border: '1px solid #E9D5FF', borderRadius: 8, padding: '7px 10px', marginBottom: 6, background: '#FCFAFF' }}
            title={l.conclusion || l.thoughts || ''}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Tag color={l.status === 'done' ? 'green' : l.status === 'error' ? 'red' : 'processing'} style={{ margin: 0, fontSize: 10 }}>{l.status === 'done' ? '✓' : l.status === 'error' ? '✗' : '…'}</Tag>
              <b style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.topic || '自主分析'}</b>
              <span style={{ fontSize: 10.5, color: '#94A3B8', flexShrink: 0 }}>{(l.started_at || l.finished_at || '').slice(5, 16)}</span>
            </div>
            {l.conclusion && <div style={{ fontSize: 11.5, color: '#6D28D9', lineHeight: 1.55, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{l.conclusion}</div>}
          </div>
        ))}
        {logs.length > 3 && <a style={{ fontSize: 11.5, color: '#0A84FF' }} onClick={() => onNavigate?.('localAI')}>查看全部（完整思考过程见「本地 AI 助手 → 🧠 自主分析」）→</a>}
      </div>
    );
  }

  return (
    <div className="content-card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <h3><ExperimentOutlined style={{ color: '#7C3AED' }} /> AI 自主分析</h3>
        <span style={{ fontSize: 12, color: '#94A3B8' }}>
          {full ? 'AI 后台自发分析你的数据（每 15 分钟一轮 + 数据变化后触发）——完整思考过程实时呈现' : 'AI 后台自发分析的关键结论（完整过程见「本地 AI 助手 → 🧠 自主分析」）'}
          <Button size="small" style={{ marginLeft: 10 }} icon={<ThunderboltOutlined />} loading={busy} onClick={runNow}>现在分析一轮</Button>
        </span>
      </div>
      {/* 现有后台引擎（比价/巡检/洞察）——AI 自主工作的一部分 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <Tag icon={<RobotOutlined />} color="blue" style={{ margin: 0, fontSize: 11.5 }}>报价情报：{engine.insights} 条待处理</Tag>
        <Tag icon={<RobotOutlined />} color="orange" style={{ margin: 0, fontSize: 11.5 }}>自主建议：{engine.advisor} 条待处理</Tag>
        <Tag icon={<RobotOutlined />} color="purple" style={{ margin: 0, fontSize: 11.5 }}>物料洞察：{engine.trends} 类已追踪</Tag>
      </div>
      {/* 实时区：进行中的一轮（summary 只显示状态行，full 显示完整过程） */}
      {live && !full && (
        <div style={{ fontSize: 12, color: live.status === 'error' ? '#DC2626' : '#7C3AED', padding: '6px 2px', marginBottom: 8 }}>
          {live.status === 'running' ? <span><Spin size="small" /> 🧠 AI 正在自主分析…（见「本地 AI 助手 → 🧠 自主分析」查看过程）</span>
            : live.skipped ? '⏭ ' + live.skipped
            : live.status === 'error' ? '本轮分析失败：' + live.error
            : '✓ 本轮分析完成' + (live.answer ? '：' + cleanProtocolText(live.answer).slice(0, 120) + (cleanProtocolText(live.answer).length > 120 ? '…' : '') : '')}
        </div>
      )}
      {live && full && (
        <div style={{ border: '1px solid #DDD6FE', borderRadius: 10, padding: '10px 14px', marginBottom: 10, background: 'linear-gradient(180deg, #F5F3FF, #FFFFFF)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <b style={{ fontSize: 12.5 }}>🧠 本轮自主分析</b>
            {live.status === 'running' && <Tag color="processing" style={{ margin: 0 }}><Spin size="small" /> 思考中</Tag>}
            {live.status === 'done' && <Tag color="green" style={{ margin: 0 }}>完成</Tag>}
            {live.status === 'error' && <Tag color="red" style={{ margin: 0 }}>失败</Tag>}
          </div>
          {live.thoughts && (
            <div style={{ fontSize: 12, color: '#6D28D9', lineHeight: 1.65, whiteSpace: 'pre-wrap', marginBottom: 6, background: '#FAF5FF', borderRadius: 8, padding: '6px 10px', maxHeight: 140, overflow: 'auto' }}>
              <b style={{ fontSize: 11 }}>💭 思考</b>
              <div>{cleanProtocolText(live.thoughts)}</div>
            </div>
          )}
          {live.tools.map((t, i) => (
            <div key={i} style={{ fontSize: 11.5, padding: '3px 0', color: t.ok ? '#374151' : '#DC2626' }}>
              🔧 {t.ok ? '✓' : '✗'} <b>{t.name}</b> <span style={{ color: '#94A3B8' }}>{JSON.stringify(t.args || {})}</span>
            </div>
          ))}
          {live.clouds.map((c, i) => (
            <div key={'c' + i} style={{ fontSize: 11.5, padding: '3px 0', color: c.ok ? '#16A34A' : (c.result === '等待审批…' ? '#D46B08' : '#DC2626') }}>
              🔐 云端申请「{c.material}」：{c.result === '等待审批…' ? <span>等待审批（底部横幅确认）</span> : c.ok ? '已批准' + (c.result ? ' · ' + c.result.slice(0, 80) : '') : '未批准' + (c.result && c.result !== '等待审批…' ? ' · ' + c.result.slice(0, 60) : '')}
            </div>
          ))}
          {live.skipped && <div style={{ fontSize: 12, color: '#94A3B8' }}>⏭ {live.skipped}（数据无变化时不重复思考，有变化立即重新分析）</div>}
          {live.error && <div style={{ fontSize: 12, color: '#DC2626' }}>失败：{live.error}</div>}
          {(live.answer || live.status === 'done') && (
            <div style={{ fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', marginTop: 6, borderTop: '1px dashed #E9D5FF', paddingTop: 6 }}>
              <b style={{ fontSize: 11, color: '#7C3AED' }}>📌 结论</b>
              <div>{cleanProtocolText(live.answer) || (live.status === 'done' ? '（本轮未输出结论）' : '')}</div>
            </div>
          )}
        </div>
      )}
      {/* 历史：summary 结论摘要卡 / full 完整时间线 */}
      {logs.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94A3B8', padding: '6px 2px' }}>
          暂无自主分析记录——AI 会在后台自发开始（也可点「现在分析一轮」立即触发）。
          <Tooltip title="本地模型自主阅读数据概览→决定深挖方向→调用工具核实→需要行情时申请云端→输出结论；全程留痕可展开查看">
            <a style={{ marginLeft: 6 }}>什么是自主分析？</a>
          </Tooltip>
        </div>
      ) : !full ? (
        /* summary：结论摘要卡（驾驶舱轻量呈现） */
        logs.map((l, i) => (
          <div key={l.id ?? i} style={{ border: '1px solid var(--color-border)', borderLeft: '3px solid ' + (l.status === 'error' ? '#EF4444' : '#7C3AED'), borderRadius: 8, padding: '8px 12px', marginBottom: 6, background: 'var(--color-surface, #fff)', cursor: 'default' }}
            title={l.conclusion || l.thoughts || ''}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tag color={l.status === 'done' ? 'green' : l.status === 'error' ? 'red' : 'processing'} style={{ margin: 0 }}>{l.status === 'done' ? '✓' : l.status === 'error' ? '✗' : '…'}</Tag>
              <b style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.topic || '自主分析'}</b>
              <span style={{ fontSize: 11, color: '#94A3B8', flexShrink: 0 }}>{(l.started_at || l.finished_at || '').slice(0, 16)}</span>
            </div>
            {l.conclusion && <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.6, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{l.conclusion}</div>}
          </div>
        ))
      ) : (
        logs.map((l, i) => (
          <details key={l.id ?? i} style={{ border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 6, background: 'var(--color-surface, #fff)' }}>
            <summary style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none' }}>
              <Tag color={l.status === 'done' ? 'green' : l.status === 'error' ? 'red' : 'processing'} style={{ margin: 0 }}>{l.status === 'done' ? '✓' : l.status === 'error' ? '✗' : '…'}</Tag>
              <b style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.topic || '自主分析'}</b>
              <span style={{ fontSize: 11, color: '#94A3B8', flexShrink: 0 }}>{(l.started_at || l.finished_at || '').slice(0, 16)}</span>
              <span style={{ fontSize: 10.5, color: '#94A3B8', flexShrink: 0 }}>▾</span>
            </summary>
            <div style={{ padding: '0 12px 10px', fontSize: 12, color: '#64748B', lineHeight: 1.65 }}>
              {l.thoughts && <div style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}><b>💭 思考</b><br />{l.thoughts}</div>}
              {(() => {
                try {
                  const arr = JSON.parse(l.tools_json || '[]');
                  return arr.length > 0 ? <div style={{ marginBottom: 6 }}><b>🔧 调用工具</b><br />{arr.map((t: any) => `${t.ok ? '✓' : '✗'} ${t.name} ${JSON.stringify(t.args || {})}${t.text ? ' → ' + t.text.slice(0, 120) : ''}`).join('\n')}</div> : null;
                } catch { return null; }
              })()}
              {(() => {
                try {
                  const arr = JSON.parse(l.clouds_json || '[]');
                  return arr.length > 0 ? <div style={{ marginBottom: 6 }}><b>🔐 云端</b><br />{arr.map((c: any) => `${c.ok ? '已批准' : '未批准'} ${c.material}${c.result ? ' → ' + c.result.slice(0, 120) : ''}`).join('\n')}</div> : null;
                } catch { return null; }
              })()}
              {l.conclusion && <div style={{ whiteSpace: 'pre-wrap' }}><b>📌 结论</b><br />{l.conclusion}</div>}
            </div>
          </details>
        ))
      )}
    </div>
  );
}