// 结论数字溯源校验（harness 阶段③，2026-08-18）：反幻觉从"提示词要求"升级为"代码强制"
// 结论文本中出现的金额/百分比，必须在数据证据（概览+工具结果）中存在，否则标记为"未溯源"供人工核对
export interface UnverifiedNum { num: number; ctx: string; }

// 提取文本中的数字及上下文（¥12.5 / 12.5元 / 12.5% / 占比 12%）
export function extractNums(text: string): UnverifiedNum[] {
  const out: UnverifiedNum[] = [];
  if (!text) return out;
  const re = /(?:¥|￥)?(\d+(?:\.\d+)?)(?=\s*(?:元|万|%|％|\b))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const num = parseFloat(m[1]);
    if (num === 0) continue;
    // 列表序号不算数据数字（"1. 项目" "3）继续" "2、xxx"）——数字后紧跟序号标点即跳过（金额/百分比的小数点已在 m[0] 内，不受影响）
    const afterCh = text.charAt(m.index + m[0].length);
    if (/^[.、)）:：,，。]/.test(afterCh)) continue;
    const start = Math.max(0, m.index - 12);
    out.push({ num, ctx: text.slice(start, m.index + m[0].length).trim() });
  }
  return out;
}

// 校验：结论数字是否在证据中出现（支持原样 / ¥前缀 / 元 / % 后缀；±0.005 内视为一致）
export function verifyConclusionNumbers(conclusion: string, evidence: string): { unverified: UnverifiedNum[] } {
  const nums = extractNums(conclusion);
  const unverified: UnverifiedNum[] = [];
  const ev = evidence || '';
  for (const n of nums) {
    const hits = [
      ev.includes(String(n.num)),
      ev.includes('¥' + n.num),
      ev.includes(n.num + '元'),
      ev.includes(n.num + '%'),
      ev.includes(String(Math.round(n.num * 1000) / 1000)),
      ev.includes(String(Math.round(n.num * 100) / 100)),
      ev.includes(String(Math.round(n.num * 10) / 10)),
    ];
    if (!hits.some(Boolean)) unverified.push(n);
  }
  return { unverified };
}
