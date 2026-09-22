import * as XLSX from 'xlsx';

type TemplateConfig = {
  fileName: string;
  sheetName: string;
  headers: string[];
  sampleRows: Array<Array<string | number>>;
  guide: Array<[string, string]>;
};

function downloadTemplate({ fileName, sheetName, headers, sampleRows, guide }: TemplateConfig) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${sampleRows.length + 1}` };
  sheet['!cols'] = headers.map(header => ({ wch: Math.max(12, Math.min(26, header.length * 2 + 5)) }));
  headers.forEach((_, index) => {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: index })];
    if (cell) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '2F6FED' } }, alignment: { horizontal: 'center' } };
  });
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  const guideSheet = XLSX.utils.aoa_to_sheet([['字段', '填写说明'], ...guide]);
  guideSheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  guideSheet['!cols'] = [{ wch: 20 }, { wch: 76 }];
  XLSX.utils.book_append_sheet(book, guideSheet, '填写说明');
  XLSX.writeFile(book, fileName);
}

export function downloadPartsTemplate() {
  downloadTemplate({
    fileName: 'CostHub_器件库导入模板.xlsx', sheetName: '器件导入模板',
    headers: ['大类', '子类', '分类', '名称', '型号', '成本', '规格', '项目', '备注'],
    sampleRows: [['硬件类', '显示器件', '面板', '27英寸 QHD 高刷面板', 'BOE-NV270QHM-NY1', 610, '27英寸 / 2560×1440 / 165Hz / IPS', 'CM27QHD165-26', '供应商报价基准；导入后可补充价格历史']],
    guide: [['成本', '填写供应商报价单价，使用数字，不要带 ¥ 符号。'], ['项目', '填写项目代号；多个项目可用逗号分隔。'], ['名称+型号', '同名同型号会复用器件主档，建议保持供应商原文一致。'], ['规格', '写入可检索规格，便于后续物料洞察和报价匹配。']],
  });
}

export function downloadProjectBomTemplate() {
  downloadTemplate({
    fileName: 'CostHub_项目BOM导入模板.xlsx', sheetName: '项目BOM导入模板',
    headers: ['项目代号', '项目名称', '模块', '模块分类', '大类', '子类', '器件名称', '型号', '单价', '数量', '备注'],
    sampleRows: [['CM27QHD165-26', '27英寸 QHD 高刷办公显示器', '显示模块', '显示', '硬件类', '显示器件', '27英寸 QHD 高刷面板', 'BOE-NV270QHM-NY1', 610, 1, '来自华东视讯 R2 报价']],
    guide: [['项目代号', '留空时导入当前选中项目；填写新代号可自动创建项目。'], ['模块', '按功能拆分，例如显示模块、主控模块、电源模块、结构模块。'], ['单价/数量', '都必须是数字；单价为 0 的行会被拦截提示。'], ['模块分类', '可填写显示、主控、电源、结构、包装、制造等，便于项目分组。']],
  });
}

export function downloadSkuDiffTemplate() {
  downloadTemplate({
    fileName: 'CostHub_SKU变体导入模板.xlsx', sheetName: 'SKU差异导入模板',
    headers: ['模块', '器件名称', '型号', '单价', '数量'],
    sampleRows: [['结构模块', '商用固定支架', 'KOKU-STAND-FIX', 67, 1]],
    guide: [['导入目标', '进入项目 → BOM版本 → SKU变体，选择目标 SKU 后导入。'], ['同名同型号', '如果与基座 BOM 同名同型号，价格或数量变化会识别为“替换”。'], ['新增器件', '基座中不存在的名称+型号会作为该 SKU 的新增差异。'], ['单价/数量', '都必须是数字；导入预览会显示新增、替换、还原或跳过动作。']],
  });
}

export function downloadTenderTemplate() {
  downloadTemplate({
    fileName: 'CostHub_供应商报价导入模板.xlsx', sheetName: '供应商报价模板',
    headers: ['模块', '器件名称', '型号', '规格参数', '数量', '单价', '小计', '备注'],
    sampleRows: [['显示模块', '27英寸 QHD 高刷面板', 'BOE-NV270QHM-NY1', '27英寸 / 2560×1440 / 165Hz / IPS', 1, 610, 610, '未税一口价']],
    guide: [['文件名', '建议使用“供应商名_轮次_报价.xlsx”，系统会保留原文件名用于追溯。'], ['单价', '填写供应商对该行的未税单价；小计由数量×单价计算。'], ['小计', '仅用于人工核对，系统导入时按数量与单价重新计算。'], ['导入位置', '项目 → 招标工作台 → 导入报价，选择轮次并确认供应商名称。']],
  });
}

export function downloadCompetitorBomTemplate() {
  downloadTemplate({
    fileName: 'CostHub_竞品BOM导入模板.xlsx', sheetName: '竞品BOM导入模板',
    headers: ['模块', '器件名称', '型号', '我方名称', '我方型号', '我方成本', '我方数量', '竞品数量', '竞品单价', '竞品小计'],
    sampleRows: [['显示模块', '27英寸 QHD 面板', 'LM270WQA-SSA1', '27英寸 QHD 高刷面板', 'BOE-NV270QHM-NY1', 610, 1, 1, 585, 585]],
    guide: [['竞品单价', '填写竞品 BOM 估算单价，使用数字。'], ['我方字段', '可填写已知的我方对应物料，系统用于成本与配置映射。'], ['竞品小计', '用于人工核对，导入时按竞品数量×竞品单价保存。'], ['导入位置', '竞品管理 → 选择竞品 → 竞品 BOM → 导入。']],
  });
}

export function downloadVoiceTemplate() {
  downloadTemplate({
    fileName: 'CostHub_用户原声导入模板.xlsx', sheetName: '用户原声模板',
    headers: ['产品/项目', '平台', '内容', '采集日期'],
    sampleRows: [['CM27QHD165-26', '电商评价', '高刷拖影控制得不错，办公和轻度游戏都够用，但底座占桌面比较大。', '2026-08-18']],
    guide: [['产品/项目', '顶部选择对应项目代号后导入；当前版本以顶部选择为准。'], ['内容', '必填，系统优先读取“内容”列，再自动分块分析。'], ['平台', '可填写电商、售后、访谈、评测等来源，便于人工追溯。'], ['采集日期', '建议使用 YYYY-MM-DD；不会影响原声正文分析。']],
  });
}
