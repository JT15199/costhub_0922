import { describe, expect, it } from 'vitest';
import { contextBudget, estimateContextTokens, estimateContextUsage, estimateTokens } from '../ai/modelProfile';

describe('agent model profile', () => {
  it('keeps input below the calibrated context after output and safety reserve', () => {
    const budget = contextBudget(16384, 3072);
    expect(budget.inputHard + budget.outputReserve + budget.safetyMargin).toBeLessThanOrEqual(16384);
    expect(budget.inputSoft).toBeLessThan(budget.inputHard);
  });

  it('does not undercount Chinese and JSON as four characters per token', () => {
    expect(estimateTokens('主板价格：{"value":100,"note":"规格待核对"}')).toBeGreaterThan(8);
  });

  it('breaks current context into observable sources without changing the budget', () => {
    const usage = estimateContextUsage(
      '系统提示'.repeat(10),
      [{ role: 'user', content: [{ type: 'text', text: '【CostHub 结构化工作状态】\n目标成本 400' }] }, { role: 'user', content: '查询项目成本' }, { role: 'toolResult', content: 'x'.repeat(1200) }],
      [{ name: 'query_project_cost', description: '读取项目成本', parameters: { type: 'object' } }],
      16384,
      4096,
    );
    expect(usage.currentTokens).toBe(estimateContextTokens('系统提示'.repeat(10), [{ role: 'user', content: [{ type: 'text', text: '【CostHub 结构化工作状态】\n目标成本 400' }] }, { role: 'user', content: '查询项目成本' }, { role: 'toolResult', content: 'x'.repeat(1200) }], [{ name: 'query_project_cost', description: '读取项目成本', parameters: { type: 'object' } }]));
    expect(usage.currentTokens).toBeGreaterThan(usage.systemTokens);
    expect(usage.toolResultTokens).toBeGreaterThan(usage.messageTokens);
    expect(usage.workingStateTokens).toBeGreaterThan(0);
    expect(usage.recentMessageTokens).toBeLessThan(usage.messageTokens);
    expect(usage.retrievedTokens).toBe(usage.toolResultTokens);
    expect(usage.toolContextTokens).toBe(usage.toolSchemaTokens);
    expect(usage.largestSource).toBe('tool_results');
    expect(usage.reservedOutput).toBe(4096);
    expect(usage.currentTokens / usage.inputHard).toBe(usage.inputUtilization);
  });
});
