// 自主分析引擎（v2.3.19，2026-08-17）
// 设计原则：
//   · 本地模型 token 免费、不涉安全 → 思考不设限（流式渲染思考过程，多轮工具循环）
//   · 云端调用需申请——申请发送什么提示词给云端 LLM，preview 就地审批（auto 直接放行）
//   · 尺寸/面积只是思考思路之一（注入提示词引导灵活推理），不是机械规则
// ⚠️ 2026-08-17 协议升级：v1 用 Ollama 原生 function calling（tools 参数）——与 format:'json' 冲突且本地小模型支持不稳
//   → 用户反馈对话里自主分析一直无内容。v2 改【文本协议】：模型在输出中写 [TOOL] 工具名 {...} / [CLOUD] {...} 标记行，
//   前端流式解析执行并回填 [RESULT]，不依赖模型 function calling 能力，任何模型都能工作。

export const MAX_THINK_ROUNDS = 8;
// 2026-08-18 单路高质量：每轮最多执行 2 个工具调用——强制模型一次追一个线索，
// 避免单轮并排 5 个工具浅尝辄止（prompt 之外执行层硬约束）；多余调用下一轮继续
export const MAX_TOOLS_PER_ROUND = 2;

// 云端调用描述（提示词展示用）
export function buildCloudToolDef() {
  return {
    type: 'function',
    function: {
      name: 'cloud_market_query',
      description:
        '申请调用云端模型联网查询某物料/品类的市场行情（近1-3月价格趋势）。仅当本地数据不足以判断行情时才使用。' +
        '调用前会请求用户审批，云端只会收到：物料通用名称 + 品类 + 查询问题，不含任何本地成本/供应商/项目数据。',
      parameters: {
        type: 'object',
        properties: {
          material_name: { type: 'string', description: '物料通用名称，如 液晶面板（不得含型号/厂家/金额数字）' },
          category: { type: 'string', description: '品类，如 硬件类，可空' },
          question: { type: 'string', description: '要问云端的行情问题（近1-3月价格趋势分析）' },
        },
        required: ['material_name', 'question'],
      },
    },
  };
}

// 本地工具 → Ollama tools 定义（保留兼容：schema 自动生成）
export function buildLocalToolDefs(tools: { id: string; desc: string; params: { key: string; type: string; required?: boolean; desc: string }[] }[]) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.id,
      description: t.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(t.params.map(p => [p.key, { type: p.type === 'number' ? 'number' : 'string', description: p.desc }])),
        required: t.params.filter(p => p.required).map(p => p.key),
      },
    },
  }));
}

// ===== 文本协议解析（2026-08-17 v2） ======
// 模型输出中的调用标记：
//   [TOOL] query_project_bom {"project_id":3}
//   [CLOUD] {"material_name":"液晶面板","category":"硬件类","question":"近1-3月价格趋势?"}
// 括号平衡扫描解析 JSON（支持跨行、嵌套），失败的行跳过
export function parseProtocolCalls(text: string): { kind: 'tool' | 'cloud'; name: string; args: any }[] {
  const calls: { kind: 'tool' | 'cloud'; name: string; args: any }[] = [];
  if (!text) return calls;
  const re = /\[(TOOL|CLOUD)\]\s*([a-z_]+)?\s*(\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = m[1] === 'TOOL' ? 'tool' : 'cloud';
    const name = kind === 'tool' ? (m[2] || '') : '';
    const start = m.index + m[0].length - 1; // 指向 {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (!inStr) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
    }
    if (end > start) {
      try { calls.push({ kind, name, args: JSON.parse(text.slice(start, end + 1)) }); } catch { /* 解析失败跳过 */ }
    }
  }
  return calls;
}

// 展示用：去掉 [TOOL]/[CLOUD] 调用标记（保留思考/结论正文）
export function cleanProtocolText(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[(TOOL|CLOUD)\]\s*[a-z_]+\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\[(TOOL|CLOUD)\]\s*\{[\s\S]*?\}\s*/g, '');
}

