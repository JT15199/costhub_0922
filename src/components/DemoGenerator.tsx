// 演示生成器（v2.3.19+）：本地 Ollama 生成 HTML/PPTX 演示文稿
// 数据安全：全程本地（Ollama 流式 + 本地渲染），素材/习惯不离开本机
// 内容与样式分离：模型只输出结构化 JSON（标题+每页要点），本地模板负责视觉（HTML 模板 / pptxgenjs 渲染）
// 习惯库：local_ai_context 表复用（分类：演示结构/风格描述/素材模板...），支持从已有 .pptx 提取大纲变习惯
import { useEffect, useState } from 'react';
import { Button, Input, Space, Modal, Tag, Checkbox, Radio, message, Upload, Alert, Empty, Tooltip } from 'antd';
import { UploadOutlined, DeleteOutlined, EditOutlined, PlusOutlined, FolderOpenOutlined, ThunderboltOutlined, InboxOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { getSetting, loadContextEntries, saveContextEntry, deleteContextEntry } from '../db';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { extractPptxOutline } from '../pptxExtract';
import pptxgen from 'pptxgenjs';

interface Habit { key: string; title: string; content: string; category: string; updated_at?: string; }

// 从模型输出里提取 JSON（容忍 ```json 围栏、前后杂文本）
function parseDemoJson(text: string): any | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// 本地时间戳文件名
function tsSuffix(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

// ==================== HTML 模板（简洁幻灯片：墨蓝+金，方向键翻页） ====================
function buildDemoHtml(data: any): string {
  const slides = (data.slides || []).map((s: any, i: number) => `
    <section class="slide" data-i="${i}">
      <div class="num">${String(i + 1).padStart(2, '0')} / ${String(data.slides.length).padStart(2, '0')}</div>
      <h2>${String(s.heading || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)}</h2>
      <ul>${(s.points || []).map((p: string) => `<li>${String(p).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)}</li>`).join('')}</ul>
      ${s.note ? `<div class="note">💡 ${String(s.note).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)}</div>` : ''}
    </section>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${String(data.title || '演示文稿')}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #F5F6F8; }
  #deck { height: 100vh; position: relative; }
  .slide { position: absolute; inset: 0; display: none; flex-direction: column; justify-content: center; padding: 9vh 12vw; background: #fff; }
  .slide.active { display: flex; }
  .slide.cover { background: linear-gradient(135deg, #16223E 0%, #1E3A6E 60%, #274B8F 100%); color: #fff; align-items: center; text-align: center; }
  .slide.cover h1 { font-size: clamp(32px, 5.5vw, 64px); letter-spacing: 2px; font-weight: 700; }
  .slide.cover .sub { margin-top: 22px; font-size: clamp(16px, 2vw, 24px); color: #C9A227; font-weight: 500; }
  .slide.cover .tag { margin-top: 40px; font-size: 13px; color: rgba(255,255,255,0.5); letter-spacing: 4px; }
  .slide h2 { font-size: clamp(24px, 3.6vw, 40px); color: #1E3A6E; font-weight: 700; margin-bottom: 6vh; }
  .slide h2::after { content: ""; display: block; width: 56px; height: 4px; background: #C9A227; margin-top: 14px; border-radius: 2px; }
  .slide ul { list-style: none; max-width: 76vw; }
  .slide li { font-size: clamp(17px, 2.1vw, 24px); line-height: 1.9; color: #2D3A4F; padding: 10px 0 10px 38px; position: relative; border-bottom: 1px solid #EEF1F5; }
  .slide li:last-child { border-bottom: none; }
  .slide li::before { content: counter(item); counter-increment: item; position: absolute; left: 0; top: 14px; width: 26px; height: 26px; border-radius: 50%; background: #1E3A6E; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; font-weight: 600; }
  .slide ul { counter-reset: item; }
  .slide .note { position: absolute; bottom: 6vh; left: 12vw; right: 12vw; font-size: 13px; color: #8A94A6; background: #F7F8FA; border: 1px dashed #D5DAE3; border-radius: 8px; padding: 8px 14px; }
  .slide .num { position: absolute; top: 5vh; right: 4vw; font-size: 13px; color: #B0B8C6; letter-spacing: 1px; }
  #progress { position: fixed; top: 0; left: 0; height: 3px; background: #C9A227; transition: width .25s ease; z-index: 99; }
  #dots { position: fixed; bottom: 3vh; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; z-index: 99; }
  #dots span { width: 8px; height: 8px; border-radius: 50%; background: #D5DAE3; cursor: pointer; transition: all .2s; }
  #dots span.on { background: #1E3A6E; transform: scale(1.25); }
  #hint { position: fixed; bottom: 3vh; right: 3vw; font-size: 11px; color: #B0B8C6; z-index: 99; }
</style>
</head>
<body>
<div id="progress"></div>
<div id="deck">
  <section class="slide cover active">
    <h1>${String(data.title || '演示文稿')}</h1>
    ${data.subtitle ? `<div class="sub">${String(data.subtitle).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)}</div>` : ''}
    <div class="tag">COSTHUB · 本地 AI 生成</div>
  </section>
  ${slides}
</div>
<div id="dots">${Array.from({ length: (data.slides?.length || 0) + 1 }, (_, i) => `<span data-i="${i}"></span>`).join('')}</div>
<div id="hint">方向键 / 空格翻页 · F 全屏</div>
<script>
  const slides = Array.from(document.querySelectorAll('.slide'));
  const dots = Array.from(document.querySelectorAll('#dots span'));
  const bar = document.getElementById('progress');
  let cur = 0;
  function go(n) {
    cur = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, i) => s.classList.toggle('active', i === cur));
    dots.forEach((d, i) => d.classList.toggle('on', i === cur));
    bar.style.width = ((cur + 1) / slides.length * 100) + '%';
  }
  document.addEventListener('keydown', e => {
    if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(e.key)) { e.preventDefault(); go(cur + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); go(cur - 1); }
    else if (e.key === 'f' || e.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
  });
  dots.forEach(d => d.addEventListener('click', () => go(Number(d.dataset.i))));
  let sx = 0;
  document.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', e => { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 50) go(cur + (dx < 0 ? 1 : -1)); }, { passive: true });
  go(0);
</script>
</body>
</html>`;
}

