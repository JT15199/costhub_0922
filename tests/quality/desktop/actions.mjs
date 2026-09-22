// Quality Harness V1 — 桌面 E2E 共享动作（测试侧）
//
// 只放「与 CostHub 交互」的通用动作，不放断言。断言留在各 scenario 里，
// 这样报告能明确指出是哪一条用户旅程断了。
//
// 选择器策略（优先级从高到低）：
//   1. data-testid —— 本轮新增的稳定测试标记
//   2. 可访问性属性 —— aria-label / placeholder（面向用户可见文案，改动成本高）
//   3. 结构类名 —— .nav-item / .ant-table 等
// 每个动作都返回结构化结果，找不到元素时给出 reason，便于报告定位。

import fs from 'node:fs';
import path from 'node:path';

import { click, sleep, typeInto } from './cdpClient.mjs';

export const TEST_IDENTITY = { username: 'agent-test', password: 'agent-test-666' };

/** 一级导航的 testid → 中文标签（用于断言与报告可读性）。 */
export const NAV_ENTRIES = [
  { key: 'dashboard', label: '今日工作台' },
  { key: 'projects', label: '项目' },
  { key: 'intelligence', label: '情报' },
  { key: 'library', label: '资料库' },
  { key: 'workLog', label: '工作手账' },
];

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/**
 * 等待登录表单初始化完成。
 *
 * 关键点（2026-09-22 走查实测）：antd 的 `loading` 按钮**不会**带 `disabled` 属性，
 * 它只是渲染成加载态并吞掉点击。第一版只检查 `!button.disabled`，于是「正在准备本地数据库…」
 * 阶段就被判为可点，点击被吞 → 登录页一直不消失 → 后续等待超时。
 * 因此必须同时确认按钮文案已经是「登录」（而不是初始化提示）。
 */
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
 * 走查结论：本仓库 antd 目前把透传属性直接放到内部 `<input>` 上
 * （`[data-testid="login-username"]` 的 tagName 就是 INPUT）。
 * 但那是框架实现细节，不同 antd 版本/不同 props 组合可能变化。
 * 因此这里运行时定位真正的可编辑元素再自行标记，测试不依赖属性落点。
 */