// 自主思考 system prompt：本地思考不限、云端申请、灵活思路 + 文本协议说明
export function buildThinkSystemPrompt(toolNames: string[], prefCtx = ''): string {
  return (
    '你是 CostHub 的自主分析助手。你可以：1) 调用本地工具读取项目成本数据；2) 申请调用云端模型查询市场行情；3) 基于两者综合分析，给出结论。\n' +
    '【思考原则】本地单路高质量：一次聚焦一个核心线索深挖到底，不要同一轮并排列多个浅问题、浅尝辄止——把 1 个问题分析透 好过 5 个问题各碰一下。\n' +
    '  ① 先定义问题：你想回答什么（如某项目降本空间 / 某物料是否该换供应商），再查数据。\n' +
    '  ② 每个判断必须有实际查到的数据支撑（引用项目/模块/数字），禁止凭空推断；查不到就明确说"数据不足"。\n' +
    '  ③ 交叉验证：关键结论尽量用 ≥2 个独立数据点印证（如模块占比 + 跨项目对比 + 供应商份额），单一数据点得出的结论要标注"基于单一数据"。\n' +
    '  ④ 输出结论前自检：逐条核对每句话是否有数据依据，没有支撑的删掉或明确标注为推测。\n' +
    '  ⑤ 推理要灵活多样、结合具体情况选最合理的思路，不要机械套用固定公式——例如带尺寸的物料（PCB/结构件）可以考虑单位面积成本、按同样尺寸折算；也可以考虑数量阶梯、工艺差异、供应商结构、规格差异、采购渠道等思路。\n' +
    '【工具调用协议】需要数据时，在输出中单独一行写（严格格式）：\n' +
    '[TOOL] 工具名 {"参数名":"值"}\n' +
    '例如：[TOOL] query_project_bom {"project_id":1}\n' +
    '需要云端行情时写：[CLOUD] {"material_name":"物料通用名","category":"品类","question":"行情问题"}\n' +
    '每次只写一个调用标记；调用结果会在下一轮以 [RESULT] 返回，你基于结果继续分析。\n' +
    '【工具】可用工具（名+参数说明）：\n' + toolNames.join('；') + '\n' +
    '【云端】仅当本地数据不足以判断行情时才申请 [CLOUD]。每次申请都会请求用户审批并展示将发送的提示词（已脱敏，仅物料名/品类/问题），申请时要说明为什么需要。\n' +
    '【输出】思考过程可以持续；当你得出最终结论时，直接输出结论文本，不要再写调用标记。' +
    (prefCtx ? '\n\n【用户偏好】\n' + prefCtx : '')
  );
}

// 云端申请时展示给用户的提示词（脱敏摘要：仅物料名/品类/问题三字段）
export function buildCloudReviewPrompt(call: { material_name?: string; category?: string; question?: string }): string {
  return (
    '【云端模型查询申请】将发送以下提示词给云端 LLM（已脱敏，仅含物料名/品类/问题，无任何本地成本/供应商/项目数据）：\n\n' +
    '物料：' + (call.material_name || '') + '\n' +
    '品类：' + (call.category || '未指定') + '\n' +
    '问题：' + (call.question || '近1-3月价格趋势分析（price-trend）')
  );
}

// 云端返回 → 模型可消费的文本（结构来自 trendService agentSearchLoop）
export function formatCloudResult(r: any): string {
  return (
    '云端行情：趋势 ' + (r.trend_direction || '信号不明确') +
    '，置信度 ' + (r.confidence_level || '中') +
    (r.magnitude_min != null ? '，近1-3月幅度约 ' + r.magnitude_min + '%~' + (r.magnitude_max ?? '') + '%' : '') +
    '\n摘要：' + (r.summary || '') +
    (r.suggested_action ? '\n建议：' + r.suggested_action : '')
  );
}

