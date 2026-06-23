// Mac风格颜色配置
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

// Mac风格颜色 - 蓝色系
export const CATEGORY_COLORS: Record<string, string> = {
  '硬件类': '#3B82F6', '结构类': '#5AC8FA', '电源类': '#8B5CF6',
  '线材类': '#AF52DE', '包材类': '#34C759', '加工费类': '#FF9500',
  '软件类': '#5856D6', '其他': '#6E6E73',
};

export const SCREEN_SIZES = ['21.5"','23.6"','23.8"','24"','24.5"','27"','28"','31.5"','32"','34"','43"','49"'];
export const RESOLUTIONS = ['1920×1080 (FHD)','1920×1200 (WUXGA)','2560×1440 (QHD)','2560×1600 (WQXGA)','3440×1440 (UWQHD)','3840×2160 (4K UHD)'];
export const REFRESH_RATES = ['60Hz','75Hz','100Hz','120Hz','144Hz','165Hz','180Hz','240Hz'];
export const PANEL_TYPES = ['IPS','VA','TN','OLED','MiniLED','QD-OLED'];
export const TIERS = ['入门级','主流级','中高端','高端','旗舰级'];
export const PROJECT_STATUSES = ['进行中','已完成','暂停'];
export const PROJECT_TYPES = ['在研','已完成'];
export const MEASURE_STATUSES = ['待执行','执行中','已完成','已取消'];
export const BRAND_RED = '#3B82F6'; // Mac蓝色

// 扩展调色板 - 16 色覆盖，足够分散任意新增分类
export const EXTRA_COLORS: readonly string[] = [
  '#0ABAB5', '#4DD0E1', '#7C4DFF', '#FF6B6B', '#FFA94D',
  '#FFD43B', '#69DB7C', '#4DABF7', '#B197FC', '#F783AC',
  '#22D3EE', '#A78BFA', '#FB7185', '#FBBF24', '#34D399', '#60A5FA',
] as const;

// djb2 字符串哈希：相同 name 永远映射到同一槽位，跨刷新保持稳定
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// 取得分类颜色：已知分类走静态字典，未知分类走哈希槽位
// 纯函数，无副作用，调用方可以安全地在 render 路径中使用
export function getCategoryColor(cat: string | undefined | null): string {
  if (!cat) return '#64748B';
  const known = CATEGORY_COLORS[cat];
  if (known) return known;
  return EXTRA_COLORS[djb2(cat) % EXTRA_COLORS.length];
}

// 调色板元数据：id 必须与 src/index.css 里 [data-palette="<id>"] 块对应
export type PaletteId = 'apple' | 'tiffany' | 'rose' | 'aurora' | 'mint' | 'sky' | 'paper';
export const PALETTES: ReadonlyArray<{ id: PaletteId; name: string; swatch: string }> = [
  { id: 'apple',   name: 'Apple 紫粉',     swatch: 'linear-gradient(135deg, #FF375F 0%, #BF5AF2 50%, #5E5CE6 100%)' },
  { id: 'tiffany', name: 'Tiffany 蓝玻璃', swatch: 'linear-gradient(135deg, #0ABAB5 0%, #4DD0E1 50%, #80DEEA 100%)' },
  { id: 'paper',   name: 'Paper 白底',     swatch: 'linear-gradient(135deg, #FFFFFF 0%, #F1F5F9 50%, #E2E8F0 100%)' },
  { id: 'rose',    name: 'Rose Gold 玫瑰', swatch: 'linear-gradient(135deg, #E879A8 0%, #F2A65A 50%, #E8B4A0 100%)' },
  { id: 'aurora',  name: 'Aurora 极光',    swatch: 'linear-gradient(135deg, #14B8A6 0%, #2DD4BF 35%, #818CF8 70%, #C084FC 100%)' },
  { id: 'mint',    name: 'Mint 薄荷',      swatch: 'linear-gradient(135deg, #34D399 0%, #A3E635 50%, #FBBF24 100%)' },
  { id: 'sky',     name: 'Sky 天空',       swatch: 'linear-gradient(135deg, #60A5FA 0%, #A5B4FC 50%, #F0ABFC 100%)' },
];