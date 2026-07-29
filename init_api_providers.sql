-- CostHub 数据库初始化脚本 - 测试数据
-- 用途：快速填充API供应商配置，便于测试物料分解和趋势洞察功能
-- 使用方法：
--   1. 运行costhub.exe一次，让它创建数据库文件
--   2. 关闭costhub.exe
--   3. 用DB Browser for SQLite打开 monitor_cost.db
--   4. 执行本脚本（File -> Import -> Database from SQL file）
--   5. 重新运行costhub.exe

-- ==================== 搜索服务 ====================

-- Serper (Google Search) - 已启用，有测试Key
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (1, 'search', 'Serper (Google Search)', 'sk-test-serper-key-12345', 'https://google.serper.dev', '', 1, 1, 1, '注册即送2500次/月免费额度，以官网为准', 'https://serper.dev');

-- Tavily - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (2, 'search', 'Tavily', '', 'https://api.tavily.com', '', 0, 2, 1, '每月1000次免费额度', 'https://tavily.com');

-- Brave Search API - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (3, 'search', 'Brave Search API', '', 'https://api.search.brave.com', '', 0, 3, 1, '免费层2000次/月，以官网为准', 'https://brave.com/search/api');

-- Bocha 博查搜索 - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (4, 'search', 'Bocha 博查搜索', '', 'https://api.bochaai.com', '', 0, 4, 1, '国内搜索API，中文场景好，以官网为准', 'https://bochaai.com');

-- DuckDuckGo Lite - 未启用，无需Key
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (5, 'search', 'DuckDuckGo Lite (免费)', '', '', '', 0, 5, 1, '完全免费，无需API Key（无结构化返回），适合低成本方案', '');

-- ==================== 大模型服务 ====================

-- DeepSeek 官方 - 已启用，有测试Key
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (11, 'llm', 'DeepSeek 官方', 'sk-test-deepseek-1234567890abcdef', 'https://api.deepseek.com', 'deepseek-v4-pro', 1, 1, 1, '新用户赠送500万tokens，按量计费极低，以官网为准', 'https://platform.deepseek.com');

-- 硅基流动 SiliconFlow - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (12, 'llm', '硅基流动 SiliconFlow', '', 'https://api.siliconflow.cn/v1/chat/completions', 'deepseek-ai/DeepSeek-V2.5', 0, 2, 1, '聚合多个开源模型的网关，部分模型免费/低价，以官网为准', 'https://siliconflow.cn');

-- 智谱 GLM - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (13, 'llm', '智谱 GLM (BigModel)', '', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4-plus', 0, 3, 1, '部分模型有个人开发者免费额度，以官网为准', 'https://open.bigmodel.cn');

-- 月之暗面 Kimi - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (14, 'llm', '月之暗面 Kimi', '', 'https://api.moonshot.cn/v1/chat/completions', 'moonshot-v1-8k', 0, 4, 1, '有免费体验额度，具体以官网为准', 'https://platform.moonshot.cn');

-- 阿里云通义千问 - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (15, 'llm', '阿里云通义千问 (DashScope)', '', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen-plus', 0, 5, 1, '部分模型有免费额度（如qwen-turbo），以官网为准', 'https://dashscope.aliyun.com');

-- 火山引擎 - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (16, 'llm', '火山引擎 (豆包/DeepSeek)', '', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'deepseek-v3-241226', 0, 6, 1, '支持联网搜索+LLM打包接入，以官网为准', 'https://console.volcengine.com');

-- 腾讯混元 - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (17, 'llm', '腾讯混元', '', 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', 'hunyuan-pro', 0, 7, 1, '个人开发者免费额度以官网为准', 'https://cloud.tencent.com/product/hunyuan');

-- 百度文心千帆 - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (18, 'llm', '百度文心千帆', '', 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat', 'ERNIE-4.5-8K', 0, 8, 1, '有免费调用额度，以官网为准', 'https://qianfan.cloud.baidu.com');

-- Groq - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (19, 'llm', 'Groq (超快推理)', '', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile', 0, 9, 1, '免费层每天大量次数（具体见官网），以官网为准', 'https://console.groq.com');

-- Exa - 未启用
INSERT OR REPLACE INTO api_providers (id, provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
VALUES (20, 'llm', 'Exa (formerly Metaphor)', '', 'https://api.exa.ai', '', 0, 10, 1, '面向AI应用的语义搜索引擎，有免费试用额度，以官网为准', 'https://exa.ai');

-- ==================== 验证插入结果 ====================

SELECT '========== 搜索服务 ==========' as '检查结果';
SELECT provider_name, is_active, CASE WHEN api_key = '' THEN '未填Key' ELSE '已填Key' END as key_status
FROM api_providers
WHERE provider_type = 'search'
ORDER BY priority;

SELECT '========== 大模型服务 ==========' as '检查结果';
SELECT provider_name, model_name, is_active, CASE WHEN api_key = '' THEN '未填Key' ELSE '已填Key' END as key_status
FROM api_providers
WHERE provider_type = 'llm'
ORDER BY priority;

-- ==================== 说明 ====================
--
-- 注意：
-- 1. 示例中的API Key是测试用的假Key，实际使用时需要替换为真实Key
-- 2. 默认启用了Serper（搜索）和DeepSeek（大模型）各一个，方便测试
-- 3. 其他供应商保持禁用状态，需要时在设置页面启用并填写Key
-- 4. 使用INSERT OR REPLACE确保脚本可以重复执行
