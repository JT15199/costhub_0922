import type { AiGatewayTraceEvent } from '../ai/gateway';
import { projectKey, type StateItem, type WorkingState } from '../ai/workingState';

const label = (event: AiGatewayTraceEvent) => {
  if (event.type === 'route_selected') return `路由选择 · ${event.route === 'cloud' ? 'Cloud' : 'Local'} · ${event.provider}`;
  if (event.type === 'privacy_evaluation') return `隐私判定 · ${event.decision.classification.toUpperCase()}`;
  if (event.type === 'context_preparation') return `上下文整理 · ${event.status}`;
  if (event.type === 'approval') return `审批 · ${event.status} · ${event.requestId.slice(0, 8)}`;
  if (event.type === 'context_usage') return `上下文预算 · ${Math.round(event.usage.currentTokens)}/${Math.round(event.usage.inputHard)}`;
  if (event.type === 'cloud_context') return `CloudSafe 上下文 · Public ${event.publicMessages} · 检索 ${event.retrieved} · Tools ${event.tools}`;
  return `${event.channel === 'cloud_tool' ? '云端工具' : '主模型'} · ${event.status.toUpperCase()}`;
};

const detail = (event: AiGatewayTraceEvent) => {
  if (event.type === 'route_selected') return '仅表示选择了候选路径，不能代表已发送。';
  if (event.type === 'privacy_evaluation') {
    return `${event.decision.reasonCode}；${regexStateLabel(event.decision)}；Classifier ${event.decision.classifierUsed ? '规则分类器已调用' : '未调用'}`;
  }
  if (event.type === 'context_preparation') return `${event.detail}；执行者 ${event.executor}；来源 ${event.sourceIds.join('、') || '未记录'}`;
  if (event.type === 'approval') return `${event.detail}；执行者 ${event.executor}；载荷 v${event.payloadVersion}；哈希 ${event.payloadHash || '未记录'}`;
  if (event.type === 'context_usage') return `最大来源 ${event.usage.largestSource}；输入预算 ${Math.round(event.usage.inputHard)} tokens。`;
  if (event.type === 'cloud_context') {
    const dropped = event.dropped ? `；剔除状态 ${event.dropped.stateItems}、消息 ${event.dropped.messages}、检索 ${event.dropped.retrieved}` : '';
    return `只准备了 ${event.publicMessages} 条 Public 消息；本地历史 ${event.localMessages == null ? '不外发' : `保留 ${event.localMessages} 条`}；外发状态 ${event.outboundStatus}${dropped}。`;
  }
  const status = event.status === 'attempted' ? '已到达传输边界（尚未确认联网）' : event.status === 'succeeded' ? '传输完成' : event.status === 'blocked' ? '未发送，已拦截' : event.status === 'cancelled' ? '请求取消' : '传输失败';
  const transportState = event.transport || (event.transported ? 'confirmed' : event.outbound ? 'unknown' : 'not_sent');
  const transport = transportState === 'confirmed' ? '已确认离开本机' : transportState === 'unknown' ? '发送情况未知' : '未发送';
  return `${status}；${transport}${event.target ? `；目标 ${event.target}` : ''}${event.error ? `；${event.error}` : ''}`;
};

type TraceStateRow = { key: string; kind: string; text: string; owner: string; sensitivity: string; source: string; sourceIds: string[]; reason: string; projection: string; sent: string; requestId?: string };

/**
 * 敏感检查的**真实**状态文案（2026-09-21 修复不实陈述）。
 * 旧代码对"来源策略短路"的情况也显示"未发现规则命中"——但那时正则根本没跑，这是对用户不实的一句话。
 * 现在三态分明：命中（列出命中项）/ 已检查未命中 / 未运行（并说明为什么没运行）。
 */
function regexStateLabel(decision: { reasonCode: string; regexMatches: string[] }): string {
  if (decision.regexMatches.length > 0) return `Regex 命中：${decision.regexMatches.join('、')}`;
  if (decision.reasonCode.startsWith('source_policy:') || decision.reasonCode.startsWith('metadata_')) {
    return `Regex 已执行未命中（分类由${decision.reasonCode.startsWith('source_policy:') ? '来源策略' : '来源元数据'}直接决定，未再调用分类器）`;
  }
  return 'Regex 已执行，未命中敏感规则';
}

