@echo off
chcp 65001 >nul
title CostHub - 拉取 Ollama 4B 模型
echo ========================================
echo   CostHub 模型拉取工具（自动处理联网开关）
echo ========================================
echo.

:: 检查是否管理员
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限才能切换防火墙！
    echo 请右键本文件 - 以管理员身份运行
    echo.
    pause
    exit /b
)

echo [1/3] 暂时解除 Ollama 联网封禁...
netsh advfirewall firewall delete rule name="CostHub_Block_Ollama_Outbound" >nul 2>&1
echo       完成（已解封）
echo.

echo [2/3] 开始拉取 Qwen3:4b 模型（约 2.5GB，请耐心等待）...
ollama pull qwen3:4b
if %errorlevel% neq 0 (
    echo.
    echo 拉取失败！请检查网络连接后重试。
    echo.
    echo [!] 正在重新封禁 Ollama 联网...
    for /f "delims=" %%i in ('where ollama 2^>nul') do set OLLAMA_PATH=%%i
    if defined OLLAMA_PATH (
        netsh advfirewall firewall add rule name="CostHub_Block_Ollama_Outbound" dir=out action=block program="%OLLAMA_PATH%" profile=any enable=yes >nul
    )
    echo    已重新封禁
    pause
    exit /b
)
echo.
echo [3/3] 拉取成功！正在重新封禁 Ollama 联网...
for /f "delims=" %%i in ('where ollama 2^>nul') do set OLLAMA_PATH=%%i
if defined OLLAMA_PATH (
    netsh advfirewall firewall add rule name="CostHub_Block_Ollama_Outbound" dir=out action=block program="%OLLAMA_PATH%" profile=any enable=yes >nul
    echo    已重新封禁，数据安全恢复
) else (
    echo    未找到 ollama.exe，请在应用里手动封禁
)
echo.
echo 完成！现在可以在 CostHub 本地AI助手设置里选择 qwen3:4b
echo.
pause
