// 测试脚本：验证趋势数据保存和读取
// 运行方式：node test-trend-data.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 假设数据库在 src-tauri/target/release 目录
const dbPath = path.join(__dirname, 'src-tauri', 'target', 'release', 'costhub.db');

console.log('数据库路径:', dbPath);
console.log('='.repeat(80));

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ 数据库连接失败:', err.message);
    process.exit(1);
  }
  console.log('✅ 数据库连接成功\n');
  runChecks();
});

function runChecks() {
  console.log('【步骤1】检查所有开启趋势关注的器件');
  console.log('-'.repeat(80));

  db.all(
    `SELECT id, name, model, sub_category, trend_enabled, trend_query_category, trend_category_type
     FROM parts
     WHERE trend_enabled = 1`,
    [],
    (err, rows) => {
      if (err) {
        console.error('❌ 查询失败:', err.message);
        return;
      }

      console.log(`找到 ${rows.length} 个开启了趋势关注的器件：\n`);

      rows.forEach((row, idx) => {
        const highlight = row.name.includes('外箱') || row.name.includes('27寸') ? '👉 ' : '   ';
        console.log(`${highlight}[${idx + 1}] ID: ${row.id}`);
        console.log(`    器件名称: ${row.name}`);
        console.log(`    型号: ${row.model || '(无)'}`);
        console.log(`    子类: ${row.sub_category || '(无)'}`);
        console.log(`    ⭐ trend_query_category: "${row.trend_query_category || '(空值)'}"`);
        console.log(`    ⭐ trend_category_type: "${row.trend_category_type || '(空值)'}"`);
        console.log('');
      });

      // 步骤2
      checkTrendItems();
    }
  );
}

function checkTrendItems() {
  console.log('\n【步骤2】检查 trend_items 表');
  console.log('-'.repeat(80));

  db.all(
    `SELECT id, query_category, category_type, trend_direction, last_updated_at
     FROM trend_items
     ORDER BY id DESC
     LIMIT 20`,
    [],
    (err, rows) => {
      if (err) {
        console.error('❌ 查询失败:', err.message);
        return;
      }

      console.log(`找到 ${rows.length} 条趋势条目（最近20条）：\n`);

      rows.forEach((row, idx) => {
        const highlight = row.query_category === '瓦楞纸' ? '🎯 ' : '   ';
        console.log(`${highlight}[${idx + 1}] ID: ${row.id}`);
        console.log(`    ⭐ query_category: "${row.query_category}"`);
        console.log(`    category_type: ${row.category_type}`);
        console.log(`    trend_direction: ${row.trend_direction || '(未查询)'}`);
        console.log(`    last_updated_at: ${row.last_updated_at || '(未查询)'}`);
        console.log('');
      });

      // 步骤3
      checkSpecificPart();
    }
  );
}

function checkSpecificPart() {
  console.log('\n【步骤3】专项检查："外箱27寸五层"');
  console.log('-'.repeat(80));

  db.all(
    `SELECT * FROM parts WHERE name LIKE '%外箱%' OR name LIKE '%27寸%'`,
    [],
    (err, rows) => {
      if (err) {
        console.error('❌ 查询失败:', err.message);
        db.close();
        return;
      }

      if (rows.length === 0) {
        console.log('❌ 未找到包含"外箱"或"27寸"的器件\n');
      } else {
        console.log(`✅ 找到 ${rows.length} 个相关器件：\n`);

        rows.forEach((row, idx) => {
          console.log(`[${idx + 1}] ID: ${row.id}`);
          console.log(`    器件名称: ${row.name}`);
          console.log(`    型号: ${row.model || '(无)'}`);
          console.log(`    子类: ${row.sub_category || '(无)'}`);
          console.log(`    趋势开启: ${row.trend_enabled === 1 ? '✅ 是' : '❌ 否'}`);
          console.log(`    🔍 trend_query_category: "${row.trend_query_category || '(空值)'}"`);
          console.log(`    🔍 trend_category_type: "${row.trend_category_type || '(空值)'}"`);
          console.log('');
        });
      }

      // 步骤4
      checkMapping();
    }
  );
}

function checkMapping() {
  console.log('\n【步骤4】检查器件与趋势条目的映射关系');
  console.log('-'.repeat(80));

  db.all(
    `SELECT
       m.id as mapping_id,
       m.component_id,
       m.trend_item_id,
       m.component_type,
       p.name as part_name,
       t.query_category,
       t.category_type
     FROM component_trend_mapping m
     LEFT JOIN parts p ON m.component_id = p.id AND m.component_type = 'part'
     LEFT JOIN trend_items t ON m.trend_item_id = t.id
     ORDER BY m.id DESC
     LIMIT 20`,
    [],
    (err, rows) => {
      if (err) {
        console.error('❌ 查询失败:', err.message);
        db.close();
        return;
      }

      console.log(`找到 ${rows.length} 条映射关系（最近20条）：\n`);

      rows.forEach((row, idx) => {
        const highlight = row.part_name?.includes('外箱') ? '👉 ' : '   ';
        console.log(`${highlight}[${idx + 1}] 映射ID: ${row.mapping_id}`);
        console.log(`    器件ID: ${row.component_id} -> ${row.part_name || '(未找到)'}`);
        console.log(`    趋势条目ID: ${row.trend_item_id}`);
        console.log(`    🔗 趋势条目的 query_category: "${row.query_category}"`);
        console.log(`    🔗 趋势条目的 category_type: ${row.category_type}`);
        console.log('');
      });

      // 关闭数据库
      db.close((err) => {
        if (err) {
          console.error('❌ 关闭数据库失败:', err.message);
        } else {
          console.log('\n✅ 检查完成，数据库已关闭');
          console.log('='.repeat(80));
          printSummary();
        }
      });
    }
  );
}

function printSummary() {
  console.log('\n【诊断总结】');
  console.log('-'.repeat(80));
  console.log('1. 如果"外箱27寸五层"的 trend_query_category 是空值或不是"瓦楞纸"');
  console.log('   → 说明前端保存时数据丢失，需要检查 PartsLibrary.tsx 保存逻辑');
  console.log('');
  console.log('2. 如果 trend_query_category 正确保存为"瓦楞纸"，但 trend_items 表没有对应条目');
  console.log('   → 说明同步机制失败，需要检查 TrendInsight.tsx 的自动同步逻辑');
  console.log('');
  console.log('3. 如果 trend_items 表有"瓦楞纸"条目，但界面显示"外箱27寸五层"');
  console.log('   → 说明前端展示逻辑读错了字段，需要检查卡片渲染代码');
  console.log('');
  console.log('4. 如果映射关系表找不到对应记录');
  console.log('   → 说明器件与趋势条目未正确关联');
  console.log('='.repeat(80));
}
