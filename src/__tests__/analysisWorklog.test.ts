import { describe, expect, it } from 'vitest';
import { buildSummaryPrompts, normalizeWorkLogRow, parseWorkLogEvidence } from '../db/worklog';
import { classifyArtifact } from '../db/artifacts';
import { detectVoiceSheet, isLikelyVoiceAttachment, normalizeVoiceItems, resolveVoiceItems } from '../voiceImport';
import { formatAttachmentRows } from '../aiTools';

describe('analysis library classification', () => {
  it('maps every persisted source to its business domain', () => {
    expect(classifyArtifact({ artifactSource: 'trend_snapshot' }).domain).toBe('material');
    expect(classifyArtifact({ artifactSource: 'project_analysis' }).domain).toBe('project');
    expect(classifyArtifact({ artifactSource: 'quote_review' }).domain).toBe('quote');
    expect(classifyArtifact({ artifactSource: 'selling_analysis' }).domain).toBe('product');
    expect(classifyArtifact({ artifactSource: 'ai_panel', toolIds: ['query_project_cost'] }).domain).toBe('project');
    expect(classifyArtifact({ artifactSource: 'ai_panel', toolIds: ['query_material_insight'] }).domain).toBe('material');
    expect(classifyArtifact({ artifactSource: 'ai_panel', toolIds: ['unknown_tool'] }).domain).toBe('unclassified');
  });
});

describe('work log compatibility', () => {
  it('maps old notes/todos and safely handles damaged evidence JSON', () => {
    expect(normalizeWorkLogRow({ id: 1, content: '旧便签', is_todo: 0, evidence_json: '{bad' }).record_type).toBe('work_progress');
    expect(normalizeWorkLogRow({ id: 2, content: '旧待办', is_todo: 1, evidence_json: '[]' }).record_type).toBe('follow_up');
    expect(parseWorkLogEvidence('{bad')).toEqual([]);
    expect(normalizeWorkLogRow({ id: 3, content: '心得', record_type: 'reflection', evidence_json: '["报价单"]' }).evidence).toEqual(['报价单']);
  });
  it('builds evidence-bound prompts without asking the model to invent facts', () => {
    const prompt = buildSummaryPrompts('performance', '2026-09-01', '2026-09-02', [normalizeWorkLogRow({ id: 9, log_date: '2026-09-02 09:00', content: '确认供应商报价', work_project: 'M280', is_todo: 0 })]);
    expect(prompt.system).toContain('不得补造数字');
    expect(prompt.user).toContain('[记录#9]');
    expect(prompt.sourceLogIds).toEqual([9]);
  });
});

describe('adaptive voice sheet import', () => {
  it('finds the fourth-row header and imports 179 comments only', () => {
    const rows: any[][] = [['京东评论抓取 — MateView GT'], ['抓取说明'], [], ['序号', '评价内容', '评分'], ...Array.from({ length: 179 }, (_, i) => [i + 1, `这是一条真实评论 ${i + 1}`, 5])];
    const result = detectVoiceSheet([{ name: '全部评论', rows }]);
    expect(result.headerRow).toBe(3);
    expect(result.contentColumn).toBe(1);
    expect(result.contents).toHaveLength(179);
    expect(result.contents[0]).toBe('这是一条真实评论 1');
    expect(result.contents).not.toContain('京东评论抓取 — MateView GT');
  });
  it('supports first-row headers, English aliases, extra sheets and single-column files', () => {
    expect(detectVoiceSheet([{ name: '评论', rows: [['评论'], ['很好'], ['支架稳']] }]).contents).toEqual(['很好', '支架稳']);
    expect(detectVoiceSheet([{ name: 'reviews', rows: [['id', 'review', 'score'], [1, 'quiet panel', 5]] }]).contentColumn).toBe(1);
    const multi = detectVoiceSheet([{ name: '说明', rows: [['报告标题'], ['说明']] }, { name: '全部评论', rows: [['comment', 'date'], ['good color', '2026-01-01'], ['bad stand', '2026-01-02']] }]);
    expect(multi.sheetName).toBe('全部评论');
    expect(multi.contents).toEqual(['good color', 'bad stand']);
  });
  it('does not classify a quote sheet as voice just because it has one fallback header', () => {
    const detection = detectVoiceSheet([{ name: 'quote-rounds.csv', rows: [
      ['source_id', 'material', 'unit_price', 'quantity', 'spec', 'warranty_years', 'remark'],
      ['A-R1-2', 'Panel-X', 300, 1, '27-inch IPS', 3, ''],
      ['A-R1-3', 'Board-X', 100, 1, 'HDMI 2.1', 3, ''],
    ] }]);
    expect(detection.headerFound).toBe(false);
    expect(isLikelyVoiceAttachment('quote-rounds.csv', detection)).toBe(false);
  });
  it('accepts all model object aliases and falls back when a non-empty payload is invalid', () => {
    expect(normalizeVoiceItems([{ comment: 'a' }, { review: 'b' }, { '评价': 'c' }])).toEqual(['a', 'b', 'c']);
    expect(resolveVoiceItems([{ id: 1 }], ['附件原声'])).toEqual(['附件原声']);
  });
});

describe('attached table reading', () => {
  it('returns real attached rows instead of reopening a file picker', () => {
    expect(formatAttachmentRows([{ name: 'quote.csv', rows: [['material', 'unit_price'], ['Panel-X', 300]] }], 10))
      .toContain('Panel-X\t300');
  });
});
