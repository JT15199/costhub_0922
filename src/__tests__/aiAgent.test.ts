import { describe, it, expect } from 'vitest';
import { parseAgentPlan, buildToolsPrompt, buildPlanSystemPrompt, buildAnswerSystemPrompt, unknownTools } from '../aiAgent';
import { listTools } from '../aiTools';

describe('parseAgentPlan — 容错解析', () => {
  it('干净 JSON', () => {
    const p = parseAgentPlan('{"steps":[{"tool":"query_projects","args":{},"reason":"列项目"}]}');
    expect(p?.steps.length).toBe(1);
    expect(p?.steps[0].tool).toBe('query_projects');
  });
  it('代码块围栏包裹', () => {
    const p = parseAgentPlan('好的，计划如下：\n\n\x60\x60\x60json\n{"steps":[{"tool":"query_project_bom","args":{"project_code":"M270"}}]}\n\x60\x60\x60\n请确认');
    expect(p?.steps.length).toBe(1);
    expect(p?.steps[0].args.project_code).toBe('M270');
  });
  it('中文引号与单引号兼容', () => {
    const p = parseAgentPlan('{"steps":[{"tool":"query_project_cost","args":{"project_code":"M270"}}]}');
    expect(p?.steps[0].tool).toBe('query_project_cost');
  });
  it('尾逗号容错', () => {
    const p = parseAgentPlan('{"steps":[{"tool":"query_todos","args":{},"reason":"查待办",},],}');
    expect(p?.steps.length).toBe(1);
  });
  it('空 steps → null（无需工具）', () => {
    expect(parseAgentPlan('{"steps":[]}')).toBeNull();
  });
  it('非 JSON 杂文本 → null', () => {
    expect(parseAgentPlan('我不确定这个任务需要工具')).toBeNull();
    expect(parseAgentPlan('')).toBeNull();
  });
  it('别名映射（insight → insight_material_trend）', () => {
    const p = parseAgentPlan('{"steps":[{"tool":"insight","args":{"material_name":"液晶面板"}}]}');
    expect(p?.steps[0].tool).toBe('insight_material_trend');
  });
});

describe('unknownTools — 未知工具检测', () => {
  it('识别不存在的工具 id', () => {
    const p = parseAgentPlan('{"steps":[{"tool":"query_projects","args":{}},{"tool":"hack_db","args":{}}]}')!;
    const unknown = unknownTools(p);
    expect(unknown).toEqual(['hack_db']);
  });
  it('全部已知 → 空', () => {
    const p = parseAgentPlan('{"steps":[{"tool":"query_projects","args":{}}]}')!;
    expect(unknownTools(p)).toEqual([]);
  });
});

describe('提示词构建', () => {
  it('工具清单包含全部工具 id 与参数说明', () => {
    const prompt = buildToolsPrompt(listTools());
    expect(prompt).toContain('query_projects');
    expect(prompt).toContain('insight_material_trend');
    expect(prompt).toContain('project_code*');
  });
  it('计划提示词要求 JSON 输出与步骤上限', () => {
    const sys = buildPlanSystemPrompt('工具清单');
    expect(sys).toContain('steps');
    expect(sys).toContain('最多 6 步');
  });
  it('总结提示词禁止编造', () => {
    expect(buildAnswerSystemPrompt()).toContain('不要编造');
  });
});
