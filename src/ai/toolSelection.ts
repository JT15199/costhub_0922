import { listTools, type AiTool, type AiToolParam } from '../aiTools';
import type { AiToolManifest } from './contracts';

const RESIDENT = ['ask_user', 'calc', 'now'];
const DISCOVERY_IDS = ['discover_tools', 'activate_tools'];

const DOMAIN_ALIASES: Record<string, string[]> = {
  project: ['project', '项目', 'bom', '成本', '目标', '降本', '模块', '竞品', '健康'],
  tender: ['tender', 'quote', '报价', '供应商', '议价', '谈价', '招标', '投标'],
  material: ['material', 'part', '物料', '器件', '行情', '价格', '趋势', '洞察'],
  worklog: ['worklog', '手账', '工作', '待办', '跟进', '沟通', '历史'],
  voice: ['voice', '原声', '评论', '评价', '反馈'],
  file: ['file', 'excel', 'xlsx', 'csv', '表格', '文件', '附件', '报告', '导出', '明细表', '清单', '材料', '结果表'],
  write: ['write', 'import', 'save', 'create', '导入', '录入', '保存', '写入', '创建', '生成', '导出', '明细表', '清单', '材料', '结果表'],
};

const internalManifest = (id: string, outputSchema: string): AiToolManifest => ({
  id,
  kind: 'calculate',
  risk: 'low',
  requiresConfirmation: false,
  requiredData: [],
  outputSchema,
  evidencePolicy: 'optional',
});

const internalParam = (key: string, type: AiToolParam['type'], desc: string, required = false): AiToolParam => ({ key, type, desc, required });

export const DISCOVERY_TOOL_IDS = DISCOVERY_IDS;

export function isDiscoveryTool(id: string): boolean {
  return DISCOVERY_IDS.includes(id);
}

function normalize(value: unknown): string {
  return String(value || '').trim().toLocaleLowerCase();
}

function domainTerms(domains: string): string[] {
  return normalize(domains).split(/[\s,，、;；|]+/).filter(Boolean).flatMap(domain => DOMAIN_ALIASES[domain] || [domain]);
}

function toolHaystack(tool: AiTool): string {
  const manifest = tool.manifest;
  return normalize([tool.id, tool.name, tool.desc, ...(manifest?.requiredData || [])].join(' '));
}

function queryTerms(query: string): string[] {
  const raw = query.split(/[\s,，、;；|]+/).filter(Boolean);
  const aliases = Object.values(DOMAIN_ALIASES).flat();
  return [...new Set([...raw, ...aliases.filter(alias => alias.length > 1 && query.includes(alias))])];
}

function inferredDomainTerms(query: string): string[] {
  const fileSignals = DOMAIN_ALIASES.file.filter(alias => alias.length > 1 && query.includes(alias));
  if (fileSignals.length) return DOMAIN_ALIASES.file;
  return Object.entries(DOMAIN_ALIASES)
    .filter(([, aliases]) => aliases.some(alias => alias.length > 1 && query.includes(alias)))
    .flatMap(([, aliases]) => aliases);
}

/** Search the complete catalog; domain queries are intentionally uncapped. */
export function discoverTools(query: string, domains = ''): AiTool[] {
  const q = normalize(query);
  const qTerms = queryTerms(q);
  const hasFileSignal = DOMAIN_ALIASES.file.some(alias => alias.length > 1 && q.includes(alias));
  const dTerms = hasFileSignal ? DOMAIN_ALIASES.file : [...new Set([...domainTerms(domains), ...inferredDomainTerms(q)])];
  if (!qTerms.length && !dTerms.length) return [];
  const all = listTools().filter(tool => tool.manifest);
  const ranked = all.map(tool => {
    const hay = toolHaystack(tool);
    let score = 0;
    for (const term of qTerms) {
      if (hay.includes(term)) score += tool.id.toLocaleLowerCase().includes(term) ? 6 : tool.name.toLocaleLowerCase().includes(term) ? 4 : 1;
    }
    if (dTerms.length && dTerms.some(term => hay.includes(term))) score += 3;
    return { tool, score };
  }).filter(item => item.score > 0 && (!dTerms.length || dTerms.some(term => toolHaystack(item.tool).includes(term))));
  ranked.sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id));
  // A query plus a domain is a focused lookup; keep the prompt small enough
  // for local models while domain-only discovery still exposes the full list.
  const matches = dTerms.length && qTerms.length ? ranked.slice(0, 8) : dTerms.length ? ranked : ranked.slice(0, 12);
  return matches.map(item => item.tool);
}

