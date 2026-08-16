// AI 今日速览（v2.3.19，2026-08-16）：打开驾驶舱即触发——本地 AI 主动汇报当天数据重点
// 生成中显示占位动画；完成后展示正文 + 来源标注（本地模型/规则速览/今日缓存）+ 重新生成
import { useEffect, useRef, useState } from 'react';
import { Button, Tag } from 'antd';
import { SyncOutlined, RobotOutlined } from '@ant-design/icons';
import { runDailyBrief, type BriefResult } from '../dailyBrief';

export default function DailyBrief({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const [state, setState] = useState<'loading' | 'done'>('loading');
  const [res, setRes] = useState<BriefResult | null>(null);
  const [genAt, setGenAt] = useState('');
  const runningRef = useRef(false);

  const load = async (force = false) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setState('loading');
    try {
      const r = await runDailyBrief({ force });
      setRes(r);
      setGenAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      setState('done');
    } finally {
      runningRef.current = false;
    }
  };
  useEffect(() => { load(); }, []);

  const srcTag = !res ? null
    : res.source === 'model' ? <Tag color="blue" style={{ margin: 0, fontSize: 10.5, lineHeight: '18px' }}>本地模型 {res.model}</Tag>
    : res.source === 'cache' ? <Tag style={{ margin: 0, fontSize: 10.5, lineHeight: '18px' }}>今日已生成（缓存）</Tag>
    : <Tag style={{ margin: 0, fontSize: 10.5, lineHeight: '18px' }}>规则速览 · 本地模型未连接</Tag>;

  return (
    <div style={{
      marginBottom: 14, borderRadius: 12, padding: '12px 16px',
      background: 'linear-gradient(135deg, rgba(10,132,255,0.07), rgba(88,86,214,0.07))',
      border: '1px solid rgba(10,132,255,0.18)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <RobotOutlined style={{ color: '#0A84FF' }} />
        <b style={{ fontSize: 13 }}>AI 今日速览</b>
        {state === 'loading'
          ? <Tag style={{ margin: 0, fontSize: 10.5, lineHeight: '18px', color: '#2563EB' }}>
              <span className="ai-breathe">●</span> AI 正在阅读你的数据…
            </Tag>
          : srcTag}
        <span style={{ flex: 1 }} />
        <Button size="small" type="text" icon={<SyncOutlined />} disabled={state === 'loading'} onClick={() => load(true)}>
          重新生成
        </Button>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.9, color: 'var(--color-text)' }}>
        {state === 'loading' ? '正在整理今天的数据要点：项目状态、报价情报、待办提醒……' : res?.text}
      </div>
      {state === 'done' && (
        <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 6 }}>
          生成于 {genAt} · 全程本地处理，数据不出本机 ·
          <a style={{ marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); onNavigate?.('localAI'); }}>查看 AI 活动记录 →</a>
        </div>
      )}
    </div>
  );
}
