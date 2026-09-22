import { useState } from 'react';
import { Button, message } from 'antd';
import { ExportOutlined, FileExcelOutlined, FileTextOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

export interface GeneratedFileMeta {
  name: string;
  type: string;
  dir: string;
  path: string;
}

export default function GeneratedFileCard({ file }: { file: GeneratedFileMeta }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      await invoke('open_exported_file', { targetDir: file.dir, fileName: file.name });
    } catch (error) {
      message.error('打开文件失败：' + String((error as Error)?.message || error));
    } finally { setBusy(false); }
  };
  const reveal = async () => {
    setBusy(true);
    try {
      await invoke('reveal_exported_file', { targetDir: file.dir, fileName: file.name });
    } catch (error) {
      message.error('定位文件失败：' + String((error as Error)?.message || error));
    } finally { setBusy(false); }
  };
  const icon = file.type === 'xlsx' ? <FileExcelOutlined /> : <FileTextOutlined />;
  return (
    <div style={{ display: 'grid', gap: 5, padding: '8px 10px', marginTop: 6, border: '1px solid var(--ai-panel-border,#E6E4DC)', borderRadius: 8, background: 'var(--color-surface,#FFF)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-primary,#181713)' }}>
        {icon}<b>{file.name}</b><span style={{ color: 'var(--color-text-tertiary,#9A978B)', fontSize: 10.5 }}>{file.type.toUpperCase()}</span>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--color-text-secondary,#5F5D54)', overflowWrap: 'anywhere' }}>保存位置：{file.path}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button size="small" icon={<ExportOutlined />} onClick={() => void open()} disabled={busy}>打开文件</Button>
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void reveal()} disabled={busy}>在文件夹中显示</Button>
      </div>
    </div>
  );
}
