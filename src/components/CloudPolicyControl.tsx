import { useEffect, useState } from 'react';
import { Alert, Button, Radio, Space, Switch, Tag, Tooltip, message } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { setSetting } from '../db';
import { getActiveApprovalGrants, revokeActiveApprovalGrants } from '../db/ai';
import { clearAllPending, clearCloudApprovals, isCleanAutoApproveEnabled, setCleanAutoApprove } from '../cloudConfirm';

export default function CloudPolicyControl() {
  const [mode, setMode] = useState<'local_only' | 'preview' | 'auto'>('local_only');
  const [grantCount, setGrantCount] = useState(0);
  const [autoClean, setAutoClean] = useState(false);
  useEffect(() => {
    const refresh = () => getActiveApprovalGrants().then(rows => setGrantCount(rows.length)).catch(() => setGrantCount(0));
    invoke<string>('get_cloud_network_mode')
      .then(async v => {
        const next = v === 'auto' || v === 'preview' ? v : 'local_only';
        setMode(next);
        if (next === 'local_only') {
          clearAllPending();
          clearCloudApprovals();
          await revokeActiveApprovalGrants();
          setGrantCount(0);
        } else {
          refresh();
        }
      })
      .catch(async () => {
        setMode('local_only');
        clearAllPending();
        clearCloudApprovals();
        setGrantCount(0);
        try { await revokeActiveApprovalGrants(); } catch { /* 读取失败时仍保持前端纯本地 */ }
      });
    window.addEventListener('costhub-cloud-approval-changed', refresh);
    void isCleanAutoApproveEnabled().then(setAutoClean).catch(() => setAutoClean(false));
    return () => window.removeEventListener('costhub-cloud-approval-changed', refresh);
  }, []);
  const change = async (value: 'local_only' | 'preview' | 'auto') => {
    try {
      await invoke('set_cloud_network_mode', { mode: value });
      await setSetting('cloud_network_mode', value);
      if (value !== 'local_only') await setSetting('ai_bridge_review', value);
      if (value === 'local_only') {
        clearAllPending();
        clearCloudApprovals();
        await revokeActiveApprovalGrants();
        setGrantCount(0);
      }
      setMode(value);
      message.success(value === 'local_only' ? '已启用纯本地模式，云端授权与排队已关闭' : value === 'preview' ? '已启用条件审批' : '已启用精确授权复用：只复用未过期、同 requestId/完整请求体的授权，不会自动放行新请求');
    } catch (error: any) {
      message.error(String(error?.message || error));
    }
  };
  const isLocalOnly = mode === 'local_only';
  return (
    <Alert
      type="info"
      showIcon
      message={<span>云端调用策略 <Tag color={isLocalOnly ? 'green' : mode === 'preview' ? 'gold' : 'blue'}>{isLocalOnly ? '纯本地' : mode === 'preview' ? '条件审批' : '安全自动'}</Tag> <Tooltip title="纯本地模式由 Rust 在授权签发和实际发送前双重拦截；条件审批和精确授权复用都只允许同一 requestId、同一完整请求体且未过期的授权。"><QuestionCircleOutlined className="settings-info-tip" tabIndex={0} aria-label="查看云端策略说明" /></Tooltip></span>}
      description={(
        <div>
          <Radio.Group value={mode} onChange={e => change(e.target.value)} style={{ margin: '6px 0' }}>
            <Radio value="local_only">纯本地（推荐）</Radio>
            <Radio value="preview">新主题先审批（推荐）</Radio>
            <Radio value="auto">自动复用精确授权（不新增自动放行）</Radio>
          </Radio.Group>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>当前有效主题授权：{grantCount} 条</span>
            <Button size="small" danger disabled={!grantCount} onClick={async () => { await revokeActiveApprovalGrants(); clearCloudApprovals(); setGrantCount(0); message.success('已撤销当前全部云端主题授权'); }}>立即撤销</Button>
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #EAEFF5' }}>
            <Space align="start" size={8}>
              <Switch size="small" checked={autoClean} disabled={isLocalOnly} onChange={async checked => {
                await setCleanAutoApprove(checked);
                setAutoClean(checked);
                message.success(checked
                  ? '已开启：本地审查零命中（无金额/供应商/项目/型号/规格）且网关可接受的公开主题将直接发送，不再询问'
                  : '已关闭：新主题一律先出审批卡');
              }} />
              <span style={{ fontSize: 12, color: '#475569' }}>
                审查通过的公开主题自动放行
                <Tooltip title="只对'物料通用名 + 品类 + 固定公开问题'三字段且本地审查零命中的请求生效；命中型号/规格/金额/供应商/项目或 C2 抽象分析仍然出卡，网关的字段/域名/载荷绑定也照旧不可绕过。每次自动放行都会在审批历史里记为'自动放行'并写明依据。">
                  <QuestionCircleOutlined className="settings-info-tip" tabIndex={0} aria-label="查看自动放行说明" />
                </Tooltip>
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                  默认开启（像「铜」这种审查零命中的公开行情查询直接通过，不再反复让你确认）。关掉它则新主题一律先出审批卡；两种情况下的本地审查与 Rust 网关都照常执行、不可关闭。
                </div>
              </span>
            </Space>
          </div>
        </div>
      )}
      style={{ marginBottom: 16 }}
    />
  );
}
