import Database from './db/sql';
import { invoke } from '@tauri-apps/api/core';

// 显示器真实成本估算数据（基于市场调研）

// ==================== 器件库数据 ====================
const partsData = [
  // 硬件类 - Scaler IC
  { main_category: '硬件类', sub_category: 'Scaler IC', category: '主控芯片', name: 'Scaler IC RTD2556', model: 'RTD2556T', cost: 35, specs: '4K@60Hz, HDR10, 2路HDMI 2.0', projects: '', remark: '主流4K scaler' },
  { main_category: '硬件类', sub_category: 'Scaler IC', category: '主控芯片', name: 'Scaler IC MST9002', model: 'MST9002X', cost: 25, specs: 'FHD@144Hz, FreeSync', projects: '', remark: '电竞 scaler' },
  { main_category: '硬件类', sub_category: 'Scaler IC', category: '主控芯片', name: 'Scaler IC TSUMC', model: 'TSUMC8-pxg', cost: 15, specs: 'FHD@60Hz, 基础功能', projects: '', remark: '入门级 scaler' },

  // 硬件类 - MCU
  { main_category: '硬件类', sub_category: 'MCU', category: '控制芯片', name: 'MCU STM32F103', model: 'STM32F103C8T6', cost: 8, specs: '72MHz, 64KB Flash', projects: '', remark: '按键/OSD控制' },
  { main_category: '硬件类', sub_category: 'MCU', category: '控制芯片', name: 'MCU STM32F407', model: 'STM32F407VGT6', cost: 15, specs: '168MHz, 1MB Flash', projects: '', remark: '高级控制+USB' },

  // 硬件类 - 电源管理IC
  { main_category: '硬件类', sub_category: '电源管理IC', category: '电源芯片', name: 'DC-DC XL1509', model: 'XL1509-5.0E1', cost: 2, specs: '5V 3A 输出', projects: '', remark: '降压模块' },
  { main_category: '硬件类', sub_category: '电源管理IC', category: '电源芯片', name: 'LDO AMS1117', model: 'AMS1117-3.3', cost: 1.5, specs: '3.3V 1A LDO', projects: '', remark: '低压差稳压' },
  { main_category: '硬件类', sub_category: '电源管理IC', category: '电源芯片', name: 'PMIC RT8207', model: 'RT8207MGQW', cost: 12, specs: '多路电源管理', projects: '', remark: '面板供电PMIC' },

  // 硬件类 - DDR
  { main_category: '硬件类', sub_category: 'DDR', category: '存储芯片', name: 'DDR3 256MB', model: 'EM68B16CWKG-25H', cost: 5, specs: '256MB DDR3-1600', projects: '', remark: ' scaler 缓存' },
  { main_category: '硬件类', sub_category: 'DDR', category: '存储芯片', name: 'DDR3 512MB', model: 'EM68B32CWKG-25H', cost: 8, specs: '512MB DDR3-1600', projects: '', remark: '4K scaler缓存' },

  // 硬件类 - 电容电阻
  { main_category: '硬件类', sub_category: '电容', category: '被动元件', name: 'MLCC 10uF', model: 'CL21A106KPFNNNE', cost: 0.15, specs: '10uF 10V X5R 0805', projects: '', remark: '滤波电容' },
  { main_category: '硬件类', sub_category: '电容', category: '被动元件', name: 'MLCC 100nF', model: 'CL21B104KBCNNNC', cost: 0.05, specs: '100nF 50V X7R 0805', projects: '', remark: '去耦电容' },
  { main_category: '硬件类', sub_category: '电阻', category: '被动元件', name: '电阻 10K', model: 'RC0805FR-0710KL', cost: 0.02, specs: '10KΩ 1% 0805', projects: '', remark: '通用电阻' },

  // 硬件类 - 接口芯片
  { main_category: '硬件类', sub_category: 'HDMI接口', category: '接口芯片', name: 'HDMI Redriver', model: 'PI3HDX12212', cost: 8, specs: 'HDMI 2.0信号增强', projects: '', remark: '长距离传输' },
  { main_category: '硬件类', sub_category: 'Type-C接口', category: '接口芯片', name: 'USB-C Controller', model: 'HD3SS460', cost: 12, specs: 'USB 3.1 Gen2 Alt Mode', projects: '', remark: 'Type-C多协议' },
  { main_category: '硬件类', sub_category: 'USB Hub', category: '接口芯片', name: 'USB Hub GL852', model: 'GL852G-12', cost: 5, specs: '4口USB 2.0 Hub', projects: '', remark: 'USB扩展' },

  // 结构类 - 前框
  { main_category: '结构类', sub_category: '前框', category: '外壳件', name: '前框 ABS 23.8"', model: 'FB-238-ABS-01', cost: 45, specs: 'ABS注塑, 黑色哑光', projects: '', remark: '入门级前框' },
  { main_category: '结构类', sub_category: '前框', category: '外壳件', name: '前框 ABS 27"', model: 'FB-270-ABS-01', cost: 65, specs: 'ABS注塑, 黑色哑光', projects: '', remark: '27寸标准框' },
  { main_category: '结构类', sub_category: '前框', category: '外壳件', name: '前框 铝合金 27"', model: 'FB-270-AL-01', cost: 120, specs: '铝合金 CNC, 银色', projects: '', remark: '高端金属框' },

  // 结构类 - 后壳
  { main_category: '结构类', sub_category: '后壳', category: '外壳件', name: '后壳 ABS 23.8"', model: 'BB-238-ABS-01', cost: 35, specs: 'ABS注塑, 散热孔', projects: '', remark: '标准后壳' },
  { main_category: '结构类', sub_category: '后壳', category: '外壳件', name: '后壳 ABS 27"', model: 'BB-270-ABS-01', cost: 50, specs: 'ABS注塑, 散热孔', projects: '', remark: '27寸后壳' },

  // 结构类 - 底座
  { main_category: '结构类', sub_category: '底座', category: '支架件', name: '底座 ABS圆形', model: 'BS-ABS-R01', cost: 15, specs: 'ABS圆形底座, 直径180mm', projects: '', remark: '入门底座' },
  { main_category: '结构类', sub_category: '底座', category: '支架件', name: '底座 铝合金V型', model: 'BS-AL-V01', cost: 45, specs: '铝合金V型底座', projects: '', remark: '中高端底座' },

  // 结构类 - 立柱
  { main_category: '结构类', sub_category: '立柱', category: '支架件', name: '立柱 ABS固定', model: 'ST-ABS-FIX', cost: 10, specs: 'ABS固定立柱', projects: '', remark: '入门固定支架' },
  { main_category: '结构类', sub_category: '立柱', category: '支架件', name: '立柱 金属升降', model: 'ST-AL-ADJ', cost: 35, specs: '金属升降立柱, 0-130mm', projects: '', remark: '升降旋转支架' },

  // 电源类 - 电源适配器
  { main_category: '电源类', sub_category: '电源适配器', category: '外置电源', name: 'Adapter 12V 2A', model: 'AD-12V2A-01', cost: 18, specs: '12V 2A 24W 外置', projects: '', remark: '入门电源适配器' },
  { main_category: '电源类', sub_category: '电源适配器', category: '外置电源', name: 'Adapter 12V 4A', model: 'AD-12V4A-01', cost: 28, specs: '12V 4A 48W 外置', projects: '', remark: '中端电源适配器' },
  { main_category: '电源类', sub_category: '电源适配器', category: '外置电源', name: 'Adapter 19V 4.74A', model: 'AD-19V4.74A', cost: 45, specs: '19V 4.74A 90W 外置', projects: '', remark: '高端大功率适配器' },

  // 电源类 - 内置电源板
  { main_category: '电源类', sub_category: '内置电源板', category: '内置电源', name: '内置电源板 60W', model: 'IPB-60W-01', cost: 35, specs: 'AC/DC 60W 内置板', projects: '', remark: '小尺寸内置电源' },
  { main_category: '电源类', sub_category: '内置电源板', category: '内置电源', name: '内置电源板 120W', model: 'IPB-120W-01', cost: 55, specs: 'AC/DC 120W 内置板', projects: '', remark: '大尺寸内置电源' },

  // 线材类 - HDMI线
  { main_category: '线材类', sub_category: 'HDMI线', category: '信号线', name: 'HDMI线 1.5m 标准', model: 'HC-STD-1.5M', cost: 8, specs: 'HDMI 1.4 1.5米', projects: '', remark: '标准HDMI线' },
  { main_category: '线材类', sub_category: 'HDMI线', category: '信号线', name: 'HDMI线 1.8m 高速', model: 'HC-HS-1.8M', cost: 15, specs: 'HDMI 2.0 1.8米编织', projects: '', remark: '高速编织线' },

  // 线材类 - 电源线
  { main_category: '线材类', sub_category: '电源线', category: '电源线', name: '电源线 1.5m', model: 'PC-1.5M-01', cost: 3, specs: 'AC电源线 1.5米 国标', projects: '', remark: '标准电源线' },

  // 线材类 - 内部连接线
  { main_category: '线材类', sub_category: '内部连接线', category: '内部线', name: 'LVDS排线 30pin', model: 'LVDS-30P-200MM', cost: 2.5, specs: 'LVDS 30pin 200mm', projects: '', remark: '面板连接线' },
  { main_category: '线材类', sub_category: '内部连接线', category: '内部线', name: 'FFC排线 6pin', model: 'FFC-6P-150MM', cost: 1, specs: 'FFC 6pin 150mm', projects: '', remark: '按键板连接' },

  // 包材类 - 外箱
  { main_category: '包材类', sub_category: '外箱', category: '包装材料', name: '外箱 23.8" 五层', model: 'CB-238-5L', cost: 12, specs: '五层瓦楞纸箱 580×420×150mm', projects: '', remark: '标准外箱' },
  { main_category: '包材类', sub_category: '外箱', category: '包装材料', name: '外箱 27" 五层', model: 'CB-270-5L', cost: 18, specs: '五层瓦楞纸箱 680×480×170mm', projects: '', remark: '27寸外箱' },

  // 包材类 - 内卡/缓冲材
  { main_category: '包材类', sub_category: '内卡/缓冲材', category: '包装材料', name: 'EPE内卡 23.8"', model: 'EPE-238-01', cost: 5, specs: 'EPE珍珠棉内卡', projects: '', remark: '缓冲保护' },
  { main_category: '包材类', sub_category: '内卡/缓冲材', category: '包装材料', name: 'EPE内卡 27"', model: 'EPE-270-01', cost: 8, specs: 'EPE珍珠棉内卡', projects: '', remark: '27寸缓冲' },

  // 包材类 - 说明书
  { main_category: '包材类', sub_category: '说明书', category: '印刷品', name: '说明书 中文', model: 'MAN-CN-A4', cost: 2, specs: 'A4 4页黑白印刷', projects: '', remark: '用户手册' },
  { main_category: '包材类', sub_category: '说明书', category: '印刷品', name: '说明书 多语言', model: 'MAN-ML-A4', cost: 4, specs: 'A4 8页彩色印刷', projects: '', remark: '高端多语言手册' },

  // 加工费类 - SMT贴片
  { main_category: '加工费类', sub_category: 'SMT贴片', category: '加工服务', name: 'SMT贴片 驱动板', model: 'SMT-DRV-01', cost: 15, specs: '驱动板SMT贴片费', projects: '', remark: '单板SMT费用' },
  { main_category: '加工费类', sub_category: 'SMT贴片', category: '加工服务', name: 'SMT贴片 电源板', model: 'SMT-PWR-01', cost: 8, specs: '电源板SMT贴片费', projects: '', remark: '电源板SMT费用' },

  // 加工费类 - 组装费
  { main_category: '加工费类', sub_category: '组装费', category: '加工服务', name: '组装费 标准款', model: 'ASM-STD-01', cost: 20, specs: '整机组装测试', projects: '', remark: '标准组装费' },
  { main_category: '加工费类', sub_category: '组装费', category: '加工服务', name: '组装费 高端款', model: 'ASM-ADV-01', cost: 35, specs: '整机组装+校准', projects: '', remark: '高端组装含校准' },

  // 软件类 - Firmware
  { main_category: '软件类', sub_category: 'Firmware', category: '软件成本', name: 'Scaler Firmware', model: 'FW-SCALER-01', cost: 3, specs: 'Scaler固件开发摊销', projects: '', remark: '固件摊销成本' },
  { main_category: '软件类', sub_category: 'OSD菜单', category: '软件成本', name: 'OSD菜单设计', model: 'OSD-DESIGN-01', cost: 2, specs: 'OSD界面设计摊销', projects: '', remark: 'UI设计摊销' },

  // 其他 - 面板（最大成本项）
  { main_category: '其他', sub_category: '面板', category: '核心部件', name: '面板 IPS 23.8" FHD', model: 'PN-238-IPS-FHD', cost: 280, specs: 'IPS 23.8" 1920×1080 60Hz', projects: '', remark: '入门IPS面板' },
  { main_category: '其他', sub_category: '面板', category: '核心部件', name: '面板 IPS 23.8" FHD 144Hz', model: 'PN-238-IPS-144', cost: 350, specs: 'IPS 23.8" 1920×1080 144Hz', projects: '', remark: '电竞IPS面板' },
  { main_category: '其他', sub_category: '面板', category: '核心部件', name: '面板 IPS 27" QHD 144Hz', model: 'PN-270-IPS-QHD144', cost: 480, specs: 'IPS 27" 2560×1440 144Hz', projects: '', remark: '中高端电竞面板' },
  { main_category: '其他', sub_category: '面板', category: '核心部件', name: '面板 IPS 27" 4K 60Hz', model: 'PN-270-IPS-4K60', cost: 550, specs: 'IPS 27" 3840×2160 60Hz', projects: '', remark: '高端4K面板' },
  { main_category: '其他', sub_category: '面板', category: '核心部件', name: '面板 VA 32" 4K 144Hz', model: 'PN-320-VA-4K144', cost: 650, specs: 'VA 32" 3840×2160 144Hz', projects: '', remark: '旗舰电竞面板' },

  // 其他 - 辅料
  { main_category: '其他', sub_category: '辅料', category: '辅助材料', name: '螺丝包', model: 'SCREW-PACK-01', cost: 2, specs: 'M3/M4螺丝包', projects: '', remark: '固定螺丝' },
  { main_category: '其他', sub_category: '辅料', category: '辅助材料', name: '导热硅脂', model: 'TG-01', cost: 1, specs: '导热硅脂 5g', projects: '', remark: '散热用' },
];

