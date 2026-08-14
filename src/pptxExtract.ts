// PPT 大纲提取（v2.3.19+，演示生成习惯库用）
// .pptx 本质是 zip+XML：jszip 解包 → presentation.xml 拿页序（sldIdLst）→ rels 映射 rId→文件 → 逐页抽文本
// 纯本地解析，文件不出本机；结果为"大纲文本"（每页标题+要点），可存为习惯注入本地模型
import JSZip from 'jszip';

const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface PptxSlide { title: string; lines: string[]; }
export interface PptxOutline { slides: PptxSlide[]; text: string; }

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml');
}

// 单页解析：所有 <a:p> 段落（段内 <a:t> 拼接），第一段非空为标题，其余为要点；隐藏页返回 null
function parseSlide(xml: string): PptxSlide | null {
  const doc = parseXml(xml);
  if (doc.documentElement.getAttribute('show') === '0') return null; // 隐藏幻灯片
  const paras: string[] = [];
  const ps = doc.getElementsByTagNameNS(DRAWING_NS, 'p');
  for (let i = 0; i < ps.length; i++) {
    const ts = ps[i].getElementsByTagNameNS(DRAWING_NS, 't');
    let text = '';
    for (let j = 0; j < ts.length; j++) text += ts[j].textContent || '';
    if (text.trim()) paras.push(text.trim());
  }
  if (paras.length === 0) return { title: '', lines: [] };
  return { title: paras[0], lines: paras.slice(1) };
}

/**
 * 提取 .pptx 大纲。file 必须是已选中文件（或 ArrayBuffer）
 * 返回 { slides, text }——text 为可直接存进习惯库的大纲文本
 */
export async function extractPptxOutline(file: File | ArrayBuffer): Promise<PptxOutline> {
  const zip = await JSZip.loadAsync(file as any);

  // 1. rels：rId → slide 文件路径
  const rels = new Map<string, string>();
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (relsXml) {
    const doc = parseXml(relsXml);
    const nodes = doc.getElementsByTagName('Relationship');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const id = n.getAttribute('Id');
      const target = n.getAttribute('Target') || '';
      if (id && target.includes('slides/slide')) rels.set(id, target);
    }
  }

  // 2. 页序：presentation.xml 的 sldIdLst（r:id 顺序）
  let order: string[] = [];
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (presXml) {
    const doc = parseXml(presXml);
    const nodes = doc.getElementsByTagNameNS(PRESENTATION_NS, 'sldId');
    for (let i = 0; i < nodes.length; i++) {
      const rid = nodes[i].getAttributeNS(RELS_NS, 'id') || nodes[i].getAttribute('r:id') || '';
      if (rid) order.push(rid);
    }
  }
  // fallback：无页序信息时按 slide 文件名数字排序（文件本身就在 zip 里）
  const slideFiles = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt((a.match(/(\d+)/) || ['', '0'])[1]) - parseInt((b.match(/(\d+)/) || ['', '0'])[1]));

  const slides: PptxSlide[] = [];
  if (order.length > 0) {
    for (const rid of order) {
      const target = rels.get(rid) || '';
      const path = target.startsWith('ppt/') ? target : `ppt/${target.replace(/^\.?\//, '')}`;
      const xml = await zip.file(path)?.async('string');
      if (!xml) continue;
      const slide = parseSlide(xml);
      if (slide) slides.push(slide);
    }
  } else {
    for (const path of slideFiles) {
      const xml = await zip.file(path)?.async('string');
      if (!xml) continue;
      const slide = parseSlide(xml);
      if (slide) slides.push(slide);
    }
  }

  return {
    slides,
    text: slides.map((s, i) => `第${i + 1}页【${s.title || '（无标题）'}】\n${s.lines.map(l => `- ${l}`).join('\n')}`).join('\n\n'),
  };
}
