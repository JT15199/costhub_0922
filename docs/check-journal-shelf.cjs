// Run against npm run dev. Browser-only fixtures never reach the local database.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const hash = require('node:crypto').createHash('sha256').update('666666').digest('hex');
const longName = '27英寸 QHD 高刷新率办公显示器项目';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ hash, longName }) => {
      localStorage.setItem('app-active', 'workLog');
      localStorage.setItem('costhub-ai-guide-seen', '1');
      const projects = [longName, '轻羽手写笔', '桌面工作站', '便携屏', '旗舰电竞', '无线鼠标', '创作屏', '新立项空白书册'].map((name, i) => ({ id: i + 1, code: `P${100 + i}`, name, category: i === 1 ? '手写笔' : '显示器' }));
      const initial = projects.slice(0, -1).flatMap(p => [0, 1].map(i => ({ id: p.id * 10 + i, project_id: p.id, work_project: p.name, title: i ? '确认下一轮报价' : '供应商方案评审', content: i ? '第二条原始内容' : '第一条原始内容', record_type: 'work_progress', log_date: `2026-09-0${i + 1} 10:00`, evidence_json: '[]' })));
      const logs = JSON.parse(localStorage.getItem('journal-test-notes') || 'null') || initial;
      window.__testNotes = logs;
      const persist = () => localStorage.setItem('journal-test-notes', JSON.stringify(logs));
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === 'get_db_path') return 'sqlite:mock';
        if (command === 'sql_load') return 'mock';
        const q = String(args?.request?.query || '');
        const values = args?.request?.values || [];
        if (command === 'sql_execute') {
          if (q.startsWith('INSERT OR REPLACE INTO settings')) localStorage.setItem(`journal-test-setting:${values[0]}`, values[1]);
          if (q.startsWith('INSERT INTO work_logs')) {
            if (window.__noteLocks > 0) { window.__noteLocks--; throw '数据库写入失败: (code: 5) database is locked'; }
            const columns = q.match(/\(([^)]+)\)/)[1].split(',');
            const id = Math.max(...logs.map(row => row.id), 0) + 1;
            logs.push({ id, ...Object.fromEntries(columns.map((c, i) => [c, values[i]])) });
            window.__noteWrites = (window.__noteWrites || 0) + 1; persist();
            return { rowsAffected: 1, lastInsertId: id };
          }
          if (q.startsWith('UPDATE work_logs SET ') && q.includes('WHERE id=?')) {
            const row = logs.find(row => row.id === values.at(-1));
            const columns = q.slice('UPDATE work_logs SET '.length).split(' WHERE ')[0].split(', ').filter(x => x.endsWith('=?')).map(x => x.slice(0, -2));
            Object.assign(row, Object.fromEntries(columns.map((c, i) => [c, values[i]]))); persist();
          }
          return { rowsAffected: 1, lastInsertId: 99 };
        }
        if (command !== 'sql_select') return [];
        const key = values[0];
        if (q.includes('FROM settings')) return [{ value: key === 'auth_password_hash' ? hash : key === 'auth_username' ? 'admin' : key === 'auth_password_changed' ? '1' : localStorage.getItem(`journal-test-setting:${key}`) || '' }];
        if (q.includes('FROM work_logs')) return logs;
        if (q.includes('FROM projects')) {
          if (q.includes('WHERE name=? OR code=?')) return projects.filter(p => p.name === key || p.code === key);
          if (q.includes('WHERE id=?')) return projects.filter(p => p.id === key);
          return projects;
        }
        return [];
      } };
    }, { hash, longName });
    const login = async () => { await page.locator('input[autocomplete="current-password"]').fill('666666'); await page.locator('.login-btn').click(); await page.locator('.cloth-book').filter({ hasText: longName }).waitFor(); };
    await page.goto('http://127.0.0.1:5188/'); await login();
    const book = page.locator('.cloth-book').filter({ hasText: longName });
    assert.equal(await page.locator('.cloth-book').count(), 7);
    assert.equal(await page.locator('.cloth-shelf').count(), 1, 'All categories share one shelf');
    for (const zoom of [1, 1.25, 1.5]) {
      await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
      await page.waitForTimeout(100);
      const fit = await book.locator('.cloth-title').evaluate(box => {
        const range = document.createRange(); range.selectNodeContents(box.querySelector('strong'));
        const text = range.getBoundingClientRect(), bounds = box.getBoundingClientRect();
        return { fits: text.width <= bounds.width + 2 && text.height <= bounds.height + 2, text: text.toJSON(), bounds: bounds.toJSON() };
      });
      assert(fit.fits, `Long title fits at ${zoom}: ${JSON.stringify(fit)}`);
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
    const before = await book.locator('.cloth-volume').boundingBox();
    await book.hover(); await page.waitForTimeout(300);
    const after = await book.locator('.cloth-volume').boundingBox();
    assert(after.height > before.height && after.y < before.y);
    await page.screenshot({ path: process.env.TEMP + '/journal-shelf.png' });
    await book.click();
    await page.locator('.bound-cover').waitFor();
    await page.locator('.bound-cover').waitFor({ state: 'detached' });
    const reader = page.locator('.journal-reader-modal');
    const heading = reader.locator('.journal-right-leaf h1');
    assert.equal(await heading.textContent(), '确认下一轮报价');
    const close = await reader.locator('.ant-modal-close').boundingBox();
    const actions = await reader.locator('.journal-reader-actions').boundingBox();
    assert(actions.x + actions.width <= close.x || actions.y >= close.y + close.height, 'Toolbar and close button do not overlap');
    await reader.getByRole('button', { name: '上一页', exact: true }).click();
    await page.locator('.bound-paper').waitFor();
    await page.waitForTimeout(650);
    assert.equal(await heading.textContent(), '确认下一轮报价', 'Current content must not change before animation finishes');
    assert.equal(await page.locator('.bound-cover').count(), 0);
    assert.equal(await page.locator('.bound-paper .curl-strip').count(), 10);
    assert(await reader.getByRole('button', { name: '继续记录', exact: true }).isDisabled());
    await page.screenshot({ path: process.env.TEMP + '/journal-curl.png' });
    await page.locator('.bound-paper').waitFor({ state: 'detached' });
    assert.equal(await heading.textContent(), '供应商方案评审');
    await reader.getByRole('button', { name: '下一页', exact: true }).click();
    await page.locator('.bound-paper').waitFor();
    assert.equal(await heading.textContent(), '供应商方案评审');
    await page.locator('.bound-paper').waitFor({ state: 'detached' });
    assert.equal(await heading.textContent(), '确认下一轮报价');
    // Append and edit are distinct operations and preserve the rest of the book.
    const original = await page.evaluate(() => window.__testNotes.filter(row => row.project_id === 1));
    await reader.getByRole('button', { name: '继续记录', exact: true }).click();
    assert.equal(await reader.getByLabel('当前书册项目').inputValue(), longName);
    const content = reader.getByPlaceholder('今天做了什么？判断是什么？结果或影响如何？');
    assert.equal(await content.inputValue(), '');
    await content.fill('今天新增的第三条记录');
    await reader.getByPlaceholder('标题（可选）', { exact: true }).fill('继续记录测试');
    await page.evaluate(() => { window.__noteLocks = 2; });
    await reader.getByRole('button', { name: '保存为新记录' }).click();
    await reader.locator('.journal-right-leaf h1').filter({ hasText: '继续记录测试' }).waitFor();
    let rows = await page.evaluate(() => window.__testNotes.filter(row => row.project_id === 1));
    assert.equal(rows.length, 3); assert.deepEqual(rows.slice(0, 2), original);
    assert.equal(await page.locator('.bound-cover').count(), 0, 'Saving does not reopen a cover');
    await reader.getByRole('button', { name: '修改本条' }).click();
    await content.fill('仅修改第三条');
    await page.screenshot({ path: process.env.TEMP + '/journal-editor.png' });
    await reader.getByRole('button', { name: '保存本条修改' }).click();
    await reader.locator('.journal-entry-body').filter({ hasText: '仅修改第三条' }).waitFor();
    rows = await page.evaluate(() => window.__testNotes.filter(row => row.project_id === 1));
    assert.equal(rows.length, 3); assert.deepEqual(rows.slice(0, 2), original);
    await reader.getByRole('button', { name: '继续记录', exact: true }).click();
    await content.fill('不能丢失的草稿');
    await page.evaluate(() => { window.__noteLocks = 10; });
    await reader.getByRole('button', { name: '保存为新记录' }).click();
    await page.getByText('数据库仍被占用，本条内容已保留，请稍后再保存。', { exact: true }).waitFor();
    assert.equal(await content.inputValue(), '不能丢失的草稿');
    await page.evaluate(() => { window.__noteLocks = 0; });
    await reader.getByRole('button', { name: '保存为新记录' }).click();
    await reader.locator('.journal-entry-body').filter({ hasText: '不能丢失的草稿' }).waitFor();
    await page.keyboard.press('Escape'); await reader.waitFor({ state: 'hidden' });
    // Empty projects require explicit creation.
    assert.equal(await page.locator('.cloth-book').filter({ hasText: '新立项空白书册' }).count(), 0);
    await page.getByRole('button', { name: '新建书册', exact: true }).click();
    await page.getByRole('dialog').locator('.ant-select').click();
    await page.getByText('P107 · 新立项空白书册', { exact: true }).click();
    await page.getByRole('button', { name: '保存书册', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.cloth-book').filter({ hasText: '新立项空白书册' }).click();
    await reader.getByRole('button', { name: '写下第一条记录' }).click();
    await content.fill('空白书册第一条');
    await reader.getByRole('button', { name: '保存为新记录' }).click();
    await reader.locator('.journal-entry-body').filter({ hasText: '空白书册第一条' }).waitFor();
    await page.keyboard.press('Escape'); await reader.waitFor({ state: 'hidden' });
    // Categories persist and can be renamed/reassigned without moving any records.
    await book.focus();
    await page.getByRole('button', { name: '调整书册分类', exact: true }).click();
    const categoryDialog = page.getByRole('dialog');
    await categoryDialog.locator('.ant-select input').fill('办公显示器');
    await categoryDialog.getByRole('button', { name: '保存分类', exact: true }).click();
    await categoryDialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.cloth-book').count(), 1);
    await page.reload(); await login();
    await page.getByRole('navigation', { name: '书册分类' }).getByRole('button', { name: '办公显示器 · 1', exact: true }).click();
    assert.equal(await page.locator('.cloth-book').count(), 1);
    assert.equal(await book.count(), 1);
    await book.click(); await reader.waitFor();
    assert.equal(await reader.locator('.journal-toc button').count(), 4);
    await page.keyboard.press('Escape'); await reader.waitFor({ state: 'hidden' });
    await page.getByRole('navigation', { name: '书册分类' }).getByRole('button', { name: '全部 · 8', exact: true }).click();
    // Rename and remove a book without deleting its records; removal survives reload.
    await book.focus();
    await page.getByRole('button', { name: '编辑书册', exact: true }).click();
    await page.getByLabel('书册名称', { exact: true }).fill('供应商谈价笔记');
    await page.getByRole('button', { name: '保存书册', exact: true }).click();
    const renamed = page.locator('.cloth-book').filter({ hasText: '供应商谈价笔记' });
    await renamed.waitFor();
    const countBeforeDelete = await page.evaluate(() => window.__testNotes.length);
    await page.getByRole('button', { name: '删除书册', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除书册', exact: true }).click();
    await renamed.waitFor({state:'detached'});
    assert.equal(await page.evaluate(() => window.__testNotes.length), countBeforeDelete);
    await page.reload();
    await page.locator('input[autocomplete="current-password"]').fill('666666'); await page.locator('.login-btn').click();
    await page.locator('.cloth-book').first().waitFor();
    assert.equal(await page.locator('.cloth-book').count(), 7);
    assert.equal(await renamed.count(), 0);
    await page.getByRole('button',{name:'新建书册',exact:true}).click();
    await page.getByLabel('书册名称',{exact:true}).fill('独立工作笔记');
    await page.getByRole('button',{name:'保存书册',exact:true}).click();
    await page.locator('.cloth-book').filter({hasText:'独立工作笔记'}).click();
    await reader.getByRole('button',{name:'写下第一条记录'}).click();
    await content.fill('不依赖项目的记录');
    await reader.getByRole('button',{name:'保存为新记录'}).click();
    await reader.locator('.journal-entry-body').filter({hasText:'不依赖项目的记录'}).waitFor();
    await page.keyboard.press('Escape'); await reader.waitFor({state:'hidden'});
    await page.setViewportSize({ width:700, height:900 });
    assert(await page.locator('.cloth-shelf-scroll').evaluateAll(nodes => nodes.some(e => e.scrollWidth > e.clientWidth)));
    assert.deepEqual(errors, []);
    console.log('PASS: adaptive long titles, deferred content switch, curl, toolbar spacing, append vs edit, retry/draft retention, empty books, category persistence and narrow layout');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
