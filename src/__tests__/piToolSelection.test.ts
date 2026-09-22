import { describe, expect, it } from 'vitest';
import { createDiscoveryTools, discoverTools, formatToolCatalog, parseActivatedToolIds, selectedToolIds } from '../ai/toolSelection';

describe('dynamic business tool catalog', () => {
  it('preloads a small read-only set for an explicit project query', () => {
    const ids = selectedToolIds('查询项目 M270 的 BOM 成本');
    expect(ids).toEqual(expect.arrayContaining(['discover_tools', 'activate_tools', 'ask_user', 'calc', 'now']));
    expect(ids).toContain('query_project_bom');
    expect(ids).not.toContain('import_supplier_quote');
    expect(ids.length).toBeLessThan(10);
  });

  it('keeps attachment reading resident while business writers remain discoverable', () => {
    const ids = selectedToolIds('分析这份附件', '供应商管理', ['supplier']);
    expect(ids).toContain('read_excel');
    expect(ids).not.toContain('write_excel');
    expect(ids).not.toContain('import_supplier_quote');
  });

  it('preloads the confirmed file writer only for requested deliverables', () => {
    const ids = selectedToolIds('比较附件并生成谈价材料和明细表', '', ['supplier']);
    expect(ids).toEqual(expect.arrayContaining(['read_excel', 'write_excel']));
  });

  it('discovers matching tools and lists a whole domain when requested', () => {
    const projectIds = discoverTools('项目 BOM 成本').map(tool => tool.id);
    expect(projectIds).toContain('query_project_bom');
    expect(projectIds).toContain('query_project_cost');
    const fileIds = discoverTools('', 'file').map(tool => tool.id);
    expect(fileIds).toContain('read_excel');
    expect(fileIds).toContain('write_excel');
  });

  it('extracts directory terms from natural Chinese without requiring BOM wording', () => {
    const ids = discoverTools('这个项目便宜了一点但该降的还没降').map(tool => tool.id);
    expect(ids).toContain('query_project_cost');
  });

  it('keeps requested file output discoverable from natural Chinese deliverables', () => {
    const ids = discoverTools('比较附件报价，给我谈价材料和明细表，先不要写入项目数据库').map(tool => tool.id);
    expect(ids).toEqual(expect.arrayContaining(['read_excel', 'write_excel']));
  });

  it('prioritizes file tools when a model supplies a conflicting business domain', () => {
    const ids = discoverTools('附件报价', 'project,tender').map(tool => tool.id);
    expect(ids).toEqual(expect.arrayContaining(['read_excel', 'write_excel']));
  });

  it('parses structured and fallback activation arguments', () => {
    expect(parseActivatedToolIds(['query_projects', ' query_project_bom '])).toEqual(['query_projects', 'query_project_bom']);
    expect(parseActivatedToolIds('["query_projects","query_project_bom"]')).toEqual(['query_projects', 'query_project_bom']);
    expect(parseActivatedToolIds('query_projects,query_project_bom')).toEqual(['query_projects', 'query_project_bom']);
    expect(formatToolCatalog(createDiscoveryTools())).toContain('discover_tools');
  });
});
