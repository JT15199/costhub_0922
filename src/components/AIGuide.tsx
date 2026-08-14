import { useEffect, useState } from 'react';
import { Modal, Tag, Button } from 'antd';
import { RobotOutlined, CheckCircleOutlined, WarningOutlined, SettingOutlined } from '@ant-design/icons';
import { getAllApiProviders, getSetting } from '../db';

// AI 能力引导（v2.3.19）：解锁后首次显示，告知已有哪些 AI 能力 + 当前配置状态
// 避免'不知道 AI 能干什么'——能力清单 + 配置就绪度一眼可见

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export default function AIGuide({ open, onClose, onOpenSettings }: Props) {
  const [llmReady, setLlmReady] = useState(false);
  const [llmName, setLlmName] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [nativeSearch, setNativeSearch] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const providers = await getAllApiProviders();
        const active = providers.find((p: any) => p.provider_type === 'llm' && p.is_active && p.api_key);
        setLlmReady(!!active);
        setLlmName(active?.provider_name || '');
        setLocalModel(await getSetting('local_ai_model', ''));
        setNativeSearch((await getSetting('ai_native_search', '1')) === '1');
      } catch { /* ignore */ }
    })();
  }, [open]);

  const Cap = ({ title, desc, ready, readyText, warnText }: { title: string; desc: string; ready: boolean; readyText: string; warnText: string }) => (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 16, marginTop: 2 }}>{ready ? <CheckCircleOutlined style={{ color: '#10B981' }} /> : <WarningOutlined style={{ color: '#F59E0B' }} />}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2, lineHeight: 1.6 }}>{desc}</div>
        <div style={{ marginTop: 6 }}>
          <Tag color={ready ? 'green' : 'orange'}>{ready ? readyText : warnText}</Tag>
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      title={<span><RobotOutlined style={{ color: '#0A84FF', marginRight: 8 }} />CostHub AI 能力一览</span>}
      open={open}
      onCancel={onClose}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            云端模型 {llmReady ? <>已就绪（{llmName}）</> : '未配置'} · 本地模型 {localModel ? <>已配置（{localModel}）</> : '未配置'} · 原生联网搜索 {nativeSearch ? '已开启' : '已关闭'}
          </span>
          <div>
            <Button onClick={onClose}>知道了</Button>
            <Button type="primary" icon={<SettingOutlined />} style={{ marginLeft: 8 }} onClick={() => { onClose(); onOpenSettings(); }}>去设置</Button>
          </div>
        </div>
      )}
      width={560}
    >
      <Cap
        title='报价情报（自动扫描）'
        desc='后台自动比对同物料跨项目报价，发现差异红点提醒；AI 疑似识别需本地模型'
        ready={!!localModel}
        readyText='本地模型已配置，自动扫描生效'
        warnText='未配置本地模型——在「本地 AI 助手」页配置 Ollama 后自动生效'
      />
      <Cap
        title='项目 AI 体检'
        desc='打开项目自动检查：BOM 完整性 / 目标超支 / 成本异动 / 同类报价偏高；「AI 小结」需本地模型'
        ready={!!localModel}
        readyText='已启用（规则部分不依赖模型，AI 小结需本地模型）'
        warnText='规则检查已启用；配置本地模型后可用「AI 小结」'
      />
      <Cap
        title='物料趋势洞察'
        desc='物料行情 AI 洞察（9 种分析框架 + 联网搜索 + 历史留档），走云端模型'
        ready={llmReady}
        readyText={llmReady ? '云端模型已就绪（' + llmName + '）' : '未配置云端模型'}
        warnText='未配置云端模型——在「系统设置 → AI 服务」配置后可用'
      />
      <Cap
        title='全局 AI 问询'
        desc='侧边栏随时提问（带当前项目上下文），回答可一键记入工作手账'
        ready={!!localModel}
        readyText='本地模型已配置，可读取项目数据（安全边界：云端不接本地数据）'
        warnText='需本地模型（数据安全原则：只有本地模型可读项目数据）'
      />
      <Cap
        title='成本快照 AI 解释'
        desc='快照对比弹窗内一键解释「这次成本为什么变了」（本地模型）'
        ready={!!localModel}
        readyText='已启用'
        warnText='需本地模型'
      />
    </Modal>
  );
}