// 上下文压缩检查点（2026-09-21）——机制直接移植自 DSH 的 compaction-basic
//
// 为什么重写：原实现的摘要是「7 字段严格 JSON」（goal/constraints/facts/evidence_ids/pending/
// failed_or_unknown/next_step），信息量太小、字段无语义说明、且 json:true + num_predict≤768 极易截断，
// 实测在 CPU 机器上频繁 `摘要模型请求超时或已取消`，失败即退化成"保守剪枝"——用户感知就是"压缩没有作用"。
//
// DSH 的做法（dsh-compaction-basic）：
//   ① 摘要指令作为**最后一条 user 消息**追加在原文之后（复用同一份 system/工具前缀，保持 KV cache）；
//   ② 强制输出**固定的 Markdown 章节目录**（主要请求与意图 / 关键技术概念 / 文件与代码 / 错误与修复 /
//      待办 / 当前工作 / 下一步 / 关键上下文），空章节写 (none)，一节都不许删；
//   ③ 摘要用 <compacted-summary> 包裹，前面加一段"这是自动生成的检查点"前言，作为**已确立的背景**；
//   ④ 原文里若已有旧检查点，要求**合并**（保留仍然成立的事实、丢弃过期的），不得原样照抄；
//   ⑤ 失败即失败：摘要没变小 / 被截断 → 不提交压缩结果（fail-closed）。
//
// 本项目落地的差异：章节标题中英并列（本地中文模型对中文标题更稳，英文锚点保留可检索性）；
// 前言与指令为中文；其余机制（固定章节、合并旧检查点、包裹标记、fail-closed）与 DSH 一致。

/** 检查点包裹标记（与 DSH 同名，便于比对与检索）。 */
export const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/** 检查点前言：把替换后的内容定性为"已确立的背景"，而不是一条新指令。 */
export const CHECKPOINT_PREAMBLE =
  '这是一段自动生成的上下文检查点，用于在释放上下文空间的同时保留必要信息。'
  + '请把它当作已经确立的背景事实，直接在此基础上继续工作，不要复述、不要确认、也不要提及"压缩"这件事。';

/** 固定章节（顺序固定，一节都不许删）。 */
export const COMPACTION_SECTIONS: { title: string; hint: string }[] = [
  { title: '## 主要请求与意图 (Primary Request and Intent)', hint: '用户最初与演变后的目标；措辞重要时原样引用' },
  { title: '## 关键技术概念 (Key Technical Concepts)', hint: '技术栈、框架、模式与项目约定' },
  { title: '## 文件与代码 (Files and Code)', hint: '精确路径：为什么重要、关键改动或代码片段' },
  { title: '## 错误与修复 (Errors and Fixes)', hint: '错误：如何解决，以及相关的用户反馈' },
  { title: '## 待办工作 (Pending Jobs)', hint: '用户明确要求但尚未完成的事' },
  { title: '## 当前工作 (Current Work)', hint: '检查点发生时正在做的事' },
  { title: '## 下一步 (Next Step)', hint: '紧接着的单一动作，与最近一次请求一致' },
  { title: '## 关键上下文 (Critical Context)', hint: '决策与理由、约束、用户偏好、悬而未决的问题、继续所需的数据' },
];

/**
 * 摘要指令（与 DSH 的 COMPACTION_INSTRUCTION 同构）。
 * @param hasPriorCheckpoint 原文里是否已存在旧检查点（存在则要求合并而不是照抄）
 */
export function buildCompactionInstruction(hasPriorCheckpoint = false): string {
  const sections = COMPACTION_SECTIONS.map(section => `${section.title}\n- [${section.hint}]`).join('\n\n');
  return [
    '你现在充当本 AI 助手的上下文压缩引擎。请把**上面的对话**浓缩成一份结构化检查点，让另一个模型能够无损接续工作。',
    '',
    '严格按下面的 Markdown 结构输出，**章节一个都不能少、顺序不能变**。用简短的项目符号，不要写成段落。空章节写「(none)」，绝不允许省略章节。',
    '',
    sections,
    '',
    '规则：',
    '- 保留精确的文件路径、命令、错误原文、标识符、数值、函数签名与语法片段。',
    '- 忠实记录用户反馈与明确指令，尤其是纠正性的意见。',
    '- 不要提及"本次摘要请求"，也不要提及"上下文被压缩过"。',
    '- 只输出检查点正文：不要调用任何工具，不要执行任何其他动作。',
    hasPriorCheckpoint
      ? `- 上面的对话里已经包含一个 ${SUMMARY_OPEN_TAG} 块，那是**更早的检查点**。不要原样照抄：保留仍然成立的事实、丢弃已经过期的、并把更新的信息合并进同一份结构里。`
      : '',
  ].filter(line => line !== '').join('\n');
}

/** 把摘要正文包成最终写回消息列表的检查点文本。 */
export function frameCheckpoint(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${String(summary || '').trim()}\n${SUMMARY_CLOSE_TAG}`;
}

/** 从文本里取出已有的检查点正文（没有则返回 ''）。 */
export function extractCheckpoint(text: string): string {
  const value = String(text || '');
  const start = value.indexOf(SUMMARY_OPEN_TAG);
  const end = value.indexOf(SUMMARY_CLOSE_TAG);
  if (start < 0 || end <= start) return '';
  return value.slice(start + SUMMARY_OPEN_TAG.length, end).trim();
}

/** 文本里是否已有检查点。 */
export function hasCheckpoint(text: string): boolean {
  return extractCheckpoint(text).length > 0;
}

/** 章节完整性校验：模型漏章节时不静默接受（与 DSH 的"一节都不许删"对齐）。 */
export function missingCheckpointSections(summary: string): string[] {
  const value = String(summary || '');
  return COMPACTION_SECTIONS
    .filter(section => !value.includes(section.title.split(' (')[0]))
    .map(section => section.title);
}

/**
 * 去掉章节标题、(none) 占位与 Markdown 符号后的"实质正文"长度。
 * 只有标题 + (none) 的空壳检查点不算摘要（这是 fail-closed 判据的基础）。
 */
export function checkpointBodyLength(summary: string): number {
  let value = String(summary || '').replace(/\(none\)/gi, '');
  for (const section of COMPACTION_SECTIONS) value = value.split(section.title).join(' ');
  return value.replace(/[#\s\-*·]/g, '').length;
}

/**
 * 宽松校验：给**兼容模式**（thinkEngine 文本协议）用。
 * 那条路径不追求严格结构——本地模型可能只给几个章节，只要正文有实质内容就接受，
 * 完全为空（或只有标题）才判失败并退回上一版消息（不阻塞主流程）。
 */
export function validateSummaryLoose(output: string): string {
  const text = String(output || '').trim();
  // 兼容路径宽松一些：只要有实质正文（8 字以上，不含标题与 (none)）就算成功。
  if (checkpointBodyLength(text) < 8) throw new Error('摘要正文过短，未提交压缩结果');
  return text;
}
