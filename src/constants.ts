export const MAIN_CATEGORIES = ['硬件类', '结构类', '电源类', '线材类', '包材类', '加工费类', '软件类', '其他'];

export const SUB_CATEGORIES: Record<string, string[]> = {
  '硬件类': ['Scaler IC', 'MCU', 'TCON', '电源管理IC', 'DDR', 'eMMC/Flash', '电阻', '电容', '电感', '晶振', '二极管', '三极管/MOSFET', 'ESD保护', 'HDMI接口', 'DP接口', 'Type-C接口', 'USB Hub', 'Audio Codec', 'WiFi/BT模块', 'PCB板', '其他硬件'],
  '结构类': ['前框', '后壳', '中框', '底座', '立柱', '铰链', 'VESA挂架', '散热片', '装饰件', '螺丝/紧固件', '其他结构'],
  '电源类': ['电源适配器', '内置电源板', 'DC-DC模块', '电池', '电源线', 'DC线', '其他电源'],
  '线材类': ['HDMI线', 'DP线', 'Type-C线', 'USB线', 'LVDS排线', 'FFC排线', '内部连接线', '其他线材'],
  '包材类': ['外箱', '内卡/缓冲材', 'PE袋', '说明书', '保修卡', '标签/贴纸', '其他包材'],
  '加工费类': ['SMT贴片', 'DIP插件', '组装费', '测试费', '包装费', '老化测试费', '校准费', '其他加工费'],
  '软件类': ['Firmware', 'OSD菜单', '色彩校准数据', '驱动软件', '测试软件', '其他软件'],
  '其他': ['面板', '背光模组', '导光板', '偏光片', '辅料', '其他'],
};

export const CATEGORY_COLORS: Record<string, string> = {
  '硬件类': '#CF0A2C', '结构类': '#2563EB', '电源类': '#8B5CF6',
  '线材类': '#EC4899', '包材类': '#14B8A6', '加工费类': '#F97316',
  '软件类': '#6366F1', '其他': '#64748B',
};

export const SCREEN_SIZES = ['21.5"','23.6"','23.8"','24"','24.5"','27"','28"','31.5"','32"','34"','43"','49"'];
export const RESOLUTIONS = ['1920×1080 (FHD)','1920×1200 (WUXGA)','2560×1440 (QHD)','2560×1600 (WQXGA)','3440×1440 (UWQHD)','3840×2160 (4K UHD)'];
export const REFRESH_RATES = ['60Hz','75Hz','100Hz','120Hz','144Hz','165Hz','180Hz','240Hz'];
export const PANEL_TYPES = ['IPS','VA','TN','OLED','MiniLED','QD-OLED'];
export const TIERS = ['入门级','主流级','中高端','高端','旗舰级'];
export const PROJECT_STATUSES = ['进行中','已完成','暂停'];
export const PROJECT_TYPES = ['在研','已完成'];
export const MEASURE_STATUSES = ['待执行','执行中','已完成','已取消'];
export const BRAND_RED = '#CF0A2C';

// 主题调色板定义
export const PALETTES = [
  { id: 'apple', name: 'Apple 紫粉', icon: '🍎' },
  { id: 'tiffany', name: 'Tiffany 蓝玻璃', icon: '💎' },
  { id: 'paper', name: 'Paper 白底', icon: '📄' },
  { id: 'rose', name: 'Rose Gold 玫瑰', icon: '🌹' },
  { id: 'aurora', name: 'Aurora 极光', icon: '🌌' },
  { id: 'mint', name: 'Mint 薄荷', icon: '🍃' },
  { id: 'sky', name: 'Sky 天空', icon: '☁️' },
];

// 调色板主色映射
export const PALETTE_PRIMARY: Record<string, string> = {
  apple: '#A855F7',
  tiffany: '#06B6D4',
  paper: '#64748B',
  rose: '#F59E0B',
  aurora: '#10B981',
  mint: '#84CC16',
  sky: '#3B82F6',
};

// 色温选项
export const COLOR_TEMPS = [
  { id: 'default', name: '默认', icon: '☀️' },
  { id: 'warm', name: '暖光', icon: '🔥' },
  { id: 'cool', name: '冷调', icon: '❄️' },
  { id: 'sepia', name: '护眼', icon: '📖' },
];

const EXTRA_COLORS = ['#6366F1', '#EC4899', '#14B8A6', '#F97316', '#8B5CF6', '#06B6D4', '#E11D48', '#CA8A04', '#7C3AED', '#0891B2'];
let colorIdx = 0;
export function getCategoryColor(cat: string): string {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  const c = EXTRA_COLORS[colorIdx % EXTRA_COLORS.length];
  CATEGORY_COLORS[cat] = c;
  colorIdx++;
  return c;
}

