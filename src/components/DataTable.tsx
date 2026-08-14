import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Table, Popover, Checkbox, Button } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { TableProps } from 'antd';

/**
 * DataTable —— Excel 式表格组件
 * 解决长文本撑高行、信息密度低的问题，内置：
 * 1. 列宽拖拽调节（表头右侧拖拽把手，宽度记忆到 localStorage）
 * 2. 列显隐设置（右上角「列设置」弹层，勾选控制，记忆到 localStorage）
 * 3. 长文本自动省略（ellipsis + 悬停 tooltip 显示全文，行高固定单行）
 *
 * 用法：<DataTable tableId="parts" columns={...} dataSource={...} ... />  （其余 props 与 antd Table 一致）
 * tableId 用于持久化每张表的列宽/显隐设置，同一张表用相同 id 即可。
 */
interface DataTableProps extends TableProps<any> {
  tableId?: string;
  /** 列设置弹层的可选固定列 key 前缀（如勾掉这些列的 checkbox 也不生效），默认不限制 */
  lockKeys?: string[];
  /** 默认隐藏的列 key（首次使用时生效） */
  defaultHidden?: string[];
  /** 隐藏列设置按钮（用于循环渲染的重复表格，如 BOM 每个模块明细） */
  hideToolbar?: boolean;
}

const STORAGE_PREFIX = 'costhub_dt_';

function loadSetting(tableId: string): { widths: Record<string, number>; hidden: Record<string, boolean> } {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + tableId);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { widths: {}, hidden: {} };
}

function saveSetting(tableId: string, s: { widths: Record<string, number>; hidden: Record<string, boolean> }) {
  try {
    localStorage.setItem(STORAGE_PREFIX + tableId, JSON.stringify(s));
  } catch { /* ignore */ }
}

/** 是否「内容列」（需要 ellipsis 的文本列）：排除操作列/纯按钮列 */
function isContentColumn(c: any) {
  if (c.fixed === 'right') return false;
  if (typeof c.title === 'string') {
    const t = c.title.trim();
    if (t === '' || t === '操作' || t === '') return false;
  }
  // 没有 dataIndex 且没有 key 的列（通常是操作列/渲染列）不强制 ellipsis
  return !!c.dataIndex || !!c.key;
}

/** 表头单元格：支持拖拽调宽 */
function ResizableTh(props: any) {
  const { children, onResize, width, ...rest } = props;
  const thRef = useRef<HTMLTableCellElement>(null);
  const startX = useRef(0);
  const startW = useRef(0);
  const resizing = useRef(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    startX.current = e.clientX;
    startW.current = (typeof width === 'number' && width > 0) ? width : (thRef.current?.getBoundingClientRect().width || 120);
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.max(60, Math.round(startW.current + ev.clientX - startX.current));
      onResize?.(w);
    };
    const onUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
  };

  return (
    <th {...rest} ref={thRef} style={{ ...(rest.style || {}), position: 'relative' }}>
      {children}
      <span
        onMouseDown={onMouseDown}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', right: -3, top: 0, bottom: 0, width: 8,
          cursor: 'col-resize', userSelect: 'none', zIndex: 2,
        }}
      />
    </th>
  );
}

/** 页面级统一「列设置」按钮：操作指定 tableId 的表格列显隐/宽度（与 DataTable 共用 localStorage） */
export function ColumnSettingsButton(props: { tableId: string; columns: any[]; lockKeys?: string[]; style?: React.CSSProperties }) {
  const { tableId, columns, lockKeys = [], style } = props;
  const [setting, setSetting] = useState<{ widths: Record<string, number>; hidden: Record<string, boolean> }>(() => loadSetting(tableId));
  const [popOpen, setPopOpen] = useState(false);

  const colKey = (c: any) => String(c.key ?? c.dataIndex ?? c.title ?? Math.random());

  const save = (next: any) => {
    setSetting(next);
    saveSetting(tableId, next);
    // 通知对应表格刷新
    window.dispatchEvent(new Event(`costhub-dt-refresh-${tableId}`));
  };

  const content = (
    <div style={{ width: 220, maxHeight: 320, overflowY: 'auto', padding: '4px 2px' }}>
      <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 6 }}>
        {columns.filter(c => !lockKeys.includes(colKey(c)) && setting.hidden[colKey(c)]).length > 0
          ? `已隐藏 ${columns.filter(c => !lockKeys.includes(colKey(c)) && setting.hidden[colKey(c)]).length} 列`
          : '全部显示'}
      </div>
      {columns.map(c => {
        const k = colKey(c);
        const locked = lockKeys.includes(k);
        return (
          <div key={k} style={{ padding: '3px 0' }}>
            <Checkbox
              checked={locked ? true : !setting.hidden[k]}
              disabled={locked}
              onChange={e => save({ ...setting, hidden: { ...setting.hidden, [k]: !e.target.checked } })}
            >
              <span style={{ fontSize: 13 }}>{typeof c.title === 'string' ? c.title : k}</span>
            </Checkbox>
          </div>
        );
      })}
      <div style={{ borderTop: '1px solid #F1F5F9', marginTop: 8, paddingTop: 8 }}>
        <Button size="small" onClick={() => save({ widths: {}, hidden: {} })}>恢复默认</Button>
      </div>
    </div>
  );

  return (
    <Popover content={content} trigger="click" open={popOpen} onOpenChange={setPopOpen} placement="bottomRight">
      <Button size="small" icon={<SettingOutlined />} style={{ fontSize: 12, ...style }}>
        列设置
      </Button>
    </Popover>
  );
}

