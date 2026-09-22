import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AutoComplete, Button, Modal, message } from 'antd';
import './JournalShelf.css';

const CLOTH = ['#6654ad', '#385675', '#5c7560', '#98747f', '#af9144', '#427a80', '#923f45', '#767087', '#a66a4b', '#7b8060'];
export function bookAppearance(key: string): CSSProperties {
  let hash = 5381;
  for (const char of key) hash = (Math.imul(hash, 33) ^ char.charCodeAt(0)) >>> 0;
  return { '--cloth': CLOTH[hash % CLOTH.length], '--spine-height': `${208 + hash % 65}px`, '--spine-width': `${44 + hash % 13}px` } as CSSProperties;
}

type Book = { key: string; code: string; name: string; category: string; rows: unknown[] };
export function journalMotionEnabled() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'off' && document.documentElement.dataset.lowfx !== 'on';
}
function SpineTitle({ name }: { name: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      if (!box.current || !text.current) return;
      const label = text.current;
      label.style.transform = 'none';
      let size = 17;
      label.style.fontSize = `${size}px`;
      while (size > 6 && (label.scrollHeight > box.current.clientHeight + 1 || label.scrollWidth > box.current.clientWidth + 1)) {
        size -= .5;
        label.style.fontSize = `${size}px`;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (box.current) observer.observe(box.current);
    let active = true;
    document.fonts.ready.then(() => { if (active) fit(); });
    return () => { active = false; observer.disconnect(); };
  }, [name]);
  return <span className="cloth-title" ref={box}><strong ref={text}>{name}</strong></span>;
}
export function JournalTurningPage({ backward, children, onFinish }: { backward: boolean; children: ReactNode; onFinish: () => void }) {
  // Ten hinged strips approximate a flexible sheet without a canvas or WebGL runtime.
  let strips: ReactNode = null;
  for (let index = 9; index >= 0; index--) {
    strips = <span className="curl-strip" key={index} style={{ '--strip': index } as CSSProperties}>
      <span className="curl-face"><span className="curl-print">{children}</span></span>
      <span className="curl-back" />{strips}
    </span>;
  }
  return <div className={`bound-paper ${backward ? 'is-backward' : ''}`} onAnimationEnd={event => { if (event.target === event.currentTarget) onFinish(); }}>{strips}</div>;
}
export default function JournalShelf({ books, selected, onSelect, onOpen, onCategoryChange }: { books: Book[]; selected?: string; onSelect: (key: string) => void; onOpen: (key: string) => void; onCategoryChange: (key: string, category: string) => Promise<void> }) {
  const [category, setCategory] = useState<string | null>(null);
  const [categorizing, setCategorizing] = useState<Book | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const categories = [...new Set(books.map(book => book.category))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const activeCategory = category && categories.includes(category) ? category : null;
  const visibleBooks = (activeCategory ? [activeCategory] : categories).flatMap(name => books.filter(book => book.category === name));
  const activeBook = books.find(book => book.key === selected) || books[0];
  const [opening, setOpening] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const open = (book: Book) => {
    if (opening) return;
    onSelect(book.key);
    if (!journalMotionEnabled()) { onOpen(book.key); return; }
    setOpening(book.key);
    timer.current = setTimeout(() => { setOpening(null); onOpen(book.key); }, 480);
  };
  return <section className="cloth-library" aria-label="手账书架">
    <header><span>项目藏书 / WORK JOURNALS</span><span>{String(books.length).padStart(2, '0')} 册</span></header>
    <div className="cloth-category-bar"><nav aria-label="书册分类"><button type="button" aria-pressed={!activeCategory} onClick={() => setCategory(null)}>全部 · {books.length}</button>{categories.map(name => <button type="button" key={name} aria-pressed={activeCategory === name} onClick={() => { setCategory(name); const first = books.find(book => book.category === name); if (first) onSelect(first.key); }}>{name} · {books.filter(book => book.category === name).length}</button>)}</nav><Button size="small" disabled={!activeBook} onClick={() => { setCategorizing(activeBook); setCategoryName(activeBook.category); }}>调整书册分类</Button></div>
    <div className="cloth-shelf-scroll"><div className="cloth-shelf">
      {visibleBooks.map((book, index) => <button type="button" key={book.key} style={bookAppearance(book.key)} className={`cloth-book ${selected === book.key ? 'is-selected' : ''} ${opening === book.key ? 'is-extracting' : ''}`} aria-label={`${book.name}，${book.rows.length} 条记录，打开手账`} aria-pressed={selected === book.key} title={`${book.name} · ${book.code}`} onFocus={() => onSelect(book.key)} onClick={() => open(book)}>
        <span className="cloth-volume"><span className="cloth-spine"><small>{String(index + 1).padStart(2, '0')}</small><SpineTitle name={book.name} /><span>{book.code}</span><small>{book.rows.length} 篇</small></span><span className="cloth-cover" aria-hidden="true"><small>COSTHUB / {book.code}</small><strong>{book.name}</strong><span>工作手账<br />{book.rows.length} 条记录</span></span><span className="cloth-page-edge" aria-hidden="true" /></span>
      </button>)}
    </div></div>
    {!books.length && <p className="cloth-empty">暂无书册，点击“新建书册”开始记录。</p>}
    <Modal open={!!categorizing} title="调整书册分类" styles={{ body: { minHeight: 180 } }} onCancel={() => { if (!savingCategory) setCategorizing(null); }} confirmLoading={savingCategory} okText="保存分类" cancelText="取消" onOk={async () => {
      const name = categoryName.trim();
      if (!categorizing || !name) { message.warning('请输入分类名称'); return; }
      setSavingCategory(true);
      try { await onCategoryChange(categorizing.key, name); setCategory(name); setCategorizing(null); message.success('书册分类已保存'); }
      catch (error) { message.error(`分类保存失败：${String(error)}`); }
      finally { setSavingCategory(false); }
    }}><p className="cloth-category-help">{categorizing?.name} · 分类用于整理书架，默认沿用项目品类。</p><AutoComplete aria-label="书册分类名称" value={categoryName} onChange={setCategoryName} filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())} options={[...new Set([...categories, '显示器', '手写笔', '鼠标', '其他'])].map(value => ({ value }))} style={{ width:'100%' }} placeholder="选择或填写分类名称" maxLength={40} /></Modal>
    <footer><span>{books.find(book => book.key === selected)?.name || '按需要建立自己的工作手账。'}</span><span>轻触书脊 · 翻开记录</span></footer>
  </section>;
}