async function tagEditable(cdp, { tag, kind }) {
  const selector = await cdp.evaluate(`(() => {
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
  return selector;
}

/** 用夹具测试账号登录。 */
export async function login(cdp, identity = TEST_IDENTITY) {
  await waitForLoginReady(cdp);

  const userSelector = await tagEditable(cdp, { tag: 'login-user', kind: 'username' });
  const passSelector = await tagEditable(cdp, { tag: 'login-pass', kind: 'password' });
  if (!userSelector || !passSelector) {
    return { ok: false, reason: `login inputs not found (user=${userSelector}, pass=${passSelector})` };
  }

  const user = await typeInto(cdp, userSelector, identity.username);
  const pass = await typeInto(cdp, passSelector, identity.password);
  if (!user?.ok || !pass?.ok) {
    return { ok: false, reason: `could not fill credentials (user=${JSON.stringify(user)}, pass=${JSON.stringify(pass)})` };
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

// ---------------------------------------------------------------------------
// AI 协作窗
// ---------------------------------------------------------------------------

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

/** 采集 AI 协作窗的状态（不触发任何模型推理）。 */
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
  // antd Input.TextArea 的 data-testid 会落到包裹节点上，真实可编辑元素是内部 textarea
  const selector = '[data-testid="local-ai-input"], .local-ai-composer-input';
  const target = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid="local-ai-input"]');
    const el = (node && node.tagName === 'TEXTAREA') ? node : (node?.querySelector('textarea') || document.querySelector('.local-ai-composer-input') || document.querySelector('.local-ai-composer textarea'));
    if (!el) return false;
    el.setAttribute('data-quality-composer', '1');
    return el.tagName;
  })()`);
  if (!target) return { ok: false, reason: `composer textarea not found (selector ${selector})` };

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

// ---------------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 夹具数据
// ---------------------------------------------------------------------------

/** 读取夹具 manifest（由 prepare-fixture.mjs 写出）。 */
export function readFixtureManifest(fixtureDir) {
  const manifestPath = path.join(fixtureDir, 'desktop-fixture.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`fixture manifest missing: ${path.basename(manifestPath)} (run "node tests/quality/desktop/prepare-fixture.mjs")`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/** 在项目页选中夹具项目，并打开 BOM 页签。 */
export async function openFixtureProjectBom(cdp, projectCode) {
  await navigateTo(cdp, { key: 'projects', label: '项目' });

  // 侧边项目条目的真实结构是 button.app-project-item（含 code + name + 状态）
  const selected = await cdp.waitFor(
    'fixture project in sidebar list',
    async () => await cdp.evaluate(`(() => {
      const code = ${JSON.stringify(projectCode)};
      const item = [...document.querySelectorAll('button.app-project-item')]
        .find(node => (node.title || node.innerText || '').includes(code));
      if (!item) return false;
      item.click();
      return true;
    })()`),
    { timeoutMs: 30000, intervalMs: 500 },
  ).catch(error => `TIMEOUT: ${error.message}`);

  if (typeof selected === 'string') return { ok: false, reason: `fixture project not listed: ${selected}` };

  // 必须确认选中的确实是夹具项目（避免点到别处后误判）
  const activated = await cdp.waitFor(
    'fixture project activated',
    async () => await cdp.evaluate(`(() => {
      const active = document.querySelector('button.app-project-item.is-active');
      return Boolean(active && (active.title || active.innerText || '').includes(${JSON.stringify(projectCode)}));
    })()`),
    { timeoutMs: 20000, intervalMs: 400 },
  ).catch(error => `TIMEOUT: ${error.message}`);

  if (typeof activated === 'string') return { ok: false, reason: `fixture project never became active: ${activated}` };

  // 进入项目后默认页签不是 BOM。这里必须处理两个实测到的坑（2026-09-22 走查）：
  //   1. DOM 里存在**多个**「BOM清单」tab 节点（隐藏的历史/预渲染节点 + 当前可见节点）；
  //      点错那个不会切换视图。
  //   2. 项目 BOM 数据是异步加载的，加载完成前页签显示「BOM清单 (0件)」，
  //      此时点击即便命中也会在切换后拿到空数据。
  // 因此：优先点可见节点，并在「页签显示非 0 件」后才点，最后轮询抖动重试。
  const bomReady = await cdp.waitFor(
    'BOM tab showing a non-zero item count',
    async () => await cdp.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.ant-tabs-tab')]
        .filter(node => /^BOM\\s*清单/.test((node.innerText || '').trim()));
      const loaded = tabs.find(node => /\\(\\s*[1-9]\\d*\\s*件\\s*\\)/.test(node.innerText || ''));
      return Boolean(loaded);
    })()`),
    { timeoutMs: 30000, intervalMs: 500 },
  ).then(() => true).catch(() => false);

  if (!bomReady) return { ok: false, reason: 'BOM tab never reported a non-zero item count (fixture BOM not loaded?)' };

  /** 点击 BOM 清单页签：优先可见节点；都不可见时退回最后一个（实测可见节点在 DOM 尾部）。 */
  const clickBomTab = `(() => {
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')]
      .filter(node => /^BOM\\s*清单/.test((node.innerText || '').trim()));
    if (!tabs.length) return 'no-tab';
    const visible = tabs.find(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const target = visible || tabs[tabs.length - 1];
    (target.querySelector('.ant-tabs-tab-btn') || target).click();
    return visible ? 'clicked-visible' : 'clicked-fallback';
  })()`;

  // 点击 + 渲染确认，允许抖动重试（tab 切换在数据/布局未稳定时偶尔不生效）
  let bomPayload = null;
  let lastClick = null;
  for (let attempt = 0; attempt < 4 && !bomPayload; attempt += 1) {
    lastClick = await cdp.evaluate(clickBomTab);
    if (lastClick === 'no-tab') return { ok: false, reason: 'no BOM tab node present in project workspace' };

    bomPayload = await cdp.waitFor(
      'BOM table with fixture rows',
      async () => await cdp.evaluate(`(() => {
        const main = document.querySelector('.main-content');
        if (!main) return false;
        const rows = main.querySelectorAll('.ant-table-tbody tr').length;
        const text = main.innerText || '';
        const models = ${JSON.stringify(BOM_MODELS_FOR_WAIT)};
        const visible = models.filter(m => text.includes(m)).length;
        if (rows < 2 || visible === 0) return false;

        const bomTab = [...main.querySelectorAll('.ant-tabs-tab')]
          .map(node => (node.innerText || '').trim())
          .find(label => /^BOM\\s*清单/.test(label));

        return JSON.stringify({
          tables: main.querySelectorAll('.ant-table').length,
          rows,
          bomTabLabel: bomTab || null,
          fixturePartsVisible: visible,
        });
      })()`),
      { timeoutMs: 12000, intervalMs: 400 },
    ).catch(() => null);
  }

  if (!bomPayload) return { ok: false, reason: `BOM table content never rendered fixture parts after 4 attempts (last click: ${lastClick})` };
  return { ok: true, ...JSON.parse(bomPayload), click: lastClick };
}

/**
 * 等待 BOM 渲染时用于判断「确实是夹具数据」的型号集合。
 * 与 fixtureData.mjs 的 FIXTURE_BOM_ROWS 对应；刻意不用全部 6 个，
 * 因为 BOM 表格默认可能分页/折叠，只要出现已知型号即可证明渲染的是夹具数据。
 */
const BOM_MODELS_FOR_WAIT = ['QA-PANEL-270', 'QA-SCALER-01', 'QA-PSU-01'];

/** 统计 BOM 表格中夹具器件名的出现次数。 */
export async function countFixtureBomRows(cdp, partModels) {
  return cdp.evaluateJson(`JSON.stringify((() => {
    const models = ${JSON.stringify(partModels)};
    // 在 main-content 之外也查找：项目工作区用了嵌套 Tabs，BOM 面板可能挂在
    // main-content 之外的 tab 容器里（走查 2026-09-22 实测如此）。页面 DOM 本身
    // 已经不含正式数据（夹具库），所以按整个 document 统计仍然准确。
    const scopes = [
      { name: 'main-content', root: document.querySelector('.main-content') },
      { name: 'document', root: document.body },
    ];
    for (const scope of scopes) {
      if (!scope.root) continue;
      const text = scope.root.innerText || '';
      const found = models.filter(m => text.includes(m));
      if (found.length > 0) {
        return {
          scope: scope.name,
          expected: models.length,
          foundInDom: found.length,
          missing: models.filter(m => !text.includes(m)),
          tableRows: scope.root.querySelectorAll('.ant-table-tbody tr').length,
        };
      }
    }
    return { scope: null, expected: models.length, foundInDom: 0, missing: models, tableRows: 0 };
  })())`);
}

// ---------------------------------------------------------------------------
// 设置页（凭据泄漏检查）
// ---------------------------------------------------------------------------

/**
 * 打开系统设置并检查 DOM 是否泄漏真实 API Key。
 * 报告与返回值中一律不出现完整 input value，只出现「形状」判断。
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

// ---------------------------------------------------------------------------
// 重启持久化（E2E-007）
// ---------------------------------------------------------------------------

/** 读取一个 localStorage 值（测试侧状态，不碰业务成本字段）。 */
export async function readLocalStorage(cdp, key) {
  return cdp.evaluate(`window.localStorage.getItem(${JSON.stringify(key)})`);
}

/** 写入一个 localStorage 值。 */
export async function writeLocalStorage(cdp, key, value) {
  return cdp.evaluate(`(() => { window.localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return window.localStorage.getItem(${JSON.stringify(key)}); })()`);
}

export { sleep, click, typeInto };
