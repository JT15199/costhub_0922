import { useEffect, useState } from 'react';
import { Alert, Button, message, Tag, Tooltip } from 'antd';
import { LockOutlined, QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { getLocalBackend, type LocalBackend } from '../localBackend';

interface IsolationStatus {
  ollama_found: boolean;
  ollama_path: string;
  blocked: boolean;
  query_error?: string;
}

export default function LocalAISecurityStatus() {
  const [status, setStatus] = useState<IsolationStatus | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [backend, setBackend] = useState<LocalBackend>('ollama');

  const refresh = async () => {
    try {
      const currentBackend = await getLocalBackend(); setBackend(currentBackend);
      const [nextStatus, nextEvents] = await Promise.all([
        invoke<IsolationStatus>('ollama_net_status'),
        invoke<string[]>('list_security_events'),
      ]);
      setStatus(nextStatus);
      setEvents(nextEvents);
    }
    catch (e: any) { setStatus({ ollama_found: false, ollama_path: '', blocked: false, query_error: String(e?.message || e) }); }
  };

  useEffect(() => { refresh(); }, []);

  const enable = async () => {
    setLoading(true);
    try {
      await invoke('ollama_net_enable_block');
      await refresh();
      message.success('Ollama 进程外网已锁定；本机命令执行的权限独立管理');
    } catch (e: any) { message.error(String(e?.message || e)); }
    finally { setLoading(false); }
  };

  const loopbackVerified = true;
  const processIsolationVerified = backend === 'ollama' && !!status?.blocked;
  const fullyVerified = loopbackVerified && processIsolationVerified;
  const detail = (
    <div style={{ lineHeight: 1.7 }}>
      <div>应用 HTTP 通道由 Rust 强制只允许本机回环；这只证明 CostHub 的访问边界。模型进程是否禁止外联是另一项系统级检查，llama.cpp 需要由 IT 按实际 server 路径和进程策略验证。</div>
      <div>安全拦截记录：<b>{events.length}</b> 条{events[0] ? `（最近：${events[0]}）` : ''}</div>
      {backend === 'llama.cpp' ? <div>当前为 llama.cpp：仅本机访问已通过；模型进程外联隔离：未由应用验证，不能据此宣称公司数据安全。</div> : !status?.ollama_found ? <div>未检测到 Ollama，请安装后刷新。</div> : processIsolationVerified
        ? <div>已验证规则 <code>CostHub_Block_Ollama_Outbound</code>，模型路径：{status.ollama_path}</div>
        : <div style={{ color: '#B91C1C' }}>外联隔离未通过前，Rust 拒绝向 Ollama 发送成本提示词。</div>}
    </div>
  );
  return (
    <Alert
      type={fullyVerified ? 'success' : 'warning'}
      showIcon
      message={<span>模型网络边界 <Tag color="green">仅本机访问：已通过</Tag> <Tag color={processIsolationVerified ? 'green' : 'gold'}>模型进程外联隔离：{backend === 'llama.cpp' ? '待 IT 验证' : processIsolationVerified ? '已通过' : '未通过'}</Tag> <Tooltip title={detail} overlayStyle={{ maxWidth: 520 }}><QuestionCircleOutlined className="settings-info-tip" tabIndex={0} aria-label="查看隔离说明" /></Tooltip></span>}
      action={<span style={{ display: 'inline-flex', gap: 8 }}>{backend === 'ollama' && !processIsolationVerified && status?.ollama_found && <Button danger type="primary" icon={<LockOutlined />} loading={loading} onClick={enable}>一键锁定 Ollama 外网</Button>}<Button icon={<ReloadOutlined />} onClick={refresh}>刷新验证</Button></span>}
      style={{ marginBottom: 16 }}
    />
  );
}
