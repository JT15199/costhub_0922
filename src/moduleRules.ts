// 模块分类规则引擎（v2.3.19，2026-08-18：从原 LocalAIAssistant 提取，供 AI 数据工程工具复用）
// 确定性关键词规则：命中即采用（比让弱模型"感觉"可靠得多）；未命中返回 null（交给 AI 或归"未归类"）
export interface ModuleRule { keywords: string[]; module: string; mainCat: string; sub: string; }

export const MODULE_RULES: ModuleRule[] = [
  { keywords: ['面板', 'lcd', '液晶', '屏', '玻璃', '偏光片', '导光板', '光学膜', 'panel'], module: '显示模块', mainCat: '硬件类', sub: '面板' },
  { keywords: ['背光', '灯条', '灯珠', 'led灯', '背光驱动', '导光'], module: '背光模块', mainCat: '硬件类', sub: '背光模组' },
  { keywords: ['电源', '适配器', 'dc-dc', 'dcdc', '变压器', '电解电容', '电容', '电阻', '电感', 'mos', '整流', '二极管', '稳压', 'ic', '磁珠', '保险丝', 'pwm'], module: '电源模块', mainCat: '电源类', sub: '电源器件' },
  { keywords: ['scaler', 'tcon', '主控', '芯片', 'mcu', 'ddr', 'emmc', 'flash', '内存', '存储', '晶振', 'pcb', '主板', 'hub', 'wifi', '蓝牙', '处理器', 'soc', 'eprom', 'eeprom'], module: '驱动板模块', mainCat: '硬件类', sub: '驱动芯片' },
  { keywords: ['按键板', '按键', 'osd', '控制板', '触控'], module: '控制板模块', mainCat: '硬件类', sub: '控制板' },
  { keywords: ['hdmi', 'dp接口', 'type-c', 'typec', 'usb接口', 'vga', '母座', '连接器', '接口'], module: '接口模块', mainCat: '硬件类', sub: '接口' },
  { keywords: ['前框', '后壳', '底座', '立柱', '中框', '支架', '螺丝', '挂架', '外壳', '卡扣', '脚垫', '装饰条'], module: '结构件', mainCat: '结构类', sub: '结构件' },
  { keywords: ['外箱', '内卡', '珍珠棉', '泡沫', 'pe袋', '防静电袋', '说明书', '标签', '贴纸', '彩盒', '纸箱', '缓冲', '保修卡'], module: '包装材料', mainCat: '包材类', sub: '包材' },
  { keywords: ['hdmi线', 'dp线', '电源线', '排线', 'ffc', 'lvds', '线缆', '线材', 'usb线', 'type-c线'], module: '连接线材', mainCat: '线材类', sub: '线材' },
  { keywords: ['喇叭', '扬声器', '麦克风', '蜂鸣器', 'sound', 'audio'], module: '声学模块', mainCat: '硬件类', sub: '声学' },
  { keywords: ['散热片', '散热器', '风扇', '导热垫', '导热', '均热板'], module: '散热组件', mainCat: '结构类', sub: '散热' },
  { keywords: ['smt', '贴片加工', '组装', '测试费', '老化', '包装费', '加工费', '校准', 'dip', '烧录', '彩印'], module: '其他', mainCat: '加工费类', sub: '加工费' },
  { keywords: ['firmware', '固件', '软件', 'osd菜单', '驱动'], module: '控制板模块', mainCat: '软件类', sub: '软件' },
];

/** 用规则引擎判断器件归属模块（返回 null 表示规则未命中，交给 AI 或归"未归类"） */
export function classifyByModule(name: string): { module: string; mainCat: string; sub: string } | null {
  const n = (name || '').toLowerCase();
  for (const rule of MODULE_RULES) {
    for (const kw of rule.keywords) {
      if (n.includes(kw)) return { module: rule.module, mainCat: rule.mainCat, sub: rule.sub };
    }
  }
  return null;
}
