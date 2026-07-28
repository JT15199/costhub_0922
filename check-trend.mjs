import Database from '@tauri-apps/plugin-sql';

async function checkTrendData() {
  try {
    const db = await Database.load('sqlite:costhub.db');

    console.log('='.repeat(80));
    console.log('检查趋势数据');
    console.log('='.repeat(80));

    // 查询包含"外箱"的器件
    const parts = await db.select(
      `SELECT id, name, model, sub_category, trend_enabled, trend_query_category, trend_category_type
       FROM parts
       WHERE name LIKE '%外箱%' OR name LIKE '%27寸%'`
    );

    console.log('\n找到的器件:');
    parts.forEach(p => {
      console.log(`ID: ${p.id}`);
      console.log(`名称: ${p.name}`);
      console.log(`趋势开启: ${p.trend_enabled}`);
      console.log(`trend_query_category: "${p.trend_query_category}"`);
      console.log(`trend_category_type: "${p.trend_category_type}"`);
      console.log('-'.repeat(40));
    });

    // 查询 trend_items 表
    const items = await db.select(
      `SELECT id, query_category, category_type
       FROM trend_items
       ORDER BY id DESC
       LIMIT 10`
    );

    console.log('\ntrend_items 表:');
    items.forEach(item => {
      console.log(`[${item.id}] query_category: "${item.query_category}" (${item.category_type})`);
    });

    console.log('='.repeat(80));

  } catch (e) {
    console.error('错误:', e);
  }
}

checkTrendData();