// ==================== 项目数据 ====================
const projectsData = [
  { code: 'MNT-2401', name: '23.8寸入门办公显示器', project_type: '在研', tier: '入门级', status: '进行中', screen_size: '23.8"', resolution: '1920×1080 (FHD)', refresh_rate: '60Hz', panel_type: 'IPS', platform_fee_rate: 5, profit_rate: 10 },
  { code: 'MNT-2402', name: '23.8寸电竞显示器', project_type: '在研', tier: '主流级', status: '进行中', screen_size: '23.8"', resolution: '1920×1080 (FHD)', refresh_rate: '144Hz', panel_type: 'IPS', platform_fee_rate: 5, profit_rate: 15 },
  { code: 'MNT-2701', name: '27寸主流办公显示器', project_type: '在研', tier: '主流级', status: '已完成', screen_size: '27"', resolution: '1920×1080 (FHD)', refresh_rate: '75Hz', panel_type: 'IPS', platform_fee_rate: 5, profit_rate: 12 },
  { code: 'MNT-2702', name: '27寸2K电竞显示器', project_type: '在研', tier: '中高端', status: '进行中', screen_size: '27"', resolution: '2560×1440 (QHD)', refresh_rate: '144Hz', panel_type: 'IPS', platform_fee_rate: 8, profit_rate: 20 },
  { code: 'MNT-2703', name: '27寸4K专业显示器', project_type: '已完成', tier: '高端', status: '已完成', screen_size: '27"', resolution: '3840×2160 (4K UHD)', refresh_rate: '60Hz', panel_type: 'IPS', platform_fee_rate: 10, profit_rate: 25 },
  { code: 'MNT-3201', name: '32寸4K旗舰电竞显示器', project_type: '在研', tier: '旗舰级', status: '进行中', screen_size: '32"', resolution: '3840×2160 (4K UHD)', refresh_rate: '144Hz', panel_type: 'VA', platform_fee_rate: 12, profit_rate: 30 },
];

