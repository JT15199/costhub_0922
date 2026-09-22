import { describe, expect, it } from 'vitest';
import { buildCloudSafeContext, CLOUD_SYSTEM_PROMPT, MAX_CLOUD_CONTEXT_CHARS } from '../ai/cloudContext';
import { emptyWorkingState } from '../ai/workingState';

const publicDecision = { classification: 'public' as const, candidateRoute: 'cloud_candidate' as const, cloudSafe: true, reasonCode: 'classifier_explicit_public_source', sourceTypes: ['public_market_data'], regexMatches: [], classifierUsed: true };

describe('CloudSafe Context Builder Phase 7', () => {
  it('keeps only approved public content and always emits tools=[]', () => {
    const state = emptyWorkingState('cloud-safe');
    state.confirmedFacts = [
      { id: 'public-fact', text: '公开市场刷新率趋势为 high', sourceMessageIds: ['m1'], sensitivity: 'public', confidence: 'confirmed', status: 'active', priority: 'normal', provenance: { sourceType: 'public_market_data', sensitivity: 'public', cloudSafe: true, priority: 'normal', sourceIds: ['m1'], verified: true } },
      { id: 'secret-fact', text: '供应商报价 ¥420', sourceMessageIds: ['m2'], sensitivity: 'sensitive', confidence: 'confirmed', status: 'active', priority: 'critical', provenance: { sourceType: 'supplier_quote', sensitivity: 'sensitive', cloudSafe: false, priority: 'critical', sourceIds: ['m2'] } },
    ];
    state.activeFiles = [{ path: 'C:\\private\\quote.xlsx', sensitivity: 'sensitive' }];
    const result = buildCloudSafeContext({
      privacyDecision: publicDecision,
      workingState: state,
      approvedMessages: [
        { id: 'approved', role: 'user', text: '公开市场趋势如何？', approved: true },
        { id: 'not-approved', role: 'user', text: '公开内容', approved: false },
        { id: 'secret-message', role: 'assistant', text: '供应商报价 ¥420', approved: true },
      ],
      approvedRetrieval: [{ id: 'public-retrieval', text: '公开行业报告摘要', approved: true }],
    });

    expect(result.context.systemPrompt).toBe(CLOUD_SYSTEM_PROMPT);
    expect(result.context.tools).toEqual([]);
    expect(result.context.workingState.map(item => item.text)).toEqual(['公开市场刷新率趋势为 high']);
    expect(result.context.messages.map(item => item.content)).toEqual(['公开市场趋势如何？']);
    expect(result.context.retrieved.map(item => item.content)).toEqual(['公开行业报告摘要']);
    expect(result.dropped).toEqual({ stateItems: 1, messages: 2, retrieved: 0 });
    expect(JSON.stringify(result.context)).not.toContain('供应商报价');
    expect(JSON.stringify(result.context)).not.toContain('quote.xlsx');
  });

  it('refuses to construct a cloud context for sensitive or unknown decisions', () => {
    expect(() => buildCloudSafeContext({ privacyDecision: { ...publicDecision, classification: 'sensitive', candidateRoute: 'local', cloudSafe: false, reasonCode: 'regex_guard' } })).toThrow('Cloud Route 已阻止');
    expect(() => buildCloudSafeContext({ privacyDecision: { ...publicDecision, classification: 'unknown', candidateRoute: 'local', cloudSafe: false, reasonCode: 'classifier_error' } })).toThrow('Cloud Route 已阻止');
  });

  it('preserves approved whitespace and rejects oversized content instead of clipping', () => {
    const text = '第一行\n\n  第二行\t保留空白';
    const result = buildCloudSafeContext({ privacyDecision: publicDecision, approvedMessages: [{ id: 'm', role: 'user', text, approved: true }] });
    expect(result.context.messages[0].content).toBe(text);
    expect(() => buildCloudSafeContext({ privacyDecision: publicDecision, approvedMessages: [{ id: 'big', role: 'user', text: 'x'.repeat(MAX_CLOUD_CONTEXT_CHARS + 1), approved: true }] })).toThrow('未生成截断后的请求');
  });

  it('allows an unknown candidate only for local preview, never as a send decision', () => {
    const candidate = { ...publicDecision, classification: 'unknown' as const, candidateRoute: 'local' as const, cloudSafe: false, reasonCode: 'user_selected_cloud_candidate' };
    expect(buildCloudSafeContext({ privacyDecision: candidate, allowUserCandidate: true, approvedMessages: [{ id: 'candidate', role: 'user', text: '公开候选内容', approved: true }] }).context.messages[0].content).toBe('公开候选内容');
    expect(() => buildCloudSafeContext({ privacyDecision: candidate, approvedMessages: [{ id: 'candidate', role: 'user', text: '公开候选内容', approved: true }] })).toThrow('Cloud Route 已阻止');
  });
});
