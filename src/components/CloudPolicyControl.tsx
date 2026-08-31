import { useEffect, useState } from 'react';
import { Alert, Radio, Tag, message } from 'antd';
import { getSetting, setSetting } from '../db';

export default function CloudPolicyControl() {
  const [mode, setMode] = useState<'preview' | 'auto'>('preview');
  useEffect(() => { getSetting('ai_bridge_review', 'preview').then(v => setMode(v === 'auto' ? 'auto' : 'preview')).catch(() => {}); }, []);
  const change = async (value: 'preview' | 'auto') => {
    await setSetting('ai_bridge_review', value);
    setMode(value);
    message.success(value === 'preview' ? '已启用条件审批' : '已启用审查通过后自动发送');
  };
  return (
    <Alert
      type="info"
      showIcon
      message={<span>云端调用策略 <Tag color={mode === 'preview' ? 'gold' : 'blue'}>{mode === 'preview' ? '条件审批' : '安全自动'}</Tag></span>}
      description={(
        <div>
          <Radio.Group value={mode} onChange={e => change(e.target.value)} style={{ margin: '6px 0' }}>
            <Radio value="preview">新主题先审批（推荐）</Radio>
            <Radio value="auto">敏感审查通过后自动发送</Radio>
          </Radio.Group>
          <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.6 }}>
            两种模式都会先做代码级敏感审查并经过 Rust 专用网关；“新主题先审批”在本次会话批准后可连续完成搜索与分析，不会每一步重复弹窗。
          </div>
        </div>
      )}
      style={{ marginBottom: 16 }}
    />
  );
}