export default function DataTable(props: DataTableProps) {
  const { tableId, lockKeys = [], defaultHidden = [], columns = [], hideToolbar = false, ...rest } = props;
  // 虚拟滚动安全守卫：rowSelection/summary 与 virtual 不兼容（rc-table 限制），
  // 显式传 virtual 但带这些能力时自动降级为普通渲染，避免白屏/错位
  const safeRest = (rest as any).virtual && ((rest as any).rowSelection || (rest as any).summary)
    ? { ...rest, virtual: false }
    : rest;
  const [setting, setSetting] = useState<{ widths: Record<string, number>; hidden: Record<string, boolean> }>(() =>
    tableId ? loadSetting(tableId) : { widths: {}, hidden: {} }
  );
  const [popOpen, setPopOpen] = useState(false);

  // 持久化
  useEffect(() => {
    if (tableId) saveSetting(tableId, setting);
  }, [setting, tableId]);

  // 监听外部触发的设置刷新（页面级统一"列设置"按钮通过 refreshDataTableSettings 通知）
  useEffect(() => {
    if (!tableId) return;
    const handler = () => setSetting(loadSetting(tableId));
    window.addEventListener(`costhub-dt-refresh-${tableId}`, handler);
    return () => window.removeEventListener(`costhub-dt-refresh-${tableId}`, handler);
  }, [tableId]);

  const colKey = useCallback((c: any) => String(c.key ?? c.dataIndex ?? c.title ?? Math.random()), []);

  // 列 key 集合（用于列设置弹层）
  const allKeys = columns.map(colKey);

  // 有效列：未被隐藏的
  const visibleColumns = columns.filter(c => {
    const k = colKey(c);
    if (lockKeys.includes(k)) return true;
    return !setting.hidden[k];
  });

  // 增强列：ellipsis + 宽度 + 拖拽 onHeaderCell（useMemo 固定引用，避免表格重渲染导致下拉频闪）
  const enhancedColumns = useMemo(() => visibleColumns.map(c => {
    const k = colKey(c);
    const col: any = { ...c };
    const w = setting.widths[k];
    if (typeof w === 'number' && w > 0) col.width = w;
    if (isContentColumn(c) && col.ellipsis === undefined) {
      col.ellipsis = true; // 原生 title 悬停显示全文，行高固定
    }
    if (col.fixed !== 'right' && col.fixed !== 'left') {
      col.onHeaderCell = (cc: any) => ({
        width: typeof setting.widths[k] === 'number' ? setting.widths[k] : cc.width,
        onResize: (w2: number) => setSetting(prev => ({ ...prev, widths: { ...prev.widths, [k]: w2 } })),
      });
    }
    return col;
  }), [visibleColumns, setting, colKey]);

  // 列设置弹层内容
  const settingContent = (
    <div style={{ width: 220, maxHeight: 320, overflowY: 'auto', padding: '4px 2px' }}>
      <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 6 }}>
        {allKeys.length - visibleColumns.length > 0
          ? `已隐藏 ${allKeys.length - visibleColumns.length} 列`
          : '全部显示'}
      </div>
      {columns.map(c => {
        const k = colKey(c);
        const locked = lockKeys.includes(k);
        return (
          <div key={k} style={{ padding: '3px 0' }}>
            <Checkbox
              checked={locked ? true : !setting.hidden[k]}
              disabled={locked}
              onChange={e => {
                const hidden = e.target.checked
                  ? { ...setting.hidden, [k]: false }
                  : { ...setting.hidden, [k]: true };
                setSetting(prev => ({ ...prev, hidden }));
              }}
            >
              <span style={{ fontSize: 13 }}>{typeof c.title === 'string' ? c.title : k}</span>
            </Checkbox>
          </div>
        );
      })}
      <div style={{ borderTop: '1px solid #F1F5F9', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
        <Button size="small" onClick={() => setSetting({ widths: {}, hidden: {} })}>恢复默认</Button>
      </div>
    </div>
  );

  // components 固定引用（每次渲染新建对象会导致 antd Table 认为表头组件变化 → 整表重挂载 → 下拉被关闭重开闪烁）
  const tableComponents = useMemo(() => (tableId ? { header: { cell: ResizableTh } } : undefined), [tableId]);

  return (
    <div>
      {tableId && columns.length > 0 && !hideToolbar && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <Popover
            content={settingContent}
            trigger="click"
            open={popOpen}
            onOpenChange={setPopOpen}
            placement="bottomRight"
          >
            <Button size="small" icon={<SettingOutlined />} style={{ fontSize: 12 }}>
              列设置
            </Button>
          </Popover>
        </div>
      )}
      <Table
        {...safeRest}
        columns={enhancedColumns}
        components={tableComponents}
      />
    </div>
  );
}
