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

const EXTRA_COLORS = ['#6366F1', '#EC4899', '#14B8A6', '#F97316', '#8B5CF6', '#06B6D4', '#E11D48', '#CA8A04', '#7C3AED', '#0891B2'];
let colorIdx = 0;
export function getCategoryColor(cat: string): string {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  const c = EXTRA_COLORS[colorIdx % EXTRA_COLORS.length];
  CATEGORY_COLORS[cat] = c;
  colorIdx++;
  return c;
}