// ===== 通用思考循环（文本协议 v2，2026-08-17）：前端自主分析 与 后台 autoThink 共用 ======
// 流程：流式思考（onReasoning+onToken 全量累积）→ 解析 [TOOL]/[CLOUD] 标记 → 本地工具执行 / 云端审批 → [RESULT] 回填继续 → 无标记输出结论
export interface ThinkEventHandlers {
  onThought?: (text: string) => void;
  onAnswer?: (text: string) => void;
  onRoundStart?: (round: number) => void;
  onPrompt?: (role: string, content: string) => void; // DSH 式轨迹：每次发给模型的 prompt（初始 + 每轮回填结果后的继续）
  onToolResult?: (name: string, args: any, ok: boolean, text: string) => void;
  onCloudResult?: (call: any, ok: boolean, result: string) => void;
}
export interface ThinkLoopOptions {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  localTools: { id: string; desc: string; params: { key: string; type: string; required?: boolean; desc: string }[] }[];
  executeTool: (id: string, args: any) => Promise<{ ok: boolean; text: string }>;
  approveCloud?: (call: any) => Promise<boolean>;
  runCloud?: (call: any) => Promise<any>;
  onEvent?: ThinkEventHandlers;
  maxRounds?: number;
}
// 上下文预算（harness 阶段②，2026-08-18）：9B 本地模型上下文有限——历史超预算时把最旧的轮次折叠为一行摘要，
// 只保留 system + 初始问题 + 最近一轮完整（避免长任务 token 膨胀导致质量下降/报错）
export function compressMessages(messages: any[], budgetChars = 9000): any[] {
  let total = 0;
  for (const m of messages) total += (m.content || '').length;
  if (total <= budgetChars) return messages;
  const head = messages.slice(0, 2); // system + 初始 user
  const tail = messages.slice(2);
  const keepTail = Math.min(tail.length, 2); // 保留最近一轮 assistant+user
  const fold = tail.slice(0, tail.length - keepTail);
  const keptTail = tail.slice(tail.length - keepTail);
  const foldText = '（前 ' + Math.ceil(fold.length / 2) + ' 轮分析过程已压缩省略——你已掌握上下文。直接继续：如需更多数据再输出 [TOOL]/[CLOUD]，否则直接给出最终结论）';
  return [...head, { role: 'user', content: foldText }, ...keptTail];
}

