// Quality Harness V2 — AI 协作窗动作
//
// 从 V1 的 actions.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
//
// 走查记录（2026-09-22）：
//   * AI 面板默认折叠成 42px 竖条（localStorage['ai-panel-collapsed'] 缺省即折叠），
//     所以 E2E 必须先展开；断言需要同时接受「已展开」与「需要展开」两种情况。
//   * antd Input.TextArea 的 data-testid 会落到包裹节点上，真实可编辑元素是内部 textarea。
//     这里不依赖属性落点，运行时定位 textarea 再自行标记。

import { sleep, typeInto } from '../cdpClient.mjs';

/** AI 面板可能默认折叠成 42px 竖条；展开后有 composer。 */
export async function expandAiPanel(cdp) {
  const alreadyOpen = await cdp.evaluate(`Boolean(document.querySelector('.local-ai-composer'))`);
  if (alreadyOpen) return { ok: true, alreadyOpen: true };

  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="展开 AI 协作窗"]')
      || [...document.querySelectorAll('button')].find(b => /展开 AI 协作窗/.test(b.getAttribute('aria-label') || ''));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, reason: 'expand button not found and panel is not open (AI panel rail missing?)' };

  await cdp.waitFor(
    'AI composer after expand',
    async () => await cdp.evaluate(`Boolean(document.querySelector('.local-ai-composer'))`),
    { timeoutMs: 20000, intervalMs: 250 },
  );

  return { ok: true, alreadyOpen: false };
}

/** 采集 AI 协作窗状态（不触发任何模型推理）。 */
export async function collectAiPanelState(cdp) {
  return cdp.evaluateJson(`JSON.stringify((() => {
    const root = document.querySelector('.local-ai-root');
    const composer = document.querySelector('.local-ai-composer');
    const input = document.querySelector('.local-ai-composer textarea, [data-testid="local-ai-input"]');
    const modelSelect = document.querySelector('[aria-label="选择本地模型"]');
    const buttons = [...(composer?.querySelectorAll('button') || [])].map(b => ({
      aria: b.getAttribute('aria-label') || '', title: b.title || '', disabled: Boolean(b.disabled),
    }));
    const text = (root?.innerText || '').trim();
    return {
      panelPresent: Boolean(root),
      collapsed: Boolean(document.querySelector('.local-ai-collapsed')),
      composerPresent: Boolean(composer),
      inputPresent: Boolean(input),
      inputDisabled: input ? Boolean(input.disabled) : null,
      inputEditable: input ? !input.disabled && !input.readOnly : null,
      modelControlPresent: Boolean(modelSelect),
      sendButtonPresent: buttons.length > 0,
      buttonCount: buttons.length,
      buttonAriaLabels: buttons.map(b => b.aria).filter(Boolean),
      // 未就绪提示（模型未启动时 UI 应当明确提示而不是崩）
      readinessHints: ['未启动', '未就绪', '未运行', '未下载', '离线', '模型'].filter(word => text.includes(word)),
      statusText: text.slice(0, 300),
    };
  })())`);
}

/** 在 composer 输入框里写入文本（不发送）。 */
export async function typeInComposer(cdp, text) {
  const found = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid="local-ai-input"]');
    const el = (node && node.tagName === 'TEXTAREA')
      ? node
      : (node?.querySelector('textarea') || document.querySelector('.local-ai-composer textarea'));
    if (!el) return false;
    el.setAttribute('data-quality-composer', '1');
    return el.tagName;
  })()`);
  if (!found) return { ok: false, reason: 'composer textarea not found' };

  const result = await typeInto(cdp, '[data-quality-composer="1"]', text);
  if (!result?.ok) return { ok: false, reason: `composer input not writable (${JSON.stringify(result)})` };
  await sleep(200);

  const value = await cdp.evaluate(`(() => { const el = document.querySelector('[data-quality-composer="1"]'); return el ? el.value : null; })()`);
  return { ok: value === text, value, expected: text };
}

/** 清空 composer，避免残留输入影响后续场景。 */
export async function clearComposer(cdp) {
  await typeInto(cdp, '[data-quality-composer="1"]', '');
}
