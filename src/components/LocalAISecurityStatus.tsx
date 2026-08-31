import { useEffect, useState } from 'react';
import { Alert, Button, message, Tag } from 'antd';
import { LockOutlined, ReloadOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

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

  const refresh = async () => {
    try {
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
      message.success('Ollama 外网已锁定；本地 AI 现在可以安全读取成本数据');
    } catch (e: any) { message.error(String(e?.message || e)); }
    finally { setLoading(false); }
  };

  const isolated = !!status?.blocked;
  return (
    <Alert
      type={isolated ? 'success' : 'error'}
      showIcon
      message={<span>本地 AI 双重隔离 {isolated ? <Tag color="green">已通过</Tag> : <Tag color="red">未通过</Tag>}</span>}
      description={(
        <div style={{ lineHeight: 1.7 }}>
          <div>第一层：普通 HTTP 只允许本机回环；云端只能走“域名白名单 + 敏感字段审查 + 条件审批”专用网关。第二层：Ollama 进程必须由 Windows 防火墙禁止出站。</div>
          <div>安全拦截记录：<b>{events.length}</b> 条{events[0] ? `（最近：${events[0]}）` : ''}</div>
          {!status?.ollama_found ? <div>未检测到 Ollama，请安装后刷新。</div> : isolated
            ? <div>已验证规则 <code>CostHub_Block_Ollama_Outbound</code>，模型路径：{status.ollama_path}</div>
            : <div style={{ color: '#B91C1C' }}>在隔离通过前，系统只允许检测模型，拒绝向 Ollama 发送任何成本提示词。</div>}
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            {!isolated && status?.ollama_found && <Button danger type="primary" icon={<LockOutlined />} loading={loading} onClick={enable}>一键锁定 Ollama 外网</Button>}
            <Button icon={<ReloadOutlined />} onClick={refresh}>刷新验证</Button>
          </div>
        </div>
      )}
      style={{ marginBottom: 16 }}
    />
  );
}
