// Quality Harness V2 — 一级导航动作
//
// 从 V1 的 actions.mjs 中拆出（V2 要求「单文件不超过 300 行」）。

/** 点击一级导航项并等待页面出现内容。 */
export async function navigateTo(cdp, entry, timeoutMs = 25000) {
  const clicked = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid="nav-${entry.key}"]')
      || [...document.querySelectorAll('.nav-item')].find(n => (n.innerText || '').trim() === ${JSON.stringify(entry.label)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, reason: `nav entry not found: ${entry.key} (${entry.label})` };

  // 离开登录态后 .main-content 一定有子节点；空白即视为失败
  await cdp.waitFor(
    `content after nav-${entry.key}`,
    async () => await cdp.evaluate(`(() => {
      const main = document.querySelector('.main-content');
      if (!main) return false;
      const text = (main.innerText || '').trim();
      return main.childElementCount > 0 && text.length > 10 ? text.length : false;
    })()`),
    { timeoutMs, intervalMs: 300 },
  );

  return cdp.evaluateJson(`JSON.stringify((() => {
    const main = document.querySelector('.main-content');
    return {
      ok: true,
      textLength: (main?.innerText || '').trim().length,
      childElements: main?.childElementCount ?? 0,
      tables: main?.querySelectorAll('.ant-table').length ?? 0,
      activeNav: document.querySelector('.nav-item.active')?.innerText?.trim() || '',
    };
  })())`);
}

/** 一级导航的 testid 与中文标签（用于 E2E-003 遍历与报告可读性）。 */
export const NAV_ENTRIES = [
  { key: 'dashboard', label: '今日工作台' },
  { key: 'projects', label: '项目' },
  { key: 'intelligence', label: '情报' },
  { key: 'library', label: '资料库' },
  { key: 'workLog', label: '工作手账' },
];
