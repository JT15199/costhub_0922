// Quality Harness V2 — 登录动作
//
// 从 V1 的 actions.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
//
// 走查记录（2026-09-22，避免以后重复踩坑）：
//   * antd 的 `loading` 按钮**不会**带 `disabled` 属性，它只渲染加载态并吞掉点击。
//     第一版就绪判断只看 `!button.disabled`，于是在「正在准备本地数据库…」阶段就点击，
//     点击被吞 → 登录页一直不消失 → 后续等待超时。
//     因此必须同时确认按钮文案已经变成「登录」而不是初始化提示。
//   * antd 会把两字中文按钮渲染成「登 录」（中间插空格），所以用 /登\s*录/ 匹配。

import { sleep, typeInto } from '../cdpClient.mjs';

/** fixture 测试账号的用户名（密码不在此处 —— 见 helpers/fixtureCredentials.mjs）。 */
export const TEST_USERNAME = 'agent-test';

/** 等待登录表单初始化完成。 */
export async function waitForLoginReady(cdp, timeoutMs = 90000) {
  return cdp.waitFor(
    'login form ready',
    async () => await cdp.evaluate(`(() => {
      const byTestId = document.querySelector('[data-testid="login-submit"]');
      const byText = [...document.querySelectorAll('button')].find(b => /登\\s*录|正在准备/.test(b.innerText || ''));
      const button = byTestId || byText;
      if (!button) return false;
      const label = (button.innerText || '').replace(/\\s+/g, '');
      // 初始化中（"正在准备本地数据库…"）不算就绪，此时点击会被 loading 态吞掉
      if (!label || label.includes('正在准备')) return false;
      if (button.classList.contains('ant-btn-loading')) return false;
      return label;
    })()`),
    { timeoutMs, intervalMs: 500 },
  );
}

/**
 * 把真实的可编辑元素打上测试标记，并返回其标记属性选择器。
 *
 * 走查结论：本仓库 antd 目前把透传属性直接放到内部 `<input>` 上。但那是框架实现细节，
 * 不同版本/不同 props 组合可能变化。因此这里运行时定位真正的可编辑元素再自行标记，
 * 测试不依赖属性落点。
 */
async function tagEditable(cdp, { tag, kind }) {
  return cdp.evaluate(`(() => {
    const candidates = [...document.querySelectorAll('input, textarea')]
      .filter(el => !el.disabled && !el.readOnly);
    const el = candidates.find(node => {
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (${JSON.stringify(kind)} === 'username') return node.type !== 'password';
      if (${JSON.stringify(kind)} === 'password') return node.type === 'password';
      return true;
    });
    if (!el) return null;
    el.setAttribute('data-quality-target', ${JSON.stringify(tag)});
    return '[data-quality-target="' + ${JSON.stringify(tag)} + '"]';
  })()`);
}

/**
 * 用 fixture 凭据登录。
 * @param {object} cdp
 * @param {{username: string, password: string}} identity
 */
export async function login(cdp, identity) {
  await waitForLoginReady(cdp);

  const userSelector = await tagEditable(cdp, { tag: 'login-user', kind: 'username' });
  const passSelector = await tagEditable(cdp, { tag: 'login-pass', kind: 'password' });
  if (!userSelector || !passSelector) {
    return { ok: false, reason: `login inputs not found (user=${userSelector}, pass=${passSelector})` };
  }

  const user = await typeInto(cdp, userSelector, identity.username);
  const pass = await typeInto(cdp, passSelector, identity.password);
  if (!user?.ok || !pass?.ok) {
    // 注意：不回显凭据内容
    return { ok: false, reason: `could not fill credentials (userOk=${Boolean(user?.ok)}, passOk=${Boolean(pass?.ok)})` };
  }

  const clicked = await cdp.evaluate(`(() => {
    const byTestId = document.querySelector('[data-testid="login-submit"]');
    const byText = [...document.querySelectorAll('button')].find(b => /登\\s*录/.test(b.innerText || ''));
    const button = byTestId || byText;
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, reason: 'login button not found' };

  // 登录成功后 LoginScreen 会卸载，主壳出现 nav-item
  await cdp.waitFor(
    'main shell after login',
    async () => await cdp.evaluate(`document.querySelectorAll('.nav-item').length > 0`),
    { timeoutMs: 60000, intervalMs: 500 },
  );

  const shell = await cdp.evaluateJson(`JSON.stringify({
    navItems: document.querySelectorAll('.nav-item').length,
    hasSidebar: Boolean(document.querySelector('.sidebar-nav')),
    hasMain: Boolean(document.querySelector('.main-content')),
    loginScreenGone: !document.querySelector('.login-screen'),
  })`);

  return { ok: true, shell };
}

export { sleep };
