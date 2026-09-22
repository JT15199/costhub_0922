// Quality Harness V2 — CDP 端口发现与页面输入辅助
//
// 从 V1 的单个 cdpClient.mjs 中拆出。这里放「与浏览器/端口打交道」的小工具，
// 不碰 CDP RPC 本身（那在 ./client.mjs）。

import { sleep } from './client.mjs';

/**
 * 轮询等待 CDP HTTP 端点上线（应用启动后 WebView2 需要数秒才创建页面）。
 *
 * @param {number} port
 * @param {{timeoutMs?: number, intervalMs?: number, isAlive?: () => boolean}} [options]
 */
export async function waitForCdpPort(port, { timeoutMs = 60000, intervalMs = 500, isAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';

  for (;;) {
    if (isAlive && !isAlive()) {
      throw new Error(`CDP_PORT_ABORTED: process went away while waiting for port ${port}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`CDP_PORT_TIMEOUT: port ${port} not ready after ${timeoutMs}ms (last: ${lastError})`);
    }
    await sleep(intervalMs);
  }
}

/**
 * 用「原生 setter + input 事件」写入受控输入框。
 * antd 的 Input 是受控组件，直接改 .value 不会触发 React onChange。
 */
export async function typeInto(cdp, selector, text) {
  return cdp.evaluateJson(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return JSON.stringify({ ok: false, reason: 'not-found' });
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return JSON.stringify({ ok: false, reason: 'no-setter' });
    const previous = input.value;
    setter.call(input, ${JSON.stringify(text)});
    // rc-input 用 _valueTracker 去重：需要回退旧值再派发，否则 onChange 不触发
    input._valueTracker?.setValue(previous);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: input.value });
  })()`);
}

/** 点击第一个匹配 selector 的元素。 */
export async function click(cdp, selector) {
  return cdp.evaluateJson(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return JSON.stringify({ ok: false, reason: 'not-found' });
    node.click();
    return JSON.stringify({ ok: true });
  })()`);
}
