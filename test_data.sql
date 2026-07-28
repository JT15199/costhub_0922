-- 插入预置的搜索服务供应商（用于测试）
INSERT INTO api_providers (provider_type, provider_name, api_key, base_url, is_active, priority, is_preset, monthly_quota_note, registration_url) VALUES
('search', 'Tavily', '', 'https://api.tavily.com', 0, 1, 1, '每月1000次免费额度', 'https://tavily.com'),
('search', 'Serper (Google Search)', 'sk-test-key-12345', 'https://google.serper.dev', 1, 2, 1, '注册即送2500次/月免费额度，以官网为准', 'https://serper.dev'),
('search', 'Brave Search API', '', 'https://api.search.brave.com', 0, 3, 1, '免费层2000次/月，以官网为准', 'https://brave.com/search/api'),
('search', 'Bocha 博查搜索', '', 'https://api.bochaai.com', 0, 4, 1, '国内搜索API，中文场景好，以官网为准', 'https://bochaai.com'),
('search', 'DuckDuckGo Lite (免费)', '', '', 0, 5, 1, '完全免费，无需API Key（无结构化返回），适合低成本方案', '');

-- 插入预置的大模型服务供应商（用于测试）
INSERT INTO api_providers (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url) VALUES
('llm', 'DeepSeek 官方', 'sk-abcdef1234567890abcdef', 'https://api.deepseek.com', 'deepseek-v4-pro', 1, 1, 1, '新用户赠送500万tokens，按量计费极低，以官网为准', 'https://platform.deepseek.com'),
('llm', '硅基流动 SiliconFlow', '', 'https://api.siliconflow.cn/v1/chat/completions', 'deepseek-ai/DeepSeek-V2.5', 0, 2, 1, '聚合多个开源模型的网关，部分模型免费/低价，以官网为准', 'https://siliconflow.cn'),
('llm', '智谱 GLM (BigModel)', '', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4-plus', 0, 3, 1, '部分模型有个人开发者免费额度，以官网为准', 'https://open.bigmodel.cn'),
('llm', '月之暗面 Kimi', '', 'https://api.moonshot.cn/v1/chat/completions', 'moonshot-v1-8k', 0, 4, 1, '有免费体验额度，具体以官网为准', 'https://platform.moonshot.cn'),
('llm', '阿里云通义千问 (DashScope)', '', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen-plus', 0, 5, 1, '部分模型有免费额度（如qwen-turbo），以官网为准', 'https://dashscope.aliyun.com'),
('llm', '火山引擎 (豆包/DeepSeek)', '', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'deepseek-v3-241226', 0, 6, 1, '支持联网搜索+LLM打包接入，以官网为准', 'https://console.volcengine.com'),
('llm', '腾讯混元', '', 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', 'hunyuan-pro', 0, 7, 1, '个人开发者免费额度以官网为准', 'https://cloud.tencent.com/product/hunyuan'),
('llm', '百度文心千帆', '', 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat', 'ERNIE-4.5-8K', 0, 8, 1, '有免费调用额度，以官网为准', 'https://qianfan.cloud.baidu.com'),
('llm', 'Groq (超快推理)', '', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile', 0, 9, 1, '免费层每天大量次数（具体见官网），以官网为准', 'https://console.groq.com');
