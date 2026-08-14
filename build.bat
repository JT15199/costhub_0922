@echo off
echo ========================================
echo CostHub 构建脚本
echo ========================================
echo.

echo [1/3] 检查环境...
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 npm，请确保已安装 Node.js
    pause
    exit /b 1
)

echo [2/3] 构建前端资源...
call npm run build
if %errorlevel% neq 0 (
    echo 错误: 前端构建失败
    pause
    exit /b 1
)

echo [3/3] 构建 Tauri 应用...
call npm run tauri:build
if %errorlevel% neq 0 (
    echo 错误: Tauri 构建失败
    pause
    exit /b 1
)

echo.
echo ========================================
echo 构建完成！
echo 输出位置: src-tauri\target\release\costhub.exe
echo ========================================
pause
