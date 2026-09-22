import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  sha256: async (text: string) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex'),
  // ⚠️ 2026-09-21：`cloud_auto_approve_clean` 从一开始就显式返回 '0'（=每次都要我确认），
  // 否则这个文件里的"要出卡"用例会被新的默认自动放行策略吞掉。自动放行的默认行为由专门用例覆盖。
  getSetting: vi.fn(async (key: string) => (key === 'cloud_auto_approve_clean' ? '0' : 'auto')),
  setSetting: vi.fn(async () => undefined),
}));
const grantCalls = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../db/ai', () => ({
  approvalPayloadHash: vi.fn(async () => 'hash'),
  getValidApprovalGrant: vi.fn(async () => null),
  createApprovalGrant: vi.fn(async (input: any) => {
    grantCalls.calls.push(input);
    return { id: grantCalls.calls.length, payload_hash: 'hash', expires_at: '2099-01-01 00:00:00' };
  }),
}));

import { clearAllPending, applySuggestedQuery, approvePending, getPendingConfirms, isCleanAutoApproveEnabled, requestCloudConfirm, switchPendingToPublicModel, waitForCloudApproval } from '../cloudConfirm';
import { getSetting } from '../db';
import { getValidApprovalGrant } from '../db/ai';

describe('云端确认队列', () => {
  beforeEach(() => {
    clearAllPending();
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === 'cloud_auto_approve_clean' ? '0' : 'auto'));
  });

  it('纯本地模式不会进入云端确认队列', async () => {
    vi.mocked(getSetting).mockResolvedValue('local_only');
    expect(await requestCloudConfirm({ material: '适配器', category: '电源类' })).toBe(false);
    expect(getPendingConfirms()).toHaveLength(0);
  });

  it('没有入队时明确说明未生成审批卡', async () => {
    vi.mocked(getSetting).mockResolvedValue('local_only');
    await expect(waitForCloudApproval({ material: '适配器', category: '电源类' })).rejects.toMatchObject({
      name: 'CloudApprovalUnavailableError',
      message: expect.stringContaining('未生成待审批卡'),
    });
  });

  it('自动模式下同一物料和品类只保留一条待确认项', async () => {
    expect(await requestCloudConfirm({ material: '适配器', category: '电源类' })).toBe(false);
    expect(await requestCloudConfirm({ material: '适配器', category: '电源类' })).toBe(false);
    expect(getPendingConfirms()).toHaveLength(1);
  });

  it('数据库授权失效后清理旧会话票并重新进入待确认', async () => {
    vi.mocked(getValidApprovalGrant)
      .mockResolvedValueOnce({ id: 7, payload_hash: 'hash', expires_at: '2099-01-01 00:00:00' } as any)
      .mockResolvedValueOnce(null);
    const payload = { material: '适配器', category: '电源类', question: '公开行情' };
    expect(await requestCloudConfirm(payload)).toBe(true);
    expect(await requestCloudConfirm(payload)).toBe(false);
    expect(getPendingConfirms()).toHaveLength(1);
  });

  it('does not merge same content from different request ids', async () => {
    const base = { material: '适配器', category: '电源类', question: '公开行情', requestId: 'request-a', sessionId: 'session-a', runId: 'run-a' };
    await requestCloudConfirm(base);
    await requestCloudConfirm({ ...base, requestId: 'request-b', sessionId: 'session-b', runId: 'run-b' });
    expect(getPendingConfirms().map(item => item.requestId)).toEqual(['request-a', 'request-b']);
  });

  it('命中敏感规则时不静默丢弃，而是生成可读的审批卡（标出规则、命中文字与替代方案）', async () => {
    expect(await requestCloudConfirm({ material: 'M270 驱动板', category: '显示器', question: '成本 ¥128 是否偏高' })).toBe(false);
    const items = getPendingConfirms();
    expect(items).toHaveLength(1);
    expect(items[0].riskLevel).toBe('hard');
    expect(items[0].riskItems?.some(risk => risk.level === 'hard')).toBe(true);
    expect(items[0].riskVerdict).toContain('不可外发');
    expect(items[0].suggestedQuery?.material).toBeTruthy();
    expect(items[0].localAudit?.status).toBe('blocked');
  });

  it('硬命中不允许直接批准；采用建议通用名后可以正常批准', async () => {
    await requestCloudConfirm({ material: 'M270 驱动板', category: '显示器', question: '成本 ¥128 是否偏高' });
    const blocked = getPendingConfirms()[0];
    const denied = await approvePending(blocked.id);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('建议通用名');

    const applied = await applySuggestedQuery(blocked.id);
    expect(applied.ok).toBe(true);
    const revised = getPendingConfirms()[0];
    expect(revised.riskLevel).not.toBe('hard');
    expect(revised.gatewayAcceptable).not.toBe(false);
    const approved = await approvePending(revised.id);
    expect(approved.ok).toBe(true);
    expect(getPendingConfirms()).toHaveLength(0);
  });

  it('物料名含型号数字时普通通道不放行，可切到「公开型号」通道', async () => {
    await requestCloudConfirm({ material: 'SC8562 芯片', category: '显示器', question: '公开价格趋势' });
    const item = getPendingConfirms()[0];
    expect(item.gatewayAcceptable).toBe(false);
    const denied = await approvePending(item.id);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('公开型号');
    const switched = await switchPendingToPublicModel(item.id);
    expect(switched.ok).toBe(true);
    expect(getPendingConfirms()[0].scopeLevel).toBe('C1_PUBLIC_MODEL');
    expect(getPendingConfirms()[0].gatewayAcceptable).toBe(true);
  });

  it('同一轮洞察：搜索主题批准后，公开投影的模型分析票自动放行（不再问第二次）', async () => {
    await requestCloudConfirm({ material: '整流器', category: '电源类', question: '公开行情' });
    const searchTicket = getPendingConfirms()[0];
    expect((await approvePending(searchTicket.id)).ok).toBe(true);

    const second = await requestCloudConfirm({
      material: '公开上下文', category: '公开模型上下文', question: '仅依据已批准公开内容回答用户问题',
      scopeLevel: 'C1_PUBLIC_CONTEXT', previewJson: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: '公开投影正文' }] }),
      requestUrl: 'https://api.deepseek.com/v1/chat/completions', requestMethod: 'POST',
      topicMaterial: '整流器', topicCategory: '电源类', publicProjection: true,
    });
    expect(second).toBe(true);
    expect(getPendingConfirms()).toHaveLength(0);
  });

  // ⚠️ 2026-09-21 用户实测："让我反复确认云端行情查询提交，这个是个大bug"。
  // 根因：`costhub-insight-request`（"批准后继续"的信号）**只有监听方、从来没有派发方**，
  // 所以点了批准之后什么都不会发生，用户只能重新提问 → 又看到一次审批 → 反复确认。
  it('批准后必须派发"继续"事件，并带上物料/品类（否则批准等于没批准）', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen: any[] = [];
    target.addEventListener('costhub-insight-request', (event: any) => seen.push(event.detail));

    await requestCloudConfirm({ material: '整流器', category: '电源类', question: '公开行情' });
    const ticket = getPendingConfirms()[0];
    expect((await approvePending(ticket.id)).ok).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ material: expect.stringContaining('整流器'), pendingId: ticket.id });
    vi.unstubAllGlobals();
  });

  it('自动放行默认开启（用户：像铜这种有什么敏感的，可以直接自己通过），设置关掉后立即恢复每次确认', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string, fallback?: string) => (key === 'cloud_auto_approve_clean' ? (fallback ?? '1') : 'auto'));
    expect(await isCleanAutoApproveEnabled()).toBe(true);
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === 'cloud_auto_approve_clean' ? '0' : 'auto'));
    expect(await isCleanAutoApproveEnabled()).toBe(false);
    // 默认（未设置过）时：像「铜」这种零命中的公开行情查询不再出卡
    vi.mocked(getSetting).mockImplementation(async (key: string, fallback?: string) => (key === 'cloud_auto_approve_clean' ? (fallback ?? '1') : 'auto'));
    expect(await requestCloudConfirm({ material: '铜', category: '原材料', question: '价格 行情 报价 涨价 供需' })).toBe(true);
    expect(getPendingConfirms()).toHaveLength(0);
  });

  it('未经批准的物料主题 + 非公开投影正文：仍然要出卡', async () => {
    const queued = await requestCloudConfirm({
      material: '公开上下文', category: '公开模型上下文', question: '仅依据已批准公开内容回答用户问题',
      scopeLevel: 'C1_PUBLIC_CONTEXT', previewJson: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '任意正文' }] }),
      requestUrl: 'https://api.deepseek.com/v1/chat/completions', requestMethod: 'POST',
      topicMaterial: '未经批准的物料', publicProjection: false,
    });
    expect(queued).toBe(false);
    expect(getPendingConfirms()).toHaveLength(1);
  });

  it('记住此主题时签发长效主题票（grantClass=theme + 7 天有效期）', async () => {
    grantCalls.calls.length = 0;
    await requestCloudConfirm({ material: '适配器', category: '电源类', question: '公开行情' });
    const item = getPendingConfirms()[0];
    const approved = await approvePending(item.id, { remember: true });
    expect(approved.ok).toBe(true);
    expect(getPendingConfirms()).toHaveLength(0);
    expect(grantCalls.calls.at(-1)?.grantClass).toBe('theme');
    expect(grantCalls.calls.at(-1)?.expiresMinutes).toBe(10080);

    await requestCloudConfirm({ material: '整流器', category: '电源类', question: '公开行情' });
    const once = await approvePending(getPendingConfirms()[0].id);
    expect(once.ok).toBe(true);
    expect(grantCalls.calls.at(-1)?.grantClass).toBe('payload');
    expect(grantCalls.calls.at(-1)?.expiresMinutes).toBe(30);
  });
});
