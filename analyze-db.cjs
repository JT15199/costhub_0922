const fs = require('fs');

// 读取数据库文件
const dbPath = './database_backup.db';
const buffer = fs.readFileSync(dbPath);

// SQLite文件格式解析（简化版）
// SQLite master表在固定位置
const sqliteMagic = buffer.toString('ascii', 0, 16);
console.log('SQLite Header:', sqliteMagic);

// 尝试找到CREATE TABLE语句
const dbString = buffer.toString('latin1');
const createTableRegex = /CREATE TABLE ([^(]+)\(([^)]+)\)/gi;
let match;
const tables = [];

while ((match = createTableRegex.exec(dbString)) !== null) {
  tables.push({
    name: match[1].trim(),
    definition: match[0]
  });
}

console.log('\n找到的表结构：\n');
tables.forEach(table => {
  console.log(`\n========== ${table.name} ==========`);
  console.log(table.definition);
});

console.log(`\n\n总共找到 ${tables.length} 个表`);