function paramDescription(param: AiToolParam): string {
  const suffix = [
    param.required ? '必填' : '可选',
    param.enum?.length ? `枚举=${param.enum.join('|')}` : '',
    param.minimum !== undefined ? `最小=${param.minimum}` : '',
    param.maximum !== undefined ? `最大=${param.maximum}` : '',
  ].filter(Boolean).join('，');
  return `${param.key}:${param.type}${suffix ? `（${suffix}）` : ''}—${param.desc}`;
}

export function formatToolCatalog(tools: AiTool[]): string {
  if (!tools.length) return '工具目录没有匹配项。请换一个关键词，或用 domains 指定领域（project/tender/material/worklog/voice/file/write）。';
  return tools.map(tool => {
    const manifest = tool.manifest;
    return `${tool.id}｜${tool.name}｜${manifest?.kind || 'unknown'}｜${tool.desc}${tool.params.length ? `｜参数：${tool.params.map(paramDescription).join('；')}` : '｜无参数'}`;
  }).join('\n');
}

export function parseActivatedToolIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(id => id.trim()).filter(Boolean);
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map(id => id.trim()).filter(Boolean);
  } catch { /* comma-separated fallback */ }
  return raw.split(/[\s,，、;；]+/).map(id => id.trim()).filter(Boolean);
}

export function createDiscoveryTools(): AiTool[] {
  return [
    {
      id: 'discover_tools',
      name: '发现业务工具',
      desc: '按用户任务关键词或领域查找 CostHub 业务工具，返回少量匹配工具和参数摘要；实际嵌套参数以原生 schema 为准。发现后工具会在下一轮原生调用中激活。',
      params: [internalParam('query', 'string', '任务关键词，如项目 BOM、报价谈价、物料行情、手账', true), internalParam('domains', 'string', '领域：project/tender/material/worklog/voice/file/write，可逗号分隔')],
      manifest: internalManifest('discover_tools', 'ToolCatalog'),
      execute: async args => formatToolCatalog(discoverTools(String(args.query || ''), String(args.domains || ''))),
    },
    {
      id: 'activate_tools',
      name: '激活业务工具',
      desc: '把 discover_tools 返回的工具 ID 加载到下一次模型请求；只接受目录中存在且有 Manifest 的工具。tool_ids 可以传字符串数组。',
      params: [{ ...internalParam('tool_ids', 'array', '工具 ID 数组，如 ["query_projects","query_project_bom"]', true), items: 'string' }],
      manifest: internalManifest('activate_tools', 'ActivatedToolIds'),
      execute: async args => {
        const ids = parseActivatedToolIds(args.tool_ids);
        const known = new Set(listTools().filter(tool => tool.manifest).map(tool => tool.id));
        return `已请求激活：${ids.filter(id => known.has(id)).join('、') || '无'}；未知或无权限工具：${ids.filter(id => !known.has(id)).join('、') || '无'}。下一轮将使用已激活 schema。`;
      },
    },
  ];
}

/** Small resident set; business tools are loaded by discover_tools. */
export function selectAgentTools(question: string, pageContext = '', attachmentTypes: string[] = []): AiTool[] {
  const q = normalize(`${question} ${pageContext}`);
  const all = listTools().filter(tool => tool.manifest);
  const ids = new Set(RESIDENT);
  if (attachmentTypes.length || /附件|excel|xlsx|csv|表格|文件/.test(q)) ids.add('read_excel');
  if (/生成|导出|明细表|清单|材料|结果表|excel|xlsx|表格/.test(q)) ids.add('write_excel');
  if (/项目|bom|成本|目标|降本|模块|竞品|健康|最贵|最便宜|最高|最低|均价|排名|前\s*\d+/.test(q)) ['query_projects', 'query_project_bom', 'query_project_cost', 'query_target_status'].forEach(id => ids.add(id));
  if (/报价|供应商|招标|谈价|议价/.test(q)) ['query_tender_analysis', 'query_supplier_profile'].forEach(id => ids.add(id));
  if (/物料|器件|行情|价格|趋势|洞察/.test(q)) ['query_material_insight', 'query_part_suppliers'].forEach(id => ids.add(id));
  if (/原声|评论|评价|反馈/.test(q)) ids.add('query_voice_dims');
  if (/手账|待办|工作记录|历史/.test(q)) ids.add('query_worklog');
  return [...createDiscoveryTools(), ...all.filter(tool => ids.has(tool.id))];
}

export function selectedToolIds(question: string, pageContext = '', attachmentTypes: string[] = []): string[] {
  return selectAgentTools(question, pageContext, attachmentTypes).map(tool => tool.id);
}
