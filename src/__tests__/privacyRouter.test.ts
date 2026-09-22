import { describe, expect, it, vi } from 'vitest';
import { evaluatePrivacy, reviewedPublicClassifier } from '../ai/privacyRouter';
import { findSensitiveRanges } from '../ai/security';

describe('Privacy Router Phase 6', () => {
  it('stops at Source Policy before the classifier', () => {
    const classifier = vi.fn(() => ({ classification: 'public' as const, reasonCode: 'classifier_public' }));
    const result = evaluatePrivacy({ text: '公开市场问题', sourceTypes: ['supplier_quote'], classifier });
    expect(result).toMatchObject({ classification: 'sensitive', candidateRoute: 'local', reasonCode: 'source_policy:supplier_quote', cloudSafe: false, classifierUsed: false });
    expect(classifier).not.toHaveBeenCalled();
  });

  it('uses the Regex Guard and never treats a match as public', () => {
    const classifier = vi.fn(() => ({ classification: 'public' as const, reasonCode: 'classifier_public' }));
    const result = evaluatePrivacy({ text: 'API key: secret-value', sourceTypes: ['public_market_data'], classifier });
    expect(result).toMatchObject({ classification: 'sensitive', candidateRoute: 'local', reasonCode: 'regex_guard', cloudSafe: false });
    expect(result.regexMatches).toContain('api_key');
    expect(classifier).not.toHaveBeenCalled();
  });

  it.each([
    '-----BEGIN PRIVATE KEY-----',
    'Bearer abcdefghijk',
    'password: secret-value',
    'contact user@example.com',
    'phone 13812345678',
    String.raw`local file C:\Users\demo\quote.xlsx`,
    'BOM 料号与目标成本',
  ])('guards %s', text => {
    expect(evaluatePrivacy({ text, sourceTypes: ['public_market_data'], classifier: () => ({ classification: 'public', reasonCode: 'bad-downgrade' }) })).toMatchObject({ classification: 'sensitive', candidateRoute: 'local', cloudSafe: false, reasonCode: 'regex_guard' });
  });

  it('accepts only a valid local classifier result and fails closed on errors', () => {
    expect(evaluatePrivacy({ text: 'public weather', sourceTypes: ['public_market_data'] })).toMatchObject({ classification: 'unknown', candidateRoute: 'local', cloudSafe: false, reasonCode: 'classifier_unverified_public_source', classifierUsed: true });
    expect(evaluatePrivacy({ text: 'public weather', sourceTypes: ['public_market_data'], metadata: [{ sourceType: 'public_market_data', sensitivity: 'public', cloudSafe: true, priority: 'normal', sourceIds: ['public-1'], verified: true }] })).toMatchObject({ classification: 'public', candidateRoute: 'cloud_candidate', cloudSafe: true, reasonCode: 'classifier_verified_public_metadata', classifierUsed: true });
    expect(evaluatePrivacy({ text: 'public weather', sourceTypes: ['public_market_data'], classifier: () => ({ classification: 'public', reasonCode: 'local_public' }) })).toMatchObject({ classification: 'public', candidateRoute: 'cloud_candidate', cloudSafe: true, classifierUsed: true });
    expect(evaluatePrivacy({ text: 'unclear', classifier: () => { throw new Error('classifier unavailable'); } })).toMatchObject({ classification: 'unknown', candidateRoute: 'local', reasonCode: 'classifier_error', cloudSafe: false });
    expect(evaluatePrivacy({ text: 'unclear', classifier: () => ({ classification: 'not-a-classification' as any, reasonCode: 'bad' }) })).toMatchObject({ classification: 'unknown', candidateRoute: 'local', reasonCode: 'classifier_invalid_result' });
  });

  it('does not trust a public label for an unpublished message', () => {
    const result = evaluatePrivacy({
      text: '保密：尚未发布的新品叫蓝鹭，将于十一月上市，请勿对外透露。',
      sourceTypes: ['public_approved_content'],
      metadata: [{ sourceType: 'public_approved_content', sensitivity: 'public', cloudSafe: true, priority: 'normal', sourceIds: ['user-review'], verified: true }],
      classifier: reviewedPublicClassifier,
    });
    expect(result).toMatchObject({ classification: 'unknown', candidateRoute: 'local', cloudSafe: false, reasonCode: 'classifier_confidentiality_signal' });
  });

  it('returns stable merged ranges for repeated unicode text and never produces HTML', () => {
    const text = '😀 报价 420元\n报价 420元 <script>alert(1)</script>';
    const ranges = findSensitiveRanges(text);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(ranges.every(range => text.slice(range.start, range.end) === range.sample)).toBe(true);
    expect(ranges.some(range => range.sample.includes('报价'))).toBe(true);
    expect(ranges.some(range => range.sample.includes('<script>'))).toBe(false);
    expect(text).toContain('<script>');
  });
});
