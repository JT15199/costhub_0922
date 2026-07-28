// 快速修复AI配置 - 直接设置正确的qwythos-9b模型

// 在浏览器Console中运行（F12打开开发者工具）：

localStorage.setItem('ai_config', JSON.stringify({
  enabled: true,
  ollamaUrl: 'http://localhost:11434',
  model: 'qwythos-9b',  // 直接设置为字符串，不是数组
  timeout: 60000,
  autoApplyHighConfidence: false,
  highConfidenceThreshold: 0.90
}));

console.log('✓ AI配置已修复');
console.log('配置内容:', JSON.parse(localStorage.getItem('ai_config')));

// 刷新页面应用新配置
location.reload();