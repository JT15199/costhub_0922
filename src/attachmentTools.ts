// 附件文件工具（v2.3.19，2026-08-19 用户：都加上——CSV/TXT/PDF 报价读取 + OCR 拍照提取）
// 提供：文本→表格尝试、PDF 文本提取、OCR 图片识别；配合 AiPanel 附件流程（detectSheetType 识别类型 → import_* 工具处理）
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** 文本 → 表格尝试：按 多个空格/tab/逗号 拆行；若每行列数一致且 ≥2 列 → 返回表格，否则 null（当纯文本） */
export function textToRows(text: string): any[][] | null {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const parsed = lines.map(l => l.split(/\t+| {2,}|,/).map(c => c.trim()).filter(Boolean));
  const firstLen = parsed[0]?.length || 0;
  if (firstLen >= 2 && parsed.every(p => p.length === firstLen)) return parsed;
  return null;
}

/** PDF 文本提取（pdfjs-dist，按 y 坐标聚合行——报价单表格每行一条） */
export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  (pdfjs as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const doc = await (pdfjs as any).getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages || 1, 20); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let lastY: number | null = null; let line = '';
    for (const item of (tc.items || []) as any[]) {
      const y = item.transform?.[5] || 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) { if (line.trim()) text += line.trim() + '\n'; line = ''; }
      line += (item.str || '') + ' ';
      lastY = y;
    }
    if (line.trim()) text += line.trim() + '\n';
  }
  return text;
}

/** OCR 图片识别（tesseract.js，语言包本地 public/tessdata/，引擎默认 CDN 需联网） */
export async function ocrImage(base64: string): Promise<string> {
  const Tesseract = await import('tesseract.js');
  const result = await Tesseract.recognize(base64, 'eng+chi_sim', {
    langPath: '/tessdata',
    logger: () => {},
  });
  return String(result?.data?.text || '');
}
