import { describe, expect, it } from 'vitest';
import { buildCompactionSource, classifyCompactionLevel, lightPruneMessages, validateSummary } from '../ai/contextPolicy';

describe('context compaction source chaining', () => {
  it('keeps the retained tail when a later compaction reuses a summary', () => {
    const messages = [
      { role: 'assistant', content: 'previous summary' },
      { role: 'user', content: 'retained evidence' },
      { role: 'assistant', content: 'new answer' },
      { role: 'user', content: 'latest constraint' },
    ] as any;
    const source = buildCompactionSource(messages, { summary: 'previous summary', sourceEnd: 99 }, 4);
    expect(source.map(message => (message as any).content)).toEqual(['previous summary', 'retained evidence', 'new answer', 'latest constraint']);
  });
});

describe('context summary validation', () => {
  // 2026-09-21：摘要从"7 字段严格 JSON"改为"DSH 式结构化检查点（固定 Markdown 章节）"。
  // 旧契约在 CPU 机器上频繁截断/超时，且信息量太小；新契约见 src/ai/compactionCheckpoint.ts。
  const checkpoint = [
    '## 主要请求与意图 (Primary Request and Intent)',
    '- 修复洞察链路，让它产出有效信息',
    '## 当前工作 (Current Work)',
    '- 正在改 contextPolicy 的压缩目标',
    '## 下一步 (Next Step)',
    '- 跑一遍测试',
  ].join('\n');

  it('accepts a structured checkpoint', () => {
    expect(validateSummary(checkpoint)).toContain('主要请求与意图');
  });

  it('rejects output that is not a checkpoint at all', () => {
    expect(() => validateSummary('{"goal":"g"}')).toThrow();
  });

  it('rejects an empty husk with headings only', () => {
    expect(() => validateSummary('## 当前工作 (Current Work)\n- (none)')).toThrow();
  });
});

describe('compaction watermarks', () => {
  it('uses the configured green/yellow/orange/red bands', () => {
    expect(classifyCompactionLevel(0.59)).toBe('green');
    expect(classifyCompactionLevel(0.6)).toBe('yellow');
    expect(classifyCompactionLevel(0.75)).toBe('orange');
    expect(classifyCompactionLevel(0.85)).toBe('red');
  });

  it('prunes only old low-value traces and protects the current user window', () => {
    const duplicate = { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'same evidence' }] } as any;
    const messages = [duplicate, { role: 'assistant', content: [{ type: 'text', text: 'same explanation' }] }, { ...duplicate },
      ...Array.from({ length: 7 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `old-${index}` }] })),
      { role: 'user', content: [{ type: 'text', text: 'current request' }] }] as any;
    const pruned = lightPruneMessages(messages);

    expect(JSON.stringify(pruned.slice(0, 3))).toContain('重复 Tool Result');
    expect(pruned.at(-1)).toEqual(messages.at(-1));
  });
});