type PathNode = { id: string; title: string; event?: AiGatewayTraceEvent; sourceIds: string[]; result: string; next: string; executor: string; basis: string };
const statusText = (event?: AiGatewayTraceEvent) => {
  if (!event) return '未执行';
  if (event.type === 'privacy_evaluation') return event.decision.classification === 'public' ? '通过' : event.decision.classification === 'sensitive' ? '阻断' : '需确认';
  if (event.type === 'route_selected') return '通过';
  if (event.type === 'context_usage' || event.type === 'context_preparation') return event.type === 'context_preparation' && event.status !== 'prepared' ? event.status === 'running' ? '进行中' : event.status === 'blocked' ? '阻断' : event.status === 'cancelled' ? '取消' : '失败' : '通过';
  if (event.type === 'cloud_context') return '通过';
  if (event.type === 'approval') return event.status === 'waiting_user' ? '需确认' : ['rejected', 'expired', 'cancelled'].includes(event.status) ? event.status === 'cancelled' ? '取消' : '阻断' : ['failed'].includes(event.status) ? '失败' : ['prepared', 'checking', 'sending'].includes(event.status) ? '进行中' : '通过';
  return event.status === 'blocked' ? '阻断' : event.status === 'cancelled' ? '取消' : event.status === 'succeeded' ? '通过' : event.status === 'attempted' ? '进行中' : '失败';
};

function decisionPath(events: AiGatewayTraceEvent[]): PathNode[] {
  const last = <T extends AiGatewayTraceEvent['type']>(type: T) => [...events].reverse().find(event => event.type === type) as Extract<AiGatewayTraceEvent, { type: T }> | undefined;
  const context = last('context_preparation') || last('context_usage');
  const privacy = last('privacy_evaluation');
  const route = last('route_selected');
  const projection = last('cloud_context');
  const approval = last('approval');
  const network = [...events].reverse().find((event): event is Extract<AiGatewayTraceEvent, { type: 'network_request' }> => event.type === 'network_request' && event.channel === 'main_model');
  return [
    { id: 'context', title: '收集上下文', event: context, sourceIds: context?.type === 'context_preparation' ? context.sourceIds : [], result: context ? context.type === 'context_usage' ? `${Math.round(context.usage.currentTokens)} tokens` : context.detail : '没有保存上下文事件', next: '内容敏感检查', executor: context?.type === 'context_preparation' ? context.executor : '宿主', basis: context?.type === 'context_usage' ? `最大来源：${context.usage.largestSource}` : context?.detail || '未记录' },
    // ⚠️ 2026-09-21：原来这里把**同一个** privacy_evaluation 事件渲染成"来源归属"与"本地敏感检查"两个节点，
    // 看上去像两步独立判断，实际上是"一个事件拆成两行"。现在合并为一个节点，并把来源标签与检查结果
    // 放在同一行里如实展示（来源标签决定分类 / 正则的命中情况 / 分类器是否真的被调用）。
    { id: 'privacy', title: '内容敏感检查', event: privacy, sourceIds: privacy?.decision.sourceTypes || [], result: privacy ? `${privacy.decision.classification.toUpperCase()} · 来源标签 ${privacy.decision.sourceTypes.join('、') || '未标注'} · ${regexStateLabel(privacy.decision)} · 分类器 ${privacy.decision.classifierUsed ? '已调用' : '未调用'}` : '未执行：没有隐私事件', next: '路由决定', executor: privacy?.decision.classifierUsed ? '宿主正则 + 本地分类器' : '宿主正则', basis: privacy?.decision.reasonCode || '未记录' },
    { id: 'route', title: '路由决定', event: route, sourceIds: [], result: route ? `${route.route === 'cloud' ? '云端候选' : '留本地'} · ${route.provider}` : '未执行：没有路由事件', next: route?.route === 'cloud' ? '构建公开内容' : '本地执行', executor: route ? '宿主规则' : '未记录', basis: route ? `gateway 请求路由=${route.route}（来自 ai_gateway_route 设置，不是隐私判定推出来的）` : '未记录' },
    { id: 'projection', title: '构建公开内容', event: projection, sourceIds: projection ? [...(projection.includedStateIds || []), ...(projection.includedMessageIds || []), ...(projection.includedRetrievedIds || [])] : [], result: projection ? `消息 ${projection.publicMessages} · 检索 ${projection.retrieved} · 工具 ${projection.tools}` : route?.route === 'cloud' ? '未执行：路由后未生成公开投影' : '未执行：本轮未选择云端候选', next: '用户审批', executor: projection ? '宿主规则' : '未记录', basis: projection ? `外发状态：${projection.outboundStatus}` : '未记录' },
    { id: 'approval', title: '用户审批 / 后端复核', event: approval, sourceIds: approval?.sourceIds || [], result: approval ? approval.detail : route?.route === 'cloud' ? '未执行：尚未生成审批事件' : '未执行：本轮未选择云端候选', next: approval?.status === 'approved' || approval?.status === 'rechecked' || approval?.status === 'sending' ? '发送' : '结束或留本地', executor: approval?.executor || '未记录', basis: approval ? `requestId ${approval.requestId} · v${approval.payloadVersion}` : '未记录' },
    { id: 'network', title: '发送 / 结果', event: network, sourceIds: [], result: network ? `${network.status} · ${network.transport || (network.outbound ? 'unknown' : 'not_sent')}` : approval?.status === 'sending' ? '进行中：等待真实网络事件' : '未执行：没有主模型网络事件', next: '结束', executor: network ? '后端传输' : '未记录', basis: network?.requestId || '未记录' },
  ];
}

