#!/bin/bash

# AI版本快速测试脚本

echo "=========================================="
echo "显示器成本管理 - AI版本测试"
echo "=========================================="
echo ""

# 检查文件是否存在
echo "1. 检查AI版本文件..."
if [ ! -d "src-ai" ]; then
    echo "✗ src-ai 目录不存在"
    exit 1
fi

if [ ! -f "ai.html" ]; then
    echo "✗ ai.html 文件不存在"
    exit 1
fi

if [ ! -f "vite.config.ai.ts" ]; then
    echo "✗ vite.config.ai.ts 文件不存在"
    exit 1
fi

echo "✓ AI版本文件完整"
echo ""

# 检查package.json脚本
echo "2. 检查npm脚本..."
if grep -q "dev:ai" package.json; then
    echo "✓ dev:ai 脚本已配置"
else
    echo "✗ dev:ai 脚本未配置"
    exit 1
fi
echo ""

# 检查Ollama是否运行
echo "3. 检查Ollama服务（可选）..."
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "✓ Ollama服务已运行"
else
    echo "⚠ Ollama服务未运行（AI功能不可用，但可启动界面）"
fi
echo ""

echo "=========================================="
echo "测试完成！"
echo ""
echo "启动命令："
echo "  npm run dev:ai"
echo ""
echo "访问地址："
echo "  http://localhost:5174/ai.html"
echo ""
echo "如需AI功能："
echo "  1. 安装Ollama: https://ollama.ai"
echo "  2. 启动服务: ollama serve"
echo "  3. 下载模型: ollama pull qwen2.5:7b"
echo "=========================================="