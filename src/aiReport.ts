// AI 报告/Excel 生成（v2.3.19，2026-08-18 用户：AI 能生成 PPT 报告/HTML 报告/处理 Excel）
// 纯函数：HTML 报告 / PPTX 演示 / Excel 工作簿 → base64（前端交给 Rust 写入 AI 工作文件夹）
import * as XLSX from 'xlsx';
import pptxgen from 'pptxgenjs';

export interface ReportSlide { heading: string; points: string[]; }

function esc(s: any): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** HTML 报告（v2 视觉：骨色底+卡片+墨色，可直接打印/另存） */
export function buildHtmlReportBase64(title: string, slides: ReportSlide[], subtitle = ''): string {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
  body{font-family:"Microsoft YaHei","Segoe UI",-apple-system,sans-serif;background:#F4F3EE;color:#181713;margin:0;padding:44px 52px;line-height:1.75;-webkit-font-smoothing:antialiased}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
  .sub{color:#9A978B;font-size:12px;margin-bottom:30px}
  .card{background:#FFFFFF;border:1px solid #E6E4DC;border-radius:12px;padding:18px 24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(24,23,19,.04)}
  h2{font-size:16px;margin:0 0 12px;border-left:4px solid #C0392B;padding-left:10px}
  ul{margin:0;padding-left:20px}
  li{font-size:13.5px;color:#2B2925;margin-bottom:7px}
  .mono{font-family:"Cascadia Mono",Consolas,monospace}
  footer{margin-top:26px;color:#9A978B;font-size:11px;text-align:right}
  @media print{body{padding:20px}}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${esc(subtitle || 'CostHub · 本地 AI 生成报告')} · ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>
${(slides || []).map(s => '<div class="card"><h2>' + esc(s.heading) + '</h2><ul>' + (s.points || []).map((p: any) => '<li>' + esc(p) + '</li>').join('') + '</ul></div>').join('')}
<footer>由本地模型基于系统数据分析生成</footer>
</body></html>`;
  return btoa(unescape(encodeURIComponent(html)));
}

/** PPTX 演示（pptxgenjs，16:9，墨蓝+金，与 DemoGenerator 同风格） */
export async function buildPptxBase64(title: string, slides: ReportSlide[], subtitle = ''): Promise<string> {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'W16', width: 13.333, height: 7.5 });
  pptx.layout = 'W16';
  pptx.author = 'CostHub';
  pptx.title = title;
  const cover = pptx.addSlide();
  cover.background = { color: '1E3A6E' };
  cover.addText(title, { x: 0.8, y: 2.1, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Microsoft YaHei' });
  if (subtitle) cover.addText(subtitle, { x: 0.8, y: 3.6, w: 11.7, h: 0.9, fontSize: 20, color: 'C9A227', fontFace: 'Microsoft YaHei' });
  cover.addText('COSTHUB · 本地 AI 生成', { x: 0.8, y: 6.6, w: 6, h: 0.5, fontSize: 12, color: 'AEB8C9', fontFace: 'Microsoft YaHei' });
  (slides || []).forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(String(i + 1), { x: 12.4, y: 0.2, w: 0.7, h: 0.4, fontSize: 11, color: 'B0B8C6', align: 'right', fontFace: 'Microsoft YaHei' });
    slide.addText(String(s.heading || ''), { x: 0.8, y: 0.55, w: 11.7, h: 0.9, fontSize: 28, bold: true, color: '1E3A6E', fontFace: 'Microsoft YaHei' });
    slide.addShape('rect', { x: 0.82, y: 1.5, w: 1.6, h: 0.045, fill: { color: 'C9A227' }, line: { type: 'none' } });
    slide.addText((s.points || []).map((p, j) => ({ text: j + 1 + '. ' + p, options: { breakLine: true, paraSpaceAfter: 14, fontSize: 18, color: '2D3A4F', fontFace: 'Microsoft YaHei' } })),
      { x: 0.8, y: 2.0, w: 11.7, h: 4.8, valign: 'top' });
  });
  return (await pptx.write({ outputType: 'base64' })) as string;
}

/** Excel 工作簿（aoa_to_sheet，第一行可为表头） */
export function buildWorkbookBase64(sheets: { name: string; rows: any[][] }[]): string {
  const wb = XLSX.utils.book_new();
  for (const s of sheets || []) {
    const aoa = (s.rows || []).map(r => (r || []).map(c => (c == null ? '' : c)));
    if (!aoa.length) continue;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, String(s.name || 'Sheet1').slice(0, 31));
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
}
