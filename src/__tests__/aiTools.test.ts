import { describe, it, expect } from 'vitest';
import { listTools, getTool, getToolManifest, validateArgs, executeTool, executeStructuredTool, TOOL_ICONS, toolIcon, WRITE_TOOL_IDS } from '../aiTools';

describe('工具注册表元数据', () => {
  it('至少 10 个工具且 id 唯一', () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThanOrEqual(10);
    const ids = tools.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('每个工具有中文名、描述、参数说明', () => {
    for (const t of listTools()) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(10);
      const keys = t.params.map(p => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  it('核心工具存在', () => {
    expect(getTool('query_projects')).toBeDefined();
    expect(getTool('query_project_bom')).toBeDefined();
    expect(getTool('insight_material_trend')).toBeDefined();
  });
  it('子类成本对比工具存在且必填参数校验', () => {
    const t = getTool('compare_subcategory_cost')!;
    expect(t).toBeDefined();
    expect(validateArgs(t, {})).toContain('缺少必填参数');
    expect(validateArgs(t, { sub_category: '液晶面板' })).toBeNull();
  });
  it('全部工具都有语义图标（TOOL_ICONS 覆盖）', () => {
    for (const t of listTools()) {
      expect(TOOL_ICONS[t.id]).toBeDefined();
      expect(toolIcon(t.id)).toBeDefined();
    }
  });
  it('全部工具都有风险 Manifest，写工具默认需要确认', () => {
    for (const t of listTools()) expect(getToolManifest(t.id)?.id).toBe(t.id);
    expect(WRITE_TOOL_IDS).toContain('canonicalize_project');
    expect(getToolManifest('canonicalize_project')?.requiresConfirmation).toBe(true);
    expect(getToolManifest('query_project_bom')?.kind).toBe('read');
  });
});

describe('validateArgs — 参数校验', () => {
  const tool = getTool('query_project_bom')!;
  it('必填缺失 → 报错', () => {
    expect(validateArgs(tool, {})).toContain('缺少必填参数');
    expect(validateArgs(tool, { project_code: '' })).toContain('缺少必填参数');
  });
  it('必填齐全 → 通过', () => {
    expect(validateArgs(tool, { project_code: 'M270' })).toBeNull();
  });
  it('数字参数类型校验', () => {
    const snapTool = getTool('query_cost_snapshots')!;
    expect(validateArgs(snapTool, { limit: 'abc' })).toContain('应为数字');
    expect(validateArgs(snapTool, { limit: 5 })).toBeNull();
  });
});

describe('executeTool — 未知工具/参数错误不抛异常', () => {
  it('未知工具返回失败文本', async () => {
    const r = await executeTool('not_exist', {});
    expect(r.ok).toBe(false);
    expect(r.text).toContain('未知工具');
  });
  it('参数错误返回失败文本', async () => {
    const r = await executeTool('query_project_bom', {});
    expect(r.ok).toBe(false);
    expect(r.text).toContain('参数错误');
  });
  it('未确认的写工具在共同入口被拒绝', async () => {
    const r = await executeTool('create_todo', { content: '不应直接写入' });
    expect(r.ok).toBe(false);
    expect(r.requiresConfirmation).toBe(true);
    expect(r.text).toContain('未执行任何写入');
  });
  it('结构化适配器对未迁移工具诚实返回', async () => {
    const r = await executeStructuredTool({ name: 'query_project_cost', args: {} });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('尚未迁移');
    expect(r.evidence).toEqual([]);
  });
});
