// AI配置文件 - 预设您的本地模型
export const AI_PRESET_CONFIG = {
  enabled: true,
  ollamaUrl: 'http://localhost:11434',
  model: 'qwythos-9b',  // 您的本地模型
  timeout: 60000,       // 60秒超时（9B模型可能稍慢）
  autoApplyHighConfidence: false,  // 先关闭自动应用，手动确认更安全
  highConfidenceThreshold: 0.90
};

// 如何在浏览器中配置：
// 1. 打开 http://localhost:5175
// 2. 点击左侧菜单 "AI设置"
// 3. 修改模型为: qwythos-9b
// 4. 点击 "保存配置"
// 5. 点击 "测试连接" 验证