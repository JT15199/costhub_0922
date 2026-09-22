// 内置提示词模板识别（2026-09-21）
// 用户要求：「如果提示词是已经内置的 skills，那些不需要展示，因为肯定是没问题的，只需要看哪些提示词是新的需要审批的，减少工作量。」
// 做法：把内置模板（各内置技能提示词 / 云端安全系统提示词 / C2 脱敏提示词）在正文里逐字定位，
// 命中的区间标为 builtin（可折叠），其余为 dynamic（用户真正需要核对的"新增内容"）。
// 模板经 cloudSafePublicText 的公开化改写后仍可能出现，因此两种形态都进索引。

export interface BuiltinTemplate { label: string; text: string }
export interface PromptSegment { kind: 'builtin' | 'dynamic'; text: string; label?: string }

let templateCache: BuiltinTemplate[] | null = null;

/** 测试与离线场景可直接注入模板索引。 */
export function setBuiltinTemplates(templates: BuiltinTemplate[] | null): void {
  templateCache = templates;
}

export function getBuiltinTemplates(): BuiltinTemplate[] | null {
  return templateCache;
}

/** 懒加载内置模板索引（动态 import 避免与 trendService/cloudConfirm 形成静态循环依赖）。 */
export async function loadBuiltinTemplates(): Promise<BuiltinTemplate[]> {
  if (templateCache) return templateCache;
  const [trend, cloud, c2] = await Promise.all([
    import('../trendService').catch(() => null) as Promise<any>,
    import('./cloudContext').catch(() => null) as Promise<any>,
    import('./c2Bridge').catch(() => null) as Promise<any>,
  ]);
  const templates: BuiltinTemplate[] = [];
  if (cloud?.CLOUD_SYSTEM_PROMPT) templates.push({ label: '云端安全系统提示词（内置）', text: String(cloud.CLOUD_SYSTEM_PROMPT) });
  if (typeof c2?.c2SafeSystemPrompt === 'function') {
    try { templates.push({ label: 'C2 脱敏系统提示词（内置）', text: String(c2.c2SafeSystemPrompt()) }); } catch { /* 忽略 */ }
  }
  const skills: any[] = Array.isArray(trend?.BUILTIN_SKILLS) ? trend.BUILTIN_SKILLS : [];
  const safeText = typeof trend?.cloudSafePublicText === 'function' ? trend.cloudSafePublicText : null;
  for (const skill of skills) {
    const raw = String(skill?.systemPrompt || '').trim();
    if (!raw) continue;
    templates.push({ label: `内置技能「${skill?.name || skill?.id}」`, text: raw });
    if (safeText) {
      try {
        const mapped = String(safeText(raw)).trim();
        if (mapped && mapped !== raw) templates.push({ label: `内置技能「${skill?.name || skill?.id}」（公开化）`, text: mapped });
      } catch { /* 忽略 */ }
    }
  }
  // 长模板优先：避免短模板把长模板切成碎片。
  templateCache = templates.filter(template => template.text.length >= 60).sort((a, b) => b.text.length - a.text.length);
  return templateCache;
}

/** 纯函数：把一段正文切成 builtin / dynamic 片段。 */
export function splitPromptSegments(text: string, templates: BuiltinTemplate[]): PromptSegment[] {
  if (!text) return [];
  if (!templates.length) return [{ kind: 'dynamic', text }];
  const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
  const spans: Array<{ start: number; end: number; label: string }> = [];
  for (const template of templates) {
    const needle = template.text;
    if (!needle) continue;
    let from = 0;
    while (from <= text.length - needle.length) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      spans.push({ start: index, end: index + needle.length, label: template.label });
      from = index + needle.length;
    }
  }
  if (!spans.length) {
    const compacted = compact(text);
    const matched = templates.find(template => compact(template.text) === compacted);
    return matched ? [{ kind: 'builtin', text, label: matched.label }] : [{ kind: 'dynamic', text }];
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; label: string }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) { last.end = Math.max(last.end, span.end); continue; }
    merged.push({ ...span });
  }
  const segments: PromptSegment[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) segments.push({ kind: 'dynamic', text: text.slice(cursor, span.start) });
    segments.push({ kind: 'builtin', text: text.slice(span.start, span.end), label: span.label });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ kind: 'dynamic', text: text.slice(cursor) });
  return segments.filter(segment => segment.text.length > 0);
}

export interface PreviewMessageSplit {
  role: string;
  segments: PromptSegment[];
  builtinChars: number;
  dynamicChars: number;
  builtinLabels: string[];
}

export interface PreviewSplit {
  messages: PreviewMessageSplit[];
  builtinChars: number;
  dynamicChars: number;
  builtinLabels: string[];
}

/** 拆一份审批载荷（messages 形状或原生搜索 input 形状）；不是这些形状时返回 null，调用方退回原文展示。 */
export function splitPreviewPayload(previewJson: string, templates: BuiltinTemplate[]): PreviewSplit | null {
  if (!previewJson) return null;
  let parsed: any;
  try { parsed = JSON.parse(previewJson); } catch { return null; }
  const list: any[] = Array.isArray(parsed?.messages) ? parsed.messages : Array.isArray(parsed?.input) ? parsed.input : [];
  if (!list.length) return null;
  const messages: PreviewMessageSplit[] = list.map(raw => {
    const text = String(raw?.content ?? '');
    const segments = splitPromptSegments(text, templates);
    const builtinChars = segments.filter(segment => segment.kind === 'builtin').reduce((sum, segment) => sum + segment.text.length, 0);
    return {
      role: String(raw?.role || 'unknown'),
      segments,
      builtinChars,
      dynamicChars: text.length - builtinChars,
      builtinLabels: [...new Set(segments.filter(segment => segment.kind === 'builtin').map(segment => segment.label || '内置模板'))],
    };
  });
  const builtinChars = messages.reduce((sum, item) => sum + item.builtinChars, 0);
  const dynamicChars = messages.reduce((sum, item) => sum + item.dynamicChars, 0);
  return { messages, builtinChars, dynamicChars, builtinLabels: [...new Set(messages.flatMap(item => item.builtinLabels))] };
}
