import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ grants: [] as any[], search: false, responses: [] as any[], searchResults: [] as any[], blockSearch: false, autoApprove: 'unset' as 'unset' | '1' | '0' }));
vi.mock('../db', () => ({
  sha256: async (text: string) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex'),
  // ⚠️ `cloud_auto_approve_clean` 必须按"真实设置值"返回：'unset' 时把生产默认值（fallback）透传给被测代码，
  // 这样才能真正验证"默认是否自动放行"，而不是让 mock 的常量把策略行为掩盖掉。
  getSetting: vi.fn(async (key: string, fallback?: string) => (key === 'cloud_auto_approve_clean'
    ? (state.autoApprove === 'unset' ? (fallback ?? '1') : state.autoApprove)
    : 'auto')),
  setSetting: vi.fn(),
  getApiProviders: vi.fn(async () => [
    { id: 1, provider_type: 'llm', provider_name: 'DeepSeek 官方', model_name: 'deepseek-chat', base_url: 'https://api.deepseek.com/v1', is_active: true, credential_configured: true },
    ...(state.search ? [{ id: 2, provider_type: 'search', provider_name: 'Tavily', base_url: 'https://api.tavily.com/search', is_active: true, credential_configured: true }] : []),
  ]),
  saveAIRequestLog: vi.fn(), logOutboundRequest: vi.fn(), saveAIUsageLog: vi.fn(),
}));
vi.mock('../db/ai', () => ({
  approvalPayloadHash: vi.fn(async () => 'theme-hash'),
  getValidApprovalGrant: vi.fn(async input => state.grants.find(g => g.payload_hash === input.payloadHash && g.requestUrl === input.requestUrl)),
  createApprovalGrant: vi.fn(async input => {
    const grant = { ...input, id: state.grants.length + 1, payload_hash: input.payloadHash || 'theme-hash', expires_at: '2099-01-01 00:00:00' };
    state.grants.push(grant); return grant;
  }),
  saveEgressAudit: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (_command, { request }) => {
  const grant = state.grants.find(g => g.id === request.approval.grant_id);
  expect(grant.requestUrl).toBe(request.url);
  if (request.url.includes('chat/completions')) {
    expect(request.body).toBe(grant.previewJson);
    expect(request.approval.scope_level).toBe('C1_PUBLIC_CONTEXT');
    const body = JSON.parse(request.body);
    expect(Object.keys(body)).toEqual(['model', 'messages']);
    expect(body.messages[0].content).toBe(CLOUD_SYSTEM_PROMPT);
    expect(body.messages.every((m: any) => new TextEncoder().encode(m.content).length <= 12000)).toBe(true);
    expect(body.messages.slice(1).some((m: any) => /BOM|项目代号|supplier_name|bom_cost/i.test(m.content))).toBe(false);
    return { success: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(state.responses.shift() || { trend_direction: '信号不明确', summary: '公开证据不足' }) } }] }) };
  }
  expect(request.approval.scope_level).toBe('C1');
  // 模拟 Rust 网关的绑定拦截（真实事故原文），用于验证"拦截原因必须传到用户面前"。
  if (state.blockSearch) return { success: false, status: 0, body: '云端请求已拦截：查询词超出已批准的公开主题范围' };
  // ⚠️ 2026-09-21 网关规则镜像断言（逐字对齐 src-tauri/src/lib.rs 的 validate_public_query_binding）：
  // C1 检索请求体里的查询词必须与授权记录里的「物料 + 问题」规范化后**完全相等**，多一个词就被拦。
  // 真实事故：曾在查询词后拼接关键词 → 网关返回"查询词超出已批准的公开主题范围" → 0 来源 → 全部维度"公开信息不足"。
  {
    const normalize = (value: string) => value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
    const body = JSON.parse(request.body || '{}');
    const query = body.query ?? body.q;
    expect(typeof query).toBe('string');
    expect(normalize(query)).toBe(normalize(`${grant.material} ${grant.question}`));
  }
  // 搜索返回一批来源：1 条垃圾站（赌博）+ 1 条真正相关的行情页 + 1 条与物料无关的招股书。
  // 用来验证"来源质量闸门"在**真实云端链路**上生效（用户实测来源里出现过 leyu-network.com.cn）。
  return { success: true, status: 200, body: JSON.stringify({ results: state.searchResults.length ? state.searchResults : [{ title: '公开行情', url: 'https://example.com/market', content: '铜市场公开资料' }] }) };
}) }));

import { invoke } from '@tauri-apps/api/core';
import { getSetting } from '../db';
import { clearAllPending, clearCloudApprovals, confirmPending, getPendingConfirms, skipPending } from '../cloudConfirm';
import { agentSearchLoop, BUILTIN_SKILLS, createStructuredInsight } from '../trendService';
import { CLOUD_SYSTEM_PROMPT } from '../ai/cloudContext';

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  clearAllPending(); clearCloudApprovals(); state.grants = []; state.responses = []; state.search = false; state.searchResults = []; state.blockSearch = false;
  // 这些用例验证的是"**明确要求每次确认**"这条策略下的卡片/放行行为（用户可在设置里把自动放行关掉）。
  // 默认自动放行的行为由下面两个专门用例覆盖。
  state.autoApprove = '0';
  vi.clearAllMocks();
});
afterEach(() => { clearAllPending(); vi.unstubAllGlobals(); });

