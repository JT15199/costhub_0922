// 数据就绪度（v2.3.19，2026-08-18 用户：引导客户如何使用——发现缺什么数据、缺了能做到什么样、建议是什么）
// 扫描本地数据（模型/项目BOM/器件报价/原声/目标/竞品/规格），逐项 有/缺/半 + 现状 + 影响 + 建议
// 设计：v2 视觉（骨色底+墨色+信号色，无 AI 味）；「让 AI 引导我」→ 预填提问给右侧 AI 协作窗
import { useEffect, useState } from 'react';
import { Button } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { getDataReadiness, type ReadinessItem } from '../dataReadiness';

const ASK_PROMPT = '先看看我的数据就绪度：我缺哪些数据？没有这些数据，我现在能做到什么、做不到什么？分别建议怎么补。';

const LEVEL_META: Record<string, { label: string; dot: string; color: string; bg: string }> = {
  ok: { label: '有', dot: '#1F7A4C', color: '#1F7A4C', bg: 'rgba(31,122,76,0.07)' },
  partial: { label: '半', dot: '#A67C1F', color: '#A67C1F', bg: 'rgba(166,124,31,0.07)' },
  missing: { label: '缺', dot: '#C0392B', color: '#C0392B', bg: 'rgba(192,57,43,0.07)' },
};

export default function DataReadiness({ onAskAi }: { onAskAi?: () => void }) {
  const [items, setItems] = useState<ReadinessItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    getDataReadiness().then(l => { if (alive) setItems(l); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, []);

  const askAi = () => {
    try { localStorage.setItem('costhub-ai-prompt-pending', JSON.stringify({ prompt: ASK_PROMPT, auto: true })); } catch { }
    if (onAskAi) onAskAi();
    else window.dispatchEvent(new CustomEvent('costhub-open-ai-prompt'));
  };

  const okN = items?.filter(i => i.level === 'ok').length ?? 0;
  const missingN = items?.filter(i => i.level === 'missing').length ?? 0;
  const partialN = (items?.length ?? 0) - okN - missingN;

  return (
    <div style={{ background: '#F4F3EE', border: '1px solid #E6E4DC', borderRadius: 10, padding: '12px 14px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#181713' }}>数据就绪度</span>
        <span style={{ fontSize: 11, color: '#9A978B' }}>缺什么 · 能做到什么样 · 建议怎么补</span>
        <Button size="small" type="primary" icon={<RobotOutlined />} style={{ marginLeft: 'auto', borderRadius: 6, fontSize: 11.5, height: 26 }} onClick={askAi}>
          让 AI 引导我
        </Button>
      </div>

      {items === null ? (
        <div style={{ fontSize: 11.5, color: '#9A978B', padding: '6px 0' }}>正在扫描本地数据…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 11.5, color: '#9A978B', padding: '6px 0' }}>暂无数据可扫描</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, fontSize: 11.5, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#5F5D54' }}>{items.length} 项能力</span>
            <span style={{ color: '#1F7A4C', fontWeight: 600 }}>● {okN} 就绪</span>
            {partialN > 0 && <span style={{ color: '#A67C1F', fontWeight: 600 }}>● {partialN} 半就绪</span>}
            {missingN > 0 && <span style={{ color: '#C0392B', fontWeight: 600 }}>● {missingN} 缺数据</span>}
            <span style={{ marginLeft: 'auto', color: '#9A978B' }}>就绪项可立即用；缺数据项看「建议」补一步即可解锁</span>
          </div>

          {items.map(it => {
            const meta = LEVEL_META[it.level] || LEVEL_META.missing;
            const prefix = it.level === 'ok' ? '现在能' : '缺了会';
            return (
              <div key={it.key} style={{ background: meta.bg, borderLeft: '3px solid ' + meta.dot, borderRadius: 6, padding: '7px 10px', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#181713' }}>{it.name}</span>
                  <span style={{ fontSize: 10, color: meta.color, fontWeight: 700, background: '#fff', borderRadius: 3, padding: '0 4px', lineHeight: '15px' }}>{meta.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#5F5D54', fontVariantNumeric: 'tabular-nums' }}>{it.have}</span>
                </div>
                <div style={{ fontSize: 11, color: '#5F5D54', marginTop: 2, lineHeight: 1.55 }}>
                  <span style={{ color: meta.color, fontWeight: 600 }}>{prefix}：</span>{it.impact}
                </div>
                {it.suggestion && (
                  <div style={{ fontSize: 11, color: '#A67C1F', marginTop: 2, lineHeight: 1.55 }}>
                    <span style={{ fontWeight: 700 }}>▶ 建议：</span>{it.suggestion}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
