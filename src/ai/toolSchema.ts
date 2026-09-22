import { Type, validateToolArguments } from '@earendil-works/pi-ai';
import type { AiTool } from '../aiTools';

const optionalText = () => Type.Optional(Type.String());
const optionalNumber = () => Type.Optional(Type.Number({ minimum: 0 }));
const bomRow = Type.Object({ name: Type.String({ minLength: 1 }), model: optionalText(), quantity: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), cost: optionalNumber(), module: optionalText(), mainCat: optionalText(), sub: optionalText() });
const cell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const nested: Record<string, Record<string, any>> = {
  import_bom_to_project: { items: Type.Array(bomRow) },
  import_competitor_bom: { rows: Type.Array(bomRow) },
  import_supplier_quote: { rows: Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), model: optionalText(), supplier: Type.String({ minLength: 1 }), price: Type.Number({ minimum: 0 }), share: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })) })) },
  import_voice_items: { items: Type.Array(Type.Union([Type.String(), Type.Object({ content: Type.String() }), Type.Object({ text: Type.String() })])) },
  write_excel: { sheets: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 31 }), rows: Type.Array(Type.Array(cell), { minItems: 1 }) }), { minItems: 1 }) },
  generate_report: { slides: Type.Array(Type.Object({ heading: Type.String(), points: Type.Array(Type.String()) }), { minItems: 1 }) },
  ask_user: { options: Type.Array(Type.String(), { minItems: 1 }) },
};

export function withNativeSchema(tool: AiTool): AiTool {
  const paged = ['query_projects', 'query_project_bom', 'query_target_status', 'query_tender_analysis', 'query_cost_snapshots'].includes(tool.id);
  const params = [...tool.params];
  if (paged) params.push({ key: 'offset', type: 'number', minimum: 0, desc: '分页起点，从 0 开始；使用上次返回的 nextOffset' }, { key: 'limit', type: 'number', minimum: 1, maximum: 200, desc: tool.id === 'query_project_bom' ? '明细页大小或排名/分组前N项（统计默认5），最大200' : '每页最多 200 行' });
  return { ...tool, desc: tool.desc.replace(/JSON 数组字符串/g, '数组') + (paged ? ' 大结果使用 offset/limit 分页；不得把单页当成全部。' : ''), params: params.filter((p, i) => params.findIndex(other => other.key === p.key) === i).map(param => nested[tool.id]?.[param.key]
    ? { ...param, type: 'array', schema: nested[tool.id][param.key], desc: param.desc.replace(/JSON 数组字符串/g, '数组') }
    : param) };
}

/** Accept old saved string arguments, but advertise real arrays to new native calls. */
export function prepareBusinessArgs(id: string, args: unknown): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const result = { ...args } as Record<string, unknown>;
  for (const key of Object.keys(nested[id] || {})) {
    if (typeof result[key] === 'string') { try { result[key] = JSON.parse(result[key] as string); } catch { /* validator returns the error */ } }
  }
  return result;
}

export function schemaFor(tool: AiTool) {
  return Type.Object(Object.fromEntries(tool.params.map(param => {
    let schema: any;
    if (param.schema) schema = param.schema;
    else if (param.enum?.length) schema = Type.Union(param.enum.map(value => Type.Literal(value)));
    else if (param.type === 'number') schema = Type.Number({ ...(param.minimum !== undefined ? { minimum: param.minimum } : {}), ...(param.maximum !== undefined ? { maximum: param.maximum } : {}) });
    else if (param.type === 'boolean') schema = Type.Boolean();
    else if (param.type === 'array') schema = Type.Array(param.items === 'number' ? Type.Number() : param.items === 'boolean' ? Type.Boolean() : Type.String());
    else if (param.type === 'object') schema = Type.Record(Type.String(), Type.Unknown());
    else schema = Type.String();
    schema = { ...schema, description: param.desc };
    return [param.key, param.required ? schema : Type.Optional(schema)];
  })));
}

export function validateNestedArgs(tool: AiTool, args: unknown): void {
  if (!nested[tool.id]) return;
  validateToolArguments({ name: tool.id, description: tool.desc, parameters: schemaFor(withNativeSchema(tool)) }, { type: 'toolCall', id: 'validate', name: tool.id, arguments: args as Record<string, unknown> });
}

export function parseToolArray(value: unknown, field: string): any[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${field} 必须是数组`);
  return parsed;
}
