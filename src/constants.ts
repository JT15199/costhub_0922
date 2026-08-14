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

// 24 色自由池（与 CATEGORY_COLORS 预设 8 色完全无重复，保证同屏分类尽量不撞色）
const EXTRA_COLORS = ['#E11D48','#06B6D4','#F59E0B','#0EA5E9','#10B981','#7C3AED','#A855F7','#0891B2','#84CC16','#EF4444','#22C55E','#DB2777','#3B82F6','#F43F5E','#CA8A04','#9D174D','#0D9488','#B45309','#6D28D9','#0F766E','#BE185D','#4D7C0F','#C2410C','#0369A1'];

/** FNV-1a + 雪崩混合哈希：稳定（同名分类永远同一颜色，与渲染顺序无关）+ 分布均匀 */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 分类自动配色：预设 8 类用固定色；其他分类用哈希起点线性探测分配未用色，
 * 结果持久化到 localStorage（catColorMap）——同屏分类不撞色、跨渲染顺序/跨会话稳定。
 */
export function getCategoryColor(cat: string): string {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  let map: Record<string, string> = {};
  try { map = JSON.parse(localStorage.getItem('catColorMap') || '{}'); } catch { /* ignore */ }
  if (map[cat]) return map[cat];
  const used = new Set<string>([...Object.values(CATEGORY_COLORS), ...Object.values(map)]);
  const start = hashStr(cat) % EXTRA_COLORS.length;
  let c = EXTRA_COLORS[start];
  if (used.has(c)) {
    for (let i = 1; i < EXTRA_COLORS.length; i++) {
      const cand = EXTRA_COLORS[(start + i) % EXTRA_COLORS.length];
      if (!used.has(cand)) { c = cand; break; }
    }
  }
  map[cat] = c;
  try { localStorage.setItem('catColorMap', JSON.stringify(map)); } catch { /* ignore */ }
  CATEGORY_COLORS[cat] = c;
  return c;
}

// 预置API供应商
export const PRESET_SEARCH_PROVIDERS = [
  {
    provider_name: 'Tavily',
    base_url: 'https://api.tavily.com/search',
    monthly_quota_note: '提供开发者免费额度，实际额度以官网当前政策为准',
    registration_url: 'https://app.tavily.com/home',
  },
  {
    provider_name: 'Serper (Google Search)',
    base_url: 'https://google.serper.dev/search',
    monthly_quota_note: '新账号通常有免费试用查询额度，以官网当前政策为准',
    registration_url: 'https://serper.dev/api-key',
  },
  {
    provider_name: 'Brave Search API',
    base_url: 'https://api.search.brave.com/res/v1/web/search',
    monthly_quota_note: '提供免费方案或试用额度，以官网当前政策为准',
    registration_url: 'https://api-dashboard.search.brave.com/app/keys',
  },
  {
    provider_name: 'Bocha 博查搜索',
    base_url: 'https://api.bochaai.com/v1/web-search',
    monthly_quota_note: '国内中文搜索服务，注册赠送/免费额度以官网当前政策为准',
    registration_url: 'https://open.bochaai.com',
  },
  {
    provider_name: 'Bing Search API',
    base_url: 'https://api.bing.microsoft.com/v7.0/search',
    monthly_quota_note: '需 Azure 订阅；是否有免费额度以 Azure 当前政策为准',
    registration_url: 'https://portal.azure.com',
  },
  {
    provider_name: 'SearchApi.io',
    base_url: 'https://www.searchapi.io/api/v1/search',
    monthly_quota_note: 'Google 等搜索结果聚合，新账号试用额度以官网为准',
    registration_url: 'https://www.searchapi.io/dashboard',
  },
  {
    provider_name: 'Exa AI Search',
    base_url: 'https://api.exa.ai/search',
    monthly_quota_note: 'AI 语义搜索，提供新用户试用额度，以官网当前政策为准',
    registration_url: 'https://dashboard.exa.ai/api-keys',
  },
];

export const PRESET_LLM_PROVIDERS = [
  {
    provider_name: 'DeepSeek 官方',
    base_url: 'https://api.deepseek.com/chat/completions',
    model_name: 'deepseek-chat',
    monthly_quota_note: '按量计费；赠送或试用额度以官网当前政策为准',
    registration_url: 'https://platform.deepseek.com/api_keys',
  },
  {
    provider_name: '硅基流动 SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1/chat/completions',
    model_name: 'Qwen/Qwen2.5-7B-Instruct',
    monthly_quota_note: '部分开源模型标有免费额度，具体以控制台为准',
    registration_url: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    provider_name: '智谱 GLM (BigModel)',
    base_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model_name: 'glm-4-flash',
    monthly_quota_note: 'GLM Flash 系列通常提供免费调用，模型与额度以官网为准',
    registration_url: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    provider_name: '月之暗面 Kimi',
    base_url: 'https://api.moonshot.cn/v1/chat/completions',
    model_name: 'moonshot-v1-8k',
    monthly_quota_note: '可能提供新用户体验额度，以官网当前政策为准',
    registration_url: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    provider_name: '阿里云通义千问 (DashScope)',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model_name: 'qwen-turbo',
    monthly_quota_note: '部分模型提供限时或新人免费额度，以百炼控制台为准',
    registration_url: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    provider_name: '火山引擎 (豆包/DeepSeek)',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model_name: '请填写推理接入点 ID',
    monthly_quota_note: '模型名称需填写控制台创建的推理接入点 ID；额度以官网为准',
    registration_url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    provider_name: '腾讯混元',
    base_url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    model_name: 'hunyuan-pro',
    monthly_quota_note: '免费资源包或试用额度以腾讯云当前政策为准',
    registration_url: 'https://console.cloud.tencent.com/hunyuan/start',
  },
  {
    provider_name: 'Google Gemini (OpenAI兼容)',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model_name: 'gemini-2.0-flash',
    monthly_quota_note: 'Gemini API 提供受速率限制的免费层，以 Google AI Studio 为准',
    registration_url: 'https://aistudio.google.com/apikey',
  },
  {
    provider_name: 'Groq (超快推理)',
    base_url: 'https://api.groq.com/openai/v1/chat/completions',
    model_name: 'llama-3.3-70b-versatile',
    monthly_quota_note: '提供受速率限制的开发者免费层，以控制台为准',
    registration_url: 'https://console.groq.com/keys',
  },
  {
    provider_name: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1/chat/completions',
    model_name: 'openrouter/free',
    monthly_quota_note: '可路由到免费模型；可用模型和频率限制以官网为准',
    registration_url: 'https://openrouter.ai/settings/keys',
  },
  {
    provider_name: '魔搭 ModelScope',
    base_url: 'https://api-inference.modelscope.cn/v1/chat/completions',
    model_name: 'Qwen/Qwen2.5-7B-Instruct',
    monthly_quota_note: '开发者推理 API 免费额度和限流以魔搭控制台为准',
    registration_url: 'https://modelscope.cn/my/myaccesstoken',
  },
];

// 兼容性导出（Settings.tsx使用的旧名称）
export const PRESET_PROVIDERS = [
  ...PRESET_SEARCH_PROVIDERS.map(p => ({ ...p, provider_type: 'search' })),
  ...PRESET_LLM_PROVIDERS.map(p => ({ ...p, provider_type: 'llm' })),
];
