import { describe, it, expect } from 'vitest';
import type { AiGatewayTraceEvent } from '../ai/gateway';
import type { RuntimeEvent } from '../ai/runtime/contract';
import { summarizeGatewayTrace } from '../components/ai/gatewayTrace';
import {
  createGatewayEventDeduplicator,
  translateRuntimeEventForUi,
} from '../components/ai/runtimeEventMapper';

const ts = (event: unknown) => event as AiGatewayTraceEvent;

/** 一条 Runtime 包装事件（底层网关事件原样透传）。 */
const gateway = (event: AiGatewayTraceEvent): RuntimeEvent =>
  ({ type: 'gateway', event, runId: 'r1', seq: 0, at: 0 } as unknown as RuntimeEvent);

const routeSelected = (): AiGatewayTraceEvent => ts({
  type: 'route_selected', route: 'local', provider: 'ollama', model: 'qwen3:4b',
});

const networkInternal = (requestId = 'req-1'): AiGatewayTraceEvent => ts({
  type: 'network_request', status: 'failed', outbound: false,
  transport: 'not_sent', channel: 'main_model', route: 'local',
  provider: 'ollama', model: 'qwen3:4b', requestId,
});

const networkOutbound = (requestId = 'req-c'): AiGatewayTraceEvent => ts({
  type: 'network_request', status: 'attempted', outbound: true,
  transport: 'confirmed', channel: 'cloud_tool', route: 'cloud',
  provider: 'cloud', model: 'qwen3:4b', requestId,
});

describe('Stage 3.5 — 网关事件重复投递（新旧路径交叉）', () => {
  it('复现：底层网关事件同时经直连回调与 Runtime 透传到达 UI', () => {
    // 生产链路（AiPanel runtime 分支）：
    //   sessionCallbacks.onGatewayTrace → emit({type:'gateway'}) 且转发 options.onGatewayTrace
    //   → AiPanel 再对每条 RuntimeEvent 调 translateRuntimeEventForUi → 又转一次
    const delivered: AiGatewayTraceEvent[] = [];
    const uiHandler = (event: AiGatewayTraceEvent) => delivered.push(event);

    const event = routeSelected();
    // 第一次：旧回调直连转发
    uiHandler(event);
    // 第二次：Runtime 事件透传
    const translated = translateRuntimeEventForUi(gateway(event));
    if (translated.gateway) uiHandler(translated.gateway);

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toBe(delivered[1]);
  });

  it('复现：重复投递会让累加型计数翻倍（outbound / toolRequests）', () => {
    const event = networkOutbound();
    const once = summarizeGatewayTrace([event]);
    const twice = summarizeGatewayTrace([event, event]);

    expect(once.outboundAttemptCount).toBe(1);
    expect(twice.outboundAttemptCount).toBe(2);
    expect(once.toolRequests).toBe(1);
    expect(twice.toolRequests).toBe(2);
  });

  it('去重器：同一条事件投递两次只透传一次', () => {
    const seen: AiGatewayTraceEvent[] = [];
    const deliver = createGatewayEventDeduplicator(event => seen.push(event));

    const event = routeSelected();
    deliver(event);
    deliver(event);

    expect(seen).toHaveLength(1);
  });

  it('去重器：内容相同但对象不同的同一逻辑事件也只透传一次', () => {
    const seen: AiGatewayTraceEvent[] = [];
    const deliver = createGatewayEventDeduplicator(event => seen.push(event));

    deliver(routeSelected());
    deliver(routeSelected()); // 结构相等、引用不同（重组后的同一事件）

    expect(seen).toHaveLength(1);
  });

  it('去重器：不同事件必须全部保留（不得吞掉真实信息）', () => {
    const seen: AiGatewayTraceEvent[] = [];
    const deliver = createGatewayEventDeduplicator(event => seen.push(event));

    const a = routeSelected();
    const b = networkInternal();
    const c = networkOutbound();
    for (const event of [a, b, c, a, b, c]) deliver(event);

    expect(seen).toHaveLength(3);
    expect(seen).toEqual([a, b, c]);
  });

  it('去重器：跨轮运行时状态必须重置（否则第二轮同类事件被误吞）', () => {
    const seen: AiGatewayTraceEvent[] = [];
    const dedup = createGatewayEventDeduplicator(event => seen.push(event));

    const first = routeSelected();
    dedup(first);
    dedup(first);
    expect(seen).toHaveLength(1);

    dedup.reset();

    const second = routeSelected();
    dedup(second);
    expect(seen).toHaveLength(2);
  });

  it('去重器：记忆有界——滑出窗口后的同类事件按新事件放行（宁可多显示，不吞真实事件）', () => {
    const seen: AiGatewayTraceEvent[] = [];
    const deliver = createGatewayEventDeduplicator(event => seen.push(event));

    const a = routeSelected();
    deliver(a);
    // 填充足够多的**互不相同**事件，确保 a 被挤出比较窗口
    for (let i = 0; i < 12; i += 1) deliver(networkInternal(`fill-${i}`));
    deliver(a);

    expect(seen).toHaveLength(14);
  });

  it('去重器：连续多条完全相同的中间事件按重复折叠（同一逻辑事件的多次投递）', () => {
    const seen: AiGatewayTraceEvent[] = [];
    const deliver = createGatewayEventDeduplicator(event => seen.push(event));

    for (let i = 0; i < 5; i += 1) deliver(networkInternal());
    expect(seen).toHaveLength(1);
  });

  it('去重后的归约结果与只消费一次完全一致', () => {
    const events = [networkOutbound(), networkOutbound(), routeSelected(), routeSelected()];
    const seen: AiGatewayTraceEvent[] = [];
    const deliver = createGatewayEventDeduplicator(event => seen.push(event));
    for (const event of events) deliver(event);

    expect(summarizeGatewayTrace(seen)).toEqual(summarizeGatewayTrace([networkOutbound(), routeSelected()]));
    expect(summarizeGatewayTrace(seen).outboundAttemptCount).toBe(1);
  });
});
