// Quality Harness V2 — 项目 / BOM 只读旅程动作
//
// 从 V1 的 actions.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
//
// 走查记录（2026-09-22，三处实测坑，避免以后重复踩）：
//   1. DOM 里存在**多个**「BOM清单」tab 节点（隐藏的历史/预渲染节点 + 当前可见节点），
//      点错那个不会切换视图 → 优先点可见节点，都不可见时退回 DOM 末尾节点。
//   2. 项目 BOM 数据异步加载，加载完成前页签显示「BOM清单 (0件)」，
//      此时点击即便命中也会拿到空数据 → 先等「非 0 件」再点。
//   3. 项目工作区使用**嵌套 Tabs**：document.querySelector('.ant-tabs-tab-active')
//      命中的是文档顺序里第一个（外层工作区 tab），不是目标子页签
//      → 不用 active class 判断，改用「BOM 表格出现夹具型号」作为渲染证据。
//   另外 BOM 面板可能挂在 .main-content 之外，因此计数时会回退到整个 document。

import { navigateTo } from './navigation.mjs';

/**
 * 等待 BOM 渲染时用于判断「确实是夹具数据」的型号集合。
 * 与 fixtureData.mjs 的 FIXTURE_BOM_ROWS 对应；刻意不用全部 6 个，
 * 因为 BOM 表格默认可能分页/折叠，只要出现已知型号即可证明渲染的是夹具数据。
 */
const BOM_MODELS_FOR_WAIT = ['QA-PANEL-270', 'QA-SCALER-01', 'QA-PSU-01'];

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