async function approveNext() {
  await vi.waitFor(() => expect(getPendingConfirms()).toHaveLength(1));
  const pending = getPendingConfirms()[0];
  expect(await confirmPending(pending.id)).toBe(true);
  return pending;
}

it('新洞察无搜索配置时只审批实际模型正文，确认后原调用继续；再次洞察可复用精确票', async () => {
  const task = agentSearchLoop('铜', '原材料', 'price-trend');
  await vi.waitFor(() => expect(getPendingConfirms()).toHaveLength(1));
  expect(invoke).not.toHaveBeenCalled();
  const approval = await approveNext();
  expect(approval.scopeLevel).toBe('C1_PUBLIC_CONTEXT');
  expect(approval.requestUrl).toBe('https://api.deepseek.com/v1/chat/completions');
  expect(approval.previewJson).toContain('铜');
  expect((await task).summary).toBe('公开证据不足');
  await agentSearchLoop('铜', '原材料', 'price-trend');
  expect(getPendingConfirms()).toHaveLength(0);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('一次洞察只问一次：搜索票批准后，同一轮公开模型分析票自动放行', async () => {
  state.search = true;
  // 2026-09-21 结构简化后，云端只调用**一次**模型（整合分析）——不再先问"该搜什么关键词"。
  // 原因：网关对搜索请求做载荷哈希绑定，一次审批 = 一个固定查询，让模型提出关键词在物理上不可生效。
  state.responses = [{ action: 'final', summary: '公开分析' }];
  const task = agentSearchLoop('铜', '原材料', 'price-trend');
  const searchTicket = await approveNext();
  expect(searchTicket.requestUrl).toBe('https://api.tavily.com/search');
  // 发给搜索 API 的必须是**关键词**，不能是那句常量疑问句（旧实现就是后者，召回质量崩坏）
  expect(String(searchTicket.previewJson)).toContain('铜 价格 行情 报价 涨价 供需');
  expect(String(searchTicket.previewJson)).not.toContain('查询该物料');
  // 搜索主题已获批准 → 紧随其后的"公开模型分析"票不再重复询问用户
  const result = await task;
  expect(result.summary).toBe('公开分析');
  expect(result.searchQuery).toBe('铜 价格 行情 报价 涨价 供需');
  expect(getPendingConfirms()).toHaveLength(0);
  expect(vi.mocked(invoke).mock.calls.filter(([, args]: any) => args.request.url.includes('tavily'))).toHaveLength(1);
  const chatCalls = vi.mocked(invoke).mock.calls.filter(([, args]: any) => args.request.url.includes('chat/completions'));
  expect(chatCalls).toHaveLength(1);
  expect((chatCalls[0][1] as any).request.approval.scope_level).toBe('C1_PUBLIC_CONTEXT');
});

it('深度 Skill 的方法论也只以公开安全投影发送', async () => {
  const task = agentSearchLoop('铝', '原材料', 'deep-research');
  const pending = await approveNext();
  expect(pending.previewJson).toContain(CLOUD_SYSTEM_PROMPT);
  expect((await task).summary).toBe('公开证据不足');
});

it('结构化分析不外发本地项目成本，忽略模型编造的项目影响', async () => {
  state.responses = [{ summary: '公开分析', project_impacts: [{ project_id: 99, value: 100 }] }];
  const task = createStructuredInsight('铜', BUILTIN_SKILLS.find(skill => skill.id === 'deep-research')!, [{ title: '公开行情', url: 'https://example.com/market', snippet: '公开价格资料' }], '秘密项目 CM999 单价 876.54 BOM');
  const pending = await approveNext();
  expect(pending.previewJson).not.toMatch(/秘密项目|CM999|876\.54|项目 BOM/);
  expect((await task).project_impacts).toEqual([]);
  // 本地模型研判优先，但外发（云端）只允许一次：且正文里不得出现任何本地项目/成本数据
  const cloudCalls = vi.mocked(invoke).mock.calls.filter(([, args]: any) => String(args?.request?.url || '').includes('chat/completions'));
  expect(cloudCalls).toHaveLength(1);
  expect(String((cloudCalls[0][1] as any).request.body)).not.toMatch(/秘密项目|CM999|876\.54|项目 BOM/);
});

it('来源质量闸门在真实云端链路上生效：剔除垃圾站、无关来源标注弱相关并如实告知模型', async () => {
  state.search = true;
  state.responses = [{ action: 'final', summary: '公开分析' }];
  state.searchResults = [
    { title: '乐鱼·体育官方网站 - 领先的数字体育与娱乐技术平台', url: 'https://leyu-network.com.cn/', content: '欢迎访问乐宇体育官方网站' },
    { title: '铜价行情：近期电解铜现货价格上涨', url: 'https://example.com/copper', content: '铜 价格 行情 上涨，现货报价走高' },
    { title: '某公司首次公开发行股票招股说明书', url: 'https://example.com/ipo.pdf', content: '本次公开发行股票获得证监会注册' },
  ];
  const task = agentSearchLoop('铜', '原材料', 'price-trend');
  await approveNext();
  const result = await task;
  // 垃圾站必须被剔除，真实行情页保留
  expect(result.allSources.some(source => /leyu-network/.test(source.url))).toBe(false);
  expect(result.allSources.some(source => /example\.com\/copper/.test(source.url))).toBe(true);
  expect(result.sourceQuality).toContain('已剔除 1 条无关/垃圾来源');
  // 招股书不含"铜" → 属于"未直接提及物料"，但既然有命中来源就不该标弱相关
  expect(result.sourceQuality).not.toContain('弱相关');
});

it('来源全部与物料无关时：不返回空，而是标注弱相关并把这件事写进模型提示词', async () => {
  state.search = true;
  state.responses = [{ action: 'final', summary: '公开分析' }];
  state.searchResults = [
    { title: '内存涨价推高手机成本', url: 'https://example.com/memory', content: '三星、SK海力士优先供AI市场' },
  ];
  const task = agentSearchLoop('适配器', '电源类', 'price-trend');
  await approveNext();
  const result = await task;
  expect(result.allSources).toHaveLength(1);
  expect(result.sourceQuality).toContain('弱相关');
  // 提示词里必须明确警告"这些来源没有直接提及该物料"，否则模型会把泛新闻当成本物料行情
  const chatBody = String((vi.mocked(invoke).mock.calls.find(([, args]: any) => String(args?.request?.url || '').includes('chat/completions'))?.[1] as any)?.request?.body || '');
  expect(chatBody).toContain('均未直接提及');
  expect(chatBody).toContain('公开信息不足');
});

it('网关拦截检索时：抛出可操作的原因，既不伪装成结论、也不偷偷换本地知识通道', async () => {
  state.search = true;
  state.blockSearch = true;
  const task = agentSearchLoop('铜', '原材料', 'price-trend');
  await approveNext();
  // 1) 必须把网关的原始原因带出来（用户要能看到"哪里出了问题"）
  await expect(task).rejects.toThrow(/查询词超出已批准的公开主题范围/);
  // 2) 必须是"需重新审批"这一档错误名：Decomposition 会 message.warning 展示原因并保留待洞察状态；
  //    同时 agentSearchLoop 的 isUserStop 命中它 → 不会静默降级成本地知识分析
  await expect(task.catch((error: any) => error?.name)).resolves.toBe('CloudApprovalUnavailableError');
  // 3) 拦截只发一次（确定性失败不重试）
  expect(vi.mocked(invoke).mock.calls.filter(([, args]: any) => args.request.url.includes('tavily'))).toHaveLength(1);
});

it('默认策略（未改过设置）：像「铜」这种审查零命中的公开行情查询直接放行，不再反复让人确认', async () => {
  state.autoApprove = 'unset'; // 把生产默认值透传进来 —— 验证"默认就是自动放行"
  state.search = true;
  state.responses = [{ action: 'final', summary: '公开分析' }];
  const task = agentSearchLoop('铜', '原材料', 'price-trend');
  const result = await task;
  // 全程没有任何待审批卡：搜索票 + 公开模型分析票都被代码审查放行
  expect(getPendingConfirms()).toHaveLength(0);
  expect(result.summary).toBe('公开分析');
  // 但外发仍然真实发生，且查询词依旧受网关绑定约束（放行 ≠ 跳过审查）
  expect(vi.mocked(invoke).mock.calls.filter(([, args]: any) => args.request.url.includes('tavily'))).toHaveLength(1);
});

it('即使用户打开自动放行，物料名里带金额的内容也过不了审查：直接报原因，绝不悄悄外发', async () => {
  state.autoApprove = 'unset';
  state.search = true;
  const task = agentSearchLoop('铜 成本 12.5 元', '原材料', 'price-trend');
  // 在生成审批卡之前就被本地审查拦下 → 一张卡都没有、一个云端请求都没有
  await expect(task).rejects.toThrow(/敏感审查未通过/);
  expect(getPendingConfirms()).toHaveLength(0);
  expect(invoke).not.toHaveBeenCalled();
  // 而且必须是"明确报错"，不能静默降级成本地知识分析（错误名走 CloudApproval* 一档 → UI 会弹出原因）
  await expect(task.catch((error: any) => error?.name)).resolves.toBe('CloudApprovalValidationError');
});

it('拒绝结束原任务且不降级换供应商发送；纯本地模式不排队', async () => {
  const task = agentSearchLoop('铝', '原材料', 'price-trend');
  const rejected = expect(task).rejects.toThrow('已取消本次云端发送');
  await vi.waitFor(() => expect(getPendingConfirms()).toHaveLength(1));
  await skipPending(getPendingConfirms()[0].id);
  await rejected;
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(getSetting).mockResolvedValue('local_only');
  await expect(agentSearchLoop('铜', '原材料', 'price-trend')).rejects.toThrow('未获批准');
  expect(getPendingConfirms()).toHaveLength(0);
});
