import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown, Input, message, Tag } from 'antd';
import {
  applySuggestedQuery,
  approvePending,
  getPendingConfirms,
  revisePendingConfirm,
  skipPending,
  switchPendingToPublicModel,
  updatePendingConfirmPreview,
  type PendingConfirm,
} from '../cloudConfirm';
import { findSensitiveRanges } from '../ai/security';
import { reviewWithLocalModel, type LocalModelFinding, type LocalSensitiveReview } from '../ai/localSensitiveReview';
import { loadBuiltinTemplates, splitPreviewPayload, type BuiltinTemplate, type PromptSegment } from '../ai/promptTemplates';

export interface ApprovalDecisionOptions { remember?: boolean; force?: boolean }

export interface CloudApprovalCardProps {
  title: string;
  content?: string;
  previewJson?: string;
  target?: string;
  purpose?: string;
  requestId?: string;
  payloadVersion?: number;
  requirementKind?: string;
  requirementTitle?: string;
  material?: string;
  category?: string;
  question?: string;
  localAudit?: PendingConfirm['localAudit'];
  pendingId?: string;
  canApprove?: boolean;
  busy?: boolean;
  searchScope?: boolean;
  onDecision: (approved: boolean, options?: ApprovalDecisionOptions) => void | Promise<void>;
  onSkipLongTerm?: () => void | Promise<void>;
  onRequestRevision?: () => void | Promise<void>;
  onModify?: (nextPreviewJson: string) => void | Promise<void>;
  onReviseSearch?: (patch: { material: string; category: string; question: string }) => void | Promise<void>;
}

function highlightedText(text: string, modelFindings: LocalModelFinding[] = []) {
  const accepted: Array<{ start: number; end: number; kind: 'rule' | 'model'; title: string }> = findSensitiveRanges(text).map(range => ({
    start: range.start,
    end: range.end,
    kind: 'rule' as const,
    title: `本地规则：${range.pattern}`,
  }));
  for (const finding of modelFindings) {
    if (!finding.quote) continue;
    const overlaps = accepted.some(mark => finding.start < mark.end && finding.end > mark.start);
    if (overlaps) continue;
    accepted.push({
      start: finding.start,
      end: finding.end,
      kind: 'model',
      title: `本地模型提示（可能误判）：${finding.riskType} · ${finding.reason} · 置信度 ${Math.round(finding.confidence * 100)}%`,
    });
  }
  if (!accepted.length) return text;
  accepted.sort((a, b) => a.start - b.start || b.end - a.end);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  accepted.forEach((mark, index) => {
    if (mark.start > cursor) nodes.push(<span key={`text-${index}`}>{text.slice(cursor, mark.start)}</span>);
    nodes.push(<mark key={`match-${index}`} title={mark.title} className={mark.kind === 'rule' ? 'ai-sensitive-mark' : 'ai-sensitive-mark is-warn'}>{text.slice(mark.start, mark.end)}</mark>);
    cursor = mark.end;
  });
  if (cursor < text.length) nodes.push(<span key="text-tail">{text.slice(cursor)}</span>);
  return nodes;
}

function payloadStats(previewJson: string) {
  let messageCount = 0;
  let hasTools = false;
  try {
    const payload = JSON.parse(previewJson) as { messages?: unknown; input?: unknown; tools?: unknown[] };
    const list = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : [];
    messageCount = list.length;
    hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
  } catch { /* 文本仍按完整载荷展示，解析失败由审批卡明确提示 */ }
  return { messageCount, hasTools };
}

const ROLE_LABEL: Record<string, string> = { system: '系统提示词', user: '用户问题', assistant: '模型历史回复', tool: '工具结果' };