// ==================== 竞品数据 ====================
const competitorsData = [
  { brand: 'Dell', model: 'P2419H', tier: '主流级', market_price: 1199, bom_cost: 0, platform_fee_rate: 5, remark: '戴尔主流23.8寸办公显示器' },
  { brand: 'AOC', model: '24G2', tier: '主流级', market_price: 999, bom_cost: 0, platform_fee_rate: 5, remark: 'AOC电竞144Hz显示器' },
  { brand: 'LG', model: '27UK850', tier: '高端', market_price: 3999, bom_cost: 0, platform_fee_rate: 10, remark: 'LG 27寸4K HDR显示器' },
  { brand: 'ASUS', model: 'VG27AQ', tier: '中高端', market_price: 2499, bom_cost: 0, platform_fee_rate: 8, remark: '华硕2K电竞显示器' },
  { brand: 'BenQ', model: 'EW3270U', tier: '旗舰级', market_price: 5999, bom_cost: 0, platform_fee_rate: 12, remark: '明基32寸4K HDR显示器' },
];

async function seedTestData() {
  const dbUrl = await invoke<string>('get_db_path');
  const db = await Database.load(dbUrl);

  console.log('开始插入测试数据...');

  // 插入器件数据
  for (const part of partsData) {
    await db.execute(
      `INSERT INTO parts (main_category, sub_category, category, name, model, cost, specs, projects, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [part.main_category, part.sub_category, part.category, part.name, part.model, part.cost, part.specs, part.projects, part.remark]
    );
  }
  console.log(`✅ 已插入 ${partsData.length} 个器件`);

  // 插入项目数据
  for (const proj of projectsData) {
    await db.execute(
      `INSERT INTO projects (code, name, project_type, tier, status, screen_size, resolution, refresh_rate, panel_type, platform_fee_rate, profit_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [proj.code, proj.name, proj.project_type, proj.tier, proj.status, proj.screen_size, proj.resolution, proj.refresh_rate, proj.panel_type, proj.platform_fee_rate, proj.profit_rate]
    );
  }
  console.log(`✅ 已插入 ${projectsData.length} 个项目`);

  // 插入竞品数据
  for (const comp of competitorsData) {
    await db.execute(
      `INSERT INTO competitors (brand, model, tier, market_price, platform_fee_rate, remark) VALUES (?, ?, ?, ?, ?, ?)`,
      [comp.brand, comp.model, comp.tier, comp.market_price, comp.platform_fee_rate, comp.remark]
    );
  }
  console.log(`✅ 已插入 ${competitorsData.length} 个竞品`);

  // 为每个项目创建BOM
  const projectBOMs = [
    // MNT-2401 入门23.8寸
    { project_code: 'MNT-2401', items: [
      { part_name: '面板 IPS 23.8" FHD', quantity: 1, module_name: '核心部件' },
      { part_name: 'Scaler IC TSUMC', quantity: 1, module_name: '驱动板' },
      { part_name: 'MCU STM32F103', quantity: 1, module_name: '驱动板' },
      { part_name: 'DDR3 256MB', quantity: 1, module_name: '驱动板' },
      { part_name: '电源管理IC RT8207', quantity: 1, module_name: '驱动板' },
      { part_name: '前框 ABS 23.8"', quantity: 1, module_name: '结构件' },
      { part_name: '后壳 ABS 23.8"', quantity: 1, module_name: '结构件' },
      { part_name: '底座 ABS圆形', quantity: 1, module_name: '结构件' },
      { part_name: '立柱 ABS固定', quantity: 1, module_name: '结构件' },
      { part_name: 'Adapter 12V 2A', quantity: 1, module_name: '电源' },
      { part_name: 'HDMI线 1.5m 标准', quantity: 1, module_name: '配件' },
      { part_name: '电源线 1.5m', quantity: 1, module_name: '配件' },
      { part_name: '外箱 23.8" 五层', quantity: 1, module_name: '包材' },
      { part_name: 'EPE内卡 23.8"', quantity: 1, module_name: '包材' },
      { part_name: '说明书 中文', quantity: 1, module_name: '包材' },
      { part_name: 'SMT贴片 驱动板', quantity: 1, module_name: '加工费' },
      { part_name: '组装费 标准款', quantity: 1, module_name: '加工费' },
      { part_name: 'Scaler Firmware', quantity: 1, module_name: '软件' },
    ]},

    // MNT-2402 电竞23.8寸
    { project_code: 'MNT-2402', items: [
      { part_name: '面板 IPS 23.8" FHD 144Hz', quantity: 1, module_name: '核心部件' },
      { part_name: 'Scaler IC MST9002', quantity: 1, module_name: '驱动板' },
      { part_name: 'MCU STM32F407', quantity: 1, module_name: '驱动板' },
      { part_name: 'DDR3 512MB', quantity: 2, module_name: '驱动板' },
      { part_name: '电源管理IC RT8207', quantity: 1, module_name: '驱动板' },
      { part_name: '前框 ABS 23.8"', quantity: 1, module_name: '结构件' },
      { part_name: '后壳 ABS 23.8"', quantity: 1, module_name: '结构件' },
      { part_name: '底座 铝合金V型', quantity: 1, module_name: '结构件' },
      { part_name: '立柱 金属升降', quantity: 1, module_name: '结构件' },
      { part_name: 'Adapter 12V 4A', quantity: 1, module_name: '电源' },
      { part_name: 'HDMI线 1.8m 高速', quantity: 1, module_name: '配件' },
      { part_name: '电源线 1.5m', quantity: 1, module_name: '配件' },
      { part_name: '外箱 23.8" 五层', quantity: 1, module_name: '包材' },
      { part_name: 'EPE内卡 23.8"', quantity: 1, module_name: '包材' },
      { part_name: '说明书 多语言', quantity: 1, module_name: '包材' },
      { part_name: 'SMT贴片 驱动板', quantity: 1, module_name: '加工费' },
      { part_name: '组装费 高端款', quantity: 1, module_name: '加工费' },
    ]},

    // MNT-2701 27寸主流
    { project_code: 'MNT-2701', items: [
      { part_name: '面板 IPS 23.8" FHD', quantity: 1, module_name: '核心部件' },
      { part_name: 'Scaler IC RTD2556', quantity: 1, module_name: '驱动板' },
      { part_name: 'MCU STM32F103', quantity: 1, module_name: '驱动板' },
      { part_name: 'DDR3 512MB', quantity: 1, module_name: '驱动板' },
      { part_name: '电源管理IC RT8207', quantity: 1, module_name: '驱动板' },
      { part_name: '前框 ABS 27"', quantity: 1, module_name: '结构件' },
      { part_name: '后壳 ABS 27"', quantity: 1, module_name: '结构件' },
      { part_name: '底座 ABS圆形', quantity: 1, module_name: '结构件' },
      { part_name: '立柱 ABS固定', quantity: 1, module_name: '结构件' },
      { part_name: 'Adapter 12V 4A', quantity: 1, module_name: '电源' },
      { part_name: 'HDMI线 1.5m 标准', quantity: 1, module_name: '配件' },
      { part_name: '电源线 1.5m', quantity: 1, module_name: '配件' },
      { part_name: '外箱 27" 五层', quantity: 1, module_name: '包材' },
      { part_name: 'EPE内卡 27"', quantity: 1, module_name: '包材' },
      { part_name: '说明书 中文', quantity: 1, module_name: '包材' },
      { part_name: 'SMT贴片 驱动板', quantity: 1, module_name: '加工费' },
      { part_name: '组装费 标准款', quantity: 1, module_name: '加工费' },
    ]},

    // MNT-2702 27寸2K电竞
    { project_code: 'MNT-2702', items: [
      { part_name: '面板 IPS 27" QHD 144Hz', quantity: 1, module_name: '核心部件' },
      { part_name: 'Scaler IC MST9002', quantity: 1, module_name: '驱动板' },
      { part_name: 'MCU STM32F407', quantity: 1, module_name: '驱动板' },
      { part_name: 'DDR3 512MB', quantity: 2, module_name: '驱动板' },
      { part_name: '电源管理IC RT8207', quantity: 1, module_name: '驱动板' },
      { part_name: 'HDMI Redriver', quantity: 2, module_name: '驱动板' },
      { part_name: '前框 铝合金 27"', quantity: 1, module_name: '结构件' },
      { part_name: '后壳 ABS 27"', quantity: 1, module_name: '结构件' },
      { part_name: '底座 铝合金V型', quantity: 1, module_name: '结构件' },
      { part_name: '立柱 金属升降', quantity: 1, module_name: '结构件' },
      { part_name: 'Adapter 19V 4.74A', quantity: 1, module_name: '电源' },
      { part_name: 'HDMI线 1.8m 高速', quantity: 2, module_name: '配件' },
      { part_name: '电源线 1.5m', quantity: 1, module_name: '配件' },
      { part_name: '外箱 27" 五层', quantity: 1, module_name: '包材' },
      { part_name: 'EPE内卡 27"', quantity: 1, module_name: '包材' },
      { part_name: '说明书 多语言', quantity: 1, module_name: '包材' },
      { part_name: 'SMT贴片 驱动板', quantity: 1, module_name: '加工费' },
      { part_name: '组装费 高端款', quantity: 1, module_name: '加工费' },
    ]},

    // MNT-2703 27寸4K专业
    { project_code: 'MNT-2703', items: [
      { part_name: '面板 IPS 27" 4K 60Hz', quantity: 1, module_name: '核心部件' },
      { part_name: 'Scaler IC RTD2556', quantity: 1, module_name: '驱动板' },
      { part_name: 'MCU STM32F407', quantity: 1, module_name: '驱动板' },
      { part_name: 'DDR3 512MB', quantity: 4, module_name: '驱动板' },
      { part_name: '电源管理IC RT8207', quantity: 1, module_name: '驱动板' },
      { part_name: 'HDMI Redriver', quantity: 2, module_name: '驱动板' },
      { part_name: 'Type-C接口芯片', quantity: 1, module_name: '驱动板' },
      { part_name: '前框 铝合金 27"', quantity: 1, module_name: '结构件' },
      { part_name: '后壳 ABS 27"', quantity: 1, module_name: '结构件' },
      { part_name: '底座 铝合金V型', quantity: 1, module_name: '结构件' },
      { part_name: '立柱 金属升降', quantity: 1, module_name: '结构件' },
      { part_name: '内置电源板 120W', quantity: 1, module_name: '电源' },
      { part_name: 'HDMI线 1.8m 高速', quantity: 2, module_name: '配件' },
      { part_name: '电源线 1.5m', quantity: 1, module_name: '配件' },
      { part_name: '外箱 27" 五层', quantity: 1, module_name: '包材' },
      { part_name: 'EPE内卡 27"', quantity: 1, module_name: '包材' },
      { part_name: '说明书 多语言', quantity: 1, module_name: '包材' },
      { part_name: 'SMT贴片 驱动板', quantity: 1, module_name: '加工费' },
      { part_name: '组装费 高端款', quantity: 1, module_name: '加工费' },
    ]},

    // MNT-3201 32寸旗舰电竞
    { project_code: 'MNT-3201', items: [
      { part_name: '面板 VA 32" 4K 144Hz', quantity: 1, module_name: '核心部件' },
      { part_name: 'Scaler IC RTD2556', quantity: 1, module_name: '驱动板' },
      { part_name: 'MCU STM32F407', quantity: 1, module_name: '驱动板' },
      { part_name: 'DDR3 512MB', quantity: 8, module_name: '驱动板' },
      { part_name: '电源管理IC RT8207', quantity: 2, module_name: '驱动板' },
      { part_name: 'HDMI Redriver', quantity: 4, module_name: '驱动板' },
      { part_name: 'Type-C接口芯片', quantity: 1, module_name: '驱动板' },
      { part_name: 'USB Hub GL852', quantity: 1, module_name: '驱动板' },
      { part_name: '前框 铝合金 27"', quantity: 1, module_name: '结构件' },
      { part_name: '后壳 ABS 27"', quantity: 1, module_name: '结构件' },
      { part_name: '底座 铝合金V型', quantity: 1, module_name: '结构件' },
      { part_name: '立柱 金属升降', quantity: 1, module_name: '结构件' },
      { part_name: '内置电源板 120W', quantity: 1, module_name: '电源' },
      { part_name: 'HDMI线 1.8m 高速', quantity: 3, module_name: '配件' },
      { part_name: '电源线 1.5m', quantity: 1, module_name: '配件' },
      { part_name: '外箱 27" 五层', quantity: 1, module_name: '包材' },
      { part_name: 'EPE内卡 27"', quantity: 1, module_name: '包材' },
      { part_name: '说明书 多语言', quantity: 1, module_name: '包材' },
      { part_name: 'SMT贴片 驱动板', quantity: 1, module_name: '加工费' },
      { part_name: '组装费 高端款', quantity: 1, module_name: '加工费' },
    ]},
  ];

  // 插入项目BOM
  for (const bom of projectBOMs) {
    const projectId = await db.select<{ id: number }[]>(`SELECT id FROM projects WHERE code = ?`, [bom.project_code]);
    if (projectId[0]) {
      for (const item of bom.items) {
        const partId = await db.select<{ id: number }[]>(`SELECT id FROM parts WHERE name = ?`, [item.part_name]);
        if (partId[0]) {
          await db.execute(
            `INSERT INTO project_boms (project_id, part_id, module_name, quantity) VALUES (?, ?, ?, ?)`,
            [projectId[0].id, partId[0].id, item.module_name, item.quantity]
          );
        }
      }
    }
  }
  console.log(`✅ 已插入 ${projectBOMs.length} 个项目的BOM数据`);

  // ==================== 插入模块库数据 ====================
  // 创建一些标准模块（独立于项目，可复用）

  // 首先为第一个项目（MNT-2401）创建模块定义
  const project1Id = await db.select<{ id: number }[]>(`SELECT id FROM projects WHERE code = 'MNT-2401'`);
  if (project1Id[0]) {
    // 创建电源模块
    await db.execute(
      `INSERT INTO modules (project_id, name, description) VALUES (?, ?, ?)`,
      [project1Id[0].id, '标准电源模块', '适用于入门级23.8寸显示器，12V 2A电源方案']
    );
    const powerModuleId = await db.select<{ id: number }[]>(`SELECT id FROM modules WHERE name = '标准电源模块' AND project_id = ?`, [project1Id[0].id]);

    // 创建驱动板模块
    await db.execute(
      `INSERT INTO modules (project_id, name, description) VALUES (?, ?, ?)`,
      [project1Id[0].id, '入门驱动板模块', '入门级Scaler方案，TSUMC+STM32F103']
    );
    const driverModuleId = await db.select<{ id: number }[]>(`SELECT id FROM modules WHERE name = '入门驱动板模块' AND project_id = ?`, [project1Id[0].id]);

    // 创建按键板模块
    await db.execute(
      `INSERT INTO modules (project_id, name, description) VALUES (?, ?, ?)`,
      [project1Id[0].id, '标准按键板模块', 'OSD菜单按键控制板']
    );
    const keyModuleId = await db.select<{ id: number }[]>(`SELECT id FROM modules WHERE name = '标准按键板模块' AND project_id = ?`, [project1Id[0].id]);

    // 为电源模块添加器件项
    if (powerModuleId[0]) {
      const adapterPart = await db.select<{ id: number; cost: number }[]>(`SELECT id, cost FROM parts WHERE name = 'Adapter 12V 2A'`);
      const powerCordPart = await db.select<{ id: number; cost: number }[]>(`SELECT id, cost FROM parts WHERE name = '电源线 1.5m'`);
      if (adapterPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [powerModuleId[0].id, adapterPart[0].id, 'Adapter 12V 2A', 'AD-12V2A-01', '电源类', '电源适配器', adapterPart[0].cost, 1]
        );
      }
      if (powerCordPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [powerModuleId[0].id, powerCordPart[0].id, '电源线 1.5m', 'PC-1.5M-01', '线材类', '电源线', powerCordPart[0].cost, 1]
        );
      }
    }

    // 为驱动板模块添加器件项
    if (driverModuleId[0]) {
      const scalerPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = 'Scaler IC TSUMC'`);
      const mcuPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = 'MCU STM32F103'`);
      const ddrPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = 'DDR3 256MB'`);
      const pmicPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = '电源管理IC RT8207'`);

      if (scalerPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId[0].id, scalerPart[0].id, 'Scaler IC TSUMC', scalerPart[0].model, '硬件类', 'Scaler IC', scalerPart[0].cost, 1]
        );
      }
      if (mcuPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId[0].id, mcuPart[0].id, 'MCU STM32F103', mcuPart[0].model, '硬件类', 'MCU', mcuPart[0].cost, 1]
        );
      }
      if (ddrPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId[0].id, ddrPart[0].id, 'DDR3 256MB', ddrPart[0].model, '硬件类', 'DDR', ddrPart[0].cost, 1]
        );
      }
      if (pmicPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId[0].id, pmicPart[0].id, '电源管理IC RT8207', pmicPart[0].model, '硬件类', '电源管理IC', pmicPart[0].cost, 1]
        );
      }
    }

    // 为按键板模块添加器件项
    if (keyModuleId[0]) {
      // 添加一些按键相关器件
      const mcuPart = await db.select<{ id: number; cost: number }[]>(`SELECT id, cost FROM parts WHERE name = 'MCU STM32F103'`);
      if (mcuPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [keyModuleId[0].id, mcuPart[0].id, 'MCU STM32F103', 'STM32F103C8T6', '硬件类', 'MCU', mcuPart[0].cost, 1]
        );
      }
      // 添加FFC排线
      const ffcPart = await db.select<{ id: number; cost: number }[]>(`SELECT id, cost FROM parts WHERE name = 'FFC排线 6pin'`);
      if (ffcPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [keyModuleId[0].id, ffcPart[0].id, 'FFC排线 6pin', 'FFC-6P-150MM', '线材类', '内部连接线', ffcPart[0].cost, 2]
        );
      }
    }
  }

  // 为第二个项目（MNT-2402电竞版）创建模块
  const project2Id = await db.select<{ id: number }[]>(`SELECT id FROM projects WHERE code = 'MNT-2402'`);
  if (project2Id[0]) {
    // 创建电竞电源模块
    await db.execute(
      `INSERT INTO modules (project_id, name, description) VALUES (?, ?, ?)`,
      [project2Id[0].id, '电竞电源模块', '适用于电竞显示器，12V 4A大功率电源方案']
    );
    const powerModuleId2 = await db.select<{ id: number }[]>(`SELECT id FROM modules WHERE name = '电竞电源模块' AND project_id = ?`, [project2Id[0].id]);

    // 创建电竞驱动板模块
    await db.execute(
      `INSERT INTO modules (project_id, name, description) VALUES (?, ?, ?)`,
      [project2Id[0].id, '电竞驱动板模块', '电竞Scaler方案，MST9002+STM32F407+双DDR']
    );
    const driverModuleId2 = await db.select<{ id: number }[]>(`SELECT id FROM modules WHERE name = '电竞驱动板模块' AND project_id = ?`, [project2Id[0].id]);

    // 为电源模块添加器件
    if (powerModuleId2[0]) {
      const adapterPart = await db.select<{ id: number; cost: number }[]>(`SELECT id, cost FROM parts WHERE name = 'Adapter 12V 4A'`);
      const powerCordPart = await db.select<{ id: number; cost: number }[]>(`SELECT id, cost FROM parts WHERE name = '电源线 1.5m'`);
      if (adapterPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [powerModuleId2[0].id, adapterPart[0].id, 'Adapter 12V 4A', 'AD-12V4A-01', '电源类', '电源适配器', adapterPart[0].cost, 1]
        );
      }
      if (powerCordPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [powerModuleId2[0].id, powerCordPart[0].id, '电源线 1.5m', 'PC-1.5M-01', '线材类', '电源线', powerCordPart[0].cost, 1]
        );
      }
    }

    // 为电竞驱动板模块添加器件
    if (driverModuleId2[0]) {
      const scalerPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = 'Scaler IC MST9002'`);
      const mcuPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = 'MCU STM32F407'`);
      const ddrPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = 'DDR3 512MB'`);
      const pmicPart = await db.select<{ id: number; cost: number; model: string }[]>(`SELECT id, cost, model FROM parts WHERE name = '电源管理IC RT8207'`);

      if (scalerPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId2[0].id, scalerPart[0].id, 'Scaler IC MST9002', scalerPart[0].model, '硬件类', 'Scaler IC', scalerPart[0].cost, 1]
        );
      }
      if (mcuPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId2[0].id, mcuPart[0].id, 'MCU STM32F407', mcuPart[0].model, '硬件类', 'MCU', mcuPart[0].cost, 1]
        );
      }
      if (ddrPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId2[0].id, ddrPart[0].id, 'DDR3 512MB', ddrPart[0].model, '硬件类', 'DDR', ddrPart[0].cost, 2]  // 电竞需要双DDR
        );
      }
      if (pmicPart[0]) {
        await db.execute(
          `INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [driverModuleId2[0].id, pmicPart[0].id, '电源管理IC RT8207', pmicPart[0].model, '硬件类', '电源管理IC', pmicPart[0].cost, 1]
        );
      }
    }
  }

  console.log('✅ 已插入模块库数据（约6个模块，包含多个器件项）');

  console.log('🎉 测试数据插入完成！');
}

// 导出函数供调用
export { seedTestData };
