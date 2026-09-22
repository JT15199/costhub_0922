import { getProjects } from '../db';

export interface ProjectMatch {
  project: any;
  score: number;
  reason: string;
}

export function normalizeEntity(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[\s\u3000\-_\/\\.,，。:：()（）\[\]【】]/g, '');
}

export async function resolveProject(input: string): Promise<{ selected: any | null; candidates: ProjectMatch[] }> {
  const query = normalizeEntity(input);
  const projects = (await getProjects('', '', '')).filter((project: any) => !project.is_deleted);
  const candidates = projects.map(project => {
    const code = normalizeEntity(project.code);
    const name = normalizeEntity(project.name);
    const exact = query && (query === code || query === name);
    const contains = query && (code.includes(query) || name.includes(query) || query.includes(code) || query.includes(name));
    const score = exact ? 1 : contains ? 0.7 : 0;
    return { project, score, reason: exact ? '项目代号/名称完全匹配' : contains ? '项目代号或名称包含查询词' : '' };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  // ponytail: 仅完全匹配自动选中；包含匹配即使只有一个候选也交给用户确认，避免错写错算。
  return { selected: candidates[0]?.score === 1 ? candidates[0].project : null, candidates };
}