function stateRows(state?: WorkingState) {
  if (!state) return [] as TraceStateRow[];
  const groups: Array<[string, StateItem[]]> = [
    ['用户约束', state.userConstraints], ['确认事实', state.confirmedFacts], ['决策', state.decisions],
    ['开放问题', state.openQuestions], ['业务上下文', state.businessContext],
  ];
  const rows: TraceStateRow[] = groups.flatMap(([kind, items]) => items.filter(item => item.status === 'active').map(item => ({
    key: `${kind}:${item.id}`,
    kind,
    text: item.text,
    owner: item.scope === 'project' || item.projectKey ? `项目 · ${item.projectKey || projectKey(state.activeProject) || '未归属'}` : '共享',
    sensitivity: item.sensitivity,
    source: (item.sourceMessageIds || item.provenance?.sourceIds || []).join('、') || '未记录',
    sourceIds: [...new Set(item.sourceMessageIds || item.provenance?.sourceIds || [])],
    reason: item.provenance?.sourceType || '未记录',
    projection: item.sensitivity === 'public' && item.provenance?.cloudSafe && item.provenance?.verified ? '公开候选' : '本地保留',
    sent: '由本轮事件核对',
  })));
  const refs: TraceStateRow[] = [
    ...state.activeFiles.map(file => ({ key: `file:${file.projectKey || 'shared'}:${file.path}`, kind: '文件', text: file.path, owner: file.scope === 'project' || file.projectKey ? `项目 · ${file.projectKey}` : '共享', sensitivity: file.sensitivity || 'unknown', source: file.path, sourceIds: [file.path], reason: '本地文件', projection: '不纳入 CloudSafe', sent: '未发送' })),
    ...state.activeArtifacts.map(artifact => ({ key: `artifact:${artifact.projectKey || 'shared'}:${artifact.id}`, kind: '产物', text: artifact.label || artifact.id, owner: artifact.scope === 'project' || artifact.projectKey ? `项目 · ${artifact.projectKey}` : '共享', sensitivity: artifact.sensitivity || 'unknown', source: artifact.id, sourceIds: [artifact.id], reason: '本地产物', projection: '不纳入 CloudSafe', sent: '未发送' })),
    ...state.completedSteps.map(step => ({ key: `completed:${step.projectKey || 'shared'}:${step.id}`, kind: '已完成步骤', text: step.text, owner: step.scope === 'project' || step.projectKey ? `项目 · ${step.projectKey}` : '共享', sensitivity: 'internal', source: step.id, sourceIds: [step.id], reason: '本地步骤', projection: '不纳入 CloudSafe', sent: '未发送' })),
    ...state.nextSteps.map(step => ({ key: `next:${step.projectKey || 'shared'}:${step.id}`, kind: '下一步', text: step.text, owner: step.scope === 'project' || step.projectKey ? `项目 · ${step.projectKey}` : '共享', sensitivity: 'internal', source: step.id, sourceIds: [step.id], reason: '本地步骤', projection: '不纳入 CloudSafe', sent: '未发送' })),
  ];
  return [...rows, ...refs];
}

