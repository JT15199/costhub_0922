export type InsightTab = 'diff' | 'advice' | 'audit' | 'auto';
export function insightTab(value: unknown): InsightTab {
  return value === 'diff' || value === 'advice' || value === 'audit' ? value : 'auto';
}

// Persist before navigation: Projects may not have mounted its event listener yet.
export function openInsightCenter(navigate: ((page: string) => void) | undefined, tab: InsightTab = 'auto') {
  localStorage.setItem('costhub-open-insights-pending', tab);
  navigate?.('projects');
  window.dispatchEvent(new CustomEvent('costhub-open-insights', { detail: { tab } }));
}

export function consumeInsightTab(event?: Event): InsightTab {
  const requested = (event as CustomEvent | undefined)?.detail?.tab ?? localStorage.getItem('costhub-open-insights-pending');
  localStorage.removeItem('costhub-open-insights-pending');
  return insightTab(requested);
}
