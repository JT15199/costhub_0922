// 自主分析引擎（2026-08-17）
import { describe, it, expect } from 'vitest';
import {
  buildThinkSystemPrompt, buildCloudToolDef, buildLocalToolDefs,
  buildCloudReviewPrompt, formatCloudResult, MAX_THINK_ROUNDS,
  parseProtocolCalls, cleanProtocolText,
} from '../thinkEngine';

describe('buildThinkSystemPrompt', () => {
  it('包含灵活思路引导（尺寸/面积只是思路之一）', () => {
    const p = buildThinkSystemPrompt(['query_project_bom', 'cloud_market_query']);
    expect(p).toContain('单位面积成本');
    expect(p).toContain('按同样尺寸折算');
    expect(p).toContain('不要机械套用固定公式');
    expect(p).toContain('cloud_market_query');
    expect(p).toContain('申请');
  });
  it('可注入用户偏好上下文', () => {
    const p = buildThinkSystemPrompt(['t'], '【偏好】优先关注机会点');
    expect(p).toContain('【用户偏好】');
    expect(p).toContain('优先关注机会点');
  });
});

describe('buildCloudToolDef', () => {
  it('云端申请工具：物料名/品类/问题必填约束', () => {
    const def: any = buildCloudToolDef();
    expect(def.function.name).toBe('cloud_market_query');
    expect(def.function.parameters.required).toContain('material_name');
    expect(def.function.parameters.required).toContain('question');
    expect(def.function.description).toContain('审批');
  });
});

describe('buildLocalToolDefs', () => {
  it('从工具元数据生成 Ollama schema', () => {
    const defs: any = buildLocalToolDefs([
      { id: 'query_project_bom', desc: '查 BOM', params: [{ key: 'project_id', type: 'number', required: true, desc: '项目ID' }] },
    ]);
    expect(defs[0].function.name).toBe('query_project_bom');
    expect(defs[0].function.parameters.properties.project_id.type).toBe('number');
    expect(defs[0].function.parameters.required).toEqual(['project_id']);
  });
});

describe('buildCloudReviewPrompt', () => {
  it('审批提示词仅含脱敏三字段（物料/品类/问题）', () => {
    const p = buildCloudReviewPrompt({ material_name: '液晶面板', category: '硬件类', question: '近1-3月价格趋势？' });
    expect(p).toContain('液晶面板');
    expect(p).toContain('硬件类');
    expect(p).toContain('近1-3月价格趋势？');
    expect(p).toContain('已脱敏');
  });
  it('缺省字段有兜底', () => {
    const p = buildCloudReviewPrompt({ material_name: 'PCB' });
    expect(p).toContain('未指定');
    expect(p).toContain('price-trend');
  });
});

describe('formatCloudResult', () => {
  it('格式化云端返回供模型消费', () => {
    const r = formatCloudResult({ trend_direction: '上涨', confidence_level: '高', magnitude_min: 5, magnitude_max: 8, summary: '供给收紧', suggested_action: '建议备货' });
    expect(r).toContain('上涨');
    expect(r).toContain('置信度 高');
    expect(r).toContain('5%~8%');
    expect(r).toContain('建议备货');
  });
  it('空结果兜底', () => {
    const r = formatCloudResult({});
    expect(r).toContain('信号不明确');
  });
});


describe('parseProtocolCalls（文本协议 v2）', () => {
  it('解析 [TOOL] 调用（含 JSON 参数）', () => {
    const calls = parseProtocolCalls('我先看看项目\n[TOOL] query_project_bom {"project_id":3}\n然后分析');
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe('tool');
    expect(calls[0].name).toBe('query_project_bom');
    expect(calls[0].args).toEqual({ project_id: 3 });
  });
  it('解析 [CLOUD] 调用', () => {
    const calls = parseProtocolCalls('[CLOUD] {"material_name":"液晶面板","category":"硬件类","question":"近1-3月价格趋势?"}');
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe('cloud');
    expect(calls[0].args.material_name).toBe('液晶面板');
  });
  it('JSON 跨行也能解析（括号平衡）', () => {
    const calls = parseProtocolCalls('[TOOL] query_project_bom {\n  "project_id": 1,\n  "x": {"y": 2}\n}');
    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual({ project_id: 1, x: { y: 2 } });
  });
  it('无调用标记返回空', () => {
    expect(parseProtocolCalls('只是分析，没有调用')).toEqual([]);
    expect(parseProtocolCalls('')).toEqual([]);
  });
  it('非法 JSON 跳过', () => {
    const calls = parseProtocolCalls('[TOOL] query_project_bom {broken');
    expect(calls.length).toBe(0);
  });
});

describe('cleanProtocolText', () => {
  it('移除调用标记保留正文', () => {
    const t = cleanProtocolText('先查数据\n[TOOL] query_project_bom {"project_id":1}\n结论是成本偏高');
    expect(t).not.toContain('[TOOL]');
    expect(t).toContain('先查数据');
    expect(t).toContain('结论是成本偏高');
  });
  it('移除 [CLOUD] 标记', () => {
    const t = cleanProtocolText('[CLOUD] {"material_name":"PCB"}\n需要行情确认');
    expect(t).not.toContain('[CLOUD]');
    expect(t).toContain('需要行情确认');
  });
});
describe('MAX_THINK_ROUNDS', () => {
  it('思考循环有上限防失控', () => {
    expect(MAX_THINK_ROUNDS).toBeGreaterThanOrEqual(5);
    expect(MAX_THINK_ROUNDS).toBeLessThanOrEqual(12);
  });
});