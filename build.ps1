# CostHub v2.3.15 Build Script
# PowerShell build script with proper UTF-8 encoding

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "CostHub v2.3.15 Auto Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$ErrorActionPreference = "Stop"

try {
    # Check Node.js
    Write-Host "[1/4] Checking environment..." -ForegroundColor Yellow
    $nodeVersion = node --version 2>$null
    if (-not $nodeVersion) {
        throw "Node.js not found. Please install Node.js first."
    }
    Write-Host "  OK Node.js: $nodeVersion" -ForegroundColor Green

    # Check npm
    $npmVersion = npm --version 2>$null
    if (-not $npmVersion) {
        throw "npm not found"
    }
    Write-Host "  OK npm: $npmVersion" -ForegroundColor Green

    # Check dependencies
    Write-Host "`n[2/4] Checking dependencies..." -ForegroundColor Yellow
    if (-not (Test-Path "node_modules")) {
        Write-Host "  First build, installing dependencies..." -ForegroundColor Yellow
        npm install
    } else {
        Write-Host "  OK Dependencies installed" -ForegroundColor Green
    }

    # Build frontend
    Write-Host "`n[3/4] Building frontend..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed"
    }
    Write-Host "  OK Frontend build completed" -ForegroundColor Green

    # Build Tauri
    Write-Host "`n[4/4] Building Tauri application..." -ForegroundColor Yellow
    Write-Host "  This may take several minutes, please wait..." -ForegroundColor Gray
    npm run tauri:build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed"
    }
    Write-Host "  OK Tauri build completed" -ForegroundColor Green

    # Check output file
    $exePath = "src-tauri\target\release\costhub.exe"
    if (Test-Path $exePath) {
        $fileSize = (Get-Item $exePath).Length / 1MB
        Write-Host "`n========================================" -ForegroundColor Cyan
        Write-Host "Build Successful!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "Output: $exePath" -ForegroundColor White
        Write-Host "Size: $([math]::Round($fileSize, 2)) MB" -ForegroundColor White
        Write-Host "Version: v2.3.15" -ForegroundColor White
        Write-Host "Database: costhub.db (will be created on first run)" -ForegroundColor White
        Write-Host "========================================" -ForegroundColor Cyan
    } else {
        throw "Build completed but output file not found"
    }

} catch {
    Write-Host "`n========================================" -ForegroundColor Red
    Write-Host "Build Failed!" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please check:" -ForegroundColor Yellow
    Write-Host "  1. Node.js and npm are installed correctly" -ForegroundColor White
    Write-Host "  2. Network connection is available" -ForegroundColor White
    Write-Host "  3. Sufficient disk space" -ForegroundColor White
    Write-Host "  4. Antivirus not blocking compilation" -ForegroundColor White
    exit 1
}

Write-Host "`nPress any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