export default function DemoGenerator() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [genType, setGenType] = useState<'html' | 'pptx'>('html');
  const [material, setMaterial] = useState('');
  const [picked, setPicked] = useState<string[]>([]);      // 勾选的习惯 key
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [model, setModel] = useState('');

  const [generating, setGenerating] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [lastFile, setLastFile] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // 习惯管理弹窗
  const [habitModal, setHabitModal] = useState(false);
  const [habitForm, setHabitForm] = useState<{ key?: string; title: string; category: string; content: string }>({ title: '', category: '演示结构', content: '' });
  // PPT 导入弹窗
  const [importModal, setImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOutline, setImportOutline] = useState('');
  const [importName, setImportName] = useState('');

  const loadAll = async () => {
    setHabits(await loadContextEntries());
    setOllamaUrl(await getSetting('local_ai_base_url', 'http://localhost:11434'));
    setModel(await getSetting('local_ai_model', ''));
  };
  useEffect(() => { loadAll(); }, []);

  // ==================== 生成 ====================
  const generate = async () => {
    if (!material.trim()) { message.warning('请先粘贴素材（案例背景、做法、效果数据）'); return; }
    if (!model) { message.warning('请先在 系统设置 → 连接设置 配置 Ollama 模型'); return; }
    setGenerating(true); setStreamText(''); setErrorMsg(''); setLastFile('');
    const pickedHabits = habits.filter(h => picked.includes(h.key));
    const sysPrompt = `你是成本管理领域的演示文稿撰写专家。根据用户提供的素材与参考习惯，输出演示文稿的完整内容结构。只输出 JSON，不要任何解释或代码块围栏。
JSON 格式（必须严格符合）：
{"title":"演示标题","subtitle":"副标题或一句话定位","slides":[{"heading":"每页标题","points":["要点1","要点2","要点3"],"note":"讲稿备注，可选"}]}
规则：
1. 页数 4-8 页；标题精炼有力
2. points 必须是完整的陈述句（表达做法、数据、结论），不是关键词堆砌
3. 所有数字必须来自用户素材，严禁编造；素材里有量化效果（降本幅度、金额、周期等）要突出呈现
4. 第一页为开篇定位，最后一页为总结或下一步`;
    const userPrompt = `【素材】\n${material}\n\n${pickedHabits.length > 0 ? `【参考习惯（学习其结构与风格）】\n${pickedHabits.map(h => `—— ${h.title} ——\n${h.content}`).join('\n\n')}` : ''}`;

    try {
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(ollamaUrl, model,
          [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
          t => setStreamText(prev => prev + t),
          () => {},
          () => resolve(),
          e => reject(new Error(e)),
          { endpoint: 'native', json: true, think: false, num_predict: 16384, temperature: 0.4 },
        );
      });
      // 解析（失败自动重试一次）
      let data = parseDemoJson(streamText);
      if (!data || !Array.isArray(data.slides) || data.slides.length === 0) {
        message.info('首次输出结构不完整，自动重试一次…');
        await new Promise<void>((resolve, reject) => {
          startOllamaStream(ollamaUrl, model,
            [{ role: 'system', content: sysPrompt }, { role: 'user', content: `${userPrompt}\n\n注意：上次输出无法解析，请只输出一个合法 JSON 对象。` }],
            t => setStreamText(prev => prev + t),
            () => {},
            () => resolve(),
            e => reject(new Error(e)),
            { endpoint: 'native', json: true, think: false, num_predict: 16384, temperature: 0.4 },
          );
        });
        data = parseDemoJson(streamText);
      }
      if (!data || !Array.isArray(data.slides) || data.slides.length === 0) {
        throw new Error('模型输出无法解析为有效内容结构');
      }
      const title = String(data.title || '演示文稿').replace(/[\\/:*?"<>|]/g, '_');
      const name = `演示-${title}-${tsSuffix()}.${genType}`;
      let b64 = '';
      if (genType === 'html') {
        b64 = btoa(unescape(encodeURIComponent(buildDemoHtml(data))));
      } else {
        b64 = await buildPptxBase64(data);
      }
      await invoke('save_export_file', { fileName: name, base64Data: b64 });
      setLastFile(name);
      logLocalAICall({
        request_type: 'demo_generate',
        material_name: material.slice(0, 80),
        system_prompt: sysPrompt.slice(0, 1500),
        user_prompt: userPrompt.slice(0, 1500),
        response_summary: '生成 ' + genType + '：' + title,
        success: true,
        model_name: model,
      });
      message.success(`已生成 ${name}`);
    } catch (e: any) {
      logLocalAICall({
        request_type: 'demo_generate',
        material_name: (material || '').slice(0, 80),
        system_prompt: sysPrompt.slice(0, 1500),
        user_prompt: userPrompt.slice(0, 1500),
        response_summary: '',
        success: false,
        error_message: String(e?.message || e).slice(0, 300),
        model_name: model,
      });
      setErrorMsg(String(e?.message || e));
      message.error(`生成失败：${String(e?.message || e).slice(0, 120)}`);
    } finally {
      setGenerating(false);
    }
  };

  // PPTX 渲染（pptxgenjs，16:9，墨蓝+金与 HTML 模板同风格）
  const buildPptxBase64 = async (data: any): Promise<string> => {
    const pptx = new pptxgen();
    pptx.defineLayout({ name: 'W16', width: 13.333, height: 7.5 });
    pptx.layout = 'W16';
    pptx.author = 'CostHub';
    pptx.title = String(data.title || '演示文稿');
    // 封面
    const cover = pptx.addSlide();
    cover.background = { color: '1E3A6E' };
    cover.addText(String(data.title || '演示文稿'), { x: 0.8, y: 2.1, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Microsoft YaHei' });
    if (data.subtitle) cover.addText(String(data.subtitle), { x: 0.8, y: 3.6, w: 11.7, h: 0.9, fontSize: 20, color: 'C9A227', fontFace: 'Microsoft YaHei' });
    cover.addText('COSTHUB · 本地 AI 生成', { x: 0.8, y: 6.6, w: 6, h: 0.5, fontSize: 12, color: 'AEB8C9', fontFace: 'Microsoft YaHei' });
    // 内容页
    (data.slides || []).forEach((s: any, i: number) => {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(`${i + 1}`, { x: 12.4, y: 0.2, w: 0.7, h: 0.4, fontSize: 11, color: 'B0B8C6', align: 'right', fontFace: 'Microsoft YaHei' });
      slide.addText(String(s.heading || ''), { x: 0.8, y: 0.55, w: 11.7, h: 0.9, fontSize: 28, bold: true, color: '1E3A6E', fontFace: 'Microsoft YaHei' });
      slide.addShape('rect', { x: 0.82, y: 1.5, w: 1.6, h: 0.045, fill: { color: 'C9A227' }, line: { type: 'none' } });
      slide.addText((s.points || []).map((p: string, j: number) => ({ text: `${j + 1}. ${p}`, options: { breakLine: true, paraSpaceAfter: 14, fontSize: 18, color: '2D3A4F', fontFace: 'Microsoft YaHei' } })),
        { x: 0.8, y: 2.0, w: 11.7, h: 4.8, valign: 'top' });
    });
    return (await pptx.write({ outputType: 'base64' })) as string;
  };

  // ==================== 习惯库 ====================
  const saveHabit = async () => {
    if (!habitForm.title.trim()) { message.warning('请填写习惯名称'); return; }
    if (!habitForm.content.trim()) { message.warning('请填写习惯内容'); return; }
    await saveContextEntry(habitForm.key || `habit-${Date.now()}`, habitForm.title.trim(), habitForm.content, habitForm.category.trim() || '演示结构');
    setHabitModal(false);
    setHabits(await loadContextEntries());
    message.success('习惯已保存');
  };
  const delHabit = async (key: string) => {
    await deleteContextEntry(key);
    setPicked(p => p.filter(k => k !== key));
    setHabits(await loadContextEntries());
  };

  // PPT 导入 → 提取大纲
  const onImportPpt = async (file: File) => {
    setImporting(true); setImportOutline('');
    try {
      const outline = await extractPptxOutline(file);
      if (outline.slides.length === 0) { message.warning('未提取到文本内容（可能全是图片页）'); return false; }
      setImportOutline(outline.text);
      setImportName(file.name.replace(/\.pptx?$/i, ''));
      message.success(`提取成功：${outline.slides.length} 页`);
    } catch (e: any) {
      message.error('解析失败：' + String(e?.message || e).slice(0, 100));
    } finally {
      setImporting(false);
    }
    return false; // 阻止 Upload 默认上传
  };
  const saveImportedHabit = async () => {
    if (!importOutline.trim()) { message.warning('请先导入 PPT'); return; }
    if (!importName.trim()) { message.warning('请填写习惯名称'); return; }
    await saveContextEntry(`habit-ppt-${Date.now()}`, importName.trim(), importOutline, '演示结构');
    setImportModal(false); setImportOutline(''); setImportName('');
    setHabits(await loadContextEntries());
    message.success('已存入习惯库（生成时可勾选作为结构范本）');
  };

  return (
    <div>
      {/* ===== 生成区 ===== */}
      <div className="content-card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <b style={{ fontSize: 14 }}><ThunderboltOutlined /> 演示生成（本地 AI · 数据不出本机）</b>
          <Space wrap>
            <Radio.Group value={genType} onChange={e => setGenType(e.target.value)} optionType="button" buttonStyle="solid" size="small"
              options={[{ label: 'HTML 演示', value: 'html' }, { label: 'PPTX 演示', value: 'pptx' }]} />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => invoke('open_exports_dir')}>打开导出目录</Button>
          </Space>
        </div>
        <Input.TextArea value={material} onChange={e => setMaterial(e.target.value)} rows={7}
          placeholder={'粘贴素材：案例背景、项目做了什么、做到了什么效果（含数字）。\n例：某 27 寸显示器项目，供应商初版整机报价 ¥120，经三家 ODM 比价与器件份额调整，量产定价 ¥98，降幅 18.3%；面板成本占比从 52% 降至 47%…'} />
        <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 340px', minWidth: 300 }}>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>
              习惯（勾选后模型学习其结构与风格）
              <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} icon={<PlusOutlined />} onClick={() => { setHabitForm({ title: '', category: '演示结构', content: '' }); setHabitModal(true); }}>新建</Button>
              <Button type="link" size="small" style={{ padding: 0, marginLeft: 4 }} icon={<UploadOutlined />} onClick={() => { setImportModal(true); }}>从 PPT 提取</Button>
            </div>
            {habits.length === 0 ? (
              <div style={{ fontSize: 12, color: '#94A3B8', padding: '10px 0' }}>习惯库为空——先"新建"写一条你的风格，或"从 PPT 提取"把已有演示变成范本</div>
            ) : (
              <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid #EEF1F5', borderRadius: 8, padding: 8 }}>
                {habits.map(h => (
                  <div key={h.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
                    <Checkbox checked={picked.includes(h.key)} onChange={e => setPicked(p => e.target.checked ? [...p, h.key] : p.filter(k => k !== h.key))} />
                    <Tooltip title={h.content.length > 200 ? h.content.slice(0, 200) + '…' : h.content}>
                      <span style={{ fontSize: 12.5, cursor: 'help' }}>{h.title}</span>
                    </Tooltip>
                    <Tag style={{ margin: 0, fontSize: 10 }}>{h.category}</Tag>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => { setHabitForm({ key: h.key, title: h.title, category: h.category, content: h.content }); setHabitModal(true); }} />
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => delHabit(h.key)} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: '1 1 260px', minWidth: 240 }}>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>模型与状态</div>
            <div style={{ fontSize: 12.5, marginBottom: 4 }}>模型：{model || <span style={{ color: '#CF0A2C' }}>未配置</span>} <span style={{ color: '#94A3B8' }}>（在 系统设置 → 连接设置 配置）</span></div>
            <div style={{ fontSize: 12.5 }}>地址：{ollamaUrl}</div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={generating} onClick={generate} disabled={generating}>生成 {genType === 'html' ? 'HTML' : 'PPTX'} 演示</Button>
          {generating && <span style={{ marginLeft: 10, fontSize: 12, color: '#64748B' }}>本地模型生成中（流式输出，内容完全在本地）…</span>}
        </div>
        {generating && streamText && (
          <div style={{ marginTop: 8, background: '#F7F8FA', border: '1px solid #EEF1F5', borderRadius: 8, padding: '8px 12px', maxHeight: 140, overflow: 'auto', fontSize: 11.5, color: '#64748B', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {streamText}
          </div>
        )}
        {lastFile && !generating && (
          <Alert style={{ marginTop: 10 }} type="success" showIcon message={`已生成：${lastFile}`}
            description={<Button size="small" icon={<FolderOpenOutlined />} onClick={() => invoke('open_exports_dir')}>打开导出目录查看</Button>} />
        )}
        {errorMsg && !generating && <Alert style={{ marginTop: 10 }} type="error" showIcon message="生成失败" description={errorMsg} />}
      </div>

      {/* ===== 习惯库管理 ===== */}
      <div className="content-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}><InboxOutlined /> 习惯库（{habits.length}）</b>
          <Space>
            <Button size="small" icon={<UploadOutlined />} onClick={() => { setImportModal(true); }}>导入 PPT 提取大纲</Button>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setHabitForm({ title: '', category: '演示结构', content: '' }); setHabitModal(true); }}>新建习惯</Button>
          </Space>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10 }}>
          习惯 = 你的工作方式。支持三类：<b>演示结构</b>（页面怎么组织）、<b>风格描述</b>（配色/语气/排版偏好）、<b>素材模板</b>（你需要的输入字段清单）。导入 PPT 可把你满意的成品直接变成结构范本。
        </div>
        {habits.length === 0 ? (
          <Empty description={'暂无习惯——把"导入 PPT"或"新建"作为第一步'} />
        ) : (
          habits.map(h => (
            <div key={h.key} style={{ border: '1px solid #EEF1F5', borderRadius: 8, padding: '8px 12px', marginBottom: 8, background: '#FAFBFC' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 13 }}>{h.title}</b>
                <Tag style={{ margin: 0, fontSize: 10.5 }}>{h.category}</Tag>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => { setHabitForm({ key: h.key, title: h.title, category: h.category, content: h.content }); setHabitModal(true); }} />
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => delHabit(h.key)} />
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#64748B', marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'auto' }}>{h.content}</div>
            </div>
          ))
        )}
      </div>

      {/* 习惯编辑弹窗 */}
      <Modal title={habitForm.key ? '编辑习惯' : '新建习惯'} open={habitModal} onOk={saveHabit} onCancel={() => setHabitModal(false)} width={560}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <Input placeholder="习惯名称，如：我的案例写作风格" value={habitForm.title} onChange={e => setHabitForm({ ...habitForm, title: e.target.value })} style={{ flex: 2 }} />
          <Input placeholder="分类（演示结构/风格描述/素材模板）" value={habitForm.category} onChange={e => setHabitForm({ ...habitForm, category: e.target.value })} style={{ flex: 1 }} />
        </div>
        <Input.TextArea rows={8} placeholder={'习惯内容：直接写给模型看的东西。\n示例（演示结构）：先讲背景痛点，再讲做法（时间先后），最后量化效果；数据要单独成页放大呈现…\n示例（风格描述）：深墨蓝标题+金色强调；语言书面正式，不用口语；每页要点不超过 4 条…'} value={habitForm.content} onChange={e => setHabitForm({ ...habitForm, content: e.target.value })} />
      </Modal>

      {/* PPT 导入弹窗 */}
      <Modal title="导入 PPT → 提取大纲 → 存为习惯" open={importModal} onCancel={() => { setImportModal(false); setImportOutline(''); setImportName(''); }} footer={null} width={640}>
        <div style={{ marginBottom: 10, fontSize: 12, color: '#6E6A64' }}>
          选择一个你满意的 .pptx，工具会提取每页标题与要点形成"结构范本"（纯本地解析，文件不出本机）。生成演示时勾选它，模型会照着这个结构写新内容。
        </div>
        <Upload accept=".pptx" showUploadList={false} beforeUpload={onImportPpt} disabled={importing}>
          <Button icon={<UploadOutlined />} loading={importing}>选择 PPT 文件</Button>
        </Upload>
        {importOutline && (
          <div style={{ marginTop: 12 }}>
            <Input placeholder="存为习惯的名称，如：优秀案例演示风格" value={importName} onChange={e => setImportName(e.target.value)} style={{ marginBottom: 8 }} />
            <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 4 }}>提取的大纲预览：</div>
            <pre style={{ background: '#F7F8FA', border: '1px solid #EEF1F5', borderRadius: 8, padding: 10, maxHeight: 260, overflow: 'auto', fontSize: 11.5, whiteSpace: 'pre-wrap', fontFamily: 'monospace', marginBottom: 10 }}>{importOutline}</pre>
            <Button type="primary" onClick={saveImportedHabit}>存入习惯库</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
