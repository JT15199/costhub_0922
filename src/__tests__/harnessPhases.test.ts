import { describe, it, expect } from 'vitest';
import { extractNums, verifyConclusionNumbers } from '../verifyConclusion';
import { compressMessages } from '../thinkEngine';

describe('verifyConclusionNumbers — 结论数字溯源校验（阶段③）', () => {
  const evidence = 'M270 BOM ¥612.50，驱动板 ¥85.00 × 2，占比 27%';

  it('结论中的金额在证据中出现 → 校验通过（不标记）', () => {
    const { unverified } = verifyConclusionNumbers('驱动板成本 ¥85.00，占 BOM 的 27%', evidence);
    expect(unverified.length).toBe(0);
  });

  it('结论中编造的数字 → 标记为未溯源', () => {
    const { unverified } = verifyConclusionNumbers('若换供应商每台可省 ¥1234.56', evidence);
    expect(unverified.length).toBe(1);
    expect(unverified[0].num).toBe(1234.56);
  });

  it('extractNums 提取金额/百分比/普通数字', () => {
    const nums = extractNums('¥12.5 成本 12.5元 占比 8% 数量 3');
    const vals = nums.map(n => n.num);
    expect(vals).toContain(12.5);
    expect(vals).toContain(8);
  });
});

describe('compressMessages — 上下文预算压缩（阶段②）', () => {
  const sys = { role: 'system', content: 'sys' };
  const user0 = { role: 'user', content: '初始问题' };
  const mk = (n: number, len = 2000) => ({ role: n % 2 === 0 ? 'assistant' : 'user', content: 'r' + n + '_' + 'x'.repeat(len) });

  it('未超预算 → 原样返回', () => {
    const msgs = [sys, user0, mk(1, 100), mk(2, 100)];
    expect(compressMessages(msgs, 9000)).toBe(msgs);
  });

  it('超预算 → 保留 system+初始问题+最近一轮，中间折叠为摘要行', () => {
    const msgs = [sys, user0, mk(1), mk(2), mk(3), mk(4)];
    const out = compressMessages(msgs, 2000);
    expect(out[0]).toBe(sys);
    expect(out[1]).toBe(user0);
    expect(out.some((m: any) => m.content.includes('压缩省略'))).toBe(true);
    // 最近一轮完整保留（最后一条是 r4 开头的 user 提示）
    const last = out[out.length - 1];
    expect(String(last.content)).toContain('r4');
  });
});
