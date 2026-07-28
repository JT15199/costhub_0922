# 直接查询数据库 - 检查"外箱27寸五层"的趋势配置
$dbPath = "C:\Users\96529\Desktop\AI coding folder\monitor-cost-main\src-tauri\target\release\costhub.db"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "数据库路径: $dbPath" -ForegroundColor Yellow
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# 使用 sqlite3.exe 查询（如果系统中有）
$sqlite3 = "sqlite3"

try {
    # 检查包含"外箱"或"27寸"的器件
    Write-Host "【步骤1】查找包含'外箱'或'27寸'的器件" -ForegroundColor Green
    Write-Host "------------------------------------------------------------------" -ForegroundColor Gray

    $query1 = @"
SELECT
    id,
    name,
    model,
    sub_category,
    trend_enabled,
    trend_query_category,
    trend_category_type
FROM parts
WHERE name LIKE '%外箱%' OR name LIKE '%27寸%';
"@

    $result1 = & $sqlite3 $dbPath $query1

    if ($result1) {
        Write-Host $result1
    } else {
        Write-Host "❌ 未找到包含'外箱'或'27寸'的器件" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "【步骤2】查找所有开启趋势关注的器件" -ForegroundColor Green
    Write-Host "------------------------------------------------------------------" -ForegroundColor Gray

    $query2 = @"
SELECT
    id,
    name,
    trend_enabled,
    trend_query_category,
    trend_category_type
FROM parts
WHERE trend_enabled = 1
LIMIT 10;
"@

    $result2 = & $sqlite3 $dbPath $query2

    if ($result2) {
        Write-Host $result2
    } else {
        Write-Host "❌ 没有开启趋势关注的器件" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "【步骤3】查找 trend_items 表中的条目" -ForegroundColor Green
    Write-Host "------------------------------------------------------------------" -ForegroundColor Gray

    $query3 = @"
SELECT
    id,
    query_category,
    category_type,
    trend_direction,
    last_updated_at
FROM trend_items
ORDER BY id DESC
LIMIT 10;
"@

    $result3 = & $sqlite3 $dbPath $query3

    if ($result3) {
        Write-Host $result3
    } else {
        Write-Host "❌ trend_items 表为空" -ForegroundColor Red
    }

} catch {
    Write-Host ""
    Write-Host "❌ 错误: 未找到 sqlite3 命令" -ForegroundColor Red
    Write-Host "请尝试以下方法之一：" -ForegroundColor Yellow
    Write-Host "1. 安装 SQLite: https://www.sqlite.org/download.html" -ForegroundColor Yellow
    Write-Host "2. 使用 debug-trend.html（在浏览器中打开）" -ForegroundColor Yellow
    Write-Host "3. 使用数据库管理工具（如 DB Browser for SQLite）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
