import * as XLSX from 'xlsx';
import { makeTenderCanonicalKey, type TenderQuoteLineInput } from './db/tender';

export interface ParsedTenderQuote {
  sourceFileName: string;
  sourceFileHash: string;
  supplierName: string;
  lines: TenderQuoteLineInput[];
  totalAmount: number;
  headerRow: number;
  warnings: string[];
}

type HeaderKey = 'module' | 'name' | 'model' | 'specs' | 'quantity' | 'unitPrice' | 'lineTotal' | 'remark';

const HEADER_ALIASES: Record<HeaderKey, string[]> = {
  module: ['模块', '功能模块', 'module', 'module name', '模组'],
  name: ['器件名称', '物料名称', '物料', '名称', '品名', 'part name', 'part', 'item'],
  model: ['型号', '料号', '物料编码', '规格型号', 'model', 'mpn', 'part no'],
  specs: ['规格参数', '规格', '参数', '描述', '技术参数', 'spec', 'specs', 'description'],
  quantity: ['数量', '用量', 'qty', 'quantity'],
  unitPrice: ['单价', '含税单价', '未税单价', '成本', '报价', 'unit price', 'price', 'cost'],
  lineTotal: ['小计', '金额', '合计', '总价', 'line total', 'amount', 'total'],
  remark: ['备注', '说明', 'remark', 'note'],
};

function clean(value: unknown): string { return String(value ?? '').replace(/\u00a0/g, ' ').trim(); }
function headerNorm(value: unknown): string { return clean(value).toLowerCase().replace(/[\s\u3000_\-（）()【】\[\]:：]/g, ''); }
function numeric(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const raw = clean(value).replace(/[￥¥$,，\s]/g, '');
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function isHeaderMatch(actual: string, alias: string) {
  const normalizedAlias = headerNorm(alias);
  return actual === normalizedAlias || actual.includes(normalizedAlias) || normalizedAlias.includes(actual);
}
function detectHeaders(rows: unknown[][]) {
  let best: { row: number; map: Partial<Record<HeaderKey, number>>; score: number } = { row: 0, map: {}, score: 0 };
  rows.slice(0, 15).forEach((row, rowIndex) => {
    const map: Partial<Record<HeaderKey, number>> = {};
    row.forEach((cell, columnIndex) => {
      const actual = headerNorm(cell);
      if (!actual) return;
      (Object.keys(HEADER_ALIASES) as HeaderKey[]).some(key => {
        if (map[key] !== undefined) return false;
        if (HEADER_ALIASES[key].some(alias => isHeaderMatch(actual, alias))) { map[key] = columnIndex; return true; }
        return false;
      });
    });
    const score = Object.keys(map).length + (map.name === undefined ? 0 : 2) + (map.unitPrice === undefined && map.lineTotal === undefined ? -1 : 1);
    if (score > best.score) best = { row: rowIndex, map, score };
  });
  return best;
}
function inferSupplierName(fileName: string) {
  const base = clean(fileName).replace(/\.[^.]+$/, '');
  const candidate = base
    .replace(/第\s*\d+\s*轮|第\s*[一二三四五六七八九十]+\s*轮/gi, '')
    .replace(/摸底报价单?|报价单?|报价|成本报价|BOM|成本|明细|版本|v\d+(?:\.\d+)*/gi, '')
    .replace(/[()（）【】\[\]{}年月日_\-—\s]+/g, ' ')
    .trim();
  return candidate.length >= 1 && !/^(供应商|supplier|vendor)$/i.test(candidate) ? candidate : '';
}
export { inferSupplierName };

export function parseTenderRows(rows: unknown[][], sourceFileName = '报价.xlsx'): Omit<ParsedTenderQuote, 'sourceFileHash'> {
  const detected = detectHeaders(rows);
  const warnings: string[] = [];
  if (detected.map.name === undefined) warnings.push('未识别到器件名称列，请检查表头');
  if (detected.map.unitPrice === undefined && detected.map.lineTotal === undefined) warnings.push('未识别到单价/金额列，价格将按 0 导入');
  const lines: TenderQuoteLineInput[] = [];
  let totalAmount = 0;
  rows.slice(detected.row + 1).forEach((row, offset) => {
    const get = (key: HeaderKey) => detected.map[key] === undefined ? '' : row[detected.map[key] as number];
    const name = clean(get('name'));
    const model = clean(get('model'));
    const specs = clean(get('specs'));
    const moduleName = clean(get('module'));
    const quantity = numeric(get('quantity'), 1) || 1;
    const unitPrice = numeric(get('unitPrice'));
    const lineTotal = numeric(get('lineTotal'), unitPrice * quantity);
    if (!name && !model && !specs && !unitPrice && !lineTotal) return;
    if (!name) { warnings.push(`第${detected.row + offset + 2}行缺少器件名称，已跳过`); return; }
    const raw: Record<string, unknown> = {};
    row.forEach((value, index) => { raw[`col_${index + 1}`] = value; });
    lines.push({ source_row: detected.row + offset + 2, raw_name: name, raw_model: model, raw_specs: specs, module_name: moduleName, quantity, unit_price: unitPrice, line_total: lineTotal, remark: clean(get('remark')), raw_json: JSON.stringify(raw), canonical_key: makeTenderCanonicalKey(name, specs) });
    totalAmount += lineTotal;
  });
  return { sourceFileName, supplierName: inferSupplierName(sourceFileName), lines, totalAmount, headerRow: detected.row, warnings };
}

async function hashBuffer(buffer: ArrayBuffer) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
  }
  // 仅作为无 WebCrypto 环境的幂等回退，不用于安全认证。
  let hash = 2166136261;
  for (const value of new Uint8Array(buffer)) { hash ^= value; hash = Math.imul(hash, 16777619); }
  return `fnv-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export async function parseTenderQuoteFile(file: File): Promise<ParsedTenderQuote> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error('报价文件没有可读取的工作表');
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[firstSheet], { header: 1, raw: true, defval: '' });
  const parsed = parseTenderRows(rows, file.name);
  return { ...parsed, sourceFileHash: await hashBuffer(buffer) };
}
