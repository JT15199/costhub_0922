import { describe, it, expect } from 'vitest';
import { buildHtmlReportBase64, buildWorkbookBase64 } from './aiReport';

function decodeB64(b: string): string { return decodeURIComponent(escape(atob(b))); }

describe('aiReport', () => {
  it('HTML 报告含标题与各节要点', () => {
    const html = decodeB64(buildHtmlReportBase64('测试报告', [{ heading: '结论', points: ['要点一', '要点二'] }]));
    expect(html).toContain('测试报告');
    expect(html).toContain('结论');
    expect(html).toContain('要点一');
  });
  it('HTML 转义特殊字符（防注入）', () => {
    const html = decodeB64(buildHtmlReportBase64('A<B', [{ heading: 'H&C', points: ['<script>'] }]));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('Excel 工作簿生成 base64（XLSX 魔数 PK）', () => {
    const b64 = buildWorkbookBase64([{ name: 'Sheet1', rows: [['器件', '单价'], ['面板', 610]] }]);
    const bytes = atob(b64);
    expect(bytes.charCodeAt(0)).toBe(0x50); // P
    expect(bytes.charCodeAt(1)).toBe(0x4B); // K
  });
});
