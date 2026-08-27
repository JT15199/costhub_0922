// AI 物料规范化（v2.3.19，2026-08-19 用户：一套通用规则套所有物料——包装/结构件/硬件/加工费；笼统物料不编造）
// 设计：统一模板（品类|主规格|次规格|型号）+ 标准品类词表 + 通用单位规则；内容由 AI 判定（不按品类写解析器）
// 结果只写 parts 的 canonical 影子字段（原名/模块库不动）
import { getDb, getProjectBOMs, getSetting } from './db';
import { startOllamaStream } from './ollama';

export const CANONICAL_CATEGORIES = ['被动元件', '显示面板', '背光模组', '电源器件', '驱动板', '接口/连接器', '结构件', '包装材料', '线材', '声学', '散热', '加工费', '软件/固件', '其他'];

export interface CanonicalOut { original: string; category: string; standard: string; specs: string[]; model: string; }

export function buildCanonicalPrompt(names: string[]): string {
  return '你是物料命名规范化助手。把每个物料名规范成统一标准名。\n' +
    '【统一模板】标准名 = 品类 + 主规格 + 次规格 + 型号（按此顺序，没有的项省略）\n' +
    '【品类词表】只能从以下选一个：' + CANONICAL_CATEGORIES.join('、') + '\n' +
    '【规则】\n' +
    '1. 全半角/大小写/空格/标点统一；单位归一（K=千欧 M=兆欧 u=微 n=纳，Ω=欧 F=法 H=亨；0603/0805 等尺寸代码保留）；\n' +
    '2. 规格按重要性排（数值规格在前，封装/精度在后）；只提取物料名里明确给出的规格；\n' +
    '3. 【笼统物料】没有具体规格（如"支架""底座""外壳"）→ specs 输出空数组，standard 只含 品类+原名称，绝不编造规格；\n' +
    '4. 厂家/型号放在 model 字段。\n' +
    '只输出 JSON 数组（每项 {original, category, standard, specs: [], model}），不要任何解释：\n' +
    names.map(n => '"' + n + '"').join(',\n');
}

/** 健壮解析：直接 JSON（完整/带前缀）→ 失败逐对象抠出（截断兜底） */
export function parseCanonicalResult(text: string): CanonicalOut[] {
  const out: CanonicalOut[] = [];
  if (!text) return out;
  const norm = (x: any): CanonicalOut => ({ original: String(x.original || ''), category: String(x.category || '其他'), standard: String(x.standard || ''), specs: Array.isArray(x.specs) ? x.specs.map(String) : [], model: String(x.model || '') });
  // ① 直接 JSON 解析（完整数组或前缀包裹后的数组）
  try {
    const m = text.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    if (Array.isArray(arr)) return arr.map(norm).filter(x => x.original);
  } catch { }
  // ② 截断兜底：逐个抠出完整对象（对象内无嵌套 {}，specs 是 [] 不影响）
  const re = /\{[^{}]*\}/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(text)) !== null) {
    try { out.push(norm(JSON.parse(mm[0]))); } catch { }
  }
  return out.filter(x => x.original);
}

/** 构造规范化撤销数据（{__restore_parts:[{id, 原影子值}]}）——撤销=恢复 UPDATE 前的影子字段原值（非删除行） */
export function buildCanonicalUndo(oldRows: any[]): Record<string, any> {
  const rows = (oldRows || []).filter((r: any) => r && Number(r.id) > 0).map((r: any) => ({
    id: Number(r.id),
    canonical_name: String(r.canonical_name || ''),
    canonical_category: String(r.canonical_category || ''),
    canonical_specs: String(r.canonical_specs || '[]'),
    canonical_updated_at: String(r.canonical_updated_at || ''),
  }));
  return { __restore_parts: rows };
}

/** 隐线规范化（2026-08-27 用户：规范化是被动触发的隐线——导入新器件时自动规范，用户无需主动操作）
 * 单批（≤20）调本地模型写 canonical 影子字段；模型不可用/失败静默返回（不阻塞导入、不打扰）；60s 完全无输出放弃（有输出无限等，不截断） */
export async function canonicalizePartBatch(parts: { id: number; name: string; model?: string }[]): Promise<{ done: number; kept: number; failed: number }> {
  const items = (parts || []).filter((x: any) => x && Number(x.id) > 0 && String(x.name || '').trim());
  if (!items.length) return { done: 0, kept: 0, failed: 0 };
  const db = await getDb();
  for (const sql of ["ALTER TABLE parts ADD COLUMN canonical_name TEXT DEFAULT ''", "ALTER TABLE parts ADD COLUMN canonical_category TEXT DEFAULT ''", "ALTER TABLE parts ADD COLUMN canonical_specs TEXT DEFAULT '[]'", "ALTER TABLE parts ADD COLUMN canonical_updated_at TEXT DEFAULT ''"]) { try { await db.execute(sql); } catch { } }
  // 预检：模型不可用直接静默返回（隐线不阻塞）
  try {
    const { detectOllama } = await import('./aiStatus');
    const st = await detectOllama();
    if (!st.connected) return { done: 0, kept: 0, failed: items.length };
  } catch { return { done: 0, kept: 0, failed: items.length }; }
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  const model = await getSetting('local_ai_model', '');
  if (!model) return { done: 0, kept: 0, failed: items.length };
  const names = items.map(x => x.name + (x.model ? ' ' + x.model : ''));
  let full = '';
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false; let lastAt = Date.now(); let cleanup: (() => void) | null = null;
      const done = () => { if (!settled) { settled = true; clearInterval(iv); try { cleanup?.(); } catch { } resolve(); } };
      const fail = (e: any) => { if (!settled) { settled = true; clearInterval(iv); try { cleanup?.(); } catch { } reject(e); } };
      const iv = setInterval(() => { if (Date.now() - lastAt > 60000) fail(new Error('模型 60s 无输出（隐线规范化放弃）')); }, 1000);
      startOllamaStream(base, model, [
        { role: 'system', content: '你是物料命名规范化助手。' },
        { role: 'user', content: buildCanonicalPrompt(names) },
      ], t => { lastAt = Date.now(); full += t; }, () => { }, () => done(), e => fail(new Error(e)),
        { endpoint: 'native', think: false, json: false, num_predict: 4096 }).then(c => { cleanup = c; }).catch(() => { /* 错误走 onError */ });
    });
  } catch { return { done: 0, kept: 0, failed: items.length }; }
  const parsed = parseCanonicalResult(full);
  const byOriginal = new Map(parsed.map(p => [p.original, p]));
  let done = 0, kept = 0, failed = 0;
  for (const it of items) {
    const key = it.name + (it.model ? ' ' + it.model : '');
    const p = byOriginal.get(key) || byOriginal.get(it.name);
    if (p && p.standard) {
      try {
        await db.execute("UPDATE parts SET canonical_name=?, canonical_category=?, canonical_specs=?, canonical_updated_at=datetime('now','localtime') WHERE id=?",
          [p.standard, p.category || '其他', JSON.stringify(p.specs || []), it.id]);
        done++;
      } catch { failed++; }
    } else kept++;
  }
  return { done, kept, failed };
}

