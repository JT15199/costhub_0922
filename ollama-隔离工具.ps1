# ============================================================
#  Ollama 网络隔离工具
#  一键封禁 ollama.exe 出站连接（Windows 防火墙层面硬隔离）
#  用法：右键 → 使用 PowerShell 运行
# ============================================================
# 需要管理员权限运行
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限！请右键点击本文件，选择"以管理员身份运行"" -ForegroundColor Red
    Read-Host "按回车退出"
    exit
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Ollama 网络隔离工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "请选择操作：" -ForegroundColor Yellow
Write-Host "  1. 封禁 Ollama 出站连接（阻止联网）"
Write-Host "  2. 解除封禁（恢复联网）"
Write-Host "  3. 查看当前封禁状态"
$choice = Read-Host "输入数字后回车"

# ---------- 查找 ollama.exe ----------
function Find-Ollama {
    $paths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe",
        "${env:ProgramFiles(x86)}\Ollama\ollama.exe",
        "$env:USERPROFILE\AppData\Local\Ollama\ollama.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    # 尝试从 PATH 查找
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$ollamaPath = Find-Ollama
if (-not $ollamaPath) {
    Write-Host "未找到 ollama.exe，请手动输入路径：" -ForegroundColor Yellow
    $ollamaPath = Read-Host "例如 C:\Users\你\AppData\Local\Programs\Ollama\ollama.exe"
    if (-not (Test-Path $ollamaPath)) {
        Write-Host "路径无效！" -ForegroundColor Red
        Read-Host "按回车退出"
        exit
    }
}
Write-Host "找到 Ollama: $ollamaPath" -ForegroundColor Green

# ---------- 规则名 ----------
$ruleBlock = "CostHub_Block_Ollama_Outbound"
$ruleAllow = "CostHub_Allow_Ollama_Outbound"

switch ($choice) {
    "1" {
        # 先删除可能存在的放行规则
        Remove-NetFirewallRule -DisplayName $ruleAllow -ErrorAction SilentlyContinue
        # 删除旧的封禁规则（避免重复）
        Remove-NetFirewallRule -DisplayName $ruleBlock -ErrorAction SilentlyContinue
        # 创建出站阻止规则
        New-NetFirewallRule -DisplayName $ruleBlock -Direction Outbound -Action Block -Program $ollamaPath -Profile Any -Description "CostHub 本地AI助手数据保护：阻止 Ollama 访问互联网" | Out-Null
        Write-Host ""
        Write-Host "✅ 已封禁 Ollama 出站连接！" -ForegroundColor Green
        Write-Host "现在 Ollama 只能在本机 (localhost) 运行，无法访问互联网。" -ForegroundColor Green
        Write-Host "本地 AI 助手不受影响，数据 100% 留在本机。" -ForegroundColor Green
    }
    "2" {
        Remove-NetFirewallRule -DisplayName $ruleBlock -ErrorAction SilentlyContinue
        # 创建显式放行规则（防止其他规则误伤）
        Remove-NetFirewallRule -DisplayName $ruleAllow -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $ruleAllow -Direction Outbound -Action Allow -Program $ollamaPath -Profile Any | Out-Null
        Write-Host "✅ 已解除封禁，Ollama 恢复联网能力。" -ForegroundColor Green
    }
    "3" {
        $r = Get-NetFirewallRule -DisplayName $ruleBlock -ErrorAction SilentlyContinue
        if ($r) {
            Write-Host "🛡️ 当前状态：Ollama 已被封禁联网（规则：$ruleBlock）" -ForegroundColor Cyan
        } else {
            $a = Get-NetFirewallRule -DisplayName $ruleAllow -ErrorAction SilentlyContinue
            if ($a) {
                Write-Host "ℹ️ 当前状态：Ollama 已解除封禁（存在放行规则）" -ForegroundColor Yellow
            } else {
                Write-Host "ℹ️ 当前状态：未设置任何规则（Ollama 默认可联网）" -ForegroundColor Yellow
            }
        }
    }
    default {
        Write-Host "无效输入" -ForegroundColor Red
    }
}

Write-Host ""
Read-Host "操作完成，按回车退出"
