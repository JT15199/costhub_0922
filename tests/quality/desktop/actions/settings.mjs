// Quality Harness V2 — 设置页读取与凭据泄漏检查
//
// 从 V1 的 actions.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
//
// 安全约定：本文件**只输出形状统计**，绝不返回或记录任何 input 的完整 value。
// 报告里出现的只有「有几个 input 长得像密钥」这类计数。

import { sleep } from '../cdpClient.mjs';

/**
 * 打开系统设置并检查 DOM 是否泄漏真实 API Key。
 * @returns {{modalOpen: boolean, textLength: number, secretShapedInputs: number, longOpaqueInputs: number, ...}}
 */
export async function inspectSettingsForCredentialLeaks(cdp) {
  // 设置入口 = 侧边栏底部的 Dropdown 触发器，菜单项里才有「系统设置」
  const openedMenu = await cdp.evaluate(`(() => {
    const trigger = document.querySelector('[data-testid="nav-settings-trigger"]')
      || [...document.querySelectorAll('.sidebar-footer > *')][0];
    if (!trigger) return false;
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    trigger.click();
    return true;
  })()`);

  if (!openedMenu) return { modalOpen: false, reason: 'settings dropdown trigger not found' };

  const clickedItem = await cdp.waitFor(
    'settings menu item',
    async () => await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find(node => /系统设置/.test(node.innerText || ''));
      if (!item) return false;
      item.click();
      return true;
    })()`),
    { timeoutMs: 10000, intervalMs: 250 },
  ).catch(() => false);

  if (!clickedItem) return { modalOpen: false, reason: 'settings menu item never appeared' };

  const modalOpened = await cdp.waitFor(
    'settings modal',
    async () => await cdp.evaluate(`(() => {
      const modal = [...document.querySelectorAll('.ant-modal')]
        .find(m => /系统设置|设置/.test(m.innerText || '') && m.offsetParent !== null);
      return Boolean(modal);
    })()`),
    { timeoutMs: 20000, intervalMs: 400 },
  ).then(() => true).catch(() => false);

  // 给设置页充分时间加载本地 AI / 云端配置
  await sleep(2500);

  const probe = await cdp.evaluateJson(`JSON.stringify((() => {
    const modal = [...document.querySelectorAll('.ant-modal')]
      .find(m => /系统设置|设置/.test(m.innerText || '') && m.offsetParent !== null);
    const text = (modal?.innerText || '').slice(0, 40000);
    // 只探测形状，不抓取完整 value
    const inputs = [...(modal?.querySelectorAll('input') || [])];
    const secretShaped = inputs.filter(i => /^(sk-|sk-ant-|AIza|gh[pousr]_|xox)/.test(String(i.value || ''))).length;
    const longSecretShaped = inputs.filter(i => String(i.value || '').length >= 32 && /^[A-Za-z0-9_\\-]{32,}$/.test(String(i.value || ''))).length;
    return {
      modalOpen: Boolean(modal),
      textLength: text.length,
      mentionsConfiguredState: /已配置|未配置/.test(text),
      secretShapedInputs: secretShaped,
      longOpaqueInputs: longSecretShaped,
      inputCount: inputs.length,
      mentionsApiKeyWords: /API ?Key|密钥|Token/i.test(text),
      mentionsLocalAi: /本地 (AI|模型)|Ollama|llama\\.cpp/i.test(text),
      mentionsCloud: /云端/.test(text),
      sample: text.slice(0, 240),
    };
  })())`);

  // 关闭弹窗，避免影响后续场景
  await cdp.evaluate(`(() => {
    const modal = [...document.querySelectorAll('.ant-modal')].find(m => m.offsetParent !== null && /设置/.test(m.innerText || ''));
    const close = modal?.querySelector('.ant-modal-close');
    if (close) close.click();
    return Boolean(close);
  })()`);
  await sleep(1000);

  return { ...probe, modalOpen: probe.modalOpen && modalOpened };
}
