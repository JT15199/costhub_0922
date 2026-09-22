import { afterEach, expect, it, vi } from 'vitest';
import { consumeInsightTab, openInsightCenter } from '../insightNavigation';

afterEach(() => vi.unstubAllGlobals());

it('keeps the requested findings tab across lazy mount and consumes subsequent live requests', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  const navigate = vi.fn(() => expect(store.has('costhub-open-insights-pending')).toBe(true));
  openInsightCenter(navigate, 'audit'); // Receiver is not mounted yet.
  expect(navigate).toHaveBeenCalledWith('projects');
  expect(consumeInsightTab()).toBe('audit');
  expect(store.size).toBe(0);
  const received: string[] = [];
  target.addEventListener('costhub-open-insights', event => received.push(consumeInsightTab(event)));
  openInsightCenter(navigate, 'advice');
  openInsightCenter(navigate, 'diff');
  openInsightCenter(navigate);
  expect(received).toEqual(['advice', 'diff', 'auto']);
  expect(store.size).toBe(0);
});