export async function runThinkLoop(opts: ThinkLoopOptions): Promise<{ finalText: string; rounds: number; clouds: { call: any; ok: boolean; result: string }[] }> {
  const { startOllamaStream } = await import('./ollama');
  let messages: any[] = [{ role: 'system', content: opts.systemPrompt }, { role: 'user', content: opts.userContent }];
  opts.onEvent?.onPrompt?.('user', opts.userContent); // 轨迹：初始问题
  const maxRounds = opts.maxRounds || MAX_THINK_ROUNDS;
  const clouds: { call: any; ok: boolean; result: string }[] = [];
  let finalText = '';
  let lastClean = ''; // 每轮清理后的文本（循环耗尽时兜底作结论）
  let looped = 0;
  // 轮内去重：相同 工具+参数 只执行一次
  const callCache = new Map<string, string>();
  for (let round = 1; round <= maxRounds; round++) {
    looped = round;
    opts.onEvent?.onRoundStart?.(round);
    let buffer = ''; // 本轮模型输出全文（思考+正文，含可能的调用标记）
    await new Promise<void>((resolve, reject) => {
      startOllamaStream(
        opts.baseUrl, opts.model, messages,
        (t) => { buffer += t; opts.onEvent?.onAnswer?.(t); },
        (t) => { buffer += t; opts.onEvent?.onThought?.(t); },
        () => resolve(),
        (e) => reject(new Error(e)),
        // ⚠️ json:false 必须（默认 format:'json' 会强制只输出 JSON，思考/正文被吞 → 无内容）；num_predict 16384 不截断长思考（用户 2026-08-18：所有本地 AI 不要截断）
        { endpoint: 'native', think: true, json: false, num_predict: 16384 },
      ).catch(() => { /* 错误走 onError */ });
    });
    const clean = cleanProtocolText(buffer);
    lastClean = clean;
    const calls = parseProtocolCalls(buffer);
    if (calls.length === 0) { finalText = clean; break; }
    // ⚠️ 单路高质量：每轮只执行前 2 个调用（其余下轮继续），避免一轮并行多工具浅尝
    const activeCalls = calls.slice(0, MAX_TOOLS_PER_ROUND);
    const toolResults: { role: string; content: string }[] = [];
    for (const call of activeCalls) {
      const argsKey = (call.kind === 'tool' ? call.name : 'cloud') + '|' + JSON.stringify(call.args || {});
      const cached = callCache.get(argsKey);
      if (cached) {
        toolResults.push({ role: 'user', content: '[RESULT]（重复调用，结果未变化）\n' + cached + '\n请基于已有结果继续，不要重复调用。' });
        continue;
      }
      if (call.kind === 'cloud') {
        const ok = opts.approveCloud ? await opts.approveCloud(call.args) : true;
        let result: string;
        if (ok && opts.runCloud) {
          try {
            const r = await opts.runCloud(call.args);
            result = (r && r.reused) ? '♻（复用近期云端结论）' + formatCloudResult(r) : formatCloudResult(r);
          } catch (e: any) {
            result = '云端查询失败：' + String(e?.message || e).slice(0, 200);
            clouds.push({ call: call.args, ok: false, result });
            opts.onEvent?.onCloudResult?.(call.args, false, result);
            toolResults.push({ role: 'user', content: '[RESULT]\n' + result });
            continue;
          }
        } else if (!ok) {
          result = '用户拒绝了本次云端申请。你可以基于已有本地数据继续分析，或说明缺少行情数据无法下结论。';
        } else {
          result = '云端查询不可用（未配置执行器）。请基于本地数据分析。';
        }
        callCache.set(argsKey, result);
        clouds.push({ call: call.args, ok, result });
        opts.onEvent?.onCloudResult?.(call.args, ok, result);
        toolResults.push({ role: 'user', content: '[RESULT]\n' + result });
      } else {
        const res = await opts.executeTool(call.name, call.args);
        if (res.ok) callCache.set(argsKey, res.text);
        opts.onEvent?.onToolResult?.(call.name, call.args, res.ok, res.text);
        toolResults.push({ role: 'user', content: '[RESULT]\n' + (res.ok ? '' : '[工具失败] ') + res.text });
      }
    }
    messages.push({ role: 'assistant', content: buffer });
    const roundHint = round >= maxRounds - 1 ? '（注意：这是最后一轮——如果你已有足够信息，请直接输出最终结论，不要再调用工具）' : '';
    const followUp = toolResults.map(r => r.content).join('\n---\n') + '\n继续你的分析：如需更多数据再输出 [TOOL]/[CLOUD] 调用，否则直接给出最终结论。' + roundHint;
    opts.onEvent?.onPrompt?.('user', followUp); // 轨迹：工具结果回填后继续发给模型
    messages.push({ role: 'user', content: followUp });
    // ⚠️ 上下文预算（阶段②）：超过 9000 字符即折叠最旧轮次，保住最近一轮完整
    messages = compressMessages(messages);
  }
  // ⚠️ 循环耗尽兜底（用户反馈：跑了一会儿停了没有结论）：最后一轮有调用时 finalText 为空 → 用最后一轮清理文本作结论
  if (!finalText) finalText = lastClean || '(思考循环达到上限未输出结论——可减少工具调用轮次或直接提问)';
  return { finalText, rounds: looped, clouds };
}