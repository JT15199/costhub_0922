// 关键物料洞察（v2.3.19，2026-08-16）：驾驶舱展示自动洞察引擎的状态与结果
// 数据=纯本地规则计划（identifyKeyMaterials/aggregateMaterials/buildInsightPlan），洞察结果来自 trend_snapshots
import { useEffect, useCallback, useState } from 'react';
import { Tag } from 'antd';
import { BulbOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { InsightPlanItem } from '../autoInsight';
import { buildMaterialSuggestion } from '../autoInsight';

const DIRECTION_META: Record<string, { text: string; color: string }> = {
  上涨: { text: '↑ 上涨', color: '#DC2626' },
  下降: { text: '↓ 下降', color: '#16A34A' },
  震荡: { text: '～ 震荡', color: '#2563EB' },
  波动: { text: '～ 波动', color: '#2563EB' },
  基本平稳: { text: '＝ 平稳', color: '#6B7280' },
};

const shortDate = (t?: string) => (t || '').slice(5, 10) || '';

export default function KeyMaterialInsights({ onNavigate, compact }: { onNavigate?: (page: string) => void; compact?: boolean }) {
  const [plan, setPlan] = useState<InsightPlanItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      const { identifyKeyMaterials, aggregateMaterials, buildInsightPlan, queryLastInsights } = await import('../autoInsight');
      const { getProjects, getProjectBOMs, getSetting } = await import('../db');
      const projects = (await getProjects('', '', '')).filter((p: any) => !p.is_deleted && (p.project_type || '') === '在研');
      if (projects.length === 0) { setPlan([]); return; }
      const bomsByProject: Record<number, any[]> = {};
      for (const p of projects) {
        try { bomsByProject[p.id] = await getProjectBOMs(p.id); } catch { bomsByProject[p.id] = []; }
      }
      const aggregates = aggregateMaterials(identifyKeyMaterials(projects, bomsByProject));
      const intervalDays = Math.max(1, Number(await getSetting('ai_insight_interval_days', '30')) || 30);
      const p = buildInsightPlan(aggregates, await queryLastInsights(), { intervalDays, now: new Date() });
      setPlan(p.slice(0, 8));
    } catch { setPlan([]); }
  }, []);

  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener('costhub-insight-done', h);
    return () => window.removeEventListener('costhub-insight-done', h);
  }, [load]);

  if (!plan || plan.length === 0) return null;

  return (
    <div style={{ marginBottom: compact ? 0 : 14, borderRadius: 12, padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <BulbOutlined style={{ color: '#D97706' }} />
        <b style={{ fontSize: 13 }}>关键物料洞察</b>
        <Tag style={{ margin: 0, fontSize: 10.5, lineHeight: '18px' }} color="orange">按子类 · 30 天周期</Tag>
        <span style={{ flex: 1 }} />
        <a style={{ fontSize: 12 }} onClick={() => onNavigate?.('decomposition')}>全部洞察 <ArrowRightOutlined /></a>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {plan.map((item, i) => {
          const agg = item.aggregate;
          const top = agg.projects[0];
          const dir = DIRECTION_META[item.lastDirection || ''] || null;
          const hasResult = !!item.lastSummary || !!item.lastDirection;
          const isWait = item.action === 'wait';
          const isTodo = item.action === 'insight';
          // 机会点/风险点建议（本地规则：方向+幅度+占比 → 具体行动）
          const suggestion = hasResult ? buildMaterialSuggestion(agg, {
            direction: item.lastDirection,
            confidence: item.lastConfidence,
            summary: item.lastSummary,
            suggested_action: item.lastAction,
            magnitudeMin: item.lastMagnitudeMin,
            magnitudeMax: item.lastMagnitudeMax,
          }) : null;
          const level = suggestion?.level;
          const lineBg = level === 'opportunity' ? 'rgba(22,163,74,0.05)' : level === 'risk' ? 'rgba(220,38,38,0.04)' : hasResult ? 'rgba(10,132,255,0.04)' : 'transparent';
          const lineBorder = level === 'opportunity' ? '1px solid rgba(22,163,74,0.25)' : level === 'risk' ? '1px solid rgba(220,38,38,0.2)' : hasResult ? '1px solid rgba(10,132,255,0.12)' : 'transparent';
          return (
            <div key={agg.key + i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 9px', borderRadius: 8, background: lineBg, border: lineBorder }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{agg.name}</span>
                  {agg.models && agg.models.length > 0 && (
                    <span style={{ fontSize: 10.5, color: '#94A3B8' }}>{'含 ' + agg.models.length + ' 种型号'}</span>
                  )}
                  <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{agg.category}</Tag>
                  <span style={{ fontSize: 10.5, color: '#94A3B8' }}>
                    占 {top.projectCode} {Math.round(top.ratio * 100)}%{agg.projects.length > 1 ? ' · 共 ' + agg.projects.length + ' 项目' : ''}
                  </span>
                  {suggestion && level === 'opportunity' && <Tag color="green" style={{ margin: 0, fontSize: 10.5, lineHeight: '18px' }}>🎯 机会点</Tag>}
                  {suggestion && level === 'risk' && <Tag color="red" style={{ margin: 0, fontSize: 10.5, lineHeight: '18px' }}>⚠️ 风险点</Tag>}
                </div>
                {hasResult ? (
                  <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                    {dir && <Tag style={{ marginRight: 6, fontSize: 10.5, lineHeight: '18px', color: dir.color, borderColor: dir.color + '55' }}>{dir.text}</Tag>}
                    {item.lastConfidence && <Tag style={{ marginRight: 6, fontSize: 10.5, lineHeight: '18px' }}>{'置信度 ' + item.lastConfidence}</Tag>}
                    <span>{item.lastSummary || ''}</span>
                    {suggestion && (
                      <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.6, color: level === 'opportunity' ? '#15803D' : level === 'risk' ? '#B91C1C' : '#64748B', background: level === 'info' ? 'rgba(100,116,139,0.06)' : 'transparent', borderRadius: 6, padding: level === 'info' ? '4px 8px' : 0 }}>
                        <b>{suggestion.title}</b>——{suggestion.action}
                      </div>
                    )}
                  </div>
                ) : isWait ? (
                  <div style={{ marginTop: 3, fontSize: 11.5, color: '#94A3B8' }}>{item.reason}{item.nextAt ? '（' + item.nextAt + '）' : ''}</div>
                ) : isTodo ? (
                  <div style={{ marginTop: 3, fontSize: 11.5, color: '#D97706' }}>{item.reason}——下一轮轮询自动执行，也可到物料趋势洞察页手动洞察</div>
                ) : null}
              </div>
              <span style={{ flexShrink: 0, fontSize: 10.5, color: '#94A3B8', marginTop: 3 }}>
                {hasResult ? (shortDate(item.lastAt) || '') + ' 洞察' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}