export default function GatewayTracePanel({ events, workingState, historyWarning, runs = [], selectedRunId = '', onSelectRun, onSourceClick }: { events: AiGatewayTraceEvent[]; workingState?: WorkingState; historyWarning?: string; runs?: Array<{ runId: string; label: string }>; selectedRunId?: string; onSelectRun?: (runId: string) => void; onSourceClick?: (source: string) => void }) {
  const cloudContext = [...events].reverse().find(event => event.type === 'cloud_context');
  const includedStateIds = new Set(cloudContext?.type === 'cloud_context' ? cloudContext.includedStateIds || [] : []);
  const modelRequests = events.filter((event): event is Extract<AiGatewayTraceEvent, { type: 'network_request' }> => event.type === 'network_request' && event.channel === 'main_model' && event.outbound);
  const modelRequest = modelRequests.at(-1);
  const modelRequestId = modelRequest?.type === 'network_request' ? modelRequest.requestId : '';
  const modelTransport = modelRequest?.type === 'network_request' ? modelRequest.transport || (modelRequest.transported ? 'confirmed' : modelRequest.outbound ? 'unknown' : 'not_sent') : undefined;
  const modelDelivery = !modelRequest
    ? 'prepared'
    : modelRequest.status === 'succeeded' && modelTransport === 'confirmed'
      ? 'confirmed'
      : modelRequest.status === 'cancelled' && modelTransport === 'unknown'
        ? 'cancelled_unknown'
        : modelTransport === 'not_sent' || modelRequest.status === 'blocked'
          ? 'not_sent'
          : 'unknown';
  const rows = stateRows(workingState).map(row => row.kind === '文件' || row.kind === '产物' || row.kind === '已完成步骤' || row.kind === '下一步'
    ? row
    : { ...row, projection: includedStateIds.has(row.key.slice(row.key.indexOf(':') + 1)) ? '已纳入公开投影' : row.projection === '公开候选' ? '本轮未纳入' : row.projection, sent: includedStateIds.has(row.key.slice(row.key.indexOf(':') + 1)) ? modelDelivery === 'confirmed' ? '已确认外发' : modelDelivery === 'prepared' ? '仅准备投影' : modelDelivery === 'cancelled_unknown' ? '尝试后取消，发送情况未知' : modelDelivery === 'not_sent' ? '未发送' : '发送情况未知' : '未进入请求体', requestId: includedStateIds.has(row.key.slice(row.key.indexOf(':') + 1)) ? modelRequestId || undefined : undefined });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, color: '#2B2925', fontSize: 12 }}>
      {historyWarning && <div role="alert" style={{ color: '#8A5A00', background: '#FFF8EC', border: '1px solid #F0D9B5', borderRadius: 7, padding: '7px 9px', lineHeight: 1.5 }}>{historyWarning}</div>}
      {runs.length > 0 && onSelectRun && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>历史运行</span>
          <select value={selectedRunId} onChange={event => onSelectRun(event.target.value)} style={{ minWidth: 220, maxWidth: '100%', border: '1px solid #D8D5CA', borderRadius: 6, padding: '4px 7px', background: '#fff', color: '#2B2925' }} aria-label="选择历史运行">
            {runs.map(run => <option key={run.runId} value={run.runId}>{run.label}</option>)}
          </select>
        </label>
      )}
      <section aria-label="判断路径">
        <div style={{ fontWeight: 700, marginBottom: 6 }}>判断路径</div>
        <div className="gateway-decision-path">
          {decisionPath(events).map(node => <details key={node.id} className={`gateway-path-node status-${statusText(node.event)}`}>
            <summary><span className="gateway-path-dot" aria-hidden="true" /> <b>{node.title}</b><span className="gateway-path-status">{statusText(node.event)}</span></summary>
            <div className="gateway-path-detail">
              <div><b>输入来源：</b>{node.sourceIds.length ? node.sourceIds.map(source => onSourceClick ? <button key={source} type="button" onClick={() => onSourceClick(source)}>{source}</button> : <span key={source}>{source}</span>) : '未记录'}</div>
              <div><b>执行者：</b>{node.executor}</div>
              <div><b>判断依据：</b>{node.basis}</div>
              <div><b>结果：</b>{node.result}</div>
              <div><b>下一步：</b>{node.next}</div>
            </div>
          </details>)}
        </div>
      </section>
      <section>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>本轮事件</div>
        {events.length ? events.map((event, index) => (
          <details key={`${event.type}-${index}`} style={{ border: '1px solid #E6E4DC', borderRadius: 7, padding: '6px 8px', marginBottom: 5, background: '#FBFAF6' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{label(event)}</summary>
            <div style={{ color: '#6F6C62', lineHeight: 1.6, marginTop: 4 }}>{detail(event)}</div>
          </details>
        )) : <div role="status" style={{ color: '#9A978B', padding: 8 }}>当前会话还没有可回放的 Gateway 事件。</div>}
      </section>
      <section>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>信息归属</div>
        {workingState ? (
          <div style={{ overflowX: 'auto', border: '1px solid #E6E4DC', borderRadius: 7 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead><tr style={{ background: '#F4F3EE', textAlign: 'left' }}><th style={{ padding: 6 }}>类型</th><th style={{ padding: 6 }}>内容</th><th style={{ padding: 6 }}>归属</th><th style={{ padding: 6 }}>敏感度</th><th style={{ padding: 6 }}>来源</th><th style={{ padding: 6 }}>判定依据</th><th style={{ padding: 6 }}>本轮投影</th><th style={{ padding: 6 }}>外发状态</th></tr></thead>
              <tbody>{rows.map(row => <tr key={row.key}><td style={{ padding: 6, borderTop: '1px solid #EEECE5', whiteSpace: 'nowrap' }}>{row.kind}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5' }}>{row.text}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5', whiteSpace: 'nowrap' }}>{row.owner}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5', whiteSpace: 'nowrap' }}>{row.sensitivity}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5' }}>{row.sourceIds.length && onSourceClick ? row.sourceIds.map(source => <button key={source} type="button" onClick={() => onSourceClick(source)} title="打开当前会话中的来源记录" style={{ border: 0, background: 'transparent', color: '#526FCA', cursor: 'pointer', padding: 0, marginRight: 4, textDecoration: 'underline' }}>{source}</button>) : row.source}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5' }}>{row.reason}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5', whiteSpace: 'nowrap' }}>{row.projection}</td><td style={{ padding: 6, borderTop: '1px solid #EEECE5', whiteSpace: 'nowrap' }}>{row.sent}{row.requestId ? <><br /><span title={row.requestId} style={{ color: '#64748B', fontSize: 10 }}>request {row.requestId.slice(0, 8)}</span></> : null}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <div role="status" style={{ color: '#9A978B', padding: 8 }}>该运行没有保存结构化状态快照；不会用当前会话状态冒充历史。</div>}
      </section>
      <div style={{ color: '#9A978B', fontSize: 11, lineHeight: 1.6 }}>信息归属表只显示所选运行的状态快照；“仅准备投影”不等于已联网，“已确认外发”只在主模型传输事件明确确认时显示，未知状态不会冒充未发送。</div>
    </div>
  );
}
