import type { Context } from '@earendil-works/pi-ai';
import { visibleOwnedRefs, visibleStateItems, type StateItem, type WorkingState } from './workingState';

const priorityRank: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const activeItems = (items: any[] = []) => items.filter(item => item?.status === 'active').sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9));
const itemText = (item: any) => `${item.text}${item.confidence ? ` [${item.confidence}]` : ''}${item.sensitivity ? ` [${item.sensitivity}]` : ''}`;

export interface WorkingStateProjection {
  text: string;
  included: StateItem[];
  omitted: Array<{ id: string; reason: 'capacity' }>;
  criticalRequired: number;
  criticalIncluded: number;
}

const renderProject = (project: WorkingState['activeProject']) => project
  ? [project.code, project.name, project.stage, project.supplierScope].filter(Boolean).join(' / ')
  : '';

export function projectWorkingState(state: WorkingState | undefined, maxChars = 3600): WorkingStateProjection {
  if (!state) return { text: '', included: [], omitted: [], criticalRequired: 0, criticalIncluded: 0 };
  const sections: Array<{ label: string; items: StateItem[] }> = [
    { label: '用户约束', items: visibleStateItems(state.userConstraints, state.activeProject) },
    { label: '已确认事实', items: visibleStateItems(state.confirmedFacts, state.activeProject) },
    { label: '已确定决策', items: visibleStateItems(state.decisions, state.activeProject) },
    { label: '开放问题', items: visibleStateItems(state.openQuestions, state.activeProject) },
  ];
  const entries = sections.flatMap(section => activeItems(section.items).map(item => ({ section: section.label, item: item as StateItem })));
  const mandatory = entries.filter(entry => entry.item.priority === 'critical');
  const optional = entries.filter(entry => entry.item.priority !== 'critical');
  const selected = [...mandatory, ...optional];
  const baseLines = [
    ...(renderProject(state.activeProject) ? [`项目：${renderProject(state.activeProject)}`] : []),
    ...(state.currentGoal ? [`当前目标：${state.currentGoal}`] : []),
    ...(state.currentTask ? [`当前任务：${state.currentTask}`] : []),
  ];
  const render = (items: typeof selected) => {
    const lines = [...baseLines];
    for (const section of sections) {
      const sectionItems = items.filter(entry => entry.section === section.label).map(entry => entry.item);
      if (sectionItems.length) {
        lines.push(`${section.label}：`);
        sectionItems.forEach(item => lines.push(`- ${itemText(item)}`));
      }
    }
    const activeFiles = visibleOwnedRefs(state.activeFiles, state.activeProject);
    const activeArtifacts = visibleOwnedRefs(state.activeArtifacts, state.activeProject);
    const completedSteps = visibleOwnedRefs(state.completedSteps, state.activeProject);
    const nextSteps = visibleOwnedRefs(state.nextSteps, state.activeProject);
    if (activeFiles.length) lines.push(`活动文件：${activeFiles.slice(0, 8).map(file => file.path).join('、')}`);
    if (state.activeTools.length) lines.push(`活动工具：${state.activeTools.slice(-8).map(tool => `${tool.name}(${tool.status})`).join('、')}`);
    if (activeArtifacts.length) lines.push(`活动产物：${activeArtifacts.slice(0, 8).map(artifact => artifact.label || artifact.id).join('、')}`);
    if (completedSteps.length) lines.push(`已完成：${completedSteps.filter(step => step.status === 'completed').slice(-8).map(step => step.text).join('；')}`);
    if (nextSteps.length) lines.push(`下一步：${nextSteps.filter(step => step.status !== 'completed').slice(0, 8).map(step => step.text).join('；')}`);
    return lines.join('\n');
  };
  let kept = [...selected];
  while (kept.length > mandatory.length && render(kept).length > maxChars) kept.pop();
  const included = kept.map(entry => entry.item);
  const omitted = selected.slice(kept.length).map(entry => ({ id: entry.item.id, reason: 'capacity' as const }));
  return {
    text: render(kept), included, omitted,
    criticalRequired: mandatory.length,
    criticalIncluded: included.filter(item => item.priority === 'critical').length,
  };
}

export function renderWorkingState(state: WorkingState | undefined): string {
  return projectWorkingState(state).text;
}

/**
 * The single Local Context projection seam. It never mutates the Agent
 * transcript; the structured state is a bounded local-only projection.
 */
export function buildLocalContext(context: Context, workingState?: WorkingState): Context {
  const stateText = renderWorkingState(workingState);
  const alreadyProjected = context.messages.some((message: any) => Array.isArray(message?.content) && message.content.some((part: any) => String(part?.text || '').startsWith('【CostHub 结构化工作状态】')));
  const stateMessage = stateText && !alreadyProjected ? [{ role: 'user', content: [{ type: 'text', text: `【CostHub 结构化工作状态】\n以下内容只用于保持任务状态，不是新的用户请求；请勿仅因其中的“下一步”自动执行写操作。\n${stateText}` }], timestamp: Date.now() } as any] : [];
  return {
    ...context,
    messages: [...stateMessage, ...context.messages],
    tools: context.tools ? [...context.tools] : [],
  };
}