/** 还原单条物料规范化：清空 canonical 影子字段（原名本就没动过，还原=回到未规范状态，可重新规范化） */
export async function resetPartCanonical(partId: number): Promise<boolean> {
  try {
    const db = await getDb();
    await db.execute("UPDATE parts SET canonical_name='', canonical_category='', canonical_specs='[]', canonical_updated_at='' WHERE id=?", [partId]);
    return true;
  } catch { return false; }
}

export async function canonicalizeProject(projectId: number, onProgress?: (done: number, total: number, current: string) => void): Promise<{ total: number; done: number; kept: number; failed: number; errors?: string[] }> {
  const db = await getDb();
  // canonical 影子列兜底（幂等 ALTER；原名/模块库不动）
  for (const sql of ["ALTER TABLE parts ADD COLUMN canonical_name TEXT DEFAULT ''", "ALTER TABLE parts ADD COLUMN canonical_category TEXT DEFAULT ''", "ALTER TABLE parts ADD COLUMN canonical_specs TEXT DEFAULT '[]'", "ALTER TABLE parts ADD COLUMN canonical_updated_at TEXT DEFAULT ''"]) { try { await db.execute(sql); } catch { } }
  const boms = (await getProjectBOMs(projectId)).filter((b: any) => !b.is_deleted);
  // 去重物料（name+model）
  const seen = new Map<string, { part_id: number; name: string; model: string }>();
  for (const b of boms) {
    const key = (b.part_name || '') + '|' + (b.part_model || '');
    if (!seen.has(key) && b.part_id) seen.set(key, { part_id: b.part_id, name: b.part_name || '', model: b.part_model || '' });
  }
  const items = [...seen.values()].filter(x => x.name);
  const total = items.length;
  if (!total) return { total: 0, done: 0, kept: 0, failed: 0 };
  const base = (await getSetting('local_ai_base_url', 'http://localhost:11434')).replace(/\/$/, '');
  const model = await getSetting('local_ai_model', '');
  if (!model) return { total, done: 0, kept: 0, failed: total };
  const stats = { total, done: 0, kept: 0, failed: 0 };
  const undoRows: any[] = [];
  const errors: string[] = [];
  const BATCH = 20;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const names = batch.map(x => x.name + (x.model ? ' ' + x.model : ''));
    let full = '';
    try {
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(base, model, [
          { role: 'system', content: '你是物料命名规范化助手。' },
          { role: 'user', content: buildCanonicalPrompt(names) },
        ], t => { full += t; }, () => { }, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', think: false, json: false, num_predict: 4096 });
      });
    } catch (e) { stats.failed += batch.length; const m = String((e as any)?.message || e || '模型无响应'); if (!errors.includes(m)) errors.push(m); continue; }
    const parsed = parseCanonicalResult(full);
    const byOriginal = new Map(parsed.map(p => [p.original, p]));
    for (const it of batch) {
      const key = it.name + (it.model ? ' ' + it.model : '');
      const p = byOriginal.get(key) || byOriginal.get(it.name);
      stats.done++;
      if (p && p.standard) {
        try {
          const old = await db.select<any[]>('SELECT id, canonical_name, canonical_category, canonical_specs, canonical_updated_at FROM parts WHERE id = ?', [it.part_id]);
          if (old.length) undoRows.push(old[0]);
        } catch { }
        try {
          await db.execute("UPDATE parts SET canonical_name=?, canonical_category=?, canonical_specs=?, canonical_updated_at=datetime('now','localtime') WHERE id=?",
            [p.standard, p.category || '其他', JSON.stringify(p.specs || []), it.part_id]);
        } catch { }
        // 笼统（specs 空）也算规范成功（kept 之外单独），done 已加
      } else {
        stats.kept++; // 保留原名未规范
      }
      onProgress?.(stats.done, total, it.name);
    }
  }
  // 撤销支持：UPDATE 前的影子字段原值交给审计 undo_json（设置页可整批还原）
  try { if (undoRows.length) { const W = window as any; W.__costhub_undo = { toolId: 'canonicalize_project', inserts: buildCanonicalUndo(undoRows) }; } } catch { }
  return { ...stats, errors: errors.slice(0, 3) };
}
