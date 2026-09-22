const { chromium } = require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const crypto = require('node:crypto');

const rows = [
  { id: 1, root_part_id: 1, parent_id: null, component_name: '显示模组', cost_ratio_estimate: 63.3, source_type: 'user_confirmed', node_type: 'structural', insight_status: 'partial', trend_item_id: 11 },
  { id: 2, root_part_id: 1, parent_id: 1, component_name: 'TFT-LCD 面板', cost_ratio_estimate: 65.9, source_type: 'user_confirmed', node_type: 'terminal', insight_status: 'queried', trend_item_id: 11 },
  { id: 3, root_part_id: 1, parent_id: 1, component_name: '驱动 IC', cost_ratio_estimate: 22, source_type: 'user_confirmed', node_type: 'terminal', insight_status: 'queried', trend_item_id: 12 },
  { id: 4, root_part_id: 1, parent_id: 1, component_name: '背光组件', cost_ratio_estimate: 12.2, source_type: 'user_confirmed', node_type: 'terminal', insight_status: 'pending', trend_item_id: null },
];
const items = rows.slice(1, 3).map(row => ({ id: row.trend_item_id, query_category: row.component_name, category_type: '物料拆解', source_type: 'decomposition' }));
const snapshots = [
  { id: 102, trend_item_id: 12, query_time: '2026-09-03 10:00:00', source_type: 'direct_query', direction: '下降', confidence_level: '中', summary: '同规格报价较上次下降，建议复核下一轮整机报价。', suggested_action: '复核供应商报价', skill_used: '价格变化', magnitude_min: -4, magnitude_max: -1, result_json: '{}' },
  { id: 101, trend_item_id: 12, query_time: '2026-08-03 10:00:00', source_type: 'direct_query', direction: '震荡', confidence_level: '低', summary: '历史报价波动有限。', suggested_action: '继续观察', skill_used: '价格变化', magnitude_min: -1, magnitude_max: 1, result_json: '{}' },
];
const sources = [
  { id: 7, trend_item_id: 12, source_title: '供应商报价 · 第 3 轮', source_url: 'https://example.com/quote', excerpt: '同规格、同交期报价记录。' },
  { id: 8, trend_item_id: 12, source_title: '历史询价记录 · 同型号', source_url: 'https://example.com/history', excerpt: '历史报价可追溯记录。' },
];
const hash = crypto.createHash('sha256').update('666666').digest('hex');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.addInitScript(({ hash, rows, items, snapshots, sources }) => {
    localStorage.setItem('app-active', 'intelligence');
    localStorage.setItem('costhub-ai-guide-seen', '1');
    localStorage.setItem('costhub-material-insight-pending', JSON.stringify({ rootId: 1 }));
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'get_db_path') return 'sqlite:mock';
      if (command === 'sql_load') return 'mock';
      if (command === 'sql_close') return true;
      if (command === 'sql_execute') return { rowsAffected: 1, lastInsertId: 99 };
      if (command !== 'sql_select') return [];
      const query = String(args?.request?.query || '');
      const values = args?.request?.values || [];
      if (query.includes('FROM settings')) {
        if (String(values[0]) === 'auth_password_hash') return [{ value: hash }];
        if (String(values[0]) === 'auth_username') return [{ value: 'admin' }];
        if (String(values[0]) === 'auth_password_changed') return [{ value: '1' }];
      }
      if (query.includes('FROM decomposition_tree')) {
        if (query.includes('WHERE id')) return rows.filter(row => Number(row.id) === Number(values[0]));
        if (query.includes('WHERE root_part_id')) return rows.filter(row => Number(row.root_part_id) === Number(values[0]));
        return rows;
      }
      if (query.includes('FROM trend_items')) return items;
      if (query.includes('FROM trend_snapshots')) return query.includes('WHERE trend_item_id') ? snapshots.filter(row => Number(row.trend_item_id) === Number(values[0])) : snapshots;
      if (query.includes('FROM trend_sources')) return sources.filter(row => Number(row.trend_item_id) === Number(values[0]));
      if (query.includes('FROM parts')) return [];
      if (query.includes('FROM trend_conversations')) return [];
      if (query.includes('FROM trend_insight_dimensions')) return [];
      if (query.includes('FROM decomposition_history')) return [];
      return [];
    } };
  }, { hash, rows, items, snapshots, sources });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
  await page.locator('input[autocomplete="current-password"]').fill('666666');
  await page.locator('.login-btn').click();
  await page.locator('.material-insight-studio').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'prototypes/material-glass-20260909/production-overview.png', fullPage: true });
  await page.locator('.react-flow__node').filter({ hasText: '驱动 IC' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'prototypes/material-glass-20260909/production-detail.png', fullPage: true });
  await page.getByText('树清单', { exact: true }).click();
  console.log(JSON.stringify({ studio: await page.locator('.material-insight-studio').count(), flowNodes: await page.locator('.react-flow__node').count(), history: await page.getByText('洞察时间轴').count(), evidence: await page.getByText('供应商报价 · 第 3 轮').count(), treeView: await page.locator('.material-compact-tree').count() }));
  await browser.close();
})();
