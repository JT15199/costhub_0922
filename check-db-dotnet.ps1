# 使用 .NET System.Data.SQLite 查询数据库
$dbPath = "C:\Users\96529\Desktop\AI coding folder\monitor-cost-main\src-tauri\target\release\costhub.db"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "🔍 CostHub 趋势数据诊断工具" -ForegroundColor White
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "数据库路径: $dbPath" -ForegroundColor Yellow
Write-Host ""

# 加载 SQLite 程序集（Windows 自带）
Add-Type -AssemblyName System.Data

function Query-SQLite {
    param([string]$query)

    $connectionString = "Data Source=$dbPath;Version=3;"
    $connection = New-Object System.Data.SQLite.SQLiteConnection($connectionString)

    try {
        $connection.Open()
        $command = $connection.CreateCommand()
        $command.CommandText = $query

        $adapter = New-Object System.Data.SQLite.SQLiteDataAdapter($command)
        $dataSet = New-Object System.Data.DataSet
        $adapter.Fill($dataSet) | Out-Null

        return $dataSet.Tables[0]
    } catch {
        Write-Host "查询失败: $_" -ForegroundColor Red
        return $null
    } finally {
        if ($connection.State -eq 'Open') {
            $connection.Close()
        }
    }
}

# 查询1: 查找包含"外箱"或"27寸"的器件
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
WHERE name LIKE '%外箱%' OR name LIKE '%27寸%'
"@

try {
    $result1 = Query-SQLite -query $query1

    if ($result1.Rows.Count -gt 0) {
        foreach ($row in $result1.Rows) {
            Write-Host ""
            Write-Host "  ID: $($row['id'])" -ForegroundColor White
            Write-Host "  器件名称: $($row['name'])" -ForegroundColor Yellow
            Write-Host "  型号: $($row['model'])" -ForegroundColor Gray
            Write-Host "  子类: $($row['sub_category'])" -ForegroundColor Gray
            Write-Host "  趋势开启: $(if ($row['trend_enabled'] -eq 1) {'✅ 是'} else {'❌ 否'})" -ForegroundColor $(if ($row['trend_enabled'] -eq 1) {'Green'} else {'Red'})
            Write-Host "  🔍 trend_query_category: '$($row['trend_query_category'])'" -ForegroundColor Cyan
            Write-Host "  🔍 trend_category_type: '$($row['trend_category_type'])'" -ForegroundColor Cyan
        }
    } else {
        Write-Host "  ❌ 未找到包含'外箱'或'27寸'的器件" -ForegroundColor Red
    }
} catch {
    Write-Host "  ⚠️  需要安装 System.Data.SQLite" -ForegroundColor Yellow
    Write-Host "  请运行: Install-Package System.Data.SQLite.Core" -ForegroundColor Yellow
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
LIMIT 10
"@

try {
    $result2 = Query-SQLite -query $query2

    if ($result2.Rows.Count -gt 0) {
        Write-Host "  找到 $($result2.Rows.Count) 个开启趋势关注的器件（最多显示10个）:"
        Write-Host ""
        foreach ($row in $result2.Rows) {
            $highlight = if ($row['name'] -like '*外箱*') { '👉 ' } else { '   ' }
            Write-Host "${highlight}[$($row['id'])] $($row['name'])" -ForegroundColor White
            Write-Host "        ⭐ query_category: '$($row['trend_query_category'])'" -ForegroundColor Cyan
            Write-Host "        ⭐ category_type: '$($row['trend_category_type'])'" -ForegroundColor Gray
        }
    } else {
        Write-Host "  ❌ 没有开启趋势关注的器件" -ForegroundColor Red
    }
} catch {
    # 忽略错误
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
LIMIT 10
"@

try {
    $result3 = Query-SQLite -query $query3

    if ($result3.Rows.Count -gt 0) {
        Write-Host "  找到 $($result3.Rows.Count) 条趋势条目（最多显示10条）:"
        Write-Host ""
        foreach ($row in $result3.Rows) {
            $highlight = if ($row['query_category'] -eq '瓦楞纸') { '🎯 ' } else { '   ' }
            Write-Host "${highlight}[ID: $($row['id'])] $($row['query_category'])" -ForegroundColor $(if ($row['query_category'] -eq '瓦楞纸') {'Cyan'} else {'White'})
            Write-Host "        类型: $($row['category_type'])" -ForegroundColor Gray
            Write-Host "        趋势: $($row['trend_direction'])" -ForegroundColor Gray
        }
    } else {
        Write-Host "  ❌ trend_items 表为空" -ForegroundColor Red
    }
} catch {
    # 忽略错误
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "📊 诊断结论" -ForegroundColor White
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "如果看到上述查询失败，请："
Write-Host "1. 使用 debug-trend.html（在浏览器中打开）" -ForegroundColor Yellow
Write-Host "2. 或下载 DB Browser for SQLite 手动查看数据库" -ForegroundColor Yellow
Write-Host ""
Write-Host "关键检查点："
Write-Host "• '外箱27寸五层' 的 trend_query_category 是否为 '瓦楞纸'？" -ForegroundColor Cyan
Write-Host "• trend_items 表中是否有 query_category='瓦楞纸' 的记录？" -ForegroundColor Cyan
Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
