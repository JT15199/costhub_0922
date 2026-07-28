# AI版本快速测试脚本（Windows PowerShell）

Write-Host "=========================================="
Write-Host "显示器成本管理 - AI版本测试"
Write-Host "=========================================="
Write-Host ""

# 检查文件是否存在
Write-Host "1. 检查AI版本文件..."
if (-not (Test-Path "src-ai")) {
    Write-Host "✗ src-ai 目录不存在"
    exit 1
}

if (-not (Test-Path "ai.html")) {
    Write-Host "✗ ai.html 文件不存在"
    exit 1
}

if (-not (Test-Path "vite.config.ai.ts")) {
    Write-Host "✗ vite.config.ai.ts 文件不存在"
    exit 1
}

Write-Host "✓ AI版本文件完整"
Write-Host ""

# 检查package.json脚本
Write-Host "2. 检查npm脚本..."
$packageJson = Get-Content "package.json" -Raw
if ($packageJson -match "dev:ai") {
    Write-Host "✓ dev:ai 脚本已配置"
} else {
    Write-Host "✗ dev:ai 脚本未配置"
    exit 1
}
Write-Host ""

# 检查Ollama是否运行（可选）
Write-Host "3. 检查Ollama服务（可选）..."
try {
    $response = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 2 -ErrorAction Stop
    Write-Host "✓ Ollama服务已运行"
} catch {
    Write-Host "⚠ Ollama服务未运行（AI功能不可用，但可启动界面）"
}
Write-Host ""

Write-Host "=========================================="
Write-Host "测试完成！"
Write-Host ""
Write-Host "启动命令："
Write-Host "  npm run dev:ai"
Write-Host ""
Write-Host "访问地址："
Write-Host "  http://localhost:5174/ai.html"
Write-Host ""
Write-Host "如需AI功能："
Write-Host "  1. 安装Ollama: https://ollama.ai"
Write-Host "  2. 启动服务: ollama serve"
Write-Host "  3. 下载模型: ollama pull qwen2.5:7b"
Write-Host "=========================================="

# 提供启动选项
Write-Host ""
Write-Host "是否立即启动AI版本？(Y/N)"
$choice = Read-Host
if ($choice -eq "Y" -or $choice -eq "y") {
    Write-Host "正在启动AI版本..."
    npm run dev:ai
}