// 预置API供应商
export const PRESET_SEARCH_PROVIDERS = [
  {
    provider_name: 'Tavily',
    base_url: 'https://api.tavily.com',
    monthly_quota_note: '每月1000次免费额度',
    registration_url: 'https://tavily.com',
  },
  {
    provider_name: 'Serper (Google Search)',
    base_url: 'https://google.serper.dev',
    monthly_quota_note: '注册即送2500次/月免费额度，以官网为准',
    registration_url: 'https://serper.dev',
  },
  {
    provider_name: 'Brave Search API',
    base_url: 'https://api.search.brave.com',
    monthly_quota_note: '免费层2000次/月，以官网为准',
    registration_url: 'https://brave.com/search/api',
  },
  {
    provider_name: 'Bocha 博查搜索',
    base_url: 'https://api.bochaai.com',
    monthly_quota_note: '国内搜索API，中文场景好，以官网为准',
    registration_url: 'https://bochaai.com',
  },
  {
    provider_name: 'Bing Search API',
    base_url: 'https://api.bing.microsoft.com',
    monthly_quota_note: 'Azure免费层每月1000次，超出按量计费，以官网为准',
    registration_url: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api',
  },
  {
    provider_name: 'SearchAPI',
    base_url: 'https://api.search1api.com',
    monthly_quota_note: '聚合多搜索引擎（Google/Bing/Brave等），以官网为准',
    registration_url: 'https://www.searchapi.io',
  },
  {
    provider_name: 'DuckDuckGo Lite (免费)',
    base_url: '',
    monthly_quota_note: '完全免费，无需API Key（无结构化返回），适合低成本方案',
    registration_url: '',
  },
];

export const PRESET_LLM_PROVIDERS = [
  {
    provider_name: 'DeepSeek 官方',
    base_url: 'https://api.deepseek.com',
    model_name: 'deepseek-v4-pro',
    monthly_quota_note: '新用户赠送500万tokens，按量计费极低，以官网为准',
    registration_url: 'https://platform.deepseek.com',
  },
  {
    provider_name: '硅基流动 SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1/chat/completions',
    model_name: 'deepseek-ai/DeepSeek-V2.5',
    monthly_quota_note: '聚合多个开源模型的网关，部分模型免费/低价，以官网为准',
    registration_url: 'https://siliconflow.cn',
  },
  {
    provider_name: '智谱 GLM (BigModel)',
    base_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model_name: 'glm-4-plus',
    monthly_quota_note: '部分模型有个人开发者免费额度，以官网为准',
    registration_url: 'https://open.bigmodel.cn',
  },
  {
    provider_name: '月之暗面 Kimi',
    base_url: 'https://api.moonshot.cn/v1/chat/completions',
    model_name: 'moonshot-v1-8k',
    monthly_quota_note: '有免费体验额度，具体以官网为准',
    registration_url: 'https://platform.moonshot.cn',
  },
  {
    provider_name: '阿里云通义千问 (DashScope)',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model_name: 'qwen-plus',
    monthly_quota_note: '部分模型有免费额度（如qwen-turbo），以官网为准',
    registration_url: 'https://dashscope.aliyun.com',
  },
  {
    provider_name: '火山引擎 (豆包/DeepSeek)',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model_name: 'deepseek-v3-241226',
    monthly_quota_note: '随送创建度以官网为准，支持联网搜索+LLM打包接入',
    registration_url: 'https://console.volcengine.com',
  },
  {
    provider_name: '腾讯混元',
    base_url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    model_name: 'hunyuan-pro',
    monthly_quota_note: '个人开发者免费额度以官网为准',
    registration_url: 'https://cloud.tencent.com/product/hunyuan',
  },
  {
    provider_name: '百度文心千帆',
    base_url: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat',
    model_name: 'ERNIE-4.5-8K',
    monthly_quota_note: '有免费调用额度，以官网为准',
    registration_url: 'https://qianfan.cloud.baidu.com',
  },
  {
    provider_name: 'Groq (超快推理)',
    base_url: 'https://api.groq.com/openai/v1/chat/completions',
    model_name: 'llama-3.3-70b-versatile',
    monthly_quota_note: '免费层每天大量次数（具体开发者见官网），以官网为准',
    registration_url: 'https://console.groq.com',
  },
  {
    provider_name: 'Exa (formerly Metaphor)',
    base_url: 'https://api.exa.ai',
    model_name: '',
    monthly_quota_note: '面向AI应用的语义搜索引擎，有免费试用额度，以官网为准',
    registration_url: 'https://exa.ai',
  },
];