export function CloudApprovalCard({
  title,
  content = '',
  previewJson,
  target,
  purpose,
  requestId,
  payloadVersion,
  requirementKind,
  requirementTitle,
  material = '',
  category = '',
  question = '',
  localAudit,
  pendingId,
  canApprove = true,
  busy = false,
  searchScope = false,
  onDecision,
  onSkipLongTerm,
  onRequestRevision,
  onModify,
  onReviseSearch,
}: CloudApprovalCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const [deciding, setDeciding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [previewOverride, setPreviewOverride] = useState<string | undefined>(undefined);
  const [revisionRequested, setRevisionRequested] = useState(false);
  const [searchDraft, setSearchDraft] = useState({ material, category, question });
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const [modelReview, setModelReview] = useState<LocalSensitiveReview>({ status: 'not_run', findings: [] });
  const [templates, setTemplates] = useState<BuiltinTemplate[]>([]);
  const [liveItem, setLiveItem] = useState<PendingConfirm | undefined>(undefined);
  const [actionNote, setActionNote] = useState('');

  // 卡片自身订阅待审批队列：采用建议名/换通道后无需父组件刷新即更新。
  useEffect(() => {
    if (!pendingId) return;
    const refresh = () => setLiveItem(getPendingConfirms().find(item => item.id === pendingId));
    refresh();
    window.addEventListener('costhub-cloud-pending', refresh);
    return () => window.removeEventListener('costhub-cloud-pending', refresh);
  }, [pendingId]);

  useEffect(() => { let alive = true; void loadBuiltinTemplates().then(list => { if (alive) setTemplates(list); }); return () => { alive = false; }; }, []);

  const item = liveItem;
  const effectiveMaterial = item?.material ?? material;
  const effectiveCategory = item?.category ?? category;
  const effectiveQuestion = item?.question ?? question;
  const effectiveAudit = item?.localAudit ?? localAudit;
  const riskItems = item?.riskItems || [];
  // ⚠️ 2026-09-21：去掉乐观默认——缺审查结果时显示"未审查"，不能显示成"未命中"。
  // 旧代码 `item?.riskLevel || (… ? 'hard' : 'clear')` 把"审查从未运行"与"审查通过"渲染成一模一样，
  // 用户据此以为系统做了判断（这正是用户质疑"并没有真实判断"的来源之一）。
  const riskLevel: 'hard' | 'soft' | 'clear' | 'unreviewed' = item?.riskLevel
    || (effectiveAudit?.status === 'blocked' ? 'hard' : effectiveAudit?.status === 'pass' ? 'clear' : 'unreviewed');
  const suggested = item?.suggestedQuery;
  const gatewayAcceptable = item?.gatewayAcceptable !== false;
  const overrideRisk = riskLevel === 'soft' && gatewayAcceptable;

  const fullPayload = Boolean(previewJson || previewOverride || item?.previewJson);
  const shownContent = previewOverride ?? item?.previewJson ?? previewJson ?? content;
  const stats = fullPayload ? payloadStats(shownContent) : { messageCount: 0, hasTools: false };
  const displayVersion = (payloadVersion || item?.payloadVersion || 1) + (previewOverride ? 1 : 0);
  const ruleRanges = findSensitiveRanges(shownContent);
  const rangeMatches = ruleRanges.map(range => `${range.pattern}: ${range.sample}`);
  const modelMatches = modelReview.findings.map(finding => `${finding.riskType}: ${finding.quote}`);
  const matches = [...(effectiveAudit?.matches?.length ? effectiveAudit.matches : rangeMatches), ...modelMatches];
  const queryHits = query ? shownContent.toLocaleLowerCase().split(query.toLocaleLowerCase()).length - 1 : 0;
  const split = useMemo(() => (fullPayload ? splitPreviewPayload(shownContent, templates) : null), [shownContent, templates, fullPayload]);

  useEffect(() => {
    let alive = true;
    if (!shownContent || riskLevel === 'hard') { setModelReview({ status: 'not_run', findings: [] }); return () => { alive = false; }; }
    void reviewWithLocalModel(shownContent).then(result => { if (alive) setModelReview(result); });
    return () => { alive = false; };
  }, [shownContent, riskLevel]);

  const decide = async (approved: boolean, options?: ApprovalDecisionOptions) => {
    if (deciding || busy) return;
    setDeciding(true);
    try { await onDecision(approved, options); }
    finally { setDeciding(false); }
  };

  const runAction = async (label: string, action: () => Promise<{ ok: boolean; reason?: string }>) => {
    setSaving(true);
    setActionNote('');
    try {
      const result = await action();
      if (result.ok) message.success(label);
      else { setActionNote(result.reason || '操作未完成'); message.warning(result.reason || '操作未完成'); }
    } catch (error) {
      setActionNote(String((error as Error)?.message || error));
    } finally { setSaving(false); }
  };

  const beginEdit = () => {
    setDraft(shownContent);
    setSearchDraft({ material: effectiveMaterial, category: effectiveCategory, question: effectiveQuestion });
    setEditing(true);
  };
  const saveEdit = async () => {
    if (searchScope && onReviseSearch) {
      setSaving(true);
      try {
        await onReviseSearch({
          material: searchDraft.material.trim(),
          category: searchDraft.category.trim(),
          question: searchDraft.question.trim(),
        });
        setRevisionRequested(false);
        setEditing(false);
        message.success('已更新搜索主题和完整载荷，请重新核对后批准。');
      } catch (error) {
        message.error('保存修改失败：' + String((error as Error)?.message || error));
      } finally { setSaving(false); }
      return;
    }
    if (!onModify) return;
    setSaving(true);
    try {
      JSON.parse(draft);
      await onModify(draft);
      setPreviewOverride(draft);
      setEditing(false);
      message.success('已更新候选载荷；版本和检查结果将重新生成，请核对后再批准。');
    } catch (error) {
      message.error('保存修改失败：' + String((error as Error)?.message || error));
    } finally { setSaving(false); }
  };

  const requestRevision = () => {
    setRevisionRequested(true);
    void onRequestRevision?.();
    if (onModify || onReviseSearch) beginEdit();
  };

  const copyPayload = async () => {
    if (!fullPayload) return;
    try {
      await navigator.clipboard.writeText(shownContent);
      message.success('已复制完整请求体');
    } catch { message.error('复制失败，请直接在载荷区域选择文本'); }
  };

  const requirementLabel = requirementKind === 'user_request' ? '用户单独需求'
    : requirementKind === 'insight' ? '洞察需求'
      : requirementKind === 'background_insight' ? '后台洞察任务'
        : requirementKind === 'public_model' ? '公开型号查询'
          : requirementKind === 'analysis' ? '分析任务'
            : '云端发送请求';

  const renderSegments = (segments: PromptSegment[]) => segments.map((segment, index) => segment.kind === 'builtin'
    ? <details key={`builtin-${index}`} className="ai-prompt-boilerplate">
        <summary>内置模板已折叠 {segment.text.length.toLocaleString()} 字 · {segment.label || '内置提示词'}（点开查看）</summary>
        <pre>{segment.text}</pre>
      </details>
    : <pre key={`dynamic-${index}`} className="ai-prompt-dynamic" style={{ fontSize: `${11 * zoom}px` }} aria-label="本次新增/动态内容">{highlightedText(segment.text, modelReview.findings)}</pre>);

  const riskTag = riskLevel === 'hard'
    ? <Tag color="red">不可外发 · 命中本地业务信息</Tag>
    : riskLevel === 'soft'
      ? <Tag color="gold">可发送 · 需你确认 {riskItems.length} 处</Tag>
      : riskLevel === 'unreviewed'
        ? <Tag>未审查 · 没有可用的检查结果</Tag>
        : <Tag color="green">未命中敏感规则</Tag>;

  return <section ref={cardRef} aria-label={title} className="ai-approval-card">
    <div className="ai-approval-card-heading">
      <strong>{title}</strong>
      <span className="ai-approval-state">等待你审批</span>
    </div>

    <div className="ai-approval-sections">
      {/* ① 需求：这条请求是谁发起的、要解决什么 */}
      <section className="ai-approval-section" data-part="need">
        <div className="ai-approval-section-head"><span>① 这条请求要做什么</span></div>
        <div className="ai-approval-requirement">
          <span>{requirementLabel}</span>
          <strong>{requirementTitle || purpose || title}</strong>
        </div>
        <div className="ai-approval-card-meta">
          <span>物料：{effectiveMaterial || '—'}</span>
          <span>品类：{effectiveCategory || '—'}</span>
          {effectiveQuestion && <span>问题：{effectiveQuestion}</span>}
        </div>
        {(target || requestId) && <div className="ai-approval-card-meta">
          {target && <span>目标：{target}</span>}
          {requestId && <span>请求：{requestId}</span>}
          <span>载荷版本：v{displayVersion}</span>
        </div>}
      </section>

      {/* ② 将发送的提示词：内置模板折叠，只看新增内容 */}
      <section className="ai-approval-section" data-part="prompt">
        <div className="ai-approval-section-head">
          <span>② 将要发出去的内容</span>
          <span className="ai-approval-section-note">
            {searchScope ? '搜索主题授权 · 不含模型分析授权' : split && split.builtinChars > 0
              ? `${shownContent.length.toLocaleString()} 字符（内置模板 ${split.builtinChars.toLocaleString()} 字已折叠，需要你核对的只有 ${split.dynamicChars.toLocaleString()} 字）`
              : fullPayload ? `${shownContent.length.toLocaleString()} 字符 · ${stats.messageCount} 条消息` : '未读取完整请求体'}
          </span>
        </div>
        <div className="ai-approval-payload-toolbar">
          <span>{split ? '内置模板（技能提示词/系统提示词）已折叠：确认无误、只看下面高亮的动态内容即可。' : '以下是完整待发送内容，请核对高亮处。'}</span>
          <span className="ai-approval-payload-tools">
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索正文" aria-label="搜索审批正文" />
            {query && ` ${queryHits} 处`}
            <button type="button" onClick={() => setZoom(value => Math.max(.8, Number((value - .1).toFixed(1))))} aria-label="缩小正文">A−</button>
            <button type="button" onClick={() => setZoom(value => Math.min(1.6, Number((value + .1).toFixed(1))))} aria-label="放大正文">A＋</button>
          </span>
        </div>
        {editing ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {searchScope && onReviseSearch ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <Input size="small" value={searchDraft.material} onChange={event => setSearchDraft(prev => ({ ...prev, material: event.target.value }))} placeholder="物料通用名（不含型号/金额/供应商/项目信息）" aria-label="修改物料名" />
                <Input size="small" value={searchDraft.category} onChange={event => setSearchDraft(prev => ({ ...prev, category: event.target.value }))} placeholder="品类（可空）" aria-label="修改品类" />
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={searchDraft.question} onChange={event => setSearchDraft(prev => ({ ...prev, question: event.target.value }))} placeholder="公开查询问题" aria-label="修改查询问题" />
              </div>
            ) : (
              <textarea
                value={draft}
                onChange={event => setDraft(event.target.value)}
                aria-label="修改候选外发载荷"
                className="ai-approval-editor"
              />
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="small" type="primary" loading={saving} onClick={() => void saveEdit()}>保存修改</Button>
              <Button size="small" disabled={saving} onClick={() => setEditing(false)}>取消修改</Button>
            </div>
          </div>
        ) : (
          <>
            {split ? (
              <div className="ai-approval-prompt-view">
                {split.messages.map((message, index) => <div key={index} className="ai-prompt-message">
                  <div className="ai-prompt-message-head">
                    <b>{ROLE_LABEL[message.role] || message.role}</b>
                    <span>{message.dynamicChars > 0 ? `需核对 ${message.dynamicChars.toLocaleString()} 字` : '全部为内置模板'}</span>
                  </div>
                  {renderSegments(message.segments)}
                </div>)}
              </div>
            ) : (
              <pre className="ai-approval-payload" style={{ fontSize: `${11 * zoom}px` }} aria-label="实际待发送完整内容">{highlightedText(shownContent || '未读取完整请求体，暂不允许发送', modelReview.findings)}</pre>
            )}
            {fullPayload && <div className="ai-approval-tools-note">{stats.hasTools ? '本次包含工具定义/结果，请在完整载荷中核对。' : '本次不发送工具。'}</div>}
            {!fullPayload && !searchScope && <div className="ai-approval-blocked">审批前未能读取完整系统、开发者、用户、助手消息及业务请求，已阻止发送。</div>}
            <div className="ai-approval-payload-toolbar">
              <span />
              {fullPayload && <Button size="small" onClick={() => void copyPayload()}>复制完整载荷</Button>}
            </div>
          </>
        )}
      </section>

      {/* ③ 判定：命中哪条规则、哪段文字、工具给出的替代方案 */}
      <section className="ai-approval-section" data-part="verdict">
        <div className="ai-approval-section-head"><span>③ 本地判定</span><span>{riskTag}</span></div>
        <div className={`ai-approval-audit is-${riskLevel === 'hard' ? 'blocked' : riskLevel === 'soft' ? 'soft' : riskLevel === 'unreviewed' ? 'unknown' : 'clear'}`}>
          <strong>{item?.riskVerdict || (riskLevel === 'hard' ? '命中本地业务信息，不可外发' : riskLevel === 'soft' ? '公开可查但敏感，需要你确认' : riskLevel === 'unreviewed' ? '这条请求没有可用的本地审查结果' : '未命中敏感规则')}</strong>
          <span>{riskLevel === 'clear'
            ? '规则检查只用于标记，不替代你的审批；确认内容无误即可批准。'
            : riskLevel === 'unreviewed'
              ? '注意：这里没有"检查通过"的结论，只是没有拿到检查结果。请自行核对下面将要发出的内容再决定。'
              : '规则命中不一定是错误——请核对下面每一条命中内容，再决定放行、改名还是跳过。'}</span>
          {matches.length > 0 && <small>{matches.join('；')}</small>}
        </div>

        {riskItems.length > 0 && <div className="ai-approval-findings">
          <div className="ai-approval-findings-head">
            <b>{riskLevel === 'hard' ? '为什么不能发' : '需要你确认的地方'}</b>
            {(onModify || onReviseSearch) ? <Button size="small" type="link" onClick={beginEdit} style={{ fontSize: 11, padding: 0, height: 'auto' }}>手动修改</Button> : null}
          </div>
          {riskItems.map((risk, index) => <div key={`risk-${index}`} className={`ai-approval-finding ${risk.level === 'hard' ? 'is-rule' : 'is-model'}`}>
            <span>{risk.level === 'hard' ? '不可外发' : '需确认'} · {risk.field === 'material' ? '物料名' : risk.field === 'category' ? '品类' : '问题'} · {risk.rule}</span>
            <code>{risk.sample}</code>
            <small>{risk.advice}</small>
          </div>)}
        </div>}

        {suggested && <div className="ai-approval-redaction">
          <div className="ai-approval-redaction-head"><b>工具建议：换个名称再发</b><span>{suggested.changes.join('；')}</span></div>
          <div className="ai-approval-redaction-body">
            <span>物料通用名</span><code>{suggested.material}</code>
            {suggested.category && <><span>品类</span><code>{suggested.category}</code></>}
            <span>查询问题</span><code>{suggested.question}</code>
          </div>
          {pendingId && <div className="ai-approval-actions">
            <Button size="small" type="primary" loading={saving} onClick={() => void runAction('已改用建议的通用名，请再确认一次', () => applySuggestedQuery(pendingId))}>采用建议通用名</Button>
            {riskLevel !== 'clear' && <Button size="small" loading={saving} onClick={() => void runAction('已切到「公开型号」通道，请在卡内确认后发送', () => switchPendingToPublicModel(pendingId))}>改用公开型号通道</Button>}
          </div>}
        </div>}

        {gatewayAcceptable === false && !suggested && <div className="ai-approval-blocked">
          网关（本地硬边界）不允许这条内容外发：物料名含型号/规格数字，或含本地业务字段。请修改内容后重试。
        </div>}

        {modelReview.status === 'findings' && <details className="ai-approval-model-findings">
          <summary>本地模型另提示 {modelReview.findings.length} 处可能敏感（可能误判，供参考）</summary>
          {modelReview.findings.map((finding, index) => <div key={`model-${index}`} className="ai-approval-finding is-model"><span>{finding.riskType} · 置信度 {Math.round(finding.confidence * 100)}%</span><code>{finding.quote}</code><small>{finding.reason}</small></div>)}
        </details>}

        {revisionRequested && <div className="ai-approval-revision">已暂停发送，任务保持等待。请修改后点击批准继续。{!onModify && !onReviseSearch ? ' 当前审批类型暂不支持卡内编辑，请修改原始需求后重新发起；任务不会自动终止。' : ''}</div>}
        {actionNote && <div className="ai-approval-revision">{actionNote}</div>}
      </section>

      {/* ④ 操作 */}
      <section className="ai-approval-section" data-part="action">
        <div className="ai-approval-section-head"><span>④ 你可以怎么做</span></div>
        <p className="ai-approval-card-note">
          批准=授权这一次发送（同一主题有效期内不再重复询问）。金额、供应商、项目代号这类本地数据在网关层没有出口，只能改用通用名；
          型号/规格属于公开信息，你可以强制发送，也可以走「公开型号」通道。
        </p>
        <div className="ai-approval-actions">
          <Button size="small" type="primary" disabled={!canApprove || riskLevel === 'hard' || !gatewayAcceptable || deciding || busy || editing || saving} loading={busy && canApprove} onClick={() => void decide(true)}>批准本次发送</Button>
          {(onSkipLongTerm || pendingId) && <Button size="small" disabled={deciding || busy || editing || saving} onClick={() => void decide(true, { remember: true })}>记住此主题（7 天不再问）</Button>}
          {overrideRisk && <Button size="small" danger disabled={deciding || busy || editing || saving} onClick={() => void decide(true, { force: true })}>我知道风险，强制发送</Button>}
          <Button size="small" disabled={deciding || busy || editing || saving} onClick={requestRevision}>退回修改</Button>
          {(onModify || onReviseSearch) ? <Button size="small" disabled={deciding || busy || saving} onClick={() => editing ? setEditing(false) : beginEdit()}>{editing ? '取消修改' : '修改内容'}</Button> : null}
          <Dropdown menu={{ items: [
            { key: 'terminate', label: '拒绝并终止本次', onClick: () => void decide(false) },
            ...(onSkipLongTerm ? [{ key: 'long-term', label: '30 天内忽略同类', onClick: () => void onSkipLongTerm() }] : []),
          ] }}><Button size="small" type="text" disabled={deciding || busy || editing || saving}>更多</Button></Dropdown>
        </div>
      </section>
    </div>
  </section>;
}

/** Background approvals stay separate from the current conversation. */
export default function CloudApprovalCards({ excludeId, sessionId, runId, showAll = false }: { excludeId?: string; sessionId?: string | null; runId?: string | null; showAll?: boolean }) {
  const [pending, setPending] = useState<PendingConfirm[]>([]);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const refresh = () => setPending(getPendingConfirms());
    refresh();
    window.addEventListener('costhub-cloud-pending', refresh);
    return () => window.removeEventListener('costhub-cloud-pending', refresh);
  }, []);
  const decide = async (item: PendingConfirm, approved: boolean, options: ApprovalDecisionOptions = {}) => {
    if (busy) return;
    setBusy(item.id);
    try {
      if (approved) {
        const result = await approvePending(item.id, options);
        if (!result.ok) throw new Error(result.reason || '未能授权，请检查云端网络模式或刷新待确认列表');
        // 只有后台巡视是"确认后重新调度"；交互式洞察正在原调用栈等待票据，不能重复启动。
        // 后台审批只落精确 grant；下一轮巡视会复用该 grant，不重放整个后台队列。
      } else await skipPending(item.id);
    } catch (error) { message.error(String((error as Error).message || error)); }
    finally { setBusy(''); }
  };
  const visible = pending.filter(item => {
    if (item.id === excludeId) return false;
    if (showAll) return true;
    if (!sessionId || !item.sessionId) return false;
    if (String(item.sessionId) !== String(sessionId)) return false;
    if (item.runId && runId && item.runId !== runId) return false;
    return true;
  });
  if (!visible.length) return null;
  return <section aria-label={showAll ? '全部云端待审批' : '当前会话云端待审批'} className="ai-background-approvals">
    <div className="ai-background-approvals-label">{showAll ? '全部云端待审批 · 逐条批准，互不影响' : '当前会话待审批 · 批准只恢复该 requestId'}</div>
    {visible.map(item => <CloudApprovalCard
      key={item.id}
      title={`${item.material} · ${item.scopeLevel || 'C1'}`}
      content={item.previewJson ? undefined : JSON.stringify({ material: item.material, category: item.category, question: item.question }, null, 2)}
      previewJson={item.previewJson}
      searchScope={!item.scopeLevel || item.scopeLevel === 'C1' || item.scopeLevel === 'C1_PUBLIC_MODEL'}
      target={item.requestUrl || '按已配置的受控端点校验'}
      purpose={item.question}
      requestId={item.requestId}
      payloadVersion={item.payloadVersion}
      requirementKind={item.requirementKind}
      requirementTitle={item.requirementTitle}
      material={item.material}
      category={item.category}
      question={item.question}
      pendingId={item.id}
      onReviseSearch={(item.scopeLevel === 'C1' || item.scopeLevel === 'C1_PUBLIC_MODEL') ? patch => { void revisePendingConfirm(item.id, patch); } : undefined}
      localAudit={item.localAudit}
      busy={busy === item.id}
      onDecision={(approved, options) => decide(item, approved, options)}
      onModify={(item.scopeLevel === 'C1_PUBLIC_CONTEXT' || item.scopeLevel === 'C1_NATIVE_SEARCH') ? next => { void updatePendingConfirmPreview(item.id, next); } : undefined}
      onSkipLongTerm={() => { void skipPending(item.id, { longTerm: true }); }}
    />)}
  </section>;
}
